import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveAgents, parseCommand, dispatchCommand, renderHealth, handleBackendControl, type ModelControl, type StatusControl, type BackendControl } from "./gateway";
import type { AsideLane } from "./aside";
import type { StatusMode } from "./statusline";
import type { TurnQueue } from "./turnqueue";
import type { Connector, Envelope, MemoryStore } from "./core/contracts";
import { Registry } from "./harness";
import * as claudecode from "./harness/claudecode";
import { parseLine } from "./harness/claudecode";
import { splitChunks } from "./stream";
import { buildPrompt } from "./router";
import { mdToTelegramHTML, normalizeBlocks } from "./connector/telegram";
import type { Config } from "./config";
import type { Agent as RegAgent } from "./registry";

const reg = () => new Registry().add(claudecode.spec());

describe("dispatchCommand — commands map to the turn engine (gw-command-*)", () => {
  function setup(cancelResult = true, popResult = true) {
    const calls: string[] = [];
    const q = {
      reset: () => calls.push("reset"),
      steer: (t: string) => calls.push("steer:" + t),
      pop: () => {
        calls.push("pop");
        return popResult;
      },
      interrupt: (t: string) => calls.push("interrupt:" + t),
      cancelPending: () => {
        calls.push("cancelPending");
        return cancelResult;
      },
    } as unknown as TurnQueue;
    const sent: string[] = [];
    const conn = { reply: () => ({ send: async (s: string) => sent.push(s) }) } as unknown as Connector;
    let newSessions = 0;
    const mem = { newSession: async () => (newSessions++, "id") } as unknown as MemoryStore;
    const env: Envelope = { channel: "t", conversation: "c", user: "u", text: "", mediaPaths: [] };
    return { calls, sent, q, conn, mem, env, newSessions: () => newSessions };
  }

  it("/steer <msg> interrupts now (no ack — the redirected reply is the ack)", async () => {
    const s = setup();
    await dispatchCommand({ name: "steer", args: "do this now" }, s.env, s.q, s.conn, s.mem);
    expect(s.calls).toEqual(["steer:do this now"]);
    expect(s.sent).toEqual([]); // no banner
  });

  it("/steer with no args shows usage and does NOT steer", async () => {
    const s = setup();
    await dispatchCommand({ name: "steer", args: "" }, s.env, s.q, s.conn, s.mem);
    expect(s.calls).toEqual([]);
    expect(s.sent[0]).toContain("Usage");
  });

  it("/pop runs the queue now (and reports nothing when empty)", async () => {
    const s = setup();
    await dispatchCommand({ name: "pop", args: "" }, s.env, s.q, s.conn, s.mem);
    expect(s.calls).toEqual(["pop"]);
    expect(s.sent).toEqual([]); // popped → the turn's reply is the ack
    const e = setup(true, false);
    await dispatchCommand({ name: "pop", args: "" }, e.env, e.q, e.conn, e.mem);
    expect(e.sent[0]).toContain("Nothing queued");
  });

  it("/interrupt <msg> hard-cuts the engine", async () => {
    const s = setup();
    await dispatchCommand({ name: "interrupt", args: "stop" }, s.env, s.q, s.conn, s.mem);
    expect(s.calls).toEqual(["interrupt:stop"]);
    expect(s.sent[0]).toContain("Interrupted");
  });

  it("/skip drops the queued /later (and reports nothing when empty)", async () => {
    const s = setup(true);
    await dispatchCommand({ name: "skip", args: "" }, s.env, s.q, s.conn, s.mem);
    expect(s.calls).toEqual(["cancelPending"]);
    expect(s.sent[0]).toContain("Cleared");
    const e = setup(false);
    await dispatchCommand({ name: "skip", args: "" }, e.env, e.q, e.conn, e.mem);
    expect(e.sent[0]).toContain("Nothing queued");
  });

  it("/new resets the engine and rotates the session", async () => {
    const s = setup();
    await dispatchCommand({ name: "new", args: "" }, s.env, s.q, s.conn, s.mem);
    expect(s.calls).toEqual(["reset"]);
    expect(s.newSessions()).toBe(1);
    expect(s.sent[0]).toContain("New session");
  });

  it("unknown command is reported, not run", async () => {
    const s = setup();
    await dispatchCommand({ name: "frobnicate", args: "" }, s.env, s.q, s.conn, s.mem);
    expect(s.calls).toEqual([]);
    expect(s.sent[0]).toContain("Unknown command");
  });
});

