import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TalentContext } from '../../../talent-sdk';
import { run, applyCalendarMatch, resolveMeeting } from './run';

// Proves the Talent's orchestration end-to-end without a subprocess or a real plane: the Plaud
// client (over a mocked global fetch), the transcribe → calendar → infer → publish sequence, and the
// outcome it REPORTS. The SDK's runCli boundary and the real capability plane are proven by the
// cutover + a live recording; this is the fast, deterministic check of the logic that moved into the
// Talent.

// start_at as Plaud actually sends it: an ISO string, often without a timezone. A naive Number()
// parse would file this at 1970 — the bug toMs exists to avoid.
const okFile = {
  id: 'rec1',
  name: 'Q3 planning.m4a',
  start_at: '2026-09-12T18:00:00.000000',
  duration: 2_580_000,
  presigned_url: 'https://plaud.test/audio/rec1',
};

function mockPlaud(file: unknown = okFile): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(file), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

/** A context whose capabilities are stubs; each test overrides what it cares about. */
function ctx(over: Partial<TalentContext['cap']> = {}, inputOver: Partial<TalentContext['input']> = {}): TalentContext {
  return {
    input: {
      item: 'rec1',
      config: {},
      context: {
        mission: 'Grow the business with the least overhead.',
        journal: { path: 'Meetings', routes: [{ id: 'globex-meetings', when: 'Globex' }], fallback: 'unclassified' },
        vocab: 'Tonoman',
      },
      ...inputOver,
    },
    creds: {},
    credential: async () => ({ token: 'tok', base: 'https://plaud.test' }),
    cap: {
      transcribe: async () => ({ text: 'We decided to ship on Friday and Rod owns the launch note.', seconds: 5, by: ['local-gpu'] }),
      calendarCandidates: async () => [],
      infer: async () => ({
        text: JSON.stringify({
          summary: 'Planning sync: shipping Friday.',
          highlights: ['Ship Friday', 'Rod owns the launch note', 'Priya to demo'],
          decisions: ['Ship Friday'],
          followups: [],
          route: 'globex-meetings',
          alignment: 'advances',
          alignmentReason: 'Moves the launch forward.',
        }),
      }),
      publish: async () => ({ published: true, path: 'Meetings/globex-meetings/rec1.md', route: 'globex-meetings' }),
      ...over,
    },
    progress: () => {},
    log: () => {},
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('the Plaud Talent run', () => {
  it('files a recording and reports a steer the agent announces (not a channel message)', async () => {
    mockPlaud();
    let publishedRec: { startTime?: number } | undefined;
    const c = ctx({
      publish: async (p) => {
        publishedRec = p.rec as { startTime?: number };
        return { published: true, path: 'Meetings/globex-meetings/rec1.md', route: 'globex-meetings' };
      },
    });
    const outcome = await run(c);
    expect(outcome.status).toBe('done');
    // The ISO start_at parsed to a real epoch (not 0/1970) — the bug toMs guards.
    expect(publishedRec?.startTime).toBe(Date.parse('2026-09-12T18:00:00.000000Z'));
    // Reports, does not speak: the steer names where it landed and carries the three highlights for
    // the agent to phrase in its own words.
    expect(outcome.steer).toContain('Meetings/globex-meetings/rec1.md');
    expect(outcome.steer).toContain('Ship Friday');
    expect(outcome.steer).toContain('Rod owns the launch note');
    expect(outcome.summary).toContain('local-gpu');
  });

  it('skips a recording with no speech rather than filing a page about silence', async () => {
    mockPlaud();
    const outcome = await run(ctx({ transcribe: async () => ({ text: '   ', seconds: 1, by: ['local-gpu'] }) }));
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toMatch(/no speech/);
  });

  it('does not announce when the recording was already filed (another run got there first)', async () => {
    mockPlaud();
    const outcome = await run(ctx({ publish: async () => ({ published: false, path: 'Meetings/globex-meetings/rec1.md', route: 'globex-meetings' }) }));
    expect(outcome.status).toBe('skipped');
    expect(outcome.steer).toBeUndefined();
  });

  it('surfaces a recording still being prepared as a retryable failure, not a silent skip', async () => {
    mockPlaud({ id: 'rec1', name: 'x', duration: 2580, presigned_url: undefined });
    await expect(run(ctx())).rejects.toThrow(/being prepared/);
  });
});

describe('applyCalendarMatch — what a match changes, as the original pipeline did', () => {
  const base = { summary: 's', highlights: [], decisions: [], followups: [] };
  const cands = [
    { summary: 'API Team Standup', attendees: ['Rod Navarro', 'Chris'], source: { kind: 'ics', alias: 'globex' } },
    { summary: 'Acme weekly', attendees: [], source: { kind: 'google', alias: 'personal' } },
  ];

  it('matches case-insensitively, like the worker does', () => {
    expect(resolveMeeting(cands, '  api team standup ')?.summary).toBe('API Team Standup');
  });

  it("takes the matched entry's attendees as the participants, and its calendar's route", () => {
    const out = applyCalendarMatch({ ...base, meeting: 'api team standup', route: 'unclassified', participants: ['guess'] }, cands, { globex: 'globex-meetings' });
    expect(out.meeting).toBe('API Team Standup');
    expect(out.participants).toEqual(['Rod Navarro', 'Chris']);
    expect(out.participantsFrom).toBe('calendar');
    expect(out.route).toBe('globex-meetings');
    expect(out.routeReason).toContain('globex calendar');
  });

  it("keeps the model's route and marks its participants as inferred when the calendar says nothing", () => {
    const out = applyCalendarMatch({ ...base, meeting: 'Acme weekly', route: 'acme-meetings', participants: ['Rod'] }, cands, { globex: 'globex-meetings' });
    expect(out.route).toBe('acme-meetings');
    expect(out.participants).toEqual(['Rod']);
    expect(out.participantsFrom).toBe('transcript');
  });

  it('refuses a meeting the model was not shown', () => {
    const out = applyCalendarMatch({ ...base, meeting: 'Made-up sync' }, cands, { globex: 'globex-meetings' });
    expect(out.meeting).toBe('');
    expect(out.route).toBeUndefined();
  });
});
