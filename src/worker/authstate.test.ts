// W3 — where an inference-credential outcome is RECORDED.
//
// The bug this exists for: on an agent where everybody brings their own subscription, one person's
// failed login used to mark the whole AGENT `error` in the Hub while every other teammate went on
// answering perfectly — and, symmetrically, a person whose own subscription lapsed showed up
// nowhere at all, because the worker returned early rather than report anything. A per-person login
// is a fact about a person, and it belongs on that person's row.

import { describe, it, expect } from "vitest";
import { postAuthState } from "./worker";
import { authFailureState, isNotLoggedInError, notLoggedInNotice } from "../turnfailure";

/** A fetch that records the call and answers with whatever the test wants. */
function recorder(answer: { ok?: boolean; status?: number } | Error = {}) {
  const calls: { url: string; method?: string; auth?: string; body: unknown }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    if (answer instanceof Error) throw answer;
    return { ok: answer.ok ?? true, status: answer.status ?? 200 } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const base = { api: "https://api.test", token: "sys-token", guid: "g-1", state: "ok" as const, provider: "claude" as const };

describe("postAuthState — the person's row, or the agent's (W3)", () => {
  it("a named person is reported against the PRINCIPAL, never the agent", async () => {
    const f = recorder();
    const r = await postAuthState({ ...base, user: "U123", provider: "codex", fetchImpl: f.impl });
    expect(r.ok).toBe(true);
    expect(f.calls[0].url).toBe("https://api.test/v1/system/agents/g-1/principals/U123/auth-state");
    expect(f.calls[0].method).toBe("POST");
    expect(f.calls[0].body).toEqual({ authState: "ok", provider: "codex" });
  });

  it("no person means the agent's own login, on the agent route", async () => {
    const f = recorder();
    await postAuthState({ ...base, fetchImpl: f.impl });
    expect(f.calls[0].url).toBe("https://api.test/v1/system/agents/g-1/auth-state");
    expect(f.calls[0].body).toEqual({ authState: "ok", provider: "claude" });
  });

  it("carries the system token as a bearer, and never the token's value anywhere else", async () => {
    const f = recorder();
    await postAuthState({ ...base, user: "U1", fetchImpl: f.impl });
    expect(f.calls[0].auth).toBe("Bearer sys-token");
    expect(JSON.stringify(f.calls[0].body)).not.toContain("sys-token");
  });

  it("url-encodes the user id — it comes off the wire and lands in a path", async () => {
    const f = recorder();
    await postAuthState({ ...base, user: "U/1 2", fetchImpl: f.impl });
    expect(f.calls[0].url).toContain("/principals/U%2F1%202/auth-state");
  });

  it("tolerates a trailing slash on the API base rather than producing a double slash", async () => {
    const f = recorder();
    await postAuthState({ ...base, api: "https://api.test/", fetchImpl: f.impl });
    expect(f.calls[0].url).toBe("https://api.test/v1/system/agents/g-1/auth-state");
  });

  it("a 404 is reported, not thrown — the person is simply not registered yet", async () => {
    const f = recorder({ ok: false, status: 404 });
    const r = await postAuthState({ ...base, user: "U1", fetchImpl: f.impl });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("a transport failure is an answer, not an exception: this is called from a failed turn", async () => {
    const f = recorder(new Error("ECONNREFUSED"));
    const r = await postAuthState({ ...base, user: "U1", fetchImpl: f.impl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });

  it("reports every state the registry knows, not just ok/error", async () => {
    const f = recorder();
    for (const state of ["ok", "error", "expired", "unconfigured"] as const) {
      await postAuthState({ ...base, state, user: "U1", fetchImpl: f.impl });
    }
    expect(f.calls.map((c) => (c.body as { authState: string }).authState)).toEqual([
      "ok",
      "error",
      "expired",
      "unconfigured",
    ]);
  });
});

describe("authFailureState — what a failed turn is entitled to conclude (W3)", () => {
  it("a credential that worked and stopped is expired", () => {
    // Quoted from a real log, which is the standard the rest of this classifier is held to.
    expect(authFailureState("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe("expired");
    expect(authFailureState("invalid_grant")).toBe("expired");
  });

  it("anything else auth-shaped is error — never a guess at expired", () => {
    // Telling the Hub a subscription lapsed when it did not is worse than saying "something is
    // wrong with this login", because only one of those sends somebody to check their billing.
    expect(authFailureState("not logged in")).toBe("error");
    expect(authFailureState("no credentials found")).toBe("error");
    expect(authFailureState("")).toBe("error");
  });

  it("agrees with the classifier that decides whether this path runs at all", () => {
    for (const msg of ["Not logged in", "OAuth session expired and could not be refreshed", "no credentials found"]) {
      expect(isNotLoggedInError(msg)).toBe(true);
    }
  });
});

describe("notLoggedInNotice — the fix it names is the one that works (W2/W3)", () => {
  it("defaults to claude, exactly as before", () => {
    expect(notLoggedInNotice()).toContain("`!connect claude`");
  });

  it("names the agent's own provider when there is one", () => {
    // On a codex agent the old text told people to sign in to an account it does not use — and the
    // login would have succeeded, so nothing would have looked wrong.
    const t = notLoggedInNotice("!connect codex");
    expect(t).toContain("`!connect codex`");
    expect(t).not.toContain("claude");
  });

  it("still does not say 'try again', which is the one thing guaranteed not to work", () => {
    expect(notLoggedInNotice()).not.toMatch(/try again/i);
  });
});
