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
import { retryAfterMs, chunkCachePath, clearChunkCache } from "./recap";

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
