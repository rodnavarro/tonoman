// The Claude Code turn-runner (A2): the only harness-specific code in the gateway.
// It runs one headless turn via
//
//   podman exec -i -e IS_SANDBOX=1 <agent> claude -p --output-format stream-json \
//     --include-partial-messages --verbose --setting-sources user \
//     --dangerously-skip-permissions --append-system-prompt-file <identity>
//
// with the assembled prompt on stdin and NO --resume (memory is substrate-owned,
// A3) and NOT --bare (bare ignores the OAuth credential, A2). It parses the NDJSON
// stdout into normalized TurnEvent values, reading by LINE (readline) so a JSON
// object split across stdout chunks is never mis-parsed.

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { TurnEvent, TurnRequest, TurnRunner } from "../core/contracts";
import type { Spec, RunnerParams, EphemeralParams } from "../harness";
import { registerClaudeHook } from "../telemetry";

/** The harness key used in agent config. */
export const KIND = "claude-code";

/** The Tonoman-owned, per-runtime sandbox image (A11) — minimal + non-privileged,
 * built from images/claudecode/ in the repo. Container ops are brokered to the host
 * (A13 Profile 1), so this never needs nested/privileged podman. Fully qualified with
 * the `localhost/` registry so podman resolves the locally-built image without a
 * short-name prompt or a registry lookup; published images swap the registry prefix. */
export const IMAGE = "localhost/tonoman/claudecode:latest";

// Where Claude Code keeps its state inside the sandbox; the per-agent config
// volume is bind-mounted here so the OAuth credential store persists (A11).
export const CONFIG_HOME = "/root/.claude";

/** Where the per-agent identity dir (AGENTS.md/persona) bind-mounts READ-ONLY; the
 * turn-runner injects it via --append-system-prompt-file <identity>/AGENTS.md (A2). */
export const IDENTITY_HOME = "/root/agent";

export interface RunnerOptions {
  container?: string; // required for the podman-exec transport; omitted in local-exec mode
  model?: string;
  bin?: string; // claude binary; default "claude"
  podman?: string; // podman binary; default "podman"
  maxTurns?: number; // cap the internal agentic tool-loop (--max-turns); <=0/undefined = uncapped
  // Claude-Code-SPECIFIC tool names to drop from the turn (--disallowedTools), e.g.
  // ["Task","NotebookEdit","TodoWrite"] — removes their schemas from the context floor for an agent
  // that never uses them. These names are Claude Code's own; a Codex/OpenCode backend would have its
  // OWN tool taxonomy + its own knob, so this deliberately lives on the claude-code harness, not in
  // the harness-neutral roster. (`--allowedTools` is NOT used: it keeps schemas and ADDS guidance.)
  disallowedTools?: string[];
  extraArgs?: string[]; // MUST NOT include --bare or --resume
  settingSources?: string; // default "user" (discovers the preset skill, A2)
  // Ephemeral mode (gw-command-btw): instead of `podman exec <container>`, run a throwaway
  // `podman run --rm --volumes-from <caller>` sandbox from the harness image and tear it
  // down after the turn. Inherits the caller's mounts (shared credential, identity, skills).
  ephemeral?: { volumesFrom: string; image: string; env?: Record<string, string> };
  // Local-exec mode (k8s split): spawn `claude` as a DIRECT child in this same process's
  // container — no `podman exec`, no cross-container transport. The pod is the isolation
  // boundary. Used by the agent runtime server (src/agent/server.ts); the gateway reaches it
  // over HTTP (src/harness/httpRunner.ts), never by exec. `container` is not required here.
  local?: boolean;
  // Auth backend for THIS turn (backend-*): "bedrock" runs on AWS Bedrock (sets
  // CLAUDE_CODE_USE_BEDROCK; region/model come from the pod env), "subscription" runs on the
  // Claude OAuth credential (bedrock flags cleared). Only meaningful for local-exec (the pod
  // carries both credential sets); undefined leaves the process env's backend as-is.
  backend?: BackendMode;
}

