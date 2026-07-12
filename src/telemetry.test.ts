import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeClaudeTranscript, sinkFromEnv, buildLangfuseBatch, withStopHook, registerClaudeHook, costOf, fullContextEnabled, parsePrefix, fullContextSections } from "./telemetry";
import { spec as claudecodeSpec } from "./harness/claudecode";

// A minimal Claude Code transcript for one turn: prompt → assistant text + a tool_use → tool_result.
const transcript = [
  { type: "queue-operation" },
  { type: "user", message: { role: "user", content: "OLD prompt from a prior turn" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "old reply" }], usage: { input_tokens: 5 }, model: "old" } },
  // --- current turn starts at the last STRING user prompt ---
  { type: "user", message: { role: "user", content: "log 2 hours for Emily" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "t1", input: { command: "billing log time" } }], usage: {}, model: "us.anthropic.claude-sonnet-4-6" } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Logged 2h for Emily." }], usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 9000, cache_creation_input_tokens: 24000 }, model: "us.anthropic.claude-sonnet-4-6" } },
];

describe("decodeClaudeTranscript — transcript → neutral trace (obs-adapter-hook / obs-trace-neutral)", () => {
  it("extracts the CURRENT turn only (after the last string prompt), with prompt/reply/tools/tokens", () => {
    const t = decodeClaudeTranscript(transcript, { agent: "atlas", backend: "bedrock", session: "s1", user: "Priya" });
    expect(t.prompt).toBe("log 2 hours for Emily");
    expect(t.reply).toBe("Logged 2h for Emily.");
    expect(t.model).toBe("us.anthropic.claude-sonnet-4-6");
    expect(t.tools).toEqual([{ name: "Bash", input: { command: "billing log time" }, output: '{"ok":true}' }]);
    expect(t.tokens).toEqual({ input: 120, output: 30, cacheRead: 9000, cacheCreation: 24000 });
    expect(t.agent).toBe("atlas");
    expect(t.backend).toBe("bedrock");
  });
  it("does not bleed the prior turn's text into the reply", () => {
    expect(decodeClaudeTranscript(transcript).reply).not.toMatch(/old reply/);
  });
  it("a thinking entry carries usage BEFORE the text flushes → tokens present, reply still empty (why the hook must wait for reply, not just usage)", () => {
    // On an extended-thinking turn Claude writes the `thinking` entry (stamped with usage) first, then
    // the `text` entry. If the Stop hook reads at this instant, usage is present but the reply is not —
    // so a usage-only guard would post an empty output. The hook must keep waiting for `reply`.
    const midFlush = [
      { type: "user", message: { content: "log 2 hours for Rod" } },
      { type: "assistant", message: { model: "m", usage: { input_tokens: 2, output_tokens: 115 }, content: [{ type: "thinking", thinking: "…" }] } },
    ];
    const t = decodeClaudeTranscript(midFlush);
    expect(t.tokens.output).toBe(115); // usage already landed…
    expect(t.reply).toBe(""); // …but the reply hasn't — do NOT post yet
  });
});

