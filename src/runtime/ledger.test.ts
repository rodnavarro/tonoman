import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger, type LedgerEntry } from "./ledger";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tonoman-ledger-"));
  file = path.join(dir, "ledger.jsonl");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Reads the ledger file back as parsed JSONL entries. */
async function lines(): Promise<LedgerEntry[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerEntry);
}

/** A monotonic fake clock so durations and ordering are deterministic. */
function fakeClock(startMs: number, stepMs: number): () => Date {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

describe("Ledger — broker op accounting", () => {
  it("records start + terminal for a completed op, clearing in-flight, with a duration", async () => {
    const led = new Ledger({ file, clock: fakeClock(1_000, 500) });
    await led.opStart("op1", ["compose", "up", "-d"], "/root/files/acme");
    expect(led.inFlight().map((e) => e.id)).toEqual(["op1"]);
    await led.opEnd("op1", { code: 0, argv: ["compose", "up", "-d"] });
    expect(led.inFlight()).toEqual([]);

    const ls = await lines();
    expect(ls.map((l) => l.phase)).toEqual(["op-start", "op-end"]);
    expect(ls[0].verb).toBe("compose");
    expect(ls[0].argv).toEqual(["compose", "up", "-d"]);
    expect(ls[1].code).toBe(0);
    expect(ls[1].durationMs).toBe(500); // one clock step between start and end
  });

  it("THE CATCH: an op started but never terminal is flagged orphaned at turn-end, not silently absent", async () => {
    const led = new Ledger({ file, clock: fakeClock(1_000, 1_000) });
    // The agent fired a long brokered restore, then the turn returned without waiting
    // (Claude Code backgrounded it) — no op-end ever arrives.
    await led.opStart("restore", ["run", "postgres:17"], "/root/files/acme");

    const orphans = await led.endTurn("tg:42");
    expect(orphans).toEqual(["restore"]);

    const ls = await lines();
    const phases = ls.map((l) => l.phase);
    expect(phases).toContain("op-orphaned");
    expect(phases).toContain("turn-end");
    const orphanLine = ls.find((l) => l.phase === "op-orphaned")!;
    expect(orphanLine.id).toBe("restore");
    expect(orphanLine.verb).toBe("run");
    const turnEnd = ls.find((l) => l.phase === "turn-end")!;
    expect(turnEnd.orphans).toBe(1);
    expect(turnEnd.conv).toBe("tg:42");
  });

  it("a clean turn (all ops terminal) flags nothing and records orphans:0", async () => {
    const led = new Ledger({ file, clock: fakeClock(1_000, 100) });
    await led.opStart("op1", ["ps"]);
    await led.opEnd("op1", { code: 0 });
    const orphans = await led.endTurn("tg:7");
    expect(orphans).toEqual([]);

    const ls = await lines();
    expect(ls.some((l) => l.phase === "op-orphaned")).toBe(false);
    expect(ls.find((l) => l.phase === "turn-end")!.orphans).toBe(0);
  });

  it("does not double-flag an op already orphaned by a prior turn-end", async () => {
    const led = new Ledger({ file, clock: fakeClock(1_000, 100) });
    await led.opStart("slow", ["run", "x"]);
    expect(await led.endTurn("c")).toEqual(["slow"]);
    expect(await led.endTurn("c")).toEqual([]); // already flagged → not re-reported

    const ls = await lines();
    expect(ls.filter((l) => l.phase === "op-orphaned").length).toBe(1);
  });

  it("records a denial as a terminal op-end (the broker refused; nothing ran)", async () => {
    const led = new Ledger({ file, clock: fakeClock(1_000, 100) });
    await led.opStart("bad", ["run", "--privileged", "img"]);
    await led.opEnd("bad", { code: 126, denied: true, reason: "flag --privileged is denied" });
    expect(led.inFlight()).toEqual([]);

    const ls = await lines();
    const end = ls.find((l) => l.phase === "op-end")!;
    expect(end.denied).toBe(true);
    expect(end.reason).toContain("--privileged");
  });

  it("never persists an injected secret — only the argv the caller passes is written", async () => {
    const led = new Ledger({ file, clock: fakeClock(1_000, 100) });
    // The broker would inject `-e TOKEN=secret` into the *executed* argv, but the
    // caller passes only the authorized (pre-injection) argv. The ledger writes that.
    await led.opStart("build", ["build", "-t", "img", "."]);
    await led.opEnd("build", { code: 0, argv: ["build", "-t", "img", "."] });

    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("secret");
    expect(raw).not.toMatch(/-e\s+\w+=/);
  });

  it("appends across instances (the ledger is durable, not in-memory only)", async () => {
    const a = new Ledger({ file, clock: fakeClock(1_000, 100) });
    await a.opStart("op1", ["ps"]);
    await a.opEnd("op1", { code: 0 });
    // A fresh instance (e.g. gateway restart) appends, doesn't truncate.
    const b = new Ledger({ file, clock: fakeClock(5_000, 100) });
    await b.opStart("op2", ["ps"]);
    await b.opEnd("op2", { code: 0 });

    const ls = await lines();
    expect(ls.length).toBe(4);
  });
});
