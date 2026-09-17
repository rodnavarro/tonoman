import type { CalendarEvent } from '../../../talent-sdk';

// The agenda brief's arithmetic, kept PURE and out of the model: which meetings are left, which ones
// collide, where the back-to-back stretches are, and where the free time is. A model asked to spot
// overlaps in a list of times gets them wrong often enough to matter; this does not.

const MIN = 60_000;

/** The parts of an instant as a clock in `timeZone` shows it. */
export function localParts(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour') % 24, minute: n('minute') };
}

/** How far ahead of UTC the zone's clock is at that instant, in minutes. */
function offsetMinutes(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MIN) * MIN) / MIN);
}

/** The instant a local wall-clock time on the same local day as `ms` happens. */
export function localTimeOn(ms: number, timeZone: string, hour: number, minute = 0): number {
  const p = localParts(ms, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day, hour, minute) - offsetMinutes(ms, timeZone) * MIN;
  // Re-read the offset AT the guess, so a day that crosses a DST change lands on the right hour.
  return Date.UTC(p.year, p.month - 1, p.day, hour, minute) - offsetMinutes(guess, timeZone) * MIN;
}

/** Today in `timeZone`: [local midnight, next local midnight). */
export function dayBounds(now: number, timeZone: string): { start: number; end: number } {
  const start = localTimeOn(now, timeZone, 0, 0);
  const p = localParts(now, timeZone);
  const tomorrowNoon = Date.UTC(p.year, p.month - 1, p.day + 1, 12) - offsetMinutes(now, timeZone) * MIN;
  return { start, end: localTimeOn(tomorrowNoon, timeZone, 0, 0) };
}

/** `HH:MM` in the zone. */
export function hhmm(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export interface Overlap {
  a: CalendarEvent;
  b: CalendarEvent;
  minutes: number;
}

export interface AgendaFacts {
  /** Every meeting today, in order. */
  today: CalendarEvent[];
  /** Meetings not yet over. */
  remaining: CalendarEvent[];
  /** Pairs of remaining meetings that collide, and by how much. */
  overlaps: Overlap[];
  /** Runs of three or more remaining meetings with five minutes or less between them. */
  backToBack: CalendarEvent[][];
  /** Gaps of at least 30 minutes left in the working day. */
  freeBlocks: { start: number; end: number }[];
}

/** PURE: the facts a brief is written from. Working hours bound the free time (default 08:00-18:00). */
export function agendaFacts(
  events: CalendarEvent[],
  now: number,
  timeZone: string,
  workday: { startHour: number; endHour: number } = { startHour: 8, endHour: 18 },
): AgendaFacts {
  const today = [...events].sort((x, y) => x.start - y.start || x.summary.localeCompare(y.summary));
  const remaining = today.filter((e) => e.end > now);

  const overlaps: Overlap[] = [];
  for (let i = 0; i < remaining.length; i++) {
    for (let j = i + 1; j < remaining.length; j++) {
      const a = remaining[i]!;
      const b = remaining[j]!;
      const minutes = Math.round((Math.min(a.end, b.end) - Math.max(a.start, b.start)) / MIN);
      if (minutes > 0) overlaps.push({ a, b, minutes });
    }
  }

  const backToBack: CalendarEvent[][] = [];
  let run: CalendarEvent[] = [];
  for (const e of remaining) {
    const prev = run[run.length - 1];
    if (prev && e.start - prev.end <= 5 * MIN && e.start >= prev.end) run.push(e);
    else {
      if (run.length >= 3) backToBack.push(run);
      run = [e];
    }
  }
  if (run.length >= 3) backToBack.push(run);

  const dayStart = localTimeOn(now, timeZone, workday.startHour);
  const dayEnd = localTimeOn(now, timeZone, workday.endHour);
  const freeBlocks: { start: number; end: number }[] = [];
  let cursor = Math.max(now, dayStart);
  for (const e of remaining) {
    if (e.start > cursor && e.start - cursor >= 30 * MIN) freeBlocks.push({ start: cursor, end: Math.min(e.start, dayEnd) });
    cursor = Math.max(cursor, e.end);
    if (cursor >= dayEnd) break;
  }
  if (dayEnd - cursor >= 30 * MIN) freeBlocks.push({ start: cursor, end: dayEnd });

  return { today, remaining, overlaps, backToBack, freeBlocks: freeBlocks.filter((f) => f.end - f.start >= 30 * MIN) };
}

/** PURE: the facts as lines the agent writes its message from, in the tenant's clock. */
export function describeFacts(f: AgendaFacts, timeZone: string, midday: boolean): string {
  const at = (e: CalendarEvent): string => `${hhmm(e.start, timeZone)}–${hhmm(e.end, timeZone)} ${e.summary}`;
  const lines: string[] = [];
  const list = midday ? f.remaining : f.today;
  lines.push(
    list.length
      ? `${midday ? 'Still ahead today' : 'Today'} (${list.length}): ${list.map(at).join('; ')}`
      : `${midday ? 'Nothing else on the calendar today.' : 'Nothing on the calendar today.'}`,
  );
  if (f.overlaps.length) {
    lines.push(
      `Overlaps (${f.overlaps.length}): ${f.overlaps.map((o) => `“${o.a.summary}” and “${o.b.summary}” collide for ${o.minutes} min from ${hhmm(Math.max(o.a.start, o.b.start), timeZone)}`).join('; ')}`,
    );
  } else if (list.length) {
    lines.push('No overlaps.');
  }
  for (const r of f.backToBack) {
    lines.push(`Back-to-back from ${hhmm(r[0]!.start, timeZone)} to ${hhmm(r[r.length - 1]!.end, timeZone)}: ${r.length} meetings with no real break.`);
  }
  if (f.freeBlocks.length) {
    lines.push(`Free blocks: ${f.freeBlocks.map((b) => `${hhmm(b.start, timeZone)}–${hhmm(b.end, timeZone)}`).join(', ')}.`);
  }
  return lines.join('\n');
}
