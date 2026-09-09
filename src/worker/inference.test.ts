// Which provider gets asked, and what a refusal means.
//
// The two pure functions carry the judgement that was wrong before — "any 4xx is permanent" killed
// meetings a second provider would have transcribed, and taking the LAST retry delay threw away a
// precise wait whenever the final provider happened not to name one. Both are testable without a
// network, which is the reason they are separated from the loop at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chooseFailure, classifyAttempt, groqFailure, transcribeWith, type Attempt, type Provider } from "./inference";
import { providerSpecs } from "./flowcfg";

const BODY_429 = "Rate limit reached for model whisper-large-v3-turbo. Please try again in 19m48s.";
const BODY_413 = "Request too large. Limit 8000, Requested 9739.";

const err = (e: Error) => e as Error & { type?: string; nextRetryDelay?: unknown; nonRetryable?: boolean };

const P = (name: string, over: Partial<Provider> = {}): Provider => ({
  name,
  baseUrl: `https://${name}.example/v1`,
  model: "whisper-1",
  ...over,
});

describe("classifyAttempt — what ONE provider's answer means", () => {
  it("429 is rate limiting, and carries the delay the provider named in its prose", () => {
    const a = classifyAttempt("groq", "transcribe", 429, BODY_429, null);
    expect(a.kind).toBe("rateLimited");
    expect(a.delayMs).toBe((19 * 60 + 48) * 1000);
  });

  it("429 with no time named is still rate limiting, just without a delay", () => {
    const a = classifyAttempt("groq", "transcribe", 429, "slow down", null);
    expect(a.kind).toBe("rateLimited");
    expect(a.delayMs).toBeUndefined();
  });

  it.each([400, 401, 403, 404, 413, 422])("%d is permanent — no retry can change the answer", (status) => {
    expect(classifyAttempt("groq", "transcribe", status, "no", null).kind).toBe("permanent");
  });

  it.each([408, 500, 502, 503])("%d is transient — the same request may well work next time", (status) => {
    expect(classifyAttempt("groq", "transcribe", status, "oops", null).kind).toBe("server");
  });

  it("an unrecognised status is assumed TRANSIENT, because guessing permanent discards a meeting", () => {
    expect(classifyAttempt("groq", "transcribe", 418, "teapot", null).kind).toBe("server");
  });

  it("names the provider in the message, so a log says WHICH one refused", () => {
    expect(classifyAttempt("local-whisper", "transcribe", 413, BODY_413, null).message).toContain("local-whisper");
  });
});

describe("chooseFailure — what to throw once EVERY provider has answered", () => {
  const attempt = (over: Partial<Attempt>): Attempt => ({ provider: "p", kind: "server", message: "m", ...over });

  it("no providers at all is a configuration fault, and says which knob is missing", () => {
    const e = err(chooseFailure("transcribe", []));
    expect(e.nonRetryable).toBe(true);
    expect(e.message).toMatch(/GROQ_API_KEY|transcribe\./);
  });

  it("takes the SOONEST delay anybody named, not the last one", () => {
    // You need exactly ONE provider to come back, so the minimum is the honest wait. Ordered with
    // the smallest FIRST so "last one wins" cannot pass this by accident.
    const e = err(
      chooseFailure("transcribe", [
        attempt({ provider: "a", kind: "rateLimited", delayMs: 60_000 }),
        attempt({ provider: "b", kind: "rateLimited", delayMs: 900_000 }),
      ]),
    );
    expect(e.nextRetryDelay).toBe(60_000);
    expect(e.nonRetryable).not.toBe(true);
  });

  it("a rate limit with no delay does not erase a delay another provider DID name", () => {
    const e = err(
      chooseFailure("transcribe", [
        attempt({ provider: "a", kind: "rateLimited", delayMs: 120_000 }),
        attempt({ provider: "b", kind: "rateLimited" }),
      ]),
    );
    expect(e.nextRetryDelay).toBe(120_000);
  });

  it("one provider's permanent refusal does NOT end the recording when another might still serve", () => {
    // This is the bug in one line. A 413 from a local server's body limit is not a fact about the
    // chunk, and Groq would have taken it.
    const e = err(
      chooseFailure("transcribe", [
        attempt({ provider: "local", kind: "permanent" }),
        attempt({ provider: "groq", kind: "server" }),
      ]),
    );
    expect(e.nonRetryable).not.toBe(true);
  });

  it("everyone refusing permanently DOES end it — yesterday's 413 lesson, kept", () => {
    const e = err(
      chooseFailure("transcribe", [
        attempt({ provider: "local", kind: "permanent" }),
        attempt({ provider: "groq", kind: "permanent" }),
      ]),
    );
    expect(e.nonRetryable).toBe(true);
  });

  it("keeps every provider's message, so the log says what each one actually said", () => {
    const e = chooseFailure("transcribe", [
      attempt({ provider: "local", kind: "permanent", message: "local said 413" }),
      attempt({ provider: "groq", kind: "permanent", message: "groq said 400" }),
    ]);
    expect(e.message).toContain("local said 413");
    expect(e.message).toContain("groq said 400");
  });
});

