// The agent runtime HTTP server (k8s split). This runs INSIDE the agent pod/container next
// to `claude`. The gateway no longer `podman exec`s the agent — it drives a turn over the
// network by POSTing to /turn here (see src/harness/httpRunner.ts). This half owns the
// process: it spawns `claude` locally (Runner local-exec mode), streams the normalized
// TurnEvents back as NDJSON, and — crucially — runs the trace decoder to its OWN stdout, so
// `kubectl logs deploy/<agent>` shows the full execution trace natively.
//
// Wire contract:
//   POST /turn   Authorization: Bearer <AGENT_RUNTIME_TOKEN>
//     body:  { prompt, systemPrompt?, model?, maxTurns?, sessionId?, sessionNew? }
//     200:   application/x-ndjson — one JSON TurnEvent per line, yielded incrementally.
//            The "error" kind carries `err` as a STRING (an Error doesn't JSON-serialize);
//            periodic {"kind":"keepalive"} lines keep the body alive on long silent turns.
//   GET /health  (token-free, no LLM spend) → { ok, cred, claude } ; 200 healthy / 503 not.
//   GET /usage   Bearer → { windows } — the agent reads its OWN OAuth token for account headroom.
//   POST /auth/login  Bearer → { url }        \  the headless harness login (roster-auth-remote).
//   POST /auth/code   Bearer { code } → { ok } |  The gateway can't podman-exec across the split,
//   GET  /auth/status Bearer → { loggedIn }   /  and the agent is the only half holding `claude`
//            + the credential store, so IT runs the login. The login argv comes from this agent's
//            harness spec, never from the wire — otherwise /auth/login would be a remote-exec hole.
//
// Inbound media (split-media-carried): the body may carry `media: [{name, b64}]` — files the
// gateway connector downloaded (a receipt, a business card). Since the gateway and this pod share
// no filesystem, the bytes ride the wire; we write each back under AGENT_MEDIA_DIR at its basename
// (the same path the gateway embedded in the prompt) so `claude` can Read it, then delete it after
// the turn. Only the basename is trusted — never a wire-supplied directory (no arbitrary write).

import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import * as claudecode from "../harness/claudecode";
import * as codex from "../harness/codex";
import { asNobody, asTheUser, asUser, canDrop, commandFor, homeIn, ownFolders, ownGroup, readAsUser, runBegan, runToEnd, stopAll, type TurnUser } from "../harness/launch";
import { bringHome } from "../harness/turnusers";
import type { BackendMode } from "../harness/claudecode";
import type { HarnessKind, Spec } from "../harness";
import type { TurnEvent, TurnRequest, TurnRunner } from "../core/contracts";
import { fetchAccountUsage } from "../statusline";
import { extractAuthUrl, extractDeviceAuth, looksLoggedIn } from "../authflow";

// This ONE agent binary can drive EITHER harness — the dual-harness image bakes both `claude`
// and `codex`, and both subscription credentials are mounted. The pod's DEFAULT harness is set
// by TONOMAN_HARNESS (default "claude-code"); it decides /health, /auth and /usage (which hold
// a harness's credential + login), and the runner used when a turn carries no model override.
function activeHarness(): HarnessKind {
  return process.env.TONOMAN_HARNESS === "codex" ? "codex" : "claude-code";
}
/** The active harness's Spec (loginArgs/statusArgs/credFile/bin), for /auth + /health + /usage. */
function activeSpec(): Spec {
  return specFor(activeHarness());
}
/** Default CLI binary for the active harness (version probe). */
function activeBin(): string {
  return binFor(activeHarness());
}

// --- per-REQUEST harness (W1) ------------------------------------------------------------------
// The pod's TONOMAN_HARNESS is a DEFAULT, not a fact. One worker serves a whole tenant, and two of
// its agents can answer on two different providers — so the caller says which one it means and the
// request wins over the env. Everything that differs between them is resolved through this one
// helper rather than five ternaries at five call sites, because the fifth is the one that gets
// missed: the cred FILENAME differs (.credentials.json / auth.json), the config-home ROOT differs
// (/root/.claude / /root/.codex) and the ENV VAR that points a child at it differs
// (CLAUDE_CONFIG_DIR / CODEX_HOME). Getting one of the three wrong means a login that reports
// success into a directory nothing reads.

/** Which harness a request is about: `?harness=` / the JSON body, else the pod's default. */
function harnessOf(req: http.IncomingMessage, body?: Record<string, unknown>): HarnessKind {
  const q = new URL(req.url ?? "/", "http://x").searchParams.get("harness");
  const b = typeof body?.harness === "string" ? body.harness : undefined;
  const asked = q || b;
  if (asked === "codex") return "codex";
  if (asked === "claude-code") return "claude-code";
  return activeHarness(); // unknown or absent → the pod's configured default, as before
}

function specFor(h: HarnessKind): Spec {
  return h === "codex" ? codex.spec() : claudecode.spec();
}
function binFor(h: HarnessKind): string {
  return h === "codex" ? "codex" : "claude";
}
/** This harness's per-agent (and per-person) config home. */
function homeFor(h: HarnessKind, agent: string | undefined, user?: string): string {
  return h === "codex" ? codex.configHomeFor(agent, user) : claudecode.configHomeFor(agent, user);
}
/** The env that points a child process at that config home — a DIFFERENT variable per harness. */
function homeEnv(h: HarnessKind, agent: string | undefined, user?: string): NodeJS.ProcessEnv | undefined {
  if (!agent) return undefined;
  const home = homeFor(h, agent, user);
  return h === "codex" ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home };
}
/** Where a request's provider program runs and as whom. With `?uid=` — the turn's user, which the
 *  worker asks the Cloud for and passes on every call — it is that user, in that user's home, with
 *  none of this service's own environment (TURNUSER-NOTHING-AS-ROOT). Without one (a self-hosted
 *  service) it is as it always was. */
