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
import type { HarnessKind } from "./harness";

const FIFO = "/tmp/tonoman-auth.fifo";
const LOG = "/tmp/tonoman-auth.log";

/** PURE: pull the OAuth URL out of a captured (ANSI/cursor-laden) login transcript. The PTY
 * wraps the URL across lines and the "Paste code here" prompt can concatenate onto the end,
 * so we strip escapes, join, regex the claude URL, and trim at the prompt. Unit-tested. */
export function extractAuthUrl(raw: string): string | undefined {
  const t = stripControl(raw);
  const joined = t.replace(/\n/g, "");
  const m = joined.match(/https:\/\/[a-z.]*claude\.com\/[A-Za-z0-9%._~:/?#[\]@!$&()*+,;=-]+/);
  if (!m) return undefined;
  let url = m[0];
  const cut = url.indexOf("Paste"); // the prompt text can run onto the state param
  if (cut > 0) url = url.slice(0, cut);
  return url;
}

/** Whether an `auth status` output reports a logged-in session (harness-agnostic-ish).
 *
 *  THE NEGATION IS CHECKED FIRST, and that is not a nicety. `codex login status` prints exactly
 *  `Not logged in` when it is not — which the positive `\blogged in\b` match reads as a yes. So a
 *  codex agent with an empty credential home would report "signed in", `/auth/status` would answer
 *  `loggedIn: true`, and the one thing this function exists to decide comes out backwards. Claude's
 *  JSON form (`"loggedIn": false`) never reached the prose branch, which is why it went unnoticed.
 *
 *  Observed strings (codex-cli 0.154): `Not logged in` / `Logged in using ChatGPT`. */
export function looksLoggedIn(statusOut: string): boolean {
  const t = stripAnsi(statusOut || "");
  if (/"loggedIn"\s*:\s*false/i.test(t)) return false;
  if (/\bnot (logged|signed) ?in\b/i.test(t)) return false;
  return /"loggedIn"\s*:\s*true/i.test(t) || /\b(logged|signed) in\b/i.test(t);
}

/** PURE: the verification URL AND the one-time code out of a `codex login --device-auth`
 *  transcript — the codex counterpart of `extractAuthUrl`.
 *
 *  Device auth is a different shape from Claude's paste-the-code flow: the CLI prints a URL and a
 *  short code, the person enters the code on OpenAI's page, and the CLI POLLS until the exchange
 *  completes. Nothing comes back through us, so there is no `/auth/code` step — only these two
 *  strings to put in front of somebody, and then waiting.
 *
 *  The code is anchored on its LABEL ("one-time code"), not on its shape: `JLEP-DT273` is one
 *  observation, "the line after the label" is the structure. Verbatim output (codex-cli 0.154,
 *  captured from a PLAIN PIPE — device auth needs no PTY, though the PTY path captures the same
 *  bytes with colour escapes around them):
 *
 *      1. Open this link in your browser and sign in to your account
 *         https://auth.openai.com/codex/device
 *
 *      2. Enter this one-time code (expires in 15 minutes)
 *         JLEP-DT273
 */
export function extractDeviceAuth(raw: string): { url: string; code: string } | undefined {
  const t = stripControl(raw);
  const lines = t.split("\n").map((l) => l.trim());
  // The URL sits alone on its own line. A narrow PTY can still wrap it, so the continuation lines
  // are glued back on — but only while they are BARE tokens (no spaces, not a new numbered step,
  // not a second URL). Joining the whole transcript the way the Claude extractor does would run
  // "…/device" straight into the "2." of the next step, since both are legal URL characters.
  let url: string | undefined;
  const at0 = lines.findIndex((l) => /^https:\/\/\S+$/.test(l));
  if (at0 >= 0) {
    url = lines[at0];
    for (let i = at0 + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l || /\s/.test(l) || /^\d+\./.test(l) || /^https:\/\//.test(l)) break;
      url += l;
    }
  }
  if (!url) return undefined;
  // The code: the first non-empty line AFTER the label. Taken this way round so a change to the
  // code's alphabet or length costs nothing, and no stray token in the banner is mistaken for it.
  const at = lines.findIndex((l) => /one-?time code/i.test(l));
  if (at < 0) return undefined;
  const code = lines.slice(at + 1).find((l) => l.length > 0);
  if (!code || /\s/.test(code)) return undefined;
  return { url, code };
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
// Re-exported rather than defined here: a Temporal workflow is bundled with no Node built-ins,
// and this file imports `node:child_process` to drive the harness. A workflow importing it fails
// the webpack build with `Module not found: node:child_process` and the worker never starts —
// which presents as a hang, not as a bad import. Definitions live in `turnfailure.ts`.
export { isNotLoggedInError, notLoggedInNotice } from "./turnfailure";

export function turnErrorNotice(agentName: string, msg: string): string {
  const detail = (msg || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `⚠️ I hit an error and couldn't finish that${detail ? ` — ${detail}` : ""}.\nIt's logged; try again, or send /new to start a fresh session.`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

/** Every escape a PTY transcript carries — OSC, single-char, CSI — plus carriage returns. Shared by
 *  both extractors so one harness's transcript is cleaned exactly like the other's. */
function stripControl(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC
    .replace(/\x1b[@-Z\\-_]/g, "") // single-char escapes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (cursor moves, colors)
    .replace(/\r/g, "");
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
  /** Start the harness login in the agent's sandbox and return what the person has to act on.
   *
   *  `code` is set ONLY by a device-auth harness (codex). The two flows run opposite directions:
   *  Claude prints a URL and expects a code BACK from the person (`submitCode`); codex prints a URL
   *  AND a code and expects the person to enter OUR code on the provider's page while the CLI
   *  polls. So a `code` here means "show them this, then wait" — never "ask them for one". */
  startHeadless(): Promise<{ url: string; code?: string }>;
  /** deliver the code; ok is OUTCOME-TRUE (the credential file actually changed) */
  submitCode(code: string): Promise<{ ok: boolean; status: string; loginTail: string }>;
  /** optional: what the harness reports about the credential in use — which account, which plan.
   *  Optional because not every transport can ask; callers show what they get and nothing more. */
  status?(): Promise<string>;
  /** Device auth only: has the login this `startHeadless` began actually completed? Polled, because
   *  nothing comes back through us to tell us. Judged the same way `submitCode` judges a pasted
   *  code — OUTCOME-TRUE, the credential file moved AND the harness agrees. */
  pending?(): Promise<{ done: boolean; loggedIn: boolean; status: string }>;
}

/** LOCAL agents: drive the login through `podman exec` (the original roster-auth-headless path). */
export function podmanAuthOps(container: string, loginArgs: string[], statusArgs: string[], credFile?: string): AuthOps {
  return {
    // No `code`: the podman path drives the Claude paste-a-code flow only. A device-auth harness
    // reaches its runtime over HTTP, which is where the second string is read.
    startHeadless: async () => ({ url: await startHeadless(container, loginArgs) }),
    submitCode: (code) => submitCode(container, statusArgs, code, credFile),
  };
}

/** PURE: what actually went wrong, when `fetch` refuses to say.
 *
 *  Node's fetch throws a bare `TypeError("fetch failed")` for every transport problem and hides the
 *  real reason in `cause`. Unwrapped, that reached a person in Slack as
 *  "I need an inference login, but I couldn't start one - fetch failed", which names neither what
 *  was unreachable nor even that anything was: a connection refused, a DNS miss and a TLS failure
 *  all read identically, and all read like a bug in the login rather than a missing process.
 *
 *  `cause` is sometimes an AggregateError - several addresses tried, IPv6 first - and its own
 *  `code` is undefined, so reading `cause.code` alone would ship "fetch failed - undefined", which
 *  is worse than what it replaced. Hence the walk: the first error carrying a code wins, and the
 *  URL is named either way, because "which address" is half of what makes this actionable. */
export function transportFailure(e: unknown, base: string): string {
  const codes: string[] = [];
  const messages: string[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== "object" || depth > 4) return;
    const err = x as { code?: unknown; errors?: unknown; cause?: unknown; message?: unknown };
    if (typeof err.code === "string") codes.push(err.code);
    // "fetch failed" is the wrapper's own message and never the reason, so it is dropped here
    // rather than allowed to win by being outermost.
    if (typeof err.message === "string" && err.message && err.message !== "fetch failed") messages.push(err.message);
    if (Array.isArray(err.errors)) for (const sub of err.errors) walk(sub, depth + 1);
    walk(err.cause, depth + 1);
  };
  walk(e, 0);
  // A code when there is one; otherwise the DEEPEST message, which is the one closest to the
  // actual syscall - undici's "bad port" beats the "fetch failed" wrapped around it.
  const why = codes[0] || messages[messages.length - 1] || (e instanceof Error && e.message) || "unknown error";
  return `couldn't reach the agent runtime at ${base} (${why})`;
}

/** REMOTE agents (k8s split): drive the login through the agent's OWN HTTP runtime. There is no
 * podman and no shared filesystem here — the agent is the only half holding `claude` and the
 * credential store, so it runs the PTY dance itself (same reason /usage lives agent-side).
 * We send only the CODE, never a command: the login argv comes from the agent's harness spec,
 * so this can never become a remote-exec primitive. */
export function httpAuthOps(
  baseUrl: string,
  token?: string,
  agent?: string,
  user?: string,
  /** WHICH provider's login this is (W1). One runtime holds both CLIs and both credential stores,
   *  so an unqualified call runs whatever the pod's TONOMAN_HARNESS happens to say — which for an
   *  agent configured the other way signs the person into the wrong account and then reports it as
   *  a success. Rides the QUERY STRING for the same reason `agent` does: the runtime reads the URL. */
  harness?: HarnessKind,
  /** The turn's user this login belongs to (turn-user.md in Tonoman Cloud), asked of the Cloud by the
   *  worker and sent on every call, so the service starts the provider's program as that user, in
   *  that user's home. Absent on a self-hosted gateway. */
  uidOf?: () => Promise<number | { uid: number; of?: "person" | "agent" } | undefined>,
): AuthOps {
  const base = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;

  const call = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    let res: Response;
    // Never guessed: when the worker says turns run as their own users and the number cannot be had,
    // the call fails rather than sign someone in as the service itself.
    // With WHOSE user it is (`of`), so the service brings home the same old login the worker would.
    const who = uidOf ? await uidOf() : undefined;
    const uid = typeof who === "object" ? who.uid : who;
    const of = typeof who === "object" && who.of ? `&of=${who.of}` : "";
    const url = uid === undefined ? `${base}${path}` : `${base}${path}${path.includes("?") ? "&" : "?"}uid=${uid}${of}`;
    try {
      res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // TRANSPORT failure, which is a different thing from the runtime answering badly - and the
      // one this function used to let through unexplained. See transportFailure().
      throw new Error(transportFailure(e, base));
    }
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

  // Whose subscription this login is for. One runtime serves every agent in a pool, so a login
  // that does not say who it belongs to lands in a shared directory and the last person to sign
  // in owns them all.
  //
  // On the QUERY STRING, not only in the body. Sent in the body alone the runtime never saw it —
  // its login handler reads the URL, not the payload — so the name was silently dropped and the
  // credential went to the shared home anyway. The endpoint reported success, because the login
  // HAD succeeded; it just belonged to the wrong agent. Both are sent now: the query is what is
  // read, the body costs nothing and keeps the two halves honest if the handler ever changes.
  // `user` rides alongside `agent` — the per-person login dir when the agent runs inference per
  // person. Same query-string rule and the same reason: the runtime reads it off the URL.
  const params = new URLSearchParams();
  if (agent) params.set("agent", agent);
  if (user) params.set("user", user);
  if (harness) params.set("harness", harness);
  const q = params.toString() ? `?${params.toString()}` : "";
  const who = { ...(agent ? { agent } : {}), ...(user ? { user } : {}), ...(harness ? { harness } : {}) };

  return {
    async startHeadless(): Promise<{ url: string; code?: string }> {
      const r = await call(`/auth/login${q}`, who);
      const url = typeof r.url === "string" ? r.url : "";
      if (!url) throw new Error("auth: the agent runtime started a login but produced no URL");
      // Device auth answers with both; the paste-a-code flow answers with a URL alone.
      const code = typeof r.code === "string" && r.code ? r.code : undefined;
      return { url, code };
    },
    /** Device auth (codex): has the login finished on the provider's side yet? */
    async pending(): Promise<{ done: boolean; loggedIn: boolean; status: string }> {
      const r = await call(`/auth/pending${q}`);
      return { done: r.done === true, loggedIn: r.loggedIn === true, status: String(r.status ?? "") };
    },
    /** What the harness reports for THIS agent (and person, if per-user): which account, which plan. */
    async status(): Promise<string> {
      const r = await call(`/auth/status${q}`);
      return String(r.status ?? "");
    },
    async submitCode(code: string): Promise<{ ok: boolean; status: string; loginTail: string }> {
      const r = await call(`/auth/code${q}`, { code, ...who });
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
