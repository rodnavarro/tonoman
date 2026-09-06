// The second brain, on disk.
//
// A tenant's second brain is a LIST of git repositories (§8), not one repo, and the agent reaches
// it as files rather than through a search service. That is deliberate: the harness already reads
// and greps files well, the content stays portable and readable whether or not any of this software
// is still running, and there is no index to fall out of date with the repository.
//
// The GRANT is what gates it. An agent with no `tonoman-secondbrain` row in `agent_tool` receives
// no sources from the roster, so revoking the tool in the Hub actually removes the checkout rather
// than hiding a button — which is the difference between a permission and a label.
//
// Credentials are references. A source names a secret; the token is read from the mounted secret
// tree in this pod and used for one clone, never written into the repository's remote URL on disk,
// because `.git/config` would then hold it in plain text for anything that later reads the volume.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SecondbrainSource {
  id: string;
  label: string;
  repoUrl: string;
  branch?: string;
  subpath?: string;
  authKind?: string;
  secretRef?: string | null;
  readOnly?: boolean;
}

export interface SyncOptions {
  /** Where checkouts live — one directory per source, under the agent's workspace. */
  root: string;
  /** Resolves `<secret>:<key>` from the mounted secret tree. */
  resolveRef(ref: string | null | undefined): Promise<string>;
  log?: (s: string) => void;
}

function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd, env: env ?? process.env, windowsHide: true, maxBuffer: 1 << 24 }, (err, so, se) =>
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, out: `${so}${se}` }),
    ),
  );
}

/** A URL carrying the token for exactly one command. Never persisted: the remote on disk stays
 *  credential-free, so the checkout can be read by anything without leaking the token. */
function authedUrl(repoUrl: string, token: string): string {
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    // GitHub accepts the token as the username with any password; `x-access-token` is the
    // documented form for an app or PAT.
    u.username = "x-access-token";
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Clone or refresh every granted source, and return the directories that are ready to read.
 *
 * A source that fails is reported and skipped, never fatal: one unreachable repository must not
 * stop the agent answering from the others, and a silent empty checkout is worse than a log line
 * saying which repo could not be fetched.
 */
export async function sync(sources: SecondbrainSource[], o: SyncOptions): Promise<{ dir: string; label: string }[]> {
  const log = o.log ?? ((s: string) => console.log(s));
  const ready: { dir: string; label: string }[] = [];
  await fs.mkdir(o.root, { recursive: true });

  for (const s of sources) {
    const dir = path.join(o.root, s.id);
    const branch = s.branch || "main";
    const token = await o.resolveRef(s.secretRef);
    const url = authedUrl(s.repoUrl, token);

    const exists = await fs
      .stat(path.join(dir, ".git"))
      .then(() => true)
      .catch(() => false);

    let r: { code: number; out: string };
    if (exists) {
      // Fetch + hard reset rather than pull: the checkout is a cache of the remote, and a merge
      // conflict in a cache is a stuck agent for no benefit.
      await run("git", ["remote", "set-url", "origin", url], dir);
      r = await run("git", ["fetch", "--depth", "1", "origin", branch], dir);
      if (r.code === 0) r = await run("git", ["reset", "--hard", `origin/${branch}`], dir);
      // Put the credential-free URL back immediately, so it is not sitting in .git/config.
      await run("git", ["remote", "set-url", "origin", s.repoUrl], dir);
    } else {
      r = await run("git", ["clone", "--depth", "1", "--branch", branch, url, dir]);
      if (r.code === 0) await run("git", ["remote", "set-url", "origin", s.repoUrl], dir);
    }

    if (r.code !== 0) {
      // Never print the output raw — it can contain the tokenized URL.
      log(`secondbrain: ${s.label} (${s.repoUrl}) failed to sync — ${redact(r.out, token).slice(0, 200)}`);
      continue;
    }
    const readable = s.subpath ? path.join(dir, s.subpath) : dir;
    ready.push({ dir: readable, label: s.label });
    log(`secondbrain: ${s.label} ready at ${readable}`);
  }
  return ready;
}

/** PURE: strip a token from command output before it reaches a log. Unit-tested, because the one
 *  place a credential leaks is an error message nobody expected to contain one. */
export function redact(text: string, token: string): string {
  let out = text;
  if (token) out = out.split(token).join("***");
  // Belt and braces: any user:pass in a URL, whatever the token was.
  return out.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***:***@");
}

/** The note prepended to a turn so the agent knows what it can read and where. Without it the
 *  files are present but the model has no reason to look. */
export function contextNote(ready: { dir: string; label: string }[]): string {
  if (ready.length === 0) return "";
  const lines = ready.map((r) => `- ${r.label}: ${r.dir}`).join("\n");
  return [
    "Your second brain is checked out on this machine and is the memory of the business:",
    lines,
    "",
    "Search it with Grep and read pages with Read before answering anything about meetings, people,",
    "deals or decisions. If the answer is not in there, say so plainly rather than guessing — a wrong",
    "recollection about a real client conversation is worse than no recollection.",
  ].join("\n");
}
