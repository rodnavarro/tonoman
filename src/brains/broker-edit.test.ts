// Changing a page or a file in a brain in place: find these words, put those (BRAIN-EDIT-IN-PLACE,
// D-BRAINS-ARE-EDITABLE in Tonoman Cloud). Real git, real broker. Titles start with the rule they prove.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore } from "./store";
import { createBroker, type Broker, type Reachable } from "./broker";

let tmp: string;
let broker: Broker;
let remote: string;
let reachOf: Record<string, Reachable[]>;
const ROD = "UROD", BEN = "UBEN";
const LEDGER = "2026/spreadsheet/deductions_ledger.csv";
const HEADER = "status,category,amount,merchant_or_source,property_or_business_link,evidence_path,treatment_note,confidence,notes";
// Row 2 is the real ledger's oddity — a comma nobody quoted — and must come through untouched.
const ROWS = [
  HEADER,
  "captured,meals,20.21,Starbucks,acme-llc,p1,Coffee,,",
  "captured,meals,12.00,Deli, Inc,acme-llc,p2,Lunch,,",
  'captured,meals,168.57,Main Street Grill,acme-llc,2026/evidence/expenses/meals/2026/2026-09-19_main-street-grill_168.57_receipt.jpg,"Business dinner, with a client",,',
  "captured,travel,100.5,Delta,acme-llc,p4,Flight,,",
];
const sh = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const onMain = (p: string) => execFileSync("git", ["show", `main:${p}`], { cwd: remote, encoding: "utf8" });

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "brk-edit-"));
  remote = path.join(tmp, "finances.git");
  sh(["init", "-q", "--bare", "-b", "main", remote]);
  const seed = mkdtempSync(path.join(tmp, "seed-"));
  sh(["init", "-q", "-b", "main"], seed);
  sh(["config", "user.name", "x"], seed);
  sh(["config", "user.email", "x@x"], seed);
  mkdirSync(path.join(seed, "2026/spreadsheet"), { recursive: true });
  writeFileSync(path.join(seed, LEDGER), ROWS.join("\n") + "\n");
  writeFileSync(path.join(seed, "notes.md"), "# Notes\n\nTODO: call the accountant.\nTODO: renew the LLC.\n");
  sh(["add", "-A"], seed);
  sh(["commit", "-q", "-m", "seed"], seed);
  sh(["push", "-q", remote, "main"], seed);
  const finances: Reachable = { id: "b-fin", name: "Finances", slug: "finances", kind: "shared", state: "active", repoUrl: remote, repoName: "finances", ownerName: "Rod", mode: "write", own: true, branch: "main", asIs: true };
  reachOf = { [ROD]: [finances], [BEN]: [{ ...finances, mode: "read", own: false }] };
  broker = createBroker({
    store: createStore({ root: path.join(tmp, "clones"), token: async () => "", fetchEveryMs: 0, log: () => {} }),
    scratch: path.join(tmp, "scratch"),
    log: () => {},
    registry: { reach: async (_a, user) => ({ tenant: "acme", speaker: { accountId: user, name: user, member: true }, brains: reachOf[user] ?? [] }), recordRepo: async () => {} },
  });
  await broker.start();
});
afterEach(async () => {
  await broker.close();
  rmSync(tmp, { recursive: true, force: true });
});

const edit = async (user: string, body: Record<string, unknown>) => {
  const { token } = broker.startTurn({ agentGuid: "sapien", slackUserId: user, who: user });
  const r = await fetch(`${broker.url}/brain/edit`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ brain: "Finances", ...body }) });
  return { status: r.status, text: await r.text() };
};

