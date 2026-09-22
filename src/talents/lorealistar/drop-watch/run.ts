import type { TalentContext, TalentOutcome } from '../../../talent-sdk';
import { dropLine, dropPage } from './drop';

// One run is ONE drop (docs/definition/objects/drop-watch.md in Tonoman Cloud). Looking at the site
// is the runtime's: it holds the person's login and tells this Talent only what the site said about
// the drop (DROPS-LOGIN-SEALED). The Talent files the drop's page and hands back the words — the
// site's own figures — to be said exactly as written (TALENT-FIGURES-SAID-AS-GIVEN). It claims nothing
// (DROPS-ONLY-LOOKS).
export async function run(ctx: TalentContext): Promise<TalentOutcome> {
  const id = ctx.input.item.replace(/^drop-/, '');
  const { drop, seen } = await ctx.cap.lorealistarDrop({ id });
  // Gone from the site since it was seen: nothing is announced from memory.
  if (!drop) return { status: 'skipped', reason: `the drop ${id} is no longer listed` };

  const page = dropPage(drop, seen ? new Date(seen) : new Date());
  let filed = true;
  try {
    await ctx.cap.page({ path: page.path, content: page.content, note: `LOREALISTAR drop: ${drop.name}` });
  } catch (e) {
    // The page is the record; the telling is the point. One failing does not stop the other.
    filed = false;
    ctx.log(`the drop's page was not filed: ${String((e as Error)?.message ?? e)}`);
  }
  return {
    status: 'done',
    say: dropLine(drop),
    summary: `New drop: ${drop.name}${filed ? '' : ' (its page was not filed)'}`,
  };
}
