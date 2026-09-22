// Finishing interrupted writes at start (BRAIN-WRITE-SURVIVES-RESTART): what happens to each kind,
// and that the person is told privately.
import { describe, it, expect } from "vitest";
import { recoverWrites } from "./recover";
import type { WriteRequest } from "./store";

const brain = { id: "b-ana", tenant: "test-a", repoUrl: "/r.git" };
const entry = (over: Record<string, unknown> = {}) => ({
  status: "pending",
  brain,
  path: "AI/jev.md",
  content: "# Jev\n",
  baseBlob: null,
  note: "Jev",
  who: "Ana",
  notify: { agentGuid: "g-echo", slackUserId: "UANA" },
  ...over,
});

function fakes(landed: "yes" | "no" | "unknown", canWrite: boolean, writeOk = true) {
  const settled: [string, string][] = [];
  const told: string[] = [];
  const writes: WriteRequest[] = [];
  const d = {
    store: {
      cleanup: async () => {},
      interrupted: async () => [{ id: "op-1", entry: entry(), landed }],
      settle: async (id: string, status: string) => void settled.push([id, status]),
      write: async (req: WriteRequest) => {
        writes.push(req);
        return writeOk ? ({ ok: true, path: req.path, sha: "abc", merged: false } as const) : ({ ok: false, reason: "push-failed", detail: "remote said no" } as const);
      },
    },
    registry: {
      reach: async () => ({
        tenant: "test-a",
        speaker: { accountId: "a", name: "Ana", member: true },
        brains: canWrite ? [{ id: "b-ana", mode: "write" }] : [{ id: "b-ana", mode: "read" }],
      }),
    },
    tell: async (_g: string, user: string, text: string) => {
      told.push(`${user}: ${text}`);
      return true;
    },
    log: () => {},
  };
  return { d: d as never, settled, told, writes };
}

describe("a restart finds an unfinished write", () => {
  it("BRAIN-WRITE-SURVIVES-RESTART one that landed is closed and the person is told it is saved", async () => {
    const f = fakes("yes", true);
    expect(await recoverWrites(f.d)).toMatchObject({ landed: 1 });
    expect(f.settled).toEqual([["op-1", "pushed"]]);
    expect(f.writes).toEqual([]);
    expect(f.told).toEqual(["UANA: The note you asked me to save, `AI/jev.md`, is saved — I was restarted just as it went through."]);
  });

  it("BRAIN-WRITE-SURVIVES-RESTART one that did not land is redone for a person who may still write, then closed", async () => {
    const f = fakes("no", true);
    expect(await recoverWrites(f.d)).toMatchObject({ redone: 1 });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ path: "AI/jev.md", content: "# Jev\n" });
    expect(typeof f.writes[0].authorize).toBe("function");
    expect(f.settled).toEqual([["op-1", "pushed"]]);
    expect(f.told[0]).toMatch(/finished saving `AI\/jev\.md`/);
  });

  it("BRAIN-WRITE-SURVIVES-RESTART one whose person can no longer write there is abandoned, and they are told", async () => {
    const f = fakes("no", false);
    expect(await recoverWrites(f.d)).toMatchObject({ abandoned: 1 });
    expect(f.writes).toEqual([]);
    expect(f.settled).toEqual([["op-1", "abandoned"]]);
    expect(f.told[0]).toMatch(/can no longer write to that brain/);
  });

  it("BRAIN-WRITE-SURVIVES-RESTART one whose remote cannot be reached is left for the next start — never redone blind", async () => {
    const f = fakes("unknown", true);
    expect(await recoverWrites(f.d)).toMatchObject({ waiting: 1 });
    expect(f.writes).toEqual([]);
    expect(f.settled).toEqual([]);
    expect(f.told).toEqual([]);
  });

  it("BRAIN-WRITE-SURVIVES-RESTART a redo that fails is closed as failed, and the person hears why", async () => {
    const f = fakes("no", true, false);
    await recoverWrites(f.d);
    expect(f.settled).toEqual([["op-1", "failed"]]);
    expect(f.told[0]).toMatch(/could not save `AI\/jev\.md`: remote said no/);
  });
});

