import { describe, it, expect } from "vitest";
import { parseTalentRun, parseWake } from "./wake";

describe("parseWake", () => {
  it("carries files to go with the text, as paths on the worker — how a test sends a photo without Slack", () => {
    const r = parseWake({ agent: "acme-nova", user: "U1", text: "file this", files: ["/tmp/in/receipt.jpg"] });
    expect(r.ok && r.req.files).toEqual(["/tmp/in/receipt.jpg"]);
    expect(parseWake({ agent: "acme-nova", user: "U1", text: "x" })).toMatchObject({ ok: true, req: { files: undefined } });
    expect(parseWake({ agent: "acme-nova", user: "U1", text: "x", files: "receipt.jpg" })).toEqual({ ok: false, error: "files must be a list of paths" });
    expect(parseWake({ agent: "acme-nova", user: "U1", text: "x", files: [7] })).toEqual({ ok: false, error: "files must be a list of paths" });
  });

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

// W4 — "run this Talent now", asked for from the Hub.
describe("parseTalentRun", () => {
  const good = { agent: "g-1", talent: "meeting-recap", item: "rec-9", user: "U1" };

  it("accepts the minimum a run needs, and defaults force to off", () => {
    const r = parseTalentRun(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req).toEqual({ ...good, force: false, requestedBy: undefined });
  });

  it("carries force and requestedBy through when they are given", () => {
    const r = parseTalentRun({ ...good, force: true, requestedBy: "acct_123" });
    if (r.ok) expect(r.req).toMatchObject({ force: true, requestedBy: "acct_123" });
  });

  it("names the field that is missing — another system calls this", () => {
    for (const k of ["agent", "talent", "item", "user"]) {
      const body = { ...good, [k]: undefined };
      expect(parseTalentRun(body)).toEqual({ ok: false, error: `${k} is required` });
    }
  });

  it("treats blank and whitespace as missing, not as a value", () => {
    expect(parseTalentRun({ ...good, item: "   " })).toEqual({ ok: false, error: "item is required" });
  });

  it("refuses a force that is a STRING rather than doing nothing quietly", () => {
    // `force: "true"` silently not forcing is the kind of thing rediscovered a week later as
    // "the re-run button doesn't work".
    expect(parseTalentRun({ ...good, force: "true" })).toEqual({ ok: false, error: "force must be a boolean" });
    expect(parseTalentRun({ ...good, requestedBy: 7 })).toEqual({ ok: false, error: "requestedBy must be a string" });
  });

  it("does not crash on rubbish", () => {
    expect(parseTalentRun(null).ok).toBe(false);
    expect(parseTalentRun("nope").ok).toBe(false);
  });
});

describe("serveWake — POST /api/talent-run (W4)", () => {
  const TOKEN = "t0k";
  let port = 39830;

  /** Boot a server on its own port and hand back a caller + the calls it recorded. */
  function boot(over: Partial<WakeDeps> = {}) {
    const ac = new AbortController();
    const calls: unknown[] = [];
    const deps = stubDeps({
      has: (a: string) => a === "g-1",
      resolveAgent: (a: string) => (a === "g-1" || a === "initech-nelly" ? "g-1" : undefined),
      runTalent: async (...args: unknown[]) => {
        calls.push(args);
        return { started: true, message: "Running it now.", workflowId: "talent:g-1:rec-9" };
      },
      ...over,
    });
    const p = port++;
    serveWake({ port: p, token: TOKEN, deps }, ac.signal);
    const post = (body: unknown, auth = TOKEN) =>
      fetch(`http://127.0.0.1:${p}/api/talent-run`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { ac, calls, post, ready: new Promise((r) => setTimeout(r, 50)) };
  }

  const good = { agent: "g-1", talent: "meeting-recap", item: "rec-9", user: "U1" };

  it("starts the run and answers 200 with the workflow id", async () => {
    const s = boot();
    await s.ready;
    try {
      const res = await s.post({ ...good, requestedBy: "acct_7" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        started: true,
        message: "Running it now.",
        workflowId: "talent:g-1:rec-9",
      });
      // The SAME deps function `!talent` calls, told this was the Hub asking.
      expect(s.calls[0]).toEqual(["g-1", "meeting-recap", "rec-9", "U1", false, { trigger: "hub", requestedBy: "acct_7" }]);
    } finally {
      s.ac.abort();
    }
  });

  it("resolves the agent by its registry GUID — that is what the Hub knows it as", async () => {
    const s = boot();
    await s.ready;
    try {
      await s.post({ ...good, agent: "initech-nelly" }); // the readable name resolves to the same key
      expect((s.calls[0] as unknown[])[0]).toBe("g-1");
    } finally {
      s.ac.abort();
    }
  });

  it("answers 409 for an item already running or already done — a conflict, not a fresh run", async () => {
    const s = boot({
      runTalent: async () => ({ started: false, message: "`rec-9` is already being processed." }),
    });
    await s.ready;
    try {
      const res = await s.post(good);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ started: false });
    } finally {
      s.ac.abort();
    }
  });

  it("answers 404 for an agent this worker does not serve", async () => {
    const s = boot();
    await s.ready;
    try {
      const res = await s.post({ ...good, agent: "somebody-elses" });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain("somebody-elses");
    } finally {
      s.ac.abort();
    }
  });

  it("answers 400 with the field at fault for a bad body", async () => {
    const s = boot();
    await s.ready;
    try {
      const res = await s.post({ agent: "g-1", talent: "meeting-recap" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "item is required" });
    } finally {
      s.ac.abort();
    }
  });

  it("is bearer-gated like /api/reload, and does not start anything when it is not", async () => {
    const s = boot();
    await s.ready;
    try {
      const res = await s.post(good, "wrong");
      expect(res.status).toBe(401);
      expect(s.calls).toEqual([]);
    } finally {
      s.ac.abort();
    }
  });

  it("answers 404 on a worker with no Talent runtime — 'not supported', not 'not authorised'", async () => {
    const s = boot({ runTalent: undefined });
    await s.ready;
    try {
      expect((await s.post(good)).status).toBe(404);
    } finally {
      s.ac.abort();
    }
  });

  it("surfaces a failure to START as a 500, rather than hanging the caller", async () => {
    const s = boot({
      runTalent: async () => {
        throw new Error("temporal unreachable");
      },
    });
    await s.ready;
    try {
      const res = await s.post(good);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { message: string }).message).toContain("temporal unreachable");
    } finally {
      s.ac.abort();
    }
  });
});
