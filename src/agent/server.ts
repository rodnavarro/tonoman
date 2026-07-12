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
import { Runner, CONFIG_HOME, spec } from "../harness/claudecode";
import type { BackendMode } from "../harness/claudecode";
import type { TurnEvent, TurnRequest, TurnRunner } from "../core/contracts";
import { fetchAccountUsage } from "../statusline";
import { extractAuthUrl, looksLoggedIn } from "../authflow";

export interface RuntimeOptions {
  /** listen port; 0 lets the OS pick (tests read server.address().port). */
  port: number;
  /** shared bearer token; when set, /turn requires `Authorization: Bearer <token>`.
   * /turn runs `claude --dangerously-skip-permissions`, so anything reaching it drives the
   * agent — the token (plus a NetworkPolicy in k8s) is the access control. */
  token?: string;
  /** injectable for tests; default builds a local-exec claudecode Runner per turn. */
  newRunner?: (o: { model?: string; maxTurns?: number; backend?: BackendMode; disallowedTools?: string[] }) => TurnRunner;
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
  /** where the login transcript is captured; default <tmp>/tonoman-auth.log. */
  authLog?: string;
  /** How to run the login under a PTY (the harness login is a TUI and won't emit its URL to a
   * plain pipe). Default `script -qfc <cmd> <log>` — util-linux, present in the agent image.
   * Injectable because the unit tests run on a host without `script`; they substitute a plain
   * redirect, which exercises the stdin/outcome plumbing but not the PTY itself. */
  ptyArgv?: (cmd: string, log: string) => string[];
  /** how long to let the harness exchange the code + write creds before we judge the outcome;
   * default 4500ms (a real OAuth exchange). Tests shrink it — a fake login needs no round trip. */
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
}

/** Where inbound wire media is materialized in THIS pod; must match the gateway connector's
 * media_dir so the path the prompt already references (media_dir/<name>) resolves here. Read at
 * call-time (not module-load) so it's overridable per test. */
function agentMediaDir(): string {
  return process.env.AGENT_MEDIA_DIR || "/root/media";
}

/** Write each wire media item under AGENT_MEDIA_DIR using ONLY its basename (path.basename strips
 * any dir components → no traversal / arbitrary write). Returns the written paths for the turn +
 * cleanup. Skips items with no bytes/name. (split-media-carried.) */
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

/** Default runner factory: a local-exec claudecode Runner (spawns `claude` in THIS container). */
const localRunner = (o: { model?: string; maxTurns?: number; backend?: BackendMode; disallowedTools?: string[] }): TurnRunner =>
  new Runner({ local: true, model: o.model, maxTurns: o.maxTurns, backend: o.backend, disallowedTools: o.disallowedTools });

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

function claudeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(bin, ["--version"], { windowsHide: true, timeout: 5000 }, (err, so) =>
      resolve(err ? null : (so?.toString() ?? "").trim()),
    ),
  );
}

