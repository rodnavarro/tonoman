// The waiting voice: a whimsical verb and a clock, à la Claude's "Cogitating… / Thought for 34s".
//
// This lived inside the Teams connector, which is the wrong home for it: it is the product's tone
// while somebody waits, not a detail of one transport. Slack needs exactly the same thing, and two
// copies of a personality drift into two personalities.
//
// Everything here is PURE, so a connector can inject a fixed verb in tests and assert on the exact
// rendered string.

/** A verb in both forms. Stored explicitly rather than derived: "Vibing"/"Vibed" and
 *  "Moonwalking"/"Moonwalked" do not come out of an -ing/-ed rule. */
export interface MysticVerb {
  /** present, while the turn runs: "Cogitating" */
  ing: string;
  /** past, once it has settled: "Cogitated" */
  ed: string;
}

export const MYSTIC_VERBS: MysticVerb[] = [
  { ing: "Cogitating", ed: "Cogitated" },
  { ing: "Ruminating", ed: "Ruminated" },
  { ing: "Pondering", ed: "Pondered" },
  { ing: "Percolating", ed: "Percolated" },
  { ing: "Marinating", ed: "Marinated" },
  { ing: "Moonwalking", ed: "Moonwalked" },
  { ing: "Noodling", ed: "Noodled" },
  { ing: "Conjuring", ed: "Conjured" },
  { ing: "Finagling", ed: "Finagled" },
  { ing: "Wrangling", ed: "Wrangled" },
  { ing: "Mulling", ed: "Mulled" },
  { ing: "Ideating", ed: "Ideated" },
  { ing: "Tinkering", ed: "Tinkered" },
  { ing: "Vibing", ed: "Vibed" },
  { ing: "Scheming", ed: "Schemed" },
];

/** One verb per turn, picked once. Re-picking mid-turn would read as a different agent taking over. */
export function randomMysticVerb(): MysticVerb {
  return MYSTIC_VERBS[Math.floor(Math.random() * MYSTIC_VERBS.length)]!;
}

/** Exact seconds in the first minute ("5s", "47s") so the cue is visibly moving; after a minute,
 *  10-second steps ("1m", "1m10s", "2m30s") so a long wait does not churn the channel. Empty under
 *  a second — a number that starts at 0 reads as broken. */
export function compactElapsed(ms: number): string {
  if (ms < 1_000) return "";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s10 = Math.floor((ms % 60_000) / 10_000) * 10;
  return s10 ? `${m}m${s10}s` : `${m}m`;
}

/** In progress: the 🤖 marker, the verb, and the clock. `🤖 Marinating… 12s` */
export function activeLine(verb: MysticVerb, elapsedMs: number): string {
  const e = compactElapsed(elapsedMs);
  return e ? `🤖 ${verb.ing}… ${e}` : `🤖 ${verb.ing}…`;
}

/** Settled: past tense and a whole duration. `Marinated for 34 seconds`.
 *
 *  No 🤖 marker, deliberately — the marker means "still going", and dropping it is half of what
 *  makes the finished line read as finished. */
export function settledLine(verb: MysticVerb, elapsedMs: number): string {
  if (elapsedMs < 60_000) {
    const s = Math.max(1, Math.round(elapsedMs / 1000));
    return `${verb.ed} for ${s} second${s === 1 ? "" : "s"}`;
  }
  const m = Math.round(elapsedMs / 60_000);
  return `${verb.ed} for ${m} minute${m === 1 ? "" : "s"}`;
}
