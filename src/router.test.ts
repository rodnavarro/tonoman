import { describe, it, expect } from "vitest";
import { Router, buildPrompt } from "./router";
import type {
  Connector,
  Envelope,
  Message,
  MemoryStore,
  Reply,
  Streamer,
  TurnEvent,
  TurnRequest,
  TurnRunner,
} from "./core/contracts";

/** Records what the router commits to memory. */
function fakeMemory(): { mem: MemoryStore; appended: Message[][] } {
  const appended: Message[][] = [];
  const mem: MemoryStore = {
    readWindow: async () => [],
    append: async (_conv, ...msgs) => {
      appended.push(msgs);
    },
    commit: async () => {},
    newSession: async () => "s",
  };
  return { mem, appended };
}

const noopReply: Reply = {
  send: async () => "1",
  update: async () => {},
  finalize: async () => {},
  canEdit: () => true,
  working: async () => {},
};
const conn: Connector = {
  name: () => "test",
  receive: async function* () {},
  reply: () => noopReply,
};
const runner: TurnRunner = { run: async function* (): AsyncIterable<TurnEvent> {} };
const env: Envelope = { channel: "test", conversation: "c", user: "u", text: "do the thing", mediaPaths: [] };

/** A streamer that just returns a fixed "final" so we can test the router's
 * commit/discard decision independent of real streaming. */
function fixedStreamer(out: string): Streamer {
  return { consume: async () => out };
}

function router(mem: MemoryStore, streamer: Streamer): Router {
  return new Router({
    agent: { name: "cody", runner, memory: mem, windowSize: 30 },
    streamer,
  });
}

describe("buildPrompt — sender identity injection (teams-identity-aware)", () => {
  const win: Message[] = [];
  it("names the current user so the agent greets/acts by identity, not a guess", () => {
    const p = buildPrompt("Atlas", "billing assistant", win, { ...env, user: "Priya Raman", text: "hi" });
    expect(p).toContain("# Current user");
    expect(p).toContain("Priya Raman");
    expect(p).toContain("# New message");
  });
  it("omits the current-user block when there is no sender name", () => {
    const p = buildPrompt("Atlas", "billing assistant", win, { ...env, user: "", text: "hi" });
    expect(p).not.toContain("# Current user");
  });
  it("is independent of isolation — the user line reflects THIS message's sender", () => {
    const a = buildPrompt("Atlas", "", win, { ...env, user: "Dana Whitfield", text: "x" });
    const b = buildPrompt("Atlas", "", win, { ...env, user: "Rod Navarro", text: "x" });
    expect(a).toContain("Dana Whitfield");
    expect(b).toContain("Rod Navarro");
    expect(a).not.toContain("Rod Navarro");
  });
});

describe("Router — commit vs discard per interrupt reason (gw-command-steer/interrupt)", () => {
  it("commits a normal (uninterrupted) turn", async () => {
    const f = fakeMemory();
    await router(f.mem, fixedStreamer("the answer")).handle(conn, env); // no signal → not aborted
    expect(f.appended).toHaveLength(1);
    expect(f.appended[0].map((m) => `${m.role}:${m.text}`)).toEqual(["user:do the thing", "assistant:the answer"]);
  });

  it("commits the PARTIAL on /steer (aborted, reason=steer) — continuity kept", async () => {
    const f = fakeMemory();
    const ac = new AbortController();
    ac.abort("steer");
    await router(f.mem, fixedStreamer("half-done work")).handle(conn, env, ac.signal);
    expect(f.appended).toHaveLength(1);
    expect(f.appended[0][1].text).toBe("half-done work");
  });

  it("DISCARDS on /interrupt (aborted, reason=interrupt) — clean cut", async () => {
    const f = fakeMemory();
    const ac = new AbortController();
    ac.abort("interrupt");
    await router(f.mem, fixedStreamer("abandoned work")).handle(conn, env, ac.signal);
    expect(f.appended).toHaveLength(0);
  });

  it("DISCARDS on /new (aborted, reason=reset)", async () => {
    const f = fakeMemory();
    const ac = new AbortController();
    ac.abort("reset");
    await router(f.mem, fixedStreamer("x")).handle(conn, env, ac.signal);
    expect(f.appended).toHaveLength(0);
  });
});

