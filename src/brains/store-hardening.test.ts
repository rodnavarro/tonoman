// The store's defences, each found in review (Astra, Sep 18): links, the log's aliases, a brain that
// moved, access that changed before the push, a restart that cannot reach the remote, and "latest".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real git on every test: slower than the 5s default when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore, seed, seedFiles, type BrainRef } from "./store";

let tmp: string;
let remote: string;
let brain: BrainRef;
const sh = (args: string[], cwd?: string, input?: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
const store = (name: string, fetchEveryMs = 0) => createStore({ root: path.join(tmp, name), token: async () => "", fetchEveryMs, log: () => {} });
const other = () => {
  const d = mkdtempSync(path.join(tmp, "other-"));
  sh(["-c", "core.autocrlf=false", "clone", "-q", remote, d]);
  sh(["config", "user.name", "x"], d);
  sh(["config", "user.email", "x@x"], d);
  return d;
};
const remoteFile = (p: string) => {
  const d = other();
  const f = path.join(d, p);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "brains-h-"));
  remote = path.join(tmp, "remote.git");
  sh(["init", "-q", "--bare", "-b", "main", remote]);
  await seed(remote, "", seedFiles("Ana's brain"), tmp);
  brain = { id: "b-ana", tenant: "test-a", repoUrl: remote };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("links in a brain", () => {
  it("BRAIN-GRANTS-DECIDE a write is refused when its path goes through a link somebody committed", async () => {
    const d = other();
    // A symlink entry, made the portable way: straight into the index.
    const blob = sh(["hash-object", "-w", "--stdin"], d, "../../elsewhere").trim();
    sh(["update-index", "--add", "--cacheinfo", `120000,${blob},shared`], d);
    sh(["commit", "-q", "-m", "a link"], d);
    sh(["push", "-q", "origin", "HEAD:main"], d);
    const s = store("w1");
    expect(await s.write({ brain, path: "shared/page.md", content: "x\n", note: "n", who: "Ana" })).toMatchObject({ ok: false, reason: "bad-path" });
    expect(await s.write({ brain, path: "shared", content: "x\n", note: "n", who: "Ana" })).toMatchObject({ ok: false, reason: "bad-path" });
  });
});

describe("the log", () => {
  it("BRAIN-LOG log.md cannot be written under any spelling of its name", async () => {
    const s = store("w1");
    for (const alias of ["log.md", "LOG.md", "log.md ", "./log.md", "a/../log.md", "/log.md"]) {
      expect((await s.write({ brain, path: alias, content: "forged", note: "x", who: "Ana" })).ok).toBe(false);
    }
    expect(remoteFile("log.md")).toBe("# Log\n\n");
  });
});

describe("a brain that moved", () => {
  it("BRAIN-MIGRATION when a brain is repointed, the next read comes from its new repo", async () => {
    const s = store("w1");
    await s.write({ brain, path: "where.md", content: "old repo\n", note: "n", who: "Ana" });
    const moved = path.join(tmp, "moved.git");
    sh(["init", "-q", "--bare", "-b", "main", moved]);
    await seed(moved, "", { "where.md": "new repo\n", "log.md": "# Log\n" }, tmp);
    expect((await s.read({ ...brain, repoUrl: moved }, "where.md"))?.content).toBe("new repo\n");
  });
});

describe("access that changes before the push", () => {
  it("BRAIN-GRANT-TIMING a write whose person lost access before the push is not pushed", async () => {
    const r = await store("w1").write({ brain, path: "p.md", content: "x\n", note: "n", who: "Ana", authorize: async () => false });
    expect(r).toMatchObject({ ok: false, reason: "not-allowed" });
    expect(remoteFile("p.md")).toBeNull();
  });
});

describe("a restart", () => {
  it("BRAIN-WRITE-SURVIVES-RESTART a write is found as landed even behind many later commits", async () => {
    const s = store("w1");
    await s.write({ brain, path: "first.md", content: "x\n", note: "n", who: "Ana" });
    const d = path.join(tmp, "w1", "_journal");
    const [f] = require("node:fs").readdirSync(d);
    const e = JSON.parse(readFileSync(path.join(d, f), "utf8"));
    writeFileSync(path.join(d, f), JSON.stringify({ ...e, status: "committed" }));
    for (let i = 0; i < 5; i++) await s.write({ brain, path: `later-${i}.md`, content: `${i}\n`, note: "n", who: "Ana" });
    const found = (await s.interrupted()).find((x) => x.id === f.slice(0, -5));
    expect(found?.landed).toBe("yes");
  }, 60_000);

  it("BRAIN-WRITE-SURVIVES-RESTART when the remote cannot be reached, the outcome is unknown — never 'not landed'", async () => {
    const d = path.join(tmp, "w1", "_journal");
    require("node:fs").mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "op-x.json"), JSON.stringify({ status: "pending", brain: { ...brain, repoUrl: path.join(tmp, "gone.git") }, path: "q.md" }));
    const [found] = await store("w1").interrupted();
    expect(found.landed).toBe("unknown");
  });
});

describe("latest", () => {
  it("BRAIN-WORKSPACE a fresh look sees another worker's push even inside the cache window", async () => {
    const s = store("w1", 60_000);
    await s.read(brain, "index.md"); // warms the cache
    const d = other();
    writeFileSync(path.join(d, "new.md"), "just pushed\n");
    sh(["add", "-A"], d);
    sh(["commit", "-q", "-m", "new"], d);
    sh(["push", "-q", "origin", "HEAD:main"], d);
    expect(await s.read(brain, "new.md")).toBeNull(); // the cache says nothing new
    await s.refresh(brain);
    expect((await s.read(brain, "new.md"))?.content).toBe("just pushed\n");
  });
});

describe("where the worker runs", () => {
  it("BRAIN-REPO-ON-FIRST-USE a new repo is seeded even from inside a broken git checkout", async () => {
    const inside = mkdtempSync(path.join(tmp, "live-"));
    writeFileSync(path.join(inside, ".git"), "gitdir: C:/somewhere/else/.bare/worktrees/agent-a\n");
    const fresh = path.join(tmp, "fresh.git");
    sh(["init", "-q", "--bare", "-b", "main", fresh]);
    const was = process.cwd();
    process.chdir(inside);
    try {
      expect(await seed(fresh, "", seedFiles("Ben's brain"), tmp)).toBe("seeded");
      await expect(store("s-inside").read({ id: "b-ben", tenant: "test-a", repoUrl: fresh }, "BRAIN.md")).resolves.not.toBeNull();
    } finally {
      process.chdir(was);
    }
  });
});