interface Place {
  home?: string;
  env?: NodeJS.ProcessEnv;
  runAs?: TurnUser;
}
const turnUsersOn = (): boolean => (process.env.TONOMAN_TURN_USERS ?? "").toLowerCase() === "on";
const REAL_USERS = { make: (uid: number) => asUser(uid), own: ownFolders, command: commandFor };
async function placeOf(opts: RuntimeOptions, req: http.IncomingMessage, h: HarnessKind, agent: string | undefined, user?: string): Promise<Place> {
  const raw = new URL(req.url ?? "/", "http://x").searchParams.get("uid");
  if (raw === null || raw === "" || !agent) {
    // Where turns run as their own users, so does every sign-in: one that does not say whose user it
    // is for would start the provider's program as this service itself, so it is refused.
    if (turnUsersOn()) throw new Error("this sign-in did not say whose user it is for");
    return { home: agent ? homeFor(h, agent, user) : undefined, env: homeEnv(h, agent, user) };
  }
  const users = opts.turnUsers ?? REAL_USERS;
  const runAs = await users.make(Number(raw)); // throws for a number that is not a turn user's
  const home = homeIn(runAs, agent, h === "codex" ? "codex" : "claude");
  await users.own(runAs, [home]);
  // A login kept where logins used to live is brought home before anything is asked about it: a
  // status check in an empty home would otherwise report a signed-in person as signed out.
  // WHOSE old login follows whose user the Cloud said this is (`of`), exactly as the worker's own
  // move does: a person's own login comes into a person's home, the agent's into the agent's — and
  // when the caller did not say, none does, rather than a person's login land in a shared home.
  // Not swallowed: a login half brought over is not something to go on and ask questions of.
  const of = new URL(req.url ?? "/", "http://x").searchParams.get("of");
  const old = of === "person" ? (user ? homeFor(h, agent, user) : undefined) : of === "agent" ? homeFor(h, agent, undefined) : undefined;
  if (!opts.turnUsers && old) await bringHome(runAs, home, old, path.basename(credFileIn(h, home)));
  return { home, runAs, env: h === "codex" ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home } };
}
/** The command, words and environment that start `bin` in a place. As a turn's user the environment
 *  is scrubbed of this service's secrets first; otherwise it is what it always was. */
function startIn(opts: RuntimeOptions, place: Place, bin: string, args: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  // As a turn's user the launcher gives the program an environment made for it, not this service's.
  return (opts.turnUsers ?? REAL_USERS).command(place.runAs, bin, args, process.env, place.env ?? {});
}
/** Answer 400 when the place cannot be had (a number that is not a turn user's); else the place. */
async function placeOr400(opts: RuntimeOptions, req: http.IncomingMessage, res: http.ServerResponse, h: HarnessKind, agent: string | undefined, user?: string): Promise<Place | undefined> {
  try {
    return await placeOf(opts, req, h, agent, user);
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message.slice(0, 200) }) + "\n");
    return undefined;
  }
}

/** The credential file a login for this harness writes, in that home. */
function credFileIn(h: HarnessKind, home: string): string {
  return h === "codex" ? `${home}/auth.json` : `${home}/.credentials.json`;
}

/** Which harness a model name belongs to — lets `/model` switch harness per turn (default codex
 * `sol`, `/model opus` hops to claude), since the pod holds both CLIs + both credentials. */
function isClaudeModel(m: string | undefined): boolean {
  return !!m && (["sonnet", "opus", "haiku"].includes(m) || /^claude-/.test(m));
}
function isCodexModel(m: string | undefined): boolean {
  return !!m && (["sol", "terra", "luna"].includes(m) || /^gpt-/.test(m));
}

export interface RuntimeOptions {
  /** listen port; 0 lets the OS pick (tests read server.address().port). */
  port: number;
  /** shared bearer token; when set, /turn requires `Authorization: Bearer <token>`.
   * /turn runs `claude --dangerously-skip-permissions`, so anything reaching it drives the
   * agent — the token (plus a NetworkPolicy in k8s) is the access control. */
  token?: string;
  /** injectable for tests; default builds a local-exec claudecode Runner per turn. */
  newRunner?: (o: { model?: string; maxTurns?: number; backend?: BackendMode; disallowedTools?: string[]; harness?: HarnessKind }) => TurnRunner;
  /** Claude-Code-specific tools to drop from every turn (--disallowedTools), from
   * $CLAUDE_CODE_DISALLOWED_TOOLS. Trims their schemas off the context floor for an agent that
   * never uses them (e.g. Task/NotebookEdit/TodoWrite). Backend-specific — see RunnerOptions. */
  disallowedTools?: string[];
  /** credential file probed by /health (token-free); default <CONFIG_HOME>/.credentials.json.
   * Also the OUTCOME signal for /auth/code — a login only counts if this file actually changed. */
  credFile?: string;
  /** harness login/status argv for the /auth/* endpoints (roster-auth-remote). Defaults come from
   * THIS agent's harness spec — never from the wire, or /auth/login would be a remote-exec hole.
   * Injectable so the unit tests can drive a fake login instead of a real OAuth flow. */
  loginArgs?: string[];
  statusArgs?: string[];
  /** How a provider's program is started as a turn's user (turn-user.md). The real launcher unless
   *  a test says otherwise: really dropping privileges needs Linux and root. */
  turnUsers?: {
    make(uid: number): Promise<TurnUser>;
    own(user: TurnUser, folders: string[]): Promise<void>;
    command: typeof commandFor;
  };
  /** where the login transcript is captured; default <tmp>/tonoman-auth.log. */
  authLog?: string;
  /** How to run the login under a PTY (the harness login is a TUI and won't emit its URL to a
   * plain pipe). Default `script -qfc <cmd> <log>` — util-linux, present in the agent image.
   * Injectable because the unit tests run on a host without `script`; they substitute a plain
   * redirect, which exercises the stdin/outcome plumbing but not the PTY itself. */
  ptyArgv?: (cmd: string, log: string) => string[];
  /** the LONGEST to wait for the harness to exchange the code and report logged in; default 30s.
   *  It is polled, not slept: success is reported the moment it is true. Tests shrink it. */
  authSettleMs?: number;
  /** claude binary for the /health version check; default "claude". */
  bin?: string;
  /** AGENT-SIDE identity file (the agent's own AGENTS.md/persona), mounted on THIS pod. When the
   * gateway ships no systemPrompt (the clean split: identity is agent config, not gateway config),
   * the runtime injects this file via --append-system-prompt-file so the agent keeps its persona.
   * Default $AGENT_IDENTITY_FILE. A gateway that DOES ship systemPrompt content overrides it. */
  identityFile?: string;
  /** AGENT-SIDE learned-rules file (learn-durable): the agent's durable personal rules, appended to
   * the system prompt every turn so they're always in force. Default $TONOMAN_BRAIN_DIR/LEARNED.md. */
  learnedFile?: string;
}

/** The /turn request body — a TurnRequest plus the per-turn knobs the gateway holds
 * (model/maxTurns) and the system prompt as CONTENT (not a gateway-side path, which would
 * not resolve on the pod → the agent would run with no persona, silently). */
