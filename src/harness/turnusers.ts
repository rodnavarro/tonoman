// Whose Linux user a run goes out as, and handing that user what the worker made for it
// (docs/definition/objects/turn-user.md in Tonoman Cloud).
//
// The Cloud decides whose user it is (TURNUSER-WHOSE, TURNUSER-NUMBER-FROM-CLOUD); the worker asks,
// every time, makes that user, and refuses to run when it cannot — it never falls back to its own
// user (TURNUSER-NOTHING-AS-ROOT).
//
// The worker is root, and a user's home is the user's to arrange — it can put a link where a folder
// was. So the worker never writes, re-owns or deletes by a path inside a home
// (TURNUSER-ROOT-STAYS-OUT): what a home needs is done AS that user, and what the worker prepares
// for it is prepared where only the worker can reach, and handed over before the user can touch it.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { asTheUser, asUser, giveFresh, loginAsUser, looksLikeLogin, ownFolders, shareForCopy, type TurnUser } from "./launch";

/** Whose user it is: a person's own, or the agent's (a shared login, someone the tenant does not
 *  know, unattended work). It decides which old login, if any, may be brought into that home. */
export type TurnUserOf = TurnUser & { of: "person" | "agent" };

export interface TurnUsersOptions {
  /** The Cloud's address and the worker's system token. */
  api: string;
  token: string;
  fetch?: typeof fetch;
  /** Make (and prove) the user with this number. The launcher's `asUser` unless a test says otherwise. */
  make?: (uid: number) => Promise<TurnUser>;
  log?: (s: string) => void;
}

/** Copy a login's files and folders — and nothing else: a link, a device or a socket is left behind,
 *  so what a link pointed at is never copied into anyone's home. Returns how many files were copied. */
export async function copyLogin(from: string, to: string): Promise<number> {
  let n = 0;
  await fs.mkdir(to, { recursive: true, mode: 0o700 });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) n += await copyLogin(src, dst);
    else if (e.isFile()) {
      await fs.copyFile(src, dst);
      n++;
    }
  }
  return n;
}

/** One at a time, across processes: the worker and the sign-in service share the homes, and both
 *  bring logins home. The lock is the KERNEL's (`flock`), on a file in a folder only root can reach:
 *  it is held by a small program for as long as this one keeps that program's input open, so it is
 *  let go the moment this process ends, however it ends — there is no stale lock to judge, no taking
 *  one over, and so no way for two to hold it. (Judging staleness by a file's age could not be made
 *  safe: two takers can both decide a lock is dead, and the second then removes the first one's
 *  fresh lock.) Where there is no `flock` — not Linux: a developer's machine, the tests — it is one
 *  at a time within this process, which is all there is there. */
const inProcess = new Map<string, Promise<unknown>>();
export async function locked<T>(root: string, name: string, fn: () => Promise<T>, waitMs = 120_000): Promise<T> {
  const dir = path.join(root, ".locks");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120));
  if (process.platform !== "linux") {
    const before = inProcess.get(file) ?? Promise.resolve();
    const mine = before.catch(() => {}).then(fn);
    const tail = mine.catch(() => {});
    inProcess.set(file, tail);
    void tail.then(() => inProcess.get(file) === tail && inProcess.delete(file));
    return mine;
  }
  // `-w`: give up rather than wait for ever. It says "held" once it has the lock, then waits for its
  // input to close — which it does when we say so, or when this process is gone.
  const holder = spawn("flock", ["-x", "-w", String(Math.ceil(waitMs / 1000)), file, "sh", "-c", "echo held; read _ || true"], { stdio: ["pipe", "pipe", "ignore"] });
  const letGo = (): void => {
    holder.stdin?.end();
    holder.kill("SIGKILL"); // its own child of root's, not yet reaped: the number is still its own
  };
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(code === 1 ? "another move of this login never finished" : `the lock could not be taken (${code})`)));
      holder.stdout?.once("data", () => resolve());
    });
  } catch (e) {
    letGo();
    throw e;
  }
  try {
    return await fn();
  } finally {
    letGo();
  }
}

