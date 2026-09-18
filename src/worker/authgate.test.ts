// W1/W2 — the auth gate, once there are two providers to ask about.
//
// Everything here is about a person's experience of a login that is not Claude's: what the gate
// says, where it puts a one-time code, how it waits, and what it reports afterwards.

import { describe, it, expect } from "vitest";
import type { AuthOps } from "../authflow";
import {
  ask,
  awaitDeviceLogin,
  codeModal,
  connectBlocks,
  devicePrompt,
  watchDeviceLogin,
  type AuthGateDeps,
} from "./authgate";

/** A Slack connector stub that records where each message went. */
function fakeConn() {
  const posts: { kind: "blocks" | "reply" | "ephemeral"; text: string; user?: string }[] = [];
  return {
    posts,
    conn: {
      postBlocks: async (_c: string, text: string) => {
        posts.push({ kind: "blocks", text });
        return "ts";
      },
      postEphemeral: async (_c: string, user: string, text: string) => {
        posts.push({ kind: "ephemeral", text, user });
        return true;
      },
      reply: (_c: string) => ({ send: async (text: string) => void posts.push({ kind: "reply", text }) }),
      call: async () => ({}),
    } as unknown as Parameters<typeof ask>[0] extends never ? never : ReturnType<AuthGateDeps["conn"]>,
  };
}

function deps(o: {
  ops: AuthOps;
  provider?: "claude" | "codex";
  conn: ReturnType<AuthGateDeps["conn"]>;
  states?: { state: string; user?: string }[];
  logins?: string[];
}): AuthGateDeps {
  return {
    ops: () => o.ops,
    conn: () => o.conn,
    provider: () => o.provider ?? "claude",
    setAuthState: async (_a, state, user) => void o.states?.push({ state, user }),
    onLogin: async (_a, user) => void o.logins?.push(user),
  };
}

describe("wording — the gate names the agent's own provider (W2)", () => {
  it("a claude agent is offered a Claude subscription", () => {
    const b = connectBlocks("nelly", "https://claude.com/x", "c1", "claude");
    expect(b.text).toContain("Claude subscription");
    expect(JSON.stringify(b.blocks)).toContain("Open Claude login");
  });

  it("a codex agent is NOT told to connect Claude — it is a ChatGPT account", () => {
    const b = connectBlocks("nelly", "https://auth.openai.com/codex/device", "c1", "codex");
    expect(b.text).toContain("ChatGPT subscription (Codex)");
    expect(b.text).not.toContain("Claude");
    expect(JSON.stringify(b.blocks)).toContain("Open Codex login");
  });

  it("the code dialog is titled for the provider too", () => {
    expect(JSON.stringify(codeModal("a", "c", "codex"))).toContain("Connect Codex");
    expect(JSON.stringify(codeModal("a", "c"))).toContain("Connect Claude");
  });

  it("the device prompt is plain: open this, type this, and it says how long the code lasts", () => {
    const t = devicePrompt("nelly", "ChatGPT subscription (Codex)", "https://auth.openai.com/codex/device", "JLEP-DT273");
    expect(t).toContain("https://auth.openai.com/codex/device");
    expect(t).toContain("`JLEP-DT273`"); // on its own line, selectable in one gesture
    expect(t).toMatch(/15 minutes/);
    expect(t).not.toMatch(/OAuth|PKCE|device_code/i);
  });
});

describe("ask() — the flow is decided by what the runtime started (W2)", () => {
  it("a code in the answer means device auth: URL + code, posted PRIVATELY, no button", async () => {
    const f = fakeConn();
    const ops: AuthOps = {
      startHeadless: async () => ({ url: "https://auth.openai.com/codex/device", code: "JLEP-DT273" }),
      submitCode: async () => ({ ok: false, status: "", loginTail: "" }),
      // Never completes here; the point of this test is what was POSTED, not the wait.
      pending: async () => ({ done: false, loggedIn: false, status: "" }),
    };
    const d = deps({ ops, provider: "codex", conn: f.conn });
    expect(await ask(d, "a", "nelly", "c1", "U1")).toBe(true);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0].kind).toBe("ephemeral"); // a one-time code is theirs, not the channel's
    expect(f.posts[0].user).toBe("U1");
    expect(f.posts[0].text).toContain("JLEP-DT273");
  });

  it("with nobody to address privately it still says it, rather than saying nothing", async () => {
    const f = fakeConn();
    const ops: AuthOps = {
      startHeadless: async () => ({ url: "https://auth.openai.com/codex/device", code: "C0DE" }),
      submitCode: async () => ({ ok: false, status: "", loginTail: "" }),
      pending: async () => ({ done: false, loggedIn: false, status: "" }),
    };
    expect(await ask(deps({ ops, provider: "codex", conn: f.conn }), "a", "nelly", "c1")).toBe(true);
    expect(f.posts[0].kind).toBe("reply");
  });

  it("no code means the Claude flow, unchanged: blocks with a button", async () => {
    const f = fakeConn();
    const ops: AuthOps = {
      startHeadless: async () => ({ url: "https://claude.com/cai/oauth/authorize?x=1" }),
      submitCode: async () => ({ ok: true, status: "", loginTail: "" }),
    };
    expect(await ask(deps({ ops, conn: f.conn }), "a", "nelly", "c1", "U1")).toBe(true);
    expect(f.posts[0].kind).toBe("blocks");
  });
});

