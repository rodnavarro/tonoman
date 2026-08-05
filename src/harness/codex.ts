// The Codex turn-runner: the codex-harness sibling of claudecode.ts. It runs one
// headless turn via
//
//   codex exec --json --skip-git-repo-check -C <workdir> \
//     --dangerously-bypass-approvals-and-sandbox [-m <model>]
//
// with the assembled prompt on stdin (identity preamble prepended, since codex has
// no --append-system-prompt-file), reading codex's experimental `--json` event
// stream (thread.started / turn.started / item.started / item.completed /
// turn.completed) by LINE and normalizing it into the SAME neutral TurnEvent values
// the gateway already consumes. Runs under the ChatGPT-subscription OAuth in
// CODEX_HOME/auth.json (never OPENAI_API_KEY — it must not outrank the sub, mirroring
// how claudecode drops ANTHROPIC_API_KEY).
//
// codex has no `--max-turns`, so the agentic-loop cap is ENFORCED here: we count the
// agentic steps (tool/command/file_change items) and SIGTERM the child once it reaches
// the cap, delivering the partial answer as a graceful "paused" done (parity with the
// claude-code error_max_turns path).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import type { TurnEvent, TurnRequest, TurnRunner, TurnUsage } from "../core/contracts";
import type { Spec, RunnerParams, EphemeralParams } from "../harness";

/** The harness key used in agent config. */
export const KIND = "codex";

/** The Tonoman-owned per-runtime sandbox image (A11): the dual-harness agent image
 * bakes BOTH @openai/codex and @anthropic-ai/claude-code, so one image serves either
 * harness (the harness is a config choice, not a separate image). */
export const IMAGE = "localhost/tonoman/agent:latest";

/** Where Codex keeps its state (auth.json, sessions) inside the sandbox; the per-agent
 * config volume bind-mounts here so the OAuth credential store persists (A11). */
export const CONFIG_HOME = "/root/.codex";

/** Where the per-agent identity dir (AGENTS.md/persona) bind-mounts READ-ONLY. codex has
 * no --append-system-prompt-file, so the runner READS the identity file and prepends it to
 * the stdin prompt as a system preamble (see identityPreamble). */
export const IDENTITY_HOME = "/root/agent";

/** Best-effort context window for the gpt-5.6 codex tiers, for the statusline context %.
 * Not reported per-turn by codex; overridable via CODEX_CONTEXT_WINDOW. An estimate, not a
 * hard fact — correct it without a rebuild by setting the env. */
export const CODEX_CONTEXT_WINDOW = Number(process.env.CODEX_CONTEXT_WINDOW || "400000");

/** Short aliases → real codex model slugs (gw-command-model): the user picks `sol`/`terra`/
 * `luna`, codex is invoked with the full `gpt-5.6-*` slug. A value that is already a full slug
 * (or unknown) passes through unchanged. */
export const CODEX_MODELS: Record<string, string> = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
};

/** Normalize a model knob to a codex slug (alias → slug; slug/unknown unchanged). */
export function normalizeModel(m: string | undefined): string | undefined {
  if (!m) return m;
  return CODEX_MODELS[m] ?? m;
}

export interface RunnerOptions {
  container?: string; // required for the podman-exec transport; omitted in local-exec mode
  model?: string; // alias or slug; normalized to a gpt-5.6-* slug per turn
  bin?: string; // codex binary; default "codex"
  podman?: string; // podman binary; default "podman"
  // The agentic-loop cap (parity with claude --max-turns): after this many agentic steps
  // (tool/command/file_change items) the turn is paused and the partial answer delivered.
  // <=0/undefined = uncapped. codex has no native flag, so it is enforced by SIGTERM here.
  maxTurns?: number;
  // Working directory codex runs in (-C): the agent's git workspace / files root. Default
  // TONOMAN_WORKDIR or the process cwd.
  cwd?: string;
  // Sandbox policy. Local-exec agents run --dangerously-bypass-approvals-and-sandbox (the POD
  // is the security boundary, exactly like claudecode's --dangerously-skip-permissions), so the
  // agent acts autonomously inside its container. Override for a tighter policy.
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | "bypass";
  extraArgs?: string[];
  // Local-exec mode (k8s split): spawn `codex` as a DIRECT child in this same pod — no
  // `podman exec`. The pod is the isolation boundary. Used by src/agent/server.ts.
  local?: boolean;
}

/** Build the child env for a local-exec codex turn: point CODEX_HOME at the config volume and
 * drop OPENAI_API_KEY so the ChatGPT-subscription OAuth resolves (an API key must never outrank
 * the sub — mirrors claudecode dropping ANTHROPIC_API_KEY). Pure + testable. */
export function localEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CODEX_HOME: CONFIG_HOME };
  delete env.OPENAI_API_KEY;
  return env;
}