describe("dispatchCommand /btw — out-of-band aside (gw-command-btw)", () => {
  function setup() {
    const sent: string[] = [];
    const conn = { reply: () => ({ send: async (s: string) => sent.push(s) }) } as unknown as Connector;
    const asks: string[] = [];
    const aside = { ask: async (q: string) => void asks.push(q), isBusy: () => false } as unknown as AsideLane;
    const env: Envelope = { channel: "t", conversation: "c", user: "u", text: "", mediaPaths: [] };
    const noQ = {} as unknown as TurnQueue;
    const noMem = {} as unknown as MemoryStore;
    return { sent, conn, asks, aside, env, noQ, noMem };
  }

  it("routes the question to the aside lane and runs no turn (the aside is its own reply)", async () => {
    const s = setup();
    await dispatchCommand({ name: "btw", args: "how's it going?" }, s.env, s.noQ, s.conn, s.noMem, undefined, s.aside);
    expect(s.asks).toEqual(["how's it going?"]);
    expect(s.sent).toEqual([]); // the aside owns its own reply; dispatch sends nothing
  });

  it("empty /btw shows usage and does not invoke the lane", async () => {
    const s = setup();
    await dispatchCommand({ name: "btw", args: "" }, s.env, s.noQ, s.conn, s.noMem, undefined, s.aside);
    expect(s.asks).toEqual([]);
    expect(s.sent[0]).toContain("Usage");
  });

  it("reports honestly when the harness has no aside capability", async () => {
    const s = setup();
    await dispatchCommand({ name: "btw", args: "hi" }, s.env, s.noQ, s.conn, s.noMem, undefined, undefined);
    expect(s.asks).toEqual([]);
    expect(s.sent[0]).toContain("aren't available");
  });
});

describe("dispatchCommand /health — deterministic check, no turn (gw-command-health)", () => {
  function setup(healthFn?: () => Promise<string>) {
    const sent: string[] = [];
    const conn = { reply: () => ({ send: async (s: string) => sent.push(s) }) } as unknown as Connector;
    const env: Envelope = { channel: "t", conversation: "c", user: "u", text: "", mediaPaths: [] };
    return { sent, conn, env };
  }
  it("replies with the deterministic health report (no queue/turn touched)", async () => {
    const s = setup();
    let ran = false;
    const health = async () => ((ran = true), "✅ Healthy — cody · 2026-06-18T00:00:00Z");
    await dispatchCommand({ name: "health", args: "" }, s.env, {} as any, s.conn, {} as any, undefined, undefined, undefined, health);
    expect(ran).toBe(true);
    expect(s.sent[0]).toContain("Healthy");
  });
  it("reports unavailable when no health checker is wired", async () => {
    const s = setup();
    await dispatchCommand({ name: "health", args: "" }, s.env, {} as any, s.conn, {} as any);
    expect(s.sent[0]).toContain("isn't available");
  });

  it("renderHealth: ✅ Healthy only when every check passes; ❌ Unhealthy + ❌ on the failing line", () => {
    const ts = "2026-06-18T00:00:00Z";
    const ok = renderHealth("cody", ts, [
      { label: "container", ok: true, detail: "up (cody)" },
      { label: "tonoman broker (from agent)", ok: true, detail: "reachable" },
    ], "C:/mem");
    expect(ok.split("\n")[0]).toBe(`✅ Healthy — cody · ${ts}`);
    expect(ok).toContain("✅ container: up (cody)");
    expect(ok).toContain("• memory: C:/mem");

    const bad = renderHealth("cody", ts, [
      { label: "container", ok: true, detail: "up (cody)" },
      { label: "brain auth", ok: false, detail: "NOT authenticated — tonoman auth login cody" },
    ], "C:/mem");
    expect(bad.split("\n")[0]).toBe(`❌ Unhealthy — cody · ${ts}`);
    expect(bad).toContain("❌ brain auth: NOT authenticated");
  });
});

