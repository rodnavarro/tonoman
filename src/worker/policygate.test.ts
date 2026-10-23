// POLICY-AGENT-GATE (policy.md in Tonoman Cloud): asked of the registry before a turn; a "yes" is
// remembered a minute, a "no" never, and a registry that cannot be asked lets nobody through.
import { describe, it, expect } from "vitest";
import { POLICY_GATE_UNREACHABLE, policyGate } from "./policygate";

const NOTICE = "Before I can help, please read and acknowledge Test A's AI Policy: https://hub/test-a/policies/ai-policy";

function registry(answers: Array<{ status: number; body?: unknown } | Error>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const a = answers.shift() ?? { status: 200, body: { ok: true } };
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("the policy gate before a turn", () => {
  it("POLICY-AGENT-GATE someone who has not acknowledged gets the registry's fixed notice and no turn", async () => {
    const r = registry([{ status: 200, body: { ok: false, notice: NOTICE } }]);
    const g = policyGate({ baseUrl: "http://api", token: "t", fetchImpl: r.fetchImpl });
    expect(await g.check("agent-1", { slackUserId: "U0AAAAAAA1" })).toEqual({ ok: false, notice: NOTICE });
    expect(r.calls[0]).toEqual({ url: "http://api/v1/system/agents/agent-1/policy-gate", body: { slackUserId: "U0AAAAAAA1" } });
  });

  it("POLICY-AGENT-GATE a no is never remembered: acknowledging in the Hub opens the agent on the next message", async () => {
    const r = registry([{ status: 200, body: { ok: false, notice: NOTICE } }, { status: 200, body: { ok: true } }]);
    const g = policyGate({ baseUrl: "http://api", token: "t", fetchImpl: r.fetchImpl });
    expect((await g.check("a", { accountId: "acc" })).ok).toBe(false);
    expect((await g.check("a", { accountId: "acc" })).ok).toBe(true);
  });

  it("POLICY-AGENT-GATE a yes is remembered for a minute, then asked again", async () => {
    let t = 0;
    const r = registry([{ status: 200, body: { ok: true } }, { status: 200, body: { ok: false, notice: NOTICE } }]);
    const g = policyGate({ baseUrl: "http://api", token: "t", fetchImpl: r.fetchImpl, now: () => t });
    expect((await g.check("a", { slackUserId: "U1" })).ok).toBe(true);
    t = 59_000;
    expect((await g.check("a", { slackUserId: "U1" })).ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    t = 61_000;
    expect((await g.check("a", { slackUserId: "U1" })).ok).toBe(false);
  });

  it("POLICY-AGENT-GATE a registry that cannot be asked lets nobody through, and says to try again", async () => {
    const down = registry([new Error("ECONNREFUSED")]);
    expect(await policyGate({ baseUrl: "http://api", token: "t", fetchImpl: down.fetchImpl }).check("a", { slackUserId: "U1" })).toEqual({ ok: false, notice: POLICY_GATE_UNREACHABLE });
    const sick = registry([{ status: 500 }]);
    expect((await policyGate({ baseUrl: "http://api", token: "t", fetchImpl: sick.fetchImpl }).check("a", { slackUserId: "U1" })).ok).toBe(false);
  });
});
