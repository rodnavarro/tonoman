// A brain organising itself: the map, connections by topic from a scripted model (FIX-SCRIPTED-MODEL)
// over pages that never link to each other (FIX-UNLINKED-PAGES), and what happens when the model is not
// there. Titles start with the rule they prove.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
