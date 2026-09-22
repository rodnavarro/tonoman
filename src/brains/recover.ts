// Finishing the writes a restart interrupted (BRAIN-WRITE-SURVIVES-RESTART).
//
// Every write is journaled before it touches git. At start, each unfinished one is either found on
// the remote (it landed: say so), found absent (redo it — but only if the person may still write
// there), or unknowable because the remote cannot be reached (leave it for the next start: redoing a
// write that did land would say it twice). The person is told the outcome privately, by DM.

import type { BrainRef, BrainStore } from "./store";
import type { BrainsRegistry } from "./broker";
import { planReceipt, type CheckedReceipt } from "../receipts/receipts";

export interface RecoverDeps {
  store: Pick<BrainStore, "interrupted" | "settle" | "write" | "cleanup"> & Partial<Pick<BrainStore, "writeFiles">>;
  registry: Pick<BrainsRegistry, "reach"> & {
    reachUnattended?(agentGuid: string, forSlackUserId: string | null): Promise<{ brains: { id: string; mode: string }[] }>;
  };
  /** Tell a person something privately. False if it could not be sent. */
  tell(agentGuid: string, slackUserId: string, text: string): Promise<boolean>;
  log?: (s: string) => void;
}

interface Entry {
  kind?: "files" | "planned";
  /** A planned write's own way back (a receipt: what was checked, and the photo's bytes). */
  recover?: { receipt?: CheckedReceipt; bytes?: string } | null;
  /** The refresh writing its own files. */
  system?: boolean;
  files?: { path: string; content: string }[];
  brain: BrainRef;
  path: string;
  content: string;
  baseBlob: string | null;
  note: string;
  who: string;
  notify: { agentGuid?: string; slackUserId?: string; unattended?: boolean } | null;
}

export async function recoverWrites(d: RecoverDeps): Promise<{ landed: number; redone: number; abandoned: number; waiting: number }> {
  const log = d.log ?? ((s: string) => console.log(s));
  const out = { landed: 0, redone: 0, abandoned: 0, waiting: 0 };
  await d.store.cleanup().catch(() => {});
  for (const it of await d.store.interrupted()) {
    const e = it.entry as unknown as Entry;
    if (e.kind === "files" && e.files?.length) e.path = e.files[0].path;
    // A receipt has no path or content of its own: it is worked out again from the brain as it is
    // now (RECEIPT-FILED-MEANS-PUSHED). A planned write that is not a receipt cannot be redone.
    const receipt = e.kind === "planned" ? e.recover?.receipt : undefined;
    const bytes = e.kind === "planned" && e.recover?.bytes ? Buffer.from(e.recover.bytes, "base64") : undefined;
    const what = receipt ? `the receipt from ${receipt.vendor} for $${receipt.amount}` : `\`${e.path}\``;
    const who = e.notify?.agentGuid && e.notify?.slackUserId ? { agent: e.notify.agentGuid, user: e.notify.slackUserId } : undefined;
    const tell = async (text: string) => (who ? d.tell(who.agent, who.user, text).catch(() => false) : false);
    if (it.landed === "unknown") {
      out.waiting++;
      continue;
    }
    if (it.landed === "yes") {
      await d.store.settle(it.id, "pushed");
      await tell(receipt ? `${what[0]!.toUpperCase()}${what.slice(1)} is filed — I was restarted just as it went through.` : `The note you asked me to save, ${what}, is saved — I was restarted just as it went through.`);
      out.landed++;
      continue;
    }
    // The refresh's own map is not finished here: it is worked out again from the brain as it is now,
    // by the refresh the queue carries over a restart. Pushing an old one could land on newer pages.
    if (e.system) {
      await d.store.settle(it.id, "abandoned", "the refresh runs again after the restart");
      continue;
    }
    // A Talent's filing is re-checked against what the RUN may reach; a person's note against theirs.
    const reachNow = async () =>
      e.notify?.unattended && d.registry.reachUnattended
        ? d.registry.reachUnattended(who!.agent, who!.user)
        : d.registry.reach(who!.agent, who!.user);
    const reach = who ? await reachNow().catch(() => null) : null;
    const allowed = reach?.brains.some((b) => b.id === e.brain.id && b.mode === "write") ?? false;
    if (!allowed) {
      await d.store.settle(it.id, "abandoned", "access changed before it could be saved");
      await tell(`I could not finish ${receipt ? "filing" : "saving"} ${what} after a restart: you can no longer write to that brain. Nothing was saved.`);
      out.abandoned++;
      continue;
    }
    const authorize = async () => (await reachNow()).brains.some((b) => b.id === e.brain.id && b.mode === "write");
    if (e.kind === "planned" && !(receipt && bytes && d.store.writeFiles)) {
      await d.store.settle(it.id, "failed", "nothing to work it out again from");
      await tell("After a restart, I could not finish something I was filing for you. Send it again, please.");
      out.abandoned++;
      continue;
    }
    const r =
      receipt && bytes && d.store.writeFiles
        ? await d.store.writeFiles({ brain: e.brain, files: [], plan: (tree) => planReceipt(receipt, bytes, tree), subject: receipt.subject, recover: e.recover ?? undefined, note: e.note, who: e.who, notify: e.notify ?? undefined, authorize })
        : e.kind === "files" && e.files && d.store.writeFiles
        ? await d.store.writeFiles({ brain: e.brain, files: e.files, note: e.note, who: e.who, notify: e.notify ?? undefined, authorize })
        : await d.store.write({ brain: e.brain, path: e.path, content: e.content, baseBlob: e.baseBlob, note: e.note, who: e.who, notify: e.notify ?? undefined, authorize });
    await d.store.settle(it.id, r.ok ? "pushed" : "failed", r.ok ? undefined : r.detail);
    await tell(r.ok ? `After a restart, I finished ${receipt ? "filing" : "saving"} ${what}.` : `After a restart, I could not ${receipt ? "file" : "save"} ${what}: ${r.detail}.`);
    if (r.ok) out.redone++;
    else out.abandoned++;
  }
  if (out.landed + out.redone + out.abandoned + out.waiting) log(`brains: recovery — ${JSON.stringify(out)}`);
  return out;
}
