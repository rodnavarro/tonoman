import type { TalentRun, CalendarCandidate } from '../../../talent-sdk';

// The Plaud Talent's run — the proven voice pipeline, now a self-contained CLI that imports ONLY the
// SDK. Ported from the worker's processRecording: fetch the recording from Plaud (the Talent's own
// credential), transcribe it (capability), summarise it against the tenant mission (capability,
// Talent-owned prompt), file it in the second brain (capability), and REPORT — the Talent does not
// speak; it returns a `steer` the agent uses to announce in its own words.
//
// The Plaud client, the recap prompt, and the result parsing live here because they are this
// Talent's domain. The transcription provider chain, the model routing, the git second brain, and
// the calendar feed resolution are the runtime's, reached through ctx.cap.

// --- Types the Talent owns (it cannot import worker internals) -----------------------------------

interface Journal {
  path: string;
  routes: { id: string; when: string }[];
  fallback: string;
}

interface Recap {
  summary: string;
  highlights: string[];
  decisions: string[];
  followups: string[];
  route?: string;
  routeReason?: string;
  meeting?: string;
  meetingReason?: string;
  alignment?: string;
  alignmentReason?: string;
  participants?: string[];
  participantsFrom?: 'calendar' | 'transcript';
}

const ALIGNMENTS = ['advances', 'neutral', 'detracts'] as const;

// --- Plaud client (CLI/OAuth path) — the credential plane hands over a resolved bearer + base -----

interface PlaudAccess {
  token?: string;
  base?: string;
}
interface PlaudRecording {
  id: string;
  title: string;
  startTime: number;
  duration: number;
  stamp: string;
  audioUrl: string;
}

// Plaud's `start_at` is an ISO STRING ("2026-09-07T03:10:46.379000"), often without a timezone;
// `created_at`/number forms may be epoch seconds or ms. Parse both exactly as the runtime does — a
// naive Number() on the ISO string yields NaN and files every recap at 1970.
const toMs = (v: string | number | undefined): number => {
  if (!v) return 0;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const t = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? t : 0;
};

/** `YYYY-MM-DD-HHMM` in UTC — the folder-per-recording name, stable so re-processing is a no-op. */
const stampFor = (startMs: number): string => {
  const d = new Date(startMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.toISOString().slice(0, 10)}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};

async function fetchRecording(access: PlaudAccess, id: string): Promise<PlaudRecording> {
  const res = await fetch(`${access.base}/open/third-party/files/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${access.token ?? ''}`, accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) throw new Error('plaud: the connected account is no longer authorized');
  if (!res.ok) throw new Error(`plaud: file ${id} → ${res.status}`);
  const f = (await res.json()) as {
    id: string;
    name?: string;
    start_at?: string | number;
    created_at?: string | number;
    duration?: number;
    presigned_url?: string;
  };
  if (!f.presigned_url) {
    // Their own client distinguishes these: a recording still syncing will have a URL shortly; one
    // that never had audio never will.
    throw new Error(
      f.duration ? 'plaud: the audio is still being prepared — it will be there on the next poll' : 'plaud: this recording has no audio',
    );
  }
  const startTime = toMs(f.start_at ?? f.created_at);
  return {
    id: f.id,
    title: (f.name ?? '').trim().replace(/\.[a-z0-9]+$/i, '') || stampFor(startTime),
    startTime,
    duration: f.duration ?? 0,
    stamp: stampFor(startTime),
    audioUrl: f.presigned_url,
  };
}

// --- The recap prompt — this Talent's wording, built from runtime-provided values -----------------

