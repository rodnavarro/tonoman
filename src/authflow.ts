// Headless harness auth (roster-auth-headless). When the operator can't run a browser where
// the agent runs (remote box, phone-only), `tonoman auth login <agent> --headless` starts the
// harness's own login INSIDE the sandbox under a PTY (the login is a TUI), captures the OAuth
// URL, and prints it. The operator authorizes on any device, then finishes with
// `tonoman auth code <agent> <code>`. Creds persist in the agent's config volume (the harness
// writes them), verified via `auth status`. No interactive TTY at the operator; no hand-run
// scripts in the container — this IS the supported path.
//
// The login process is started DETACHED (`podman exec -d`) so it survives the first CLI call
// and keeps the PKCE verifier alive for the second; a held-open FIFO carries the code in. The
// URL extractor is pure (ANSI-stripped) so it's unit-tested without a container.

import { execFile } from "node:child_process";

const FIFO = "/tmp/tonoman-auth.fifo";
const LOG = "/tmp/tonoman-auth.log";

/** PURE: pull the OAuth URL out of a captured (ANSI/cursor-laden) login transcript. The PTY
 * wraps the URL across lines and the "Paste code here" prompt can concatenate onto the end,
 * so we strip escapes, join, regex the claude URL, and trim at the prompt. Unit-tested. */
export function extractAuthUrl(raw: string): string | undefined {
  const t = raw
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC
    .replace(/\x1b[@-Z\\-_]/g, "") // single-char escapes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (cursor moves, colors)
    .replace(/\r/g, "");
  const joined = t.replace(/\n/g, "");
  const m = joined.match(/https:\/\/[a-z.]*claude\.com\/[A-Za-z0-9%._~:/?#[\]@!$&()*+,;=-]+/);
  if (!m) return undefined;
  let url = m[0];
  const cut = url.indexOf("Paste"); // the prompt text can run onto the state param
  if (cut > 0) url = url.slice(0, cut);
  return url;
}

/** Whether an `auth status` output reports a logged-in session (harness-agnostic-ish). */
export function looksLoggedIn(statusOut: string): boolean {
  return /"loggedIn"\s*:\s*true/i.test(statusOut) || /\blogged in\b/i.test(stripAnsi(statusOut));
}

/** PURE: does a turn error look like a harness AUTH failure (vs any other error)? Matched on
 * the failure SHAPE, not one harness's exact wording, so it surfaces an actionable notice
 * (gw-auth-actionable) instead of failing silently. Deliberately narrow to avoid false hits. */
export function isAuthError(msg: string): boolean {
  return /\b401\b|invalid authentication credentials|failed to authenticate|authentication failed|oauth token (has )?expired|invalid_grant|\bnot authenticated\b|please run\b[^.]*\blogin/i.test(
    msg || "",
  );
}

/** The user-facing notice for an unauthenticated agent — names the agent + the exact fix. */
export function authNotice(agentName: string): string {
  return `⚠️ I can't run — my login isn't valid (missing or expired).\nOperator: authenticate me with\n  tonoman auth login ${agentName} --headless`;
}

/** PURE: does a turn error look like a RESUME of a harness session whose store is gone? A
 * session_persist agent whose session dir was wiped (e.g. a fresh PVC/volume, or `rm`d creds)
 * fails on `--resume <id>`; the claude CLI surfaces it as a generic "error_during_execution" or an
 * explicit "no conversation found". The router only consults this when it WAS resuming (!sessionNew),
 * so matching the generic subtype is safe — and it justifies ONE fresh-session retry (a chat turn is
 * safe to re-run). Part of gw-turn-ended-actionable (never die silently). */
export function isStaleSessionError(msg: string): boolean {
  return /error_during_execution|no conversation found|session (id )?.*not found|could not (find|load|resume) session|invalid session|unknown session/i.test(
    msg || "",
  );
}

/** The notice shown when a vanished session was auto-recovered (resume-miss self-heal). Visible,
 * not magic — the user learns their history was dropped, but the turn still runs. */
export function resumeResetNotice(): string {
  return "↻ My previous session had expired, so I started a fresh one and ran your message on it.";
}

/** The never-silent FLOOR (gw-turn-ended-actionable): a turn that failed for a reason we can't
 * auto-recover still gets an explicit, non-alarming message — never a dead typing cue. Keeps the
 * detail short (the full error is in the gateway log) and carries no secrets (harness/infra text). */
export function turnErrorNotice(agentName: string, msg: string): string {
  const detail = (msg || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `⚠️ I hit an error and couldn't finish that${detail ? ` — ${detail}` : ""}.\nIt's logged; try again, or send /new to start a fresh session.`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const shq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/** podman exec wrapper → { code, out (stdout+stderr) }. */
function px(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile("podman", args, { windowsHide: true, maxBuffer: 1 << 24 }, (err, so, se) =>
      resolve({
        code: err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0,
        out: (so?.toString() ?? "") + (se?.toString() ?? ""),
      }),
    ),
  );
}

/** Start the harness login headless inside the container and return the OAuth URL.
 * Detached so the login (and its PKCE verifier) survives until `submitCode`. */
export async function startHeadless(container: string, loginArgs: string[], deadlineMs = 25000): Promise<string> {
  if (loginArgs.length === 0) throw new Error("harness defines no login command");
  // `script` gives the TUI login a PTY; a held-open FIFO is its stdin (the code arrives later).
  const cmd = loginArgs.join(" ");
  const boot = `rm -f ${FIFO} ${LOG}; mkfifo ${FIFO}; (sleep 3600 > ${FIFO} &); exec script -qfc ${shq(cmd)} ${LOG} < ${FIFO}`;
  const started = await px(["exec", "-d", container, "sh", "-c", boot]);
  if (started.code !== 0) throw new Error(`auth: could not start login in "${container}": ${started.out.trim()}`);
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { out } = await px(["exec", container, "sh", "-c", `cat ${LOG} 2>/dev/null`]);
    const url = extractAuthUrl(out);
    if (url) return url;
    if (Date.now() > deadline) throw new Error("auth: login URL did not appear (is the agent's container running?)");
    await sleep(500);
  }
}

/** mtime (epoch secs) of a file in the container, or 0 if absent. */
async function credMtime(container: string, file?: string): Promise<number> {
  if (!file) return 0;
  const { out } = await px(["exec", container, "sh", "-c", `stat -c %Y ${shq(file)} 2>/dev/null || echo 0`]);
  return Number(out.trim()) || 0;
}

/** The headless login, as an OPERATION rather than a transport (roster-auth-remote). A local
 * (podman) agent and a remote (claude-code-http, k8s) agent expose the same two steps; only how we
 * reach the sandbox differs. The CLI talks to this, so `tonoman auth login --headless` reads the
 * same for both — the split stops being the operator's problem. */
export interface AuthOps {
  /** start the harness login in the agent's sandbox and return the OAuth URL */
  startHeadless(): Promise<string>;
  /** deliver the code; ok is OUTCOME-TRUE (the credential file actually changed) */
  submitCode(code: string): Promise<{ ok: boolean; status: string; loginTail: string }>;
}

/** LOCAL agents: drive the login through `podman exec` (the original roster-auth-headless path). */
export function podmanAuthOps(container: string, loginArgs: string[], statusArgs: string[], credFile?: string): AuthOps {
  return {
    startHeadless: () => startHeadless(container, loginArgs),
    submitCode: (code) => submitCode(container, statusArgs, code, credFile),
  };
}

/** REMOTE agents (k8s split): drive the login through the agent's OWN HTTP runtime. There is no
 * podman and no shared filesystem here — the agent is the only half holding `claude` and the
 * credential store, so it runs the PTY dance itself (same reason /usage lives agent-side).
 * We send only the CODE, never a command: the login argv comes from the agent's harness spec,
 * so this can never become a remote-exec primitive. */
export function httpAuthOps(baseUrl: string, token?: string): AuthOps {
  const base = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;

  const call = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON body → fall through to the status check with an empty object */
    }
    if (!res.ok) throw new Error(`auth: agent runtime said ${res.status} — ${String(parsed.error ?? text).slice(0, 200)}`);
    return parsed;
  };

  return {
    async startHeadless(): Promise<string> {
      const r = await call("/auth/login", {});
      const url = typeof r.url === "string" ? r.url : "";
      if (!url) throw new Error("auth: the agent runtime started a login but produced no URL");
      return url;
    },
    async submitCode(code: string): Promise<{ ok: boolean; status: string; loginTail: string }> {
      const r = await call("/auth/code", { code });
      return { ok: r.ok === true, status: String(r.status ?? ""), loginTail: String(r.loginTail ?? "") };
    },
  };
}

