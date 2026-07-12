// The substrate-owned, git-backed transcript store (A3). Each conversation is one
// JSONL file — sessions/<conversation>.jsonl — inside the agent's mounted git
// workspace, the same repo that holds its work product. The format is Tonoman's
// own, never the harness's private session files, so memory survives container
// restarts and never has to migrate off a harness internal.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Message, MemoryStore } from "../core/contracts";

const SESSIONS_DIR = "sessions";

/** The default secret-safety `.gitignore` written into every agent memory repo (A3).
 * The agent's data + the tools it builds ARE versioned (and pushed); credentials are
 * NOT — the convention is "any key/token/PEM lives under `secrets/` or is named
 * `*.secret`", and these patterns are ignored so `git add -A` can never sweep a secret
 * into a commit (especially important pushing to GitHub). Written only if absent — an
 * agent that maintains its own .gitignore is left alone. */
export const SECRET_GITIGNORE = `# Tonoman agent memory — secret-safety (NEVER commit credentials).
# Agent data + self-built tool scripts ARE versioned and pushed. Anything secret goes
# under secrets/ (or is named *.secret) and is ignored here so it can't be committed.
secrets/
*.secret
*.local
.env
*.env
*.token
*.key
*.pem
*.credentials.json
.credentials.json
# Build artifacts an agent may create while building tools — NOT versioned (they bloat the
# repo and, on Windows, the symlinks under node_modules/.bin make 'git add -A' fail outright,
# which would otherwise break every turn's memory commit). They persist on the volume regardless.
node_modules/
.cache/
__pycache__/
*.pyc
`;

/** Lines we guarantee are present even in a pre-existing .gitignore (repairs agents created
 * before these were added — esp. node_modules, which otherwise breaks `git add -A`). */
const REQUIRED_IGNORES = ["node_modules/", "secrets/", "*.secret"];

export interface GitStoreOptions {
  /** the workspace git repo (work product lives here too — co-versioned). */
  root: string;
  /** optional https URL pushed to after each commit (with token). */
  remote?: string;
  /** fine-grained PAT applied only at push time via an http extraheader; never
   * written into .git/config and never logged. */
  token?: string;
  /** remote branch to push to; defaults to the repo's current branch. */
  branch?: string;
  authorName?: string;
  authorEmail?: string;
  /** injectable clock for dated session ids (and tests); defaults to wall-clock. */
  clock?: () => Date;
  /** injectable UUID minter for harness session ids (tests); defaults to crypto.randomUUID. */
  uuid?: () => string;
}

export class GitStore implements MemoryStore {
  constructor(private readonly o: GitStoreOptions) {}

  /** Makes root a git repo with a sessions/ dir if it isn't one already, and ensures a
   * secret-safe `.gitignore` exists (written once, never clobbered). Idempotent. */
  async ensureRepo(): Promise<void> {
    if (!this.o.root) throw new Error("memory: empty root");
    await fs.mkdir(path.join(this.o.root, SESSIONS_DIR), { recursive: true });
    await this.ensureGitignore(); // secret-safety before the first commit can ever run
    try {
      const st = await fs.stat(path.join(this.o.root, ".git"));
      if (st.isDirectory()) return; // already a repo
    } catch {
      /* not a repo yet */
    }
    await this.git("init", "-q");
    await this.git("config", "user.name", this.o.authorName || "tonoman agent");
    await this.git("config", "user.email", this.o.authorEmail || "agent@tonoman.local");
  }

  /** Writes the default secret-safety `.gitignore` if the repo doesn't already have one,
   * so credentials can never be swept into a commit (the never-commit-secrets rule). */
  private async ensureGitignore(): Promise<void> {
    const f = path.join(this.o.root, ".gitignore");
    let existing: string | undefined;
    try {
      existing = await fs.readFile(f, "utf8");
    } catch {
      await fs.writeFile(f, SECRET_GITIGNORE, "utf8");
      return;
    }
    // Repair an older .gitignore that predates a required pattern (e.g. node_modules/, which
    // otherwise makes `git add -A` fail and breaks the per-turn memory commit). Append-only —
    // never rewrite what the agent maintains.
    const lines = existing.split(/\r?\n/).map((l) => l.trim());
    const missing = REQUIRED_IGNORES.filter((p) => !lines.includes(p));
    if (missing.length) {
      await fs.appendFile(f, `\n# added by Tonoman (required ignores)\n${missing.join("\n")}\n`, "utf8");
    }
  }

