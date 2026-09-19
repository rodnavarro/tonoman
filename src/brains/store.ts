// A brain on disk: one clone per brain, read only at pushed revisions, written through a journal.
//
// The rules this keeps (docs/definition/objects/brain.md in Tonoman Cloud):
//   BRAIN-WORKSPACE      readers see the latest PUSHED state, never another turn's half-written file —
//                        every read goes through `origin/<branch>`, not the working tree.
//   BRAIN-REMEMBER       a write is confirmed only after the push succeeds.
//   BRAIN-LOG            every write adds a dated line to `log.md`.
//   BRAIN-TWO-WRITERS    writes to one brain are serialized here, and a push that loses a race is
//                        redone on the new remote with a three-way merge, so both changes land; a real
//                        conflict keeps the person's text and says so.
//   BRAIN-WRITE-SURVIVES-RESTART  every write is journaled before it touches git, and a restart
//                        finishes or reports it (see `recover`).
//
// The clone lives under the worker's state root, which no turn can read (the turn runs as its own
// user). The git credential is used per command and never written to `.git/config`.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export interface BrainRef {
  id: string;
  /** Tenant slug — only for the on-disk layout. */
  tenant: string;
  repoUrl: string;
  branch?: string;
  /** Read and write under this folder only (legacy second brains that live in a wiki subtree). */
  subpath?: string;
  /** For the refresh's map and log; not used to find the brain. */
  name?: string;
}

export interface StoreOptions {
  root: string;
  /** The token for this brain's remote, or "" for none (a local remote in tests). */
  token(b: BrainRef): Promise<string>;
  now?: () => Date;
  log?: (s: string) => void;
  /** How long a fetch stays fresh for reads. Writes always fetch. */
  fetchEveryMs?: number;
  /** Called after a person's or a Talent's write is pushed — never after the refresh's own
   *  (BRAIN-REFRESH-NO-LOOP). The refresh queue listens here. */
  onPushed?: (b: BrainRef) => void;
}

