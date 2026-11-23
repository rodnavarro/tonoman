// The meeting-recap skill as a prompt (D-JOBS-ARE-PROMPTS in Tonoman Cloud). A new recording is not
// processed by code that then tells the agent what happened: the agent is asked to recap it, on the
// person's behalf, exactly as that person could ask in a DM — and it does the work with the tools the
// skill brings (`tonoman plaud`, `tonoman calendar`, `tonoman meeting-recap file`). What stays code is
// what must not be left to judgement: finding new recordings (the poll), checking a recap before it is
// filed (the file tool), and seeing that it was filed (the run's post hook).
//
// The rules below are the ones the recap prompt always carried; they now reach the agent itself.

export interface RecapJob {
  /** The copy's keyword: `meeting-recap`, or a second copy's own. */
  copy: string;
  id: string;
  title: string;
  startedAt: number;
  minutes: number;
  /** The Plaud login, by label; "mine" is the person's own. */
  login: string;
  /** This copy's calendars, by label; empty = whatever the person may read. */
  calendars: string[];
  journal?: { routes: { id: string; when: string }[]; fallback: string };
  mission?: string;
  vocab?: string;
}

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** PURE: the prompt a recording's run sends the agent. */
export function recapJobPrompt(j: RecapJob): string {
  const login = j.login && j.login !== "mine" ? ` --login ${q(j.login)}` : "";
  const cals = j.calendars.length ? ` --calendars ${q(j.calendars.join(","))}` : "";
  const copy = j.copy && j.copy !== "meeting-recap" ? ` --copy ${j.copy}` : "";
  const start = new Date(j.startedAt).toISOString();
  const end = new Date(j.startedAt + j.minutes * 60_000).toISOString();
  const rules: string[] = [
    "The recap is plain text in this layout (one label per line; a list is one `- ` line per item, `- (none)` when empty): `Summary:` 2 to 4 sentences · `Highlights:` at most 5 one-line items · `Decisions:` · `Follow-ups:` · `Participants:` the people who clearly took part, by name as the transcript gives them.",
    "Be specific and factual. Never invent a name, number, decision or commitment. If something is unclear in the transcript, leave it out rather than guess.",
    "Add `Meeting:` the calendar entry this recording is, its title EXACTLY as the calendar gave it, or leave it empty when the transcript does not clearly match one — empty is a correct and common answer; a wrong match renames the meeting and files it into a series it does not belong to. Add `Meeting reason:` one short sentence naming what decided it.",
  ];
  if (j.journal) {
    rules.push(
      `Decide where it is filed: add \`Route:\` exactly one of ${j.journal.routes.map((r) => `${r.id} (${r.when})`).join(", ")}; if none clearly fits, ${j.journal.fallback} — a wrong confident guess is worse, because somebody reviews that folder and nobody reviews a misfiled meeting. Add \`Route reason:\` one short sentence.`,
    );
  }
  if (j.mission) {
    rules.push(
      `The person whose meeting this is describes what they are trying to do as: "${j.mission}". Treat it as a statement about attention, not topics. Add \`Alignment:\` advances, neutral or detracts — detracts is normal for a meeting that reached no decision, re-answered a settled question or belonged in a message. Add \`Alignment reason:\` one sentence. Do not flatter.`,
    );
  }
  if (j.vocab) rules.push(`The transcriber mishears these names: ${j.vocab}. Where the transcript clearly means one, spell it correctly — spelling only, never what was said.`);

  return [
    `Run ${j.copy} on a new recording: ${q(j.title)}, ${j.minutes} minute${j.minutes === 1 ? "" : "s"}, recorded ${start}.`,
    "",
    `1. Read it: \`tonoman plaud transcript --id ${j.id}${login}\`. If it is not a meeting to file (no speech, a test press, a few stray words), stop there: close it with \`tonoman meeting-recap skip --id ${j.id}${login}${copy} --reason "<why, in a few words>"\` and tell them in one line. Without the skip it is asked about again.`,
    `2. See which meeting it was: \`tonoman calendar find --from ${start} --to ${end}${cals}\`.`,
    `3. File the recap, as plain text on standard input (never JSON — the shell refuses braces with quotes): \`tonoman meeting-recap file --id ${j.id}${login}${copy} <<'RECAP'\` then the recap's lines, then a line \`RECAP\`. If it is refused, fix what it says and file it again.`,
    ...rules.map((r) => `   ${r}`),
    "4. Then write them a short message: it is ready, where it was filed, and the three most useful things from it in your own words; offer to answer questions about it.",
  ].join("\n");
}

/** PURE: the nudge when a run's turn ended without filing (the post hook's one retry). */
export function recapNudge(j: Pick<RecapJob, "copy" | "id" | "title" | "login">): string {
  const login = j.login && j.login !== "mine" ? ` --login ${q(j.login)}` : "";
  const copy = j.copy && j.copy !== "meeting-recap" ? ` --copy ${j.copy}` : "";
  return `The recap of ${q(j.title)} is not filed yet. File it now: \`tonoman meeting-recap file --id ${j.id}${login}${copy} <<'RECAP'\` with the recap as plain text (Summary:, Highlights:, Decisions:, Follow-ups:, Participants:, Meeting: …) and a closing line \`RECAP\` — never JSON — then tell them it is ready. If it is not a meeting to file (no speech, a test press, a few stray words), close it instead with \`tonoman meeting-recap skip --id ${j.id}${login}${copy} --reason "<why>"\` and say nothing more: they were already told.`;
}
