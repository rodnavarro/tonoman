// A brain organising itself: the map, connections by topic from a scripted model (FIX-SCRIPTED-MODEL)
// over pages that never link to each other (FIX-UNLINKED-PAGES), and what happens when the model is not
// there. Titles start with the rule they prove.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real git against real repos: slow when the whole suite runs at once, not wrong.
vi.setConfig({ testTimeout: 30_000 });
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore, seed, type BrainRef } from "./store";
import { refreshBrain, createRefreshQueue, relatedEdges, rootedLinks, type RefreshPublish } from "./refresh";

let tmp: string;
let remote: string;
let brain: BrainRef;
let pushed: string[];
const sh = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const remoteFile = (p: string) => {
  const d = mkdtempSync(path.join(tmp, "peek-"));
  sh(["-c", "core.autocrlf=false", "clone", "-q", remote, d]);
  const f = path.join(d, p);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};
const commits = () => Number(sh(["rev-list", "--count", "main"], remote).trim());

/** The scripted model: topics from what a page says, every time the same. */
const scripted = (calls: string[]) => async (_system: string, user: string) => {
  calls.push(user.split("\n")[0]!);
  const tags = /typesafe/i.test(user) ? ["typesafe"] : /offsite/i.test(user) ? ["offsite"] : ["misc"];
  return JSON.stringify({ summary: user.split("\n")[2]?.slice(0, 60) ?? "a page", tags });
};

let store: ReturnType<typeof createStore>;
beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "brains-r-"));
  remote = path.join(tmp, "remote.git");
  sh(["init", "-q", "--bare", "-b", "main", remote]);
  await seed(
    remote,
    "",
    {
      "BRAIN.md": "# Ana's brain\n",
      "index.md": "# index\n",
      "log.md": "# Log\n",
      "AI/jev.md": "# Jev\n\nTypeSafe's first System One model.\n",
      "AI/pricing.md": "# Pricing\n\nTypeSafe charges per input token.\n",
      "Team/offsite.md": "# Offsite\n\nThe offsite is on the 14th.\n",
    },
    tmp,
  );
  brain = { id: "b-ana", tenant: "test-a", repoUrl: remote };
  pushed = [];
  store = createStore({ root: path.join(tmp, "w"), token: async () => "", fetchEveryMs: 0, log: () => {}, onPushed: (b) => pushed.push(b.id) });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const deps = (over: Partial<Parameters<typeof refreshBrain>[0]> = {}, published: RefreshPublish[] = []) => ({
  store,
  publish: async (_id: string, p: RefreshPublish) => void published.push(p),
  log: () => {},
  ...over,
});

describe("connections", () => {
  it("BRAIN-CONNECTIONS pages about the same topic are connected though nothing links them, and gathered in a hub", async () => {
    const published: RefreshPublish[] = [];
    const r = await refreshBrain(deps({ infer: scripted([]), available: async () => true }, published), brain, "Ana's brain");
    expect(r.state).toBe("fresh");
    expect(r.graph!.edges).toContainEqual({ source: "AI/jev", target: "AI/pricing", kind: "related" });
    expect(remoteFile(".tonoman/hubs/typesafe.md")).toMatch(/Jev[\s\S]*Pricing/);
    // The pages themselves are untouched.
    expect(remoteFile("AI/jev.md")).toBe("# Jev\n\nTypeSafe's first System One model.\n");
  });

  it("BRAIN-CONNECTIONS a topic shared by one page alone connects nothing", () => {
    const notes = new Map([["a", { blob: "1", summary: "", tags: ["x"] }], ["b", { blob: "2", summary: "", tags: ["y"] }]]);
    expect(relatedEdges(notes, []).edges).toEqual([]);
  });
});

