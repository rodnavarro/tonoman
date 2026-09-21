import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../../talent-sdk';
import { agendaFacts, dayBounds, describeFacts, hhmm, localTimeOn } from './facts';

const TZ = 'America/New_York';
const H = 3_600_000;
const M = 60_000;

/** A New York wall-clock time on 2026-09-17 (EDT, UTC-4). */
const nyc = (t: string): number => Date.parse(`2026-09-17T${t}:00-04:00`);
function ev(summary: string, from: string, to: string): CalendarEvent {
  return { summary, start: nyc(from), end: nyc(to), attendees: [], source: { kind: 'ics', alias: 'globex' } };
}

describe('dayBounds', () => {
  it('is local midnight to local midnight', () => {
    const { start, end } = dayBounds(nyc('07:00'), TZ);
    expect(new Date(start).toISOString()).toBe('2026-09-17T04:00:00.000Z');
    expect(new Date(end).toISOString()).toBe('2026-09-18T04:00:00.000Z');
  });

  it('is 25 hours on the day clocks fall back', () => {
    const { start, end } = dayBounds(Date.parse('2026-11-01T12:00:00-05:00'), TZ);
    expect(new Date(start).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect((end - start) / H).toBe(25);
  });

  it('is 23 hours on the day clocks spring forward', () => {
    const { start, end } = dayBounds(Date.parse('2026-03-08T12:00:00-04:00'), TZ);
    expect(new Date(start).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect((end - start) / H).toBe(23);
  });

  it('uses the zone, not UTC, near midnight', () => {
    // 23:30 in New York is already the 18th in UTC; the local day is still the 17th.
    const { start } = dayBounds(nyc('23:30'), TZ);
    expect(new Date(start).toISOString()).toBe('2026-09-17T04:00:00.000Z');
  });
});

describe('localTimeOn / hhmm', () => {
  it('round-trips a wall-clock time', () => {
    expect(hhmm(localTimeOn(nyc('06:00'), TZ, 8, 30), TZ)).toBe('08:30');
    expect(hhmm(localTimeOn(Date.parse('2026-11-01T12:00:00-05:00'), TZ, 18), TZ)).toBe('18:00');
  });
});

describe('agendaFacts', () => {
  const day = [
    ev('Standup', '09:00', '09:15'),
    ev('Globex pipeline review', '10:00', '11:00'),
    ev('Vendor call', '10:30', '11:30'),
    ev('Lunch & learn', '12:00', '12:30'),
    ev('1:1 Priya', '12:30', '13:00'),
    ev('Acme sync', '13:05', '13:30'),
  ];

  it('finds overlaps with their minutes', () => {
    const f = agendaFacts(day, nyc('07:00'), TZ);
    expect(f.overlaps).toHaveLength(1);
    expect(f.overlaps[0]!.a.summary).toBe('Globex pipeline review');
    expect(f.overlaps[0]!.b.summary).toBe('Vendor call');
    expect(f.overlaps[0]!.minutes).toBe(30);
  });

  it('finds back-to-back runs of three with small gaps', () => {
    const f = agendaFacts(day, nyc('07:00'), TZ);
    expect(f.backToBack.map((r) => r.map((e) => e.summary))).toEqual([['Lunch & learn', '1:1 Priya', 'Acme sync']]);
  });

  it('finds free blocks of 30 minutes or more inside working hours', () => {
    const f = agendaFacts(day, nyc('07:00'), TZ);
    expect(f.freeBlocks.map((b) => `${hhmm(b.start, TZ)}-${hhmm(b.end, TZ)}`)).toEqual(['08:00-09:00', '09:15-10:00', '11:30-12:00', '13:30-18:00']);
  });

  it('ignores a gap shorter than 30 minutes', () => {
    const f = agendaFacts([ev('A', '08:00', '09:00'), ev('B', '09:20', '18:00')], nyc('07:00'), TZ);
    expect(f.freeBlocks).toEqual([]);
  });

  it('at midday counts only what is not over, and frees from now', () => {
    const f = agendaFacts(day, nyc('12:10'), TZ);
    expect(f.today).toHaveLength(6);
    expect(f.remaining.map((e) => e.summary)).toEqual(['Lunch & learn', '1:1 Priya', 'Acme sync']);
    expect(f.overlaps).toHaveLength(0);
    expect(f.freeBlocks.map((b) => `${hhmm(b.start, TZ)}-${hhmm(b.end, TZ)}`)).toEqual(['13:30-18:00']);
  });

  it('does not report a block after the working day ends', () => {
    const f = agendaFacts([ev('Late', '17:45', '19:00')], nyc('17:50'), TZ);
    expect(f.freeBlocks).toEqual([]);
  });

  it('an empty calendar is one free working day', () => {
    const f = agendaFacts([], nyc('07:00'), TZ);
    expect(f.freeBlocks.map((b) => (b.end - b.start) / M)).toEqual([600]);
  });
});

describe('describeFacts', () => {
  it('names each overlap in the tenant clock', () => {
    const f = agendaFacts([ev('A', '10:00', '11:00'), ev('B', '10:30', '11:30')], nyc('07:00'), TZ);
    const text = describeFacts(f, TZ, false);
    expect(text).toContain('Today (2): 10:00–11:00 A; 10:30–11:30 B');
    expect(text).toContain('“A” and “B” collide for 30 min from 10:30');
  });

  it('says a clear afternoon plainly', () => {
    const f = agendaFacts([ev('A', '09:00', '10:00')], nyc('12:00'), TZ);
    expect(describeFacts(f, TZ, true)).toContain('Nothing else on the calendar today.');
  });
});