interface TurnBody {
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  sessionId?: string;
  sessionNew?: boolean;
  /** auth backend for this turn (backend-*): the gateway snapshots its per-agent backend knob
   * here, exactly like `model`. The runtime toggles CLAUDE_CODE_USE_BEDROCK for the claude spawn. */
  backend?: BackendMode;
  /** inbound media the gateway downloaded, base64'd for the wire (split-media-carried). Written
   * back under AGENT_MEDIA_DIR at each basename so the prompt's path reference resolves here. */
  media?: { name?: string; b64?: string }[];
  /** WHICH provider answers this turn (W1): "claude-code" | "codex". The pod holds both CLIs and
   * both credentials, so a turn that does not say runs on TONOMAN_HARNESS — which for an agent
   * configured the other way is the wrong model on the wrong account. The gateway sends it on
   * every turn; an absent value keeps the pod default, so an older gateway is unchanged. */
  harness?: string;
  /** WHOSE credential directory this turn runs under, when the agent runs inference per person.
   * Resolved gateway-side (only it knows the provider AND the speaker) and applied here through
   * the harness's own env var. Unset = the agent's one shared login. */
  configHome?: string;
}

/** Where inbound wire media is materialized in THIS pod; must match the gateway connector's
 * media_dir so the path the prompt already references (media_dir/<name>) resolves here. Read at
 * call-time (not module-load) so it's overridable per test. */
function agentMediaDir(): string {
  return process.env.AGENT_MEDIA_DIR || "/root/media";
}

/** Write each wire media item under AGENT_MEDIA_DIR using ONLY its basename (path.basename strips
 * any dir components → no traversal / arbitrary write). Returns the written paths for the turn.
 * Skips items with no bytes/name. (split-media-carried.) */
export async function materializeMedia(media: { name?: string; b64?: string }[] | undefined): Promise<string[]> {
  const paths: string[] = [];
  if (!media?.length) return paths;
  const dir = agentMediaDir();
  await fs.mkdir(dir, { recursive: true });
  for (const m of media) {
    if (!m?.b64 || !m?.name) continue;
    const dest = path.join(dir, path.basename(m.name));
    await fs.writeFile(dest, Buffer.from(m.b64, "base64"));
    paths.push(dest);
  }
  return paths;
}

/** How long a materialized media file lives before it's swept (split-media-carried lifetime).
 * Default 6h; override with AGENT_MEDIA_TTL_MS. */
function mediaTtlMs(): number {
  const v = Number(process.env.AGENT_MEDIA_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60 * 1000;
}

/** Reclaim media files older than the TTL. Runs at the START of each turn, NOT the end — because a
 * receipt and the instruction to file it routinely arrive as SEPARATE messages (separate turns), so
 * media MUST outlive the single turn that carried it. Per-turn deletion was the bug: the image was
 * unlinked the instant its turn ended, so the follow-up turn that acted on it found nothing. A
 * start-of-turn TTL sweep keeps disk bounded while letting a file survive the follow-up turns of one
 * task; the file just materialized for the CURRENT turn has age ~0 and is never swept. Best-effort:
 * a missing dir, or a race with a concurrent unlink, is not an error. (split-media-carried.) */
export async function sweepStaleMedia(now: number = Date.now()): Promise<string[]> {
  const dir = agentMediaDir();
  const swept: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return swept; // no media dir yet → nothing to reclaim
  }
  const ttl = mediaTtlMs();
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (st.isFile() && now - st.mtimeMs > ttl) {
        await fs.unlink(p);
        swept.push(p);
      }
    } catch {
      /* raced with another sweep or a concurrent write — fine */
    }
  }
  return swept;
}

let sysCounter = 0;

/** Serialize a normalized TurnEvent to one NDJSON line. The `error` kind's `err` is an
 * Error (non-serializable) → emit its message as a string; httpRunner rehydrates it. */
export function encodeEvent(ev: TurnEvent): string {
  const wire: Record<string, unknown> = { kind: ev.kind };
  if (ev.text !== undefined) wire.text = ev.text;
  if (ev.tool !== undefined) wire.tool = ev.tool;
  if (ev.final !== undefined) wire.final = ev.final;
  if (ev.usage !== undefined) wire.usage = ev.usage;
  if (ev.capped !== undefined) wire.capped = ev.capped;
  if (ev.kind === "error") wire.err = ev.err?.message ?? "error";
  return JSON.stringify(wire);
}

/** Local-exec runner factory, routed by MODEL so `/model` can switch harness within one agent:
 *  - a codex model (sol/terra/luna, gpt-*) → codex Runner (spawns `codex`)
 *  - a claude model (sonnet/opus/haiku, claude-*) → claudecode Runner (spawns `claude`)
 *  - no/unknown model → the pod's DEFAULT harness (TONOMAN_HARNESS), so a bare turn runs on the
 *    configured default (e.g. codex `sol`) with no model flag.
 * Both credentials are mounted and each Runner points at its own CONFIG_HOME, so the two never
 * cross-contaminate. */