export interface Page {
  path: string;
  content: string;
  /** The blob this content came from — pass it back to `write` so a concurrent edit is merged, not overwritten. */
  blob: string | null;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export type WriteResult =
  | { ok: true; path: string; sha: string; merged: boolean }
  | { ok: false; reason: "conflict" | "push-failed" | "bad-path" | "not-allowed"; detail: string; pendingId?: string };

export interface WriteRequest {
  brain: BrainRef;
  path: string;
  content: string;
  /** The blob the writer read, if it edited an existing page. */
  baseBlob?: string | null;
  /** One line for log.md: what this is. */
  note: string;
  /** Who it is for, for log.md and the journal. */
  who: string;
  /** Anything recovery needs to tell the person the outcome later. Opaque to the store. */
  notify?: Record<string, unknown>;
  /** Asked immediately before every push: may this person still write here? (BRAIN-GRANT-TIMING) */
  authorize?: () => Promise<boolean>;
}

/** Several pages written as one commit, replacing what is there — what a Talent files (a recap page
 *  and its transcript). The Talent owns those paths; a person's pages are written with `write`. */
export interface FilesRequest {
  brain: BrainRef;
  files: { path: string; content: string }[];
  note: string;
  who: string;
  notify?: Record<string, unknown>;
  authorize?: () => Promise<boolean>;
  /** The refresh writing its own files under `.tonoman/`: allowed there only, no log.md line, and it
   *  does not start another refresh. */
  system?: boolean;
  /** A path this write may replace only if what is there is already its own — checked on the pushed
   *  tip inside every attempt, so two writers choosing one name cannot both win. */
  claim?: { path: string; mine: (existing: string) => boolean };
  /** The pushed revision this write was computed from. If the brain has moved on, nothing is written
   *  ("superseded"): the refresh's map of an older state must not land on a newer one. */
  basedOn?: string;
}

export type FilesResult =
  | { ok: true; paths: string[]; sha: string | null }
  | { ok: false; reason: "push-failed" | "bad-path" | "not-allowed" | "taken" | "superseded"; detail: string };

interface GitResult {
  code: number;
  out: string;
}

function git(args: string[], cwd?: string, input?: string, token?: string): Promise<GitResult> {
  // The credential rides in git's ENVIRONMENT config, never in a URL or an argument: arguments are
  // readable by every user on the machine through /proc, and a URL is written into .git/config by a
  // clone. A process's environment is readable only by its own user.
  const auth: NodeJS.ProcessEnv = token
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`tonoman:${token}`).toString("base64")}`,
      }
    : {};
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        // Never the process's own folder: a worker started inside a git checkout (dev mounts its source,
        // a worktree whose .git points at a host path) would make every repo-less command — clone,
        // ls-remote — read that checkout first and fail.
        cwd: cwd ?? tmpdir(),
        windowsHide: true,
        maxBuffer: 1 << 26,
        // No prompt, ever: a missing credential must fail, not hang a turn waiting on a terminal.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C", ...auth },
      },
      (err, so, se) => resolve({ code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) || 1 : 0, out: `${so}${se}` }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** PURE: never let a token reach a log. */
export function redact(text: string, token: string): string {
  let out = token ? text.split(token).join("***") : text;
  out = out.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***:***@");
  return out;
}

/** PURE: a page path a person or an agent may name. Relative, inside the brain, not git's own files,
 *  and not the files the store itself keeps. Returns the normalized path or null. */
export function safePagePath(p: string, subpath = ""): string | null {
  if (typeof p !== "string") return null;
  const raw = p.replace(/\\/g, "/").trim();
  if (!raw || raw.startsWith("/") || /^[a-z]:/i.test(raw) || raw.includes("\0")) return null;
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === ".." ) return null;
    if (seg.toLowerCase() === ".git" || seg.startsWith(".git")) return null;
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  const rel = parts.join("/");
  if (rel.length > 300) return null;
  const sub = subpath.replace(/^\/+|\/+$/g, "");
  return sub ? `${sub}/${rel}` : rel;
}

/** PURE: is this path inside the refresh's own folder? */
export function isRefreshPath(p: string): boolean {
  return p.replace(/\\/g, "/").split("/").some((seg) => seg.toLowerCase() === ".tonoman");
}

/** PURE: the dated log.md line for a write. */
export function logLine(at: Date, pagePath: string, note: string, who: string): string {
  const stamp = at.toISOString().replace("T", " ").slice(0, 16);
  const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
  return `- ${stamp} UTC · \`${pagePath}\` · ${clean(note) || "updated"} · for ${clean(who) || "someone"}\n`;
}

