// What a failed turn should SAY, as pure functions.
//
// Separate from `authflow.ts` for a structural reason rather than a stylistic one: a Temporal
// workflow is bundled into a sandbox with no Node built-ins, and `authflow` imports
// `node:child_process` to drive the harness. Importing it from a workflow fails the webpack build
// with `Module not found: node:child_process`, and the worker then never starts at all — which
// presents as a hang rather than as a bad import.
//
// So anything a WORKFLOW needs to decide lives here, where there is nothing to import.
// `authflow.ts` re-exports these so the gateway keeps one place to look.

/** PURE: did this turn fail because there is no working inference credential?
 *
 *  A different failure from every other one, and it deserves a different sentence. "I hit an error"
 *  is true and useless: the person can retry forever and it will never work, because nothing is
 *  wrong with their message — the agent has no subscription to answer on.
 *
 *  The auth gate normally catches this before a turn is attempted, from `auth_state` in the
 *  registry. That remains the right source: a FACT about the agent, never a file check — jarvis
 *  reported healthy for 54 days over a credential that had expired and carried no refresh token.
 *  But `auth_state` is a SNAPSHOT, and this is the floor beneath it. A credential that expires
 *  between roster refreshes leaves the gate open and the turn failing, and the customer reads a
 *  fragment of a stack trace.
 *
 *  Deliberately narrow. Over-matching would hide real faults behind "sign in again", and somebody
 *  would sign in repeatedly while the actual problem went unreported.
 *
 *  MATCHED AGAINST STRINGS THE HARNESS ACTUALLY EMITS, not against guesses at them. The first
 *  version was written from imagination and read well - and then the real thing,
 *  "Failed to authenticate: OAuth session expired and could not be refreshed", matched none of it,
 *  so an expired subscription reached Slack as "I hit an error and couldn't finish that". Every
 *  alternative below is quoted in the test from a log, and any new one should arrive the same way. */
export function isNotLoggedInError(msg: string): boolean {
  return /not logged ?in|please run \/login|no credentials found|invalid api key|oauth (token|session) (has )?expired|could not be refreshed|authentication_error/i.test(
    msg || "",
  );
}

/** What to say when there is no inference credential. Names the fix, because there is exactly one
 *  and the person cannot guess it — and deliberately does NOT say "try again", which is the one
 *  thing guaranteed not to work. */
export function notLoggedInNotice(): string {
  return (
    "⚠️ I can't answer — I'm not signed in to an inference provider right now.\n" +
    "Send `!connect claude` and I'll walk you through it."
  );
}

/** Temporal's own wrapper messages. An activity that throws reaches the workflow as an
 *  `ActivityFailure` whose message is the constant "Activity task failed"; what the activity
 *  actually said is on `cause`. These carry no information about the failure at all. */
const WRAPPERS = /^(activity task failed|workflow execution failed|activity task cancelled)$/i;

/** PURE: the real reason, dug out of a Temporal failure chain.
 *
 *  This is the bug behind the bug. `String(e.message)` on an ActivityFailure is ALWAYS
 *  "Activity task failed" — so a person read "⚠️ I hit an error and couldn't finish that —
 *  Activity task failed", and, worse, `isNotLoggedInError` was being asked about that constant
 *  rather than about the harness's message. No pattern could ever have matched it. Widening the
 *  classifier looked like a fix and changed nothing, because the string it was judging was never
 *  the string that mattered.
 *
 *  The rendered text was the evidence all along: "Activity task failed" IS the wrapper's message,
 *  printed where the reason was meant to go.
 *
 *  Returns the outermost message that isn't a wrapper, so a real error at any depth wins, and
 *  falls back to the original rather than to an empty string — an unrecognised shape should read
 *  worse, never blanker. */
export function failureReason(e: unknown): string {
  const seen = new Set<unknown>();
  let node: unknown = e;
  let fallback = "";
  for (let depth = 0; node && depth < 8 && !seen.has(node); depth++) {
    seen.add(node);
    const msg = String((node as { message?: unknown })?.message ?? "").trim();
    if (msg && !fallback) fallback = msg;
    if (msg && !WRAPPERS.test(msg)) return msg;
    node = (node as { cause?: unknown })?.cause;
  }
  return fallback || String(e ?? "unknown error");
}
