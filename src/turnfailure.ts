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
 *  would sign in repeatedly while the actual problem went unreported. */
export function isNotLoggedInError(msg: string): boolean {
  return /not logged ?in|please run \/login|no credentials found|invalid api key|oauth token (has )?expired|authentication_error/i.test(
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