function buildRecapPrompt(
  transcript: string,
  title: string,
  journal: Journal | undefined,
  candidates: CalendarCandidate[],
  mission: string,
  vocab: string,
): { system: string; user: string } {
  const routing = journal
    ? [
        `Also decide where this meeting is filed. Choose exactly one "route" from this list:`,
        journal.routes.map((r) => `"${r.id}" — ${r.when}`).join(' | '),
        `If none clearly fits, or the transcript does not say enough to be sure, answer "${journal.fallback}".`,
        `A wrong confident guess is worse than "${journal.fallback}": somebody reviews that folder, and nobody reviews a misfiled meeting.`,
        `Add "route" (one of the ids above) and "routeReason" (one short sentence) to the JSON.`,
      ].join(' ')
    : '';
  const calendaring = candidates.length
    ? [
        'A calendar shows these entries around the time of this recording.',
        'Decide which ONE the recording actually is:',
        candidates
          .map((c, i) => `${i + 1}. "${c.summary}"${c.attendees.length ? ` — with ${c.attendees.slice(0, 6).join(', ')}` : ''}`)
          .join(' | '),
        'Add "meeting" to the JSON: the chosen entry\'s text EXACTLY as written above, or "" if the transcript does not clearly match any of them.',
        '"" is a correct and common answer — people record things that are not on a calendar, and a wrong match renames the meeting and files it into a series it does not belong to.',
        'Also add "meetingReason": one short sentence naming what in the transcript decided it.',
      ].join(' ')
    : '';
  const aligning = mission
    ? [
        `The person whose meeting this is describes what they are trying to do as: "${mission}".`,
        'Treat that as a statement about ATTENTION, not about topics. It does not mean meetings on other subjects are unimportant; it means their attention is the scarce resource, and the question is whether this meeting bought progress or spent the capacity to make progress.',
        `Add "alignment" to the JSON, exactly one of: ${ALIGNMENTS.join(' | ')}.`,
        '"detracts" is a normal and expected answer. Use it when the meeting reached no decision, re-answered a question already settled, or covered something that belonged in a message — however pleasant or productive it felt.',
        '"neutral" is for a meeting that neither moved this forward nor cost anything worth naming.',
        'Also add "alignmentReason": ONE short sentence naming what in the transcript decided it.',
        'Do not flatter. Do not look for a way to connect the meeting to the goal. If the honest answer is that this was an hour that bought nothing, say so.',
      ].join(' ')
    : '';
  const spelling = vocab
    ? [
        `The transcriber mishears these names: ${vocab}.`,
        'Where the transcript clearly means one of them, use the correct spelling in your answer.',
        'Spelling only — never change what was said or what it meant.',
      ].join(' ')
    : '';
  const system = [
    'You summarise a recorded business meeting for a searchable knowledge base.',
    'Be specific and factual. Never invent a name, number, decision or commitment.',
    'If something is unclear in the transcript, leave it out rather than guessing.',
    'Reply with STRICT JSON only: {"summary": string, "highlights": string[], "decisions": string[], "followups": string[], "participants": string[]}.',
    'summary: 2-4 sentences. highlights: at most 5, each one line. decisions/followups may be empty.',
    'participants: the people who clearly took part, by name as the transcript gives it; empty when nobody is named.',
    routing,
    calendaring,
    aligning,
    spelling,
  ]
    .filter(Boolean)
    .join(' ');
  return { system, user: `Meeting: ${title}\n\nTranscript:\n${transcript}` };
}