describe("the files an agent follows", () => {
  it("BRAIN-TRAVERSAL-FILES a page's ordinary relative links are part of the map", async () => {
    await store.write({ brain, path: "Team/plan.md", content: "# Plan\n\nSee [the offsite](offsite.md) and [Jev](../AI/jev.md), [out](../../x.md), [web](https://x.com/a.md).\n", note: "plan", who: "Ana" });
    const r = await refreshBrain(deps(), brain, "Ana's brain");
    const links = r.graph!.edges.filter((e) => e.kind !== "related" && e.source === "Team/plan").map((e) => e.target).sort();
    expect(links).toEqual(["AI/jev", "Team/offsite"]);
    expect(remoteFile(".tonoman/orphans.md")).not.toContain("Team/offsite.md");
  });

  it("BRAIN-TRAVERSAL-FILES links resolve from the page's own folder, and from the brain's root inside a shared repo", () => {
    expect(rootedLinks("Team/plan", "[a](offsite.md) [b](../AI/jev.md#x) [c](/AI/p) [d](#top) [e](mailto:a@b.c)")).toBe(
      "[a](/Team/offsite.md) [b](/AI/jev.md#x) [c](/AI/p) [d](#top) [e](mailto:a@b.c)",
    );
    expect(rootedLinks("plan", "[a](/Brains/Ana/AI/jev.md) [b](../other.md)", "Brains/Ana")).toBe("[a](/AI/jev.md) [b](../other.md)");
  });

  it("BRAIN-TRAVERSAL-FILES each refresh writes the map, the hubs, the orphan list and a log line, under .tonoman/", async () => {
    await refreshBrain(deps({ infer: scripted([]), available: async () => true }), brain, "Ana's brain");
    expect(remoteFile(".tonoman/index.md")).toMatch(/# Ana's brain — map[\s\S]*## Topics[\s\S]*\[typesafe\]\(hubs\/typesafe\.md\) — 2 pages/);
    expect(remoteFile(".tonoman/orphans.md")).toContain("Team/offsite.md");
    expect(remoteFile(".tonoman/log.md")).toMatch(/3 pages newly read/);
  });

  it("BRAIN-REFRESH-NO-LOOP the refresh's own write does not start another refresh, and adds no line to the brain's log", async () => {
    await refreshBrain(deps({ infer: scripted([]), available: async () => true }), brain, "Ana's brain");
    expect(pushed).toEqual([]);
    expect(remoteFile("log.md")).toBe("# Log\n");
    await store.write({ brain, path: "AI/new.md", content: "# New\n", note: "n", who: "Ana" });
    expect(pushed).toEqual(["b-ana"]);
  });

  it("BRAIN-TRAVERSAL-FILES nobody but the refresh writes inside .tonoman/", async () => {
    expect(await store.write({ brain, path: ".tonoman/index.md", content: "forged", note: "x", who: "Ana" })).toMatchObject({ ok: false, reason: "bad-path" });
    expect(await store.writeFiles({ brain, files: [{ path: ".tonoman/x.md", content: "x" }], note: "x", who: "Ana" })).toMatchObject({ ok: false, reason: "bad-path" });
  });
});

describe("the local model", () => {
  it("BRAIN-LOCAL-MODEL a page the model has read is not read again until it changes", async () => {
    const calls: string[] = [];
    await refreshBrain(deps({ infer: scripted(calls), available: async () => true }), brain, "Ana's brain");
    expect(calls).toHaveLength(3);
    calls.length = 0;
    await refreshBrain(deps({ infer: scripted(calls), available: async () => true }), brain, "Ana's brain");
    expect(calls).toEqual([]);
    await store.write({ brain, path: "AI/jev.md", content: "# Jev\n\nTypeSafe's model, now in beta.\n", baseBlob: (await store.read(brain, "AI/jev.md"))!.blob, note: "n", who: "Ana" });
    await refreshBrain(deps({ infer: scripted(calls), available: async () => true }), brain, "Ana's brain");
    expect(calls).toEqual(["# jev"]);
  }, 60_000);

  it("BRAIN-LOCAL-MODEL when the local model is not there, the refresh waits: nothing is written and the brain shows stale", async () => {
    const before = commits();
    const published: RefreshPublish[] = [];
    const sent: string[] = [];
    const r = await refreshBrain(deps({ infer: async (s, u) => (sent.push(u), "{}"), available: async () => false }, published), brain, "Ana's brain");
    expect(r).toMatchObject({ state: "stale", detail: "waiting for the local model" });
    expect(published.map((p) => p.state)).toEqual(["stale"]);
    expect(sent).toEqual([]); // not one page went anywhere
    expect(commits()).toBe(before);
  });

  it("BRAIN-BACKGROUND-REFRESH with no local model set up, the brain is still mapped, and says it is not connected", async () => {
    const r = await refreshBrain(deps(), brain, "Ana's brain");
    expect(r.state).toBe("fresh");
    expect(r.detail).toMatch(/not connected/);
    expect(r.graph!.edges.filter((e) => e.kind === "related")).toEqual([]);
  });
});

describe("in the background", () => {
  it("BRAIN-BACKGROUND-REFRESH a burst of pushes is refreshed once, after they settle, and the brain shows stale meanwhile", async () => {
    const runs: string[] = [];
    const stale: string[] = [];
    const q = createRefreshQueue({ run: async (b) => (runs.push(b.id), { state: "fresh" }), stale: async (b) => void stale.push(b.id), delayMs: 30, log: () => {} });
    q.touch(brain);
    q.touch(brain);
    q.touch(brain);
    await new Promise((r) => setTimeout(r, 80));
    await q.idle();
    expect(runs).toEqual(["b-ana"]);
    expect(stale.length).toBeGreaterThan(0);
    q.stop();
  });

  it("BRAIN-LOCAL-MODEL a refresh that waited for the model is tried again later", async () => {
    let n = 0;
    const q = createRefreshQueue({ run: async () => ({ state: n++ === 0 ? "stale" : "fresh" }), delayMs: 10, retryMs: 20, log: () => {} });
    q.touch(brain);
    await new Promise((r) => setTimeout(r, 100));
    await q.idle();
    expect(n).toBe(2);
    q.stop();
  });
});

/** Commit to the remote as somebody with a plain git client would — a symlink included. */
const commitRaw = (entries: { path: string; mode?: string; content: string }[]) => {
  const d = mkdtempSync(path.join(tmp, "raw-"));
  sh(["-c", "core.autocrlf=false", "clone", "-q", remote, d]);
  sh(["config", "user.name", "x"], d);
  sh(["config", "user.email", "x@x"], d);
  for (const e of entries) {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: d, input: e.content, encoding: "utf8" }).trim();
    sh(["update-index", "--add", "--cacheinfo", `${e.mode ?? "100644"},${blob},${e.path}`], d);
  }
  sh(["commit", "-q", "-m", "raw"], d);
  sh(["push", "-q", "origin", "HEAD:main"], d);
};

