// A Talent filing into a brain (BRAIN-TALENT-TARGET): the meeting recap's page and transcript, in the
// brain the run is pointed at, as one commit with its log line.
//
// Naming is the recap's own (`pathsFor`), so a page lands where it would have in the second brain; the
// only difference is that "is this name taken, and by which recording?" is asked of the brain's pushed
// state rather than of a checkout on disk.

import * as recap from "../worker/recap";
import type { CalEvent } from "../worker/calendar";
import { recordingKey } from "../worker/recordingkey";
import type { BrainRef, BrainStore, FilesResult } from "./store";

export interface RecapFiling {
  rec: recap.Recording;
  recap: recap.Recap;
  transcript: string;
  journal?: recap.Journal;
  candidates?: CalEvent[];
  by?: string[];
  timezone?: string;
  owner?: string;
}

export async function publishRecapToBrain(
  store: Pick<BrainStore, "writeFiles">,
  target: { brain: BrainRef; who: string; authorize: () => Promise<boolean>; agentGuid?: string },
  f: RecapFiling,
): Promise<{ result: FilesResult; page: string; transcript: string; route: string }> {
  const route = recap.resolveRoute(f.journal, f.recap.route);
  const hint = recap.recapSlugHint(f.recap);
  // Whether a name is free is asked INSIDE the store's serialized push, on the pushed tip, every
  // attempt: two recordings of the same minute filed at once must not both take one name. The one
  // that finds it held by another recording files beside it, under its own recording key.
  const mine = (existing: string) => recap.isSameRecording(recap.identityOf(existing), f.rec);
  const file = async (disambiguator?: string) => {
    const where = recap.pathsFor(f.journal, f.rec, route, hint, disambiguator, f.recap.meeting);
    const page = recap.overviewMarkdown(f.rec, { ...f.recap, route }, where.folder, f.candidates ?? [], f.by ?? [], f.timezone ?? "UTC", f.owner);
    const transcript = `# Transcript — ${f.rec.title}\n\nTranscribed by ${recap.transcribedBy(f.by ?? [])} from the Plaud recording.\n\n---\n\n${f.transcript}\n`;
    const result = await store.writeFiles({
      brain: target.brain,
      files: [
        { path: where.page, content: page },
        { path: `${where.folder}/Transcript.md`, content: transcript },
      ],
      claim: { path: where.page, mine },
      note: `Meeting recap: ${f.rec.title} (${f.rec.stamp})`,
      who: target.who,
      authorize: target.authorize,
      // A restart finishes this against what the RUN may reach (the agent's grants and the person's),
      // and tells the person it was for.
      notify: target.agentGuid ? { agentGuid: target.agentGuid, slackUserId: target.who, unattended: true } : undefined,
    });
    return { result, page: where.page, transcript: `${where.folder}/Transcript.md`, route };
  };
  const first = await file();
  if (first.result.ok || first.result.reason !== "taken") return first;
  return file(recordingKey(f.rec.id).slice(0, 8));
}
