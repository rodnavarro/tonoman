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
  // Morning before 11:00 local looks at the whole day; later in the day, only what is left.
  const midday = localParts(now, timeZone).hour >= 11;

  const steer =
    `It's time for the ${midday ? 'midday' : 'morning'} agenda check. From their calendars (times ${timeZone}):\n` +
    `${describeFacts(facts, timeZone, midday)}\n\n` +
    'Write them a short message: how the ' +
    (midday ? 'rest of the day' : 'day') +
    ' looks, every overlap called out plainly with which one you would move or decline and why, any back-to-back ' +
    'stretch that leaves no break, and the best free block to protect. If the calendar is clear, say so in one line. ' +
    'Do not invent meetings or times that are not listed above.';

  return {
    status: 'done',
    summary: `${midday ? 'Midday' : 'Morning'} brief: ${facts.remaining.length} meeting(s) left, ${facts.overlaps.length} overlap(s).`,
    steer,
  };
};
