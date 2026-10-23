// A tenant's policies come before its agents (POLICY-AGENT-GATE in Tonoman Cloud's policy.md): someone
// who has not acknowledged the tenant's published policies gets one fixed notice with the link, and
// no turn — no model, no brain read, no tool, no command. On every channel.
//
// The registry decides; this asks it before a turn and remembers a "yes" for a minute, so a busy
// conversation does not ask on every message. A "no" is not remembered: acknowledging in the Hub
// opens the agent on the very next message. If the registry cannot be asked, nobody is let through
// on a guess — the person is told to try again.

export type PolicyVerdict = { ok: true } | { ok: false; notice: string };

export interface PolicyGateOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  okForMs?: number;
  now?: () => number;
}

export const POLICY_GATE_UNREACHABLE = "I can't check right now whether you're cleared to use me. Please try again in a minute.";

export function policyGate(o: PolicyGateOptions) {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const okFor = o.okForMs ?? 60_000;
  const cleared = new Map<string, number>();
  return {
    /** May this person be answered by this agent now? `speaker` is the chat id the message came from,
     *  or the account when the channel already knows it. */
    async check(agentGuid: string, speaker: { slackUserId?: string; accountId?: string }): Promise<PolicyVerdict> {
      const key = `${agentGuid}\u0000${speaker.accountId ?? ""}\u0000${speaker.slackUserId ?? ""}`;
      const until = cleared.get(key);
      if (until !== undefined && until > now()) return { ok: true };
      try {
        const r = await f(`${o.baseUrl}/v1/system/agents/${encodeURIComponent(agentGuid)}/policy-gate`, {
          method: "POST",
          headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
          body: JSON.stringify(speaker),
        });
        // An agent the registry does not know is not this gate's to stop (the roster decides who serves).
        if (r.status === 404) return { ok: true };
        if (!r.ok) return { ok: false, notice: POLICY_GATE_UNREACHABLE };
        const j = (await r.json()) as { ok?: boolean; notice?: string };
        if (j.ok) {
          cleared.set(key, now() + okFor);
          if (cleared.size > 5000) for (const [k, t] of cleared) if (t <= now()) cleared.delete(k);
          return { ok: true };
        }
        return { ok: false, notice: j.notice || POLICY_GATE_UNREACHABLE };
      } catch {
        return { ok: false, notice: POLICY_GATE_UNREACHABLE };
      }
    },
  };
}