describe("sinkFromEnv — one config, mapped across env-name quirks (obs-sink-config / obs-sink-mapping)", () => {
  const base = { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" };
  it("null when unconfigured → tracing OFF", () => {
    expect(sinkFromEnv({})).toBeNull();
  });
  it("reads keys + LANGFUSE_BASE_URL (Claude Code / Codex), trimming trailing slash", () => {
    expect(sinkFromEnv({ ...base, LANGFUSE_BASE_URL: "http://lf:3000/" } as NodeJS.ProcessEnv)).toEqual({ publicKey: "pk", secretKey: "sk", baseUrl: "http://lf:3000" });
  });
  it("also accepts LANGFUSE_BASEURL (OpenCode quirk)", () => {
    expect(sinkFromEnv({ ...base, LANGFUSE_BASEURL: "http://lf:3000" } as NodeJS.ProcessEnv)?.baseUrl).toBe("http://lf:3000");
  });
  it("explicit TRACE_TO_LANGFUSE=false disables even with keys present", () => {
    expect(sinkFromEnv({ ...base, LANGFUSE_BASE_URL: "http://lf", TRACE_TO_LANGFUSE: "false" } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("buildLangfuseBatch — neutral trace → Langfuse ingestion (obs-zero-dep)", () => {
  it("emits a trace + a generation (with usage) + a span per tool", () => {
    let n = 0;
    const t = decodeClaudeTranscript(transcript, { agent: "atlas", backend: "bedrock" });
    const { batch } = buildLangfuseBatch(t, () => `id${n++}`, "2026-07-04T00:00:00Z") as { batch: any[] };
    const types = batch.map((b) => b.type);
    expect(types).toEqual(["trace-create", "generation-create", "span-create"]);
    const tc = batch.find((b) => b.type === "trace-create");
    expect(tc.body.name).toBe("atlas-turn"); // per-agent name → fleet cost groups by agent
    expect(tc.body.tags).toContain("agent:atlas");
    expect(tc.body.tags).toContain("backend:bedrock");
    const gen = batch.find((b) => b.type === "generation-create");
    expect(gen.body.usage).toMatchObject({ input: 120, output: 30, unit: "TOKENS" });
    // `total` folds in the cache tiers so the headline token count agrees with the cost (input/output
    // stay pure; the gap up to total is the cache). Precise split remains in metadata.
    expect(gen.body.usage.total).toBe(120 + 30 + 9000 + 24000); // = 33150
    expect(gen.body.usage.totalCost).toBeGreaterThan(0); // cost sent explicitly so Langfuse v2 shows it
    expect(gen.body.metadata.cache_creation_input_tokens).toBe(24000);
    expect(batch.find((b) => b.type === "span-create").body.name).toBe("tool:Bash");
  });
});

describe("withStopHook / registerClaudeHook — runtime registers the hook (obs-runtime-registers)", () => {
  it("adds a Stop hook and preserves other settings; idempotent", () => {
    const once = withStopHook({ model: "sonnet", hooks: { PreToolUse: [] } }, "node cli __trace-hook") as any;
    expect(once.model).toBe("sonnet");
    expect(once.hooks.PreToolUse).toEqual([]);
    expect(once.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "node cli __trace-hook" }] }]);
    const twice = withStopHook(once, "node cli __trace-hook") as any;
    expect(twice.hooks.Stop).toHaveLength(1); // not appended twice
  });

  it("writes settings.json with the trace hook", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tono-tel-"));
    try {
      await registerClaudeHook(dir, "/opt/tonoman/dist/cli.js");
      const s = JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));
      expect(s.hooks.Stop[0].hooks[0].command).toContain("__trace-hook");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("costOf — cache-aware USD cost (obs cost visibility)", () => {
  it("prices sonnet incl. cache tiers (cache dominates)", () => {
    const c = costOf("us.anthropic.claude-sonnet-4-6", { input: 3, output: 67, cacheRead: 20429, cacheCreation: 2226 });
    expect(c.total).toBeGreaterThan(0);
    expect(c.total).toBeCloseTo(3 * 3e-6 + 20429 * 0.3e-6 + 2226 * 3.75e-6 + 67 * 15e-6, 6);
    // per-tier broken out (so cache cost is legible, not folded into input)
    expect(c.input).toBeCloseTo(3 * 3e-6, 9);
    expect(c.output).toBeCloseTo(67 * 15e-6, 9);
    expect(c.cacheWrite).toBeCloseTo(2226 * 3.75e-6, 9);
    expect(c.cacheRead).toBeCloseTo(20429 * 0.3e-6, 9);
  });
  it("prices opus higher than sonnet for the same tokens", () => {
    const toks = { input: 1000, output: 1000, cacheRead: 1000, cacheCreation: 1000 };
    expect(costOf("claude-opus-4-8", toks).total!).toBeGreaterThan(costOf("claude-sonnet-4-6", toks).total!);
  });
  it("returns {} for an unpriced/unknown model (no fake cost)", () => {
    expect(costOf("some-unknown-model", { input: 100, output: 100 })).toEqual({});
    expect(costOf(undefined, { input: 100 })).toEqual({});
  });
});

describe("full-context capture — assemble the entire request post-hoc (fctx-*)", () => {
  it("fullContextEnabled is OFF unless explicitly truthy (fctx-flag-gated)", () => {
    expect(fullContextEnabled({})).toBe(false);
    expect(fullContextEnabled({ TRACE_FULL_CONTEXT: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(fullContextEnabled({ TRACE_FULL_CONTEXT: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(fullContextEnabled({ TRACE_FULL_CONTEXT: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("parsePrefix extracts system blocks + tool schemas from a captured request (fctx-boot-prefix)", () => {
    const p = parsePrefix({
      model: "x",
      system: [{ type: "text", text: "You are Atlas." }, { type: "text", text: "Rules…" }],
      tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(p).not.toBeNull();
    expect(p!.system).toEqual(["You are Atlas.", "Rules…"]);
    expect(p!.tools[0]).toMatchObject({ name: "Bash", description: "run a command" });
  });
  it("parsePrefix returns null for a non-request object", () => {
    expect(parsePrefix({ foo: 1 })).toBeNull();
  });
  it("fullContextSections = one section for system prompt + one PER TOOL + one for messages (fctx-captures-entire-request)", () => {
    const prefix = { system: ["You are Atlas."], tools: [{ name: "Bash", description: "shell" }, { name: "Read", description: "read a file" }] };
    const secs = fullContextSections(prefix, transcript); // reuse the module-level transcript fixture
    expect(secs.map((s) => s.label)).toEqual(["system prompt", "tool: Bash", "tool: Read", "messages"]);
    expect(secs[0].text).toContain("You are Atlas.");
    expect(secs[1].text).toContain("shell");
    const msgs = secs.find((s) => s.label === "messages")!.text;
    expect(msgs).toContain("log 2 hours for Emily"); // current turn's prompt
    expect(msgs).toContain("OLD prompt from a prior turn"); // AND prior history (grows with session)
    expect(msgs).toContain("[tool_use Bash]"); // tool calls rendered
  });
  it("fullContextSections degrades gracefully when the prefix wasn't captured", () => {
    const secs = fullContextSections(null, transcript);
    expect(secs[0].text).toContain("prefix not captured at boot");
    expect(secs.find((s) => s.label === "messages")!.text).toContain("log 2 hours for Emily");
  });
  it("splits a multi-block system prompt (base + appended identity) into one span per block", () => {
    // Claude Code sends system as an array; --append-system-prompt-file adds a block. This is how the
    // agent's AGENTS.md identity (and any extra appended prompt) surfaces as its own span.
    const prefix = { system: ["You are Claude Code, the base prompt…", "# Atlas — Billing Assistant\nYou are Atlas."], tools: [{ name: "Bash", description: "shell" }] };
    const secs = fullContextSections(prefix, transcript);
    expect(secs.map((s) => s.label)).toEqual(["system prompt [1/2]", "system prompt [2/2]", "tool: Bash", "messages"]);
    expect(secs[1].text).toContain("You are Atlas."); // the appended identity is legible on its own
  });
  it("peels an appended identity (AGENTS.md) concatenated onto the base system block into its own span", () => {
    // Real Claude Code behaviour: --append-system-prompt-file concatenates onto the TAIL of the base
    // block (not a new array entry). We know the file we appended, so we split it back out.
    const identity = "# Atlas — Billing Assistant\nYou are Atlas, the firm's billing assistant.";
    const prefix = { system: [`You are Claude Code, the base prompt with tool guidance…\n\n${identity}`], tools: [{ name: "Bash", description: "shell" }] };
    const secs = fullContextSections(prefix, transcript, [{ label: "identity: AGENTS.md", text: identity }]);
    const id = secs.find((s) => s.label === "identity: AGENTS.md")!;
    expect(id).toBeDefined();
    expect(id.text).toContain("You are Atlas");
    const sys = secs.find((s) => s.label === "system prompt")!;
    expect(sys.text).toContain("base prompt with tool guidance");
    expect(sys.text).not.toContain("You are Atlas"); // identity peeled OUT of the base block
  });
  it("a skill loaded via the Skill tool becomes its OWN span and is elided from messages", () => {
    const withSkill = [
      { type: "user", message: { role: "user", content: "draft today's invoices" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", id: "s1", input: { command: "billing" } }], usage: {}, model: "us.anthropic.claude-sonnet-4-6" } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "# Northgate Advisors — Billing\nDrive the billing CLI; never compute invoice math yourself." }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "3 drafts ready." }], usage: { input_tokens: 100 }, model: "us.anthropic.claude-sonnet-4-6" } },
    ];
    const prefix = { system: ["You are Atlas."], tools: [{ name: "Bash", description: "shell" }] };
    const secs = fullContextSections(prefix, withSkill);
    expect(secs.map((s) => s.label)).toEqual(["system prompt", "tool: Bash", "skill: billing", "messages"]);
    expect(secs.find((s) => s.label === "skill: billing")!.text).toContain("never compute invoice math");
    // the skill body is pulled OUT of messages, replaced by a one-line pointer
    const msgs = secs.find((s) => s.label === "messages")!.text;
    expect(msgs).not.toContain("never compute invoice math");
    expect(msgs).toContain("[skill body shown in its own span]");
  });
  it("buildLangfuseBatch emits ONE span per section, token count in the name (fctx-attaches-to-trace)", () => {
    let n = 0;
    const t = decodeClaudeTranscript(transcript, { agent: "atlas" });
    const without = buildLangfuseBatch(t, () => `a${n++}`, "2026-07-05T00:00:00Z") as { batch: any[] };
    expect(without.batch.find((b) => String(b.body?.name).startsWith("ctx:"))).toBeUndefined();
    n = 0;
    const sections = [
      { label: "system prompt", text: "x".repeat(24000) }, // ~6k tok
      { label: "tool: Bash", text: "y".repeat(400) }, // ~100 tok
      { label: "messages", text: "hi" },
    ];
    const withCtx = buildLangfuseBatch(t, () => `b${n++}`, "2026-07-05T00:00:00Z", sections) as { batch: any[] };
    const ctxSpans = withCtx.batch.filter((b) => String(b.body?.name).startsWith("ctx:"));
    expect(ctxSpans).toHaveLength(3);
    expect(ctxSpans[0].body.name).toBe("ctx: system prompt · ~6.0k tok"); // token count in the name
    expect(ctxSpans[1].body.name).toBe("ctx: tool: Bash · ~100 tok");
    expect(ctxSpans[0].body.input).toBe("x".repeat(24000));
    expect(ctxSpans[0].body.metadata.est_tokens).toBe(6000);
  });
});

describe("Spec.telemetry — the harness declares its adapter, runtime wires it (obs-harness-neutral)", () => {
  it("claude-code declares a `hook` adapter that registers via the Spec (not a hardcoded call)", async () => {
    const tel = claudecodeSpec().telemetry;
    expect(tel?.kind).toBe("hook");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tono-spec-"));
    try {
      await tel!.register({ configDir: dir, cliPath: "/opt/tonoman/dist/cli.js", sink: { publicKey: "pk", secretKey: "sk", baseUrl: "http://lf" } });
      const s = JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));
      expect(s.hooks.Stop[0].hooks[0].command).toContain("__trace-hook");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
