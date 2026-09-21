// Filing a receipt into a real git remote shaped like the finances repo: what lands on `main`, the
// exact commit line, nothing else added, and a push that someone else beat. Rules: Tonoman Cloud's
// docs/definition/objects/receipt.md and brain.md (BRAIN-AS-IS, BRAIN-FILES-NOT-JUST-PAGES).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real git on every test: slower than the 5s default when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createStore, type BrainRef } from "../brains/store";
import { checkReceipt, planReceipt, LEDGER_HEADER } from "./receipts";

let tmp: string;
let remote: string;
let brain: BrainRef;
const sh = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const LEDGER = "2026/spreadsheet/deductions_ledger.csv";
const EVIDENCE = "2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg";

/** A person's own clone, to look at `main` or push to it by hand. */
const clone = () => {
  const d = mkdtempSync(path.join(tmp, "c-"));
  sh(["-c", "core.autocrlf=false", "clone", "-q", remote, d]);
  sh(["config", "user.name", "x"], d);
  sh(["config", "user.email", "x@x"], d);
  return d;
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "receipts-"));
  remote = path.join(tmp, "finances.git");
  sh(["init", "-q", "--bare", "-b", "main", remote]);
  const seed = mkdtempSync(path.join(tmp, "seed-"));
  sh(["init", "-q", "-b", "main"], seed);
  sh(["config", "user.name", "x"], seed);
  sh(["config", "user.email", "x@x"], seed);
  execFileSync("sh", ["-c", `mkdir -p 2026/spreadsheet && printf '%s\\n%s\\n' '${LEDGER_HEADER}' 'captured,meals,20.21,Starbucks Coffee,acme-llc,p,note,,' > ${LEDGER} && echo '# Finances' > README.md`], { cwd: seed });
  sh(["add", "-A"], seed);
  sh(["commit", "-q", "-m", "seed"], seed);
  sh(["push", "-q", remote, "main"], seed);
  brain = { id: "b-fin", tenant: "acme", repoUrl: remote, branch: "main", asIs: true };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const store = () => createStore({ root: path.join(tmp, "w"), token: async () => "", fetchEveryMs: 0, log: () => {} });
const receipt = () => {
  const c = checkReceipt({ vendor: "Corner Bistro", date: "2026-09-19", amount: "48.96", category: "meals", entity: "acme-llc", fileName: "photo.JPG", note: "Business breakfast" }, ["acme-llc", "northwind-ventures-llc"]);
  if (!c.ok) throw new Error(c.ask);
  return c.r;
};
const photo = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0xfe, 0x0a, 0x0d]); // bytes that text handling would damage
const file = (s: ReturnType<typeof store>, bytes = photo) => {
  const r = receipt();
  return s.writeFiles({ brain, files: [], note: r.subject, subject: r.subject, who: "Rod", plan: (t) => planReceipt(r, bytes, t) });
};

