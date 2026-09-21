// The Talent framework — Tonoman OSS's runtime contract for a Talent.
//
// A Talent is the single versioned unit an agent runs. It is CODE behind a MANIFEST, not interpreted
// steps: the step interpreter this replaced (skill.ts / runSkillWorkflow / runStep) is deleted. The
// manifest is DATA — what the Talent needs and what it can be configured with — declared in code and
// reported to the Cloud `talent` registry so a tenant can install it. The implementation is a
// workflow the worker runs (for the built-in Plaud Talent, the proven voice pipeline).
//
// "Where a Talent comes from" is a pluggable SOURCE, not a fixed place: built-in (this tree) today,
// a Cloud install and a marketplace later. This contract is the shape every source produces.

/** One credential the Talent needs.
 *
 *  THREE STRENGTHS, not two, and the third is the interesting one:
 *
 *   - required        (neither flag)   cannot run without it — Plaud, for a Talent whose whole job
 *                                      is to fetch recordings from Plaud.
 *   - `optional`      works, just does less, and nobody needs telling.
 *   - `fallback`      REQUIRED, and it degrades. The Talent needs this credential to do its job
 *                     properly, the Hub should ask for it, and a person should be told what they
 *                     are missing without it — but the run still happens, because filing a meeting
 *                     with no calendar match is far better than not filing it at all.
 *
 *  A calendar is the case that forced the distinction. Marked `optional`, it was invisible: nothing
 *  asked for it, nothing said a recap had been filed without matching it to a meeting, and the
 *  degraded output looked exactly like the good one. Marked plainly required, it would have stopped
 *  meetings being filed at all for every tenant that has not connected one. `fallback` is the honest
 *  shape: ask for it, name what is lost, run anyway.
 *
 *  `transcription` is met by construction: there is always a platform/tenant provider chain, so it
 *  is a capability the runtime supplies below the Talent, not a per-user account to connect. */
export interface CredentialRequirement {
  kind: string;
  optional?: boolean;
  /** WHICH credential kinds satisfy this requirement, when several can. `calendar` is met by an ICS
   *  feed or a Google connection, and a Talent should not have to name three requirements to say one
   *  thing. Absent = the requirement is met by its own `kind`, which is every other one today. */
  providers?: string[];
  /** What happens WITHOUT it, in the words a person should be shown. Its presence is also what
   *  marks the requirement as degradable, so a gate reads one field rather than inferring intent
   *  from prose. */
  fallback?: string;
}

/** PURE: may a Talent run when this requirement is not met?
 *
 *  `optional` and `fallback` both mean yes, for different reasons — one because nothing is lost,
 *  one because something is lost and running anyway is still the right answer. Only a bare required
 *  credential blocks.
 *
 *  This is the ONE place that judgement is made, so a gate cannot be added later that knows about
 *  `optional` and has never heard of `fallback` — which would quietly stop every tenant without a
 *  calendar from getting their meetings filed. */
export function blocksRun(req: CredentialRequirement): boolean {
  return !req.optional && !req.fallback;
}

/** PURE: what a person should be told about a requirement they have not met. Empty when there is
 *  nothing worth saying — a truly optional credential is not news. */
export function missingNote(req: CredentialRequirement): string {
  return req.fallback ?? "";
}

export type ConfigFieldType = 'channel' | 'channel_list' | 'text' | 'toggle' | 'brain';

/** One typed field an agent fills when the Talent is installed. The Hub renders a form from these
 *  (a later wave); the worker reads the saved values. Adding a field is a code change = a new
 *  version, which is the whole point of the manifest being declared in code. */
export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  label?: string;
  required?: boolean;
}

/** How a Talent runs on its own, if it does. Absent for a Talent that only runs on demand. The Hub
 *  shows a schedule switch only for a Talent that declares one, and `summary` is the line beside it. */
export interface TalentSchedule {
  kind: 'interval' | 'times';
  summary: string;
}

/** A Talent's manifest: its identity and its declared, deterministic requirements + config. This is
 *  what registration upserts into the Cloud `talent` registry (git = source of truth). */
export interface TalentManifest {
  name: string;
  version: number;
  description?: string;
  requires: CredentialRequirement[];
  configSchema: ConfigField[];
  schedule?: TalentSchedule;
}