describe("awaitDeviceLogin — waiting is the mechanism, not a workaround (W2)", () => {
  const clock = (startMs = 0) => {
    let t = startMs;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("returns as soon as the runtime says done", async () => {
    let calls = 0;
    const ops = {
      pending: async () => ({ done: ++calls >= 3, loggedIn: calls >= 3, status: "Logged in using ChatGPT" }),
    } as unknown as AuthOps;
    const r = await awaitDeviceLogin(ops, { ...clock(), pollMs: 1000, timeoutMs: 600_000 });
    expect(r).toEqual({ ok: true, status: "Logged in using ChatGPT", timedOut: false });
    expect(calls).toBe(3);
  });

  it("gives up at the deadline and says so — a code that expired is not a failed login", async () => {
    const ops = { pending: async () => ({ done: false, loggedIn: false, status: "Not logged in" }) } as unknown as AuthOps;
    const r = await awaitDeviceLogin(ops, { ...clock(), pollMs: 60_000, timeoutMs: 600_000 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("a transport blip mid-wait is not an answer: it keeps waiting", async () => {
    let calls = 0;
    const ops = {
      pending: async () => {
        calls++;
        if (calls < 3) throw new Error("fetch failed");
        return { done: true, loggedIn: true, status: "Logged in using ChatGPT" };
      },
    } as unknown as AuthOps;
    const r = await awaitDeviceLogin(ops, { ...clock(), pollMs: 1000, timeoutMs: 600_000 });
    expect(r.ok).toBe(true);
  });

  it("an ops with no pending() (the Claude transport) never claims a login", async () => {
    const ops = { startHeadless: async () => ({ url: "x" }), submitCode: async () => ({ ok: true, status: "", loginTail: "" }) };
    expect(await awaitDeviceLogin(ops, {})).toEqual({ ok: false, status: "", timedOut: false });
  });
});

describe("watchDeviceLogin — the outcome is reported, in order (W2/W3)", () => {
  it("registers the person BEFORE reporting their auth state, then confirms privately", async () => {
    const f = fakeConn();
    const order: string[] = [];
    const states: { state: string; user?: string }[] = [];
    const ops = { pending: async () => ({ done: true, loggedIn: true, status: "ok" }) } as unknown as AuthOps;
    const d: AuthGateDeps = {
      ops: () => ops,
      conn: () => f.conn,
      provider: () => "codex",
      setAuthState: async (_a, state, user) => {
        order.push("state");
        states.push({ state, user });
      },
      onLogin: async () => void order.push("register"),
    };
    await watchDeviceLogin(d, "a", "c1", ops, "U1", true, { pollMs: 1, timeoutMs: 1000 });
    // The per-person auth-state route only UPDATES an existing principal and 404s for a new one —
    // so registering second would silently lose the very first login of every new teammate.
    expect(order).toEqual(["register", "state"]);
    expect(states).toEqual([{ state: "ok", user: "U1" }]);
    expect(f.posts.at(-1)).toMatchObject({ kind: "ephemeral", user: "U1" });
    expect(f.posts.at(-1)!.text).toContain("Connected");
  });

  it("a timeout says the code may have expired and offers a fresh one — not a bare error", async () => {
    const f = fakeConn();
    const states: { state: string; user?: string }[] = [];
    const ops = { pending: async () => ({ done: false, loggedIn: false, status: "" }) } as unknown as AuthOps;
    const d: AuthGateDeps = {
      ops: () => ops,
      conn: () => f.conn,
      provider: () => "codex",
      setAuthState: async (_a, state, user) => void states.push({ state, user }),
    };
    await watchDeviceLogin(d, "a", "c1", ops, "U1", false, { pollMs: 1, timeoutMs: 2, now: (() => { let t = 0; return () => (t += 2); })() });
    expect(states).toEqual([{ state: "error", user: "U1" }]);
    expect(f.posts.at(-1)!.text).toContain("!connect codex");
  });

  it("never throws into its caller when the registry is unreachable", async () => {
    const f = fakeConn();
    const ops = { pending: async () => ({ done: true, loggedIn: true, status: "ok" }) } as unknown as AuthOps;
    const d: AuthGateDeps = {
      ops: () => ops,
      conn: () => f.conn,
      setAuthState: async () => {
        throw new Error("registry down");
      },
    };
    await expect(watchDeviceLogin(d, "a", "c1", ops, "U1", false, { pollMs: 1, timeoutMs: 1000 })).resolves.toBeUndefined();
    expect(f.posts.at(-1)!.text).toContain("Connected");
  });
});