describe("a receipt on main", () => {
  it("RECEIPT-SAME-LAYOUT one commit, its first line exactly `finances: <date> <Vendor> <amount> (<category>)`, the file and the row", async () => {
    expect(await file(store())).toMatchObject({ ok: true });
    const c = clone();
    expect(sh(["log", "-1", "--format=%s"], c).trim()).toBe("finances: 2026-09-19 Corner Bistro 48.96 (meals)");
    expect(existsSync(path.join(c, EVIDENCE))).toBe(true);
    expect(readFileSync(path.join(c, LEDGER), "utf8").trim().split("\n").at(-1)).toBe(
      `captured,meals,48.96,Corner Bistro,acme-llc,${EVIDENCE},Business breakfast,,`,
    );
  });

  it("BRAIN-FILES-NOT-JUST-PAGES the photo lands byte for byte", async () => {
    await file(store());
    expect(readFileSync(path.join(clone(), EVIDENCE)).equals(photo)).toBe(true);
  });

  it("BRAIN-AS-IS nothing but the file and the row is added — no log.md, no BRAIN.md, no map", async () => {
    await file(store());
    const c = clone();
    expect(sh(["show", "--name-only", "--format=", "HEAD"], c).trim().split("\n").sort()).toEqual([LEDGER, EVIDENCE].sort());
    for (const f of ["log.md", "BRAIN.md", ".tonoman"]) expect(existsSync(path.join(c, f))).toBe(false);
  });

  it("RECEIPT-NO-DOUBLE the same receipt again writes nothing and says where the first one is", async () => {
    const s = store();
    await file(s);
    const before = sh(["rev-parse", "main"], remote).trim();
    const again = await file(s);
    expect(again).toMatchObject({ ok: true, outcome: { status: "duplicate", evidence: EVIDENCE } });
    expect(sh(["rev-parse", "main"], remote).trim()).toBe(before);
  });

  it("RECEIPT-FILED-MEANS-PUSHED someone pushed first: the filing lands on top, and both are on main", async () => {
    const s = store();
    await s.fetchNow(brain); // the worker's copy is now behind what is about to happen
    const other = clone();
    execFileSync("sh", ["-c", `printf 'captured,travel,100.00,Delta,acme-llc,q,by hand,,\\n' >> ${LEDGER}`], { cwd: other });
    sh(["commit", "-qam", "by hand"], other);
    sh(["push", "-q"], other);
    expect(await file(s)).toMatchObject({ ok: true });
    const rows = readFileSync(path.join(clone(), LEDGER), "utf8").trim().split("\n");
    expect(rows.some((r) => r.includes("Delta"))).toBe(true);
    expect(rows.at(-1)).toContain("Corner Bistro");
  });

  it("RECEIPT-FILED-MEANS-PUSHED someone pushed while this one was being worked out: the push is refused, it is worked out again on top, and both are on main", async () => {
    const s = store();
    const r = receipt();
    let planned = 0;
    const res = await s.writeFiles({
      brain, files: [], note: r.subject, subject: r.subject, who: "Rod",
      plan: async (t) => {
        if (planned++ === 0) {
          // After the plan has read the brain, before its push: a person pushes by hand.
          const other = clone();
          execFileSync("sh", ["-c", `printf 'captured,travel,100.00,Delta,acme-llc,q,by hand,,\\n' >> ${LEDGER}`], { cwd: other });
          sh(["commit", "-qam", "by hand"], other);
          sh(["push", "-q"], other);
        }
        return planReceipt(r, photo, t);
      },
    });
    expect(res).toMatchObject({ ok: true });
    expect(planned).toBe(2);
    const rows = readFileSync(path.join(clone(), LEDGER), "utf8").trim().split("\n");
    expect(rows.filter((x) => x.includes("Delta"))).toHaveLength(1);
    expect(rows.filter((x) => x.includes("Corner Bistro"))).toHaveLength(1);
  });

  it("RECEIPT-FILED-MEANS-PUSHED a repo that ignores photos still gets the photo: 'filed' is never said of a row with no file", async () => {
    const other = clone();
    execFileSync("sh", ["-c", "printf '*.jpg\n' > .gitignore"], { cwd: other });
    sh(["add", "-A"], other);
    sh(["commit", "-qm", "ignore photos"], other);
    sh(["push", "-q"], other);
    expect(await file(store())).toMatchObject({ ok: true, outcome: { status: "filed" } });
    expect(sh(["ls-tree", "-r", "--name-only", "main"], remote)).toContain(EVIDENCE);
  });

  it("BRAIN-FILES-NOT-JUST-PAGES a repo that treats photos as text does not get to change their bytes", async () => {
    const other = clone();
    execFileSync("sh", ["-c", "printf '*.jpg text eol=crlf\n' > .gitattributes"], { cwd: other });
    sh(["add", "-A"], other);
    sh(["commit", "-qm", "photos as text"], other);
    sh(["push", "-q"], other);
    const bytes = Buffer.from("line one\nline two\r\nline three\n");
    await file(store(), bytes);
    const blob = execFileSync("git", ["cat-file", "blob", `main:${EVIDENCE}`], { cwd: remote });
    expect(blob.equals(bytes)).toBe(true);
  });

  it("RECEIPT-EXTRA-PHOTOS another photo of a filed payment lands beside the first on main, and the ledger is untouched", async () => {
    const s = store();
    await file(s);
    const ledgerBefore = sh(["rev-parse", `main:${LEDGER}`], remote).trim();
    const c = checkReceipt({ vendor: "Corner Bistro", date: "2026-09-19", amount: "48.96", category: "meals", entity: "acme-llc", fileName: "back.png", extra: true }, ["acme-llc"]);
    if (!c.ok) throw new Error(c.ask);
    const second = Buffer.from("the back of the receipt");
    const send = () => s.writeFiles({ brain, files: [], note: c.r.subject, subject: c.r.subject, who: "Rod", plan: (t) => planReceipt(c.r, second, t) });
    expect(await send()).toMatchObject({ ok: true, outcome: { status: "extra", evidence: EVIDENCE.replace(".jpg", "_2.png") } });
    expect(sh(["rev-parse", `main:${LEDGER}`], remote).trim()).toBe(ledgerBefore);
    // Sent again after a lost answer: already kept, not kept twice.
    expect(await send()).toMatchObject({ ok: true, outcome: { status: "extra", evidence: EVIDENCE.replace(".jpg", "_2.png") } });
    expect(sh(["ls-tree", "-r", "--name-only", "main"], remote)).not.toContain("_3.");
  });
});
