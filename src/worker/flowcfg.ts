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
  /** `<secret>:<key>` naming the Plaud credential for THIS tenant. No environment fallback, for
   *  the same reason `notifyChannel` has none: a worker-wide default is one customer's account
   *  read on another customer's behalf. Empty means the flow has no credential yet — which is
   *  exactly the state a tenant is in before the person has logged in. */
  credentialRef: string;
  /** Whether this agent watches for recordings at all.
   *
   *  A switch, because "has a second brain and a Plaud token" is not the same as "should be filing
   *  meetings". Two tenants sharing one Plaud account both see every recording, so turning one of
   *  them off has to be a row somebody can set — not a redeploy, and not deleting a credential. */
  enabled: boolean;
  /** Slack channel id where recaps are announced. Empty = DM the notify user. */
  notifyChannel: string;
  /** Slack user id: who a DM would go to, and who the agent addresses. */
  notifyUser: string;
  pollSeconds: number;
  /** Absolute ISO instant, or a bare date. Empty = "from today onwards". */
  since: string;
  /** Where meetings are filed, or undefined for the flat `Meetings/` layout. */
  journal?: Journal;
  /** Calendar titles that are blocks rather than meetings — "Focus Time", "Lunch",
   *  "Calendly Meeting Block". Comma-separated in the row, because a person types this.
   *
   *  NOTE there is deliberately no `calendar.tz` here. Matching happens in epoch milliseconds, so
   *  it needs no timezone at all — see calendar.ts. The old pipeline needed one only because it
   *  searched a LOCAL-DAY window, which is also why it got DST boundaries wrong. */
  calendarExclude: string[];
  /** How far either side of a recording to look for events. Generous by default: people start
   *  recording after a meeting begins, and this only gathers candidates — the content decides. */
  calendarPadMinutes?: number;
  /** Whether Plaud is ONE shared account for the tenant (`shared`, the default and Sapien's) or each
   *  member's own (`per_person`). Default `shared`, so a tenant that has not opted in keeps a single
   *  mounted/connected account and every existing flow is unchanged; only an explicit `per_person`
   *  makes `!connect plaud` sign in the SPEAKER and the poll fan out over per-member accounts. */
  plaudScope: "shared" | "per_person";
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Whether the voice flow's Plaud is per-person, without building the whole settings object — the
 *  connect commands need only this one bit to decide whether `!connect plaud` signs in the SPEAKER
 *  or the tenant's one shared account. Default shared, so nothing about an existing agent changes. */
export function plaudPerPerson(props: Record<string, string> = {}): boolean {
  return (props["plaud_scope"] ?? "shared").toLowerCase() === "per_person";
}

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

  // Comma-separated, trimmed, blanks dropped. A trailing comma is the ordinary result of somebody
  // editing this in a form, and an empty pattern treated as a substring match would exclude every
  // event and switch calendar matching off without saying so.
  const calendarExclude = (p("calendar.exclude") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    // Default ON: a tenant that configured a voice flow means to run it. Only an explicit "false"
    // turns it off, so a typo cannot silently stop a pipeline somebody is relying on.
    enabled: (p("enabled") ?? "true").toLowerCase() !== "false",
    calendarExclude,
    calendarPadMinutes: p("calendar.window_minutes") ? num(p("calendar.window_minutes"), 30) : undefined,
    // NO environment fallback for these two, deliberately. A channel id and a user id name a place
    // inside ONE workspace, so a worker-wide default is cross-tenant contamination by construction:
    // the second tenant's agent inherited the first tenant's channel and was about to announce a
    // person's private recaps into a customer's Slack. Whose channel it is, is a fact about the
    // tenant, and there is no sensible default for it.
    notifyChannel: p("notify_channel") ?? "",
    notifyUser: p("notify_user") ?? "",
    // Whose Plaud account this is. Same rule, same reason: `PLAUD_TOKEN_FILE` was one path on one
    // pod, and one pod runs every agent the worker has — so both tenants polled whichever account
    // had been mounted, and a second person logging in would have replaced the first.
    credentialRef: p("credential_ref") ?? "",
    pollSeconds: num(p("poll_seconds") ?? env.VOICE_POLL_SECONDS, 300),
    since: p("since") ?? (env.VOICE_SINCE ?? "").trim(),
    // Default shared: per-person is a deliberate opt-in, for the same reason as `enabled` —
    // a typo must never move a tenant off their one working account into a state where the poll finds
    // no per-member accounts and stops.
    plaudScope: (p("plaud_scope") ?? "shared").toLowerCase() === "per_person" ? "per_person" : "shared",
    journal,
  };
}