async function handleHealth(res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  const credFile = opts.credFile ?? `${CONFIG_HOME}/.credentials.json`;
  let cred = false;
  let mtime: string | undefined;
  try {
    const st = await fs.stat(credFile);
    cred = true;
    mtime = st.mtime.toISOString();
  } catch {
    /* missing → not healthy */
  }
  const claude = await claudeVersion(opts.bin ?? "claude");
  const ok = cred && !!claude;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, cred, mtime, claude }) + "\n");
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
  const credFile = opts.credFile ?? `${CONFIG_HOME}/.credentials.json`;
  let windows: import("../statusline").UsageWindow[] = [];
  try {
    const raw = await fs.readFile(credFile, "utf8");
    const token = (JSON.parse(raw).claudeAiOauth?.accessToken as string) || null;
    if (token) windows = await fetchAccountUsage(token);
  } catch {
    /* missing cred / bad json / not OAuth → [] */
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
let pendingLogin: { child: import("node:child_process").ChildProcess } | null = null;

/** The credential's (mtime, size) — the OUTCOME signal for a login. 0/0 when absent. */
async function credStamp(credFile: string): Promise<[number, number]> {
  try {
    const st = await fs.stat(credFile);
    return [st.mtimeMs, st.size];
  } catch {
    return [0, 0];
  }
}

function authUnauthorized(req: http.IncomingMessage, opts: RuntimeOptions): boolean {
  return !!opts.token && req.headers["authorization"] !== `Bearer ${opts.token}`;
}

/** POST /auth/login — start the harness's own login under a PTY and return the OAuth URL.
 * Takes NO command from the caller: the argv comes from this agent's harness spec, so the
 * endpoint can't be turned into a remote-exec primitive. Bearer-gated like /turn. */
async function handleAuthLogin(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
  if (authUnauthorized(req, opts)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"unauthorized"}\n');
    return;
  }
  const loginArgs = opts.loginArgs ?? spec().loginArgs ?? [];
  if (!loginArgs.length) {
    res.writeHead(501, { "content-type": "application/json" });
    res.end('{"error":"this harness defines no login command"}\n');
    return;
  }
  // A second login supersedes a pending one — its PKCE verifier is dead to us anyway.
  if (pendingLogin) {
    pendingLogin.child.kill();
    pendingLogin = null;
  }
  const authLog = opts.authLog ?? DEFAULT_AUTH_LOG;
  await fs.rm(authLog, { force: true }).catch(() => {});

  const argv = (opts.ptyArgv ?? DEFAULT_PTY)(loginArgs.join(" "), authLog);
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
  pendingLogin = { child };
  child.on("error", () => {
    if (pendingLogin?.child === child) pendingLogin = null;
  });
  child.on("exit", () => {
    if (pendingLogin?.child === child) pendingLogin = null;
  });

  const deadline = Date.now() + 25_000;
  for (;;) {
    const raw = await fs.readFile(authLog, "utf8").catch(() => "");
    const url = extractAuthUrl(raw);
    if (url) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url }) + "\n");
      return;
    }
    // Bail on: timeout, the login exiting, or the spawn failing outright (the "error" handler
    // clears pendingLogin) — never spin for 25s on a login that was never going to speak.
    if (Date.now() > deadline || child.exitCode !== null || pendingLogin?.child !== child) {
      child.kill();
      pendingLogin = null;
      res.writeHead(504, { "content-type": "application/json" });
      res.end('{"error":"login URL did not appear"}\n');
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
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
  const credFile = opts.credFile ?? `${CONFIG_HOME}/.credentials.json`;
  const before = await credStamp(credFile);

  pendingLogin.child.stdin?.write(`${code}\n`);
  await new Promise((r) => setTimeout(r, opts.authSettleMs ?? 4500)); // exchange the code + write creds

  const after = await credStamp(credFile);
  const statusArgs = opts.statusArgs ?? spec().statusArgs ?? [];
  const status = statusArgs.length ? (await run(statusArgs[0], statusArgs.slice(1))).trim() : "";
  const authLog = opts.authLog ?? DEFAULT_AUTH_LOG;
  const loginTail = (await fs.readFile(authLog, "utf8").catch(() => "")).slice(-400);

  pendingLogin?.child.kill();
  pendingLogin = null;
  await fs.rm(authLog, { force: true }).catch(() => {});

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
  const statusArgs = opts.statusArgs ?? spec().statusArgs ?? [];
  const status = statusArgs.length ? (await run(statusArgs[0], statusArgs.slice(1))).trim() : "";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ loggedIn: looksLoggedIn(status), status }) + "\n");
}

/** execFile → combined output, never throws (a non-zero `auth status` is information, not a crash). */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile(bin, args, { windowsHide: true, maxBuffer: 1 << 22 }, (_e, so, se) => resolve((so?.toString() ?? "") + (se?.toString() ?? ""))),
  );
}

async function handleTurn(req: http.IncomingMessage, res: http.ServerResponse, opts: RuntimeOptions): Promise<void> {
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

  // Materialize any inbound media into this pod's FS so `claude` can Read it by the same path
  // the prompt references (split-media-carried). Cleaned up in the finally below.
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
  };
  const runner = (opts.newRunner ?? localRunner)({ model: body.model, maxTurns: body.maxTurns, backend: body.backend, disallowedTools: opts.disallowedTools });

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
    for (const p of mediaPaths) fs.unlink(p).catch(() => {}); // per-turn media is transient
    if (!res.writableEnded) res.end();
  }
}

/** Start the agent runtime HTTP server. Returns the (already-listening) http.Server. */
export function serveRuntime(opts: RuntimeOptions): http.Server {
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
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}\n');
  });
  server.listen(opts.port);
  return server;
}