// Both run AS the user, inside its own home, under the lock.
//
// PREPARE copies the old login (a copy only this user can read, and cannot change) WHOLE into a
// folder of its own beside where logins live. If the home holds nothing yet, that is all: the folder
// is put in place later, by one rename — which fails, rather than replace anything, if the home has
// come to hold something by then. If the home already holds something, everything of the old login
// EXCEPT the login itself goes in now: folders are made where they are missing, and each file is
// put in place by a hard link — which appears whole or not at all, and FAILS if the name is taken:
// there is no moment between looking and placing in which something written meanwhile could be
// replaced. The home's own stays as it is, and nothing is moved out of the way. Cut short anywhere,
// there is still no login at home, the home is as it was or fuller, and the move is done again.
const PREPARE = [
  "umask 077",
  'src="$1"; dst="$2"; cred="$3"; tmp="$2.incoming"',
  'fail() { rm -rf -- "$tmp"; exit 1; }',
  'rm -rf -- "$tmp"',
  'mkdir -p -- "$(dirname -- "$dst")" || exit 1',
  'cp -R -- "$src" "$tmp" || fail',
  '[ -f "$tmp/$cred" ] && [ ! -L "$tmp/$cred" ] || fail',
  'if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then echo whole; exit 0; fi',
  '[ -d "$dst" ] && [ ! -L "$dst" ] || fail',
  'if [ -z "$(ls -A -- "$dst")" ]; then echo whole; exit 0; fi',
  "merge() {",
  "  local e n",
  '  for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do',
  '    if [ ! -e "$e" ] && [ ! -L "$e" ]; then continue; fi',
  '    n="${e##*/}"',
  '    if [ "$2" = "$dst" ] && [ "$n" = "$cred" ]; then continue; fi',
  '    if [ -d "$e" ] && [ ! -L "$e" ]; then',
  // A folder: made if the name is free (mkdir fails if it is not), gone into if it is a folder.
  '      mkdir -- "$2/$n" 2>/dev/null',
  '      if [ -d "$2/$n" ] && [ ! -L "$2/$n" ]; then merge "$e" "$2/$n" || return 1; fi',
  "      continue",
  "    fi",
  // A file: linked into place, or — the name being taken — left, the home's own staying as it is.
  '    ln -- "$e" "$2/$n" 2>/dev/null || [ -e "$2/$n" ] || [ -L "$2/$n" ] || return 1',
  "  done",
  "}",
  'merge "$tmp" "$dst" || fail',
  "echo merged",
].join("\n");

// FINISH puts the login itself in place, LAST — it is what says "a login is home" — and only if what
// is at home is still exactly what was LOOKED AT and judged not to be a login (`was`, from the one
// look `loginAsUser` took): one written meanwhile is the one that stays (`kept`). By rename, so it
// appears whole or not at all; a rename replaces a link put there rather than writing through it.
// What was there and was no login is kept beside it, under a name that was free: by a hard link,
// which fails rather than replace, or for what is not a plain file a no-replace move.
const FINISH = [
  'dst="$1"; cred="$2"; was="$3"; how="$4"; tmp="$1.incoming"; f="$1/$2"',
  'fail() { rm -rf -- "$tmp"; exit 1; }',
  'if [ ! -e "$f" ] && [ ! -L "$f" ]; then now=none',
  'elif [ -L "$f" ]; then now="other:link:$(readlink -- "$f")"',
  'elif [ ! -f "$f" ]; then now=other:not-a-file',
  'else h=$(sha256sum < "$f" | cut -d" " -f1); if [ -n "$h" ]; then now="file:$h"; else now=unknown; fi; fi',
  'if [ "$now" != "$was" ]; then rm -rf -- "$tmp"; echo kept; exit 0; fi',
  'if [ "$how" = whole ]; then mv -T -- "$tmp" "$dst" || fail; echo brought; exit 0; fi',
  'if [ "$now" != none ]; then',
  "  i=0; kept=",
  '  while [ "$i" -lt 20 ]; do',
  '    aside="$f.not-a-login.$(date +%s).$$.$i"',
  '    if [ -f "$f" ] && [ ! -L "$f" ]; then ln -- "$f" "$aside" 2>/dev/null && kept=1 && break',
  '    else mv -n -T -- "$f" "$aside" 2>/dev/null; if [ ! -e "$f" ] && [ ! -L "$f" ]; then kept=1; break; fi; fi',
  "    i=$((i+1))",
  "  done",
  '  [ -n "$kept" ] || fail',
  "fi",
  'mv -T -- "$tmp/$cred" "$f" || fail',
  'rm -rf -- "$tmp"',
  "echo brought",
].join("\n");

/** Bring a login kept where logins used to live into its user's home, once (TURNUSER-MOVE-ONCE-SAFELY).
 *  "Already home" means a LOGIN is there (`looksLikeLogin`) — not any file: a status check run in a
 *  fresh home leaves the provider's own state files behind, and a sign-in cut short leaves an empty
 *  credential; neither is a login, and neither stands in the way of the real one.
 *
 *  Root copies the old login (root's own files) into a staging folder only root can write, and lets
 *  the user READ that copy. Everything inside the home is done AS THE USER (`PREPARE`, `FINISH`), and
 *  whether the home has a login is asked AGAIN between the two, so one signed in while the copy was
 *  being made is the one that stays. The old login is set aside, not deleted — and only once it
 *  really is home. Files and folders only. */
