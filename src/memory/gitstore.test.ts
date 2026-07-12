import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitStore, SECRET_GITIGNORE } from "./gitstore";
import type { Message } from "../core/contracts";

let dir: string;
let clockVal: Date;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tonoman-gitstore-"));
  clockVal = new Date("2026-06-14T10:00:00.000Z");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function store(): GitStore {
  return new GitStore({ root: dir, clock: () => clockVal });
}
function msg(role: "user" | "assistant", text: string): Message {
  return { role, text, ts: "2026-06-14T10:00:00Z" };
}
function texts(ms: Message[]): string[] {
  return ms.map((m) => m.text);
}

describe("GitStore — dated sessions + /new rotation (ws-session-dated, gw-command-new-session)", () => {
  it("writes a dated default session and round-trips the window", async () => {
    const s = store();
    await s.append("tg:42", msg("user", "hello"), msg("assistant", "hi"));
    expect(texts(await s.readWindow("tg:42", 0))).toEqual(["hello", "hi"]);
    // stored as sessions/<conv>/<YYYY-MM-DD>.jsonl (the dated cut-off)
    const f = path.join(dir, "sessions", "tg_42", "2026-06-14.jsonl");
    await expect(fs.stat(f)).resolves.toBeTruthy();
  });

  it("/new rotates to an empty session; the prior transcript is preserved on disk", async () => {
    const s = store();
    await s.append("tg:42", msg("user", "old-1"), msg("assistant", "old-2"));

    clockVal = new Date("2026-06-14T11:30:00.000Z");
    const newId = await s.newSession("tg:42");
    expect(newId).toBe("2026-06-14t11-30-00-000"); // dated AND unique

    // amnesia: the next read sees nothing
    expect(await s.readWindow("tg:42", 0)).toEqual([]);

    // new turn writes only into the fresh session
    await s.append("tg:42", msg("user", "fresh-1"));
    expect(texts(await s.readWindow("tg:42", 0))).toEqual(["fresh-1"]);

    // the old session file still exists with its history (not deleted)
    const oldFile = path.join(dir, "sessions", "tg_42", "2026-06-14.jsonl");
    const oldRaw = await fs.readFile(oldFile, "utf8");
    expect(oldRaw).toContain("old-1");
    expect(oldRaw).toContain("old-2");
    expect(oldRaw).not.toContain("fresh-1");
  });

  it("reads a legacy flat transcript when there's no session pointer (no silent memory reset on upgrade)", async () => {
    // simulate the pre-session layout: sessions/<conv>.jsonl
    await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "sessions", "tg_42.jsonl"),
      JSON.stringify(msg("user", "legacy-msg")) + "\n",
      "utf8",
    );

    const s = store();
    expect(texts(await s.readWindow("tg:42", 0))).toEqual(["legacy-msg"]);

    // /new rotates away from the legacy file (which stays on disk)
    clockVal = new Date("2026-06-14T12:00:00.000Z");
    await s.newSession("tg:42");
    expect(await s.readWindow("tg:42", 0)).toEqual([]);
    await expect(fs.stat(path.join(dir, "sessions", "tg_42.jsonl"))).resolves.toBeTruthy();
  });

  it("honours the window size n", async () => {
    const s = store();
    await s.append("c", msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d"));
    expect(texts(await s.readWindow("c", 2))).toEqual(["c", "d"]);
  });

  it("returns an empty window for an unknown conversation", async () => {
    expect(await store().readWindow("never-seen", 10)).toEqual([]);
  });
});

describe("GitStore — harness session mapping (session-resume: --session-id/--resume)", () => {
  function storeWithUuids(ids: string[]): GitStore {
    let i = 0;
    return new GitStore({ root: dir, clock: () => clockVal, uuid: () => ids[Math.min(i++, ids.length - 1)] });
  }

  it("mints a UUID for the current session (isNew), holds it steady, flips to resume after markHarnessSession", async () => {
    const s = storeWithUuids(["uuid-A", "uuid-B"]);
    const first = await s.harnessSession("tg:9");
    expect(first).toEqual({ id: "uuid-A", isNew: true }); // create
    expect(await s.harnessSession("tg:9")).toEqual({ id: "uuid-A", isNew: true }); // still create (not marked)
    await s.markHarnessSession("tg:9");
    expect(await s.harnessSession("tg:9")).toEqual({ id: "uuid-A", isNew: false }); // now resume, same id
  });

  it("/new rotates the substrate session → a fresh harness UUID (clean session for the harness too)", async () => {
    const s = storeWithUuids(["uuid-A", "uuid-B"]);
    await s.harnessSession("tg:9");
    await s.markHarnessSession("tg:9");
    await s.newSession("tg:9"); // /new
    expect(await s.harnessSession("tg:9")).toEqual({ id: "uuid-B", isNew: true }); // brand-new session
  });
});