/** The brain auth backend for a turn (backend-*): the Claude subscription (OAuth) or AWS Bedrock. */
export type BackendMode = "subscription" | "bedrock";

/** Build the child env for a local-exec turn given the desired auth backend (backend-bedrock-turn /
 * backend-subscription-turn). Pure + testable (run() spawns; this doesn't). Always sets IS_SANDBOX +
 * CLAUDE_CONFIG_DIR and drops ANTHROPIC_API_KEY (it must never outrank OAuth, A2). Then:
 *  - "bedrock": set CLAUDE_CODE_USE_BEDROCK=1 — AWS_REGION + ANTHROPIC_MODEL + the SigV4 keys come
 *    from the pod env (helm), which are already in `base`.
 *  - "subscription": clear CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_MANTLE / ANTHROPIC_MODEL so the
 *    OAuth credential resolves and no Bedrock model id leaks onto the subscription path.
 *  - undefined: leave whatever backend the pod env declares (back-compat). */
export function localEnv(base: NodeJS.ProcessEnv, backend?: BackendMode): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, IS_SANDBOX: "1", CLAUDE_CONFIG_DIR: CONFIG_HOME };
  delete env.ANTHROPIC_API_KEY;
  if (backend === "bedrock") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
  } else if (backend === "subscription") {
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_MANTLE;
    delete env.ANTHROPIC_MODEL;
  }
  return env;
}

export class Runner implements TurnRunner {
  // The model is mutable so `/model` can switch it (gw-command-model). podmanArgs reads
  // it per turn, so a change takes effect on the NEXT turn — a turn already spawned keeps
  // the model its argv was built with.
  private model?: string;
  constructor(private readonly o: RunnerOptions) {
    // Local-exec needs no container (the pod IS the sandbox); every other mode does.
    if (!o.local && !o.container) throw new Error("claudecode: empty container");
    this.model = o.model;
  }

  /** Current model flag (undefined = harness/account default). */
  getModel(): string | undefined {
    return this.model;
  }
  /** Set the model used from the next turn on (gw-command-model). */
  setModel(model: string | undefined): void {
    this.model = model;
  }

