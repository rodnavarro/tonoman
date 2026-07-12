import { describe, it, expect } from "vitest";
import { TurnQueue, mergePending, type RunTurn, type PendingMsg } from "./turnqueue";

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const m = (text: string): PendingMsg => ({ text, user: "u", mediaPaths: [] });
const OPTS = { coalesceMs: 20 };

/** A controllable fake turn runner: records each turn's text + abort reason, lets the
 * test finish the in-flight turn, and resolves promptly when its turn is aborted. */
function harness() {
  const calls: string[] = [];
  const reasons: unknown[] = [];
  let resolveCurrent: (() => void) | null = null;
  const runTurn: RunTurn = (msg, signal) => {
    calls.push(msg.text);
    return new Promise<void>((resolve) => {
      resolveCurrent = resolve;
      signal.addEventListener(
        "abort",
        () => {
          reasons.push(signal.reason);
          resolve();
        },
        { once: true },
      );
    });
  };
  return {
    calls,
    reasons,
    runTurn,
    finish: () => {
      const r = resolveCurrent;
      resolveCurrent = null;
      r?.();
    },
  };
}

describe("mergePending", () => {
  it("merges two messages chronologically, blank-line separated", () => {
    expect(mergePending(m("A"), m("B"))).toEqual({ text: "A\n\nB", user: "u", mediaPaths: [] });
  });
  it("returns the other when one side is null", () => {
    expect(mergePending(null, m("B"))!.text).toBe("B");
    expect(mergePending(m("A"), null)!.text).toBe("A");
  });
  it("carries the latest verified identity through a merge (identity-roster)", () => {
    const a: PendingMsg = { text: "A", user: "u", mediaPaths: [], identity: { name: "Rod", verified: true } };
    const b: PendingMsg = { text: "B", user: "u", mediaPaths: [], identity: { name: "Rod2", verified: true } };
    expect(mergePending(a, b)!.identity!.name).toBe("Rod2"); // latest wins, like `user`
    expect(mergePending(a, m("B"))!.identity!.name).toBe("Rod"); // preserved when the new msg has none
  });
});

describe("TurnQueue — identity survives the queue → RunTurn (identity-roster regression)", () => {
  it("hands the sender identity to the turn runner instead of dropping it at the queue boundary", async () => {
    let seen: PendingMsg | null = null;
    const run: RunTurn = async (msg) => { seen = msg; };
    const ac = new AbortController();
    const q = new TurnQueue(run, ac.signal, { coalesceMs: 0 });
    q.message("draft invoices", "Rod", [], { name: "Rod2", role: "operator", email: "rod2@example.com", verified: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).not.toBeNull();
    expect(seen!.identity).toMatchObject({ name: "Rod2", verified: true });
  });
});

describe("TurnQueue — queue by default (gw-turn-enqueue)", () => {
  it("runs an idle message", async () => {
    const h = harness();
    const q = new TurnQueue(h.runTurn, new AbortController().signal, OPTS);
    q.message("A", "u");
    await sleep(40);
    expect(h.calls).toEqual(["A"]);
    expect(h.reasons).toEqual([]);
  });

  it("QUEUES a message that arrives while busy (no interrupt) and merges follow-ups", async () => {
    const h = harness();
    const q = new TurnQueue(h.runTurn, new AbortController().signal, OPTS);
    q.message("A", "u"); // idle → starts
    await sleep(40);
    q.message("check the worker", "u"); // arrives while busy → QUEUED, not an interrupt
    q.message("and the api", "u"); // merges with the queued one
    await sleep(40);
    expect(h.calls).toEqual(["A"]); // still just A running — nothing was interrupted
    expect(h.reasons).toEqual([]);
    h.finish(); // A completes on its own
    await sleep(40);
    expect(h.calls).toEqual(["A", "check the worker\n\nand the api"]); // merged queue ran after
    expect(h.reasons).toEqual([]); // never interrupted
  });

  it("emits queue-depth changes for the footer (grows to N while running, 0 when picked up)", async () => {
    const h = harness();
    const events: Array<[number, boolean]> = [];
    const q = new TurnQueue(h.runTurn, new AbortController().signal, { ...OPTS, onPendingChange: (n, _p, running) => events.push([n, running]) });
    q.message("A", "u");
    await sleep(40); // A running
    q.message("q1", "u");
    q.message("q2", "u");
    expect(events.some(([n, r]) => n === 2 && r === true)).toBe(true); // depth 2 while a turn runs
    h.finish();
    await sleep(40);
    expect(events[events.length - 1][0]).toBe(0); // queue picked up → footer clears
  });
});

describe("TurnQueue — /steer and /pop interrupt and keep context", () => {
  it("/steer interrupts the running turn (reason steer), folds in the queue, runs now", async () => {
    const h = harness();
    const q = new TurnQueue(h.runTurn, new AbortController().signal, OPTS);
    q.message("A", "u");
    await sleep(40);
    q.message("queued1", "u"); // sitting in the queue
    q.steer("do this now", "u"); // interrupt + fold in queued1
    await sleep(40);
    expect(h.calls).toEqual(["A", "queued1\n\ndo this now"]);
    expect(h.reasons).toEqual(["steer"]); // partial KEPT as context
  });

  it("/pop runs the queued message(s) now (interrupt, keep context); false when empty", async () => {
    const h = harness();
    const q = new TurnQueue(h.runTurn, new AbortController().signal, OPTS);
    q.message("A", "u");
    await sleep(40);
    expect(q.pop()).toBe(false); // nothing queued yet
    q.message("q1", "u");
    q.message("q2", "u");
    expect(q.pop()).toBe(true);
    await sleep(40);
    expect(h.calls).toEqual(["A", "q1\n\nq2"]);
    expect(h.reasons).toEqual(["steer"]);
  });
});

describe("TurnQueue — /interrupt hard cut, /new resets, /skip clears the queue", () => {
  it("/interrupt aborts (reason interrupt), drops the queue, runs fresh", async () => {
    const h = harness();
    const q = new TurnQueue(h.runTurn, new AbortController().signal, OPTS);
    q.message("A", "u");
    await sleep(40);
    q.message("q1", "u"); // would-be queued
    q.interrupt("X", "u"); // hard cut: drops q1, aborts A
    await sleep(40);
    expect(h.calls).toEqual(["A", "X"]);
    expect(h.reasons).toEqual(["interrupt"]);
  });

  it("/new (reset) aborts with reason reset and clears the queue", async () => {
    const h = harness();
    const q = new TurnQueue(h.runTurn, new AbortController().signal, OPTS);
    q.message("A", "u");
    await sleep(40);
    q.reset();
    await sleep(40);
    expect(h.calls).toEqual(["A"]);
    expect(h.reasons).toEqual(["reset"]);
  });

  it("/skip clears the queue so it never runs", async () => {
    const h = harness();
    const q = new TurnQueue(h.runTurn, new AbortController().signal, OPTS);
    q.message("A", "u");
    await sleep(40);
    q.message("q1", "u");
    expect(q.cancelPending()).toBe(true);
    h.finish();
    await sleep(40);
    expect(h.calls).toEqual(["A"]);
  });
});
