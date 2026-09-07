// Reading a flow's settings out of the registry's flat property rows.
//
// The registry stores `flow_property` rows — agent, flow, key, value — and knows nothing about
// what any of them mean. That is deliberate: the runtime that owns a flow is the only thing that
// should have to understand `journal.path`, and it is what keeps adding a meeting category an
// INSERT rather than a migration in one repo and a redeploy in another.
//
// PURE. Everything here turns a Record<string,string> into something typed, and says clearly what
// happens when a key is missing.

import type { Journal } from "./recap";

/** What the voice flow needs, as the registry holds it. */
export interface VoiceSettings {
  /** Slack channel id where recaps are announced. Empty = DM the notify user. */
  notifyChannel: string;
  /** Slack user id: who a DM would go to, and who the agent addresses. */
  notifyUser: string;
  pollSeconds: number;
  /** Absolute ISO instant, or a bare date. Empty = "from today onwards". */
  since: string;
  /** Where meetings are filed, or undefined for the flat `Meetings/` layout. */
  journal?: Journal;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read the voice flow's settings.
 *
 * `props` are the registry rows; `env` is the fallback while a tenant has no rows yet. The registry
 * wins wherever it has an answer — the point of the table is that a deployment stops being where a
 * tenant's configuration lives.
 *
 * Routes are `route.<id> = <when>`, one row each, so adding a category is one INSERT. The id is the
 * folder name, which is what makes the scheme portable: a different tenant's folders are different
 * rows and nothing else.
 */
export function voiceSettings(props: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env): VoiceSettings {
  const p = (k: string): string | undefined => {
    const v = props[k];
    return v !== undefined && v !== "" ? v : undefined;
  };

  const routes = Object.entries(props)
    .filter(([k, v]) => k.startsWith("route.") && v.trim())
    .map(([k, v]) => ({ id: k.slice("route.".length), when: v }))
    // Stable order so the prompt the model sees does not change between polls for no reason.
    .sort((a, b) => a.id.localeCompare(b.id));

  const journalPath = p("journal.path");
  // A journal needs somewhere to put the ambiguous ones. Without a fallback the only safe answer
  // would be to invent a folder, so the whole scheme is refused rather than half-applied.
  const fallback = p("journal.fallback");
  const journal: Journal | undefined =
    journalPath && fallback ? { path: journalPath, fallback, routes } : undefined;

  return {
    notifyChannel: p("notify_channel") ?? (env.VOICE_NOTIFY_CHANNEL ?? "").trim(),
    notifyUser: p("notify_user") ?? (env.VOICE_NOTIFY_USER ?? "").trim(),
    pollSeconds: num(p("poll_seconds") ?? env.VOICE_POLL_SECONDS, 120),
    since: p("since") ?? (env.VOICE_SINCE ?? "").trim(),
    journal,
  };
}

/** A one-line summary for the boot log. What is configured is worth saying out loud: a flow that
 *  silently files everything under `unclassified` looks identical to one that is working. */
export function describe(v: VoiceSettings): string {
  const where = v.notifyChannel ? `channel ${v.notifyChannel}` : `a DM with ${v.notifyUser || "nobody"}`;
  const filing = v.journal
    ? `${v.journal.path}/{${v.journal.routes.map((r) => r.id).join(",") || "—"}} → ${v.journal.fallback}`
    : "Meetings/ (no routing)";
  return `announcing in ${where}; filing under ${filing}; every ${v.pollSeconds}s`;
}