  private now(): Date {
    return (this.o.clock ?? (() => new Date()))();
  }

  /** Per-conversation session dir: sessions/<conv>/ holds the dated session files
   * plus a CURRENT pointer naming the active one. */
  private convDir(conversation: string): string {
    return path.join(this.o.root, SESSIONS_DIR, sanitize(conversation));
  }
  private currentPtr(conversation: string): string {
    return path.join(this.convDir(conversation), "CURRENT");
  }
  /** The pre-session flat layout (sessions/<conv>.jsonl). Read as a fallback so
   * upgrading never drops an agent's existing memory. */
  private legacyFile(conversation: string): string {
    return path.join(this.o.root, SESSIONS_DIR, sanitize(conversation) + ".jsonl");
  }
  private sessionFile(conversation: string, sessionId: string): string {
    return path.join(this.convDir(conversation), sessionId + ".jsonl");
  }

  /** The file to READ for the conversation's active session, or null if there is no
   * history yet. Prefers the explicit CURRENT session, then a legacy flat transcript. */
  private async readPath(conversation: string): Promise<string | null> {
    try {
      const id = (await fs.readFile(this.currentPtr(conversation), "utf8")).trim();
      if (id) return this.sessionFile(conversation, id);
    } catch {
      /* no CURRENT pointer */
    }
    try {
      await fs.stat(this.legacyFile(conversation));
      return this.legacyFile(conversation); // pre-session history, still readable
    } catch {
      return null;
    }
  }

  /** The file to APPEND to — the active session, creating a dated default one (and the
   * CURRENT pointer) the first time if neither a session nor a legacy file exists. */
  private async writePath(conversation: string): Promise<string> {
    const existing = await this.readPath(conversation);
    if (existing) return existing;
    const id = dateId(this.now()); // first message ever → start today's session
    await this.setCurrent(conversation, id);
    return this.sessionFile(conversation, id);
  }

  private async setCurrent(conversation: string, sessionId: string): Promise<void> {
    await fs.mkdir(this.convDir(conversation), { recursive: true });
    await fs.writeFile(this.currentPtr(conversation), sessionId, "utf8");
  }

  /** Starts a fresh session for a conversation (the `/new` command): the next turn
   * reads an empty window. The prior session file is left on disk (history preserved,
   * git-versioned) — amnesia for the agent, not data loss. Returns the new id. */
  async newSession(conversation: string): Promise<string> {
    const id = stampId(this.now());
    await this.setCurrent(conversation, id);
    return id;
  }

  /** The CURRENT substrate session id (or the presumptive default dated one if none is set yet —
   * matching writePath's default so the harness UUID ties to the same session the messages land in). */
  private async currentSessionId(conversation: string): Promise<string> {
    try {
      const id = (await fs.readFile(this.currentPtr(conversation), "utf8")).trim();
      if (id) return id;
    } catch {
      /* no CURRENT pointer yet */
    }
    return dateId(this.now());
  }
  /** Sidecar file holding the harness session UUID (+ created flag) for a substrate session. */
  private ccPath(conversation: string, sessionId: string): string {
    return path.join(this.convDir(conversation), sessionId + ".cc.json");
  }

