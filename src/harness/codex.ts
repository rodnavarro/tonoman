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

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import type { TurnEvent, TurnRequest, TurnRunner, TurnUsage } from "../core/contracts";
import type { Spec, RunnerParams, EphemeralParams } from "../harness";
import type { UsageWindow } from "../statusline";
import { codexMcpOverrides, mcpEnv, runOnly, scrubEnv } from "./turnenv";
import { commandFor, findAsUser, ownGroup, readAsUser, runBegan, stopAll, type TurnUser } from "./launch";

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

/** WHOSE ChatGPT subscription a codex turn runs on — the exact counterpart of claudecode's
 * `configHomeFor`, applied through CODEX_HOME instead of CLAUDE_CONFIG_DIR.
 *
 * One runtime serves every agent a pool has, and a subscription belongs to a person, so the config
 * home has to say whose it is or the second login replaces the first. Same three cases, same
 * sanitisation, and the same rule for a name that was GIVEN but sanitises away: it gets a directory
 * of its own that is nobody's and works for nothing, rather than falling back to the pool's shared
 * credential. Both the agent name and the user id arrive over the wire and decide a filesystem
 * path, which is the whole reason the sanitisation is here and not at the caller. */
export function configHomeFor(
  agent: string | undefined,
  user?: string,
  root: string = CONFIG_HOME,
): string {
  if (!agent) return root;
  const safe = agent.replace(/[^A-Za-z0-9_-]/g, "");
  const agentHome = `${root}/agents/${safe || "_invalid"}`;
  if (!user) return agentHome;
  const safeUser = user.replace(/[^A-Za-z0-9_-]/g, "");
  return `${agentHome}/users/${safeUser || "_invalid"}`;
}

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
  binArgs?: string[]; // arguments before codex's own (a wrapper script, e.g. in tests)
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
  /** Tonoman Cloud's floor: the shell is closed unless the turn says `shell: "full"` (see RunnerParams). */
  closedShell?: boolean;
  // WHOSE ChatGPT subscription this runner answers on (local-exec): the CODEX_HOME a turn runs
  // with, from `configHomeFor(agent, user)`. Default: the pool's shared CONFIG_HOME, which is
  // every agent that has not asked for its own. A per-turn `req.configHome` overrides it.
  configHome?: string;
}

/** Build the child env for a local-exec codex turn: point CODEX_HOME at the config volume and
 * drop OPENAI_API_KEY so the ChatGPT-subscription OAuth resolves (an API key must never outrank
 * the sub — mirrors claudecode dropping ANTHROPIC_API_KEY). Pure + testable. */
export function localEnv(base: NodeJS.ProcessEnv, configHome: string = CONFIG_HOME, make = true): NodeJS.ProcessEnv {
  // codex REFUSES to start when CODEX_HOME does not exist ("path does not exist"), where claude
  // would create its config dir. So the home is ensured here, at the one place every codex child's
  // CODEX_HOME is set — a login, a turn, a status check all pass through localEnv or homeEnv.
  // Not for a turn that runs as its own user: that folder is the user's, already made AS the user,
  // and the worker does not make folders by a path inside it (TURNUSER-ROOT-STAYS-OUT).
  if (make) ensureCodexHome(configHome);
  // A Codex turn has a shell: whatever is in its environment, it can print. The worker's secrets stay out.
  const env: NodeJS.ProcessEnv = { ...scrubEnv(base), CODEX_HOME: configHome };
  delete env.OPENAI_API_KEY;
  return env;
}

/** Create a codex config home if it is missing. Idempotent, best-effort — a permission error is
 *  left for codex itself to report rather than thrown from an env builder. */
export function ensureCodexHome(home: string): void {
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch {
    /* codex will report a real problem; a mkdir race or EEXIST is not one */
  }
}

/** Read the identity/persona file and format it as a system preamble prepended to the prompt
 * (codex has no --append-system-prompt-file). Returns "" when absent/unreadable so a turn never
 * fails just because identity is missing. */