describe("dispatchCommand /statusline — usage display mode (gw-command-statusline)", () => {
  function setup(initial: StatusMode = "none", supported = true) {
    let mode = initial;
    const sent: string[] = [];
    const conn = { reply: () => ({ send: async (s: string) => sent.push(s) }) } as unknown as Connector;
    const env: Envelope = { channel: "t", conversation: "c", user: "u", text: "", mediaPaths: [] };
    const status: StatusControl | undefined = supported
      ? { get: () => mode, set: (m) => void (mode = m), snapshot: async () => "SNAPSHOT" }
      : undefined;
    const noQ = {} as unknown as TurnQueue;
    const noMem = {} as unknown as MemoryStore;
    return { sent, conn, env, status, mode: () => mode, noQ, noMem };
  }
  const run = (s: ReturnType<typeof setup>, args: string) =>
    dispatchCommand({ name: "statusline", args }, s.env, s.noQ, s.conn, s.noMem, undefined, undefined, s.status);

  it("sets a valid mode", async () => {
    const s = setup();
    await run(s, "full");
    expect(s.mode()).toBe("full");
    expect(s.sent[0]).toContain("full");
  });

  it("no arg shows a tappable picker when the channel supports it (gw-command-statusline)", async () => {
    const choiceCalls: { text: string; choices: { label: string; data: string }[] }[] = [];
    const conn = {
      reply: () => ({
        send: async () => {},
        sendChoices: async (text: string, choices: { label: string; data: string }[]) => void choiceCalls.push({ text, choices }),
      }),
    } as unknown as Connector;
    let mode: StatusMode = "small";
    const status: StatusControl = { get: () => mode, set: (m) => void (mode = m) };
    const env: Envelope = { channel: "t", conversation: "c", user: "u", text: "", mediaPaths: [] };
    await dispatchCommand({ name: "statusline", args: "" }, env, {} as any, conn, {} as any, undefined, undefined, status);
    expect(choiceCalls).toHaveLength(1);
    expect(choiceCalls[0].choices.map((c) => c.data)).toEqual([
      "/statusline none",
      "/statusline small",
      "/statusline full",
      "/statusline print",
    ]);
  });

  it("no arg falls back to a text hint when the channel has no buttons", async () => {
    const s = setup("small"); // s.conn's reply has no sendChoices
    await run(s, "");
    expect(s.sent[0]).toContain("small");
  });

  it("print shows the status on demand without changing the mode (gw-command-statusline)", async () => {
    const s = setup("none");
    await run(s, "print");
    expect(s.sent[0]).toBe("SNAPSHOT");
    expect(s.mode()).toBe("none"); // print is an action, not a mode change
  });

  it("rejects an unknown mode without changing it", async () => {
    const s = setup("none");
    await run(s, "verbose");
    expect(s.mode()).toBe("none");
    expect(s.sent[0]).toContain("Unknown mode");
  });

  it("none turns it off", async () => {
    const s = setup("full");
    await run(s, "none");
    expect(s.mode()).toBe("none");
    expect(s.sent[0]).toContain("off");
  });

  it("reports when unavailable", async () => {
    const s = setup("none", false);
    await run(s, "small");
    expect(s.sent[0]).toContain("isn't available");
  });
});

