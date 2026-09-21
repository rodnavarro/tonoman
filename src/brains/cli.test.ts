// `tonoman`, the one command every agent has (Tonoman Cloud docs/definition/objects/cli.md): found by
// asking it, acting as the turn's person, answering in bounded text. Run as the real script, the way
// the agent's shell runs it. Titles start with the rule they prove.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real git on every test: slower than the 5s default when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createStore, seed, seedFiles } from "./store";
import { createBroker, type Broker, type Reachable } from "./broker";
import { cliSource } from "./cli";

let tmp: string;
let broker: Broker;
let cliPath: string;
let ana: Reachable;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "cli-"));
  const remote = path.join(tmp, "ana.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  await seed(remote, "", seedFiles("Ana's brain"), tmp);
  ana = { id: "b-ana", name: "Ana's brain", slug: "ana", kind: "personal", state: "active", repoUrl: remote, repoName: "ana", ownerName: "Ana", mode: "write", own: true };
  broker = createBroker({
    store: createStore({ root: path.join(tmp, "clones"), token: async () => "", fetchEveryMs: 0, log: () => {} }),
    scratch: path.join(tmp, "scratch"),
    log: () => {},
    registry: { reach: async (_a, user) => ({ tenant: "t", speaker: { accountId: user, name: user, member: true }, brains: user === "UANA" ? [ana] : [] }), recordRepo: async () => {} },
  });
  await broker.start();
  cliPath = path.join(tmp, "tonoman.cjs");
  writeFileSync(cliPath, cliSource);
});
afterEach(async () => {
  await broker.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Run `tonoman <args>` as a turn's shell would: with that turn's environment only. */
const tonoman = (env: Record<string, string>, ...args: string[]) => tonomanIn(env, undefined, ...args);
/** The same, with something on stdin (a long page is written that way). */
const tonomanIn = (env: Record<string, string>, input: string | undefined, ...args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const child = execFile(process.execPath, [cliPath, ...args], { env: { ...env, PATH: "" }, timeout: 20_000 }, (err, so, se) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: `${so}${se}` }),
    );
    child.stdin?.end(input ?? "");
  });

describe("found by asking it", () => {
  it("CLI-SMALL-CONTEXT `tonoman --help` names the groups; `tonoman brain --help` names its commands and their arguments", async () => {
    const { cli } = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    const top = await tonoman(cli.env, "--help");
    expect(top.code).toBe(0);
    expect(top.out).toMatch(/brain/);
    const brain = await tonoman(cli.env, "brain", "--help");
    for (const c of ["list", "pages", "search", "read", "write"]) expect(brain.out).toContain(c);
    expect(brain.out).toMatch(/--brain/);
  });

  it("CLI-GRANTED-GROUPS `tonoman receipts` appears only while Receipts is on for the agent", async () => {
    const off = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    expect((await tonoman(off.cli.env, "--help")).out).not.toMatch(/receipts/);
    expect((await tonoman(off.cli.env, "receipts", "file")).out).toMatch(/Receipts is not on/);
    const on = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana", receipts: { brainId: "b-ana" } });
    expect((await tonoman(on.cli.env, "--help")).out).toMatch(/receipts/);
  });

  it("CLI-ONE-COMMAND an unknown command says so and points to --help", async () => {
    const { cli } = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    const r = await tonoman(cli.env, "brian", "list");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--help/);
  });
});

describe("acting as the turn's person", () => {
  it("CLI-ACTS-AS-SPEAKER the same command shows each person their own brains", async () => {
    const a = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    const b = broker.startTurn({ agentGuid: "echo", slackUserId: "UBEN", who: "Ben" });
    expect((await tonoman(a.cli.env, "brain", "list")).out).toContain("Ana's brain");
    expect((await tonoman(b.cli.env, "brain", "list")).out).not.toContain("Ana's brain");
  });

  it("CLI-DIES-WITH-TURN after the turn ends, its command is refused", async () => {
    const { token, cli } = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    expect((await tonoman(cli.env, "brain", "list")).code).toBe(0);
    broker.endTurn(token);
    const r = await tonoman(cli.env, "brain", "list");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/ended/);
  });

  it("CLI-ACTS-AS-SPEAKER writing through the command lands as the person, and reading it back works", async () => {
    const { cli } = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    const w = await tonoman(cli.env, "brain", "write", "--brain", "Ana's brain", "--path", "AI/jev.md", "--note", "Jev", "--content", "# Jev\nTypeSafe's model.");
    expect(w.code).toBe(0);
    expect((await tonoman(cli.env, "brain", "read", "--brain", "Ana's brain", "--path", "AI/jev.md")).out).toContain("TypeSafe's model.");
  });
});

