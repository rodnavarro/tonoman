// The visible work log: what the agent is doing, and for how long.
//
// Slack's assistant status line ("Nelly is thinking…") holds ONE short string and disappears the
// moment the turn settles. That is the right place for the current activity and the wrong place
// for a record of it — a person who watched the agent grep the second brain three times and read
// two files has no way to see that afterwards, and during the turn the status text does not move
// unless a new event happens to arrive.
//
// So the tool trace is a standalone NOTE (Reply.note): a message the turn owns, updated on a timer
// so the elapsed time actually ticks, and settled to one compact line when the answer lands. It is
// never the message the answer is written into — that was the "…" placeholder Rod saw flash and be
// overwritten, and it reads as a glitch.
//
// Everything here is PURE. The activity owns the timer and the posting; this module owns what the
// person reads.

export interface ToolCall {
  /** The harness's tool name, e.g. "Bash", "Grep". */
  tool: string;
  /** A short preview of what it was called with, when the harness gives one. */
  detail?: string;
}

/** How many trace lines the live note shows. A turn can make dozens of calls; the useful thing is
 *  what it is doing NOW plus enough history to see the shape of it. */
const TRACE_LINES = 5;

/** Elapsed, in the form a person reads at a glance: `4s`, `1m 12s`, `3m 04s`. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Collapse consecutive-or-not repeats into `name ×n`, preserving first-use order. This is what
 *  makes the settled line readable: "Grep ×4, Read ×2" rather than six identical bullets. */
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
  return detail ? `• \`${c.tool}\` — ${detail.slice(0, 80)}` : `• \`${c.tool}\``;
}

/**
 * The live note, re-rendered on every tick.
 *
 * The elapsed time is first because it is the part that moves: it is the difference between "the
 * agent is working" and "the agent is stuck", and it is the whole reason this is on a timer rather
 * than only on tool events.
 */
export function liveNote(calls: ToolCall[], elapsedMs: number): string {
  const head = `⚙️ *Working…* ${fmtElapsed(elapsedMs)}`;
  if (calls.length === 0) return head;
  const shown = calls.slice(-TRACE_LINES);
  const hidden = calls.length - shown.length;
  const lines = [head, ...shown.map(traceLine)];
  if (hidden > 0) lines.splice(1, 0, `_…${hidden} earlier step${hidden === 1 ? "" : "s"}_`);
  return lines.join("\n");
}

/**
 * The settled note: what the turn actually did, in one line, kept above the answer.
 *
 * Null means "delete the note instead" — a turn that answered from the model alone in a couple of
 * seconds has nothing to show, and leaving a "Worked for 2s" line above every trivial reply is
 * clutter that makes the real traces harder to notice.
 */
export function settledNote(calls: ToolCall[], elapsedMs: number): string | null {
  if (calls.length === 0) return null;
  const parts = tally(calls).map((t) => (t.n > 1 ? `${t.tool} ×${t.n}` : t.tool));
  return `⚙️ Worked for ${fmtElapsed(elapsedMs)} · ${parts.join(", ")}`;
}

/** The Slack status-line text for the current activity, bounded to Slack's 100-char limit. */
export function statusFor(current: ToolCall | undefined, elapsedMs: number): string {
  const base = current ? `is running ${current.tool.toLowerCase()}` : "is thinking";
  return `${base} · ${fmtElapsed(elapsedMs)}`.slice(0, 100);
}
