// Starting a program as a turn's own Linux user (docs/definition/objects/turn-user.md in Tonoman Cloud).
//
// The worker is root; nothing it starts on an agent's behalf is (TURNUSER-NOTHING-AS-ROOT). Every
// program — a turn, a Talent, a sign-in, a status check — goes through here: the user is made if it
// is not there, the drop is proven once before anything real runs under it, and the program is
// started with `setpriv`, which sets the user and its one group, clears every other group, and sets
// no-new-privileges so nothing it runs can climb back (TURNUSER-ONE-LAUNCHER).
//
// And the other half (TURNUSER-ROOT-STAYS-OUT): a user's folders are the user's to arrange — it can
// put a link where a folder was. So the worker never opens, writes, re-owns or deletes anything by a
// path inside one. What has to be done there is done AS the user (`asTheUser`, `readAsUser`,
// `removeAsUser`, `ownFolders`), where a planted link can only ever lead the user to its own files;
// and what the worker prepares for a user it prepares where only the worker can reach, and hands
// over once (`giveFresh`) or lets the user read and not change (`shareForCopy`).
//
// What this does NOT do is said in the definition: the network is still the worker's
// (TURNUSER-NETWORK), and nothing limits processor or memory (TURNUSER-LIMITS).

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { childEnv } from "./turnenv";

export interface TurnUser {
  uid: number;
  home: string;
}

/** Where users' homes live: on the worker's volume, outside its own folders (TURNUSER-HOME-PRIVATE). */
export const HOMES_ROOT = process.env.TONOMAN_HOMES_ROOT || "/srv/tonoman/homes";

/** The Cloud allots from 20000 up; nothing below that is ever a turn's user — root least of all. */
const LOWEST = 20000;
const HIGHEST = 2_000_000_000;
const isTurnUid = (uid: number): boolean => Number.isInteger(uid) && uid >= LOWEST && uid <= HIGHEST;

/** The throwaway plain user the worker tries its own doors as, and runs what is nobody's in particular
 *  as. It owns nothing, anywhere. BELOW the Cloud's range, so it can never be a real person's number;
 *  and inside the 65,536 a rootless container maps, where a huge number is simply invalid. */
export const PROBE_UID = 19999;

const PATH_ONLY = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" });

/** Can this process drop to another user at all? Linux, root, and `setpriv` on the path. */
export function canDrop(): boolean {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) return false;
  try {
    execFileSync("setpriv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** PURE: a user's home. */
export function homeOf(uid: number, root: string = HOMES_ROOT): string {
  return `${root.replace(/\/+$/, "")}/${uid}`;
}

/** PURE: what a user keeps for one agent — a provider's login, its history. The agent's name arrives
 *  over the wire, so it cannot name a path. */
export function homeIn(user: TurnUser, agent: string, what: "claude" | "codex" | "turns" | "talents"): string {
  const safe = (agent ?? "").split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9_-]/g, "");
  return `${user.home}/agents/${safe || "_invalid"}/${what}`;
}

const nameOf = (uid: number): string => `tu${uid}`;

/** PURE: the user, by name, for programs that look themselves up. No password, no shell. */
export function passwdLine(u: TurnUser): string {
  return `${nameOf(u.uid)}:x:${u.uid}:${u.uid}:Tonoman turn user:${u.home}:/usr/sbin/nologin`;
}

export function groupLine(u: TurnUser): string {
  return `${nameOf(u.uid)}:x:${u.uid}:`;
}

const dropFlags = (uid: number): string[] => [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--"];

/** PURE: the words that start `bin` as this user. Refuses any number that is not a turn user's.
 *
 *  With a folder to start in, the program goes there AFTER it has become the user — never the worker
 *  going there first, as root, and the program inheriting where root stood: a folder that is the
 *  user's can be swapped for a link, and root would walk through doors the user cannot open. */
export function launchArgs(user: TurnUser, bin: string, args: string[], cwd?: string): { cmd: string; args: string[] } {
  if (!isTurnUid(user.uid)) throw new Error(`${user.uid} is not a turn user's number`);
  if (!cwd) return { cmd: "setpriv", args: [...dropFlags(user.uid), bin, ...args] };
  return { cmd: "setpriv", args: [...dropFlags(user.uid), "sh", "-c", 'cd -- "$1" || exit 97; shift; exec "$@"', "sh", cwd, bin, ...args] };
}

/** PURE: the words that start `bin` as the throwaway plain user — for something that is nobody's in
 *  particular (asking a provider's program its version), so that it is not run as root either. */
export function asNobody(bin: string, args: string[]): { cmd: string; args: string[] } {
  return { cmd: "setpriv", args: [...dropFlags(PROBE_UID), bin, ...args] };
}

// One at a time: two turns making users at once must not interleave their lines in /etc/passwd.
let making: Promise<unknown> = Promise.resolve();

async function addLine(file: string, line: string, startsWith: string): Promise<void> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  if (text.split("\n").some((l) => l.startsWith(startsWith))) return;
  await fs.appendFile(file, `${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`);
}

