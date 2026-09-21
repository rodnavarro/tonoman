import type { TalentManifest } from '../../../talent-sdk';

// The agenda brief: at configured times of day, look at the agent's calendars, work out what is left,
// what collides and where the free time is, and have the agent tell the person. It owns no calendar
// code — calendars are a runtime capability every Talent shares (ctx.cap.calendarEvents).
export const manifest: TalentManifest = {
  name: 'agenda-brief',
  version: 1,
  description: "Review today's calendar at set times: what's left, what overlaps, and where the free time is.",
  requires: [{ kind: 'calendar' }],
  capabilities: ['calendar'],
  configSchema: [
    // Comma-separated local times in the tenant's timezone. Default 07:00,12:00.
    { key: 'times', type: 'text', label: 'When to send it (HH:MM, comma-separated, local time)' },
  ],
};
