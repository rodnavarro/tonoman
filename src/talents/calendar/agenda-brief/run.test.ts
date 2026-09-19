import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CalendarEvent, TalentContext } from '../../../talent-sdk';
import { run } from './run';

function ctx(events: CalendarEvent[], timezone = 'America/New_York') {
  const calendarEvents = vi.fn(async () => events);
  const infer = vi.fn();
  const c = {
    input: { item: 'agenda-2026-09-17T11:00', config: {}, context: { timezone } },
    creds: {},
    credential: vi.fn(),
    cap: { transcribe: vi.fn(), infer, publish: vi.fn(), calendarCandidates: vi.fn(), calendarEvents },
    progress: vi.fn(),
    log: vi.fn(),
  } as unknown as TalentContext;
  return { c, calendarEvents, infer };
}

const at = (t: string): number => Date.parse(`2026-09-17T${t}:00-04:00`);
const ev = (summary: string, a: string, b: string): CalendarEvent => ({
  summary,
  start: at(a),
  end: at(b),
  attendees: [],
  source: { kind: 'ics', alias: 'foley' },
});

afterEach(() => vi.useRealTimers());

describe('agenda-brief run', () => {
  it('reads today in the tenant zone and steers with the overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('07:00'));
    const { c, calendarEvents, infer } = ctx([ev('Foley review', '10:00', '11:00'), ev('Vendor call', '10:30', '11:30')]);
    const out = await run(c);
    expect(calendarEvents).toHaveBeenCalledWith({ from: at('00:00'), to: Date.parse('2026-09-18T00:00:00-04:00') });
    expect(out.status).toBe('done');
    expect(out.steer).toContain('morning agenda check');
    expect(out.steer).toContain('“Foley review” and “Vendor call” collide for 30 min from 10:30');
    expect(out.summary).toBe('Morning brief: 2 meeting(s) left, 1 overlap(s).');
    // No model call inside the Talent: the announcement turn writes the brief.
    expect(infer).not.toHaveBeenCalled();
  });

  it('at noon is a midday check of what is left', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('12:00'));
    const { c } = ctx([ev('Standup', '09:00', '09:15'), ev('Sync', '14:00', '14:30')]);
    const out = await run(c);
    expect(out.steer).toContain('midday agenda check');
    expect(out.steer).toContain('Still ahead today (1): 14:00–14:30 Sync');
    expect(out.steer).not.toContain('Standup');
  });

  it('a late-afternoon time is an end-of-day check, not a midday one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('16:00'));
    const { c } = ctx([ev('Wrap-up', '16:30', '17:00'), ev('Earlier', '14:00', '14:30')]);
    const out = await run(c);
    expect(out.steer).toContain('end-of-day agenda check');
    expect(out.steer).toContain('Still ahead today (1): 16:30–17:00 Wrap-up');
    expect(out.summary).toBe('End-of-day brief: 1 meeting(s) left, 0 overlap(s).');
  });

  it('falls back to UTC without a timezone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-17T07:00:00Z'));
    const { c, calendarEvents } = ctx([], '');
    await run(c);
    expect(calendarEvents).toHaveBeenCalledWith({ from: Date.parse('2026-09-17T00:00:00Z'), to: Date.parse('2026-09-18T00:00:00Z') });
  });
});
