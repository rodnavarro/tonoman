// One run of the drop watcher is ONE drop: file its page, and hand back the words to be said exactly
// as they are (docs/definition/objects/drop-watch.md in Tonoman Cloud). Looking at the site is the
// runtime's, which holds the login; the Talent never sees it (DROPS-LOGIN-SEALED).
import { describe, it, expect, vi } from 'vitest';
import type { TalentContext } from '../../../talent-sdk';
import { run } from './run';
import type { Campaign } from './drop';

const drop: Campaign = {
  id: 'abc-123',
  type: 'DROP',
  name: 'Absolut Repair Molecular Serum',
  status: 'Active',
  end_date: '2026-09-30T23:59:00Z',
  initial_qty: 250,
  claimed_qty: 210,
  max_claimed: 1,
  sub_brands: [{ id: 'b1', name: "L'Oréal Professionnel" }],
};

function ctx(item: string, found: Campaign | undefined, page: () => Promise<unknown> = async () => ({ filed: true, path: 'x', brain: "Stef's brain" })) {
  const lorealistarDrop = vi.fn(async () => (found ? { drop: found, seen: '2026-09-20T13:05:00.000Z' } : { drop: undefined }));
  const filePage = vi.fn(page);
  const c = {
    input: { item, config: {}, user: 'USTEF' },
    creds: {},
    credential: vi.fn(),
    cap: { transcribe: vi.fn(), infer: vi.fn(), publish: vi.fn(), calendarCandidates: vi.fn(), calendarEvents: vi.fn(), page: filePage, lorealistarDrop },
    progress: vi.fn(),
    log: vi.fn(),
  } as unknown as TalentContext;
  return { c, lorealistarDrop, filePage };
}

describe('drop-watch run', () => {
  it("DROPS-NEW-IS-TOLD-AT-ONCE a new drop is said in the site's own figures, to be posted exactly as written — never reworded by the agent", async () => {
    const { c, lorealistarDrop } = ctx('drop-abc-123', drop);
    const out = await run(c);
    expect(lorealistarDrop).toHaveBeenCalledWith({ id: 'abc-123' });
    expect(out.status).toBe('done');
    expect(out.say).toContain('Absolut Repair Molecular Serum');
    expect(out.say).toContain("L'Oréal Professionnel");
    expect(out.say).toContain('40 of 250 left');
    expect(out.say).toContain('2026-09-30');
    expect(out.say).toContain('https://us.lorealistar.com/activities/drop/abc-123');
    // Said as given, so nothing is handed to the agent to put in its own words.
    expect(out.steer).toBeUndefined();
  });

  it('DROPS-A-PAGE-EACH the drop becomes a page in the brain the run is pointed at: what it was, when it was seen, its figures then', async () => {
    const { c, filePage } = ctx('drop-abc-123', drop);
    await run(c);
    const filed = filePage.mock.calls[0]![0] as { path: string; content: string; note: string };
    expect(filed.path).toBe('Drops/2026-09-20-absolut-repair-molecular-serum-abc-123.md');
    expect(filed.content).toContain('40 of 250 left');
    expect(filed.note).toMatch(/drop/i);
  });

  it('DROPS-NEW-IS-TOLD-AT-ONCE a page that could not be filed does not keep the person from being told', async () => {
    const { c } = ctx('drop-abc-123', drop, async () => {
      throw new Error('no brain to file into');
    });
    const out = await run(c);
    expect(out.status).toBe('done');
    expect(out.say).toContain('40 of 250 left');
    expect(out.summary).toMatch(/not filed/i);
  });

  it('DROPS-ONLY-LOOKS it says where to claim it and claims nothing: the only things it asks of the runtime are the drop and a page', async () => {
    const { c } = ctx('drop-abc-123', drop);
    await run(c);
    for (const [name, fn] of Object.entries(c.cap)) if (!['page', 'lorealistarDrop'].includes(name)) expect(fn).not.toHaveBeenCalled();
    expect(c.credential).not.toHaveBeenCalled();
  });

  it('DROPS-TOLD-ONCE a drop the runtime no longer has — already gone from the site — is skipped, not announced from memory', async () => {
    const { c } = ctx('drop-gone', undefined);
    const out = await run(c);
    expect(out.status).toBe('skipped');
    expect(out.say).toBeUndefined();
  });
});