describe("changing a file in a brain in place", () => {
  it("BRAIN-EDIT-IN-PLACE one row of a ledger gains a note: that row changes, every other byte of the file does not, and it is one commit", async () => {
    const find = '"Business dinner, with a client",,';
    const r = await edit(ROD, { path: LEDGER, find, replace: '"Business dinner, with a client",,Dana from Globex was there', note: "Note on the Main Street Grill dinner" });
    expect(r.status).toBe(200);
    const after = onMain(LEDGER).split("\n");
    expect(after[3]!.endsWith(",Dana from Globex was there")).toBe(true);
    for (const i of [0, 1, 2, 4]) expect(after[i]).toBe(ROWS[i]);
    expect(sh(["show", "--name-only", "--format=", "main"], remote).trim()).toBe(LEDGER);
    expect(sh(["log", "-1", "--format=%s", "main"], remote).trim()).toBe("Note on the Main Street Grill dinner");
  });

  it("BRAIN-EDIT-IN-PLACE words can be added after the ones found, leaving those as they are", async () => {
    const r = await edit(ROD, { path: "notes.md", find: "TODO: call the accountant.\n", after: "DONE Sep 19: she will file the extension.\n", note: "Accountant called" });
    expect(r.status).toBe(200);
    expect(onMain("notes.md")).toBe("# Notes\n\nTODO: call the accountant.\nDONE Sep 19: she will file the extension.\nTODO: renew the LLC.\n");
  });

  it("BRAIN-EDIT-IN-PLACE words found more than once, or not at all, change nothing — and the agent is told which, so it can give more of the line", async () => {
    const before = sh(["rev-parse", "main"], remote).trim();
    const twice = await edit(ROD, { path: "notes.md", find: "TODO:", replace: "DONE:", note: "x" });
    expect(twice.status).toBe(409);
    expect(twice.text).toMatch(/2 places/);
    const none = await edit(ROD, { path: LEDGER, find: "Cracker Barrel", replace: "x", note: "x" });
    expect(none.status).toBe(404);
    expect(none.text).toMatch(/not found/i);
    expect(sh(["rev-parse", "main"], remote).trim()).toBe(before);
  });

  it("BRAIN-EDIT-IN-PLACE someone who can only read the brain cannot edit it", async () => {
    const before = sh(["rev-parse", "main"], remote).trim();
    expect((await edit(BEN, { path: "notes.md", find: "renew the LLC", replace: "close the LLC", note: "x" })).status).toBe(403);
    expect(sh(["rev-parse", "main"], remote).trim()).toBe(before);
  });

  it("BRAIN-EDIT-IN-PLACE a file that is not there, a path that climbs out, a photo, or an edit that changes nothing, is refused", async () => {
    expect((await edit(ROD, { path: "nope.md", find: "a", replace: "b", note: "x" })).status).toBe(404);
    expect((await edit(ROD, { path: "../outside.md", find: "a", replace: "b", note: "x" })).status).toBe(400);
    expect((await edit(ROD, { path: "notes.md", find: "renew", replace: "renew", note: "x" })).status).toBe(400);
    expect((await edit(ROD, { path: "notes.md", find: "", replace: "b", note: "x" })).status).toBe(400);
  });

  it("BRAIN-EDIT-IN-PLACE a change someone pushed meanwhile is kept: the edit is made on the file as it is now", async () => {
    const other = mkdtempSync(path.join(tmp, "other-"));
    sh(["clone", "-q", remote, other]);
    sh(["config", "user.name", "x"], other);
    sh(["config", "user.email", "x@x"], other);
    writeFileSync(path.join(other, LEDGER), ROWS.join("\n") + "\ncaptured,office,9.99,Staples,acme-llc,p5,Pens,,\n");
    sh(["commit", "-qam", "by hand"], other);
    sh(["push", "-q"], other);
    expect((await edit(ROD, { path: LEDGER, find: "p4,Flight,,", replace: "p4,Flight,,to the Globex offsite", note: "Note on the Delta flight" })).status).toBe(200);
    const after = onMain(LEDGER);
    expect(after).toContain("Staples");
    expect(after).toContain("to the Globex offsite");
  });
});