describe("THE INVARIANT — one Groq provider behaves exactly as it did before the list existed", () => {
  // This is what makes the change safe to merge. Every deployment that has not configured a second
  // provider must see the same message, the same wait and the same retryability as `groqFailure`
  // produced when Groq was the only thing in the code. If this drifts, every failure path in the
  // system changed shape at once and nothing else would have said so.
  const cases: [string, number, string, string | null][] = [
    ["a daily audio quota", 429, BODY_429, null],
    ["a rate limit with a retry-after header", 429, "slow down", "30"],
    ["a context that cannot fit the meeting", 413, BODY_413, null],
    ["a malformed request", 400, "bad request", null],
    ["a rotated key", 401, "invalid api key", null],
  ];

  it.each(cases)("%s", (_what, status, body, header) => {
    const before = err(groqFailure("transcribe", status, body, header));
    const after = err(chooseFailure("transcribe", [classifyAttempt("groq", "transcribe", status, body, header)]));
    expect(after.message).toBe(before.message);
    expect(after.nextRetryDelay).toEqual(before.nextRetryDelay);
    expect(after.nonRetryable).toEqual(before.nonRetryable);
  });

  it("a 500 stays an ordinary retryable error, exactly as before", () => {
    const before = err(groqFailure("transcribe", 500, "upstream", null));
    const after = err(chooseFailure("transcribe", [classifyAttempt("groq", "transcribe", 500, "upstream", null)]));
    expect(after.message).toBe(before.message);
    expect(after.nonRetryable).not.toBe(true);
    expect(before.nonRetryable).not.toBe(true);
  });
});

describe("transcribeWith — asking each provider in turn", () => {
  afterEach(() => vi.unstubAllGlobals());

  let file = "";
  const withAudio = async (): Promise<string> => {
    if (!file) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inference-"));
      file = path.join(dir, "part-000.flac");
      await fs.writeFile(file, "not really audio");
    }
    return file;
  };

  const ok = (text: string) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ text }) });
  const bad = (status: number, body = "no") => ({
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  });

  it("falls through to the next provider when the first is DEAD at the transport", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      if (url.startsWith("https://local")) throw new Error("ECONNREFUSED");
      return ok("the meeting");
    });
    const dead: string[] = [];
    const served = await transcribeWith([P("local"), P("groq")], await withAudio(), "", { onDead: (n) => dead.push(n) });
    expect(served.value).toBe("the meeting");
    expect(served.provider.name).toBe("groq");
    expect(dead).toEqual(["local"]);
    expect(asked).toHaveLength(2);
  });

  it("falls through on a 4xx TOO — one provider's limit is not the recording's fate", async () => {
    // The old rule stopped here and threw nonRetryable, killing a meeting Groq would have taken.
    vi.stubGlobal("fetch", async (url: string) => (url.startsWith("https://local") ? bad(413, BODY_413) : ok("done")));
    const served = await transcribeWith([P("local"), P("groq")], await withAudio(), "");
    expect(served.value).toBe("done");
    expect(served.provider.name).toBe("groq");
  });

  it("says out loud when it did NOT use the first choice", async () => {
    // A fallback that never announces itself hides a dead GPU while the paid provider picks up the
    // bill — it still "works", which is why it can run unnoticed for a month.
    const lines: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (url.startsWith("https://local") ? bad(500) : ok("done")));
    await transcribeWith([P("local"), P("groq")], await withAudio(), "", { log: (l) => lines.push(l) });
    expect(lines.join(" ")).toContain("fell through to groq");
  });

  it("stays silent when the FIRST provider served — a normal run says nothing", async () => {
    const lines: string[] = [];
    vi.stubGlobal("fetch", async () => ok("done"));
    await transcribeWith([P("groq"), P("local")], await withAudio(), "", { log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
  });

  it("OMITS Authorization for a provider with no key, and sends it for one with a key", async () => {
    // `Bearer undefined` is a string a server rejects as a bad credential, which reads in the log as
    // "the local GPU refused our key" for a server that wanted no key at all.
    const seen: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seen[url.startsWith("https://local") ? "local" : "groq"] = init.headers;
      return url.startsWith("https://local") ? bad(500) : ok("done");
    });
    await transcribeWith([P("local"), P("groq", { apiKey: "k" })], await withAudio(), "");
    expect(seen.local).toEqual({});
    expect(seen.groq).toEqual({ Authorization: "Bearer k" });
  });

  it("a provider that ACCEPTS and then hangs is abandoned, and the next one is asked", async () => {
    vi.stubGlobal("fetch", async (url: string, init: { signal?: AbortSignal }) => {
      if (!url.startsWith("https://slow")) return ok("done");
      // Never resolves on its own: only the abort signal ends it, which is the point.
      return await new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      });
    });
    const served = await transcribeWith([P("slow", { timeoutMs: 30 }), P("groq")], await withAudio(), "");
    expect(served.provider.name).toBe("groq");
  });

  it("throws with EVERY provider's answer once none of them served", async () => {
    vi.stubGlobal("fetch", async () => bad(500, "upstream is unwell"));
    await expect(transcribeWith([P("local"), P("groq")], await withAudio(), "")).rejects.toThrow(/local.*groq/s);
  });
});