function parseRecapJson(text: string): Recap {
  const shapes: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) shapes.push(fenced[1].trim());
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open >= 0 && close > open) shapes.push(text.slice(open, close + 1));
  for (const shape of shapes) {
    try {
      return JSON.parse(shape) as Recap;
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(`summarize: the model did not return JSON — ${text.slice(0, 200)}`);
}

function resolveAlignment(proposed: string | undefined): string {
  const v = (proposed ?? '').trim().toLowerCase();
  return (ALIGNMENTS as readonly string[]).includes(v) ? v : '';
}

/** The model may only claim a meeting it was shown — a hallucinated name files the recap into a
 *  series it does not belong to. */
export function resolveMeeting(candidates: CalendarCandidate[], proposed: string | undefined): CalendarCandidate | undefined {
  // Case- and space-tolerant, like the worker's: the model echoing "api team standup" for
  // "API Team Standup" is the same meeting, and an exact comparison dropped the match.
  const want = (proposed ?? '').trim().toLowerCase();
  if (!want) return undefined;
  return candidates.find((c) => c.summary.trim().toLowerCase() === want);
}

/** PURE: what a calendar match changes, as the original pipeline did.
 *
 *  - The meeting is the entry's own title (a closed set: only an entry the model was shown).
 *  - Its attendees ARE the participants — the calendar is authoritative, the transcript a guess.
 *  - Its calendar decides the route when the tenant said so (`calendar.route.<alias>`): a meeting on
 *    the Globex calendar is a Globex meeting, whatever the model inferred from the talk. */
export function applyCalendarMatch(
  recap: Recap,
  candidates: CalendarCandidate[],
  calendarRoutes: Record<string, string> = {},
): Recap {
  const matched = resolveMeeting(candidates, recap.meeting);
  const out: Recap = { ...recap, meeting: matched?.summary ?? '' };
  if (matched && matched.attendees.length) {
    out.participants = matched.attendees;
    out.participantsFrom = 'calendar';
  } else if (out.participants?.length) {
    out.participantsFrom = 'transcript';
  }
  const routed = matched?.source ? calendarRoutes[matched.source.alias] : undefined;
  if (routed) {
    out.route = routed;
    out.routeReason = `on the ${matched!.source!.alias} calendar as “${matched!.summary}”`;
  }
  return out;
}

// --- The run -------------------------------------------------------------------------------------

export const run: TalentRun = async (ctx) => {
  const { item, context } = ctx.input;
  const mission = String(context?.mission ?? '');
  const journal = context?.journal as Journal | undefined;
  const vocab = String(context?.vocab ?? '');

  const access = (await ctx.credential('plaud')) as PlaudAccess;

  ctx.progress('fetching recording');
  const rec = await fetchRecording(access, item);

  ctx.progress('transcribing');
  const { text, by } = await ctx.cap.transcribe({ audioUrl: rec.audioUrl, label: rec.title, cacheId: rec.id, vocab });
  // A recording with no speech in it is not a meeting to file: summarising silence produces a
  // confident page about nothing. Left unpublished so a provider that can hear it picks it up later.
  if (!text.trim()) return { status: 'skipped', reason: 'no speech in the recording' };

  ctx.progress('reading calendar');
  const candidates = await ctx.cap.calendarCandidates({ from: rec.startTime, to: rec.startTime + rec.duration });

  ctx.progress('summarising');
  const prompt = buildRecapPrompt(text, rec.title, journal, candidates, mission, vocab);
  const calendarRoutes = (context?.calendarRoutes as Record<string, string> | undefined) ?? {};
  const recap = applyCalendarMatch(parseRecapJson((await ctx.cap.infer(prompt)).text), candidates, calendarRoutes);
  recap.alignment = resolveAlignment(recap.alignment);
  if (!recap.alignment) recap.alignmentReason = undefined;

  ctx.progress('filing');
  const filed = await ctx.cap.publish({
    rec: { id: rec.id, title: rec.title, startTime: rec.startTime, duration: rec.duration, stamp: rec.stamp },
    recap,
    transcript: text,
    candidates,
    by,
  });
  // Already present means another run got there first — skip the announcement, do not file twice.
  if (!filed.published) return { status: 'skipped', reason: `already filed at ${filed.path}` };

  // Report, don't speak: the agent announces in its own words from this steer. Same wording the live
  // pipeline used, minus the channel — the wrapper runs it as a real turn so follow-ups land in the
  // same conversation.
  const top = (recap.highlights ?? []).slice(0, 3);
  const steer =
    `A recording has just finished processing and is filed in the second brain at ${filed.path}: ` +
    `“${rec.title}”. Write a short message telling them it is ready and giving the three most useful ` +
    `things from it, in your own words, then offer to answer questions about it. ` +
    `The three: ${top.map((h, i) => `(${i + 1}) ${h}`).join(' ')}`;

  return {
    status: 'done',
    summary: `Filed “${rec.title}” at ${filed.path}${filed.route ? ` (route ${filed.route})` : ''}, transcribed by ${by.join(' + ') || 'cache'}.`,
    steer,
  };
};