  /** The transport-neutral `claude` flags for one turn — everything AFTER the `claude`
   * binary, identical whether we reach claude via `podman exec` or spawn it locally. This is
   * the wire-neutral core of a turn (the argv tail the runtime server receives). Separated so
   * the contract (right flags, never --bare/--resume) is testable without podman. */
  private claudeTail(req: TurnRequest): string[] {
    // The sandbox IS the security boundary, so --dangerously-skip-permissions
    // (headless -p has no one to approve tool calls; an allow-list silently denies
    // a skill's own sub-tools). IS_SANDBOX=1 (set by the transport) is required for that as root.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources",
      this.o.settingSources ?? "user",
      "--dangerously-skip-permissions",
    ];
    // Drop tools this agent never uses, so their schemas leave the context floor (claude-code-only).
    if (this.o.disallowedTools && this.o.disallowedTools.length) {
      args.push("--disallowedTools", this.o.disallowedTools.join(","));
    }
    if (req.systemPromptFile) args.push("--append-system-prompt-file", req.systemPromptFile);
    if (this.model) args.push("--model", this.model); // mutable: /model switches it per turn
    // Cap the internal agentic tool-loop so one open-ended turn (e.g. a research rabbit hole)
    // can't loop unbounded and drain the account's usage window. Hitting the cap exits with an
    // error result (subtype "error_max_turns") — parseLine treats that as DONE so the partial
    // answer still lands rather than surfacing as a failure.
    if (this.o.maxTurns && this.o.maxTurns > 0) args.push("--max-turns", String(this.o.maxTurns));
    // Session mode (opt-in, session-persist agents): resume the harness's OWN session so the
    // conversation history is cached across turns instead of re-sent on stdin every turn — only
    // the new message rides in req.prompt. First turn CREATES it (--session-id); later turns
    // RESUME it (--resume). Without a sessionId this stays substrate-owned (window on stdin, A3).
    if (req.sessionId) args.push(req.sessionNew ? "--session-id" : "--resume", req.sessionId);
    if (this.o.extraArgs) args.push(...this.o.extraArgs);
    return args;
  }

  /** Builds the full `podman exec …` (or ephemeral `podman run …`) argv for one turn.
   * ANTHROPIC_API_KEY must stay unset (A2): the image/run never set it. We do NOT pass
   * -e ANTHROPIC_API_KEY= (an empty value can read as "set" and outrank OAuth). */
  podmanArgs(req: TurnRequest): string[] {
    const bin = this.o.bin ?? "claude";
    const e = this.o.ephemeral;
    let base: string[];
    if (e) {
      // Ephemeral sidecar (gw-command-btw): a throwaway container from the harness image,
      // inheriting the caller's mounts (shared credential + identity + skills) via
      // --volumes-from, removed on exit (--rm). The harness env is set so config resolves
      // to the shared volume (e.g. CLAUDE_CONFIG_DIR) — without it claude warns it can't
      // find its config at the default path (spike finding).
      base = ["run", "--rm", "-i", "-e", "IS_SANDBOX=1"];
      for (const [k, v] of Object.entries(e.env ?? {})) base.push("-e", `${k}=${v}`);
      base.push("--volumes-from", e.volumesFrom, e.image, bin);
    } else {
      base = ["exec", "-i", "-e", "IS_SANDBOX=1", this.o.container!, bin]; // guaranteed non-empty by ctor (non-local)
    }
    return [...base, ...this.claudeTail(req)];
  }

  /** Local-exec argv (k8s split): the transport-neutral claude flags with NO podman prefix
   * and NO container — `claude` is spawned as a direct child in this same container, the pod
   * being the isolation boundary. `run()` sets IS_SANDBOX=1 + CLAUDE_CONFIG_DIR in the child
   * env (what podman `-e` did) and drops ANTHROPIC_API_KEY. Testable without spawning. */
  localArgs(req: TurnRequest): string[] {
    return this.claudeTail(req);
  }

  async *run(req: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnEvent> {
    const bin = this.o.bin ?? "claude";
    // Local-exec (k8s): spawn `claude` directly, setting the sandbox env the podman `-e` flags
    // used to inject. Explicitly drop ANTHROPIC_API_KEY so it can never outrank the OAuth cred.
    // Otherwise: `podman exec` (or ephemeral `podman run`) into the agent container.
    let child;
    if (this.o.local) {
      // Backend-aware env (backend-*): bedrock sets CLAUDE_CODE_USE_BEDROCK, subscription clears it.
      const env = localEnv(process.env, this.o.backend);
      child = spawn(bin, this.localArgs(req), { windowsHide: true, env });
    } else {
      const podman = this.o.podman ?? "podman";
      child = spawn(podman, this.podmanArgs(req), { windowsHide: true });
    }

    // Trace: surface the FULL claude execution (tool calls, results, tokens) to the runtime's
    // stdout/stderr so a run isn't a black box. Concise decode is ON by default; TONOMAN_TRACE=raw
    // adds verbatim stream-json + per-token deltas (⚠ dumps full tool payloads / customer data).
    const trace = resolveTraceMode();
    const label = this.o.container || "local";

    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr += s; // kept for the "no result" error message below
      if (trace !== "off") process.stderr.write(`[${label}:stderr] ${s}`);
    });

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    // Wait for process exit alongside reading stdout.
    const closed = new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.on("error", (err) => resolve({ code: null, err }));
      child.on("close", (code) => resolve({ code }));
    });

    // Feed the prompt and close stdin.
    child.stdin.write(req.prompt);
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    let sawResult = false;
    let parseErr: Error | undefined;
    try {
      for await (const line of rl) {
        if (trace !== "off") for (const t of decodeTrace(line, trace)) console.error(`gateway: [${label}] ${t}`);
        const ev = parseLine(line.trim());
        if (!ev) continue;
        // Cap hit: stream a plain "paused" note (a normal text delta, so it lands in the reply on
        // every channel) BEFORE the done — so a truncated turn reads as a graceful pause, not a
        // silent stop or a failure.
        if (ev.kind === "done" && ev.capped) {
          const n = this.o.maxTurns ?? 0;
          yield { kind: "text", text: `\n\n_⏸ Paused at my ${n}-step working limit — reply “continue” to keep going._` };
        }
        if (ev.kind === "done" || ev.kind === "error") sawResult = true;
        yield ev;
      }
    } catch (e) {
      parseErr = e as Error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    const { code, err } = await closed;
    if (!sawResult) {
      // No terminal result line: surface a single error so the router never hangs.
      const msg = stderr.trim();
      if (parseErr) yield { kind: "error", err: new Error(`claudecode: stream parse: ${parseErr.message}`) };
      else if (err) yield { kind: "error", err: new Error(`claudecode: ${err.message}`) };
      else if (code !== 0) yield { kind: "error", err: new Error(`claudecode: exit ${code}: ${msg}`) };
      else yield { kind: "error", err: new Error("claudecode: turn produced no result") };
    }
  }
}