/** Read the identity/persona file and format it as a system preamble prepended to the prompt
 * (codex has no --append-system-prompt-file). Returns "" when absent/unreadable so a turn never
 * fails just because identity is missing. */
export function identityPreamble(systemPromptFile: string | undefined): string {
  if (!systemPromptFile) return "";
  try {
    const txt = fs.readFileSync(systemPromptFile, "utf8").trim();
    return txt ? `# Your identity and operating instructions\n\n${txt}\n\n---\n\n` : "";
  } catch {
    return "";
  }
}

export class Runner implements TurnRunner {
  // Mutable so `/model` can switch it (gw-command-model); read per turn, so a change takes
  // effect on the NEXT turn.
  private model?: string;
  constructor(private readonly o: RunnerOptions) {
    if (!o.local && !o.container) throw new Error("codex: empty container");
    this.model = normalizeModel(o.model);
  }

  getModel(): string | undefined {
    return this.model;
  }
  setModel(model: string | undefined): void {
    this.model = normalizeModel(model);
  }

  private sandboxFlags(): string[] {
    const s = this.o.sandbox ?? (this.o.local ? "bypass" : "workspace-write");
    // The pod is the security boundary for a local-exec agent: bypass approvals so it runs
    // autonomously (headless has no one to approve), exactly like claudecode --dangerously-skip.
    if (s === "bypass") return ["--dangerously-bypass-approvals-and-sandbox"];
    return ["-s", s];
  }

  /** The transport-neutral `codex exec` flags for one turn (everything AFTER the binary). */
  codexTail(): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", ...this.sandboxFlags()];
    const cwd = this.o.cwd ?? process.env.TONOMAN_WORKDIR ?? process.cwd();
    args.push("-C", cwd);
    if (this.model) args.push("-m", this.model);
    if (this.o.extraArgs) args.push(...this.o.extraArgs);
    return args;
  }

  /** Full `podman exec …` argv (non-local transport). */
  podmanArgs(): string[] {
    const bin = this.o.bin ?? "codex";
    return ["exec", "-i", this.o.container!, bin, ...this.codexTail()];
  }

  localArgs(): string[] {
    return this.codexTail();
  }

  async *run(req: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnEvent> {
    const bin = this.o.bin ?? "codex";
    let child;
    if (this.o.local) {
      child = spawn(bin, this.localArgs(), { windowsHide: true, env: localEnv(process.env) });
    } else {
      const podman = this.o.podman ?? "podman";
      child = spawn(podman, this.podmanArgs(), { windowsHide: true });
    }

    const trace = process.env.TONOMAN_TRACE !== "off";
    const label = this.o.container || "local";

    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr += s;
      if (trace) process.stderr.write(`[${label}:codex:stderr] ${s}`);
    });

    let killed = false;
    const onAbort = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const closed = new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.on("error", (err) => resolve({ code: null, err }));
      child.on("close", (code) => resolve({ code }));
    });

    // Identity preamble + the assembled window/message on stdin (A3): substrate-owned, no
    // codex session resume in V1 (the whole window rides in req.prompt every turn).
    child.stdin.write(identityPreamble(req.systemPromptFile) + req.prompt);
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const cap = this.o.maxTurns && this.o.maxTurns > 0 ? this.o.maxTurns : 0;
    const finalParts: string[] = [];
    let iterations = 0; // agentic steps (tool/command/file_change items)
    let usage: TurnUsage | undefined;
    let capped = false;
    let parseErr: Error | undefined;

    try {
      for await (const line of rl) {
        const ev = parseLine(line.trim());
        if (!ev) continue;
        if (ev.kind === "text") {
          if (ev.text) finalParts.push(ev.text);
          yield ev;
        } else if (ev.kind === "tool") {
          iterations++;
          yield ev;
          if (cap && iterations >= cap) {
            capped = true;
            killed = true;
            child.kill("SIGTERM");
            break;
          }
        } else if (ev.kind === "done") {
          // turn.completed: carries usage only; the final text is what we accumulated.
          usage = ev.usage;
        } else if (ev.kind === "error") {
          yield ev;
          signal?.removeEventListener("abort", onAbort);
          return;
        }
      }
    } catch (e) {
      parseErr = e as Error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    const { code, err } = await closed;

    // Graceful-cap note (parity with claudecode): a plain text delta so it lands in the reply.
    if (capped) {
      const n = this.o.maxTurns ?? 0;
      yield { kind: "text", text: `\n\n_⏸ Paused at my ${n}-step working limit — reply "continue" to keep going._` };
    }

    const final = finalParts.join("\n\n").trim();
    const u: TurnUsage | undefined = usage ? { ...usage, iterationsUsed: iterations } : undefined;

    // A terminal done if we got any answer or a clean/killed exit; otherwise surface an error so
    // the router never hangs.
    if (final || usage || capped || killed) {
      yield { kind: "done", final, usage: u, capped };
    } else if (parseErr) {
      yield { kind: "error", err: new Error(`codex: stream parse: ${parseErr.message}`) };
    } else if (err) {
      yield { kind: "error", err: new Error(`codex: ${err.message}`) };
    } else if (code !== 0) {
      yield { kind: "error", err: new Error(`codex: exit ${code}: ${stderr.trim().slice(-800)}`) };
    } else {
      yield { kind: "error", err: new Error("codex: turn produced no result") };
    }
  }
}