const localRunner = (o: { model?: string; maxTurns?: number; backend?: BackendMode; disallowedTools?: string[]; harness?: HarnessKind }): TurnRunner => {
  // The turn's OWN harness (W1) stands in for the pod default; an explicit model still wins over
  // both, because `/model opus` on a codex agent is a deliberate one-turn hop and always was.
  const dflt = o.harness ?? activeHarness();
  const useCodex = isCodexModel(o.model) || (!o.model && dflt === "codex");
  if (useCodex && !isClaudeModel(o.model)) {
    return new codex.Runner({ local: true, model: o.model, maxTurns: o.maxTurns });
  }
  return new claudecode.Runner({ local: true, model: o.model, maxTurns: o.maxTurns, backend: o.backend, disallowedTools: o.disallowedTools });
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      buf += c;
      // Headroom for base64'd inbound media (split-media-carried): a ~20MB file → ~27MB base64.
      if (buf.length > 40_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

// Asked once: a program's version does not change while this service runs, and /health is asked often.
const versions = new Map<string, Promise<string | null>>();
function binVersion(bin: string): Promise<string | null> {
  let v = versions.get(bin);
  if (!v) {
    // Where turns run as their own users, nothing of a provider's runs as this service — not even
    // `--version`, which /health asks for without a login (TURNUSER-NOTHING-AS-ROOT).
    const on = turnUsersOn();
    // On, and unable to start anything as anyone else: then it is not started at all.
    if (on && !canDrop()) return Promise.resolve(null);
    const plain = on;
    const start = plain ? asNobody(bin, ["--version"]) : { cmd: bin, args: ["--version"] };
    v = new Promise((resolve) =>
      execFile(start.cmd, start.args, { windowsHide: true, timeout: 5000, env: plain ? { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent" } : process.env }, (err, so) =>
        resolve(err ? null : (so?.toString() ?? "").trim()),
      ),
    );
    versions.set(bin, v);
    void v.then((got) => got === null && versions.delete(bin)); // a failure is asked again
  }
  return v;
}

async function handleHealth(res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  const credFile = opts.credFile ?? activeSpec().credFile ?? `${claudecode.CONFIG_HOME}/.credentials.json`;
  let cred = false;
  let mtime: string | undefined;
  try {
    const st = await fs.stat(credFile);
    cred = true;
    mtime = st.mtime.toISOString();
  } catch {
    /* missing → not healthy */
  }
  const version = await binVersion(opts.bin ?? activeBin());
  const ok = cred && !!version;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, cred, mtime, harness: activeHarness(), claude: version }) + "\n");
}

/** GET /usage — the agent reads its OWN OAuth token and reports account headroom (5h/7d) as
 * { windows: UsageWindow[] } (gw-command-statusline). Bearer-gated like /turn. Degrades to
 * { windows: [] } when the token/endpoint is unavailable (never throws, never leaks the token). */
async function handleUsage(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  if (opts.token && req.headers["authorization"] !== `Bearer ${opts.token}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}\n');
    return;
  }
  // Account-headroom windows (5h/7d): read from the ACTIVE harness's own usage source — codex from
  // the ChatGPT /codex/usage endpoint, claude from Anthropic's OAuth-usage API. Both read usage (not
  // inference) with the account's own token. So a codex agent shows the same 5h/7d window as claude.
  let windows: import("../statusline").UsageWindow[] = [];
  const h = harnessOf(req);
  if (turnUsersOn() || new URL(req.url ?? "/", "http://x").searchParams.get("uid")) {
    // Where turns run as their own users the login is in a user's home, and this service does not
    // open a file there itself (TURNUSER-ROOT-STAYS-OUT): it is read AS that user. Asked without
    // saying whose, there is nothing of anyone's to read.
    const who = agentOf(req);
    const place = who ? await placeOf(opts, req, h, who, userOf(req)).catch(() => undefined) : undefined;
    if (place?.runAs && place.home && !opts.turnUsers) {
      if (h === "codex") {
        const latest = (await asTheUser(place.runAs, 'find "$1" -type f -name "rollout-*.jsonl" -printf "%T@ %p\\n" 2>/dev/null | sort -rn | head -n 1 | cut -d" " -f2-', [`${place.home}/sessions`], { timeoutMs: 20_000 }).catch(() => "")).trim();
        const text = latest ? await asTheUser(place.runAs, 'tail -c 4000000 -- "$1"', [latest], { maxBytes: 5_000_000, timeoutMs: 20_000 }).catch(() => "") : "";
        windows = codex.usageFromRollout(text);
      } else {
        try {
          const raw = await readAsUser(place.runAs, `${place.home}/.credentials.json`, 1 << 20);
          const token = raw ? ((JSON.parse(raw).claudeAiOauth?.accessToken as string) || null) : null;
          if (token) windows = await fetchAccountUsage(token);
        } catch {
          /* missing cred / bad json / not OAuth → [] */
        }
      }
    }
  } else if (h === "codex") {
    // This agent's OWN codex home when it named itself, exactly as the claude branch below reads
    // this agent's own credential — headroom belongs to whoever's subscription is answering.
    const who = agentOf(req);
    windows = await codex.fetchCodexUsage(who ? codex.configHomeFor(who, userOf(req)) : process.env.CODEX_HOME || codex.CONFIG_HOME);
  } else {
    // This agent's own credential: the headroom belongs to whoever's subscription is answering,
    // and reading the shared file would report one person's quota under everybody's name.
    const usageAgent = agentOf(req);
    const credFile = usageAgent
      ? `${claudecode.configHomeFor(usageAgent, userOf(req))}/.credentials.json`
      : (opts.credFile ?? `${claudecode.CONFIG_HOME}/.credentials.json`);
    try {
      const raw = await fs.readFile(credFile, "utf8");
      const token = (JSON.parse(raw).claudeAiOauth?.accessToken as string) || null;
      if (token) windows = await fetchAccountUsage(token);
    } catch {
      /* missing cred / bad json / not OAuth → [] */
    }
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ windows }) + "\n");
}

// --- headless harness login, agent-side (roster-auth-remote) -------------------------------
// The gateway can't `podman exec` across the split, so the AGENT runs its own login: it is the
// only half with `claude` and the credential store. The harness login is a TUI, so it needs a
// PTY — `script` supplies one; its stdin stays a live pipe so the code can arrive in a LATER
// request while the login process (and its PKCE verifier) stays alive in between.
const DEFAULT_AUTH_LOG = path.join(os.tmpdir(), "tonoman-auth.log");
const DEFAULT_PTY = (cmd: string, log: string): string[] => ["script", "-qfc", cmd, log];
/** The login in flight, and WHOSE it is - the follow-up code must be judged against the same
 *  agent that started it, not against whatever the second request happens to say.
 *
 *  `harness` and `credBefore` are here for device auth (codex, W2), which has no second request to
 *  carry them: nothing comes back through us, so the login's own credential BASELINE has to be
 *  snapshotted at start time or "the credential changed" means nothing when /auth/pending asks. */
let pendingLogin: {
  child: import("node:child_process").ChildProcess;
  agent?: string;
  user?: string;
  harness: HarnessKind;
  credFile: string;
  credBefore: [number, number];
  /** Where, and as whom, this login's program runs: every later check of it uses the same. */
  place: Place;
  /** What it has printed, when it runs as a turn's user (see `readAuthLog`). */
  transcript?: string;
  /** It was started in a process group of its own, to be stopped with everything it started. */
  grouped?: boolean;
  /** The child has EXITED, but its record is kept. `codex login --device-auth` exits the moment it
   *  succeeds, so dropping the record on exit would throw away the one thing that makes the next
   *  /auth/pending poll honest: the credential's baseline. Without it the poll falls back to status
   *  alone, and a stale-but-valid auth.json sitting on disk answers "yes" for a login that never
   *  happened. Kept until the poll reads it, or until another login supersedes it. */
  exited?: boolean;
} | null = null;

/** The credential's (mtime, size) — the OUTCOME signal for a login. 0/0 when absent. */
async function credStamp(credFile: string, as?: TurnUser): Promise<[number, number]> {
  // In a turn user's home it is asked AS that user: this service does not look at a path there itself.
  if (as) {
    const out = await asTheUser(as, 'stat -c "%.6Y %s" -- "$1"', [credFile], { timeoutMs: 10_000 }).catch(() => "");
    const [m, size] = out.trim().split(" ").map(Number);
    return Number.isFinite(m) && Number.isFinite(size) ? [m * 1000, size] : [0, 0];
  }
  try {
    const st = await fs.stat(credFile);
    return [st.mtimeMs, st.size];
  } catch {
    return [0, 0];
  }
}

/** Really starting programs as turn users (not a test's stand-in for it). */
const dropsFor = (opts: RuntimeOptions, place: Place | undefined): TurnUser | undefined => (opts.turnUsers ? undefined : place?.runAs);
/** A login's transcript — what it printed: the link to open, the code to enter.
 *
 *  As a turn's user it is NOT a file. A file would have to be somewhere that user can write, and
 *  then any other program of the same user could write it too — and put its own link and code in
 *  front of the person as if the provider had. Nor a name in /tmp, which could be made a link for
 *  this service to read as root. It is what came down a pipe this service holds the other end of:
 *  only the login itself can have said it. Self-hosted, it is the file it always was. */
const TRANSCRIPT_MAX = 256 * 1024;
const readAuthLog = async (opts: RuntimeOptions, place: Place | undefined): Promise<string> =>
  dropsFor(opts, place) ? (pendingLogin?.transcript ?? "") : fs.readFile(opts.authLog ?? DEFAULT_AUTH_LOG, "utf8").catch(() => "");
const dropAuthLog = async (opts: RuntimeOptions, place: Place | undefined): Promise<void> => {
  if (!dropsFor(opts, place)) await fs.rm(opts.authLog ?? DEFAULT_AUTH_LOG, { force: true }).catch(() => {});
};
/** End a login and whatever it started. */
const endLogin = (l: NonNullable<typeof pendingLogin>): void => stopAll(l.child, !!l.grouped);
/** Where a device login may send a person: the provider's own pages, and nowhere else. */
const DEVICE_AUTH_HOSTS = /(^|\.)(openai\.com|chatgpt\.com)$/i;
const trustedDeviceUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && DEVICE_AUTH_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
};

function authUnauthorized(req: http.IncomingMessage, opts: RuntimeOptions): boolean {
  return !!opts.token && req.headers["authorization"] !== `Bearer ${opts.token}`;
}

/** Which agent a login request is about, from `?agent=` or the JSON body.
 *
 *  One runtime serves every agent a pool has, and a Claude subscription belongs to a person — so a
 *  login has to say WHOSE it is or the first person's credential is replaced by the second's.
 *  `configHomeFor` sanitises the name; it decides a filesystem path and it arrives over the wire. */
function agentOf(req: http.IncomingMessage, body?: Record<string, unknown>): string | undefined {
  const q = new URL(req.url ?? "/", "http://x").searchParams.get("agent");
  const b = typeof body?.agent === "string" ? body.agent : undefined;
  return (q || b || undefined) ?? undefined;
}

/** WHICH PERSON's login under the agent, from `?user=` or the JSON body — set only when the agent
 *  runs inference per person, so each teammate signs into their own credential dir. `configHomeFor`
 *  sanitises it the same way as the agent name, since it too decides a filesystem path from the wire.
 *  Absent = the agent's one shared login, which is every agent today. */
function userOf(req: http.IncomingMessage, body?: Record<string, unknown>): string | undefined {
  const q = new URL(req.url ?? "/", "http://x").searchParams.get("user");
  const b = typeof body?.user === "string" ? body.user : undefined;
  return (q || b || undefined) ?? undefined;
}

/** Where this agent's login writes, and where its credential is checked — the person's own dir when
 *  `user` is set, else the agent's shared one. */
function credFileFor(opts: RuntimeOptions, h: HarnessKind, agent: string | undefined, user?: string, place?: Place): string {
  if (place?.runAs && place.home) return credFileIn(h, place.home);
  if (agent) return credFileIn(h, homeFor(h, agent, user));
  return opts.credFile ?? specFor(h).credFile ?? credFileIn(h, h === "codex" ? codex.CONFIG_HOME : claudecode.CONFIG_HOME);
}

/** POST /auth/login — start the harness's own login under a PTY and return what the person needs.
 *
 * Takes NO command from the caller: the argv comes from the named harness's spec, so the endpoint
 * can't be turned into a remote-exec primitive. Bearer-gated like /turn.
 *
 * TWO SHAPES, because the two providers ask for two different things:
 *  - claude  → `{ url }`.        The person pastes a code back; `/auth/code` completes it.
 *  - codex   → `{ url, code }`.  Device auth: the person enters OUR code on OpenAI's page and the
 *                                CLI polls. Nothing comes back through us, so there is no second
 *                                request — the child stays alive and `/auth/pending` watches it.
 */
async function handleAuthLogin(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  if (authUnauthorized(req, opts)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}\n');
    return;
  }
  const h = harnessOf(req);
  const deviceAuth = h === "codex";
  const loginArgs = opts.loginArgs ?? specFor(h).loginArgs ?? [];
  if (!loginArgs.length) {
    res.writeHead(501, { "content-type": "application/json" });
    res.end('{"error":"this harness defines no login command"}\n');
    return;
  }
  // A second login supersedes a pending one — its PKCE verifier is dead to us anyway.
  if (pendingLogin) {
    endLogin(pendingLogin);
    pendingLogin = null;
  }
  // DEVICE AUTH NEEDS NO PTY. `codex login --device-auth` prints its URL and code straight to a
  // plain pipe (verified against codex-cli 0.154), so the transcript is captured by redirecting the
  // child's own stdout — no `script`, and no guessing how the CLI renders under a TTY it thinks a
  // person is watching. Claude's login IS a TUI and still gets the PTY, which is what `script` was
  // brought in for. `ptyArgv` is honoured either way, because that is what the tests inject.

  // The login writes wherever the harness's config-home env points, so this is the line that
  // decides whose subscription an agent ends up running on. Without it every login in the pool
  // lands in one directory and the last person to sign in owns every agent. WHICH variable that
  // is differs by harness (CLAUDE_CONFIG_DIR / CODEX_HOME) — see homeEnv.
  const who = agentOf(req);
  const user = userOf(req);
  // codex refuses a missing CODEX_HOME; make sure the per-person home exists before the login runs.
  const place = await placeOr400(opts, req, res, h, who, user);
  if (!place) return;
  const authLog = opts.authLog ?? DEFAULT_AUTH_LOG;
  await dropAuthLog(opts, place);
  const asUserNow = dropsFor(opts, place);
  // As a turn's user the transcript comes down this service's own pipe (see `readAuthLog`): a device
  // login prints straight to it, and the PTY's `script` is given nowhere to write but its output.
  const argv = opts.ptyArgv ? opts.ptyArgv(loginArgs.join(" "), authLog) : deviceAuth ? loginArgs : DEFAULT_PTY(loginArgs.join(" "), asUserNow ? "/dev/null" : authLog);
  const logFd = !opts.ptyArgv && deviceAuth && !asUserNow ? await fs.open(authLog, "a") : undefined;
  if (h === "codex" && who && !place.runAs) codex.ensureCodexHome(homeFor(h, who, user));
  // As the turn's user when the worker named one: a sign-in is the provider's own program, and it
  // writes the credential — it does not run as this service (TURNUSER-NOTHING-AS-ROOT). And it ends
  // like any other run of that user: counted, in a group of its own, with what it leaves behind
  // stopped (TURNUSER-DIES-WITH-THE-TURN).
  const start = startIn(opts, place, argv[0], argv.slice(1));
  const hold = await runBegan(asUserNow);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(start.cmd, start.args, {
      // Device auth writes its own transcript; the PTY path has `script` write it instead.
      stdio: asUserNow ? ["pipe", "pipe", "pipe"] : logFd ? ["pipe", logFd.fd, logFd.fd] : ["pipe", "ignore", "ignore"],
      env: start.env,
      ...ownGroup(asUserNow),
    });
  } catch (e) {
    hold.release();
    await logFd?.close().catch(() => {});
    throw e;
  }
  hold.started(child.pid);
  child.once("exit", hold.release);
  child.once("error", hold.release);
  let transcript = "";
  if (asUserNow) {
    const said = (b: Buffer): void => {
      transcript = (transcript + b.toString("utf8")).slice(-TRANSCRIPT_MAX);
      if (pendingLogin?.child === child) pendingLogin.transcript = transcript;
    };
    child.stdout?.on("data", said);
    child.stderr?.on("data", said);
  }
  // Ours to close once the child holds its own descriptor.
  await logFd?.close().catch(() => {});
  // The BASELINE, taken before the login can have written anything. Device auth completes with no
  // further request from us, so without this snapshot /auth/pending has nothing to compare against
  // and would bless a pre-existing credential as a login that just happened.
  const credFile = credFileFor(opts, h, who, user, place);
  const credBefore = await credStamp(credFile, asUserNow);
  pendingLogin = { child, agent: who, user, harness: h, credFile, credBefore, place, transcript, grouped: !!ownGroup(asUserNow).detached };
  // A spawn that never started has no baseline worth keeping — it wrote nothing.
  child.on("error", () => {
    if (pendingLogin?.child === child) pendingLogin = null;
  });
  // An exit is NOT the end of the record. Device auth exits ON SUCCESS, and the poll that has not
  // asked yet still needs the baseline to tell that success apart from a credential that was
  // already there. See `exited` above.
  child.on("exit", () => {
    if (pendingLogin?.child === child) pendingLogin.exited = true;
  });

  const deadline = Date.now() + 25_000;
  for (;;) {
    const raw = await readAuthLog(opts, place);
    if (deviceAuth) {
      // Both or neither: a URL with no code is not something a person can act on, and answering
      // with half of it would put them on a page that asks for something we have not read yet.
      const d = extractDeviceAuth(raw);
      // Only ever the provider's own page: a person is never sent somewhere else to type a code.
      if (d && trustedDeviceUrl(d.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: d.url, code: d.code }) + "\n");
        return;
      }
    } else {
      const url = extractAuthUrl(raw);
      if (url) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url }) + "\n");
        return;
      }
    }
    // Bail on: timeout, the login exiting, or the spawn failing outright (the "error" handler
    // clears pendingLogin) — never spin for 25s on a login that was never going to speak.
    // Bail on: timeout, the login exiting before it spoke, or the spawn failing outright. A login
    // that exited WITHOUT printing its URL has nothing to offer either way, so the record goes too.
    if (Date.now() > deadline || child.exitCode !== null || pendingLogin?.child !== child) {
      stopAll(child, !!ownGroup(asUserNow).detached);
      pendingLogin = null;
      res.writeHead(504, { "content-type": "application/json" });
      res.end('{"error":"login URL did not appear"}\n');
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** GET /auth/pending — has the login started by /auth/login finished? (W2, device auth.)
 *
 * Judged exactly as `/auth/code` judges a pasted code, and for the same reason: OUTCOME-TRUE. The
 * credential file must actually have changed since the login started AND the harness's own status
 * must agree. `auth status` alone would read a PRE-EXISTING credential and report a cheerful ✓ for
 * a login nobody ever completed.
 *
 * It tolerates a MISSING pendingLogin rather than 409-ing: a poll runs for ten minutes, and the
 * child can be gone (it exited the moment it finished, or the process was restarted) while the
 * credential it wrote is right there. With no baseline to compare against, status alone is the
 * best available signal — reported honestly as `credChanged: false` so the caller can tell.
 */
async function handleAuthPending(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  if (authUnauthorized(req, opts)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}\n');
    return;
  }
  const h = harnessOf(req);
  const who = agentOf(req);
  const user = userOf(req);
  // The login's OWN record wins over what this request says, so a stray poll cannot judge one
  // person's credential to bless another's login — the same rule /auth/code follows.
  const mine = pendingLogin && (pendingLogin.agent ?? undefined) === who && (pendingLogin.user ?? undefined) === user;
  const place = mine ? pendingLogin!.place : await placeOr400(opts, req, res, h, who, user);
  if (!place) return;
  const credFile = mine ? pendingLogin!.credFile : credFileFor(opts, h, who, user, place);
  const before = mine ? pendingLogin!.credBefore : undefined;
  const after = await credStamp(credFile, dropsFor(opts, place));
  const credChanged = before ? after[0] > before[0] || after[1] !== before[1] : false;

  const statusArgs = opts.statusArgs ?? specFor(mine ? pendingLogin!.harness : h).statusArgs ?? [];
  const status = statusArgs.length
    ? (await run(opts, place, statusArgs[0], statusArgs.slice(1))).trim()
    : "";
  const loggedIn = looksLoggedIn(status);
  // Done = the credential moved AND the harness agrees. With no baseline (the child is gone) the
  // harness's word is all there is, and it is reported as such rather than dressed up.
  const done = loggedIn && (credChanged || !before);
  if (done) {
    if (pendingLogin) endLogin(pendingLogin);
    pendingLogin = null;
    if (place) await dropAuthLog(opts, place);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ done, loggedIn, credChanged, pending: !!pendingLogin, status }) + "\n");
}

/** POST /auth/code {code} — hand the code to the waiting login and report OUTCOME-TRUE success:
 * the credential file must have actually been (re)written. `auth status` alone would happily read
 * a PRE-EXISTING credential and report a false ✓ for a login that never completed. */
async function handleAuthCode(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  if (authUnauthorized(req, opts)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}\n');
    return;
  }
  let code = "";
  try {
    code = String((JSON.parse(await readBody(req)) as { code?: unknown }).code ?? "");
  } catch {
    /* bad json → empty code → 400 below */
  }
  if (!code) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"no code"}\n');
    return;
  }
  if (!pendingLogin) {
    res.writeHead(409, { "content-type": "application/json" });
    res.end('{"error":"no login in progress — start one with auth login --headless"}\n');
    return;
  }
  // The SAME agent the login was started for - taken from the pending login rather than from
  // this request, so a mistyped follow-up cannot check one person's credential to bless
  // another's login.
  // Falls back to the agent named on THIS request only when the pending login recorded none —
  // an older client that sent it one way and not the other should still be judged per agent.
  // The harness the login was STARTED on, for the same reason as the agent: the pending login is
  // the authority on what it is, not a follow-up request that may say anything.
  const h = pendingLogin?.harness ?? harnessOf(req);
  const codePlace = pendingLogin?.place ?? (await placeOr400(opts, req, res, h, pendingLogin?.agent ?? agentOf(req), pendingLogin?.user ?? userOf(req)));
  if (!codePlace) return;
  const credFile = pendingLogin?.credFile ?? credFileFor(opts, h, pendingLogin?.agent ?? agentOf(req), pendingLogin?.user ?? userOf(req), codePlace);
  // Taken NOW, not at login time, and deliberately: this flow's window is the few seconds between
  // the person pasting a code and the CLI writing the credential. Widening it to the whole login
  // would let a routine background token refresh count as "the credential changed", and bless a
  // wrong code on an agent that happened to already be signed in. (Device auth cannot do it this
  // way — nothing comes back through us to mark the start of that window — which is exactly why
  // /auth/pending carries its own baseline from /auth/login instead.)
  const before = await credStamp(credFile, dropsFor(opts, codePlace));

  pendingLogin.child.stdin?.write(`${code}\n`);

  const statusArgs = opts.statusArgs ?? specFor(h).statusArgs ?? [];
  // The SAME directory the login wrote to. Asked without it, this reads the shared home, reports
  // "loggedIn": false for a login that worked perfectly, and tells the person their code failed —
  // which is exactly what it did: the credential file had changed, and the status check was
  // looking somewhere else entirely.
  const codeAgent = pendingLogin?.agent ?? agentOf(req);
  const codeUser = pendingLogin?.user ?? userOf(req);
  const statusNow = async (): Promise<string> =>
    statusArgs.length
      ? (
          await run(opts, codePlace, statusArgs[0], statusArgs.slice(1))
        ).trim()
      : "";

  // POLLED, not a fixed sleep. The CLI writes the credential file first and the account state that
  // `auth status` reads a moment later, so one check 4.5s in reported `loggedIn: false` for logins
  // that had worked — twice in a row — and people re-did a login that was already done. Wait for the
  // credential to change AND status to agree, up to the settle limit.
  const deadline = Date.now() + (opts.authSettleMs ?? 30_000);
  let after = before;
  let status = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    after = await credStamp(credFile, dropsFor(opts, codePlace));
    if (!(after[0] > before[0] || after[1] !== before[1])) continue;
    status = await statusNow();
    if (!statusArgs.length || looksLoggedIn(status)) break;
  }
  if (!status) status = await statusNow();
  const loginTail = (await readAuthLog(opts, codePlace)).slice(-400);

  if (pendingLogin) endLogin(pendingLogin);
  pendingLogin = null;
  await dropAuthLog(opts, codePlace);

  const credChanged = after[0] > before[0] || after[1] !== before[1];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: credChanged && looksLoggedIn(status), status, loginTail }) + "\n");
}

/** GET /auth/status — what the harness itself reports (account, plan). Bearer-gated. */
async function handleAuthStatus(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  if (authUnauthorized(req, opts)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}\n');
    return;
  }
  // The harness asked about (W1), not the pod's default: one runtime holds both CLIs and both
  // credentials, so `codex login status` and `claude auth status` answer about different accounts.
  const h = harnessOf(req);
  const statusArgs = opts.statusArgs ?? specFor(h).statusArgs ?? [];
  // Scoped to the agent asked about. Without this every agent reports the POOL's credential,
  // which is the confusion per-agent logins exist to remove - and the answer would look right.
  const who = agentOf(req);
  const user = userOf(req);
  const place = await placeOr400(opts, req, res, h, who, user);
  if (!place) return;
  const status = statusArgs.length ? (await run(opts, place, statusArgs[0], statusArgs.slice(1))).trim() : "";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ loggedIn: looksLoggedIn(status), status }) + "\n");
}

/** execFile → combined output, never throws (a non-zero `auth status` is information, not a crash). */
function run(opts: RuntimeOptions, place: Place, bin: string, args: string[]): Promise<string> {
  const start = startIn(opts, place, bin, args);
  // As a turn's user it is a counted run with a real deadline (killed, not asked), swept when it
  // ends like any other — a sign-in ending beside it does not take it for a stray, and what it might
  // leave behind does not stay.
  const as = dropsFor(opts, place);
  if (as) return runToEnd(as, start.cmd, start.args, start.env, 60_000);
  return new Promise((resolve) =>
    execFile(start.cmd, start.args, { windowsHide: true, maxBuffer: 1 << 22, env: start.env, timeout: 60_000, killSignal: "SIGKILL" }, (_e, so, se) => resolve((so?.toString() ?? "") + (se?.toString() ?? ""))),
  );
}

async function handleTurn(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  // A turn started here would run as this service — as root, beside every home. Where turns run as
  // their own users they are started by the worker's launcher and nowhere else (TURNUSER-NOTHING-AS-ROOT).
  if (turnUsersOn()) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end('{"error":"turns are not run by this service where they run as their own users"}\n');
    return;
  }
  if (opts.token && req.headers["authorization"] !== `Bearer ${opts.token}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}\n');
    return;
  }
  let body: TurnBody;
  try {
    body = JSON.parse(await readBody(req)) as TurnBody;
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"bad json"}\n');
    return;
  }
  if (!body.prompt) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"missing prompt"}\n');
    return;
  }

  // Client (gateway) disconnect / fetch-abort → TCP close → abort the local claude child.
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });

  // Identity resolution (+ learned rules, learn-durable). Prefer content shipped by the gateway;
  // otherwise this pod's OWN mounted identity file. If a LEARNED.md exists in the brain, APPEND it so
  // the agent's durably-recorded personal rules are in force every turn — the read-side of the
  // personal learn path. When learned rules are present we always write a combined tmp file.
  let sysFile: string | undefined;
  let sysTmp = false;
  const identity = body.systemPrompt ?? (opts.identityFile ? await fs.readFile(opts.identityFile, "utf8").catch(() => undefined) : undefined);
  const learned = opts.learnedFile ? await fs.readFile(opts.learnedFile, "utf8").catch(() => undefined) : undefined;
  if (learned && learned.trim()) {
    const combined = [identity ?? "", "\n\n# Your learned rules (durable — you recorded these; follow them)\n", learned].join("\n");
    sysFile = path.join(os.tmpdir(), `tonoman-sysprompt-${process.pid}-${++sysCounter}.md`);
    await fs.writeFile(sysFile, combined, "utf8");
    sysTmp = true;
  } else if (body.systemPrompt) {
    sysFile = path.join(os.tmpdir(), `tonoman-sysprompt-${process.pid}-${++sysCounter}.md`);
    await fs.writeFile(sysFile, body.systemPrompt, "utf8");
    sysTmp = true;
  } else if (opts.identityFile) {
    sysFile = opts.identityFile;
  }

  // Reclaim media from earlier turns that has aged out (start-of-turn TTL sweep), THEN materialize
  // this turn's media. The order matters: sweeping first bounds the dir, and the file we're about to
  // write has age ~0 so it can never be caught by its own turn's sweep. Media is NOT deleted at turn
  // end — a receipt sent in one message is routinely acted on in a LATER turn (split-media-carried).
  await sweepStaleMedia().catch((e) => console.error(`runtime: media sweep failed: ${(e as Error).message}`));
  let mediaPaths: string[] = [];
  try {
    mediaPaths = await materializeMedia(body.media);
  } catch (e) {
    console.error(`runtime: media write failed: ${(e as Error).message}`); // non-fatal; text turn runs
  }

  const turnReq: TurnRequest = {
    prompt: body.prompt,
    systemPromptFile: sysFile,
    sessionId: body.sessionId,
    sessionNew: body.sessionNew,
    mediaPaths,
    // WHOSE login answers, on a per-person agent. The runner applies it through its own harness's
    // env var, so the same field means CLAUDE_CONFIG_DIR for one and CODEX_HOME for the other.
    configHome: body.configHome,
  };
  const runner = (opts.newRunner ?? localRunner)({
    model: body.model,
    maxTurns: body.maxTurns,
    backend: body.backend,
    disallowedTools: opts.disallowedTools,
    harness: harnessOf(req, body as unknown as Record<string, unknown>),
  });

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (s: string): void => {
    if (!res.writableEnded && !res.destroyed) res.write(s);
  };
  // Heartbeat so a silent multi-minute `billing` phase doesn't trip the client's idle-body timeout.
  const hb = setInterval(() => write('{"kind":"keepalive"}\n'), 15000);
  try {
    for await (const ev of runner.run(turnReq, ac.signal)) {
      if (res.writableEnded || res.destroyed) break;
      write(encodeEvent(ev) + "\n");
    }
  } catch (e) {
    write(encodeEvent({ kind: "error", err: e as Error }) + "\n");
  } finally {
    clearInterval(hb);
    if (sysFile && sysTmp) fs.unlink(sysFile).catch(() => {}); // never delete a mounted identity file
    // NB: media is deliberately NOT unlinked here. It must survive into follow-up turns (the image
    // arrives, the instruction to act on it comes next) — the start-of-turn TTL sweep reclaims it.
    if (!res.writableEnded) res.end();
  }
}

