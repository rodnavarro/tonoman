// Someone the agent does not know starts no turn (AGENTACCOUNT-UNKNOWN-NO-TURN in Tonoman Cloud).
//
// Whether a Slack user is known is a registry fact — a person registered for the agent with that
// id — so it is checked here, before anything is spent. The model used to be started anyway and
// told to ask "who are you?", which it could not fix and paid for on every message.

/** PURE: does this agent know the speaker? An agent with no registry (no `principals` on its
 *  config — the open-source runtime on its own roster) knows everyone, as before. */
export function knowsSpeaker(principals: { kind: string; value: string }[] | undefined, user: string): boolean {
  if (principals === undefined) return true;
  return principals.some((p) => p.kind === "slack_user_id" && p.value === user);
}

/** PURE: the platform's words to someone the agent does not know. Fixed; no model. With their Slack
 *  id, so the person can hand it to whoever allows them — the id is what an admin needs when Slack
 *  gave no email to know them by (ACCOUNT-NO-EMAIL-NO-GUESS in Tonoman Cloud). */
export function unknownSpeakerNotice(agentName: string, userId?: string): string {
  const base = `I don't know who you are yet, so I can't help here. Ask an owner or admin of your team to allow you on ${agentName} in Tonoman Cloud`;
  return userId ? `${base} — your Slack id is ${userId}.` : `${base}.`;
}

/** Says the notice at most once per person and conversation in `windowMs`, so three messages in a
 *  row get one answer rather than three. In memory: a restart may say it once more, never less. */
export function noticeLimiter(windowMs = 10 * 60 * 1000, now: () => number = Date.now) {
  const said = new Map<string, number>();
  return {
    /** True when the notice should be said now (and records that it was). */
    shouldSay(agent: string, conversation: string, user: string): boolean {
      const key = `${agent}\u0000${conversation}\u0000${user}`;
      const t = now();
      const last = said.get(key);
      if (last !== undefined && t - last < windowMs) return false;
      said.set(key, t);
      if (said.size > 2000) {
        for (const [k, v] of said) if (t - v >= windowMs) said.delete(k);
      }
      return true;
    },
  };
}