describe("Router — session-resume mode (feed only the new message; harness resumes its own session)", () => {
  it("CREATE turn seeds the window (once), RESUME turns never re-send it", async () => {
    const reqs: TurnRequest[] = [];
    const capturing: TurnRunner = {
      run(req): AsyncIterable<TurnEvent> {
        reqs.push(req); // eager: fixedStreamer doesn't iterate the generator
        return (async function* (): AsyncIterable<TurnEvent> {})();
      },
    };
    let started = false;
    const mem: MemoryStore = {
      // A non-empty window on a CREATE turn only happens via a /compact seed (a brand-new
      // conversation reads empty). It must ride into the fresh session; a RESUME turn skips it.
      readWindow: async () => [{ role: "user", text: "SEED-LINE", ts: "t" }],
      append: async () => {},
      commit: async () => {},
      newSession: async () => "s",
      harnessSession: async () => ({ id: "uuid-X", isNew: !started }),
      markHarnessSession: async () => {
        started = true;
      },
    };
    const r = new Router({
      agent: { name: "billy", runner: capturing, memory: mem, windowSize: 30, sessionPersist: true },
      streamer: fixedStreamer("ok"),
    });

    await r.handle(conn, env);
    expect(reqs[0].sessionId).toBe("uuid-X");
    expect(reqs[0].sessionNew).toBe(true); // first turn CREATES the session
    expect(reqs[0].prompt).toContain("SEED-LINE"); // the seed (compact summary) rides into the new session
    expect(reqs[0].prompt).toContain("do the thing"); // the new message IS sent

    await r.handle(conn, env);
    expect(reqs[1].sessionNew).toBe(false); // subsequent turn RESUMES it
    expect(reqs[1].prompt).not.toContain("SEED-LINE"); // resume never re-sends the window (cache reuse)
  });

  it("without sessionPersist, still injects the window and sends no session flags (unchanged path)", async () => {
    const reqs: TurnRequest[] = [];
    const capturing: TurnRunner = {
      run(req): AsyncIterable<TurnEvent> {
        reqs.push(req); // eager: fixedStreamer doesn't iterate the generator
        return (async function* (): AsyncIterable<TurnEvent> {})();
      },
    };
    const mem: MemoryStore = {
      readWindow: async () => [{ role: "user", text: "OLD-HISTORY-LINE", ts: "t" }],
      append: async () => {},
      commit: async () => {},
      newSession: async () => "s",
    };
    const r = new Router({ agent: { name: "cody", runner: capturing, memory: mem, windowSize: 30 }, streamer: fixedStreamer("ok") });
    await r.handle(conn, env);
    expect(reqs[0].sessionId).toBeUndefined();
    expect(reqs[0].prompt).toContain("OLD-HISTORY-LINE"); // window fed as before
  });
});

// gw-auth-actionable — an auth failure must reach the user with the fix, not fail silently.
describe("Router — auth failure → actionable notice (gw-auth-actionable)", () => {
  function recordingConn(): { conn: Connector; sent: string[] } {
    const sent: string[] = [];
    const reply: Reply = { ...noopReply, send: async (t: string) => (sent.push(t), "1") };
    return { conn: { ...conn, reply: () => reply }, sent };
  }
  const thrower = (msg: string): Streamer => ({
    consume: async () => {
      throw new Error(msg);
    },
  });

  it("on a 401, replies with the fix command and does NOT commit the turn", async () => {
    const f = fakeMemory();
    const rc = recordingConn();
    await router(f.mem, thrower("claudecode: exit 1: Failed to authenticate. API Error: 401 Invalid authentication credentials")).handle(rc.conn, env);
    expect(rc.sent.some((s) => s.includes("tonoman auth login cody --headless"))).toBe(true);
    expect(f.appended).toHaveLength(0); // failed turn isn't recorded as a normal exchange
  });

  it("a NON-auth turn error is SURFACED to the user, never silent (gw-turn-ended-actionable)", async () => {
    const f = fakeMemory();
    const rc = recordingConn();
    await router(f.mem, thrower("podman: container not found")).handle(rc.conn, env); // no throw: handled
    expect(rc.sent.some((s) => s.includes("couldn't finish"))).toBe(true);
    expect(rc.sent.some((s) => s.includes("container not found"))).toBe(true); // detail carried
    expect(rc.sent.some((s) => s.includes("auth login"))).toBe(false); // not misclassified as auth
    expect(f.appended).toHaveLength(0); // a failed turn isn't recorded as a normal exchange
  });

  it("resume-miss self-heals: rotates to a fresh session, tells the user, retries once", async () => {
    const rc = recordingConn();
    let rotated = false;
    const appended: Message[][] = [];
    const mem: MemoryStore = {
      readWindow: async () => [],
      append: async (_c, ...m) => {
        appended.push(m);
      },
      commit: async () => {},
      newSession: async () => ((rotated = true), "new"),
      // resumes an "old" session until rotated, then mints a fresh one
      harnessSession: async () => (rotated ? { id: "new-uuid", isNew: true } : { id: "old-uuid", isNew: false }),
      markHarnessSession: async () => {},
    };
    let calls = 0;
    const streamer: Streamer = {
      consume: async () => {
        if (++calls === 1) throw new Error("claude turn failed (error_during_execution)");
        return "recovered answer";
      },
    };
    const reqs: TurnRequest[] = [];
    const capturing: TurnRunner = {
      run(req) {
        reqs.push(req);
        return (async function* (): AsyncIterable<TurnEvent> {})();
      },
    };
    const r = new Router({
      agent: { name: "cody", runner: capturing, memory: mem, windowSize: 30, sessionPersist: true },
      streamer,
    });
    await r.handle(rc.conn, env);
    expect(rotated).toBe(true); // rotated to a fresh session
    expect(rc.sent.some((s) => s.includes("started a fresh one"))).toBe(true); // told the user
    expect(reqs).toHaveLength(2); // ran twice: resume, then fresh
    expect(reqs[0].sessionId).toBe("old-uuid");
    expect(reqs[1]).toMatchObject({ sessionId: "new-uuid", sessionNew: true });
    expect(appended.length).toBeGreaterThan(0); // the recovered turn IS committed
  });
});
