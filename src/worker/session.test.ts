// The two pieces that make a thread remember itself: which harness session a conversation
// continues in, and the guarantee that only one turn is inside it at a time.
//
// Both were written after the same bug. Sapien answered a question about a Foley meeting, was
// asked "could u get me the keypoints in bullet points instead?", and replied "I don't have
// anything above this to convert — this looks like the start of our conversation." The status
// line said it plainly: `⟳ 12 · ctx 7%` on the first answer, `⟳ 1 · ctx 2%` on the second. Every
// message was a fresh `claude` run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serializer } from "./activities";
import { sessionStore } from "./worker";

describe("sessionStore — a thread continues one session", () => {
  let dir = "";
  const ids = (): (() => string) => {
    let n = 0;
    return () => `uuid-${++n}`;
  };
  const store = (): ReturnType<typeof sessionStore> => sessionStore(dir, ids());

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tonoman-sessions-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates once, then resumes: the SECOND turn in a thread is not a new session", async () => {
    const s = store();
    const first = await s.claim("nelly", "T1");
    const second = await s.claim("nelly", "T1");
    expect(first).toEqual({ id: "uuid-1", isNew: true });
    // Same session, and no longer new — `--resume`, not `--session-id`.
    expect(second).toEqual({ id: "uuid-1", isNew: false });
  });

  it("SURVIVES a restart — which is the whole reason it is on disk", async () => {
    // The in-memory version answered every question correctly until the pod was replaced, and then
    // silently forgot. Rod watched the turn counter go from 6 back to 1 mid-conversation. A second
    // store over the same directory is exactly what the next pod is.
    const first = await store().claim("nelly", "T1");
    const afterRestart = await store().claim("nelly", "T1");
    expect(afterRestart).toEqual({ id: first.id, isNew: false });
  });

  it("marks a session used on the way OUT, not after the turn succeeds", async () => {
    // The asymmetry is the whole point. A turn that dies before writing its session file leaves an
    // id pointing at nothing, and the next turn's `--resume` misses — which oneTurn repairs. The
    // other direction has no repair: `--session-id` against a file that already exists is a hard
    // error, and it would recur on every turn in that thread forever. So claiming is eager.
    const s = store();
    await s.claim("nelly", "T1"); // imagine this turn throws
    expect((await s.claim("nelly", "T1")).isNew).toBe(false);
  });

  it("NEVER lets one agent resume another's conversation", async () => {
    // A Slack conversation key is a thread timestamp — unique within one workspace and nowhere
    // else. This worker serves Murphy and Axiplex, in two different workspaces. Keyed by the
    // thread alone, Sapien would resume Nelly's session and answer Rod out of a customer's
    // transcript: the same mistake as the worker-wide notify channel, with worse contents.
    const s = store();
    const nelly = await s.claim("nelly", "1757200000.000100");
    const sapien = await s.claim("sapien", "1757200000.000100");
    expect(sapien.id).not.toBe(nelly.id);
    expect(sapien.isNew).toBe(true);
  });

  it("keeps separate threads of ONE agent separate", async () => {
    const s = store();
    expect((await s.claim("nelly", "T1")).id).not.toBe((await s.claim("nelly", "T2")).id);
  });

  it("survives a conversation key with slashes in it, which every Slack key has", async () => {
    // `T0BV.../D0C0.../1788771650.197619` — a path separator inside a filename.
    const s = store();
    const key = "T0BV5R3NXGB/D0C01GQT7MF/1788771650.197619";
    const first = await s.claim("sapien", key);
    expect(await s.claim("sapien", key)).toEqual({ id: first.id, isNew: false });
  });

  it("reset hands back a genuinely new session, ready to be created", async () => {
    const s = store();
    const before = await s.claim("nelly", "T1");
    const after = await s.reset("nelly", "T1");
    expect(after.id).not.toBe(before.id);
    expect(after.isNew).toBe(true);
    // And the thread carries on in the NEW one.
    expect(await s.claim("nelly", "T1")).toEqual({ id: after.id, isNew: false });
  });

  it("answers the turn even when the pointer cannot be written", async () => {
    // An unwritable volume costs memory, which is the behaviour we had yesterday. It must never
    // cost the answer, which is the behaviour we have never had.
    const s = sessionStore(path.join(dir, "nested", "\u0000bad"), ids());
    const got = await s.claim("nelly", "T1");
    expect(got.id).toBe("uuid-1");
    expect(got.isNew).toBe(true);
  });
});

describe("serializer — one turn at a time per conversation", () => {
  it("holds the second turn until the first is done", async () => {
    // Temporal's default activity cancellation is TRY_CANCEL: a steer moves the workflow to the
    // next turn WITHOUT waiting for this one to unwind. Two `claude` processes appending to one
    // session transcript is how a remembered conversation becomes a corrupted one.
    const run = serializer();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();

    const first = run("nelly/T1", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = run("nelly/T1", async () => {
      order.push("second:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not make one conversation wait on another", async () => {
    // Nelly's thread stalling on a slow model must not stop Sapien answering someone else.
    const run = serializer();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const slow = run("nelly/T1", async () => {
      await gate.promise;
      order.push("nelly");
    });
    await run("sapien/T9", async () => {
      order.push("sapien");
    });
    expect(order).toEqual(["sapien"]);
    gate.resolve();
    await slow;
  });

  it("a FAILED turn does not wedge the conversation shut", async () => {
    // The chain has to continue on the error path too. A lock released only on success would
    // silence a thread permanently the first time a turn threw — which is strictly worse than the
    // amnesia this whole change is fixing.
    const run = serializer();
    const boom = run("nelly/T1", async () => {
      throw new Error("model exploded");
    });
    await expect(boom).rejects.toThrow("model exploded");
    await expect(run("nelly/T1", async () => "answered")).resolves.toBe("answered");
  });

  it("surfaces each turn's own outcome to its own caller", async () => {
    const run = serializer();
    const a = run("nelly/T1", async () => "a");
    const b = run("nelly/T1", async () => {
      throw new Error("b failed");
    });
    const c = run("nelly/T1", async () => "c");
    await expect(a).resolves.toBe("a");
    await expect(b).rejects.toThrow("b failed");
    await expect(c).resolves.toBe("c");
  });

  it("forgets a conversation once its queue drains, so the map is not a leak", async () => {
    // One entry per thread ever seen would grow without bound in a worker that runs for weeks.
    const run = serializer();
    await run("nelly/T1", async () => "done");
    // Nothing to assert from outside except that the next turn still behaves like the first.
    const next = await run("nelly/T1", async () => "again");
    expect(next).toBe("again");
    vi.restoreAllMocks();
  });
});
