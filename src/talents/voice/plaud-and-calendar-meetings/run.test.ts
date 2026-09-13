import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TalentContext } from '../../../talent-sdk';
import { run } from './run';

// Proves the Talent's orchestration end-to-end without a subprocess or a real plane: the Plaud
// client (over a mocked global fetch), the transcribe → calendar → infer → publish sequence, and the
// outcome it REPORTS. The SDK's runCli boundary and the real capability plane are proven by the
// cutover + a live recording; this is the fast, deterministic check of the logic that moved into the
// Talent.

const okFile = {
  id: 'rec1',
  name: 'Q3 planning.m4a',
  start_at: 1_757_700_000_000,
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
        journal: { path: 'Meetings', routes: [{ id: 'foley-meetings', when: 'Foley' }], fallback: 'unclassified' },
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
          highlights: ['Ship Friday', 'Rod owns the launch note', 'Celine to demo'],
          decisions: ['Ship Friday'],
          followups: [],
          route: 'foley-meetings',
          alignment: 'advances',
          alignmentReason: 'Moves the launch forward.',
        }),
      }),
      publish: async () => ({ published: true, path: 'Meetings/foley-meetings/rec1.md', route: 'foley-meetings' }),
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
    const outcome = await run(ctx());
    expect(outcome.status).toBe('done');
    // Reports, does not speak: the steer names where it landed and carries the three highlights for
    // the agent to phrase in its own words.
    expect(outcome.steer).toContain('Meetings/foley-meetings/rec1.md');
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
    const outcome = await run(ctx({ publish: async () => ({ published: false, path: 'Meetings/foley-meetings/rec1.md', route: 'foley-meetings' }) }));
    expect(outcome.status).toBe('skipped');
    expect(outcome.steer).toBeUndefined();
  });

  it('surfaces a recording still being prepared as a retryable failure, not a silent skip', async () => {
    mockPlaud({ id: 'rec1', name: 'x', duration: 2580, presigned_url: undefined });
    await expect(run(ctx())).rejects.toThrow(/being prepared/);
  });
});
