import { describe, it, expect } from "vitest";
import { Runner, spec, KIND, parseLine, decodeTrace, resolveTraceMode, localEnv, toolPreview } from "./claudecode";

/** Pull the value following a flag in an argv (or undefined if the flag is absent). */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const req = { prompt: "hi" };

describe("claudecode Runner.podmanArgs — model knob is per-turn (gw-command-model)", () => {
  it("emits --model for the configured model and never --bare/--resume", () => {
    const r = new Runner({ container: "cody", model: "sonnet" });
    const args = r.podmanArgs(req);
    expect(flagValue(args, "--model")).toBe("sonnet");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--resume");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("omits --model entirely when no model is set (account default)", () => {
    const r = new Runner({ container: "cody" });
    expect(r.podmanArgs(req)).not.toContain("--model");
  });

  it("emits --disallowedTools as a comma list to trim the context floor; omits it when empty/unset", () => {
    const r = new Runner({ container: "cody", disallowedTools: ["Task", "NotebookEdit", "TodoWrite"] });
    expect(flagValue(r.podmanArgs(req), "--disallowedTools")).toBe("Task,NotebookEdit,TodoWrite");
    expect(new Runner({ container: "cody" }).podmanArgs(req)).not.toContain("--disallowedTools");
    expect(new Runner({ container: "cody", disallowedTools: [] }).podmanArgs(req)).not.toContain("--disallowedTools");
  });

  it("emits --max-turns N to cap the agentic loop; omits it when uncapped (0/undefined)", () => {
    expect(flagValue(new Runner({ container: "cody", maxTurns: 10 }).podmanArgs(req), "--max-turns")).toBe("10");
    expect(new Runner({ container: "cody" }).podmanArgs(req)).not.toContain("--max-turns");
    expect(new Runner({ container: "cody", maxTurns: 0 }).podmanArgs(req)).not.toContain("--max-turns");
  });

  it("session mode: --session-id to CREATE, --resume to CONTINUE; neither without a sessionId", () => {
    const r = new Runner({ container: "cody" });
    const created = r.podmanArgs({ prompt: "hi", sessionId: "uuid-1", sessionNew: true });
    expect(flagValue(created, "--session-id")).toBe("uuid-1");
    expect(created).not.toContain("--resume");
    const resumed = r.podmanArgs({ prompt: "next", sessionId: "uuid-1", sessionNew: false });
    expect(flagValue(resumed, "--resume")).toBe("uuid-1");
    expect(resumed).not.toContain("--session-id");
    const plain = r.podmanArgs({ prompt: "hi" }); // no session → substrate-window mode, unchanged
    expect(plain).not.toContain("--resume");
    expect(plain).not.toContain("--session-id");
  });

  it("setModel takes effect on the NEXT podmanArgs (the next turn), not retroactively", () => {
    const r = new Runner({ container: "cody", model: "sonnet" });
    expect(flagValue(r.podmanArgs(req), "--model")).toBe("sonnet");
    r.setModel("opus");
    expect(r.getModel()).toBe("opus");
    expect(flagValue(r.podmanArgs(req), "--model")).toBe("opus"); // next turn uses it
    r.setModel(undefined); // reset to account default
    expect(r.podmanArgs(req)).not.toContain("--model");
  });

  it("spec exposes a runner whose model is mutable (the /model seam)", () => {
    expect(spec().kind).toBe(KIND);
    const runner = spec().newRunner({ container: "cody", model: "sonnet" });
    expect(typeof runner.setModel).toBe("function");
    expect(runner.getModel?.()).toBe("sonnet");
  });
});

describe("claudecode local-exec transport — gateway/agent split (net-local-exec)", () => {
  it("localArgs is the transport-neutral tail: no exec/run/container, starts at -p", () => {
    const r = new Runner({ local: true, model: "sonnet" });
    const a = r.localArgs(req);
    expect(a[0]).toBe("-p");
    expect(a).not.toContain("exec");
    expect(a).not.toContain("run");
    expect(a).not.toContain("--volumes-from");
    expect(a).toContain("--dangerously-skip-permissions");
    expect(flagValue(a, "--model")).toBe("sonnet");
    // model/session/max-turns still ride the tail exactly as in the podman path
    expect(a).toContain("--output-format");
    expect(flagValue(a, "--output-format")).toBe("stream-json");
  });

  it("localArgs still emits --max-turns and the session flags (parity with podmanArgs tail)", () => {
    const r = new Runner({ local: true, maxTurns: 10 });
    expect(flagValue(r.localArgs({ prompt: "hi", sessionId: "s1", sessionNew: true }), "--session-id")).toBe("s1");
    expect(flagValue(r.localArgs({ prompt: "hi", sessionId: "s1", sessionNew: false }), "--resume")).toBe("s1");
    expect(flagValue(r.localArgs(req), "--max-turns")).toBe("10");
  });

  it("local mode needs no container; non-local still requires one", () => {
    expect(() => new Runner({ local: true })).not.toThrow();
    expect(() => new Runner({ container: "" })).toThrow(/empty container/);
  });

  it("the local tail equals the podman tail (byte-identical after the transport prefix)", () => {
    const local = new Runner({ local: true, model: "opus" });
    const exec = new Runner({ container: "cody", model: "opus" });
    const rq = { prompt: "hi", sessionId: "s", sessionNew: true, systemPromptFile: "/root/agent/AGENTS.md" };
    const execArgs = exec.podmanArgs(rq);
    const tailStart = execArgs.indexOf("-p"); // everything from -p on is transport-neutral
    expect(execArgs.slice(tailStart)).toEqual(local.localArgs(rq));
  });
});

