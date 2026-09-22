// `tonoman receipts`, at the broker: who may file and read, only a file from the speaker's own turn
// folder, a run recorded for each thing done, and nothing while the Talent is off. Rules: Tonoman
// Cloud's docs/definition/objects/receipt.md, talent.md (TALENT-IN-CONVERSATION), run.md
// (RUN-FROM-CONVERSATION), cli.md (CLI-GRANTED-GROUPS).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real git on every test: slower than the 5s default when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore } from "../brains/store";
import { createBroker, type Broker, type ConversationRun, type Reachable } from "../brains/broker";
import { LEDGER_HEADER } from "./receipts";

let tmp: string;
let broker: Broker;
let runs: ConversationRun[];
let finances: Reachable;
let reachOf: Record<string, Reachable[]>;
const ROD = "UROD", BEN = "UBEN";
const sh = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "brk-rcpt-"));
  const remote = path.join(tmp, "finances.git");
  sh(["init", "-q", "--bare", "-b", "main", remote]);
  const seed = mkdtempSync(path.join(tmp, "seed-"));
  sh(["init", "-q", "-b", "main"], seed);
  sh(["config", "user.name", "x"], seed);
  sh(["config", "user.email", "x@x"], seed);
  mkdirSync(path.join(seed, "2026/spreadsheet"), { recursive: true });
  writeFileSync(path.join(seed, "2026/spreadsheet/deductions_ledger.csv"), `${LEDGER_HEADER}\ncaptured,meals,20.21,Starbucks,acme-llc,p,,,\n`);
  sh(["add", "-A"], seed);
  sh(["commit", "-q", "-m", "seed"], seed);
  sh(["push", "-q", remote, "main"], seed);
  finances = { id: "b-fin", name: "Finances", slug: "finances", kind: "shared", state: "active", repoUrl: remote, repoName: "finances", ownerName: "Rod", mode: "write", own: true, branch: "main", asIs: true };
  reachOf = { [ROD]: [finances], [BEN]: [] };
  runs = [];
  broker = createBroker({
    store: createStore({ root: path.join(tmp, "clones"), token: async () => "", fetchEveryMs: 0, log: () => {} }),
    scratch: path.join(tmp, "scratch"),
    log: () => {},
    registry: {
      reach: async (_a, user) => ({ tenant: "acme", speaker: { accountId: user, name: user, member: user in reachOf }, brains: reachOf[user] ?? [] }),
      recordRepo: async () => {},
    },
    recordRun: async (r) => void runs.push(r),
  });
  await broker.start();
});
afterEach(async () => {
  await broker.close();
  rmSync(tmp, { recursive: true, force: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
/** A turn folder holding the working copy of the one photo the person sent. */
const turnWithPhoto = () => {
  const cwd = mkdtempSync(path.join(tmp, "turn-"));
  writeFileSync(path.join(cwd, "photo.jpg"), JPEG);
  return cwd;
};
/** A turn as the worker starts it: the person's attachments are handed over before the agent runs. */
const startWith = (user: string, who: string, files: { name: string; bytes: Buffer }[] = [{ name: "photo.jpg", bytes: JPEG }], receipts: object | undefined = receiptsOn, cwd = turnWithPhoto()) => {
  const t = broker.startTurn({ agentGuid: "sapien", slackUserId: user, who, cwd, receipts: receipts as never });
  broker.attach(t.token, files);
  return { ...t, cwd };
};
const call = async (token: string, op: string, body: Record<string, unknown> = {}) => {
  const r = await fetch(`${broker.url}/receipts/${op}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
const fields = { file: "photo.jpg", vendor: "Corner Bistro", date: "2026-09-19", amount: "48.96", category: "meals", entity: "acme-llc", note: "Business breakfast" };
const receiptsOn = { brainId: "b-fin", entities: ["acme-llc", "northwind-ventures-llc", "northwind-beauty-llc"] };

describe("filing from a conversation", () => {
  it("RECEIPT-REPORT a filing answers with what was filed, its entity and where — from the filing itself", async () => {
    const { token } = startWith(ROD, "Rod");
    const r = await call(token, "file", fields);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Corner Bistro — $48.96 — meals — 2026-09-19 → acme-llc → 2026/evidence/expenses/meals");
    expect(r.text).toContain("2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg");
  });

  it("RUN-FROM-CONVERSATION each filing is a run of Receipts, for the person, with no content", async () => {
    const { token } = startWith(ROD, "Rod");
    await call(token, "file", fields);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentGuid: "sapien", slackUserId: ROD, talent: "receipts", status: "done", summary: "filed a receipt" });
    expect(JSON.stringify(runs[0])).not.toMatch(/Antojo|48\.96|breakfast/);
  });

  it("RECEIPT-WHO-MAY-FILE someone who cannot write the finances brain is refused, and nothing is written", async () => {
    const { token } = startWith(BEN, "Ben");
    const r = await call(token, "file", fields);
    expect(r.status).toBe(403);
    expect((await call(token, "totals", { year: "2026" })).status).toBe(403);
    reachOf[BEN] = [{ ...finances, mode: "read", own: false }];
    expect((await call(token, "file", fields)).status).toBe(403); // reading is not filing
    expect((await call(token, "totals", { year: "2026" })).status).toBe(200);
  });

  it("RECEIPT-FILES-WHAT-WAS-SENT only a file the person sent is filed: a path elsewhere, or a file the agent made in its folder, is refused", async () => {
    const elsewhere = path.join(tmp, "secret.jpg");
    writeFileSync(elsewhere, JPEG);
    const { token, cwd } = startWith(ROD, "Rod");
    writeFileSync(path.join(cwd, "invented.jpg"), JPEG);
    for (const f of [elsewhere, "../secret.jpg", "/etc/passwd", ".", "invented.jpg"]) expect((await call(token, "file", { ...fields, file: f })).status).toBe(403);
  });

  it("RECEIPT-FILES-WHAT-WAS-SENT naming the file by the path the agent was shown works too: it is matched by its name, and the path is never opened", async () => {
    const { token, cwd } = startWith(ROD, "Rod");
    expect((await call(token, "file", { ...fields, file: path.join(cwd, "photo.jpg") })).status).toBe(200);
  });

  it("RECEIPT-FILES-WHAT-WAS-SENT what is filed is the file as it arrived: changing the copy in the turn's folder — or pointing it at a secret — changes nothing", async () => {
    const secret = path.join(tmp, "tenant-secret.txt");
    writeFileSync(secret, "a secret the worker can read and the turn must not");
    const { token, cwd } = startWith(ROD, "Rod");
    rmSync(path.join(cwd, "photo.jpg"));
    try {
      symlinkSync(secret, path.join(cwd, "photo.jpg"));
    } catch {
      writeFileSync(path.join(cwd, "photo.jpg"), "swapped"); // no symlinks here (Windows): a plain swap
    }
    expect((await call(token, "file", fields)).status).toBe(200);
    const filed = execFileSync("git", ["cat-file", "blob", "main:2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg"], { cwd: finances.repoUrl! });
    expect(filed.equals(JPEG)).toBe(true);
  });

  it("RECEIPT-DOCUMENTS a file that is not what its name says, an empty one, or a PDF with a password is refused and nothing is written", async () => {
    const lockedPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Filter /Standard /V 2 >>\nendobj\ntrailer\n<< /Encrypt 1 0 R /Root 2 0 R >>\n%%EOF\n");
    const { token } = startWith(ROD, "Rod", [
      { name: "empty.jpg", bytes: Buffer.alloc(0) },
      { name: "words.pdf", bytes: Buffer.from("just words, not a PDF") },
      { name: "locked.pdf", bytes: lockedPdf },
    ]);
    const before = sh(["rev-parse", "main"], finances.repoUrl!).trim();
    expect((await call(token, "file", { ...fields, file: "empty.jpg" })).text).toMatch(/Not filed.*empty|not a/i);
    expect((await call(token, "file", { ...fields, file: "words.pdf" })).status).toBe(422);
    const locked = await call(token, "file", { ...fields, file: "locked.pdf" });
    expect(locked.status).toBe(422);
    expect(locked.text).toMatch(/password/i);
    expect(sh(["rev-parse", "main"], finances.repoUrl!).trim()).toBe(before);
  });

  it("RECEIPT-DOCUMENTS a real PNG, a real PDF and a real HEIC are taken", async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(12)]);
    const { token } = startWith(ROD, "Rod", [
      { name: "a.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) },
      { name: "b.pdf", bytes: Buffer.from("%PDF-1.4\n%%EOF\n") },
      { name: "c.heic", bytes: heic },
    ]);
    expect((await call(token, "file", { ...fields, file: "a.png", vendor: "A" })).status).toBe(200);
    expect((await call(token, "file", { ...fields, file: "b.pdf", vendor: "B" })).status).toBe(200);
    expect((await call(token, "file", { ...fields, file: "c.heic", vendor: "C" })).status).toBe(200);
  });

  it("RECEIPT-SAME-LAYOUT Receipts files only into a brain kept as it is, on main: any other is refused before anything is written", async () => {
    for (const wrong of [{ ...finances, asIs: false }, { ...finances, branch: "draft" }]) {
      reachOf[ROD] = [wrong];
      const { token } = startWith(ROD, "Rod");
      const r = await call(token, "file", fields);
      expect(r.status).toBe(409);
      expect(r.text).toMatch(/kept as it is|main/);
    }
    expect(sh(["log", "--oneline", "main"], finances.repoUrl!).trim().split("\n")).toHaveLength(1);
  });

  it("RECEIPT-EXTRA-PHOTOS another photo of a payment that was never filed is not a run that went well: nothing is written, and the run says so", async () => {
    const { token } = startWith(ROD, "Rod");
    const r = await call(token, "file", { ...fields, extra: true });
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/file it first/);
    expect(runs.at(-1)).toMatchObject({ status: "failed" });
    expect(runs.at(-1)!.summary).not.toMatch(/already on file/);
  });

  it("RECEIPT-TOTALS a year that is not a year is refused, never answered with this year's totals", async () => {
    const { token } = startWith(ROD, "Rod");
    expect((await call(token, "totals", { year: "2025x" })).status).toBe(400);
    expect((await call(token, "totals", {})).status).toBe(200);
  });

  it("CLI-GRANTED-GROUPS with Receipts off for the agent, the commands say so and do nothing", async () => {
    const { token } = startWith(ROD, "Rod", undefined, null as never);
    const r = await call(token, "file", fields);
    expect(r.status).toBe(403);
    expect(r.text).toMatch(/Receipts is not on/);
    expect(runs).toEqual([]);
  });

  it("RECEIPT-AMOUNTS a refund is not filed; the agent is told to ask the person", async () => {
    const { token } = startWith(ROD, "Rod");
    const r = await call(token, "file", { ...fields, amount: "-48.96" });
    expect(r.status).toBe(422);
    expect(r.text).toMatch(/Not filed.*refund/i);
  });

  it("RECEIPT-TOTALS the year's count and totals, counted from the ledger", async () => {
    const { token } = startWith(ROD, "Rod");
    await call(token, "file", fields);
    const r = await call(token, "totals", { year: "2026" });
    expect(r.text).toContain("2026: 2 entries, $69.17");
    expect(r.text).toContain("meals — 2 — $69.17");
  });
});