/** Make the user and its private home, if they are not there. Doing it again changes nothing. The
 *  home's own entry sits in a folder only root can write, so it cannot be swapped for a link. */
export function ensureUser(uid: number, root: string = HOMES_ROOT): Promise<TurnUser> {
  if (!isTurnUid(uid)) return Promise.reject(new Error(`${uid} is not a turn user's number`));
  const run = making.then(async () => {
    const user: TurnUser = { uid, home: homeOf(uid, root) };
    await addLine("/etc/group", groupLine(user), `${nameOf(uid)}:`);
    await addLine("/etc/passwd", passwdLine(user), `${nameOf(uid)}:`);
    // The folder of homes can be passed through but not listed: nobody sees who else lives here.
    await fs.mkdir(root, { recursive: true });
    await fs.chmod(root, 0o711);
    const st = await fs.lstat(user.home).catch(() => null);
    if (st && !st.isDirectory()) throw new Error(`the home of ${uid} is not a folder`);
    if (!st) {
      // Closed before it is anyone's, and the user's only as the last step.
      await fs.mkdir(user.home, { mode: 0o700 });
      await fs.lchown(user.home, uid, uid);
    } else if (st.uid === 0 && (st.mode & 0o077) === 0 && (await fs.readdir(user.home)).length === 0) {
      // Made and not yet handed over when the worker last stopped: still root's, closed, and empty,
      // so nobody can have touched it. Finished now, rather than refused for ever.
      await fs.lchown(user.home, uid, uid);
    } else if (st.uid !== uid) throw new Error(`the home of ${uid} belongs to someone else`);
    return user;
  });
  making = run.catch(() => {});
  return run;
}

const proven = new Map<string, Promise<TurnUser>>();

/** The user, made and PROVEN: a throwaway program is started as it first, and unless that program
 *  really is that user, in that one group, with no way back to privileges and no capabilities, no
 *  real program is started under it (TURNUSER-ONE-LAUNCHER). Once per user per worker. */
export function asUser(uid: number, root: string = HOMES_ROOT): Promise<TurnUser> {
  const key = `${root}\0${uid}`;
  let p = proven.get(key);
  if (!p) {
    p = ensureUser(uid, root).then(async (user) => {
      const { cmd, args } = launchArgs(user, "sh", ["-c", "id -u; id -g; id -G; grep -E '^(NoNewPrivs|CapEff|CapPrm|CapInh):' /proc/self/status"]);
      const out = await new Promise<string>((resolve, reject) =>
        execFile(cmd, args, { env: PATH_ONLY(), timeout: 10_000 }, (err, so, se) => (err ? reject(new Error(`could not start a program as ${uid}: ${se || err.message}`)) : resolve(so))),
      );
      const lines = out.trim().split("\n");
      const held =
        lines[0] === String(uid) &&
        lines[1] === String(uid) &&
        lines[2] === String(uid) &&
        /NoNewPrivs:\s+1/.test(out) &&
        /CapEff:\s+0+\b/.test(out) &&
        /CapPrm:\s+0+\b/.test(out) &&
        /CapInh:\s+0+\b/.test(out);
      if (!held) throw new Error(`a program started as ${uid} did not come up as that user alone — refusing to run anything under it`);
      return user;
    });
    proven.set(key, p);
    p.catch(() => proven.delete(key));
  }
  return p;
}

// ------------------------------------------------------------------ done AS the user, never by root

/** Run a short script as the user — moving its own files about, reading one of them. Never anything
 *  a model wrote. Resolves with what it printed (bounded); rejects when it fails. */
export async function asTheUser(user: TurnUser, script: string, args: string[] = [], o: { maxBytes?: number; timeoutMs?: number } = {}): Promise<string> {
  const l = launchArgs(user, "sh", ["-c", script, "sh", ...args]);
  const done = await helperBegan(user);
  try {
    return await bounded(l.cmd, l.args, { ...PATH_ONLY(), HOME: user.home }, o.timeoutMs ?? 120_000, o.maxBytes ?? 1 << 20);
  } finally {
    done();
  }
}

/** Run a helper to its end or to its deadline — a REAL deadline. It runs as a user whose other
 *  processes may be hostile: one of them can stop it (SIGSTOP), and a polite signal to a stopped
 *  process waits for ever. So at the deadline it is killed outright, with everything it started; and
 *  the answer is taken when the helper itself ends, not when the last thing holding its output does.
 *
 *  The group is signalled by number only while the helper has not been reaped: until then the number
 *  is still its own, and cannot have become anyone else's. */
