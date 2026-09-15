// The visible work log: what the agent is doing, and for how long.
//
// Slack's assistant status line holds ONE short string and disappears the moment the turn settles.
// That is the right place for the current activity and the wrong place for a record of it — a
// person who watched the agent grep the second brain three times and read two files has no way to
// see that afterwards, and during the turn the status text does not move unless a new event
// happens to arrive.
//
// So the tool trace is a standalone NOTE (Reply.note): a message the turn owns, updated on a timer
// so the clock actually ticks, and settled to one line when the answer lands. It is never the
// message the answer is written into — that was the "…" placeholder that flashed and got
// overwritten, and it reads as a glitch.
//
// The voice is Teams': the 🤖 marker with a mystic verb while it runs, past tense once it is done —
// `🤖 Marinating… 12s` becoming `Marinated for 14 seconds`. Shared from core/mystic rather than
// re-invented, because an agent that is whimsical on Teams and terse on Slack is two agents.
//
// Everything here is PURE. The activity owns the timer, the verb, and the posting; this module
// owns what the person reads.

import { activeLine, settledLine, type MysticVerb } from "../core/mystic";

export interface ToolCall {
  /** The harness's tool name, e.g. "Bash", "Grep". */
  tool: string;
  /** A short preview of what it was called with, when the harness gives one. */
  detail?: string;
}

/** How many trace lines the live note shows. A turn can make dozens of calls; the useful thing is
 *  what it is doing NOW plus enough history to see the shape of it. */
const TRACE_LINES = 5;

/** Collapse repeats into `name ×n`, preserving first-use order. This is what makes the settled line
 *  readable: "Grep ×4, Read ×2" rather than six identical bullets. */
export function tally(calls: ToolCall[]): { tool: string; n: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const c of calls) {
    if (!counts.has(c.tool)) order.push(c.tool);
    counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
  }
  return order.map((tool) => ({ tool, n: counts.get(tool) ?? 0 }));
}

/** One trace line. The detail is trimmed hard — a Bash preview can be a whole command line, and a
 *  note that wraps to four lines per call stops being scannable. */
function traceLine(c: ToolCall): string {
  const detail = (c.detail ?? "").replace(/\s+/g, " ").trim();
  return detail ? `🔧 \`${c.tool}\` — ${detail.slice(0, 80)}` : `🔧 \`${c.tool}\``;
}

/**
 * The live note, re-rendered on every tick: the tools above, the 🤖 verb and the clock below.
 *
 * That order is Teams': the tools are what changed, the verb line is what is still true. It is also
 * why the clock is on the bottom line — it is the part that moves, and a moving line is the
 * difference between "the agent is working" and "the agent is stuck".
 */
export function liveNote(calls: ToolCall[], elapsedMs: number, verb: MysticVerb): string {
  const lines: string[] = [];
  const shown = calls.slice(-TRACE_LINES);
  const hidden = calls.length - shown.length;
  if (hidden > 0) lines.push(`_…${hidden} earlier step${hidden === 1 ? "" : "s"}_`);
  lines.push(...shown.map(traceLine));
  lines.push(activeLine(verb, elapsedMs));
  return lines.join("\n");
}

/**
 * The settled note: past tense, a whole duration, and what the turn actually used.
 *
 * `Marinated for 14 seconds · Grep ×4, Read ×2`
 *
 * Null means "delete the note instead" — a turn that answered from the model alone in a couple of
 * seconds has nothing to show, and a "Pondered for 2 seconds" above every trivial reply is clutter
 * that makes the real traces harder to notice.
 */
export function settledNote(calls: ToolCall[], elapsedMs: number, verb: MysticVerb): string | null {
  if (calls.length === 0) return null;
  const used = tally(calls).map((t) => (t.n > 1 ? `${t.tool} ×${t.n}` : t.tool));
  return `${settledLine(verb, elapsedMs)} · ${used.join(", ")}`;
}

/** The Slack status-line text under the composer, bounded to Slack's 100-character limit.
 *
 *  Slack prefixes it with the agent's name, so this reads "Nelly is running grep" or, before any
 *  tool has run, "Nelly is marinating" — the same verb the note is using, lower-cased to sit in
 *  the sentence. */
export function statusFor(current: ToolCall | undefined, verb: MysticVerb): string {
  const what = current ? `running ${current.tool.toLowerCase()}` : verb.ing.toLowerCase();
  return `is ${what}`.slice(0, 100);
}