// --- NDJSON stream-json parsing (A2) ---------------------------------------

interface RawIteration {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface RawUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  /** per-internal-call usage; the peak gives true context occupancy (the top-level fields
   * SUM across calls, so they over-count the window). */
  iterations?: RawIteration[];
}

interface RawLine {
  type?: string; // "system" | "stream_event" | "assistant" | "user" | "result"
  subtype?: string;
  event?: unknown; // present when type == "stream_event"
  message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> }; // "assistant"/"user"
  result?: string; // final assistant text when type == "result"
  is_error?: boolean;
  usage?: RawUsage; // present on the result line (gw-command-statusline)
  total_cost_usd?: number;
  num_turns?: number; // agentic iterations the turn took (result line) — statusline iteration count
  /** per-model usage, keyed by model name (e.g. "claude-opus-4-8[1m]"); each carries the
   * real contextWindow — so context % uses the actual window, not a hardcoded 200k. */
  modelUsage?: Record<string, { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number }>;
}

interface RawEvent {
  type?: string; // "content_block_start" | "content_block_delta" | ...
  delta?: { type?: string; text?: string };
  content_block?: { type?: string; name?: string };
}

// --- Trace: full-execution visibility to stdout/stderr (not a black box) --------
// Concise decode is ON by default (a few lines per turn); TONOMAN_TRACE=raw also emits the
// verbatim stream-json + per-token deltas + stray non-JSON lines. ⚠ raw dumps full tool
// payloads (customer names, invoice amounts, the system prompt) to the gateway log.

export type TraceMode = "off" | "on" | "raw";

/** Resolve the trace mode from env. Default "on" so a run is never a black box. */
export function resolveTraceMode(env: string | undefined = process.env.TONOMAN_TRACE): TraceMode {
  const v = (env ?? "").toLowerCase().trim();
  if (v === "off" || v === "0" || v === "false" || v === "none") return "off";
  if (v === "raw" || v === "2" || v === "verbose") return "raw";
  return "on";
}

