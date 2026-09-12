import { describe, it, expect } from "vitest";
import { parseWake } from "./wake";

describe("parseWake", () => {
  it("accepts a wake addressed to a user", () => {
    const r = parseWake({ agent: "acme-nova", user: "U1", text: "your meeting is ready" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req).toMatchObject({ agent: "acme-nova", user: "U1", verbatim: false });
  });

  it("accepts a wake addressed to a conversation", () => {
    const r = parseWake({ agent: "acme-nova", conversation: "T1/C2", text: "hi" });
    expect(r.ok).toBe(true);
  });

  it("says what is missing rather than failing vaguely — other systems call this", () => {
    expect(parseWake({ text: "x", user: "U1" })).toEqual({ ok: false, error: "agent is required" });
    expect(parseWake({ agent: "a", user: "U1" })).toEqual({ ok: false, error: "text is required" });
    expect(parseWake({ agent: "a", text: "x" })).toEqual({
      ok: false,
      error: "one of user or conversation is required",
    });
  });

  it("treats verbatim as opt-in, so a wake runs as a turn unless asked otherwise", () => {
    const a = parseWake({ agent: "a", user: "U1", text: "x" });
    const b = parseWake({ agent: "a", user: "U1", text: "x", verbatim: true });
    if (a.ok) expect(a.req.verbatim).toBe(false);
    if (b.ok) expect(b.req.verbatim).toBe(true);
  });

  it("does not crash on rubbish", () => {
    expect(parseWake(null).ok).toBe(false);
    expect(parseWake("nope").ok).toBe(false);
  });
});

import { serveWake, type WakeDeps } from "./wake";

/** A wake deps stub — records reload calls, and answers `has` for one agent. */
function stubDeps(over: Partial<WakeDeps> = {}): WakeDeps & { reloads: number } {
  const state = { reloads: 0 };
  return Object.assign(state, {
    has: () => true,
    dmFor: async () => "C1",
    say: async () => {},
    ask: async () => {},
    reload: () => {
      state.reloads += 1;
    },
    ...over,
  });
}

describe("serveWake — POST /api/reload", () => {
  const PORT = 39817;
  const TOKEN = "t0k";
  const base = `http://127.0.0.1:${PORT}`;

  it("pokes a reload when authorised, and reports whether reload is enabled", async () => {
    const ac = new AbortController();
    const deps = stubDeps();
    expect(serveWake({ port: PORT, token: TOKEN, deps }, ac.signal)).toBe(true);
    // A moment for listen().
    await new Promise((r) => setTimeout(r, 50));
    try {
      // No token → 401, and reload NOT called.
      const un = await fetch(`${base}/api/reload`, { method: "POST" });
      expect(un.status).toBe(401);
      // Authorised → 202, reload called exactly once.
      const ok = await fetch(`${base}/api/reload`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(202);
      expect(deps.reloads).toBe(1);
    } finally {
      ac.abort();
    }
  });

  it("answers 404 when the worker has reload disabled — 'not supported', not 'not authorised'", async () => {
    const ac = new AbortController();
    const deps = stubDeps({ reload: undefined });
    serveWake({ port: PORT + 1, token: TOKEN, deps }, ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    try {
      const r = await fetch(`http://127.0.0.1:${PORT + 1}/api/reload`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(r.status).toBe(404);
    } finally {
      ac.abort();
    }
  });
});