export function identityPreamble(systemPromptFile: string | undefined, words?: string): string {
  if (words === undefined && !systemPromptFile) return "";
  try {
    // The words themselves when the worker already read them; never the file again once it may be
    // in a folder that is no longer the worker's.
    const txt = (words ?? fs.readFileSync(systemPromptFile!, "utf8")).trim();
    return txt ? `# Your identity and operating instructions\n\n${txt}\n\n---\n\n` : "";
  } catch {
    return "";
  }
}

/** Where a login keeps which Codex session belongs to which conversation. Codex names its own
 *  sessions, so the worker's session id has to be looked up (CONVO-SESSION-RESUME). */
// Beside the login for a self-hosted agent. For a turn that runs as its own user the login's folder
// is that user's, where it could put a link where this file was and have the worker — root — write
// through it; so there the map is kept in the worker's own state, named by a digest of the home
// (TURNUSER-ROOT-STAYS-OUT).
const threadsFile = (codexHomeDir: string, mapDir?: string): string =>
  mapDir ? `${mapDir}/${createHash("sha256").update(codexHomeDir).digest("hex").slice(0, 32)}.json` : `${codexHomeDir}/tonoman-threads.json`;

function readThreads(codexHomeDir: string, mapDir?: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(threadsFile(codexHomeDir, mapDir), "utf8")) as unknown;
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Remember that this conversation is that Codex session. Never throws: a turn is worth more than
 *  its memory. */
export function rememberThread(codexHomeDir: string, sessionId: string, threadId: string, mapDir?: string): void {
  try {
    const all = readThreads(codexHomeDir, mapDir);
    if (all[sessionId] === threadId) return;
    all[sessionId] = threadId;
    // Bounded: the oldest conversations go first. Codex keeps its own records regardless.
    const keep = Object.entries(all).slice(-2000);
    fs.mkdirSync(mapDir ?? codexHomeDir, { recursive: true, ...(mapDir ? { mode: 0o700 } : {}) });
    fs.writeFileSync(threadsFile(codexHomeDir, mapDir), JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  } catch {
    /* the next message starts a new session instead */
  }
}

/** The Codex session for this conversation — only while Codex still has it on disk. One it has lost
 *  (another login's, a cleared volume) is not resumed: the conversation starts again rather than fail. */
/** The same, for a turn that runs as its own user: whether Codex still has the session is asked AS
 *  that user, not by the worker looking through the user's folders. */
export async function threadForAs(user: TurnUser, codexHomeDir: string, sessionId: string, mapDir: string): Promise<string | undefined> {
  const all = readThreads(codexHomeDir, mapDir);
  const id = Object.hasOwn(all, sessionId) ? all[sessionId] : undefined;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]+$/.test(id)) return undefined;
  return (await findAsUser(user, `${codexHomeDir}/sessions`, `rollout-*${id}.jsonl`)) ? id : undefined;
}

export function threadFor(codexHomeDir: string, sessionId: string, mapDir?: string): string | undefined {
  const all = readThreads(codexHomeDir, mapDir);
  const id = Object.hasOwn(all, sessionId) ? all[sessionId] : undefined;
  return typeof id === "string" && /^[A-Za-z0-9-]+$/.test(id) && rolloutOf(codexHomeDir, id) ? id : undefined;
}