/** One-line, whitespace-collapsed preview with a hard cap (limits PII in the log). */
function preview(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

/** Decode one raw claude stream-json line into human-readable trace line(s). Pure + testable.
 * Returns [] for lines that carry nothing traceworthy in the given mode. */
export function decodeTrace(line: string, mode: "on" | "raw"): string[] {
  const out: string[] = [];
  const raw = line.trim();
  if (!raw) return out;
  let rl: RawLine & { model?: string; tools?: unknown[]; message?: { content?: unknown[] } };
  try {
    rl = JSON.parse(raw);
  } catch {
    // Stray non-JSON output — often the actual error text when something breaks. Surface in raw.
    if (mode === "raw") out.push(`· ${preview(raw, 500)}`);
    return out;
  }
  switch (rl.type) {
    case "system":
      if (rl.subtype === "init")
        out.push(`init model=${rl.model ?? "?"} tools=${Array.isArray(rl.tools) ? rl.tools.length : "?"}`);
      break;
    case "assistant":
      for (const b of (rl.message?.content ?? []) as Array<Record<string, unknown>>) {
        if (b.type === "tool_use") out.push(`→ tool_use ${String(b.name)}(${preview(JSON.stringify(b.input ?? {}))})`);
        else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(`  ${preview(b.text)}`);
      }
      break;
    case "user":
      for (const b of (rl.message?.content ?? []) as Array<Record<string, unknown>>) {
        if (b.type === "tool_result") {
          const c = Array.isArray(b.content)
            ? (b.content as Array<Record<string, unknown>>).map((x) => (typeof x.text === "string" ? x.text : "")).join(" ")
            : String(b.content ?? "");
          out.push(`← tool_result${b.is_error ? " ERR" : ""} ${preview(c)}`);
        }
      }
      break;
    case "result": {
      const u = rl.usage ?? {};
      const tok = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      const cost = rl.total_cost_usd != null ? ` $${rl.total_cost_usd.toFixed(4)}` : "";
      out.push(`✓ result ${rl.is_error ? "ERROR " : ""}${tok}tok${cost} ${preview(rl.result ?? "")}`);
      break;
    }
    // "stream_event" per-token deltas are intentionally skipped in concise mode (would flood).
  }
  if (mode === "raw") out.push(`raw ${preview(raw, 2000)}`);
  return out;
}

/** A short, human one-liner for a tool call's primary argument (gw-tool-narration): the command
 * for Bash, the path for a file op, the pattern for a search, etc. Bounded and whitespace-collapsed
 * — it never dumps the full input (which can carry customer data). "" when nothing pithy is present. */
export function toolPreview(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const KEYS = ["command", "file_path", "pattern", "path", "query", "url", "description", "prompt"];
  let v: unknown;
  for (const k of KEYS) {
    if (typeof input[k] === "string" && input[k]) {
      v = input[k];
      break;
    }
  }
  if (v === undefined) v = Object.values(input).find((x) => typeof x === "string" && x);
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

/** Parses one NDJSON line into at most one normalized event. Live text comes from
 * partial-message deltas; the final answer from the result line. A tool step surfaces from the
 * "assistant" message (name + arg preview); its redundant summary text is ignored. */
export function parseLine(line: string): TurnEvent | null {
  if (!line) return null;
  let rl: RawLine;
  try {
    rl = JSON.parse(line) as RawLine;
  } catch {
    return null; // not a JSON event line (stray log)
  }
  switch (rl.type) {
    case "stream_event": {
      if (rl.event == null) return null;
      const ev = rl.event as RawEvent;
      if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          return { kind: "text", text: ev.delta.text };
        }
      }
      // tool_use surfaces from the "assistant" message below (with its arg preview) — the
      // content_block_start event has the name but no input yet (it streams via deltas).
      return null;
    }
    case "assistant": {
      // A tool step, surfaced live (gw-tool-narration). The assistant message carries the full
      // tool_use block (name + input) just before the tool runs. Emit the FIRST tool_use with a
      // short arg preview; the assistant's own TEXT is ignored here (redundant with the streamed
      // text deltas, per the note above).
      const t = (rl.message?.content ?? []).find((b) => b?.type === "tool_use" && b.name);
      if (t?.name) return { kind: "tool", tool: t.name, text: toolPreview(t.name, t.input) };
      return null;
    }
    case "result":
      // Hitting --max-turns exits with is_error + subtype "error_max_turns". That's not a real
      // failure — the agent just ran out of its tool-loop budget — so deliver as DONE (the answer
      // streamed so far is preserved by the consumer; final may be empty and that's fine).
      if (rl.is_error && rl.subtype !== "error_max_turns") {
        const msg = rl.result || `claude turn failed (${rl.subtype ?? "error"})`;
        return { kind: "error", err: new Error(msg) };
      }
      if (rl.subtype === "error_max_turns") {
        return { kind: "done", final: rl.result ?? "", usage: parseUsage(rl), capped: true };
      }
      return { kind: "done", final: rl.result ?? "", usage: parseUsage(rl) };
    default:
      return null;
  }
}