function bounded(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, maxBytes: number, born?: (pid: number | undefined) => void, anyEnd = false): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform === "linux" });
    } catch (e) {
      return reject(e as Error);
    }
    born?.(child.pid);
    let out = "";
    let err = "";
    let over = false;
    child.stdout!.on("data", (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > maxBytes) {
        over = true;
        kill();
      }
    });
    child.stderr!.on("data", (b: Buffer) => (err = (err + b.toString("utf8")).slice(-2000)));
    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === "linux" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    };
    let late = false;
    const timer = setTimeout(() => ((late = true), kill()), timeoutMs);
    child.once("error", (e) => (clearTimeout(timer), reject(e)));
    child.once("exit", (code) => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Anything it left behind is the user's stray, and is swept with the rest.
      if (late) return reject(new Error("it did not finish in time, and was stopped"));
      if (over) return reject(new Error("it said more than it may"));
      // One more turn of the loop, for output already on its way.
      setImmediate(() => (anyEnd ? resolve(out + err) : code === 0 ? resolve(out) : reject(new Error((err || `it ended with ${code}`).slice(0, 300)))));
    });
  });
}

/** Make the folders a user's program needs inside its home — its login's folder, its temp. Made AS
 *  THE USER: a link it put where a folder was can then only ever lead the user to its own files. */
export async function ownFolders(user: TurnUser, folders: string[]): Promise<void> {
  const all = [...folders, `${user.home}/tmp`];
  for (const f of all) {
    const rel = path.relative(user.home, f);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("a user's folders are inside its home");
  }
  await asTheUser(user, 'mkdir -p -m 700 -- "$@"', all, { timeoutMs: 15_000 }).catch((e) => {
    throw new Error(`could not make ${user.uid}'s folders: ${(e as Error).message}`);
  });
}

/** Read a file in a user's folder, as the user, up to `maxBytes`. Null when it cannot: not there, not
 *  the user's to read — which is what a link to one of root's files is, read this way. */
export async function readAsUser(user: TurnUser, file: string, maxBytes: number): Promise<string | null> {
  return asTheUser(user, 'head -c "$2" -- "$1"', [file, String(maxBytes)], { maxBytes: maxBytes + 4096, timeoutMs: 20_000 }).catch(() => null);
}

/** Is there a plain file here, as far as the user can see? */
export async function fileAsUser(user: TurnUser, file: string): Promise<boolean> {
  return asTheUser(user, '[ -f "$1" ]', [file], { timeoutMs: 10_000 }).then(() => true, () => false);
}

/** The first file with this name under a folder of the user's, found as the user. */
export async function findAsUser(user: TurnUser, folder: string, name: string): Promise<string | null> {
  const out = await asTheUser(user, 'find "$1" -maxdepth 6 -type f -name "$2" -print -quit 2>/dev/null', [folder, name], { timeoutMs: 20_000 }).catch(() => "");
  return out.split("\n")[0] || null;
}

/** Delete files or folders in a user's folders, as the user. A folder swapped for a link to someone
 *  else's then deletes nothing of theirs: the user was never allowed to. */
export async function removeAsUser(user: TurnUser, targets: string[]): Promise<boolean> {
  if (!targets.length) return true;
  return asTheUser(user, 'rm -rf -- "$@"', targets, { timeoutMs: 60_000 }).then(() => true, () => false);
}

/** PURE: is this what a provider's login looks like — by the file's name, the provider's own shape:
 *  Codex's `auth.json` holds its tokens (or an API key), Claude's `.credentials.json` its OAuth
 *  tokens. Not whether the provider would still honour it — only that it IS a login, which a file
 *  that is merely there, empty, cut short, or some other JSON, is not. */
export function looksLikeLogin(credName: string, text: string): boolean {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return false;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return false;
  const str = (v: unknown): boolean => typeof v === "string" && v.length >= 8;
  const o = j as Record<string, unknown>;
  if (credName === "auth.json") {
    const t = o.tokens as Record<string, unknown> | undefined;
    return str(o.OPENAI_API_KEY) || (!!t && typeof t === "object" && (str(t.access_token) || str(t.refresh_token)));
  }
  const c = o.claudeAiOauth as Record<string, unknown> | undefined;
  return !!c && typeof c === "object" && (str(c.accessToken) || str(c.refreshToken));
}

/** The most a login's file may hold. One that holds more is not judged by its beginning. */
export const LOGIN_MAX = 1 << 20;

/** ONE look, AS the user, at the place a login goes: whether a login is there, and exactly WHAT was
 *  looked at — so that what is judged and what is later compared are the same bytes, never two reads
 *  of a file that could differ between them. `was` names what was seen: `none`; `file:<sha256>` of a
 *  plain file's whole contents; `other:<what>` for anything else (a link and where it leads, a
 *  folder, a pipe). THROWS when it could not look: not being able to judge a login is not the same
 *  as there being none, and must never lead to one being replaced. */