describe("providerSpecs — a tenant's own providers, as rows", () => {
  it("orders NUMERICALLY, because localeCompare puts 10 before 2", () => {
    // A customer who added a tenth provider would otherwise find their order rearranged, and the
    // symptom is a bill from the wrong provider rather than an error.
    const rows: Record<string, string> = {};
    for (const n of [2, 10, 1]) {
      rows[`transcribe.${n}.url`] = `https://p${n}.example/v1`;
      rows[`transcribe.${n}.model`] = "whisper-1";
    }
    expect(providerSpecs(rows, "transcribe").map((p) => p.url)).toEqual([
      "https://p1.example/v1",
      "https://p2.example/v1",
      "https://p10.example/v1",
    ]);
  });

  it("drops a half-written row rather than guessing an endpoint for it", () => {
    // Defaulting a missing url means sending a customer's meeting somewhere they did not name.
    const specs = providerSpecs(
      { "transcribe.1.model": "whisper-1", "transcribe.2.url": "https://ok.example/v1", "transcribe.2.model": "m" },
      "transcribe",
    );
    expect(specs.map((p) => p.name)).toEqual(["transcribe-2"]);
  });

  it("keeps the two jobs apart — a summariser row is not a transcriber", () => {
    const rows = {
      "transcribe.1.url": "https://t.example/v1",
      "transcribe.1.model": "whisper-1",
      "summarize.1.url": "https://s.example/v1",
      "summarize.1.model": "sonnet",
    };
    expect(providerSpecs(rows, "transcribe").map((p) => p.model)).toEqual(["whisper-1"]);
    expect(providerSpecs(rows, "summarize").map((p) => p.model)).toEqual(["sonnet"]);
  });

  it("assumes a provider DOES bias its vocabulary unless the row says otherwise", () => {
    const base = { "transcribe.1.url": "https://t.example/v1", "transcribe.1.model": "m" };
    expect(providerSpecs(base, "transcribe")[0]!.biases).toBe(true);
    expect(providerSpecs({ ...base, "transcribe.1.biases": "false" }, "transcribe")[0]!.biases).toBe(false);
  });

  it("trims a trailing slash, so a row and a hand-written url produce the same request", () => {
    const specs = providerSpecs(
      { "transcribe.1.url": "https://t.example/v1/", "transcribe.1.model": "m" },
      "transcribe",
    );
    expect(specs[0]!.url).toBe("https://t.example/v1");
  });

  it("carries the key REF, never a key — this function must never read a secret", () => {
    const specs = providerSpecs(
      { "transcribe.1.url": "https://t.example/v1", "transcribe.1.model": "m", "transcribe.1.key_ref": "s:K" },
      "transcribe",
    );
    expect(specs[0]!.keyRef).toBe("s:K");
  });
});
