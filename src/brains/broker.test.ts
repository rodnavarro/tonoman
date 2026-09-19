// The brain tool a turn uses: every call checked against the registry at that moment, what the turn
// used recorded before anything is returned, one reading budget per turn, and the brain's repo made
// on its owner's first note. Titles start with the rule they prove.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore, seed, seedFiles } from "./store";
import { createBroker, pickBrain, withinBudget, type Reach, type Reachable, type Broker } from "./broker";

let tmp: string;
let broker: Broker;
const ANA = "UANA", BEN = "UBEN", STRANGER = "USTR";

// The registry, in memory: who reaches what right now. Tests change it mid-turn.
let reachOf: Record<string, Reachable[]>;
let recorded: { id: string; url: string }[];
const members = new Set([ANA, BEN]);

const brain = (over: Partial<Reachable>): Reachable => ({
  id: "b", name: "B", slug: "b", kind: "shared", state: "active", repoUrl: null, repoName: null,
  ownerName: "Ana", mode: "read", own: false, ...over,
});

const newRemote = async (name: string, withSeed = true): Promise<string> => {
  const r = path.join(tmp, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", r]);
  if (withSeed) await seed(r, "", seedFiles(name), tmp);
  return r;
};

const call = async (token: string, tool: string, body: Record<string, unknown> = {}) => {
  const r = await fetch(`${broker.url}/brain/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

let anaPersonal: Reachable, engineering: Reachable, bensPersonal: Reachable;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "broker-"));
  recorded = [];
  anaPersonal = brain({ id: "b-ana", name: "Ana's brain", slug: "ana-1", kind: "personal", own: true, mode: "write", repoUrl: await newRemote("ana") });
  engineering = brain({ id: "b-eng", name: "Engineering", slug: "engineering", mode: "read", repoUrl: await newRemote("eng") });
  bensPersonal = brain({ id: "b-ben", name: "Ben's brain", slug: "ben-1", kind: "personal", own: true, mode: "write", state: "not_created", ownerName: "Ben" });
  reachOf = { [ANA]: [anaPersonal, { ...engineering, mode: "write" }], [BEN]: [bensPersonal, engineering], [STRANGER]: [] };
  const store = createStore({ root: path.join(tmp, "clones"), token: async () => "", fetchEveryMs: 0, log: () => {} });
  broker = createBroker({
    store,
    scratch: path.join(tmp, "scratch"),
    log: () => {},
    registry: {
      reach: async (_agent, user): Promise<Reach> => ({
        tenant: "test-a",
        speaker: { accountId: user, name: user, member: members.has(user) },
        brains: reachOf[user] ?? [],
      }),
      recordRepo: async (id, url) => void recorded.push({ id, url }),
    },
    provisioner: {
      create: async (_tenant, b) => ({ repoUrl: await newRemote(`made-${b.slug}`, false), repoName: `brain-test-a-${b.slug}-dev` }),
      token: async () => "",
    },
  });
  await broker.start();
  // Engineering has something in it.
  await store.write({ brain: { id: engineering.id, tenant: "test-a", repoUrl: engineering.repoUrl! }, path: "AI/typesafe-ai.md", content: "# TypeSafe AI\nJev: a System One model.\n", note: "Jev", who: "Ana" });
});

afterEach(async () => {
  await broker.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("what a turn can reach", () => {
  it("BRAIN-REACH a person's turn cannot read a brain they do not reach", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: BEN, who: "Ben" });
    const r = await call(token, "read", { brain: "Ana's brain", path: "index.md" });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("index");
  });

  it("BRAIN-GRANT-TIMING a grant made during a turn is usable on the next call", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: BEN, who: "Ben" });
    expect((await call(token, "read", { brain: "Ana's brain", path: "index.md" })).status).toBe(404);
    reachOf[BEN] = [...reachOf[BEN], { ...anaPersonal, own: false, mode: "read" }];
    expect((await call(token, "read", { brain: "Ana's brain", path: "index.md" })).status).toBe(200);
  });

  it("BRAIN-GRANT-TIMING a revoke during a turn stops the very next read and write", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    expect((await call(token, "read", { brain: "Engineering", path: "AI/typesafe-ai.md" })).status).toBe(200);
    reachOf[ANA] = [anaPersonal];
    expect((await call(token, "read", { brain: "Engineering", path: "AI/typesafe-ai.md" })).status).toBe(404);
    expect((await call(token, "write", { brain: "Engineering", path: "x.md", content: "x", note: "x" })).status).toBe(404);
  });

  it("BRAIN-REACH a person who is not a member reaches nothing", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: STRANGER, who: "?" });
    expect((await call(token, "list")).text).toMatch(/not a member/);
  });

  it("BRAIN-GRANTS-DECIDE a token from a finished turn opens nothing", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    broker.endTurn(token);
    expect((await call(token, "list")).status).toBe(401);
    expect((await call("made-up", "list")).status).toBe(401);
  });
});

describe("what a turn used", () => {
  it("BRAIN-USED-DECIDES listing counts every brain whose index was shown; an empty brain counts for nothing", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: BEN, who: "Ben" });
    const r = await call(token, "list");
    expect(r.text).toContain("Engineering");
    expect(r.text).toContain("empty so far");
    expect(broker.endTurn(token).used).toEqual(["b-eng"]);
  });

  it("BRAIN-USED-DECIDES a search counts only the brains it found something in", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    const r = await call(token, "search", { query: "jev" });
    expect(r.text).toContain("AI/typesafe-ai.md");
    expect(broker.endTurn(token).used).toEqual(["b-eng"]);
  });

  it("BRAIN-USED-DECIDES a brain is counted as used even when the read finds no page", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    await call(token, "read", { brain: "Engineering", path: "missing.md" });
    expect(broker.endTurn(token).used).toEqual(["b-eng"]);
  });
});

describe("reading", () => {
  it("BRAIN-INDEX-FIRST the list shows each brain's index before anything else is asked", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    const r = await call(token, "list");
    expect(r.text).toMatch(/Ana's brain \(yours, read and write\)/);
    expect(r.text).toMatch(/index\.md \(start\)/);
  });

  it("BRAIN-BOUNDED everything a turn reads shares one budget, and it says what was cut", async () => {
    await broker.close();
    const store = createStore({ root: path.join(tmp, "clones2"), token: async () => "", fetchEveryMs: 0, log: () => {} });
    broker = createBroker({
      store, scratch: path.join(tmp, "scratch2"), log: () => {}, budgetBytes: 600,
      registry: { reach: async () => ({ tenant: "test-a", speaker: { accountId: "a", name: "Ana", member: true }, brains: [engineering] }), recordRepo: async () => {} },
    });
    await broker.start();
    await store.write({ brain: { id: engineering.id, tenant: "test-a", repoUrl: engineering.repoUrl! }, path: "big.md", content: "x".repeat(2000), note: "big", who: "Ana" });
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    const first = await call(token, "read", { brain: "Engineering", path: "big.md" });
    expect(first.text).toMatch(/budget/);
    const second = await call(token, "read", { brain: "Engineering", path: "AI/typesafe-ai.md" });
    expect(second.text).toMatch(/budget is spent/);
  });
});

describe("writing", () => {
  it("BRAIN-REMEMBER a write to a brain the person can write to is saved, and the reply says where", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    const r = await call(token, "write", { brain: "Ana's brain", path: "AI/jev.md", content: "# Jev\n", note: "Joined the Jev waitlist" });
    expect(r.status).toBe(200);
    expect(r.text).toBe("Saved to Ana's brain: AI/jev.md.");
    const back = await call(token, "read", { brain: "Ana's brain", path: "AI/jev.md" });
    expect(back.text).toContain("# Jev");
  });

  it("BRAIN-READ-ONLY-REFUSAL writing where the person may only read is refused, naming where they can write", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: BEN, who: "Ben" });
    const r = await call(token, "write", { brain: "Engineering", path: "x.md", content: "x", note: "x" });
    expect(r.status).toBe(403);
    expect(r.text).toBe("Engineering is read only for this person. They can write to: Ben's brain.");
  });

  it("BRAIN-REPO-ON-FIRST-USE the owner's first note creates the repo, seeds it, records it, and saves the note", async () => {
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: BEN, who: "Ben" });
    const r = await call(token, "write", { brain: "Ben's brain", path: "offsite.md", content: "Offsite on the 14th.\n", note: "Offsite date" });
    expect(r.status).toBe(200);
    expect(recorded).toEqual([{ id: "b-ben", url: expect.stringContaining("made-ben-1.git") }]);
    // From now on the registry says it is active.
    reachOf[BEN] = [{ ...bensPersonal, state: "active", repoUrl: recorded[0].url }, engineering];
    const back = await call(token, "read", { brain: "Ben's brain", path: "offsite.md" });
    expect(back.text).toContain("Offsite on the 14th.");
    expect((await call(token, "read", { brain: "Ben's brain", path: "BRAIN.md" })).text).toContain("How this brain is organised");
  });

  it("BRAIN-REPO-ON-FIRST-USE nobody but the owner can bring a brain into being", async () => {
    reachOf[ANA] = [...reachOf[ANA], { ...bensPersonal, own: false, mode: "write" }];
    const { token } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    expect((await call(token, "write", { brain: "Ben's brain", path: "x.md", content: "x", note: "x" })).status).toBe(409);
    expect(recorded).toEqual([]);
  });
});

describe("naming a brain", () => {
  it("BRAIN-WHICH-ONE a brain is found by id, exact name, or a unique name in any case — never by a guess", () => {
    const bs = [anaPersonal, engineering, brain({ id: "b-x", name: "engineering notes" })];
    expect(pickBrain(bs, "b-eng")?.id).toBe("b-eng");
    expect(pickBrain(bs, "ENGINEERING")?.id).toBe("b-eng");
    expect(pickBrain(bs, "Eng")).toBeUndefined();
    expect(withinBudget("abc", 10)).toEqual({ text: "abc", cut: false });
  });
});

describe("the harness side", () => {
  it("BRAIN-EVERY-AGENT the MCP server a harness starts lists the four tools and answers a call", async () => {
    const { mcp } = broker.startTurn({ agentGuid: "echo", slackUserId: ANA, who: "Ana" });
    const child = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ["pipe", "pipe", "inherit"] });
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const ask = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    const answer = async (id: number) => {
      for (let i = 0; i < 100 && !lines.find((l) => l.id === id); i++) await new Promise((r) => setTimeout(r, 50));
      return lines.find((l) => l.id === id) as { result: Record<string, unknown> };
    };
    ask({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    ask({ method: "notifications/initialized" });
    ask({ id: 2, method: "tools/list" });
    ask({ id: 3, method: "tools/call", params: { name: "brain_search", arguments: { query: "Jev" } } });
    expect((await answer(1)).result.serverInfo).toMatchObject({ name: "tonoman-brain" });
    expect(((await answer(2)).result.tools as { name: string }[]).map((t) => t.name)).toEqual(["brain_list", "brain_search", "brain_read", "brain_write"]);
    const found = (await answer(3)).result as { content: { text: string }[]; isError: boolean };
    expect(found.isError).toBe(false);
    expect(found.content[0].text).toContain("AI/typesafe-ai.md");
    child.stdin.end();
  });
});
