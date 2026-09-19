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
  store: Pick<BrainStore, "read" | "writeFiles">,
  target: { brain: BrainRef; who: string; authorize: () => Promise<boolean>; agentGuid?: string },
  f: RecapFiling,
): Promise<{ result: FilesResult; page: string; transcript: string; route: string }> {
  const route = recap.resolveRoute(f.journal, f.recap.route);
  const hint = recap.recapSlugHint(f.recap);
  let where = recap.pathsFor(f.journal, f.rec, route, hint, undefined, f.recap.meeting);
  const there = await store.read(target.brain, where.page);
  // Another recording already has this minute's name: file beside it, not over it.
  if (there && !recap.isSameRecording(recap.identityOf(there.content), f.rec)) {
    where = recap.pathsFor(f.journal, f.rec, route, hint, recordingKey(f.rec.id).slice(0, 8), f.recap.meeting);
  }
  const page = recap.overviewMarkdown(f.rec, { ...f.recap, route }, where.folder, f.candidates ?? [], f.by ?? [], f.timezone ?? "UTC", f.owner);
  const transcript = `# Transcript — ${f.rec.title}\n\nTranscribed by ${recap.transcribedBy(f.by ?? [])} from the Plaud recording.\n\n---\n\n${f.transcript}\n`;
  const result = await store.writeFiles({
    brain: target.brain,
    files: [
      { path: where.page, content: page },
      { path: `${where.folder}/Transcript.md`, content: transcript },
    ],
    note: `Meeting recap: ${f.rec.title} (${f.rec.stamp})`,
    who: target.who,
    authorize: target.authorize,
    // A restart finishes this against what the RUN may reach (the agent's grants and the person's),
    // and tells the person it was for.
    notify: target.agentGuid ? { agentGuid: target.agentGuid, slackUserId: target.who, unattended: true } : undefined,
  });
  return { result, page: where.page, transcript: `${where.folder}/Transcript.md`, route };
}
