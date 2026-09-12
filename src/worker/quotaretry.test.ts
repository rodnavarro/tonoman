// Surviving a DAILY quota, which is not the kind of failure a retry policy is built for.
//
// What happened on 2026-09-08, in one line: 611 transcription attempts, 4 published. Groq's free
// tier allows 28800 seconds of audio a day; roughly 4¼ hours were actually recorded, and the rest
// of the budget went to re-transcribing the same five meetings because a failed attempt threw away
// every chunk it had already paid for and the schedule started over two minutes later.
//
// Two defects, so two suites: read the provider's own "come back at" instead of guessing, and keep
// the chunks that succeeded.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { retryAfterMs, chunkCachePath, clearChunkCache, parseProbeSeconds, groqFailure } from "./recap";

const BODY_429 =
  '{"error":{"message":"Rate limit reached for model `whisper-large-v3-turbo` in organization ' +
  "`org_REDACTED` service tier `on_demand` on seconds of audio per day (ASPD): " +
  'Limit 28800, Used 28596, Requested 600. Please try again in 19m48s."}}';

describe("retryAfterMs — the provider already said when", () => {
  it("reads the delay out of the BODY, which is where the daily quota puts it", () => {
    // The real body, copied from the logs. There is no retry-after header on this one — reading
    // only the header would have missed the single failure that actually mattered.
    expect(retryAfterMs(null, BODY_429)).toBe((19 * 60 + 48) * 1000);
  });

  it("prefers a retry-after header when there is one", () => {
    expect(retryAfterMs("30", "")).toBe(30_000);
  });

  it("understands the shapes that sentence comes in", () => {
    expect(retryAfterMs(null, "Please try again in 45.6s")).toBe(45_600);
    expect(retryAfterMs(null, "Please try again in 2m")).toBe(120_000);
    expect(retryAfterMs(null, "Please try again in 1h2m3s")).toBe(3_723_000);
  });

  it("says nothing when the response says nothing, so the generic backoff still applies", () => {
    // Returning 0 here would retry instantly and reproduce the storm with extra steps.
    expect(retryAfterMs(null, "internal server error")).toBeUndefined();
    expect(retryAfterMs("", "")).toBeUndefined();
    expect(retryAfterMs("not-a-number", "")).toBeUndefined();
  });

  it("caps a hostile or malformed delay rather than parking a meeting until next week", () => {
    expect(retryAfterMs("999999999", "")).toBe(6 * 3_600_000);
    expect(retryAfterMs(null, "try again in 99h")).toBe(6 * 3_600_000);
    // And a floor, so a "0" cannot become a hot loop.
    expect(retryAfterMs("0.0001", "")).toBe(1_000);
  });
});

describe("chunkCachePath — what makes resuming safe", () => {
  const rec = { id: "abc123", title: "t", startTime: 0, duration: 0, stamp: "s" };

  it("keys on the recording, so two meetings never read each other's chunks", () => {
    const a = chunkCachePath("/c", rec, 0, 3);
    const b = chunkCachePath("/c", { ...rec, id: "def456" }, 0, 3);
    expect(a).not.toBe(b);
  });

  it("keys on the chunk COUNT as well, because a different count means different chunks", () => {
    // The subtle one. If the audio is ever segmented differently, chunk 1 of 3 covers different
    // minutes than chunk 1 of 9 — reusing it would splice the wrong ten minutes into a transcript
    // and nothing downstream could tell. Separate paths make a stale set simply invisible.
    expect(chunkCachePath("/c", rec, 1, 3)).not.toBe(chunkCachePath("/c", rec, 1, 9));
  });

  it("orders lexically, so a directory listing reads in transcript order", () => {
    const names = [0, 2, 10].map((i) => path.basename(chunkCachePath("/c", rec, i, 11)));
    expect(names).toEqual(["chunk-000.txt", "chunk-002.txt", "chunk-010.txt"]);
    expect([...names].sort()).toEqual(names);
  });
});