describe("GitStore — secret-safe .gitignore (cfg-no-secrets / ws-git-secrets)", () => {
  it("ensureRepo writes a default .gitignore that ignores the credential patterns", async () => {
    const s = store();
    await s.ensureRepo();
    const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toBe(SECRET_GITIGNORE);
    for (const pat of ["secrets/", "*.secret", ".env", "*.token", "*.pem", "*.credentials.json"]) {
      expect(gi).toContain(pat);
    }
  });

  it("preserves an agent's own .gitignore (append-only) — keeps its lines, adds only missing required ignores", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), "custom\n", "utf8");
    await store().ensureRepo();
    const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("custom"); // the agent's line is never removed/overwritten
    expect(gi).toContain("node_modules/"); // but a required safety ignore is appended (or git add -A breaks)
  });

  it("leaves a .gitignore that already has the required ignores untouched", async () => {
    const body = "custom\nnode_modules/\nsecrets/\n*.secret\n";
    await fs.writeFile(path.join(dir, ".gitignore"), body, "utf8");
    await store().ensureRepo();
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf8")).toBe(body); // nothing to add → unchanged
  });

  it("a secret under secrets/ is NOT tracked, but agent data + tools ARE (git add -A can't sweep it)", async () => {
    const s = store();
    await s.ensureRepo();
    await fs.mkdir(path.join(dir, "secrets"), { recursive: true });
    await fs.writeFile(path.join(dir, "secrets", "api.token"), "SUPER_SECRET", "utf8");
    await fs.mkdir(path.join(dir, "tools"), { recursive: true });
    await fs.writeFile(path.join(dir, "tools", "send.js"), "// non-secret tool", "utf8");
    await fs.writeFile(path.join(dir, "contacts.csv"), "name\n", "utf8");
    await s.commit("test: data + tool + secret present");
    // The tracked set includes the data + tool, never the secret.
    const tracked = await store2(dir).lsFiles();
    expect(tracked).toContain("tools/send.js");
    expect(tracked).toContain("contacts.csv");
    expect(tracked.some((f) => f.includes("secrets/") || f.endsWith(".token"))).toBe(false);
  });
});

// turn-safety: memory must never abort a turn, and node_modules must never break `git add -A`.
describe("GitStore — resilient commit + ignore repair (turn-safety)", () => {
  it("commit is best-effort: a non-repo root logs and does NOT throw (never aborts a turn)", async () => {
    const s = new GitStore({ root: dir, clock: () => clockVal }); // ensureRepo NOT called → no .git
    await fs.writeFile(path.join(dir, "x.txt"), "hi", "utf8");
    await expect(s.commit("no repo here")).resolves.toBeUndefined(); // logs, doesn't throw
  });

  it("repairs a pre-existing .gitignore missing node_modules/ (the git-add-fail cause)", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), "secrets/\n*.secret\n", "utf8"); // old, pre-node_modules
    await store().ensureRepo();
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf8")).toContain("node_modules/");
  });

  it("node_modules in the workspace is ignored — tools commit, node_modules never tracked", async () => {
    const s = store();
    await s.ensureRepo();
    await fs.mkdir(path.join(dir, "tools", "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(path.join(dir, "tools", "node_modules", ".bin", "x"), "bin", "utf8");
    await fs.writeFile(path.join(dir, "tools", "run.mjs"), "// tool", "utf8");
    await s.commit("tools present");
    const tracked = await store2(dir).lsFiles();
    expect(tracked).toContain("tools/run.mjs");
    expect(tracked.some((f) => f.includes("node_modules"))).toBe(false);
  });
});

// small helper exposing `git ls-files` for the secret-safety assertion
function store2(root: string) {
  const { execFile } = require("node:child_process");
  return {
    lsFiles: (): Promise<string[]> =>
      new Promise((resolve) =>
        execFile("git", ["-C", root, "ls-files"], { windowsHide: true }, (_e: unknown, so: Buffer) =>
          resolve((so?.toString() ?? "").split("\n").map((s) => s.trim()).filter(Boolean)),
        ),
      ),
  };
}