describe("claudecode ephemeral runner — /btw sidecar argv (gw-command-btw)", () => {
  it("builds `run --rm --volumes-from <caller>` with the harness env, not `exec`", () => {
    const r = new Runner({
      container: "cody",
      ephemeral: { volumesFrom: "cody", image: "localhost/tonoman/claudecode:latest", env: { CLAUDE_CONFIG_DIR: "/root/.claude" } },
    });
    const a = r.podmanArgs({ prompt: "hi" });
    expect(a[0]).toBe("run");
    expect(a).toContain("--rm");
    expect(a).toContain("--volumes-from");
    expect(a[a.indexOf("--volumes-from") + 1]).toBe("cody");
    expect(a).toContain("localhost/tonoman/claudecode:latest");
    expect(a).toContain("CLAUDE_CONFIG_DIR=/root/.claude"); // env set so config resolves to shared volume
    expect(a).not.toContain("exec");
    // still a real headless claude turn with the sandbox flag
    expect(a).toContain("-p");
    expect(a).toContain("--dangerously-skip-permissions");
  });

  it("spec.newEphemeralRunner wires the sidecar from EphemeralParams", () => {
    const runner = spec().newEphemeralRunner!({
      volumesFrom: "cardy",
      image: "img:latest",
      env: { CLAUDE_CONFIG_DIR: "/root/.claude" },
      model: "sonnet",
    });
    const a = (runner as Runner).podmanArgs({ prompt: "x" });
    expect(a[0]).toBe("run");
    expect(a[a.indexOf("--volumes-from") + 1]).toBe("cardy");
    expect(a[a.indexOf("--model") + 1]).toBe("sonnet");
  });
});

describe("parseLine usage — result line → TurnUsage (gw-command-statusline)", () => {
  it("normalizes usage + cost onto the done event; context = PEAK iteration, not the summed totals", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      result: "hi",
      total_cost_usd: 0.2,
      usage: {
        input_tokens: 3019,
        cache_creation_input_tokens: 5056,
        cache_read_input_tokens: 78047, // summed across iterations — would over-count the window
        output_tokens: 9,
        iterations: [
          { input_tokens: 3019, cache_read_input_tokens: 13860, cache_creation_input_tokens: 5056 }, // ctx 21935
          { input_tokens: 100, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 }, // ctx 8100
        ],
      },
      modelUsage: {
        "claude-haiku-4-5-20251001": { inputTokens: 1073, contextWindow: 200000 },
        "claude-opus-4-8[1m]": { inputTokens: 3019, cacheReadInputTokens: 78047, contextWindow: 1000000 },
      },
    });
    // primary model = the one with the most tokens (opus); its real 1M window is captured.
    expect(parseLine(line)).toEqual({
      kind: "done",
      final: "hi",
      usage: {
        inputTokens: 3019,
        cacheWriteTokens: 5056,
        cacheReadTokens: 78047,
        outputTokens: 9,
        costUsd: 0.2,
        contextTokens: 21935,
        model: "opus-4-8[1m]",
        contextWindow: 1000000,
      },
    });
  });

  it("contextTokens falls back to the single-call sum when no iterations are present", () => {
    const line = JSON.stringify({
      type: "result",
      result: "hi",
      usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 200, output_tokens: 4 },
    });
    const ev = parseLine(line)!;
    expect(ev.usage?.contextTokens).toBe(350);
  });

  it("omits usage when the result carries neither usage nor cost", () => {
    expect(parseLine(JSON.stringify({ type: "result", result: "hi" }))).toEqual({ kind: "done", final: "hi" });
  });

  it("treats an error_max_turns result as DONE + capped (partial answer lands, not a failure)", () => {
    const ev = parseLine(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns", result: "" }));
    expect(ev).toEqual({ kind: "done", final: "", capped: true });
  });

  it("still surfaces a real error result (other subtypes) as an error", () => {
    const ev = parseLine(JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "boom" }));
    expect(ev?.kind).toBe("error");
  });

  // gw-tool-narration — a tool step surfaces from the assistant message with a short arg preview.
  it("emits a tool event (name + arg preview) from an assistant tool_use message", () => {
    const ev = parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rn wiki sync" } }] } }));
    expect(ev).toEqual({ kind: "tool", tool: "Bash", text: "rn wiki sync" });
  });

  it("ignores an assistant message that carries only text (no tool_use)", () => {
    expect(parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }))).toBeNull();
  });

  it("toolPreview picks the primary arg, collapses whitespace, and bounds length", () => {
    expect(toolPreview("Bash", { command: "rn  wiki   sync" })).toBe("rn wiki sync");
    expect(toolPreview("Read", { file_path: "/root/files/wiki-p/x.md" })).toBe("/root/files/wiki-p/x.md");
    expect(toolPreview("Grep", { pattern: "TODO", path: "/src" })).toBe("TODO");
    expect(toolPreview("X", {}).length).toBe(0);
    expect(toolPreview("Bash", { command: "x".repeat(200) }).length).toBe(60);
  });
});