  /** Maps a stable harness (claude-code) session UUID onto the conversation's CURRENT substrate
   * session, minting one on first use. `/new` rotates the substrate session → a fresh UUID here,
   * so `/new` gives the harness a clean session too. Best-effort; a UUID is not a secret. */
  async harnessSession(conversation: string): Promise<{ id: string; isNew: boolean }> {
    const sid = await this.currentSessionId(conversation);
    const p = this.ccPath(conversation, sid);
    try {
      const j = JSON.parse(await fs.readFile(p, "utf8")) as { uuid: string; started?: boolean };
      if (j.uuid) return { id: j.uuid, isNew: !j.started };
    } catch {
      /* no sidecar yet → mint one */
    }
    const uuid = (this.o.uuid ?? randomUUID)();
    await fs.mkdir(this.convDir(conversation), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ uuid, started: false }), "utf8");
    return { id: uuid, isNew: true };
  }

  /** Marks the current harness session created, so the next turn resumes (not recreates) it. */
  async markHarnessSession(conversation: string): Promise<void> {
    const sid = await this.currentSessionId(conversation);
    const p = this.ccPath(conversation, sid);
    try {
      const j = JSON.parse(await fs.readFile(p, "utf8")) as { uuid: string; started?: boolean };
      if (j.started) return;
      await fs.writeFile(p, JSON.stringify({ ...j, started: true }), "utf8");
    } catch {
      /* best-effort: if the sidecar is missing, the next harnessSession call re-mints it */
    }
  }

  async readWindow(conversation: string, n: number): Promise<Message[]> {
    const p = await this.readPath(conversation);
    if (!p) return []; // no history yet (or a freshly /new'd, still-empty session)
    let raw: string;
    try {
      raw = await fs.readFile(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // session file not written yet
      throw new Error(`memory: open transcript: ${(e as Error).message}`);
    }
    const msgs: Message[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      msgs.push(JSON.parse(t) as Message);
    }
    if (n > 0 && msgs.length > n) return msgs.slice(msgs.length - n);
    return msgs;
  }

  async append(conversation: string, ...msgs: Message[]): Promise<void> {
    if (msgs.length === 0) return;
    const p = await this.writePath(conversation);
    await fs.mkdir(path.dirname(p), { recursive: true });
    // one JSON object per line, trailing newline per message (matches the Go store).
    const body = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await fs.appendFile(p, body, "utf8");
  }

  /** Stages the whole workspace, commits, and pushes when a remote+token are set.
   * A no-op commit (nothing changed) is not an error. */
  async commit(message: string): Promise<void> {
    try {
      await this.git("add", "-A");
      try {
        await this.git("commit", "-q", "-m", message);
      } catch (e) {
        if (isNothingToCommit((e as Error).message)) return; // nothing to commit is success
        throw e;
      }
      if (!this.o.remote || !this.o.token) return; // local-only is fine (A3)
      await this.push();
    } catch (e) {
      // Memory is BEST-EFFORT: a failed add/commit/push must NEVER abort the agent's turn
      // (the reply matters more than the snapshot). A bad file in the workspace — e.g. a
      // node_modules symlink git can't index — used to throw here and kill the turn. Log,
      // don't throw; the next turn's commit retries once the cause clears (.gitignore, etc.).
      console.error(`gateway: memory commit skipped (${message}): ${(e as Error).message}`);
    }
  }

  private async push(): Promise<void> {
    try {
      await this.git("remote", "get-url", "origin");
    } catch {
      await this.git("remote", "add", "origin", this.o.remote!);
    }
    const branch = this.o.branch || (await this.git("rev-parse", "--abbrev-ref", "HEAD")).trim();
    const auth = Buffer.from(`x-access-token:${this.o.token}`).toString("base64");
    // push current HEAD to the (possibly configured) remote branch.
    await this.git("-c", `http.extraheader=Authorization: Basic ${auth}`, "push", "-u", "origin", `HEAD:${branch}`);
  }

  /** Runs a git command rooted at the workspace and returns combined output. */
  private git(...args: string[]): Promise<string> {
    const full = ["-C", this.o.root, ...args];
    return new Promise((resolve, reject) => {
      execFile("git", full, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout || "") + (stderr || "");
        if (err) {
          // Never echo args: the http.extraheader push carries the token.
          reject(new Error(`memory: git ${args[0]} failed: ${out.trim()}`));
        } else {
          resolve(out);
        }
      });
    });
  }
}

function isNothingToCommit(out: string): boolean {
  const o = out.toLowerCase();
  return o.includes("nothing to commit") || o.includes("no changes added");
}

/** Reduces an arbitrary conversation id to a safe single path component. */
function sanitize(s: string): string {
  if (!s) return "default";
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** The default (first) session of a day: `YYYY-MM-DD` — a dated cut-off a reader can
 * see at a glance when the workspace is pushed to GitHub (ws-session-dated). */
function dateId(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A fresh session id for `/new`: dated AND unique to the second+ms so multiple
 * resets in a day don't collide — `YYYY-MM-DDtHH-MM-SS-mmm`. */
function stampId(d: Date): string {
  return d.toISOString().replace("T", "t").replace(/[:.]/g, "-").replace("Z", "");
}