export async function bringHome(user: TurnUser, configHome: string, old: string, credName: string, log: (s: string) => void = (s) => console.log(s)): Promise<boolean> {
  const rel = path.relative(user.home, configHome);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("a login's home is inside its user's home");
  if (!/^[A-Za-z0-9._-]+$/.test(credName)) throw new Error("that is not a credential's file name");
  if (path.resolve(old) === path.resolve(configHome)) return false;
  const homes = path.dirname(user.home);
  const atHome = path.join(configHome, credName);
  return locked(homes, `${user.uid}-${rel}`, async () => {
    const st = await fs.lstat(old).catch(() => null);
    // Nothing kept the old way, or a link where a folder should be: nothing to bring.
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;
    const oldCred = await fs.lstat(path.join(old, credName)).catch(() => null);
    if (!oldCred?.isFile() || oldCred.size > 1 << 20) return false;
    // The old one must itself be a login: a broken one is not brought home to stand for one.
    if (!looksLikeLogin(credName, await fs.readFile(path.join(old, credName), "utf8").catch(() => ""))) return false;
    // Asked AS the user, under the lock, so a sign-in that has finished is seen. Not being able to
    // look throws: it is never taken to mean there is no login.
    if ((await loginAsUser(user, atHome)).login) return false;

    const stagingRoot = path.join(homes, ".staging");
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o711 });
    await fs.chmod(stagingRoot, 0o711);
    // Closed while it is filled; opened to this one user's group only once it is whole.
    const staging = path.join(stagingRoot, randomBytes(9).toString("hex"));
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      const copy = path.join(staging, "login");
      const files = await copyLogin(old, copy);
      await shareForCopy(user, staging);
      const how = (await asTheUser(user, PREPARE, [copy, configHome, credName])).trim().split("\n").pop();
      if (how !== "whole" && how !== "merged") throw new Error("the login could not be made ready to bring home");
      // Again, now that the copy is made — it can take a while, and a person may have signed in
      // meanwhile: theirs stays. What is there is remembered exactly, and FINISH goes ahead only if
      // it is still exactly that.
      // ONE look: what is judged and what FINISH compares against are the same bytes.
      const seen = await loginAsUser(user, atHome).catch(async (e) => {
        await asTheUser(user, 'rm -rf -- "$1.incoming"', [configHome]).catch(() => {});
        throw e;
      });
      if (seen.login || seen.was === "other:too-big") {
        await asTheUser(user, 'rm -rf -- "$1.incoming"', [configHome]).catch(() => {});
        if (seen.login) return false;
        throw new Error("what is where the login goes is too large to judge; it was left as it is");
      }
      const said = (await asTheUser(user, FINISH, [configHome, credName, seen.was, how])).trim().split("\n").pop();
      // A login that appeared at home meanwhile is the one that stays; the old one is left where it is.
      if (said !== "brought") return false;
      // Set aside, not deleted: recoverable until somebody checks the new place is right.
      await fs.rename(old, `${old}.moved-${Date.now()}`).catch((e) => log(`turn users: the old login of ${user.uid} is home but could not be set aside (${(e as Error).message.slice(0, 80)})`));
      log(`turn users: brought a login into the home of ${user.uid} (${files} files)`);
      return true;
    } finally {
      // Root's own folder, which the user could read and never write.
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** For the tests: the two halves of a move, so that one cut short between them can be shown. */
export const __testing = { PREPARE, FINISH };

export function turnUsers(o: TurnUsersOptions) {
  const doFetch = o.fetch ?? fetch;
  const make = o.make ?? ((uid: number) => asUser(uid));
  const log = o.log ?? ((s: string) => console.log(s));

  return {
    /** Asked of the Cloud before EVERY run — never remembered: someone who has left the tenant stops
     *  running as themselves on their very next message, not a minute later. */
    async for(agentGuid: string, speaker: string | undefined): Promise<TurnUserOf> {
      const r = await doFetch(`${o.api}/v1/system/agents/${encodeURIComponent(agentGuid)}/turn-user`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
        body: JSON.stringify(speaker ? { slackUserId: speaker } : {}),
      });
      if (!r.ok) throw new Error(`the Cloud did not say whose user this runs as (${r.status}); nothing was run`);
      const j = (await r.json()) as { uid?: unknown; of?: unknown };
      const uid = Number(j.uid);
      if (!Number.isInteger(uid) || uid < 20000) throw new Error(`${uid} is not a turn user's number; nothing was run`);
      return { ...(await make(uid)), of: j.of === "person" ? "person" : "agent" };
    },

    async handOver(user: TurnUser, what: { cwd?: string; cwdIsUsers?: boolean; configHome: string; oldConfigHome?: string; credName?: string }): Promise<void> {
      await ownFolders(user, [what.configHome]);
      if (what.oldConfigHome) await bringHome(user, what.configHome, what.oldConfigHome, what.credName ?? "auth.json", log);
      // The turn's folder — its attachments, its prompt file — is the worker's own until this moment.
      // A turn run again on a fresh session (a memory that could not be reopened) comes here twice
      // with the same folder: by then it is the user's, and the worker does not walk it again. That
      // it IS the user's by now is what the worker remembers having done (`cwdIsUsers`) — not what
      // it finds by looking at the folder, which by then is the user's to have changed.
      if (what.cwd && !what.cwdIsUsers) await giveFresh(user, what.cwd);
    },
  };
}
