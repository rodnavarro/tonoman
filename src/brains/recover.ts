// Finishing the writes a restart interrupted (BRAIN-WRITE-SURVIVES-RESTART).
//
// Every write is journaled before it touches git. At start, each unfinished one is either found on
// the remote (it landed: say so), found absent (redo it — but only if the person may still write
// there), or unknowable because the remote cannot be reached (leave it for the next start: redoing a
// write that did land would say it twice). The person is told the outcome privately, by DM.

import type { BrainRef, BrainStore } from "./store";
import type { BrainsRegistry } from "./broker";

export interface RecoverDeps {
  store: Pick<BrainStore, "interrupted" | "settle" | "write" | "cleanup">;
  registry: Pick<BrainsRegistry, "reach">;
  /** Tell a person something privately. False if it could not be sent. */
  tell(agentGuid: string, slackUserId: string, text: string): Promise<boolean>;
  log?: (s: string) => void;
}

interface Entry {
  brain: BrainRef;
  path: string;
  content: string;
  baseBlob: string | null;
  note: string;
  who: string;
  notify: { agentGuid?: string; slackUserId?: string } | null;
}

export async function recoverWrites(d: RecoverDeps): Promise<{ landed: number; redone: number; abandoned: number; waiting: number }> {
  const log = d.log ?? ((s: string) => console.log(s));
  const out = { landed: 0, redone: 0, abandoned: 0, waiting: 0 };
  await d.store.cleanup().catch(() => {});
  for (const it of await d.store.interrupted()) {
    const e = it.entry as unknown as Entry;
    const who = e.notify?.agentGuid && e.notify?.slackUserId ? { agent: e.notify.agentGuid, user: e.notify.slackUserId } : undefined;
    const tell = async (text: string) => (who ? d.tell(who.agent, who.user, text).catch(() => false) : false);
    if (it.landed === "unknown") {
      out.waiting++;
      continue;
    }
    if (it.landed === "yes") {
      await d.store.settle(it.id, "pushed");
      await tell(`The note you asked me to save, \`${e.path}\`, is saved — I was restarted just as it went through.`);
      out.landed++;
      continue;
    }
    const reach = who ? await d.registry.reach(who.agent, who.user).catch(() => null) : null;
    const allowed = reach?.brains.some((b) => b.id === e.brain.id && b.mode === "write") ?? false;
    if (!allowed) {
      await d.store.settle(it.id, "abandoned", "access changed before it could be saved");
      await tell(`I could not finish saving \`${e.path}\` after a restart: you can no longer write to that brain. Nothing was saved.`);
      out.abandoned++;
      continue;
    }
    const r = await d.store.write({
      brain: e.brain,
      path: e.path,
      content: e.content,
      baseBlob: e.baseBlob,
      note: e.note,
      who: e.who,
      notify: e.notify ?? undefined,
      authorize: async () => {
        const now = await d.registry.reach(who!.agent, who!.user);
        return now.brains.some((b) => b.id === e.brain.id && b.mode === "write");
      },
    });
    await d.store.settle(it.id, r.ok ? "pushed" : "failed", r.ok ? undefined : r.detail);
    await tell(r.ok ? `After a restart, I finished saving \`${e.path}\`.` : `After a restart, I could not save \`${e.path}\`: ${r.detail}.`);
    if (r.ok) out.redone++;
    else out.abandoned++;
  }
  if (out.landed + out.redone + out.abandoned + out.waiting) log(`brains: recovery — ${JSON.stringify(out)}`);
  return out;
}