/** One inference provider as the registry holds it — the key still a REF, never the key itself.
 *
 *  That separation is the point: `flowcfg` stays pure and testable because it never reads a secret,
 *  and the one place that can turn a ref into a credential is the worker. A pure function that
 *  quietly needed the filesystem would be neither. */
export interface ProviderSpec {
  /** For the log and the recap's provenance line. Defaults to the row index if nobody named it. */
  name: string;
  /** The OpenAI-compatible root, the part before `/audio/transcriptions`. */
  url: string;
  model: string;
  keyRef: string;
  /** Whether this provider biases its vocabulary from `prompt`. Groq does; a local faster-whisper
   *  server accepts the field and ignores it, which is a real difference in proper nouns. */
  biases: boolean;
  timeoutMs?: number;
  /** Most transcript this provider may be sent in one request, in characters. See Provider. */
  maxChars?: number;
}

/**
 * A tenant's providers for one job, in the order it wants them tried.
 *
 * Rows are `<job>.<n>.<field>`, so adding a fallback is an INSERT and reordering is an UPDATE:
 *
 *   transcribe.1.url    https://api.groq.com/openai/v1
 *   transcribe.1.model  whisper-large-v3-turbo
 *   transcribe.1.key_ref  recap-secrets:GROQ_API_KEY
 *   transcribe.2.url    http://host.containers.internal:8181/v1
 *
 * SORTED NUMERICALLY, which is not fussiness: `localeCompare` puts "10" before "2", so a customer
 * who added a tenth provider would find their order silently rearranged — and the symptom is a bill
 * from the wrong provider, not an error.
 *
 * A row group with no `url` or no `model` is DROPPED rather than defaulted. Guessing an endpoint
 * for a half-written row means sending a customer's meeting somewhere they did not name.
 */
export function providerSpecs(props: Record<string, string> = {}, job = "transcribe"): ProviderSpec[] {
  const groups = new Map<number, Record<string, string>>();
  for (const [k, v] of Object.entries(props)) {
    // Split rather than match. A regex built from a template literal is one missed backslash away
    // from `\d` meaning the letter d, and it would parse nothing while looking entirely correct.
    const parts = k.split(".");
    if (parts.length !== 3 || parts[0] !== job || !v.trim()) continue;
    const n = Number(parts[1]);
    if (!Number.isInteger(n)) continue;
    const g = groups.get(n) ?? {};
    g[parts[2]!] = v.trim();
    groups.set(n, g);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, g]) => ({
      name: g.name ?? `${job}-${n}`,
      url: (g.url ?? "").replace(/[/]+$/, ""),
      model: g.model ?? "",
      keyRef: g.key_ref ?? "",
      // Default TRUE: every hosted provider does, and assuming it does not would silently drop the
      // vocabulary hints on the one that does.
      biases: (g.biases ?? "true").toLowerCase() !== "false",
      timeoutMs: g.timeout_seconds ? num(g.timeout_seconds, 0) * 1000 || undefined : undefined,
      maxChars: g.max_chars ? num(g.max_chars, 0) || undefined : undefined,
    }))
    .filter((p) => p.url && p.model);
}

/** A one-line summary for the boot log. What is configured is worth saying out loud: a flow that
 *  silently files everything under `unclassified` looks identical to one that is working. */
export function describe(v: VoiceSettings): string {
  if (!v.enabled) return "DISABLED (flow_property enabled=false)";
  // Checked after the off switch: a flow somebody turned off is a decision, and calling that
  // "waiting for a login" would send the reader to fix the wrong thing. Checked before everything
  // else, because where recaps would be filed does not matter while there is no account to read.
  if (!v.credentialRef) return "waiting for a Plaud login (no credential_ref for this tenant)";
  const where = v.notifyChannel ? `channel ${v.notifyChannel}` : `a DM with ${v.notifyUser || "nobody"}`;
  const filing = v.journal
    ? `${v.journal.path}/{${v.journal.routes.map((r) => r.id).join(",") || "—"}} → ${v.journal.fallback}`
    : "Meetings/ (no routing)";
  return `announcing in ${where}; filing under ${filing}; every ${v.pollSeconds}s`;
}