describe("a restart finds an unfinished Talent filing", () => {
  it("BRAIN-WRITE-SURVIVES-RESTART it is re-checked against what the run may reach, and redone as one filing", async () => {
    const files = [{ path: "r/page.md", content: "p" }, { path: "r/Transcript.md", content: "t" }];
    const redone: unknown[] = [];
    const d = {
      store: {
        cleanup: async () => {},
        interrupted: async () => [{ id: "op-2", entry: { status: "pending", kind: "files", files, brain, note: "Meeting recap", who: "UANA", notify: { agentGuid: "g-echo", slackUserId: "UANA", unattended: true } }, landed: "no" }],
        settle: async () => {},
        write: async () => { throw new Error("a filing is not a single page"); },
        writeFiles: async (req: unknown) => { redone.push(req); return { ok: true, paths: ["r/page.md"], sha: "abc" }; },
      },
      registry: {
        reach: async () => ({ tenant: "t", speaker: {}, brains: [] }), // the person alone cannot write there
        reachUnattended: async () => ({ brains: [{ id: "b-ana", mode: "write" }] }), // the run can
      },
      tell: async () => true,
      log: () => {},
    };
    expect(await recoverWrites(d as never)).toMatchObject({ redone: 1 });
    expect(redone).toHaveLength(1);
    expect((redone[0] as { files: unknown[] }).files).toEqual(files);
  });
});

describe("a restart finds an unfinished refresh write", () => {
  it("BRAIN-BACKGROUND-REFRESH the refresh's own interrupted map is dropped, not pushed: the refresh works it out again", async () => {
    const f = fakes("no", true);
    (f.d as { store: { interrupted: () => Promise<unknown> } }).store.interrupted = async () => [
      { id: "op-9", entry: entry({ kind: "files", system: true, files: [{ path: ".tonoman/index.md", content: "old map" }] }), landed: "no" },
    ];
    await recoverWrites(f.d);
    expect(f.writes).toEqual([]);
    expect(f.settled).toEqual([["op-9", "abandoned"]]);
    expect(f.told).toEqual([]);
  });
});

describe("a restart finds an unfinished receipt (receipt.md in Tonoman Cloud)", () => {
  const photo = Buffer.from("the photo, byte for byte");
  const receiptEntry = async () => {
    const { checkReceipt } = await import("../receipts/receipts");
    const c = checkReceipt({ vendor: "Corner Bistro", date: "2026-09-19", amount: "48.96", category: "meals", entity: "acme-llc", fileName: "IMG_1.JPG" }, ["acme-llc"]);
    if (!c.ok) throw new Error(c.ask);
    // As the broker journals it: no path, no content — the receipt and its bytes.
    return { status: "pending", kind: "planned", brain, recover: { receipt: c.r, bytes: photo.toString("base64"), entities: ["acme-llc"] }, note: "a receipt", who: "Ana", notify: { agentGuid: "g-echo", slackUserId: "UANA" } };
  };
  const withReceipt = async (landed: "yes" | "no", canWrite: boolean) => {
    const f = fakes(landed, canWrite);
    const filed: Record<string, unknown>[] = [];
    const store = (f.d as { store: Record<string, unknown> }).store;
    const e = await receiptEntry();
    store.interrupted = async () => [{ id: "op-r", entry: e, landed }];
    store.writeFiles = async (req: Record<string, unknown>) => {
      filed.push(req);
      return { ok: true, paths: [], sha: "abc" };
    };
    return { ...f, filed };
  };

  it("RECEIPT-FILED-MEANS-PUSHED a filing a restart cut short is worked out again from the brain as it is now, with the same photo and the same commit line", async () => {
    const f = await withReceipt("no", true);
    expect(await recoverWrites(f.d)).toMatchObject({ redone: 1 });
    expect(f.writes).toEqual([]); // never as a note with no path
    expect(f.filed).toHaveLength(1);
    expect(f.filed[0]!.subject).toBe("finances: 2026-09-19 Corner Bistro 48.96 (meals)");
    const plan = await (f.filed[0]!.plan as (t: unknown) => Promise<{ write: { path: string; content: Buffer | string }[] }>)({ list: async () => [], read: async () => null });
    expect(plan.write[0]!.path).toBe("2026/evidence/expenses/meals/2026/2026-09-19_corner-bistro_48.96_receipt.jpg");
    expect(Buffer.compare(plan.write[0]!.content as Buffer, photo)).toBe(0);
    expect(f.told.join("\n")).toMatch(/Corner Bistro/);
    expect(f.told.join("\n")).not.toMatch(/undefined/);
  });

  it("RECEIPT-FILED-MEANS-PUSHED one that had landed is said to be filed, by its vendor and amount", async () => {
    const f = await withReceipt("yes", true);
    expect(await recoverWrites(f.d)).toMatchObject({ landed: 1 });
    expect(f.filed).toEqual([]);
    expect(f.told.join("\n")).toMatch(/Corner Bistro.*48\.96/);
    expect(f.told.join("\n")).not.toMatch(/undefined/);
  });

  it("RECEIPT-WHO-MAY-FILE one whose person can no longer write the finances brain is dropped, and nothing is written", async () => {
    const f = await withReceipt("no", false);
    expect(await recoverWrites(f.d)).toMatchObject({ abandoned: 1 });
    expect(f.filed).toEqual([]);
    expect(f.told.join("\n")).toMatch(/Corner Bistro/);
  });
});