export function createStore(o: StoreOptions) {
  const log = o.log ?? ((s: string) => console.log(s));
  const now = o.now ?? (() => new Date());
  const fetchEvery = o.fetchEveryMs ?? 15_000;
  const lastFetch = new Map<string, number>();
  const locks = new Map<string, Promise<unknown>>();

  const dirOf = (b: BrainRef) => path.join(o.root, b.tenant.replace(/[^a-z0-9-]/gi, "_"), b.id);
  const journalDir = () => path.join(o.root, "_journal");
  const branchOf = (b: BrainRef) => b.branch || "main";
  const remoteRef = (b: BrainRef) => `refs/remotes/origin/${branchOf(b)}`;

  /** One operation per brain at a time — fetches and writes alike share the clone's index and refs. */
  function serial<T>(b: BrainRef, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(b.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(b.id, next);
    return next.finally(() => {
      if (locks.get(b.id) === next) locks.delete(b.id);
    });
  }

  async function ensureClone(b: BrainRef, token: string): Promise<string> {
    const dir = dirOf(b);
    const exists = await fs.stat(path.join(dir, ".git")).then(() => true, () => false);
    if (exists) {
      const current = (await git(["remote", "get-url", "origin"], dir)).out.trim();
      if (current === b.repoUrl) return dir;
      // The brain was repointed (a second-brain source moved): this clone is another repo's now. Its
      // pending writes are in the journal, not in the clone, so it is simply made again.
      await fs.rm(dir, { recursive: true, force: true });
      lastFetch.delete(b.id);
    }
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const r = await git(["clone", "--no-checkout", "--branch", branchOf(b), b.repoUrl, dir], undefined, undefined, token);
    if (r.code !== 0) {
      // An empty repo has no branch to check out; clone it plain and let the first write create the branch.
      const r2 = await git(["clone", "--no-checkout", b.repoUrl, dir], undefined, undefined, token);
      if (r2.code !== 0) throw new Error(`clone failed: ${redact(r2.out, token).slice(0, 300)}`);
    }
    await git(["config", "user.name", "Tonoman"], dir);
    // Bytes in, bytes out: a page is stored exactly as written, whatever the host's line-ending habits.
    await git(["config", "core.autocrlf", "false"], dir);
    await git(["config", "user.email", "brains@tonoman.com"], dir);
    return dir;
  }

  async function fetchNow(b: BrainRef): Promise<string> {
    const token = await o.token(b);
    const dir = await ensureClone(b, token);
    const r = await git(["fetch", "--prune", "origin", `+refs/heads/${branchOf(b)}:${remoteRef(b)}`], dir, undefined, token);
    if (r.code !== 0 && !/couldn't find remote ref/.test(r.out)) {
      throw new Error(`fetch failed: ${redact(r.out, token).slice(0, 300)}`);
    }
    lastFetch.set(b.id, Date.now());
    return dir;
  }

  /** A clone fresh enough to read — fetched at most every `fetchEveryMs`. */
  async function fresh(b: BrainRef): Promise<string> {
    const at = lastFetch.get(b.id) ?? 0;
    if (Date.now() - at < fetchEvery) return dirOf(b);
    return serial(b, () => fetchNow(b));
  }

  /** Fetch now, whatever the cache says: a turn's first look at a brain sees the latest push. */
  async function refresh(b: BrainRef): Promise<void> {
    await serial(b, () => fetchNow(b));
  }

  /** PURE-ish: is every part of this path an ordinary file or folder in the tree — no symlink, no
   *  submodule? A write must never be steered outside the brain by a link somebody committed. */
  async function plainPath(dir: string, rev: string, rel: string): Promise<boolean> {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const r = await git(["ls-tree", "-z", rev, "--", parts.slice(0, i).join("/")], dir);
      if (r.code !== 0) return false;
      const entry = r.out.split("\0").find(Boolean);
      if (!entry) return true; // nothing there from here down: a new path
      const mode = entry.split(" ")[0];
      if (mode === "120000" || mode === "160000") return false;
    }
    return true;
  }

  async function hasRemoteBranch(dir: string, b: BrainRef): Promise<boolean> {
    return (await git(["rev-parse", "--verify", "--quiet", remoteRef(b)], dir)).code === 0;
  }

  async function blobOf(dir: string, rev: string, p: string): Promise<string | null> {
    const r = await git(["rev-parse", "--verify", "--quiet", `${rev}:${p}`], dir);
    return r.code === 0 ? r.out.trim() : null;
  }

  async function read(b: BrainRef, p: string): Promise<Page | null> {
    const rel = safePagePath(p, b.subpath);
    if (!rel) return null;
    const dir = await fresh(b);
    if (!(await hasRemoteBranch(dir, b))) return null;
    const blob = await blobOf(dir, remoteRef(b), rel);
    if (!blob) return null;
    const r = await git(["cat-file", "blob", blob], dir);
    if (r.code !== 0) return null;
    return { path: p.replace(/\\/g, "/").replace(/^\/+/, ""), content: r.out, blob };
  }

  async function list(b: BrainRef, limit = 2000): Promise<string[]> {
    const dir = await fresh(b);
    if (!(await hasRemoteBranch(dir, b))) return [];
    const sub = (b.subpath ?? "").replace(/^\/+|\/+$/g, "");
    const args = ["ls-tree", "-r", "--name-only", "-z", remoteRef(b)];
    if (sub) args.push("--", sub);
    const r = await git(args, dir);
    if (r.code !== 0) return [];
    return r.out
      .split("\0")
      .filter(Boolean)
      .map((x) => (sub && x.startsWith(`${sub}/`) ? x.slice(sub.length + 1) : x))
      .slice(0, limit);
  }

  async function search(b: BrainRef, query: string, limit = 40): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const dir = await fresh(b);
    if (!(await hasRemoteBranch(dir, b))) return [];
    const sub = (b.subpath ?? "").replace(/^\/+|\/+$/g, "");
    // Fixed strings, case-insensitive, over the pushed tree only. Each word must appear on the line.
    const words = q.split(/\s+/).filter(Boolean).slice(0, 6);
    const args = ["grep", "-n", "-I", "-i", "-F", "--full-name", "-z"];
    words.forEach((w, i) => args.push(...(i === 0 ? ["-e", w] : ["--and", "-e", w])));
    args.push(remoteRef(b));
    if (sub) args.push("--", sub);
    const r = await git(args, dir);
    if (r.code === 1) return []; // no match
    if (r.code !== 0) throw new Error("the search could not be run");
    // Records are <rev>:<path>\0<line>\0<text>\n, and a path may itself hold a newline, so they are
    // read field by field rather than split on newlines.
    const hits: SearchHit[] = [];
    const out = r.out;
    const prefix = `${remoteRef(b)}:`;
    let i = 0;
    while (i < out.length && hits.length < limit) {
      const a = out.indexOf("\0", i);
      const c = a < 0 ? -1 : out.indexOf("\0", a + 1);
      const e = c < 0 ? -1 : out.indexOf("\n", c + 1);
      if (a < 0 || c < 0) break;
      const pth = out.slice(i, a).replace(prefix, "");
      const rel = sub && pth.startsWith(`${sub}/`) ? pth.slice(sub.length + 1) : pth;
      hits.push({ path: rel, line: Number(out.slice(a + 1, c)), text: out.slice(c + 1, e < 0 ? out.length : e).slice(0, 300) });
      i = e < 0 ? out.length : e + 1;
    }
    return hits;
  }

  // --- writes -----------------------------------------------------------------------------------

  async function journal(id: string, entry: Record<string, unknown>): Promise<void> {
    await fs.mkdir(journalDir(), { recursive: true, mode: 0o700 });
    const f = path.join(journalDir(), `${id}.json`);
    const prev = await fs.readFile(f, "utf8").then((s) => JSON.parse(s) as Record<string, unknown>, () => ({}));
    await fs.writeFile(`${f}.tmp`, JSON.stringify({ ...prev, ...entry, at: now().toISOString() }), { mode: 0o600 });
    await fs.rename(`${f}.tmp`, f);
  }

  /** One attempt: a fresh worktree on the pushed tip, the change merged in, log.md appended, pushed. */
  async function attempt(req: WriteRequest, rel: string, opId: string): Promise<WriteResult | "retry"> {
    const b = req.brain;
    const token = await o.token(b);
    const dir = await fetchNow(b);
    const tipExists = await hasRemoteBranch(dir, b);
    const wt = path.join(dir, `.tonoman-wt-${opId.slice(0, 8)}`);
    await git(["worktree", "remove", "--force", wt], dir);
    await fs.rm(wt, { recursive: true, force: true });
    // Provisioning always seeds a first commit, so a brain with no branch is one that was never set up.
    if (!tipExists) return { ok: false, reason: "push-failed", detail: "this brain has not been set up yet" };
    const add = await git(["worktree", "add", "--detach", wt, remoteRef(b)], dir);
    if (add.code !== 0) return { ok: false, reason: "push-failed", detail: redact(add.out, token).slice(0, 300) };
    try {
      // First, before anything else looks at the path: no link or submodule anywhere along it.
      const logRel = safePagePath("log.md", b.subpath)!;
      if (!(await plainPath(dir, remoteRef(b), rel)) || !(await plainPath(dir, remoteRef(b), logRel))) {
        return { ok: false, reason: "bad-path", detail: "that page sits behind a link in the brain, so it cannot be written" };
      }
      const target = path.join(wt, rel);
      const current = tipExists ? await blobOf(dir, remoteRef(b), rel) : null;
      let content = req.content;
      let merged = false;
      if (current && req.baseBlob && current !== req.baseBlob) {
        // Someone changed this page since the writer read it: merge theirs and ours on the common base.
        const tmp = path.join(wt, `.merge-${opId.slice(0, 8)}`);
        await fs.mkdir(tmp, { recursive: true });
        const [baseF, curF, oursF] = ["base", "current", "ours"].map((n) => path.join(tmp, n));
        await fs.writeFile(baseF, (await git(["cat-file", "blob", req.baseBlob], dir)).out);
        await fs.writeFile(curF, (await git(["cat-file", "blob", current], dir)).out);
        await fs.writeFile(oursF, req.content);
        const m = await git(["merge-file", "-p", oursF, baseF, curF]);
        await fs.rm(tmp, { recursive: true, force: true });
        if (m.code !== 0) {
          return { ok: false, reason: "conflict", detail: "someone else changed the same lines of this page", pendingId: opId };
        }
        content = m.out;
        merged = true;
      } else if (current && !req.baseBlob) {
        // A brand-new page whose name is already taken: never overwrite a page the writer did not read.
        const existing = (await git(["cat-file", "blob", current], dir)).out;
        if (existing !== req.content) {
          return { ok: false, reason: "conflict", detail: "a page with that name already exists; read it first and edit it", pendingId: opId };
        }
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Belt and braces for the checks above: what is written must resolve inside this worktree.
      const root = await fs.realpath(wt);
      const inside = async (f: string) => (await fs.realpath(path.dirname(f))).startsWith(root);
      if (!(await inside(target))) return { ok: false, reason: "bad-path", detail: "that page resolves outside the brain" };
      await fs.writeFile(target, content);
      const logFile = path.join(wt, logRel);
      const prior = await fs.readFile(logFile, "utf8").catch(() => "# Log\n\n");
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      if (!(await inside(logFile))) return { ok: false, reason: "bad-path", detail: "the brain's log resolves outside the brain" };
      await fs.writeFile(logFile, prior + (prior.endsWith("\n") ? "" : "\n") + logLine(now(), req.path, req.note, req.who));
      await git(["add", "-A", "--", rel, path.relative(wt, logFile).replace(/\\/g, "/")], wt);
      const msg = `${req.note.replace(/\s+/g, " ").trim().slice(0, 72) || `Update ${req.path}`}\n\nFor: ${req.who}\nTonoman-Op: ${opId}\n`;
      const c = await git(["commit", "-q", "-F", "-"], wt, msg);
      if (c.code !== 0 && !/nothing to commit/.test(c.out)) {
        return { ok: false, reason: "push-failed", detail: c.out.slice(0, 300) };
      }
      const sha = (await git(["rev-parse", "HEAD"], wt)).out.trim();
      await journal(opId, { status: "committed", sha });
      // The last moment to stop: may this person still write here? (BRAIN-GRANT-TIMING)
      if (req.authorize && !(await req.authorize().catch(() => false))) {
        return { ok: false, reason: "not-allowed", detail: "access to this brain changed while writing, so nothing was saved" };
      }
      const p = await git(["push", "--porcelain", "origin", `HEAD:refs/heads/${branchOf(b)}`], wt, undefined, token);
      if (p.code !== 0) {
        if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/.test(p.out)) return "retry";
        return { ok: false, reason: "push-failed", detail: redact(p.out, token).slice(0, 300) };
      }
      await git(["update-ref", remoteRef(b), sha], dir);
      lastFetch.set(b.id, Date.now());
      return { ok: true, path: req.path, sha, merged };
    } finally {
      await git(["worktree", "remove", "--force", wt], dir);
      await fs.rm(wt, { recursive: true, force: true });
    }
  }

  async function write(req: WriteRequest): Promise<WriteResult> {
    const rel = safePagePath(req.path, req.brain.subpath);
    const bare = safePagePath(req.path);
    if (!rel || !bare || bare.toLowerCase() === "log.md" || isRefreshPath(bare)) {
      return { ok: false, reason: "bad-path", detail: "that page name is not allowed" };
    }
    const opId = randomUUID();
    await journal(opId, {
      status: "pending",
      brain: req.brain,
      path: req.path,
      content: req.content,
      baseBlob: req.baseBlob ?? null,
      note: req.note,
      who: req.who,
      notify: req.notify ?? null,
    });
    return serial(req.brain, async () => {
      for (let i = 0; i < 4; i++) {
        let r: WriteResult | "retry";
        try {
          r = await attempt(req, rel, opId);
        } catch (e) {
          r = { ok: false, reason: "push-failed", detail: (e as Error).message.slice(0, 300) };
        }
        if (r === "retry") continue;
        await journal(opId, r.ok ? { status: "pushed", sha: r.sha } : { status: r.reason === "conflict" ? "conflict" : r.reason === "not-allowed" ? "abandoned" : "failed", detail: r.detail });
        if (r.ok) {
          log(`brains: ${req.brain.id} ${req.path} pushed ${r.sha.slice(0, 8)}${r.merged ? " (merged)" : ""}`);
          o.onPushed?.(req.brain);
        }
        return r;
      }
      await journal(opId, { status: "failed", detail: "the brain kept changing under the write" });
      return { ok: false, reason: "push-failed", detail: "the brain kept changing under the write", pendingId: opId };
    });
  }

  /** Writes a restart interrupted. Each is either found already on the remote (its op id is in the
   *  history) or not; the caller decides whether to redo it (after re-checking the person's grant)
   *  and whom to tell. Nothing is redone here. */
  async function interrupted(): Promise<{ id: string; entry: Record<string, unknown>; landed: "yes" | "no" | "unknown" }[]> {
    const dir = journalDir();
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out: { id: string; entry: Record<string, unknown>; landed: "yes" | "no" | "unknown" }[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const entry = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as Record<string, unknown>;
      if (entry.status !== "pending" && entry.status !== "committed") continue;
      const id = n.slice(0, -5);
      const b = entry.brain as BrainRef;
      // The whole history, by the op id in the commit message. An unreachable remote is "unknown",
      // never "not landed": redoing a write that did land would say it twice.
      let landed: "yes" | "no" | "unknown" = "unknown";
      try {
        const d = await serial(b, () => fetchNow(b));
        const g = await git(["log", remoteRef(b), "--fixed-strings", `--grep=Tonoman-Op: ${id}`, "--format=%H", "-n", "1"], d);
        if (g.code === 0) landed = g.out.trim() ? "yes" : "no";
      } catch {
        /* unreachable: unknown */
      }
      out.push({ id, entry, landed });
    }
    return out;
  }

  async function attemptFiles(req: FilesRequest, rels: string[], opId: string): Promise<FilesResult | "retry"> {
    const b = req.brain;
    const token = await o.token(b);
    const dir = await fetchNow(b);
    if (!(await hasRemoteBranch(dir, b))) return { ok: false, reason: "push-failed", detail: "this brain has not been set up yet" };
    if (req.basedOn) {
      const tip = (await git(["rev-parse", remoteRef(b)], dir)).out.trim();
      if (tip !== req.basedOn) return { ok: false, reason: "superseded", detail: "the brain changed after this was worked out" };
    }
    if (req.claim) {
      const rel = safePagePath(req.claim.path, b.subpath);
      const blob = rel ? await blobOf(dir, remoteRef(b), rel) : null;
      if (blob && !req.claim.mine((await git(["cat-file", "blob", blob], dir)).out)) {
        return { ok: false, reason: "taken", detail: `"${req.claim.path}" already holds something else` };
      }
    }
    const logRel = safePagePath("log.md", b.subpath)!;
    for (const rel of [...rels, logRel]) {
      if (!(await plainPath(dir, remoteRef(b), rel))) return { ok: false, reason: "bad-path", detail: "a page sits behind a link in the brain" };
    }
    const wt = path.join(dir, `.tonoman-wt-${opId.slice(0, 8)}`);
    await git(["worktree", "remove", "--force", wt], dir);
    await fs.rm(wt, { recursive: true, force: true });
    const add = await git(["worktree", "add", "--detach", wt, remoteRef(b)], dir);
    if (add.code !== 0) return { ok: false, reason: "push-failed", detail: redact(add.out, token).slice(0, 300) };
    try {
      const root = await fs.realpath(wt);
      for (let i = 0; i < rels.length; i++) {
        const target = path.join(wt, rels[i]);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (!(await fs.realpath(path.dirname(target))).startsWith(root)) return { ok: false, reason: "bad-path", detail: "a page resolves outside the brain" };
        await fs.writeFile(target, req.files[i].content);
      }
      await git(["add", "-A", "--", ...rels], wt);
      // Nothing changed (a re-run of something already filed): no commit, no log line, still a success.
      if ((await git(["diff", "--cached", "--quiet"], wt)).code === 0) return { ok: true, paths: req.files.map((f) => f.path), sha: null };
      if (!req.system) {
        const logFile = path.join(wt, logRel);
        const prior = await fs.readFile(logFile, "utf8").catch(() => "# Log\n\n");
        await fs.mkdir(path.dirname(logFile), { recursive: true });
        await fs.writeFile(logFile, prior + (prior.endsWith("\n") ? "" : "\n") + logLine(now(), req.files[0].path, req.note, req.who));
        await git(["add", "--", logRel], wt);
      }
      const msg = `${req.note.replace(/\s+/g, " ").trim().slice(0, 72) || "Filed by a Talent"}\n\nFor: ${req.who}\nTonoman-Op: ${opId}\n`;
      const c = await git(["commit", "-q", "-F", "-"], wt, msg);
      if (c.code !== 0) return { ok: false, reason: "push-failed", detail: c.out.slice(0, 300) };
      const sha = (await git(["rev-parse", "HEAD"], wt)).out.trim();
      await journal(opId, { status: "committed", sha });
      if (req.authorize && !(await req.authorize().catch(() => false))) {
        return { ok: false, reason: "not-allowed", detail: "this run can no longer write to that brain" };
      }
      const pushed = await git(["push", "--porcelain", "origin", `HEAD:refs/heads/${branchOf(b)}`], wt, undefined, token);
      if (pushed.code !== 0) {
        if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/.test(pushed.out)) return "retry";
        return { ok: false, reason: "push-failed", detail: redact(pushed.out, token).slice(0, 300) };
      }
      await git(["update-ref", remoteRef(b), sha], dir);
      lastFetch.set(b.id, Date.now());
      return { ok: true, paths: req.files.map((f) => f.path), sha };
    } finally {
      await git(["worktree", "remove", "--force", wt], dir);
      await fs.rm(wt, { recursive: true, force: true });
    }
  }

  async function writeFiles(req: FilesRequest): Promise<FilesResult> {
    const rels: string[] = [];
    for (const f of req.files) {
      const rel = safePagePath(f.path, req.brain.subpath);
      const bare = safePagePath(f.path);
      const refreshOwn = isRefreshPath(bare ?? "");
      if (!rel || !bare || bare.toLowerCase() === "log.md" || refreshOwn !== !!req.system) {
        return { ok: false, reason: "bad-path", detail: `"${f.path}" is not a page name that can be written` };
      }
      rels.push(rel);
    }
    if (!rels.length) return { ok: false, reason: "bad-path", detail: "nothing to write" };
    const opId = randomUUID();
    await journal(opId, { status: "pending", kind: "files", system: !!req.system, brain: req.brain, files: req.files, note: req.note, who: req.who, notify: req.notify ?? null });
    return serial(req.brain, async () => {
      for (let i = 0; i < 4; i++) {
        let r: FilesResult | "retry";
        try {
          r = await attemptFiles(req, rels, opId);
        } catch (e) {
          r = { ok: false, reason: "push-failed", detail: (e as Error).message.slice(0, 300) };
        }
        if (r === "retry") continue;
        await journal(opId, r.ok ? { status: "pushed", sha: r.sha } : { status: r.reason === "not-allowed" ? "abandoned" : "failed", detail: r.detail });
        if (r.ok && r.sha && !req.system) o.onPushed?.(req.brain);
        return r;
      }
      await journal(opId, { status: "failed", detail: "the brain kept changing under the write" });
      return { ok: false, reason: "push-failed", detail: "the brain kept changing under the write" };
    });
  }

  /** Run `fn` over a temporary checkout of the brain's pushed state, then remove it. The refresh reads
   *  the brain this way; nothing written there is kept. */
  async function withCheckout<T>(b: BrainRef, fn: (dir: string, revision: string) => Promise<T>): Promise<T> {
    const dir = await serial(b, () => fetchNow(b));
    if (!(await hasRemoteBranch(dir, b))) throw new Error("this brain has not been set up yet");
    const revision = (await git(["rev-parse", remoteRef(b)], dir)).out.trim();
    const wt = path.join(dir, `.tonoman-wt-read-${randomUUID().slice(0, 8)}`);
    const add = await git(["worktree", "add", "--detach", wt, revision], dir);
    if (add.code !== 0) throw new Error(`could not check out the brain: ${add.out.slice(0, 200)}`);
    try {
      return await fn(wt, revision);
    } finally {
      await git(["worktree", "remove", "--force", wt], dir);
      await fs.rm(wt, { recursive: true, force: true });
    }
  }

  /** Worktrees a crash left behind, in every clone. */
  async function cleanup(): Promise<void> {
    const tenants = await fs.readdir(o.root).catch(() => [] as string[]);
    for (const t of tenants) {
      if (t.startsWith("_")) continue;
      for (const id of await fs.readdir(path.join(o.root, t)).catch(() => [] as string[])) {
        const dir = path.join(o.root, t, id);
        for (const e of await fs.readdir(dir).catch(() => [] as string[])) {
          if (e.startsWith(".tonoman-wt-")) await fs.rm(path.join(dir, e), { recursive: true, force: true });
        }
        await git(["worktree", "prune"], dir);
      }
    }
  }

  /** The brain's pushed revision, fetched now; null for a brain with nothing pushed. */
  async function head(b: BrainRef): Promise<string | null> {
    const dir = await serial(b, () => fetchNow(b));
    if (!(await hasRemoteBranch(dir, b))) return null;
    return (await git(["rev-parse", remoteRef(b)], dir)).out.trim() || null;
  }

  /** Close a journal entry after recovery decided what happened. */
  async function settle(id: string, status: "pushed" | "failed" | "abandoned", detail?: string): Promise<void> {
    await journal(id, { status, ...(detail ? { detail } : {}) });
  }

  return { read, list, search, write, writeFiles, withCheckout, interrupted, settle, cleanup, refresh, dirOf, fetchNow, head };
}

