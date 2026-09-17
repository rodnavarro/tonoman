import type { TalentManifest } from './contract';

// The agenda brief, as the worker registers it in the Cloud catalogue. Kept in step with the Talent's
// own manifest (src/talents/calendar/agenda-brief/manifest.ts): same name, version and config.
//
// Its schedule is time-of-day, not a poll: `times` (local, comma-separated, default 07:00,12:00) in the
// tenant's timezone, created by the worker when the grant exists.
export const agendaBrief: TalentManifest = {
  name: 'agenda-brief',
  version: 1,
  description: "Review today's calendar at set times: what's left, what overlaps, and where the free time is.",
  requires: [{ kind: 'calendar' }],
  configSchema: [{ key: 'times', type: 'text', label: 'When to send it (HH:MM, comma-separated, local time)' }],
  schedule: { kind: 'times', summary: 'Sends a brief at the set times of day' },
};

/** The times a brief goes out when the grant does not say. */
export const DEFAULT_AGENDA_TIMES = '07:00,12:00';

/** PURE: `"07:00, 12:30"` → hour/minute pairs. Anything unreadable is dropped, not guessed; a value that
 *  yields nothing means no schedule rather than a brief at midnight. Duplicates collapse. */
export function parseAgendaTimes(raw: unknown): { hour: number; minute: number }[] {
  const text = typeof raw === 'string' && raw.trim() ? raw : DEFAULT_AGENDA_TIMES;
  const seen = new Set<string>();
  const out: { hour: number; minute: number }[] = [];
  for (const part of text.split(',')) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) continue;
    const key = `${hour}:${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hour, minute });
  }
  return out.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}
