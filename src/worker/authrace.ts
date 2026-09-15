// The OAuth refresh race, and the one correct reaction to it: wait a moment and run again.
//
// One agent is one Claude login, and one login is one credentials file — while the pod runs several
// `claude` processes on it at once: a person's turn, a recap being summarised, the announcement of
// that recap. When the access token is due, whichever process starts first refreshes it and the next
// one, arriving mid-refresh, exits with "Failed to refresh OAuth token: another Claude Code process
// is refreshing it or exited mid-refresh". Nine times in one day; every one of them a turn that
// produced nothing.
//
// What made it worse than a blip: a turn that fails before its first token looks exactly like a
// session that cannot be resumed, so the worker "repaired" it by starting a FRESH session — and the
// person's conversation lost its memory over a token refresh that would have finished in seconds.
//
// So: a race error that arrives before anything has been streamed is retried on the SAME request,
// same session, after a short wait. Anything after the first event is not retried — the person has
// already seen output, and a second run would say it twice.

import type { TurnEvent } from "../core/contracts";

/** PURE: is this the refresh race, as the CLI words it? Quoted from the log, like every other
 *  classifier in turnfailure.ts. NOT an expired login — that has its own classifier and its own
 *  answer (`!connect claude`), and the two must never be confused: one waits, the other asks. */
export function isAuthRaceError(msg: string): boolean {
  return /another Claude Code process is refreshing|exited mid-refresh/i.test(msg || "");
}

/** The waits between attempts. A refresh is a single HTTP round trip, so the first retry is soon;
 *  the later ones cover a process that died mid-refresh and left its lock for the CLI to expire. */
export const AUTH_RACE_DELAYS_MS = [3_000, 8_000, 15_000];

export interface AuthRaceOptions {
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Run `start()` and pass its events through; if the FIRST event is the refresh race, wait and run
 *  it again, up to `delaysMs.length` more times. Every other error, and a race that arrives after
 *  output has already been streamed, passes through untouched. */
export async function* withAuthRaceRetry(
  start: () => AsyncIterable<TurnEvent>,
  o: AuthRaceOptions = {},
): AsyncGenerator<TurnEvent> {
  const delays = o.delaysMs ?? AUTH_RACE_DELAYS_MS;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? ((s) => console.warn(s));
  for (let attempt = 0; ; attempt++) {
    let streamed = false;
    let raced = false;
    for await (const ev of start()) {
      if (!streamed && ev.kind === "error" && attempt < delays.length && isAuthRaceError(ev.err?.message ?? "")) {
        raced = true;
        break; // closes the inner iterator; the process behind it has already exited
      }
      streamed = true;
      yield ev;
    }
    if (!raced) return;
    const ms = delays[attempt]!;
    log(`harness: OAuth refresh race on start; retrying the same turn in ${ms}ms (${attempt + 1}/${delays.length})`);
    await sleep(ms);
  }
}