export type BrainStore = ReturnType<typeof createStore>;

/** Push a brain's first commit into an empty remote: the seed files, on its branch. Idempotent —
 *  a remote that already has the branch is left alone (a second provisioning attempt adopts it). */
export async function seed(repoUrl: string, token: string, files: Record<string, string>, scratch: string, branch = "main"): Promise<"seeded" | "already"> {
  const probe = await git(["ls-remote", "--heads", repoUrl, branch], undefined, undefined, token);
  if (probe.code !== 0) throw new Error(`cannot reach the new repo: ${redact(probe.out, token).slice(0, 300)}`);
  if (probe.out.trim()) return "already";
  const dir = path.join(scratch, `seed-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await git(["init", "-q", "-b", branch], dir);
    await git(["config", "core.autocrlf", "false"], dir);
    for (const [f, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await fs.writeFile(path.join(dir, f), body);
    }
    await git(["add", "-A"], dir);
    await git(["-c", "user.name=Tonoman", "-c", "user.email=brains@tonoman.com", "commit", "-q", "-m", "A new brain"], dir);
    const p = await git(["push", "-q", repoUrl, `HEAD:refs/heads/${branch}`], dir, undefined, token);
    if (p.code !== 0) {
      const again = await git(["ls-remote", "--heads", repoUrl, branch], undefined, undefined, token);
      if (again.out.trim()) return "already"; // another worker seeded it first
      throw new Error(`seeding failed: ${redact(p.out, token).slice(0, 300)}`);
    }
    return "seeded";
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The seed a new brain starts with (BRAIN-REPO-ON-FIRST-USE). */
export function seedFiles(name: string): Record<string, string> {
  return {
    "BRAIN.md": [
      `# ${name}`,
      "",
      "How this brain is organised, for the people and agents who use it.",
      "",
      "- `index.md` is the map: every topic, and the page or hub that gathers it. Read it first.",
      "- A **hub** is a page that links the pages of one topic. Add a page to its hub.",
      "- `log.md` records every write: when, which page, what, for whom. It is kept by Tonoman.",
      "- `.tonoman/` is Tonoman's map of this brain — topics, hub pages that gather them, pages nothing links to.",
      "  It is rebuilt after changes and never edits your pages.",
      "- One topic per page. Name pages plainly (`AI/typesafe-ai.md`). Link related pages.",
      "- Write what the sources support; cite them. Never file a guess.",
      "",
    ].join("\n"),
    "index.md": [`# ${name} — index`, "", "_Nothing filed yet._", ""].join("\n"),
    "log.md": ["# Log", "", ""].join("\n"),
  };
}