export async function loginAsUser(user: TurnUser, file: string): Promise<{ login: boolean; was: string }> {
  const out = await asTheUser(
    user,
    [
      'f="$1"',
      'if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo none; exit 0; fi',
      'if [ -L "$f" ]; then printf "other:link:%s\\n" "$(readlink -- "$f")"; exit 0; fi',
      'if [ ! -f "$f" ]; then echo other:not-a-file; exit 0; fi',
      "echo file",
      // One more than the bound: a file that is too big shows itself, rather than passing on its beginning.
      'head -c "$2" -- "$f"',
    ].join("\n"),
    [file, String(LOGIN_MAX + 1)],
    { maxBytes: LOGIN_MAX + 4096, timeoutMs: 20_000 },
  );
  const nl = out.indexOf("\n");
  const head = nl < 0 ? out : out.slice(0, nl);
  if (head !== "file") return { login: false, was: head || "none" };
  const bytes = Buffer.from(out.slice(nl + 1), "utf8");
  if (bytes.length > LOGIN_MAX) return { login: false, was: "other:too-big" };
  return { login: looksLikeLogin(path.basename(file), bytes.toString("utf8")), was: `file:${createHash("sha256").update(bytes).digest("hex")}` };
}

/** Is there a login that can be used here, as far as the user can see? Not being able to look is
 *  answered "no" HERE only because the callers of this one merely report; a move uses `loginAsUser`. */
export async function usableLoginAsUser(user: TurnUser, file: string): Promise<boolean> {
  return loginAsUser(user, file).then((r) => r.login, () => false);
}

// --------------------------------------------------- prepared by the worker, where only it can reach

/** Hand a folder the worker has JUST made to the user it is for — a turn's folder and what the worker
 *  put in it. Only a folder that is still root's and closed to everyone, holding plain files and
 *  folders with no other name elsewhere: nobody else can have touched it, so walking it as root is
 *  safe. Every mode is set first and ownership changes last, the folder's own last of all — until
 *  that moment nobody but root can reach anything in it. One that is already the user's is refused,
 *  never walked again. */
