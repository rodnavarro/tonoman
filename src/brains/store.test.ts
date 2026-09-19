// The brain store against a throwaway local remote (FIX-GIT-REMOTE): reads at pushed revisions,
// journaled writes, two writers, and what a restart finds. Rule names start each test title
// (docs/definition/objects/brain.md in Tonoman Cloud).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore, seed, seedFiles, safePagePath, logLine, redact, type BrainRef } from "./store";

let tmp: string;
let remote: string;
let brain: BrainRef;

const sh = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const storeAt = (name: string, now?: () => Date) =>
  createStore({ root: path.join(tmp, name), token: async () => "", fetchEveryMs: 0, log: () => {}, now });
/** What the remote holds, read through a fresh clone — never through the store under test. */
const remoteFile = (p: string): string | null => {
  const d = mkdtempSync(path.join(tmp, "peek-"));
  sh(["-c", "core.autocrlf=false", "clone", "-q", remote, d]);
  const f = path.join(d, p);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};
const remoteLog = () => sh(["log", "--format=%B", "main"], remote);

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "brains-"));
  remote = path.join(tmp, "remote.git");
  sh(["init", "-q", "--bare", "-b", "main", remote]);
  expect(await seed(remote, "", seedFiles("Ana's brain"), tmp)).toBe("seeded");
  brain = { id: "b-ana", tenant: "test-a", repoUrl: remote };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("a new brain", () => {
  it("BRAIN-REPO-ON-FIRST-USE is seeded with BRAIN.md, index.md and log.md", () => {
    expect(remoteFile("BRAIN.md")).toContain("Ana's brain");
    expect(remoteFile("index.md")).toContain("index");
    expect(remoteFile("log.md")).toContain("# Log");
  });

  it("BRAIN-REPO-ON-FIRST-USE seeding again adopts the repo instead of overwriting it", async () => {
    expect(await seed(remote, "", { "BRAIN.md": "other" }, tmp)).toBe("already");
    expect(remoteFile("BRAIN.md")).toContain("Ana's brain");
  });
});