/** The Codex features a turn runs without, unless its agent is set to a full shell. */
const CLOSED_FEATURES = ["shell_tool", "unified_exec", "multi_agent", "plugins", "hooks"];

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
  codexTail(req?: TurnRequest, inContainer = false, resumeThread?: string): string[] {
    // A later message of a conversation resumes Codex's own session for it (CONVO-SESSION-RESUME):
    // without that, every message began a conversation of its own and the agent forgot the receipt
    // it had just asked about. `resume` takes no sandbox or folder flag, so those go another way.
    const sandbox = this.sandboxFlags();
    const args = resumeThread
      ? ["exec", "resume", "--json", "--skip-git-repo-check", ...(sandbox[0] === "-s" ? ["-c", `sandbox_mode=${JSON.stringify(sandbox[1])}`] : sandbox)]
      : ["exec", "--json", "--skip-git-repo-check", ...sandbox];
    // The turn's own folder when it has one (its attachments and nothing else), else the runner's.
    // An agent in a container of its own cannot see the worker's folders (CLI-IN-ITS-OWN-CONTAINER).
    const cwd = (inContainer ? undefined : req?.cwd) ?? this.o.cwd ?? process.env.TONOMAN_WORKDIR ?? process.cwd();
    // A resumed session is started IN its folder instead (see `run`).
    if (!resumeThread) args.push("-C", cwd);
    // The model THIS turn asks for (the Hub's current default, or a thread's `!model`), else the
    // runner's own: a runner is built once, so its model alone would miss a change made since.
    const model = normalizeModel(req?.model) ?? this.model;
    if (model) args.push("-m", model);
    // Codex has no shell at all — its own switches, not a list it could talk its way past — and
    // `tonoman` comes as its one tool (CLI-ONLY-THIS-COMMAND). Codex's "never ask" mode runs whatever
    // it is asked, so an allow-list alone would not hold. Closed on EVERY turn, with or without
    // `tonoman` (CLI-CLOSED-WHATEVER-FAILS); only an agent set to a full shell keeps it.
    // `shell_tool` is the switch that removes every command tool; `unified_exec` alone only swaps one
    // for another. Child agents, plugins and hooks go too (CLI-CODEX-ONLY-ITS-TOOL): a child agent's
    // role file can switch the shell back on, and plugins and hooks both start programs.
    // A self-hosted runner (no `closedShell`) closes it only for a turn that came with `tonoman`.
    const closed = this.o.closedShell ? req?.lean || req?.shell !== "full" : !!req && !req.lean && !!req.cli && req.shell !== "full";
    if (closed) for (const f of CLOSED_FEATURES) args.push("-c", `features.${f}=false`);
    // The turn's MCP server: `tonoman` as one tool (or, before it, the brain tool).
    if (req && !req.lean && !inContainer && req.mcpServers?.length) args.push(...codexMcpOverrides(req.mcpServers));
    // Photos the person attached go with the prompt (CONVO-ATTACHED-FILES): without a shell, Codex has
    // no other way to open them. A PDF cannot be attached this way; the prompt still names it.
    if (!inContainer) for (const m of req?.mediaPaths ?? []) if (/\.(jpe?g|png|gif|webp)$/i.test(m)) args.push("--image", m);
    if (this.o.extraArgs) args.push(...this.o.extraArgs);
    // The session, then `-`: the prompt comes on stdin, as it always has.
    if (resumeThread) args.push(resumeThread, "-");
    return args;
  }

  /** Full `podman exec …` argv (non-local transport). */
  podmanArgs(req?: TurnRequest): string[] {
    const bin = this.o.bin ?? "codex";
    return ["exec", "-i", this.o.container!, bin, ...this.codexTail(req, true)];
  }

  localArgs(req?: TurnRequest, resumeThread?: string): string[] {
    return this.codexTail(req, false, resumeThread);
  }

  /** One turn. However the caller stops listening — to the end, on an error it was handed, or by
   *  simply walking away — the program does not outlive it (TURNUSER-DIES-WITH-THE-TURN): a caller
   *  that abandons the stream takes its cancel signal with it, and nothing else would stop the program. */
  async *run(req: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnEvent> {
    let born: { child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(s?: NodeJS.Signals): boolean }; grouped: boolean } | undefined;
    try {
      yield* this.running(req, signal, (child, grouped) => void (born = { child, grouped }));
    } finally {
      if (born && born.child.exitCode === null && born.child.signalCode === null) stopAll(born.child, born.grouped);
    }
  }

  private async *running(req: TurnRequest, signal: AbortSignal | undefined, born: (child: import("node:child_process").ChildProcess, grouped: boolean) => void): AsyncIterable<TurnEvent> {
    const bin = this.o.bin ?? "codex";
    let child;
    // Which of Codex's sessions this conversation is, when it has one Codex still holds.
    const home = req.configHome ?? this.o.configHome ?? CONFIG_HOME;
    const mapDir = req.runAs ? `${process.env.TONOMAN_STATE_ROOT ?? "/root/.tonoman"}/codex-threads` : undefined;
    const resuming = this.o.local && req.sessionId && req.sessionNew === false && !req.lean;
    const resumeThread = !resuming ? undefined : req.runAs ? await threadForAs(req.runAs, home, req.sessionId!, mapDir!) : threadFor(home, req.sessionId!, mapDir);
    // Reserved before it starts and released exactly once — on a start that failed as on an exit —
    // so a user's last run ending is always noticed (TURNUSER-DIES-WITH-THE-TURN).
    const hold = await runBegan(this.o.local ? req.runAs : undefined);
    const release = hold.release;
    const grouped = !!ownGroup(req.runAs).detached;
    try {
      if (this.o.local) {
        // `req.configHome` overrides the runner's per-agent default for THIS turn only — set when
        // the agent runs inference per person, so the speaker's own login answers.
        const env = localEnv(process.env, home, !req.runAs);
        // As the turn's own Linux user when it has one, never as the worker; and what this run is
        // given — its login's folder, `tonoman`'s own credential — is passed as this run's, not
        // picked out of the worker's environment (TURNUSER-ONLY-WHAT-IT-NEEDS).
        // A resumed session takes no folder flag, so it is started in the turn's own folder. As a turn's
        // user it goes there itself, after it has become that user: the worker does not go first.
        const startIn = resumeThread && req.cwd ? req.cwd : undefined;
        const start = commandFor(req.runAs, bin, [...(this.o.binArgs ?? []), ...this.localArgs(req, resumeThread)], env, { ...runOnly(env), ...(req.lean ? {} : mcpEnv(req.mcpServers)) }, startIn);
        child = spawn(start.cmd, start.args, {
          windowsHide: true,
          ...(startIn && !req.runAs ? { cwd: startIn } : {}),
          ...ownGroup(req.runAs),
          // What `tonoman`'s tool needs — the turn's credential among it — rides in the environment,
          // never on the command line, where any process could read it (CLI-TOKEN-NOT-IN-ARGUMENTS).
          env: start.env,
        });
      } else {
        const podman = this.o.podman ?? "podman";
        child = spawn(podman, this.podmanArgs(req), { windowsHide: true });
      }
    } catch (e) {
      release();
      throw e;
    }
    // A program that never started emits `error` and no `exit`.
    child.once("error", release);
    hold.started(child.pid);
    born(child, grouped);

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
      stopAll(child, grouped);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Everything the turn started stops with it (TURNUSER-DIES-WITH-THE-TURN). On `exit`, not `close`:
    // something the program left running can hold its pipes open for ever, and that is exactly what
    // has to be stopped. Then the run is released, and when it was this user's last, everything
    // still running as that user is stopped too — a process can leave its group, never its user.
    // What it left behind is stopped as its user, by descent — not by root signalling a group number
    // that, now the program has ended, may already be somebody else's.
    child.once("exit", release);
    // Asked to stop before it had even started.
    if (signal?.aborted) stopAll(child, grouped);
    const closed = new Promise<{ code: number | null; err?: Error }>((resolve) => {
      child.on("error", (err) => resolve({ code: null, err }));
      child.on("close", (code) => resolve({ code }));
    });

    // Identity preamble + the assembled window/message on stdin (A3): substrate-owned, no
    // codex session resume in V1 (the whole window rides in req.prompt every turn).
    child.stdin.write(identityPreamble(req.systemPromptFile, req.runAs ? (req.systemPrompt ?? "") : req.systemPrompt) + req.prompt);
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const cap = this.o.maxTurns && this.o.maxTurns > 0 ? this.o.maxTurns : 0;
    const finalParts: string[] = [];
    let iterations = 0; // agentic steps (tool/command/file_change items)
    let usage: TurnUsage | undefined;
    let capped = false;
    let parseErr: Error | undefined;
    let threadId: string | undefined;

    try {
      for await (const line of rl) {
        const tid = threadIdOf(line);
        if (tid) {
          threadId = tid;
          // Remembered the moment Codex names it, so the next message resumes it even if this
          // turn is cut short.
          if (this.o.local && req.sessionId && !req.lean) rememberThread(home, req.sessionId, tid, mapDir);
        }
        const ev = parseLine(line.trim());
        if (!ev) continue;
        if (ev.kind === "text") {
          if (ev.text) finalParts.push(ev.text);
          yield ev;
        } else if (ev.kind === "tool") {
          iterations++;
          // The same trace a Claude turn leaves (gateway: [local] → tool_use …), bounded to the label.
          if (trace) console.error(`gateway: [${label}] ${codexTrace(ev)}`);
          yield ev;
          if (cap && iterations >= cap) {
            capped = true;
            killed = true;
            stopAll(child, grouped);
            break;
          }
        } else if (ev.kind === "done") {
          // turn.completed: carries usage only; the final text is what we accumulated. codex's
          // turn.completed omits the model name, so stamp it from our own model knob (statusline).
          usage = ev.usage;
          if (usage && !usage.model) usage.model = shortModel(normalizeModel(req.model) ?? this.model);
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
    // What the turn's own rollout says (CONVO-FOOTER-BOTH-PROVIDERS): the model calls it took, what
    // the last one held, and the speaker's 5h/7d allowance — read by this turn's thread id, never the
    // newest file, which may be another person's conversation.
    const report = !this.o.local || !threadId ? undefined : req.runAs ? await readTurnRolloutAs(req.runAs, home, threadId) : readTurnRollout(home, threadId);
    const u: TurnUsage | undefined = usage
      ? {
          ...usage,
          iterationsUsed: Math.max(1, report?.modelCalls ?? 0),
          ...(report?.lastInput ? { contextTokens: report.lastInput } : {}),
          ...(report?.windows.length ? { accountWindows: report.windows } : {}),
        }
      : undefined;

    if (trace && u) console.error(`gateway: [${label}] ${codexResultTrace(u, final)}`);

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
  server?: string; // mcp_tool_call: which MCP server
  tool?: string; // mcp_tool_call: which of its tools
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
  // An MCP call is named as Claude names it, so the work log reads the same on both providers.
  if (item.type === "mcp_tool_call" && item.tool) return { tool: `mcp__${item.server ?? "mcp"}__${item.tool}`, text: "" };
  const kind = item.type ?? "step";
  let detail = "";
  if (item.command) detail = String(item.command);
  else if (item.type === "file_change") detail = item.status ? `(${item.status})` : "";
  return { tool: kind, text: detail.replace(/\s+/g, " ").trim().slice(0, 60) };
}

/** PURE: the trace line for one codex step, as a Claude turn's `→ tool_use name(args)`. */
export function codexTrace(ev: TurnEvent): string {
  return `→ tool_use ${ev.tool ?? "step"}(${(ev.text ?? "").slice(0, 200)})`;
}

/** PURE: the trace line for a finished codex turn, as a Claude turn's `✓ result Ntok …`. */
export function codexResultTrace(u: TurnUsage, final: string): string {
  const tok = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0);
  return `✓ result ${tok}tok ⟳${u.iterationsUsed ?? 0} ${final.replace(/\s+/g, " ").trim().slice(0, 200)}`;
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
      // An error Codex reports mid-turn keeps its message, so the log says what went wrong.
      if (it.type === "error") return { kind: "tool", tool: "error", text: String((it as { message?: unknown }).message ?? "") };
      // Any non-message item that completed is an agentic step (tool/command/file edit).
      const { tool, text } = toolLabel(it);
      return { kind: "tool", tool, text };
    }
    case "turn.completed":
      return { kind: "done", final: "", usage: mapUsage(rl.usage, rl.model) };
    case "turn.failed":
      // A turn Codex gave up on says why, instead of an exit code and nothing else.
      return { kind: "error", err: new Error(`codex: ${String((rl as { error?: { message?: unknown } }).error?.message ?? "the turn failed")}`) };
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

// --- account usage window (5h/7d) — the codex equivalent of claude's OAuth-usage API ------------
// codex exec --json doesn't surface rate limits, and the ChatGPT /codex/usage HTTP endpoint is
// Cloudflare-bot-blocked for headless clients (403 challenge page). But codex WRITES the rate limits
// it receives on every turn into its session rollout log (CODEX_HOME/sessions/.../rollout-*.jsonl).
// Reading that file is network-free, always current, and ToS-clean (it's codex's own state, no API
// call) — the analog of the claude statusline's 5h/7d window. (Our Runner never uses --ephemeral, so
// the rollout is always persisted.)

interface CodexRateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** Map codex's `rate_limits` (primary/secondary) to neutral UsageWindows. 300min→"5h", 10080→"7d".
 * Shorter window first (the one that bites soonest). Pure + testable. */
export function parseCodexRateLimits(rl: { primary?: CodexRateWindow; secondary?: CodexRateWindow } | undefined): UsageWindow[] {
  if (!rl) return [];
  const key = (m: number): string =>
    m === 300 ? "5h" : m === 10080 ? "7d" : m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`;
  const out: UsageWindow[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || w.window_minutes == null) continue;
    out.push({
      key: key(w.window_minutes),
      usedPct: Math.round(w.used_percent ?? 0),
      resetAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : undefined,
    });
  }
  return out.sort((a, b) => (a.key.endsWith("h") ? 0 : 1) - (b.key.endsWith("h") ? 0 : 1));
}

/** The thread id `codex exec --json` announces first (`thread.started`), or undefined. */
export function threadIdOf(line: string): string | undefined {
  if (!line.includes('"thread.started"')) return undefined;
  try {
    const o = JSON.parse(line) as CodexLine;
    return o.type === "thread.started" && typeof o.thread_id === "string" ? o.thread_id : undefined;
  } catch {
    return undefined;
  }
}

/** One turn's own rollout, found by its thread id under CODEX_HOME/sessions: how many model calls it
 *  made (one `token_count` each), what the last call held, and the last 5h/7d windows it saw.
 *  Undefined when the file is not there — never throws. */
/** The file Codex keeps for one of its sessions under this home, or undefined. */
export function rolloutOf(codexHomeDir: string, threadId: string): string | undefined {
  const safe = threadId.replace(/[^A-Za-z0-9-]/g, "");
  if (!safe) return undefined;
  const find = (d: string, depth: number): string | undefined => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of ents) {
      const p = `${d}/${e.name}`;
      if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(`${safe}.jsonl`)) return p;
      if (e.isDirectory() && depth < 4) {
        const f = find(p, depth + 1);
        if (f) return f;
      }
    }
    return undefined;
  };
  return find(`${codexHomeDir}/sessions`, 0);
}

/** PURE: what one turn's own record says: how many model calls, the last call's context, its allowance. */
export function parseTurnRollout(text: string): { modelCalls: number; lastInput: number; windows: UsageWindow[] } {
  let modelCalls = 0;
  let lastInput = 0;
  let windows: UsageWindow[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let o: { payload?: { type?: string; info?: { last_token_usage?: { input_tokens?: number } } | null; rate_limits?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.payload?.type !== "token_count") continue;
    if (o.payload.info) {
      modelCalls++;
      lastInput = o.payload.info.last_token_usage?.input_tokens ?? lastInput;
    }
    const w = parseCodexRateLimits(o.payload.rate_limits as never);
    if (w.length) windows = w;
  }
  return { modelCalls, lastInput, windows };
}

export function readTurnRollout(codexHomeDir: string, threadId: string): { modelCalls: number; lastInput: number; windows: UsageWindow[] } | undefined {
  try {
    const f = rolloutOf(codexHomeDir, threadId);
    return f ? parseTurnRollout(fs.readFileSync(f, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/** The same, for a turn that ran as its own user: found and read AS that user, so a link put where
 *  the record was shows the worker nothing of its own (TURNUSER-ROOT-STAYS-OUT). */
export async function readTurnRolloutAs(user: TurnUser, codexHomeDir: string, threadId: string): Promise<{ modelCalls: number; lastInput: number; windows: UsageWindow[] } | undefined> {
  const safe = threadId.replace(/[^A-Za-z0-9-]/g, "");
  if (!safe) return undefined;
  const f = await findAsUser(user, `${codexHomeDir}/sessions`, `rollout-*${safe}.jsonl`);
  const text = f ? await readAsUser(user, f, 16 * 1024 * 1024) : null;
  return text === null ? undefined : parseTurnRollout(text);
}

/** Recursively find a `rate_limits` object anywhere in a parsed rollout line. */
function findRateLimits(o: unknown): { primary?: CodexRateWindow; secondary?: CodexRateWindow } | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  if (rec.rate_limits && typeof rec.rate_limits === "object") return rec.rate_limits as never;
  for (const k of Object.keys(rec)) {
    const r = findRateLimits(rec[k]);
    if (r) return r;
  }
  return null;
}

/** Newest rollout-*.jsonl under CODEX_HOME/sessions (recursive), by mtime. */
function latestRolloutFile(sessionsDir: string): string | undefined {
  let best: string | undefined;
  let bestM = -1;
  const walk = (d: string): void => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > bestM) {
            bestM = m;
            best = p;
          }
        } catch {
          /* raced unlink */
        }
      }
    }
  };
  walk(sessionsDir);
  return best;
}

/** The codex account's 5h/7d usage windows, read from the latest session rollout log. Returns []
 * when no turn has run yet (no rollout) or on any failure — never throws. Named `fetchCodexUsage`
 * (async) to match the /usage caller, though it's a local file read (no network). */
/** PURE: the newest allowance a rollout's text reports. */
export function usageFromRollout(text: string): UsageWindow[] {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let o: unknown;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const rl = findRateLimits(o);
    const w = rl ? parseCodexRateLimits(rl) : [];
    if (w.length) return w;
  }
  return [];
}

export async function fetchCodexUsage(codexHomeDir: string = CONFIG_HOME): Promise<UsageWindow[]> {
  try {
    const f = latestRolloutFile(`${codexHomeDir}/sessions`);
    if (!f) return [];
    const lines = fs.readFileSync(f, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let o: unknown;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const rl = findRateLimits(o);
      if (rl) {
        const w = parseCodexRateLimits(rl);
        if (w.length) return w;
      }
    }
    return [];
  } catch {
    return [];
  }
}

/** The Codex harness plug for the roster registry (A11). */
export function spec(): Spec {
  return {
    kind: KIND,
    image: IMAGE,
    configHome: CONFIG_HOME,
    identityHome: IDENTITY_HOME,
    runEnv: { CODEX_HOME: CONFIG_HOME },
    // No container configured means THIS pod is the sandbox (local-exec), exactly as claudecode
    // reads it — an agent is a row in Tonoman Cloud, not a container to exec into.
    newRunner: (p: RunnerParams) =>
      new Runner({
        container: p.container,
        local: !p.container,
        model: p.model,
        maxTurns: p.maxTurns,
        closedShell: p.closedShell,
        configHome: configHomeFor(p.agent),
      }),
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
