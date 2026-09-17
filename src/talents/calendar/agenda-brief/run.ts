import type { TalentRun } from '../../../talent-sdk';
import { agendaFacts, dayBounds, describeFacts, localParts } from './facts';

// One agenda brief. The facts are computed here (facts.ts); the agent writes the message from them in
// its own voice, as it does for a recap — so a brief is one model turn, the announcement, and the
// numbers in it come from code rather than from the model reading a list of times.
export const run: TalentRun = async (ctx) => {
  const timeZone = String(ctx.input.context?.timezone || 'UTC');
  const now = Date.now();
  const { start, end } = dayBounds(now, timeZone);

  ctx.progress('reading calendars');
  const events = await ctx.cap.calendarEvents({ from: start, to: end });
  const facts = agendaFacts(events, now, timeZone);
  // The times are configurable, so the label comes from the local hour, not from which slot fired:
  // before 11:00 is the morning look at the whole day; after that, only what is left of it.
  const phase = checkPhase(localParts(now, timeZone).hour);
  const midday = phase !== "morning";

  const steer =
    `It's time for the ${phase} agenda check. From their calendars (times ${timeZone}):\n` +
    `${describeFacts(facts, timeZone, midday)}\n\n` +
    'Write them a short message: how the ' +
    (midday ? 'rest of the day' : 'day') +
    ' looks, every overlap called out plainly with which one you would move or decline and why, any back-to-back ' +
    'stretch that leaves no break, and the best free block to protect. If the calendar is clear, say so in one line. ' +
    'Do not invent meetings or times that are not listed above.';

  return {
    status: 'done',
    summary: `${phase[0]!.toUpperCase()}${phase.slice(1)} brief: ${facts.remaining.length} meeting(s) left, ${facts.overlaps.length} overlap(s).`,
    steer,
  };
};

/** PURE: which check a brief is, from the local hour it runs at. */
export function checkPhase(hour: number): "morning" | "midday" | "end-of-day" {
  if (hour < 11) return "morning";
  if (hour < 16) return "midday";
  return "end-of-day";
}
