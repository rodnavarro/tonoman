// A Talent filing into a brain (BRAIN-TALENT-TARGET): the recap's page and transcript as one commit
// with a log line, named as the recap names them, never over another recording's page.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore, seed, seedFiles, type BrainRef } from "./store";
import { publishRecapToBrain } from "./talentpublish";

let tmp: string;
let remote: string;
let brain: BrainRef;
const sh = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const remoteFile = (p: string) => {
  const d = mkdtempSync(path.join(tmp, "peek-"));
  sh(["-c", "core.autocrlf=false", "clone", "-q", remote, d]);
  const f = path.join(d, p);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};
const commits = () => Number(sh(["rev-list", "--count", "main"], remote).trim());

const rec = (id: string, startTime: number) => ({
  id,
  title: "Offsite planning",
  startTime,
  endTime: startTime + 30 * 60_000,
  duration: 30 * 60_000,
  stamp: "2026-09-18T1500",
});
const recapOf = { summary: "Planned the offsite.", highlights: ["Offsite on the 14th"], route: "unclassified" };

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "brains-t-"));
  remote = path.join(tmp, "remote.git");
  sh(["init", "-q", "--bare", "-b", "main", remote]);
  await seed(remote, "", seedFiles("Ana's brain"), tmp);
  brain = { id: "b-ana", tenant: "test-a", repoUrl: remote };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const file = (store: ReturnType<typeof createStore>, r: ReturnType<typeof rec>, authorize = async () => true) =>
  publishRecapToBrain(store, { brain, who: "UANA", authorize }, { rec: r as never, recap: recapOf as never, transcript: "hello world", timezone: "UTC" });

describe("a recap filed into a brain", () => {
  it("BRAIN-TALENT-TARGET the page and its transcript land together, in one commit, with a log line", async () => {
    const s = createStore({ root: path.join(tmp, "w"), token: async () => "", fetchEveryMs: 0, log: () => {} });
    const before = commits();
    const r = await file(s, rec("rec-1", Date.UTC(2026, 8, 18, 15)));
    expect(r.result.ok).toBe(true);
    expect(commits()).toBe(before + 1);
    expect(remoteFile(r.page)).toContain("recording_id: rec-1");
    expect(remoteFile(r.transcript)).toContain("hello world");
    expect(remoteFile("log.md")).toMatch(/Meeting recap: Offsite planning .* for UANA/);
  });

  it("BRAIN-TALENT-TARGET filing the same recording again changes nothing", async () => {
    const s = createStore({ root: path.join(tmp, "w"), token: async () => "", fetchEveryMs: 0, log: () => {} });
    const first = await file(s, rec("rec-1", Date.UTC(2026, 8, 18, 15)));
    const n = commits();
    const again = await file(s, rec("rec-1", Date.UTC(2026, 8, 18, 15)));
    expect(again.page).toBe(first.page);
    expect(again.result).toMatchObject({ ok: true, sha: null });
    expect(commits()).toBe(n);
  });

  it("BRAIN-TALENT-TARGET another recording in the same minute files beside the first, never over it", async () => {
    const s = createStore({ root: path.join(tmp, "w"), token: async () => "", fetchEveryMs: 0, log: () => {} });
    const a = await file(s, rec("rec-1", Date.UTC(2026, 8, 18, 15)));
    const b = await file(s, rec("rec-2", Date.UTC(2026, 8, 18, 15, 0, 30)));
    expect(b.page).not.toBe(a.page);
    expect(remoteFile(a.page)).toContain("recording_id: rec-1");
    expect(remoteFile(b.page)).toContain("recording_id: rec-2");
  });

  it("BRAIN-TALENT-TARGET a run that can no longer write there files nothing", async () => {
    const s = createStore({ root: path.join(tmp, "w"), token: async () => "", fetchEveryMs: 0, log: () => {} });
    const n = commits();
    const r = await file(s, rec("rec-1", Date.UTC(2026, 8, 18, 15)), async () => false);
    expect(r.result).toMatchObject({ ok: false, reason: "not-allowed" });
    expect(commits()).toBe(n);
  });
});