export async function giveFresh(user: TurnUser, dir: string): Promise<void> {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("only a folder the worker made can be handed over");
  if (st.uid !== 0) throw new Error("that folder was already handed over; the worker does not walk a user's folder");
  if ((st.mode & 0o077) !== 0) throw new Error("only a folder closed to everyone else can be handed over");
  const found: { p: string; dir: boolean }[] = [];
  const walk = async (target: string): Promise<void> => {
    for (const name of await fs.readdir(target)) {
      const p = path.join(target, name);
      const t = await fs.lstat(p);
      if (t.isSymbolicLink()) continue; // left as it is: a link is never re-owned, and nothing follows it
      if (!t.isDirectory() && !t.isFile()) throw new Error("only plain files and folders can be handed over");
      if (t.isFile() && t.nlink > 1) throw new Error("a file with another name elsewhere cannot be handed over");
      found.push({ p, dir: t.isDirectory() });
      if (t.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  for (const f of found) await fs.chmod(f.p, f.dir ? 0o700 : 0o600);
  await fs.chmod(dir, 0o700);
  for (const f of found.reverse()) await fs.lchown(f.p, user.uid, user.uid);
  await fs.lchown(dir, user.uid, user.uid);
}

/** Let a user READ a copy the worker made, and nothing more: it stays root's, with the user's own
 *  group allowed to read it. The user can copy from it and cannot change it, so there is nothing in
 *  it for a link to be planted in, and the worker can clear it away afterwards without going into
 *  anything a user controls. The folder must be one only root can reach while this runs. */
export async function shareForCopy(user: TurnUser, dir: string): Promise<void> {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.uid !== 0) throw new Error("only a folder the worker made can be shared");
  const walk = async (target: string): Promise<void> => {
    for (const name of await fs.readdir(target)) {
      const p = path.join(target, name);
      const t = await fs.lstat(p);
      if (t.isSymbolicLink() || (!t.isDirectory() && !t.isFile())) {
        await fs.rm(p, { force: true });
        continue;
      }
      if (t.isDirectory()) await walk(p);
      await fs.lchown(p, 0, user.uid);
      await fs.chmod(p, t.isDirectory() ? 0o750 : 0o640);
    }
  };
  await walk(dir);
  await fs.lchown(dir, 0, user.uid);
  await fs.chmod(dir, 0o750);
}

// ----------------------------------------------------------------------------------- the command

/** PURE: the command, its words and its environment for starting `bin` as this user — or exactly as
 *  given when there is no user to run as (a self-hosted agent, which codes in a container of its own).
 *  As a user the environment is made for it (`childEnv`): the runtime's settings from `env`, plus
 *  `extra` — what this one run is given — with HOME and TMPDIR inside the user's home. */
export function commandFor(
  runAs: TurnUser | undefined,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
  /** The folder it starts in — gone to AFTER it has become the user (see `launchArgs`). With a user
   *  to run as, the caller must NOT also hand `cwd` to spawn: that is root going there first. */
  cwd?: string,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!runAs) return { cmd: bin, args, env: { ...env, ...extra } };
  const l = launchArgs(runAs, bin, args, cwd);
  return { cmd: l.cmd, args: l.args, env: { ...childEnv(env, extra), HOME: runAs.home, TMPDIR: `${runAs.home}/tmp`, USER: nameOf(runAs.uid), LOGNAME: nameOf(runAs.uid) } };
}

// -------------------------------------------------------------------------------- the door check

/** Which of these places a plain user can in fact get into. The worker asks before it serves anyone
 *  (TURNUSER-DOORS-TRIED-AT-START): a secrets folder that is open to everyone, as a Windows folder
 *  mounted into a container is, makes running turns as their own users a show.
 *
 *  `closed` must give a plain user nothing: nothing to write, and no file to read — tried by reading,
 *  every file the worker can see there, since a folder that cannot be listed can still be passed
 *  through to a file whose name is known. Kubernetes' own shape, an open folder of root-only files,
 *  is closed. `unwritable` is what a turn runs — the worker's code, `tonoman` — which it may read and
 *  must not be able to change, anywhere in it. Anything that cannot be checked counts as open. */
export async function openToOthers(closed: string[], unwritable: string[] = [], o: { as?: TurnUser; shallow?: boolean } = {}): Promise<string[]> {
  // As the throwaway plain user at start; and again AS each real user the first time it is made
  // (`as`), since a door can be open to one number and shut to another.
  const flags = dropFlags(o.as ? o.as.uid : PROBE_UID);
  if (o.as && !isTurnUid(o.as.uid)) throw new Error(`${o.as.uid} is not a turn user's number`);
  const probe = (script: string, args: string[]) =>
    bounded("setpriv", [...flags, "sh", "-c", script, "sh", ...args], PATH_ONLY(), 120_000, 1 << 22).catch((e) => {
      throw new Error(`could not try the worker's doors as a plain user: ${(e as Error).message}`);
    });
  const open = new Set<string>();
  const deep = o.shallow ? "false" : "true";
  // Whoever OWNS a thing can change its permissions, whatever they say today. So nothing that is
  // meant to be closed, or not to be changed — the place itself, any folder above it, anything in it
  // — may belong to a turn user, or to the throwaway plain user the doors are tried as.
  const aUsers = (uid: number): boolean => uid === PROBE_UID || isTurnUid(uid);
  for (const p of [...closed, ...unwritable]) {
    for (let d = p; ; d = path.dirname(d)) {
      const st = await fs.stat(d).catch(() => null);
      if (st && aUsers(st.uid)) open.add(p);
      if (d === path.dirname(d)) break;
    }
  }

  // Anything a plain user can write, at any depth — links followed, since what a link leads to is
  // what gets run; any folder ABOVE it that a plain user can write, since whoever can write the
  // folder above can put something else in its place; and for a closed place, anything it can read.
  const looked = await probe(
    [
      'n="$1"; deep="$2"; shift 2; i=0',
      'for p in "$@"; do',
      "  i=$((i+1))",
      '  d="$p"; up=""',
      '  while [ "$d" != "/" ] && [ -n "$d" ]; do d=$(dirname -- "$d"); if [ -w "$d" ]; then up=1; fi; done',
      '  if [ -n "$up" ]; then printf "%s\\n" "$p"; continue; fi',
      '  [ -e "$p" ] || continue',
      '  if [ -w "$p" ]; then printf "%s\\n" "$p"; continue; fi',
      '  if [ "$deep" = true ] && [ -n "$(find -L "$p" -writable -print -quit 2>/dev/null)" ]; then printf "%s\\n" "$p"; continue; fi',
      // …or that belongs to a user at all (19999 and up), writable today or not.
      '  if [ "$deep" = true ] && [ -n "$(find -L "$p" -uid +19998 -print -quit 2>/dev/null)" ]; then printf "%s\\n" "$p"; continue; fi',
      '  [ "$i" -le "$n" ] || continue',
      '  if [ -f "$p" ]; then if [ -r "$p" ]; then printf "%s\\n" "$p"; fi; continue; fi',
      '  if [ -n "$(find -L "$p" -type f -readable -print -quit 2>/dev/null)" ]; then printf "%s\\n" "$p"; fi',
      "done",
    ].join("\n"),
    [String(closed.length), deep, ...closed, ...unwritable],
  );
  for (const p of looked.split("\n").filter(Boolean)) open.add(p);

  // A folder that cannot be listed hides its files from `find`, not from someone who knows a name.
  // Root lists them all — links followed, since a secret is often one — and the probe tries each.
  // Anything root itself cannot look at is NOT passed over: the place is then not called closed.
  for (const dir of closed) {
    if (open.has(dir)) continue;
    const names: string[] = [];
    const folders: string[] = [];
    // A folder of root's own that gives nobody else anything — not even the right to pass through —
    // shuts off everything under it: a permission granted to one named user shows in those same
    // bits, so none is hiding. It is not walked: what is under it cannot be reached through it.
    const shut = (st: { uid: number; mode: number }): boolean => st.uid === 0 && (st.mode & 0o077) === 0;
    const walk = async (d: string, depth: number): Promise<void> => {
      if (depth > 32) throw new Error("too deep to check");
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const l = await fs.lstat(p);
        const t = await fs.stat(p).catch((err) => {
          // A link to nothing holds nothing to read. Anything else that cannot be looked at is a failure.
          if (l.isSymbolicLink() && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }); // follows a link: what it points at is what is read
        // Whoever OWNS a thing can change its permissions, whatever they say today: something in a
        // closed place that belongs to a turn user is that user's to open whenever it likes.
        if (t && (aUsers(t.uid) || aUsers(l.uid))) throw new Error("something in a closed place belongs to a user");
        if (t?.isDirectory()) {
          if (shut(t)) continue;
          folders.push(p);
          await walk(p, depth + 1);
        } else if (t?.isFile()) names.push(p);
        if (names.length + folders.length > 50_000) throw new Error("too much to check");
      }
    };
    // `stat`, not `lstat`: a door that is itself a link is looked at where it leads.
    const there = await fs.stat(dir).catch((err) => ((err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unknown"));
    if (there === null) continue; // no such place: nothing in it to get into (the folders above it were tried)
    // Shut itself, or under a folder that is: nothing in it can be reached, whatever it holds.
    const above: string[] = [];
    for (let d = path.dirname(dir); ; d = path.dirname(d)) {
      above.push(d);
      if (d === path.dirname(d)) break;
    }
    const shutAbove = there !== "unknown" && (shut(there) || (await Promise.all(above.map((d) => fs.stat(d).then(shut, () => false)))).some(Boolean));
    if (shutAbove) continue;
    const listed = there !== "unknown" && (await (there.isDirectory() ? walk(dir, 0) : Promise.resolve()).then(() => true, () => false));
    if (!listed) {
      open.add(dir); // could not be checked, so it is not called closed
      continue;
    }
    for (let i = 0; i < folders.length; i += 500) {
      const writable = await probe('for f in "$@"; do if [ -w "$f" ]; then printf "%s\\n" "$f"; fi; done', folders.slice(i, i + 500));
      if (writable.trim()) open.add(dir);
    }
    for (let i = 0; i < names.length; i += 500) {
      // To read OR to write: a file a user may change and not read is hidden from its own `find`
      // by the folder it cannot list, and is a door all the same.
      const reachable = await probe('for f in "$@"; do if [ -r "$f" ] || [ -w "$f" ]; then printf "%s\\n" "$f"; fi; done', names.slice(i, i + 500));
      if (reachable.trim()) open.add(dir);
    }
  }
  return [...closed, ...unwritable].filter((p) => open.has(p));
}

// ------------------------------------------------------------------------- ending with the turn

/** Spawn options that put a user's program in a process group of its own, so everything it starts
 *  can be stopped with it (TURNUSER-DIES-WITH-THE-TURN). Only where there is a user to run as. */
export function ownGroup(runAs: TurnUser | undefined): { detached?: boolean } {
  return runAs && process.platform === "linux" ? { detached: true } : {};
}

/** Stop a program and everything in its group. Asked politely, then — if it is still there after a
 *  moment — not: a program that ignores the first would otherwise never end, and nothing after it
 *  would ever be cleaned up.
 *
 *  The group is signalled by its number, as root — so ONLY while the program itself has not been
 *  reaped: until then that number is still its own. Once it has ended the number can become some
 *  other group's, and a signal sent then would be root's signal to a stranger; what the program left
 *  behind is stopped as its user instead (`sweepStrays`). */
export function stopAll(
  child: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean; once?(ev: "exit", fn: () => void): unknown },
  grouped: boolean,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const ended = (): boolean => child.exitCode !== null && child.exitCode !== undefined ? true : child.signalCode !== null && child.signalCode !== undefined;
  const send = (sig: NodeJS.Signals): void => {
    if (ended()) return;
    if (grouped && child.pid) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        /* the group is already gone: fall through to the program itself */
      }
    }
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  send(signal);
  if (signal === "SIGKILL") return;
  const timer = setTimeout(() => send("SIGKILL"), 5000);
  timer.unref();
  child.once?.("exit", () => clearTimeout(timer));
}

/** PURE: of these processes, the ones running as `uid` that do not descend from any of `keep` — what
 *  ended runs left behind. A process can leave its group and its session; it cannot stop being the
 *  child of whoever started it except by that one ending, and then it is nobody's that still runs. */
export function straysOf(procs: { pid: number; ppid: number; uid: number }[], uid: number, keep: number[], self?: number): number[] {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const kept = new Set(keep);
  const under = (pid: number): boolean => {
    for (let at: number | undefined = pid, hops = 0; at !== undefined && at > 0 && hops < 256; at = parent.get(at), hops++) if (kept.has(at)) return true;
    return false;
  };
  return procs.filter((p) => p.uid === uid && p.pid !== self && !under(p.pid)).map((p) => p.pid);
}

// Run as the user: list its own processes, stop the ones that belong to no run still going. Its
// signals can only ever reach its own user's processes, whatever a number has come to mean.
const STRAY_SCRIPT = `
const fs=require("fs");const keep=new Set(process.argv.slice(1).map(Number));const me=process.getuid();
const procs=[];for(const d of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(d))continue;try{const t=fs.readFileSync("/proc/"+d+"/status","utf8");
const u=/^Uid:\\s+(\\d+)/m.exec(t),pp=/^PPid:\\s+(\\d+)/m.exec(t);if(u&&pp)procs.push({pid:+d,ppid:+pp[1],uid:+u[1]})}catch{}}
const parent=new Map(procs.map(p=>[p.pid,p.ppid]));const under=pid=>{for(let at=pid,h=0;at>0&&h<256;at=parent.get(at),h++){if(keep.has(at))return true}return false};
for(const p of procs){if(p.uid!==me||p.pid===process.pid||under(p.pid))continue;try{process.kill(p.pid,"SIGKILL")}catch{}}
console.log("swept");
`;

async function procsNow(): Promise<{ pid: number; ppid: number; uid: number }[]> {
  const out: { pid: number; ppid: number; uid: number }[] = [];
  // Not being able to look is not the same as there being nothing: it throws, and the sweep fails.
  for (const d of await fs.readdir("/proc")) {
    if (!/^[0-9]+$/.test(d)) continue;
    const t = await fs.readFile(`/proc/${d}/status`, "utf8").catch((e) => {
      // Gone between being listed and being read: it has ended, which is all that was wanted of it.
      if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return "";
      throw e;
    });
    const u = /^Uid:\s+(\d+)/m.exec(t);
    const pp = /^PPid:\s+(\d+)/m.exec(t);
    const state = /^State:\s+(\S)/m.exec(t)?.[1];
    // Ended and only waiting to be reaped does not count: it runs nothing.
    if (u && pp && state !== "Z") out.push({ pid: Number(d), ppid: Number(pp[1]), uid: Number(u[1]) });
  }
  return out;
}

/** Stop what ended runs of this user left running. Done AS the user, whose signals can only reach
 *  its own processes. REJECTS when something is still there afterwards, or when it could not look:
 *  a clean-up that did not work is not reported as one that did.
 *
 *  With NO run of the user still going it is `kill(-1)`: one call, in which the kernel signals every
 *  process of that user at once — nothing can fork its way out from under it. That is the promise
 *  that holds against a hostile program: when a user's last run has ended, nothing of it is left.
 *
 *  While OTHER runs of the user go on (`keep`: the process numbers they were started as), only what
 *  does not descend from one of them is stopped — found by reading /proc, which is a look at a
 *  moving thing: a program forking faster than it is looked at can outlast it, until that user's
 *  last run ends. Two runs of one user share one sandbox anyway (`TURNUSER-ONE-USER-ONE-SANDBOX`). */
export async function sweepStrays(user: TurnUser, keep: number[] = []): Promise<void> {
  if (!isTurnUid(user.uid) || process.platform !== "linux") return;
  // It SAYS that it did it. A sweeper that was stopped, killed or never started says nothing, and then
  // two quiet looks at /proc are not taken for a clean-up: a look can be outrun, the kill cannot.
  // (`kill(-1)` leaves the caller itself alone; with nobody else to signal it fails with ESRCH — which
  // is also an answer: there was nothing.)
  const script = keep.length
    ? STRAY_SCRIPT
    : 'try{process.kill(-1,"SIGKILL");console.log("swept")}catch(e){if(e&&e.code==="ESRCH")console.log("swept");else process.exit(1)}';
  for (let round = 0; round < 3; round++) {
    const l = launchArgs(user, process.execPath, ["-e", script, ...keep.map(String)]);
    const said = await bounded(l.cmd, l.args, PATH_ONLY(), 10_000, 1 << 16).catch(() => "");
    if (!/^swept$/m.test(said)) continue;
    await new Promise((r) => setTimeout(r, 80));
    // Looked at twice: one look can miss what was being born while it looked.
    if (straysOf(await procsNow(), user.uid, keep).length) continue;
    await new Promise((r) => setTimeout(r, 40));
    if (straysOf(await procsNow(), user.uid, keep).length === 0) return;
  }
  throw new Error(`what an earlier run left running as ${user.uid} could not be stopped`);
}

/** Everything running as this user, stopped. */
export const sweepUser = (user: TurnUser): Promise<void> => sweepStrays(user, []);

// Per user: the runs going (by the process number each was started with, once it has one), the
// helpers in flight, a sweep under way, and whether the last sweep failed. A run or a helper never
// starts while its user is being swept — it would be what gets stopped; a sweep waits for the
// helpers in flight, which are short and bounded.
interface Going {
  runs: Set<{ pid?: number; begun?: boolean }>;
  helpers: number;
  sweep?: Promise<void>;
  /** Another run ended while a sweep was under way: it goes round again, with who is left. */
  again?: boolean;
  /** A sweep failed: something an earlier run left behind may still be running. */
  dirty?: boolean;
  idle: (() => void)[];
}
const going = new Map<number, Going>();
const of = (uid: number): Going => {
  let g = going.get(uid);
  if (!g) going.set(uid, (g = { runs: new Set(), helpers: 0, idle: [] }));
  return g;
};

async function helperBegan(user: TurnUser): Promise<() => void> {
  const g = of(user.uid);
  while (g.sweep) await g.sweep.catch(() => {});
  // Nothing new is started as a user beside what a failed clean-up left — a helper no more than a
  // run: it is tried again first, and the helper is refused if it fails again.
  if (g.dirty && process.platform === "linux") {
    await sweepNow(user);
    if (g.dirty) throw new Error(`what an earlier run left running as ${user.uid} could not be stopped; nothing new is started beside it`);
    // Asked afresh: a run may have ended, and started a sweep, while that one was awaited.
    for (let s = of(user.uid).sweep; s; s = of(user.uid).sweep) await s.catch(() => {});
  }
  g.helpers++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    g.helpers--;
    for (const f of g.idle.splice(0)) f();
  };
}

/** ONE sweep per user at a time, and one owner of what it found. A run ending while it is under way
 *  does not start a second beside it — two would stop each other's helpers, and the one that finished
 *  first would let a new run in under the other — it asks this one to go round again, with who is
 *  left by then. Nothing new starts as the user until the last round is done; what THAT round found
 *  is what counts. */
function sweepNow(user: TurnUser): Promise<void> {
  const g = of(user.uid);
  if (g.sweep) {
    g.again = true;
    return g.sweep;
  }
  const sweep = (async () => {
    do {
      g.again = false;
      // Not while a helper is in flight, nor while a run is reserved and not yet started: it would be
      // started into the sweep, known by no number yet, and stopped with the strays.
      while (g.helpers > 0 || [...g.runs].some((r) => !r.begun)) await new Promise<void>((r) => g.idle.push(r));
      await sweepStrays(user, [...g.runs].map((r) => r.pid).filter((p): p is number => typeof p === "number")).then(
        () => void (g.dirty = false),
        () => void (g.dirty = true),
      );
    } while (g.again);
  })().finally(() => {
    g.sweep = undefined;
  });
  g.sweep = sweep;
  return sweep;
}

/** Run a provider's own short program as a user — a status check — to its end or its deadline, and
 *  give back everything it said, however it ended. Counted as a RUN, not a helper: it is not one of
 *  the worker's own scripts, so what it may have left behind is swept when it ends. */
export async function runToEnd(user: TurnUser, cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<string> {
  const hold = await runBegan(user);
  try {
    return await bounded(cmd, args, env, timeoutMs, 1 << 22, (pid) => hold.started(pid), true);
  } catch (e) {
    return String((e as Error).message ?? "");
  } finally {
    hold.started(undefined);
    hold.release();
  }
}

export interface RunHold {
  /** The program started: its process number is what its descendants are known by. */
  started(pid: number | undefined): void;
  /** The run ended — or never started. Safe to call more than once; it counts once. */
  release(): void;
}

/** Reserve a run for this user. Waits for a sweep of that user to finish first, so a new run is never
 *  what gets stopped; and when an earlier clean-up FAILED it is tried again first, and the run is
 *  refused if it fails again — it is not started beside whatever could not be stopped.
 *
 *  When a run ends, what it left behind is stopped at once — also while other runs of the same user
 *  go on, which are told apart by descent from the programs they were started as. */
export async function runBegan(runAs: TurnUser | undefined): Promise<RunHold> {
  if (!runAs) return { started: () => {}, release: () => {} };
  const g = of(runAs.uid);
  while (g.sweep) await g.sweep.catch(() => {});
  if (g.dirty && process.platform === "linux") {
    await sweepNow(runAs);
    if (g.dirty) throw new Error(`what an earlier run left running as ${runAs.uid} could not be stopped; nothing new is started beside it`);
  }
  const run: { pid?: number; begun?: boolean } = {};
  g.runs.add(run);
  let released = false;
  return {
    started: (pid) => {
      if (pid !== undefined || !run.begun) run.pid = pid;
      run.begun = true;
      for (const f of g.idle.splice(0)) f();
    },
    release: () => {
      if (released) return;
      released = true;
      g.runs.delete(run);
      for (const f of g.idle.splice(0)) f();
      if (process.platform === "linux") void sweepNow(runAs);
    },
  };
}
