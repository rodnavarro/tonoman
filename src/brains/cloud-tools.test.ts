// Tools a Tonoman Cloud serves an agent (D-CLOUD-TOOLS, CLI-CLOUD-TOOLS in Tonoman Cloud's cli.md):
// the runtime shows them in the turn's `tonoman` and carries each call to the Cloud with the person
// speaking — and knows nothing else of them. Also `tonoman web fetch` through the broker
// (TOOL-WEB-FETCH). Titles start with the rule they prove.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore } from "./store";
import { createBroker, type Broker, type CloudTool, type Reach } from "./broker";
import { cliSource } from "./cli";

vi.setConfig({ testTimeout: 30_000 });

/** A tool as a Cloud would list it on the roster: a `notes` group with a command that reads its
 *  text from stdin and one that takes a file the person sent. */
const NOTES: CloudTool = {
  name: "notes",
  about: "the team's shared notes (served by the Cloud)",
  note: "Notes is on: keep the team's notes with `tonoman notes`.",
  commands: {
    add: { args: ["--title", "--text (or on stdin)"], about: "Add a note.", stdin: "text" },
    attach: { args: ["--file"], about: "Attach a file the person sent to the newest note.", file: "file" },
  },
};

let tmp: string;
let broker: Broker;
let cliPath: string;
let calls: { agent: string; tool: string; command: string; speaker: string; body: Record<string, unknown>; file?: { name: string; data: string } }[];

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "cloudtools-"));
  calls = [];
  broker = createBroker({
    store: createStore({ root: path.join(tmp, "clones"), token: async () => "", fetchEveryMs: 0, log: () => {} }),
    scratch: path.join(tmp, "scratch"),
    log: () => {},
    registry: { reach: async (_a, user): Promise<Reach> => ({ tenant: "t", speaker: { accountId: user, name: user, member: true }, brains: [] }), recordRepo: async () => {} },
    cloudTool: async (agent, tool, command, call) => {
      calls.push({ agent, tool, command, ...call });
      return { status: 200, text: `the Cloud did ${tool} ${command}` };
    },
  });
  await broker.start();
  cliPath = path.join(tmp, "tonoman.cjs");
  writeFileSync(cliPath, cliSource);
});
afterEach(async () => {
  await broker.close();
  rmSync(tmp, { recursive: true, force: true });
});

const tonoman = (env: Record<string, string>, input: string | undefined, ...args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const child = execFile(process.execPath, [cliPath, ...args], { env: { ...env, PATH: "" }, timeout: 20_000 }, (err, so, se) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: `${so}${se}` }),
    );
    child.stdin?.end(input ?? "");
  });
const post = async (token: string, route: string, body: Record<string, unknown>) => {
  const r = await fetch(`${broker.url}/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};

describe("tools a Cloud serves", () => {
  it("CLI-CLOUD-TOOLS a tool the Cloud lists for the agent is a `tonoman` group in its turn, and absent from any other", async () => {
    const on = broker.startTurn({ agentGuid: "g1", slackUserId: "UANA", who: "Ana", cloudTools: [NOTES] });
    const help = await tonoman(on.cli.env, undefined, "--help");
    expect(help.out).toContain("notes");
    expect((await tonoman(on.cli.env, undefined, "notes", "--help")).out).toContain("add --title --text (or on stdin)");
    const off = broker.startTurn({ agentGuid: "g1", slackUserId: "UANA", who: "Ana" });
    expect((await tonoman(off.cli.env, undefined, "--help")).out).not.toContain("notes");
    expect((await tonoman(off.cli.env, undefined, "notes", "add")).code).not.toBe(0);
  });

  it("CLI-CLOUD-TOOLS a call goes to the Cloud with the agent, the person speaking and the arguments — stdin read where the tool says", async () => {
    const { cli } = broker.startTurn({ agentGuid: "g1", slackUserId: "UANA", who: "Ana", cloudTools: [NOTES] });
    const r = await tonoman(cli.env, "remember the offsite", "notes", "add", "--title", "Offsite");
    expect(r.code).toBe(0);
    expect(r.out).toContain("the Cloud did notes add");
    expect(calls).toEqual([{ agent: "g1", tool: "notes", command: "add", speaker: "UANA", body: { title: "Offsite", text: "remember the offsite" } }]);
  });

  it("CLI-CLOUD-TOOLS a tool not listed for this turn's agent is refused, and nothing reaches the Cloud", async () => {
    const { token } = broker.startTurn({ agentGuid: "g1", slackUserId: "UANA", who: "Ana" });
    expect((await post(token, "cloud/notes/add", { title: "x" })).status).toBe(403);
    const listed = broker.startTurn({ agentGuid: "g1", slackUserId: "UANA", who: "Ana", cloudTools: [NOTES] });
    expect((await post(listed.token, "cloud/notes/delete-everything", {})).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("CONVO-FILES-IN-THE-TURN a file goes to the Cloud only when it is one the person sent, as it arrived", async () => {
    const { token } = broker.startTurn({ agentGuid: "g1", slackUserId: "UANA", who: "Ana", cloudTools: [NOTES] });
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    broker.attach(token, [{ name: "team.jpg", bytes: photo }]);
    for (const file of ["other.jpg", "../team.jpg", "/etc/team.jpg"]) expect((await post(token, "cloud/notes/attach", { file })).status, file).toBeGreaterThanOrEqual(400);
    expect(calls).toEqual([]);
    expect((await post(token, "cloud/notes/attach", { file: "team.jpg" })).status).toBe(200);
    expect(calls[0]!.file).toEqual({ name: "team.jpg", data: photo.toString("base64") });
  });
});

describe("web fetch", () => {
  it("TOOL-WEB-FETCH without the grant `tonoman web fetch` does nothing; with it, the page comes back", async () => {
    const opened: string[] = [];
    const b = createBroker({
      store: createStore({ root: path.join(tmp, "c2"), token: async () => "", fetchEveryMs: 0, log: () => {} }),
      scratch: path.join(tmp, "s2"),
      log: () => {},
      registry: { reach: async (): Promise<Reach> => ({ tenant: "test-a", speaker: { accountId: "a", name: "A", member: true, role: "member" }, brains: [] }), recordRepo: async () => {} },
      fetchPage: async (url) => (opened.push(url), { url, status: 200, title: "Priya Raman - Acme", description: "Head of data", text: "x".repeat(6000) }),
    });
    await b.start();
    try {
      const go = async (webFetch: boolean, body: Record<string, unknown>) => {
        const { token, cli } = b.startTurn({ agentGuid: "g", slackUserId: "U1", who: "A", webFetch });
        const r = await fetch(`${b.url}/web/fetch`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, text: await r.text(), env: cli.env };
      };
      const off = await go(false, { url: "https://example.com/" });
      expect(off.status).toBe(403);
      expect(off.env.TONOMAN_WEB_FETCH).toBeUndefined();
      expect(opened).toEqual([]);
      const on = await go(true, { url: "https://example.com/" });
      expect(on.env.TONOMAN_WEB_FETCH).toBe("1");
      expect(on.text).toContain("title: Priya Raman - Acme");
      expect(on.text).toContain("1000 more characters: --from 5000");
    } finally {
      await b.close();
    }
  });
});
