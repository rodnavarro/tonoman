// One recording's identity, across the id schemes its source has used.
//
// On 2026-09-15 Plaud's API began returning every file id with an `of_` prefix — the same 32 hex
// characters, renamed. Every check that asked "is this the recording on the page?" compared ids
// byte-for-byte, so every recording in every account read as brand new at once: re-announced,
// re-transcribed, re-filed as a duplicate. The lesson is that an id from somebody else's API is a
// handle for fetching, not an identity for remembering, and the two must be kept apart.
//
// This module is PURE and dependency-free on purpose: it is imported by the Temporal workflow code
// (which must stay deterministic and cannot pull in node modules) as well as by the runtime.

/** The stable KEY for a recording — what the run record, the workflow id, the chunk cache and the
 *  page's `recording_id` are keyed on. The prefix Plaud added is dropped; a future rename that keeps
 *  the hex core is absorbed here, and one that does not is caught by the instant match in
 *  `isPublished` instead. */
export function recordingKey(id: string): string {
  return id.replace(/^of_/, "");
}

/** How many times the poll will re-launch a Talent run that keeps failing, before it stops and
 *  leaves the item for a person (`!talent <name> <id> again` forces it). Each launch already carries
 *  the activity's own retries, so three launches is a lot of trying — the day of the GPU outage it
 *  was fourteen, and every one re-announced the recording. */
export const MAX_TALENT_LAUNCHES = 3;

export interface PriorRun {
  status: "running" | "done" | "failed";
  attempts: number;
}

/** PURE: what the durable run record says to do with an item.
 *
 *  - `done`: filed already — never again (the page may not even be in the checkout yet).
 *  - `failed` past the launch budget: give up quietly; a person decides.
 *  - nothing on record: the FIRST time — this launch announces the recording.
 *  - anything else (`running`, or `failed` with budget left): launch again, silently. `running` is
 *    not trusted as "in flight" — a run that died without closing would otherwise block its item
 *    forever; the workflow id is what actually dedups an in-flight run. */
export function talentGate(prior: PriorRun | undefined, force = false): "skip-done" | "skip-given-up" | "first" | "again" {
  if (force) return prior ? "again" : "first";
  if (!prior) return "first";
  if (prior.status === "done") return "skip-done";
  if (prior.status === "failed" && prior.attempts >= MAX_TALENT_LAUNCHES) return "skip-given-up";
  return "again";
}

/** PURE: whether the launch that is about to open the record is the LAST one the budget allows —
 *  the one whose failure is worth telling the person about. */
export function isFinalLaunch(prior: PriorRun | undefined): boolean {
  return (prior?.attempts ?? 0) + 1 >= MAX_TALENT_LAUNCHES;
}