describe("dispatchCommand /model — switch model, effect next turn (gw-command-model)", () => {
  function setup(configured: string | undefined = "sonnet", supported = true) {
    let cur: string | undefined = configured;
    const sent: string[] = [];
    const conn = { reply: () => ({ send: async (s: string) => sent.push(s) }) } as unknown as Connector;
    const q = {} as unknown as TurnQueue;
    const mem = {} as unknown as MemoryStore;
    const env: Envelope = { channel: "t", conversation: "c", user: "u", text: "", mediaPaths: [] };
    const model: ModelControl = { get: () => cur, set: (m) => void (cur = m), configured, supported };
    return { sent, conn, q, mem, env, model, current: () => cur };
  }
  const run = (s: ReturnType<typeof setup>, args: string) =>
    dispatchCommand({ name: "model", args }, s.env, s.q, s.conn, s.mem, s.model);

  it("/model <name> sets it and acks old→new with next-turn semantics", async () => {
    const s = setup("sonnet");
    await run(s, "opus");
    expect(s.current()).toBe("opus");
    expect(s.sent[0]).toContain("sonnet → opus");
    expect(s.sent[0]).toContain("next turn");
  });

  it("/model with no arg shows a tappable picker when the channel supports it (gw-command-model)", async () => {
    const choiceCalls: { label: string; data: string }[][] = [];
    const conn = {
      reply: () => ({ send: async () => {}, sendChoices: async (_t: string, c: { label: string; data: string }[]) => void choiceCalls.push(c) }),
    } as unknown as Connector;
    const model: ModelControl = {
      get: () => "opus",
      set: () => {},
      configured: "sonnet",
      supported: true,
      choices: async () => [
        { label: "opus", data: "/model claude-opus-4-8" },
        { label: "default", data: "/model default" },
      ],
    };
    const env: Envelope = { channel: "t", conversation: "c", user: "u", text: "", mediaPaths: [] };
    await dispatchCommand({ name: "model", args: "" }, env, {} as any, conn, {} as any, model);
    expect(choiceCalls).toHaveLength(1);
    expect(choiceCalls[0].map((c) => c.data)).toContain("/model claude-opus-4-8");
  });

  it("/model with no arg reports the current model (and flags an override)", async () => {
    const s = setup("sonnet");
    await run(s, ""); // configured, no override
    expect(s.sent[0]).toContain("sonnet");
    expect(s.sent[0]).not.toContain("override");
    await run(s, "opus");
    await run(s, ""); // now an override
    expect(s.sent[2]).toContain("override");
    expect(s.sent[2]).toContain("configured: sonnet");
  });

  it("/model default clears the override back to the configured model", async () => {
    const s = setup("sonnet");
    await run(s, "opus");
    await run(s, "default");
    expect(s.current()).toBe("sonnet");
    expect(s.sent[1]).toContain("reset");
    expect(s.sent[1]).toContain("sonnet");
  });

  it("rejects an invalid model at command time and does NOT change it", async () => {
    const s = setup("sonnet");
    await run(s, "gpt-4");
    expect(s.current()).toBe("sonnet");
    expect(s.sent[0]).toContain("Unknown model");
    expect(s.sent[0]).toContain("sonnet"); // lists valid options
  });

  it("no-ops with a note when the same model is requested", async () => {
    const s = setup("opus");
    await run(s, "opus");
    expect(s.sent[0]).toContain("Already on opus");
  });

  it("reports honestly when the harness has no model switch", async () => {
    const s = setup("sonnet", false);
    await run(s, "opus");
    expect(s.current()).toBe("sonnet"); // unchanged
    expect(s.sent[0]).toContain("no model switch");
  });
});

describe("normalizeBlocks — readable reply spacing", () => {
  it("normalizes bullets to • and keeps them on their own lines", () => {
    expect(normalizeBlocks("- one\n- two")).toBe("• one\n• two");
    expect(normalizeBlocks("* a\n+ b")).toBe("• a\n• b");
  });
  it("puts a blank line around a heading", () => {
    expect(normalizeBlocks("intro\n## Status\ndone")).toBe("intro\n\n## Status\n\ndone");
  });
  it("collapses runaway blank lines to a single gap", () => {
    expect(normalizeBlocks("a\n\n\n\nb")).toBe("a\n\nb");
  });
  it("leaves already-spaced prose intact", () => {
    expect(normalizeBlocks("para one\n\npara two")).toBe("para one\n\npara two");
  });
});