describe("claudecode trace — full-execution visibility (resolveTraceMode + decodeTrace)", () => {
  it("resolveTraceMode: defaults ON, honors off/raw aliases", () => {
    expect(resolveTraceMode(undefined)).toBe("on");
    expect(resolveTraceMode("")).toBe("on");
    expect(resolveTraceMode("off")).toBe("off");
    expect(resolveTraceMode("0")).toBe("off");
    expect(resolveTraceMode("raw")).toBe("raw");
    expect(resolveTraceMode("verbose")).toBe("raw");
  });

  it("decodes system-init, tool_use, tool_result, and result lines", () => {
    expect(decodeTrace(JSON.stringify({ type: "system", subtype: "init", model: "sonnet", tools: ["a", "b"] }), "on"))
      .toEqual(["init model=sonnet tools=2"]);
    expect(decodeTrace(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "billing get time" } }] } }), "on"))
      .toEqual(['→ tool_use Bash({"command":"billing get time"})']);
    expect(decodeTrace(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "not found" }] }] } }), "on"))
      .toEqual(["← tool_result ERR not found"]);
    const res = decodeTrace(JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 }), "on");
    expect(res[0]).toBe("✓ result 15tok $0.0100 done");
  });

  it("concise mode skips per-token stream_event deltas; raw mode dumps them", () => {
    const delta = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } });
    expect(decodeTrace(delta, "on")).toEqual([]);
    expect(decodeTrace(delta, "raw").some((l) => l.startsWith("raw "))).toBe(true);
  });

  it("raw mode surfaces stray non-JSON lines (real errors); concise mode ignores them", () => {
    expect(decodeTrace("Traceback: something broke", "on")).toEqual([]);
    expect(decodeTrace("Traceback: something broke", "raw")).toEqual(["· Traceback: something broke"]);
  });

  it("caps previews so full payloads/PII do not flood the log", () => {
    const big = "x".repeat(500);
    const [line] = decodeTrace(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: big }] } }), "on");
    expect(line.length).toBeLessThan(220);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("localEnv — backend-aware child env (backend-*)", () => {
  const base = {
    PATH: "/usr/bin",
    AWS_ACCESS_KEY_ID: "AKIA",
    AWS_REGION: "us-east-1",
    ANTHROPIC_MODEL: "us.anthropic.claude-sonnet-4-6",
    ANTHROPIC_API_KEY: "sk-must-drop",
  } as NodeJS.ProcessEnv;

  it("always sets IS_SANDBOX + CLAUDE_CONFIG_DIR and drops ANTHROPIC_API_KEY (A2)", () => {
    const e = localEnv(base);
    expect(e.IS_SANDBOX).toBe("1");
    expect(e.CLAUDE_CONFIG_DIR).toBe("/root/.claude");
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("bedrock sets CLAUDE_CODE_USE_BEDROCK and keeps region/model/keys from the pod env (backend-bedrock-turn)", () => {
    const e = localEnv(base, "bedrock");
    expect(e.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(e.AWS_REGION).toBe("us-east-1");
    expect(e.ANTHROPIC_MODEL).toBe("us.anthropic.claude-sonnet-4-6");
    expect(e.AWS_ACCESS_KEY_ID).toBe("AKIA");
  });

  it("subscription clears the bedrock/mantle flags + ANTHROPIC_MODEL so OAuth resolves (backend-subscription-turn)", () => {
    const e = localEnv({ ...base, CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_MANTLE: "1" } as NodeJS.ProcessEnv, "subscription");
    expect(e.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(e.CLAUDE_CODE_USE_MANTLE).toBeUndefined();
    expect(e.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("undefined backend leaves the pod env's backend as-is (back-compat)", () => {
    const e = localEnv({ ...base, CLAUDE_CODE_USE_BEDROCK: "1" } as NodeJS.ProcessEnv);
    expect(e.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });
});
