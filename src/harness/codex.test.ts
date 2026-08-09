import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseLine, mapUsage, normalizeModel, shortModel, localEnv, identityPreamble, parseCodexRateLimits, CODEX_CONTEXT_WINDOW, modelContextWindow, resetContextWindowCache } from "./codex";

describe("codex harness — model normalization (gw-command-model)", () => {
  it("maps the friendly tier aliases to gpt-5.6 slugs, passes slugs/unknowns through", () => {
    expect(normalizeModel("sol")).toBe("gpt-5.6-sol");
    expect(normalizeModel("terra")).toBe("gpt-5.6-terra");
    expect(normalizeModel("luna")).toBe("gpt-5.6-luna");
    expect(normalizeModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeModel(undefined)).toBeUndefined();
  });
  it("shortModel compacts a slug for the statusline", () => {
    expect(shortModel("gpt-5.6-sol")).toBe("sol");
    expect(shortModel("gpt-5.1-codex")).toBe("5.1-codex");
  });
});

describe("codex harness — event parsing (the --json stream → neutral TurnEvent)", () => {
  it("agent_message item → a text event", () => {
    const ev = parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
    expect(ev).toEqual({ kind: "text", text: "hello" });
  });
  it("a non-message item (file_change/command) → a tool event with a bounded label", () => {
    const ev = parseLine(JSON.stringify({ type: "item.completed", item: { type: "file_change", status: "completed" } }));
    expect(ev?.kind).toBe("tool");
    expect(ev?.tool).toBe("file_change");
  });
  it("turn.completed → a done event carrying normalized usage", () => {
    const ev = parseLine(
      JSON.stringify({ type: "turn.completed", model: "gpt-5.6-sol", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5 } }),
    );
    expect(ev?.kind).toBe("done");
    expect(ev?.usage?.inputTokens).toBe(20); // fresh = total(100) − cached(80)
    expect(ev?.usage?.cacheReadTokens).toBe(80);
    expect(ev?.usage?.outputTokens).toBe(25); // output + reasoning
    expect(ev?.usage?.contextTokens).toBe(100);
    expect(ev?.usage?.model).toBe("sol");
    expect(ev?.usage?.contextWindow).toBe(CODEX_CONTEXT_WINDOW);
  });
  it("thread.started / turn.started / non-JSON banners → null (ignored)", () => {
    expect(parseLine(JSON.stringify({ type: "thread.started", thread_id: "x" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "turn.started" }))).toBeNull();
    expect(parseLine("Reading prompt from stdin...")).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("codex harness — account usage window (5h/7d, like claude's statusline)", () => {
  it("maps codex rate_limits (rollout format) to neutral UsageWindows, 5h before 7d", () => {
    const w = parseCodexRateLimits({
      primary: { used_percent: 3, window_minutes: 10080, resets_at: 1786507094 },
      secondary: { used_percent: 41, window_minutes: 300, resets_at: 1786500000 },
    });
    expect(w.map((x) => x.key)).toEqual(["5h", "7d"]); // shorter window first
    const five = w.find((x) => x.key === "5h")!;
    expect(five.usedPct).toBe(41);
    expect(five.resetAt).toBe(new Date(1786500000 * 1000).toISOString());
  });
  it("returns [] when there is no rate_limits (never throws)", () => {
    expect(parseCodexRateLimits(undefined)).toEqual([]);
    expect(parseCodexRateLimits({})).toEqual([]);
  });
});

describe("codex harness — env + identity (ToS-safe subscription, no API key)", () => {
  it("localEnv points CODEX_HOME at the config volume and drops OPENAI_API_KEY", () => {
    const env = localEnv({ OPENAI_API_KEY: "should-be-dropped", PATH: "/x" }); // scan:allow test fixture, not a real key — asserts the key is dropped
    expect(env.CODEX_HOME).toBe("/root/.codex");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/x");
  });
  it("identityPreamble is empty when no file is given (a missing persona never fails a turn)", () => {
    expect(identityPreamble(undefined)).toBe("");
    expect(identityPreamble("/no/such/file/xyz")).toBe("");
  });
});

describe("codex harness — context window (statusline ctx %)", () => {
  const mkHome = (models: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-models-"));
    fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({ models }));
    resetContextWindowCache();
    return dir;
  };

  it("reads the real per-model window from codex's own models_cache.json", () => {
    // The shape codex actually writes — verified against a live CODEX_HOME.
    const home = mkHome([
      { slug: "gpt-5.6-sol", context_window: 272000, max_context_window: 272000 },
      { slug: "gpt-5.4", context_window: 272000, max_context_window: 1000000 },
    ]);
    expect(modelContextWindow("gpt-5.6-sol", home)).toBe(272000);
    expect(modelContextWindow("sol", home)).toBe(272000); // alias resolves first
  });

  it("takes the model's default window, not max_context_window", () => {
    // gpt-5.4 advertises a 1M ceiling but a turn gets 272k. Reporting the ceiling would make ctx %
    // read ~3.7x lower than reality — the window would fill with no warning.
    const home = mkHome([{ slug: "gpt-5.4", context_window: 272000, max_context_window: 1000000 }]);
    expect(modelContextWindow("gpt-5.4", home)).toBe(272000);
  });

  it("falls back to the constant for an unknown model or unreadable cache", () => {
    const home = mkHome([{ slug: "gpt-5.6-sol", context_window: 272000 }]);
    expect(modelContextWindow("gpt-9-nonexistent", home)).toBe(CODEX_CONTEXT_WINDOW);
    resetContextWindowCache();
    expect(modelContextWindow("gpt-5.6-sol", path.join(os.tmpdir(), "no-such-codex-home"))).toBe(CODEX_CONTEXT_WINDOW);
  });

  it("the fallback is 272k, not the old 400k guess", () => {
    // Guessing HIGH is the dangerous direction: ctx % reads lower than reality.
    expect(CODEX_CONTEXT_WINDOW).toBe(272000);
  });

  it("picks up a refreshed cache without a restart (memo keyed on mtime)", () => {
    const home = mkHome([{ slug: "gpt-5.6-sol", context_window: 272000 }]);
    expect(modelContextWindow("gpt-5.6-sol", home)).toBe(272000);
    // codex rewrites the file when OpenAI changes a tier; the memo must not pin the old number.
    fs.writeFileSync(
      path.join(home, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-5.6-sol", context_window: 400000 }] }),
    );
    fs.utimesSync(path.join(home, "models_cache.json"), new Date(), new Date(Date.now() + 1000));
    expect(modelContextWindow("gpt-5.6-sol", home)).toBe(400000);
  });
});