// --- codex `--json` event parsing -------------------------------------------------

interface CodexItem {
  id?: string;
  type?: string; // "agent_message" | "file_change" | "command_execution" | "reasoning" | ...
  text?: string;
  command?: string;
  status?: string; // "in_progress" | "completed" | "failed"
  changes?: unknown;
}
interface CodexUsage {
  input_tokens?: number; // TOTAL input incl. cached
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}
interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  model?: string;
}

/** A short human label for a codex tool/command step (gw-tool-narration), bounded to avoid
 * dumping payloads/customer data. */
function toolLabel(item: CodexItem): { tool: string; text: string } {
  const kind = item.type ?? "step";
  let detail = "";
  if (item.command) detail = String(item.command);
  else if (item.type === "file_change") detail = item.status ? `(${item.status})` : "";
  return { tool: kind, text: detail.replace(/\s+/g, " ").trim().slice(0, 60) };
}

/** Map a codex model slug to a compact statusline name ("gpt-5.6-sol" → "sol"). */
export function shortModel(slug: string | undefined): string | undefined {
  if (!slug) return slug;
  const m = /^gpt-5\.6-(sol|terra|luna)$/.exec(slug);
  return m ? m[1] : slug.replace(/^gpt-/, "");
}

/** Parse one codex `--json` line into at most one normalized TurnEvent. Stateless: the runner
 * accumulates the final answer from the "text" events and reads usage off the "done". */
export function parseLine(line: string): TurnEvent | null {
  if (!line) return null;
  let rl: CodexLine;
  try {
    rl = JSON.parse(line) as CodexLine;
  } catch {
    return null; // codex prints some non-JSON banner/log lines to the same stream
  }
  switch (rl.type) {
    case "item.completed": {
      const it = rl.item ?? {};
      if (it.type === "agent_message") {
        return it.text ? { kind: "text", text: it.text } : null;
      }
      // Any non-message item that completed is an agentic step (tool/command/file edit).
      const { tool, text } = toolLabel(it);
      return { kind: "tool", tool, text };
    }
    case "turn.completed":
      return { kind: "done", final: "", usage: mapUsage(rl.usage, rl.model) };
    default:
      // thread.started / turn.started / item.started — no neutral event.
      return null;
  }
}

/** Normalize codex usage into the harness-neutral TurnUsage (gw-command-statusline). */
export function mapUsage(u: CodexUsage | undefined, model: string | undefined): TurnUsage | undefined {
  if (!u) return undefined;
  const totalInput = u.input_tokens ?? 0;
  const cacheRead = u.cached_input_tokens ?? 0;
  const fresh = Math.max(0, totalInput - cacheRead);
  return {
    inputTokens: fresh,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: u.cache_write_input_tokens ?? 0,
    // reasoning tokens are billed output; fold them in so the count matches the vendor.
    outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
    // codex re-sends the window each call, so total input ≈ peak single-call context occupancy.
    contextTokens: totalInput,
    model: shortModel(model),
    contextWindow: CODEX_CONTEXT_WINDOW,
  };
}

/** The Codex harness plug for the roster registry (A11). */
export function spec(): Spec {
  return {
    kind: KIND,
    image: IMAGE,
    configHome: CONFIG_HOME,
    identityHome: IDENTITY_HOME,
    runEnv: { CODEX_HOME: CONFIG_HOME },
    newRunner: (p: RunnerParams) => new Runner({ container: p.container, model: p.model, maxTurns: p.maxTurns }),
    newEphemeralRunner: (p: EphemeralParams) =>
      new Runner({ container: p.volumesFrom, model: p.model }),
    // Headless login = codex device-auth (prints an OpenAI verification URL + user code); the
    // FIFO/PTY plumbing in authflow.ts is harness-neutral, only the URL extractor is codex-specific.
    loginArgs: ["codex", "login", "--device-auth"],
    statusArgs: ["codex", "login", "status"],
    logoutArgs: ["codex", "logout"],
    credFile: `${CONFIG_HOME}/auth.json`, // headless login verifies this file changed
  };
}