describe("answers that fit", () => {
  it("CLI-OUTPUT-BOUNDED a command answers in a few thousand characters at most and says there is more", async () => {
    const { cli } = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    expect((await tonomanIn(cli.env, "x".repeat(40_000), "brain", "write", "--brain", "Ana's brain", "--path", "big.md", "--note", "big")).code).toBe(0);
    const r = await tonoman(cli.env, "brain", "read", "--brain", "Ana's brain", "--path", "big.md");
    expect(r.out.length).toBeLessThan(9_000);
    expect(r.out).toMatch(/more/i);
  });
});

describe("receipts through the command", () => {
  it("RECEIPT-REPORT `tonoman receipts file` files a photo from the turn's folder and prints what was filed", async () => {
    const fin = path.join(tmp, "fin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", fin]);
    const s = mkdtempSync(path.join(tmp, "s-"));
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.name", "x"], ["config", "user.email", "x@x"]]) execFileSync("git", a, { cwd: s });
    mkdirSync(path.join(s, "2026/spreadsheet"), { recursive: true });
    writeFileSync(path.join(s, "2026/spreadsheet/deductions_ledger.csv"), "status,category,amount,merchant_or_source,property_or_business_link,evidence_path,treatment_note,confidence,notes\n");
    for (const a of [["add", "-A"], ["commit", "-qm", "seed"], ["push", "-q", fin, "main"]]) execFileSync("git", a, { cwd: s });
    ana.repoUrl = fin;
    ana.asIs = true;
    const cwd = mkdtempSync(path.join(tmp, "turn-"));
    writeFileSync(path.join(cwd, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const started = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana", cwd, receipts: { brainId: "b-ana", entities: ["acme-llc"] } });
    broker.attach(started.token, [{ name: "photo.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) }]); // what the person sent, as the worker hands it over
    const { cli } = started;
    const r = await tonoman(cli.env, "receipts", "file", "--file", "photo.jpg", "--vendor", "Corner Bistro", "--date", "2026-09-19", "--amount", "48.96", "--category", "meals", "--entity", "acme-llc");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Corner Bistro — $48.96 — meals — 2026-09-19 → acme-llc");
  });
});

describe("tonoman as Codex's one tool", () => {
  /** Speak MCP to the turn's tool the way Codex does: initialize, list, call. */
  const mcp = async (server: { command: string; args: string[]; env: Record<string, string> }, calls: object[]) =>
    new Promise<Record<string, unknown>[]>((resolve) => {
      const child = execFile(server.command, server.args, { env: { ...server.env, PATH: "" }, timeout: 20_000 }, (_e, so) =>
        resolve(so.split("\n").filter(Boolean).map((l) => JSON.parse(l))),
      );
      const msgs = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ...calls];
      child.stdin?.end(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    });

  it("CLI-SMALL-CONTEXT Codex sees one tool, tonoman, and calling it runs the same command", async () => {
    const { mcp: server } = broker.startTurn({ agentGuid: "echo", slackUserId: "UANA", who: "Ana" });
    const replies = await mcp(server, [
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tonoman", arguments: { args: ["brain", "list"] } } },
    ]);
    const tools = (replies.find((r) => r.id === 2)!.result as { tools: { name: string; description: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["tonoman"]);
    expect(tools[0]!.description.length).toBeLessThan(600);
    const called = replies.find((r) => r.id === 3)!.result as { content: { text: string }[]; isError: boolean };
    expect(called.isError).toBe(false);
    expect(called.content[0]!.text).toContain("Ana's brain");
  });
});