/** Deliver the authorization code to the waiting login, wait for the exchange, and verify
 * OUTCOME-TRUE: the credential file must actually be (re)written — `auth status` alone would
 * read "logged in" off a PRE-EXISTING credential and give a false ✓. */
export async function submitCode(
  container: string,
  statusArgs: string[],
  code: string,
  credFile?: string,
): Promise<{ ok: boolean; status: string; loginTail: string }> {
  const before = await credMtime(container, credFile);
  const w = await px(["exec", container, "sh", "-c", `printf '%s\\n' ${shq(code)} > ${FIFO}`]);
  if (w.code !== 0) throw new Error(`auth: no login in progress for "${container}" (run 'tonoman auth login ${container} --headless' first)`);
  await sleep(4500); // let the harness exchange the code + write creds
  const after = await credMtime(container, credFile);
  const status = statusArgs.length ? stripAnsi((await px(["exec", container, ...statusArgs])).out).trim() : "";
  const loginTail = stripAnsi((await px(["exec", container, "sh", "-c", `tail -c 400 ${LOG} 2>/dev/null`])).out).trim();
  await px(["exec", container, "sh", "-c", `rm -f ${FIFO} ${LOG}; pkill -f 'script -q' 2>/dev/null || true`]); // cleanup
  // The credential file was freshly (re)written AND status reports logged-in. If we have no
  // credFile to check, fall back to status alone (best available signal for that harness).
  const credChanged = credFile ? after > 0 && after > before : true;
  return { ok: credChanged && looksLoggedIn(status), status, loginTail };
}
