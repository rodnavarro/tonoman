// The Plaud login, done directly rather than through the CLI.
//
// The CLI was the obvious way in and it does not work here. Its login calls `open(url)` and only
// PRINTS the link when that call rejects; in a pod it neither opens anything nor rejects, so the
// link is generated, never shown, and the person is told the sign-in could not start. Replacing
// the bundled opener did not help — the resolve happens without executing anything.
//
// Every parameter it would have used is knowable, so we build the request ourselves: no
// subprocess, no output parsing, no browser assumption, and the PKCE verifier stays in our hands
// where the exchange needs it.
//
// Verified end to end against the live service, not inferred from reading a client:
//   • the consent screen renders and grants file metadata + audio
//   • the token endpoint takes FORM encoding (JSON answers 422 "field required", which reads
//     like a bad request rather than the wrong content type)
//   • refresh returns a fresh access token
//
// One thing is still borrowed: the client_id belongs to Plaud's own CLI, which is why the consent
// screen says "Plaud-CLI wants to access your workspace" instead of Tonoman. Our own registered
// client would fix the wording and allow a public redirect_uri, which would in turn remove the
// copy-and-paste step below. Both need Plaud to register us; neither needs code.

import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { homeFor } from "./plaudcli";
import { stamp, storeFor } from "./tokenstore";

const API_BASE = process.env.PLAUD_API_BASE ?? "https://platform.plaud.ai/developer/api";
const AUTH_URL = process.env.PLAUD_AUTH_URL ?? "https://web.plaud.ai/platform/oauth";
const TOKEN_URL =
  process.env.PLAUD_TOKEN_URL ?? "https://platform.plaud.ai/developer/api/oauth/third-party/access-token";
const CLIENT_ID = process.env.PLAUD_CLI_CLIENT_ID ?? "client_f9e0b214-c11f-434b-8b95-c4497d1feb81";
/** Fixed by the client we are borrowing. Nothing else is accepted for it. */
const REDIRECT_URI = "http://localhost:8199/auth/callback";

export interface Pending {
  url: string;
  verifier: string;
  state: string;
}

/** Where a half-finished login waits. On the volume, not in memory: connecting is two messages
 *  with a person's attention span in between, and a pod that restarts mid-login should not
 *  silently make their pasted code meaningless. */
function pendingPath(agent: string, user?: string, root?: string): string {
  return path.join(homeFor(agent, user, root), "pending-login.json");
}

/** Begin a login: the URL to put in front of the person, and the secret that finishes it. */
export async function begin(agent: string, user?: string, root?: string): Promise<Pending> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString()}`;

  const p: Pending = { url, verifier, state };
  await fsp.mkdir(homeFor(agent, user, root), { recursive: true });
  await fsp.writeFile(pendingPath(agent, user, root), JSON.stringify(p), "utf8");
  return p;
}

/** The authorization code out of whatever the person pasted — the whole address bar, or just the
 *  query, because people paste what they have. */
export function codeFrom(pasted: string): { code?: string; state?: string } {
  const t = (pasted ?? "").trim().replace(/^<|>$/g, "");
  const q = t.includes("?") ? t.slice(t.indexOf("?") + 1) : t;
  const p = new URLSearchParams(q);
  return { code: p.get("code") ?? undefined, state: p.get("state") ?? undefined };
}

export interface Finished {
  ok: boolean;
  /** Why not, in words the person can act on. */
  problem?: string;
}

/** Disconnect: forget this agent's tokens and tell Plaud to revoke them.
 *
 *  Local first, and revocation best-effort. If the network call fails we have still stopped reading
 *  the account, which is the part the person asked for; a disconnect that refuses because a remote
 *  call failed leaves them connected to something they just said to drop. */
export async function disconnect(agent: string, user?: string, root?: string): Promise<void> {
  const token = await storeFor(root)
    .load(agent, user)
    .then((t) => t?.access_token)
    .catch(() => undefined);
  await storeFor(root).clear(agent, user);
  await fsp.rm(pendingPath(agent, user, root), { force: true }).catch(() => {});
  if (!token) return;
  await fetch(`${API_BASE}/open/third-party/users/current/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});
}

/** Finish a login with the pasted callback, and store the tokens where the poll reads them. */
export async function complete(agent: string, pasted: string, user?: string, root?: string): Promise<Finished> {
  const { code, state } = codeFrom(pasted);
  if (!code) return { ok: false, problem: "that address has no `code=` in it — paste the whole thing" };

  let pending: Pending | undefined;
  try {
    pending = JSON.parse(await fsp.readFile(pendingPath(agent, user, root), "utf8")) as Pending;
  } catch {
    return { ok: false, problem: "I don't have a sign-in waiting — start again with `!connect plaud`" };
  }
  // The state is what stops a code from somewhere else being pasted in here, deliberately or by
  // accident. It is cheap to check and the only thing standing between a stray link and a
  // connected account.
  if (state && pending.state && state !== pending.state) {
    return { ok: false, problem: "that address is from a different sign-in — run `!connect plaud` and use the newest link" };
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
      state: pending.state,
      client_id: CLIENT_ID,
    }),
  }).catch(() => undefined);

  if (!res) return { ok: false, problem: "I couldn't reach Plaud to finish the sign-in" };
  if (!res.ok) {
    // Codes are single-use and short-lived, which is the overwhelmingly likely reason.
    return {
      ok: false,
      problem:
        res.status === 400 || res.status === 401
          ? "Plaud wouldn't accept that code — they expire quickly and only work once. `!connect plaud` for a fresh link"
          : `Plaud answered ${res.status}`,
    };
  }

  // Named `granted` rather than `tokens`, which is now the store.
  const granted = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!granted.access_token) return { ok: false, problem: "Plaud's answer had no access token in it" };

  // Storing is allowed to fail loudly. Reporting a connection that was not persisted is worse
  // than reporting a failure: the person believes they are done, and nothing ever polls.
  try {
    await storeFor(root).save(agent, stamp(granted), user);
  } catch (e) {
    return { ok: false, problem: `I signed in but couldn't store the credential — ${(e as Error).message}` };
  }
  // The pending secret has done its job; leaving it lying about serves nobody.
  await fsp.rm(pendingPath(agent, user, root), { force: true }).catch(() => {});
  return { ok: true };
}