/** Start the agent runtime HTTP server. Returns the (already-listening) http.Server. */
export function serveRuntime(opts: RuntimeOptions): http.Server {
  // It starts programs as any turn user it is asked to: with no token, anything that can reach its
  // port could ask. So where turns run as their own users it does not start without one.
  if (turnUsersOn() && !opts.token?.trim()) throw new Error("the sign-in service needs a token (AGENT_RUNTIME_TOKEN) where turns run as their own users; it was not started");
  const brainDir = process.env.TONOMAN_BRAIN_DIR;
  opts = {
    ...opts,
    identityFile: opts.identityFile ?? process.env.AGENT_IDENTITY_FILE,
    learnedFile: opts.learnedFile ?? (brainDir ? path.join(brainDir, "LEARNED.md") : undefined),
  };
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && url === "/turn") {
      void handleTurn(req, res, opts);
      return;
    }
    // /health AND / answer the (token-free) probe, so both k8s probes and the gateway's
    // service-style `fetch(host/)` health check work.
    if (req.method === "GET" && (url === "/health" || url === "/")) {
      void handleHealth(res, opts);
      return;
    }
    // /usage (gw-command-statusline, k8s split): the AGENT holds the OAuth credential, so it —
    // not the gateway — fetches its own Claude account headroom (5h/7d) and returns the windows.
    // Bearer-gated like /turn (it reads the cred + hits the Anthropic OAuth API); never spends
    // model tokens. This is the split-correct replacement for the gateway's podman-exec read.
    if (req.method === "GET" && url === "/usage") {
      void handleUsage(req, res, opts);
      return;
    }
    // /auth/* (roster-auth-remote): the headless harness login, driven agent-side. The gateway
    // can't podman-exec across the split, and the agent is the only half holding `claude` + the
    // credential store — so it runs its own login and the operator's `tonoman auth login
    // <agent> --headless` reads identically for a local and a remote agent.
    if (req.method === "POST" && url === "/auth/login") {
      void handleAuthLogin(req, res, opts);
      return;
    }
    if (req.method === "POST" && url === "/auth/code") {
      void handleAuthCode(req, res, opts);
      return;
    }
    if (req.method === "GET" && url === "/auth/status") {
      void handleAuthStatus(req, res, opts);
      return;
    }
    // /auth/pending (W2): device auth has no code to send back, so the gateway POLLS here until the
    // person has finished on OpenAI's page and the CLI has written the credential.
    if (req.method === "GET" && url === "/auth/pending") {
      void handleAuthPending(req, res, opts);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}\n');
  });
  server.listen(opts.port);
  return server;
}
