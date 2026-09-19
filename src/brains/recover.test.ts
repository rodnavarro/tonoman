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