describe("clearChunkCache", () => {
  it("removes that recording's chunks and leaves every other recording alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "chunks-"));
    try {
      const mine = { id: "mine", title: "t", startTime: 0, duration: 0, stamp: "s" };
      const other = { ...mine, id: "other" };
      for (const r of [mine, other]) {
        const at = chunkCachePath(root, r, 0, 1);
        await fs.mkdir(path.dirname(at), { recursive: true });
        await fs.writeFile(at, "text");
      }
      await clearChunkCache(root, mine);
      await expect(fs.readFile(chunkCachePath(root, mine, 0, 1), "utf8")).rejects.toThrow();
      expect(await fs.readFile(chunkCachePath(root, other, 0, 1), "utf8")).toBe("text");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("is quiet about a cache that was never written", async () => {
    // Publishing a recording that transcribed in one pass still calls this.
    const rec = { id: "never", title: "t", startTime: 0, duration: 0, stamp: "s" };
    await expect(clearChunkCache(path.join(os.tmpdir(), "no-such-dir-here"), rec)).resolves.toBeUndefined();
  });
});

describe("parseProbeSeconds — measuring what we actually send", () => {
  // Everything about this pipeline was reported in megabytes and chunk counts, and the resource we
  // are rationed on is SECONDS OF AUDIO. When Groq's limiter said 6573 and our arithmetic said
  // 3600, nothing in the system could say which was right. ffprobe is local and free; there was
  // never a reason to infer this.
  it("reads ffprobe's bare duration output", () => {
    expect(parseProbeSeconds("600.048000\n")).toBeCloseTo(600.048);
    expect(parseProbeSeconds("  300.5  ")).toBeCloseTo(300.5);
  });

  it("returns undefined rather than 0 when ffprobe says nothing useful", () => {
    // A 0 here would be logged as "0s → groq" and quietly misreport a chunk we did send.
    expect(parseProbeSeconds("")).toBeUndefined();
    expect(parseProbeSeconds("N/A")).toBeUndefined();
    expect(parseProbeSeconds("0")).toBeUndefined();
    expect(parseProbeSeconds("-1")).toBeUndefined();
  });
});

describe("groqFailure — too early is not the same as too large", () => {
  const BODY_413 =
    '{"error":{"message":"Request too large for model `openai/gpt-oss-120b` in organization ' +
    "`org_REDACTED` service tier `on_demand` on tokens per minute (TPM): Limit 8000, " +
    'Requested 9739, please reduce your message size and try again."}}';

  it("makes a 429 retryable, carrying the delay the provider named", () => {
    const e = groqFailure("transcribe", 429, BODY_429, null) as { type?: string; nextRetryDelay?: unknown; nonRetryable?: boolean };
    expect(e.type).toBe("GroqRateLimited");
    expect(e.nextRetryDelay).toBeDefined();
    expect(e.nonRetryable).not.toBe(true);
  });

  it("makes a 413 NON-retryable, because the same request will never fit", () => {
    // Seven attempts were spent on exactly this body — each a full transcription's worth of
    // orchestration for a foregone conclusion. "Limit 8000, Requested 9739" is a size, not a
    // schedule; there is no later at which it becomes true.
    const e = groqFailure("summarize", 413, BODY_413, null) as { type?: string; nonRetryable?: boolean };
    expect(e.type).toBe("GroqRejected");
    expect(e.nonRetryable).toBe(true);
  });

  it("gives up on the errors that describe a broken request rather than a busy server", () => {
    for (const status of [400, 401, 403, 404]) {
      const e = groqFailure("transcribe", status, "nope", null) as { nonRetryable?: boolean };
      expect(e.nonRetryable).toBe(true);
    }
  });

  it("keeps a 5xx retryable, because that IS the transient case", () => {
    const e = groqFailure("transcribe", 503, "upstream unavailable", null) as { nonRetryable?: boolean };
    expect(e.nonRetryable).not.toBe(true);
  });

  it("keeps a 429 with no stated delay retryable on the generic backoff", () => {
    // Retryable, just not on a schedule the provider chose — falling through to nonRetryable here
    // would abandon a meeting over a rate limit that clears in seconds.
    const e = groqFailure("transcribe", 429, "slow down", null) as { nonRetryable?: boolean };
    expect(e.nonRetryable).not.toBe(true);
  });

  it("names which call failed, since both go to the same provider", () => {
    expect(String(groqFailure("summarize", 413, BODY_413, null).message)).toContain("groq summarize");
    expect(String(groqFailure("transcribe", 429, BODY_429, null).message)).toContain("groq transcribe");
  });
});