/** Normalizes the result line's `usage` (+ cost) into a harness-neutral TurnUsage
 * (gw-command-statusline). Returns undefined when no usage is present. */
function parseUsage(rl: RawLine): import("../core/contracts").TurnUsage | undefined {
  const u = rl.usage;
  if (!u && rl.total_cost_usd == null) return undefined;
  const inputTokens = u?.input_tokens ?? 0;
  const cacheWriteTokens = u?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = u?.cache_read_input_tokens ?? 0;
  // Context occupancy = the PEAK single internal call (input + cache), not the summed totals
  // (which re-count the cached context every iteration → > window). Fall back to the
  // single-call sum when no per-iteration data is present.
  const iterCtx = (u?.iterations ?? []).map(
    (it) => (it.input_tokens ?? 0) + (it.cache_read_input_tokens ?? 0) + (it.cache_creation_input_tokens ?? 0),
  );
  const contextTokens = iterCtx.length ? Math.max(...iterCtx) : inputTokens + cacheReadTokens + cacheWriteTokens;
  // Primary model = the one that handled the most context this turn (a turn can use several,
  // e.g. haiku for sub-steps + opus for the main work); take its name + real context window.
  let model: string | undefined;
  let contextWindow: number | undefined;
  let bestTok = -1;
  for (const [name, v] of Object.entries(rl.modelUsage ?? {})) {
    const tok = (v.inputTokens ?? 0) + (v.cacheReadInputTokens ?? 0) + (v.cacheCreationInputTokens ?? 0);
    if (tok > bestTok) {
      bestTok = tok;
      model = name.replace(/^claude-/, ""); // "claude-opus-4-8[1m]" → "opus-4-8[1m]"
      contextWindow = v.contextWindow;
    }
  }
  return {
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: u?.output_tokens ?? 0,
    costUsd: rl.total_cost_usd,
    contextTokens,
    model,
    contextWindow,
    iterationsUsed: rl.num_turns,
  };
}

/** The Claude Code harness plug for the roster registry (A11). */
export function spec(): Spec {
  return {
    kind: KIND,
    image: IMAGE,
    configHome: CONFIG_HOME,
    identityHome: IDENTITY_HOME,
    // Keep ALL Claude Code state in the config volume (incl. the sibling ~/.claude.json
    // profile), so a destroy+recreate comes back fully configured (A2/A11).
    runEnv: { CLAUDE_CONFIG_DIR: CONFIG_HOME },
    // No container configured means THIS pod is the sandbox (local-exec): `claude` is spawned as a
    // direct child instead of through `podman exec`. That is what a Tonoman Cloud gateway does —
    // an agent is a row, so there is no per-agent container to exec into, and the pod boundary is
    // the isolation the container used to provide. A self-hosted roster still names a container
    // and still goes through podman, unchanged.
    newRunner: (p: RunnerParams) =>
      new Runner({ container: p.container, local: !p.container, model: p.model, maxTurns: p.maxTurns }),
    newEphemeralRunner: (p: EphemeralParams) =>
      new Runner({ container: p.volumesFrom, model: p.model, ephemeral: { volumesFrom: p.volumesFrom, image: p.image, env: p.env } }),
    loginArgs: ["claude", "auth", "login", "--claudeai"],
    statusArgs: ["claude", "auth", "status"],
    logoutArgs: ["claude", "auth", "logout"],
    credFile: `${CONFIG_HOME}/.credentials.json`, // headless login verifies this file changed
    // Observability (obs-adapter-hook): Claude Code traces via a post-turn Stop hook + a transcript
    // decoder. The runtime registers it on boot; the hook runs tonoman's own __trace-hook (zero-dep).
    telemetry: {
      kind: "hook",
      register: ({ configDir, cliPath }) => registerClaudeHook(configDir, cliPath),
    },
  };
}