describe("reading", () => {
  it("BRAIN-WORKSPACE reads the latest pushed state, including another writer's push", async () => {
    const s = storeAt("w1");
    expect(await s.read(brain, "AI/jev.md")).toBeNull();
    // Someone else pushes a page.
    const other = mkdtempSync(path.join(tmp, "other-"));
    sh(["clone", "-q", remote, other]);
    sh(["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "--allow-empty", "-m", "noop"], other);
    execFileSync("git", ["-C", other, "checkout", "-q", "main"]);
    require("node:fs").mkdirSync(path.join(other, "AI"));
    require("node:fs").writeFileSync(path.join(other, "AI", "jev.md"), "# Jev\n");
    sh(["add", "-A"], other);
    sh(["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "jev"], other);
    sh(["push", "-q", "origin", "main"], other);
    const page = await s.read(brain, "AI/jev.md");
    expect(page?.content).toBe("# Jev\n");
    expect(page?.blob).toMatch(/^[0-9a-f]{40}$/);
  });

  it("BRAIN-WORKSPACE the clone keeps no working copy a reader could see half-written", async () => {
    const s = storeAt("w1");
    await s.list(brain);
    const files = readdirSync(s.dirOf(brain)).filter((f) => f !== ".git");
    expect(files).toEqual([]);
  });

  it("BRAIN-INDEX-FIRST search finds lines holding every word, case-insensitively, with their page", async () => {
    const s = storeAt("w1");
    await s.write({ brain, path: "AI/typesafe-ai.md", content: "# TypeSafe AI\nJoined the Jev waitlist.\n", note: "Jev waitlist", who: "Ana" });
    const hits = await s.search(brain, "jev WAITLIST");
    expect(hits.some((h) => h.path === "AI/typesafe-ai.md" && /Jev waitlist/.test(h.text))).toBe(true);
    expect(await s.search(brain, "nothing-like-this")).toEqual([]);
  });

  it("BRAIN-WORKSPACE a brain that lives in a subfolder reads and lists only that folder", async () => {
    const s = storeAt("w1");
    await s.write({ brain, path: "wiki/Topic.md", content: "inside\n", note: "in", who: "Ana" });
    await s.write({ brain, path: "outside.md", content: "outside\n", note: "out", who: "Ana" });
    const sub: BrainRef = { ...brain, id: "b-sub", subpath: "wiki" };
    expect(await s.list(sub)).toEqual(["Topic.md"]);
    expect((await s.read(sub, "Topic.md"))?.content).toBe("inside\n");
    expect(await s.read(sub, "../outside.md")).toBeNull();
  });
});

describe("page names", () => {
  it("BRAIN-GRANTS-DECIDE a page name cannot climb out of the brain or touch git's own files", () => {
    for (const bad of ["../x.md", "/etc/passwd", "C:/x", "a/../../b", ".git/config", "a/.git/hooks/x", ".gitmodules", ""]) {
      expect(safePagePath(bad)).toBeNull();
    }
    expect(safePagePath("AI//typesafe-ai.md")).toBe("AI/typesafe-ai.md");
    expect(safePagePath("x.md", "wiki")).toBe("wiki/x.md");
  });

  it("BRAIN-LOG nobody writes log.md directly; the store keeps it", async () => {
    const r = await storeAt("w1").write({ brain, path: "log.md", content: "forged", note: "x", who: "Ana" });
    expect(r).toMatchObject({ ok: false, reason: "bad-path" });
  });
});

describe("writing", () => {
  it("BRAIN-REMEMBER a write is on the remote when it is confirmed, and says where", async () => {
    const r = await storeAt("w1").write({ brain, path: "AI/typesafe-ai.md", content: "# TypeSafe\n", note: "Jev waitlist", who: "Ana" });
    expect(r).toMatchObject({ ok: true, path: "AI/typesafe-ai.md" });
    expect(remoteFile("AI/typesafe-ai.md")).toBe("# TypeSafe\n");
  });

  it("BRAIN-LOG every write adds one dated line to log.md: what, where, for whom", async () => {
    const at = new Date("2026-09-18T17:53:00Z");
    await storeAt("w1", () => at).write({ brain, path: "AI/typesafe-ai.md", content: "x\n", note: "Joined the Jev waitlist", who: "Ana" });
    expect(remoteFile("log.md")).toContain(logLine(at, "AI/typesafe-ai.md", "Joined the Jev waitlist", "Ana"));
    expect(logLine(at, "a.md", "n", "Ana")).toBe("- 2026-09-18 17:53 UTC · `a.md` · n · for Ana\n");
  });

  it("BRAIN-TWO-WRITERS two workers writing different pages at once both land", async () => {
    const [s1, s2] = [storeAt("w1"), storeAt("w2")];
    const [a, b] = await Promise.all([
      s1.write({ brain, path: "one.md", content: "one\n", note: "one", who: "Ana" }),
      s2.write({ brain, path: "two.md", content: "two\n", note: "two", who: "Ben" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(remoteFile("one.md")).toBe("one\n");
    expect(remoteFile("two.md")).toBe("two\n");
    const lines = remoteFile("log.md")!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
  });

  it("BRAIN-TWO-WRITERS two edits to different lines of one page are both kept", async () => {
    const s1 = storeAt("w1");
    await s1.write({ brain, path: "p.md", content: "a\nb\nc\nd\ne\n", note: "start", who: "Ana" });
    const base = await s1.read(brain, "p.md");
    const s2 = storeAt("w2");
    const baseForBen = await s2.read(brain, "p.md");
    expect((await s1.write({ brain, path: "p.md", content: "A\nb\nc\nd\ne\n", baseBlob: base!.blob, note: "ana", who: "Ana" })).ok).toBe(true);
    const r = await s2.write({ brain, path: "p.md", content: "a\nb\nc\nd\nE\n", baseBlob: baseForBen!.blob, note: "ben", who: "Ben" });
    expect(r).toMatchObject({ ok: true, merged: true });
    expect(remoteFile("p.md")).toBe("A\nb\nc\nd\nE\n");
  });

  it("BRAIN-TWO-WRITERS edits to the same line are not forced: the person is told and their text is kept", async () => {
    const s1 = storeAt("w1");
    await s1.write({ brain, path: "p.md", content: "line\n", note: "start", who: "Ana" });
    const base = await s1.read(brain, "p.md");
    await s1.write({ brain, path: "p.md", content: "Ana's line\n", baseBlob: base!.blob, note: "ana", who: "Ana" });
    const r = await storeAt("w2").write({ brain, path: "p.md", content: "Ben's line\n", baseBlob: base!.blob, note: "ben", who: "Ben" });
    expect(r).toMatchObject({ ok: false, reason: "conflict" });
    expect(remoteFile("p.md")).toBe("Ana's line\n");
    // Ben's text is kept in the journal, under the id he was given.
    const journal = JSON.parse(readFileSync(path.join(tmp, "w2", "_journal", `${(r as { pendingId: string }).pendingId}.json`), "utf8"));
    expect(journal).toMatchObject({ status: "conflict", content: "Ben's line\n" });
  });

  it("BRAIN-TWO-WRITERS a new page never silently replaces one someone else already wrote", async () => {
    await storeAt("w1").write({ brain, path: "p.md", content: "first\n", note: "a", who: "Ana" });
    const r = await storeAt("w2").write({ brain, path: "p.md", content: "second\n", note: "b", who: "Ben" });
    expect(r).toMatchObject({ ok: false, reason: "conflict" });
    expect(remoteFile("p.md")).toBe("first\n");
  });
});

describe("a restart", () => {
  it("BRAIN-WRITE-SURVIVES-RESTART a write that reached the remote before the restart is recognised as landed", async () => {
    const s = storeAt("w1");
    const r = await s.write({ brain, path: "p.md", content: "x\n", note: "n", who: "Ana" });
    expect(r.ok).toBe(true);
    // Pretend the process died after the push but before it recorded the outcome.
    const dir = path.join(tmp, "w1", "_journal");
    const [f] = readdirSync(dir);
    const e = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    require("node:fs").writeFileSync(path.join(dir, f), JSON.stringify({ ...e, status: "committed" }));
    const found = await storeAt("w1").interrupted();
    expect(found).toHaveLength(1);
    expect(found[0].landed).toBe("yes");
    expect(remoteLog()).toContain(`Tonoman-Op: ${found[0].id}`);
  });

  it("BRAIN-WRITE-SURVIVES-RESTART a write that never reached the remote is found, with everything needed to redo it", async () => {
    const dir = path.join(tmp, "w1", "_journal");
    require("node:fs").mkdirSync(dir, { recursive: true });
    const entry = { status: "pending", brain, path: "q.md", content: "q\n", note: "n", who: "Ana", notify: { slackUserId: "UANA" } };
    require("node:fs").writeFileSync(path.join(dir, "op-1.json"), JSON.stringify(entry));
    const found = await storeAt("w1").interrupted();
    expect(found).toEqual([{ id: "op-1", entry: expect.objectContaining({ content: "q\n", notify: { slackUserId: "UANA" } }), landed: "no" }]);
  });
});

describe("the credential", () => {
  it("BRAIN-GRANTS-DECIDE the git credential is never written into the clone's configuration", async () => {
    const s = createStore({ root: path.join(tmp, "w1"), token: async () => "SECRET-TOKEN-123", fetchEveryMs: 0, log: () => {} });
    await s.write({ brain, path: "p.md", content: "x\n", note: "n", who: "Ana" });
    const cfg = readFileSync(path.join(s.dirOf(brain), ".git", "config"), "utf8");
    expect(cfg).not.toContain("SECRET-TOKEN-123");
    expect(cfg).not.toMatch(/extraHeader/i);
    expect(redact("https://tonoman:SECRET-TOKEN-123@host/x failed", "SECRET-TOKEN-123")).not.toContain("SECRET");
  });
});
