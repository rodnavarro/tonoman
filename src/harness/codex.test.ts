import { describe, it, expect } from "vitest";
import { parseLine, mapUsage, normalizeModel, shortModel, localEnv, ensureCodexHome, identityPreamble, parseCodexRateLimits, CODEX_CONTEXT_WINDOW } from "./codex";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

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
  it("an MCP tool call is named by its server and tool, as Claude names it (mcp__brain__brain_pages)", () => {
    const ev = parseLine(JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "brain", tool: "brain_pages", status: "completed" } }));
    expect(ev?.kind).toBe("tool");
    expect(ev?.tool).toBe("mcp__brain__brain_pages");
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

describe("codex harness — CODEX_HOME must exist (codex refuses a missing one)", () => {
  it("localEnv creates the config home it points at", () => {
    const home = path.join(os.tmpdir(), `codexhome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect(fs.existsSync(home)).toBe(false);
    const env = localEnv(process.env, home);
    expect(env.CODEX_HOME).toBe(home);
    expect(fs.existsSync(home)).toBe(true);
    // and never carries an API key that would outrank the subscription
    expect(env.OPENAI_API_KEY).toBeUndefined();
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("ensureCodexHome is idempotent", () => {
    const home = path.join(os.tmpdir(), `codexhome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ensureCodexHome(home);
    ensureCodexHome(home);
    expect(fs.existsSync(home)).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