describe("mdToTelegramHTML — spacing + inline formatting together", () => {
  it("renders a heading as bold on its own spaced line and bullets as •", () => {
    const out = mdToTelegramHTML("## Result\n- fixed **worker**\n- restored `core`");
    expect(out).toContain("<b>Result</b>");
    expect(out).toContain("• fixed <b>worker</b>");
    expect(out).toContain("• restored <code>core</code>");
    expect(out.split("<b>Result</b>")[1].startsWith("\n\n")).toBe(true); // blank line after heading
  });
  it("still escapes HTML and converts inline marks", () => {
    expect(mdToTelegramHTML("a <b> & `c`")).toBe("a &lt;b&gt; &amp; <code>c</code>");
  });
});

describe("parseCommand — slash-command detection (gw-command-new-session)", () => {
  it("returns null for plain text (a normal turn)", () => {
    expect(parseCommand("the worker is broken, fix it")).toBeNull();
    expect(parseCommand("  hi there")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
  it("parses a bare command, lower-cased", () => {
    expect(parseCommand("/new")).toEqual({ name: "new", args: "" });
    expect(parseCommand("  /New  ")).toEqual({ name: "new", args: "" });
  });
  it("strips an @botname suffix (group disambiguation) and keeps args", () => {
    expect(parseCommand("/new@CodyBot")).toEqual({ name: "new", args: "" });
    expect(parseCommand("/model opus 4.8")).toEqual({ name: "model", args: "opus 4.8" });
  });
});

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    state_root: "C:/state",
    health_addr: "127.0.0.1:8787",
    stream: { cursor: " 🤖", edit_interval_ms: 900 },
    agents: [{ name: "cody", container: "cody", harness: "claude-code", telegram: { token: "t" }, window_size: 30 }],
    ...overrides,
  };
}

describe("resolveAgents (roster, A11)", () => {
  it("mints a fresh GUID and a 3000-block port for a brand-new agent", () => {
    let n = 0;
    const out = resolveAgents(cfg(), [], reg(), () => `guid${n++}`);
    expect(out).toHaveLength(1);
    expect(out[0].rec.guid).toBe("guid0");
    expect(out[0].rec.port_base).toBe(3000);
    expect(out[0].rec.config_home).toBe(claudecode.CONFIG_HOME);
    expect(out[0].rec.memory_root).toBe(path.join("C:/state", "guid0", "memory"));
  });

  it("keeps an existing agent's GUID + port stable across restarts (resolve by name)", () => {
    const existing: RegAgent[] = [
      { guid: "stable123", name: "cody", harness: "claude-code", container: "cody", config_volume: "v", config_home: "/root/.claude", memory_root: "C:/state/stable123/memory", port_base: 3020 },
    ];
    const out = resolveAgents(cfg(), existing, reg(), () => "SHOULD-NOT-MINT");
    expect(out[0].rec.guid).toBe("stable123");
    expect(out[0].rec.port_base).toBe(3020);
  });

  it("honors an explicitly pinned GUID over name lookup", () => {
    const c = cfg();
    c.agents[0].guid = "pinned";
    const out = resolveAgents(c, [], reg(), () => "x");
    expect(out[0].rec.guid).toBe("pinned");
  });

  it("assigns non-overlapping port bases across multiple agents", () => {
    const c = cfg({
      agents: [
        { name: "a", container: "a", harness: "claude-code", telegram: { token: "t" } },
        { name: "b", container: "b", harness: "claude-code", telegram: { token: "t" } },
      ],
    });
    let n = 0;
    const out = resolveAgents(c, [], reg(), () => `g${n++}`);
    expect(out.map((r) => r.rec.port_base)).toEqual([3000, 3010]);
  });

  it("throws on an unknown harness", () => {
    const c = cfg();
    c.agents[0].harness = "nope";
    expect(() => resolveAgents(c, [], reg(), () => "x")).toThrow(/unknown harness/);
  });
});

describe("parseLine (stream-json → TurnEvent, A2)", () => {
  it("emits a text delta from a partial-message content_block_delta", () => {
    const line = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } });
    expect(parseLine(line)).toEqual({ kind: "text", text: "hi" });
  });

  it("emits a tool-progress event (name + arg preview) from an assistant tool_use message", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rn wiki sync" } }] } });
    expect(parseLine(line)).toEqual({ kind: "tool", tool: "Bash", text: "rn wiki sync" });
  });

  it("emits done with the final text from a result line", () => {
    const line = JSON.stringify({ type: "result", result: "the answer" });
    expect(parseLine(line)).toEqual({ kind: "done", final: "the answer" });
  });

  it("emits error from an is_error result line", () => {
    // (error_max_turns is deliberately NOT an error — it's delivered as done so the partial
    // answer lands; see claudecode.test.ts. Use a genuine failure subtype here.)
    const line = JSON.stringify({ type: "result", is_error: true, result: "boom", subtype: "error_during_execution" });
    const ev = parseLine(line)!;
    expect(ev.kind).toBe("error");
    expect(ev.err?.message).toBe("boom");
  });

  it("ignores non-JSON lines and redundant assistant summaries", () => {
    expect(parseLine("[debug] starting")).toBeNull();
    expect(parseLine(JSON.stringify({ type: "assistant", message: {} }))).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("splitChunks (A4 overflow)", () => {
  it("returns a single chunk when within budget", () => {
    expect(splitChunks("short", 4096)).toEqual(["short"]);
  });
  it("splits oversized text, preferring line boundaries", () => {
    const text = "aaaa\nbbbb\ncccc";
    const chunks = splitChunks(text, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").replace(/\n/g, "")).toBe("aaaabbbbcccc");
  });
});

describe("buildPrompt (A3 identity + window injection)", () => {
  it("injects name, role, the window, and the new message", () => {
    const p = buildPrompt("Cody", "dev agent", [{ role: "user", text: "hello", ts: "t" }], {
      channel: "telegram",
      conversation: "1",
      user: "Rod",
      text: "bring up the stack",
      mediaPaths: [],
    });
    expect(p).toContain('You are "Cody"');
    expect(p).toContain("Your role: dev agent");
    expect(p).toContain("user: hello");
    expect(p).toContain("bring up the stack");
  });

  it("lists attached media paths for the brain to read", () => {
    const p = buildPrompt("", "", [], { channel: "telegram", conversation: "1", user: "Rod", text: "", mediaPaths: ["/root/incoming/x.jpg"] });
    expect(p).toContain("/root/incoming/x.jpg");
  });
});

describe("mdToTelegramHTML", () => {
  it("converts a small markdown subset and escapes HTML", () => {
    expect(mdToTelegramHTML("**bold** and `code` and <tag>")).toBe("<b>bold</b> and <code>code</code> and &lt;tag&gt;");
  });
});

describe("handleBackendControl — loopback auth-backend switch (backend-switch-live)", () => {
  function ctlMap(initial?: "subscription" | "bedrock", supported = true): Map<string, BackendControl> {
    let v = initial;
    const ctl: BackendControl = { get: () => v, set: (b) => { v = b; }, configured: initial, supported };
    return new Map([["atlas", ctl]]);
  }

  it("rejects an unknown agent", () => {
    const r = handleBackendControl(ctlMap("bedrock"), "nope");
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/unknown agent/);
  });

  it("no mode reports the current backend + configured default", () => {
    const r = handleBackendControl(ctlMap("bedrock"), "atlas");
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/atlas backend: bedrock/);
  });

  it("flips to a valid backend and reports old → new (backend-switch-live)", () => {
    const m = ctlMap("bedrock");
    const r = handleBackendControl(m, "atlas", "subscription");
    expect(r.ok).toBe(true);
    expect(r.msg).toMatch(/bedrock → subscription/);
    expect(r.msg).toMatch(/next turn/);
    expect(m.get("atlas")!.get()).toBe("subscription"); // actually flipped
  });

  it("rejects an invalid mode", () => {
    const r = handleBackendControl(ctlMap("bedrock"), "atlas", "openai");
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/invalid backend/);
  });

  it("says so when the harness has no backend switch", () => {
    const r = handleBackendControl(ctlMap("subscription", false), "atlas", "bedrock");
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/no backend switch/);
  });
});