describe("found in review (Astra, Sep 19)", () => {
  it("BRAIN-NO-DISCLOSURE a committed symlink is never read, sent to the model, or remembered — not even the refresh's own cache", async () => {
    const outside = path.join(tmp, "other-brain-secret.md");
    writeFileSync(outside, "# Secret\n\nTOPSECRET other brain content\n");
    commitRaw([
      { path: "AI/leak.md", mode: "120000", content: outside },
      { path: ".tonoman/pages.json", mode: "120000", content: outside },
    ]);
    const sent: string[] = [];
    const r = await refreshBrain(deps({ infer: async (s, u) => (sent.push(u), JSON.stringify({ summary: "x", tags: ["misc"] })), available: async () => true }), brain, "Ana's brain");
    expect(r.state).toBe("fresh");
    expect(sent.join("\n")).not.toMatch(/leak|TOPSECRET|other-brain-secret/);
    expect(r.graph!.nodes.map((n) => n.id)).not.toContain("AI/leak");
    expect(remoteFile(".tonoman/pages.json")).not.toMatch(/leak|TOPSECRET/);
  });

  it("BRAIN-BACKGROUND-REFRESH a brain bigger than one batch shows how far it got, not fresh, and carries on until every page is read", async () => {
    const published: RefreshPublish[] = [];
    const first = await refreshBrain(deps({ infer: scripted([]), available: async () => true, budget: 1 }, published), brain, "Ana's brain");
    expect(first).toMatchObject({ state: "stale", again: "soon" });
    expect(first.detail).toMatch(/1 of 3 pages read so far/);
    expect(published.map((p) => p.state)).toEqual(["stale"]);
    await refreshBrain(deps({ infer: scripted([]), available: async () => true, budget: 1 }, published), brain, "Ana's brain");
    const last = await refreshBrain(deps({ infer: scripted([]), available: async () => true, budget: 1 }, published), brain, "Ana's brain");
    expect(last.state).toBe("fresh");
    expect(last.again).toBeUndefined();
  }, 60_000);

  it("BRAIN-BACKGROUND-REFRESH a refresh overtaken by a newer push is not published as fresh, and goes again", async () => {
    const published: RefreshPublish[] = [];
    const other = createStore({ root: path.join(tmp, "w-other"), token: async () => "", fetchEveryMs: 0, log: () => {} });
    let once = false;
    const infer = async (s: string, u: string) => {
      if (!once) {
        once = true;
        await other.write({ brain, path: "Team/new.md", content: "# New\n\nJust written.\n", note: "n", who: "Ben" });
      }
      return scripted([])(s, u);
    };
    const r = await refreshBrain(deps({ infer, available: async () => true }, published), brain, "Ana's brain");
    expect(r).toMatchObject({ state: "stale", again: "soon" });
    expect(published.map((p) => p.state)).not.toContain("fresh");
    expect(remoteFile(".tonoman/index.md")).toBeNull(); // the older map was not written over the newer brain
  }, 60_000);

  it("BRAIN-ARCHIVED-ON-LEAVE an archived brain is not refreshed; one archived mid-refresh gets nothing written or published", async () => {
    const before = commits();
    const published: RefreshPublish[] = [];
    const r = await refreshBrain(deps({ active: async () => false }, published), brain, "Ana's brain");
    expect(r).toMatchObject({ again: "never" });
    let asks = 0;
    const midway = await refreshBrain(deps({ active: async () => asks++ === 0 }, published), brain, "Ana's brain");
    expect(midway).toMatchObject({ again: "never" });
    expect(published).toEqual([]);
    expect(commits()).toBe(before);
  });

  it("BRAIN-BACKGROUND-REFRESH a refresh that fails or throws is tried again, waiting longer each time", async () => {
    const at: number[] = [];
    const outcomes: (() => Promise<RefreshPublish>)[] = [
      async () => { throw new Error("boom"); },
      async () => ({ state: "failed" }),
      async () => ({ state: "fresh" }),
    ];
    const q = createRefreshQueue({ run: async () => (at.push(Date.now()), outcomes[at.length - 1]!()), delayMs: 5, retryMs: 30, log: () => {} });
    q.touch(brain);
    await new Promise((r) => setTimeout(r, 250));
    await q.idle();
    expect(at).toHaveLength(3);
    expect(at[2]! - at[1]!).toBeGreaterThan(at[1]! - at[0]!); // backed off
    q.stop();
  });

  it("BRAIN-BACKGROUND-REFRESH a refresh that was waiting when the worker stopped runs after it starts again", async () => {
    const dir = path.join(tmp, "queue");
    const first = createRefreshQueue({ run: async () => ({ state: "fresh" }), delayMs: 60_000, dir, log: () => {} });
    first.touch(brain);
    await new Promise((r) => setTimeout(r, 30)); // the file is written
    first.stop(); // the worker stops before the refresh ran
    const runs: string[] = [];
    const second = createRefreshQueue({ run: async (b) => (runs.push(b.id), { state: "fresh" }), delayMs: 5, dir, log: () => {} });
    expect(await second.resume()).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    await second.idle();
    expect(runs).toEqual(["b-ana"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(await createRefreshQueue({ run: async () => ({ state: "fresh" }), dir }).resume()).toBe(0); // done: forgotten
    second.stop();
  });
});

describe("a brain kept as it is", () => {
  it("BRAIN-AS-IS is never read by the local model, and nothing is written into it", async () => {
    const calls: string[] = [];
    const before = commits();
    const published: RefreshPublish[] = [];
    const r = await refreshBrain(deps({ infer: scripted(calls), available: async () => true }, published), { ...brain, asIs: true }, "Finances");
    expect(calls).toEqual([]);
    expect(commits()).toBe(before);
    expect(published.every((p) => !p.graph)).toBe(true);
    expect(r).toMatchObject({ state: "stale", detail: "kept as it is" });
  });

  it("BRAIN-AS-IS a refresh queued before the brain was marked so still reads nothing: the registry is asked", async () => {
    const calls: string[] = [];
    const r = await refreshBrain(deps({ infer: scripted(calls), available: async () => true, keptAsIs: async () => true }), brain, "Finances");
    expect(calls).toEqual([]);
    expect(r.detail).toBe("kept as it is");
  });

  it("BRAIN-AS-IS a push to it queues no refresh, and one saved before a restart is dropped", async () => {
    const runs: string[] = [];
    const q = createRefreshQueue({ run: async (b) => (runs.push(b.id), { state: "fresh" }), delayMs: 5, log: () => {} });
    q.touch({ ...brain, asIs: true });
    await new Promise((r) => setTimeout(r, 30));
    await q.idle();
    expect(runs).toEqual([]);
    q.stop();
    const dir = path.join(tmp, "queue-asis");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "b-fin.json"), JSON.stringify({ ...brain, id: "b-fin", asIs: true }));
    const after = createRefreshQueue({ run: async (b) => (runs.push(b.id), { state: "fresh" }), delayMs: 5, dir, log: () => {} });
    expect(await after.resume()).toBe(0);
    expect(existsSync(path.join(dir, "b-fin.json"))).toBe(false);
    after.stop();
  });
});
