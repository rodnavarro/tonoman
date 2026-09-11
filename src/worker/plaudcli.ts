// Connecting a Plaud account, as the person whose account it is.
//
// What this replaces: a bearer token scraped out of Rod's browser devtools, valid for 24 hours,
// renewed by a scheduled task driving headless Chrome against a saved Google session on his
// laptop. That works exactly as long as one particular machine is awake, and it cannot be handed
// to a customer at all — "log in again every morning, and also I keep your Google session" is not
// an onboarding step.
//
// The official CLI issues OAuth tokens that last about 300 days and renew themselves. Its login
// prints a URL. A URL is something an agent can put in front of a person in Slack, which is the
// whole reason this file exists: the person clicks it, signs in to their own Plaud account, and
// the tokens land in a directory this tenant owns.

import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Where one agent's Plaud tokens live. Per agent, on the volume — the same rule as every other
 *  credential here: whose account this is, is a fact about the tenant. */
export function homeFor(agent: string, user?: string, root?: string): string {
  const base = path.join(root ?? process.env.TONOMAN_STATE_ROOT ?? "/root/.tonoman", "plaud", encodeURIComponent(agent));
  // A member's home is nested under the agent's; the shared account (no user) keeps the exact path
  // it always had, so nothing on the volume moves for a tenant that has not gone per-person.
  return user ? path.join(base, "users", encodeURIComponent(user)) : base;
}

/** The first URL the CLI prints. It offers to open a browser and, failing that, tells the person
 *  to open the link themselves — which is the case we are always in, since this runs in a pod. */
export function loginUrl(output: string): string | undefined {
  return /\bhttps:\/\/[^\s<>"')\]]+/.exec(output)?.[0];
}

/** A user code, when the flow shows one alongside the URL. Device-code flows print a short
 *  hyphenated code; authorization-code flows print only a link. We surface it when it is there
 *  rather than assuming which flow this is. */
export function loginCode(output: string): string | undefined {
  return /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
}

export interface Started {
  /** The link to put in front of the person. */
  url: string;
  /** Shown next to the link when the flow uses one. */
  code?: string;
  /** Resolves when the CLI exits: true if the login completed. */
  done: Promise<boolean>;
}

export interface RunOpts {
  agent: string;
  /** The member connecting their own account, when per-person; absent for the shared account. */
  user?: string;
  root?: string;
  /** Overridable so tests do not need the real CLI on PATH. */
  bin?: string;
  /** How long to wait for the URL before giving up on a CLI that is not going to print one. */
  urlTimeoutMs?: number;
  /** How long the person has to finish signing in. */
  loginTimeoutMs?: number;
}

/** Start `plaud login` and hand back the URL as soon as it appears.
 *
 *  Deliberately NOT await-the-whole-login: the login cannot finish until somebody opens the link,
 *  and nobody can open a link that is still inside a process we have not read yet. So the URL is
 *  returned early and the completion is a promise the caller can settle later.
 *
 *  HOME is pointed at this agent's own directory, because the CLI writes ~/.plaud/tokens.json and
 *  one pod runs every agent this worker has. Sharing a home would mean the second person to
 *  connect replaces the first — which is the bug we just finished removing from the old
 *  credential, and it would be a shame to reintroduce it here. */
export async function startLogin(o: RunOpts): Promise<Started> {
  const home = homeFor(o.agent, o.user, o.root);
  await fsp.mkdir(home, { recursive: true });

  // The CLI opens a browser and only PRINTS the URL when opening fails:
  //     open(url).catch(() => console.log("Could not open browser. Open this URL manually: ..."))
  // In a pod that call succeeds against nothing, so the link is generated, never shown, and the
  // person is told the sign-in could not start. Rather than depend on a failure, we give it an
  // opener that prints — which is what "open a browser" honestly means on a machine with no
  // screen, and is how the CLI's own docs describe using it on a headless server.
  const bin = path.join(home, "bin");
  await fsp.mkdir(bin, { recursive: true });
  const shim = path.join(bin, "xdg-open");
  const script = ["#!/bin/sh", 'echo "PLAUD_OPEN $1"'].join("\n") + "\n";
  await fsp.writeFile(shim, script, { mode: 0o755 });
  await fsp.chmod(shim, 0o755).catch(() => {});

  const child = spawn(o.bin ?? "plaud", ["login"], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let seen = "";
  let settle: ((s: Started) => void) | undefined;
  const first = new Promise<Started>((res) => (settle = res));
  let finished: ((ok: boolean) => void) | undefined;
  const done = new Promise<boolean>((res) => (finished = res));

  const read = (chunk: Buffer): void => {
    seen += chunk.toString();
    const url = loginUrl(seen);
    if (url && settle) {
      const s = settle;
      settle = undefined;
      s({ url, code: loginCode(seen), done });
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.on("close", (code) => finished?.(code === 0));
  child.on("error", () => finished?.(false));

  // Give up rather than hang forever on a CLI that is missing or silent — a person waiting on a
  // link deserves to be told it is not coming.
  const timer = setTimeout(() => {
    if (settle) {
      child.kill();
      settle({ url: "", done: Promise.resolve(false) });
      settle = undefined;
    }
  }, o.urlTimeoutMs ?? 30_000);
  const kill = setTimeout(() => child.kill(), o.loginTimeoutMs ?? 15 * 60_000);
  void done.then(() => {
    clearTimeout(timer);
    clearTimeout(kill);
  });

  return first;
}

/** The CLI's redirect_uri is hardcoded to http://localhost:8199/auth/callback, and it is the
 *  LOGIN PROCESS that listens there — inside this pod. The person signing in is somewhere else
 *  entirely, so their browser lands on a page that cannot load, with the authorization code
 *  sitting in the address bar.
 *
 *  That dead URL is the code delivery mechanism. They paste it back, and we replay it against the
 *  listener that has been waiting for it all along, which finishes the PKCE exchange and writes
 *  the tokens. It is the same shape as the Claude login already in use here: link out, code in.
 *
 *  Accepts the whole URL or just the query, because people paste what they have. */
export function callbackUrl(pasted: string): string | undefined {
  const t = (pasted ?? "").trim().replace(/^<|>$/g, "");
  const q = t.includes("?") ? t.slice(t.indexOf("?") + 1) : t;
  const p = new URLSearchParams(q);
  if (!p.get("code")) return undefined;
  return `http://127.0.0.1:${CALLBACK_PORT}/auth/callback?${p.toString()}`;
}

/** Fixed by the CLI; a login cannot use any other port. */
export const CALLBACK_PORT = 8199;

/** Hand the pasted code to the waiting login process. */
export async function completeLogin(pasted: string): Promise<boolean> {
  const url = callbackUrl(pasted);
  if (!url) return false;
  try {
    const r = await fetch(url, { redirect: "manual" });
    // Any answer at all means the listener took it; the login process decides the rest and we
    // learn the outcome from its exit, not from this response.
    return r.status > 0;
  } catch {
    return false;
  }
}

/** Has this agent connected a Plaud account? Whatever holds the tokens is the only authority — a
 *  row saying "connected" that the credential disagrees with would be worse than no row.
 *
 *  A store that THROWS is not "no": a 500 from a failed decrypt means there is a credential we
 *  could not read, and answering false would offer to reconnect an account that is connected —
 *  and then overwrite it. Undefined is no, an error is an error. */
export async function connected(agent: string, user?: string, root?: string): Promise<boolean> {
  const { storeFor } = await import("./tokenstore");
  return Boolean(await storeFor(root).load(agent, user));
}
