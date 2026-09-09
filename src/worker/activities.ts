// The turn, as a Temporal activity.
//
// It reuses the runtime that already exists rather than reimplementing it: the harness Runner
// spawns `claude` and yields TurnEvents, and the connector's Reply posts and edits in the channel.
// The activity is the thin thing between them — which is the point, because a durable turn should
// not be a second implementation of a turn.
//
// The activity does the posting rather than returning text for the caller to post. That is what
// makes streaming survive the split: the process running the model is the process holding the
// channel credential, so a partial answer reaches the person as it is produced, and a cancellation
// leaves that partial visible and labelled rather than vanishing.

import { Context } from "@temporalio/activity";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Connector, Reply, TurnEvent, TurnUsage } from "../core/contracts";
import type { AgentConfig } from "../config";
import * as recap from "./recap";
import * as inference from "./inference";
import * as skill from "./skill";
import * as calendar from "./calendar";
import * as worklog from "./worklog";
import { randomMysticVerb } from "../core/mystic";

/** How the worker finds an agent's connector and runner. Injected at worker construction so this
 *  module holds no globals and can be unit-tested without Temporal. */
export interface TurnDeps {
  agent(name: string): { cfg: AgentConfig; conn: Connector; context?: string; run: (req: TurnRunReq, signal?: AbortSignal) => AsyncIterable<TurnEvent> } | undefined;
  /** What this agent needs to run the voice flow, or undefined if it is not configured for one. */
  voice?(name: string): VoiceConfig | undefined;
  /** Say something verbatim to a person, opening a DM if needed. */
  say?(agent: string, user: string, text: string): Promise<void>;
  /** The durable record of one item of one skill: opened before the first step, closed either way.
   *
   *  Behind a hook rather than a direct database call for the same reason everything else here is:
   *  the worker holds no connection string. It asks the registry, over the same system-token API it
   *  already uses for the roster. */
  skillRun?: {
    open(agent: string, skill: string, itemKey: string, version: number): Promise<void>;
    close(agent: string, skill: string, itemKey: string, status: "done" | "failed", error?: string): Promise<void>;
  };
  /** Run text as a turn addressed to a person. */
  ask?(agent: string, user: string, text: string): Promise<void>;
  /** The display-only status footer for a finished turn: the model, the turn's tokens, context
   *  occupancy, and how much of the Claude plan's 5h/7d windows is left. Null for none. */
  footer?(agent: string, conversation: string, usage: TurnUsage | undefined): Promise<string | null>;
  /** Remember the turn's usage, so `!status` can report it later without spending a turn. */
  recordUsage?(conversation: string, usage: TurnUsage): void;
  /** The model this conversation is set to, if it has chosen one.
   *
   *  Per CONVERSATION. The harness's own model knob is per process, so one worker serving two
   *  people meant `!model opus` in one thread silently moved everybody else too — which is what
   *  happened the first time two users shared this worker. */
  modelFor?(conversation: string): string | undefined;
  /** The harness session this conversation continues in, MARKED AS IN USE by the act of asking.
   *
   *  Without one, every message is a fresh `claude` run: the agent answers a question perfectly and
   *  then cannot remember it thirty seconds later ("I don't have anything above this to convert —
   *  this looks like the start of our conversation"). The window is not re-sent on stdin because
   *  the harness holds it; only the new message rides in the prompt.
   *
   *  Claiming rather than peeking is what keeps `--session-id` to exactly one use per id, which is
   *  its contract. Every later turn resumes, and the one way that can be wrong — no session on disk
   *  — is the one case `resetSession` below repairs. */
  claimSession?(agent: string, conversation: string): Promise<{ id: string; isNew: boolean }>;
  /** Abandon this conversation's session and hand back a fresh one. The resume-miss repair, and
   *  what `!new` does. */
  resetSession?(agent: string, conversation: string): Promise<{ id: string; isNew: boolean }>;
}

/** PURE: the text of a transcript value, whichever shape it arrived in. */
function transcriptText(v: unknown): string {
  if (typeof v === "string") return v;
  const t = (v as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
}

/** PURE: who transcribed it, for the page to state. Empty when the value predates provenance or
 *  every chunk came from a cache that records none — which `transcribedBy` then says out loud
 *  rather than guessing at. */
function transcribedByOf(v: unknown): string[] {
  const by = (v as { by?: unknown } | null)?.by;
  return Array.isArray(by) ? (by as string[]) : [];
}

/** LARGE VALUES TRAVEL BY REFERENCE.
 *
 *  A 42,000-character transcript through workflow state runs into Temporal's payload limits —
 *  warned past 256KB, refused past 2MB — and an eighty-eight-minute meeting is 55,000 characters
 *  before anything else is in the bag. Inlining works perfectly on a five-minute recording and
 *  breaks on a long one, which is the kind of thing that must be settled rather than discovered.
 *
 *  So a big value is written beside the chunk cache and the bag carries a pointer. Small ones stay
 *  inline, because a pointer to eleven characters is just a slower eleven characters. */
async function maybeRef(value: string, v: VoiceConfig, name: string): Promise<unknown> {
  if (!skill.tooBigToInline(value) || !v.chunkCacheDir) return value;
  const at = path.join(v.chunkCacheDir, "refs", `${name}.txt`);
  await fs.mkdir(path.dirname(at), { recursive: true });
  await fs.writeFile(at, value, "utf8");
  return { $ref: at, bytes: value.length } satisfies skill.Ref;
}

/** The other half: a step is handed VALUES, never pointers. Resolving here rather than in the
 *  workflow is what keeps the workflow free of a filesystem it is not allowed to touch. */
async function resolveRefs(seen: skill.Bag, _v: VoiceConfig): Promise<skill.Bag> {
  // A reference that cannot be read is a REAL failure, not an empty string: the alternative is
  // summarising a meeting from nothing and publishing the result as if it were the meeting.
  const one = async (value: unknown): Promise<unknown> => {
    if (skill.isRef(value)) return await fs.readFile(value.$ref, "utf8");
    // ONE level of nesting, so a value can carry its own provenance — `{ text, by }` is the honest
    // shape for a transcript, since WHO transcribed it is a fact about that text and travels with
    // it. Not arbitrary depth: a general graph walk would be a serialisation format, and this
    // language deliberately does not have one.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        inner[k] = skill.isRef(v) ? await fs.readFile(v.$ref, "utf8") : v;
      }
      return inner;
    }
    return value;
  };
  const out: skill.Bag = {};
  for (const [k, value] of Object.entries(seen)) out[k] = await one(value);
  return out;
}

/** Keep an activity's heartbeat alive on a TIMER while `work` runs.
 *
 *  WHY A TIMER AND NOT MORE CALLS. `heartbeatTimeout` is how long Temporal waits before declaring
 *  an activity dead, and the only heartbeats during a transcription fired BETWEEN chunks — so the
 *  real gap was the wall time of ONE 600-second chunk. That made a liveness timeout into an
 *  accidental throughput limit: a slower provider, or one busy machine, and a perfectly healthy
 *  transcription is killed and started again from the beginning.
 *
 *  It mattered less while a single fast cloud provider bounded the gap. It stops being an
 *  abstraction the moment any local server is in the list, because the gap becomes a property of
 *  somebody's hardware. With this, progress reporting and liveness go back to being separate
 *  things: `onProgress` still says how far along we are, and the heartbeat says the worker is
 *  alive — which is the only question the timeout was ever asking.
 *
 *  `note()` is read at each tick rather than captured, so the heartbeat carries the CURRENT step
 *  and a stalled activity says which chunk it stalled on. */
async function beating<T>(note: () => string, work: () => Promise<T>): Promise<T> {
  const ctx = Context.current();
  const timer = setInterval(() => {
    // Never let the keep-alive be what fails the activity: outside an activity context, or once
    // cancellation has begun, heartbeating throws and the real work is still fine.
    try {
      ctx.heartbeat(note());
    } catch {
      /* the work below is what matters */
    }
  }, 15_000);
  // `unref` so a pending timer can never hold the worker process open at shutdown.
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export interface VoiceConfig {
  /** Where this agent's recaps are announced: a Slack channel id.
   *
   *  A property of the FLOW, per agent, not of the worker — one worker runs every agent a tenant
   *  has, and "which channel does Nelly post recaps to" is a different question for each of them.
   *  Empty falls back to a DM with `notify`, which works but makes it impossible to tell from the
   *  outside whether a recap went to Rod or to Celine.
   *
   *  Belongs in the agent's registry row; it arrives from the environment until that column
   *  exists, which is why it is shaped like configuration rather than read from `process.env`
   *  where it is used. */
  notifyChannel?: string;
  creds: recap.PlaudCreds;
  /** The second-brain checkout the recap is written into. */
  brainDir: string;
  /** Push URL carrying the credential — used for one command, never left on disk. */
  pushUrl: string;
  /** Who transcribes, in order of preference. A LIST because one key was three separate
   *  impossibilities: no tenant could bring its own transcription, a rotated key killed every
   *  meeting while a working spare sat unused, and there was nowhere to put a local server. */
  transcribe: inference.Provider[];
  /** Who summarises. A SEPARATE list, because it is a different job with a different constraint:
   *  the transcription tier's 8000-token context cannot summarise a 62-minute meeting at any
   *  price, and that is a fact about the summariser, not about the audio. */
  summarize: inference.Provider[];
  /** What the TENANT is trying to do — one sentence, from the registry, shared by every agent the
   *  tenant has. Empty means this flow does not judge, which is the ordinary state until somebody
   *  writes one. */
  mission?: string;
  vocab: string;
  /** Where a half-finished transcription keeps the chunks it already paid for, so a retry resumes.
   *  On the volume rather than in memory, because the thing being survived is a process that died
   *  or a quota that will not reset for hours. */
  chunkCacheDir?: string;
  /** Where meetings are filed, when this flow classifies them. Absent = the flat `Meetings/`
   *  layout, which is what a tenant with no folder scheme wants. */
  journal?: recap.Journal;
  /** How often the poll looks, from the registry. */
  pollSeconds?: number;
  /** Who a DM would go to, when no channel is configured. */
  notifyUser?: string;
  /** Epoch ms before which a recording is none of our business. Without it the first poll
   *  backfills the customer's entire Plaud history and announces each one as if it had just
   *  happened. */
  floorMs: number;
  /** Calendars this agent may read, URLs already resolved from the secret store. Empty is the
   *  ordinary state and costs nothing: the flow behaves exactly as it did before calendars. */
  calendars?: calendar.CalendarFeed[];
  /** Titles that are blocks rather than meetings — "Focus Time", "Lunch". From the registry. */
  calendarExclude?: string[];
  /** How far either side of a recording to look. Generous by default; see calendar.ts. */
  calendarPadMinutes?: number;
}

export interface TurnRunReq {
  prompt: string;
  systemPromptFile?: string;
  /** The model for THIS turn. Per conversation, never per process — see `modelFor`. */
  model?: string;
  /** The harness session to run in, so the agent remembers the rest of the thread. */
  sessionId?: string;
  /** true = create it (`--session-id`); false = continue it (`--resume`). */
  sessionNew?: boolean;
}

export interface TurnInput {
  agent: string;
  conversation: string;
  channel: string;
  text: string;
  user: string;
  /** The previous turn was steered away mid-answer, so say so rather than pretending continuity. */
  afterInterruption?: boolean;
}

export interface NoticeInput {
  agent: string;
  conversation: string;
  channel: string;
  text: string;
}

/** Slack rate-limits an edit to roughly one call per second per channel, and a burst 429s the whole
 *  stream. Editing slower than the model produces is the correct trade. */
const EDIT_INTERVAL_MS = 1200;

/** How often the work log re-renders.
 *
 *  Not one second, even though the Teams version counted in seconds: the tick makes TWO Slack calls
 *  (a message edit and a status set), and at 1s that sits exactly on the per-channel edit limit — a
 *  429 there would take the answer's own stream down with it, in front of whoever is watching. Two
 *  and a half seconds still reads as a live clock.
 *
 *  It doubles as the delay before the log appears at all, which is deliberate: a turn that answers
 *  straight from the model in two seconds leaves no trace, and only real work gets narrated. */
const TICK_MS = 2500;

/** The work log's cadence while the ANSWER is streaming. Slower, because the answer's own message
 *  is being edited on EDIT_INTERVAL_MS at the same time and they share one per-channel budget. The
 *  clock stepping every five seconds still reads as running; two writers at one second each does
 *  not read at all, because one of them gets a 429. */
const ANSWERING_TICK_MS = 5000;

/** One turn at a time per conversation.
 *
 *  Temporal's default activity cancellation is TRY_CANCEL: when a new message steers a turn, the
 *  WORKFLOW moves straight on to the next one without waiting for this activity to unwind. With a
 *  harness session that is not merely untidy — turn N+1 opens `--resume` on the same session file
 *  that turn N is still writing, and two `claude` processes appending to one transcript is how a
 *  remembered conversation becomes a corrupted one.
 *
 *  Chained rather than rejected, because the second message is a correction the person is waiting
 *  on, not a duplicate to drop. The wait is short: the steered turn is aborted through the run
 *  signal, so its child is killed rather than left to finish. */
export function serializer(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    // `then(fn, fn)` — the next turn runs whether the previous one answered or threw. A failed
    // turn that wedged the lock would silence the conversation for good.
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export function makeActivities(deps: TurnDeps) {
  const serialize = serializer();
  return {
    async runTurn(input: TurnInput): Promise<void> {
      return serialize(`${input.agent}/${input.conversation}`, () => oneTurn(deps, input));
    },


    async postNotice(input: NoticeInput): Promise<void> {
      const found = deps.agent(input.agent);
      if (!found) return;
      const reply = found.conn.reply(input.conversation);
      // Clear the working cue first, because the commonest reason this notice exists is that the
      // turn which set that cue is no longer running to clear it itself — a pod replaced during a
      // deploy, an activity that lost its heartbeat. Slack disables the composer while a status is
      // set, so without this the person is told something went wrong in a thread they can no
      // longer type in, which is a worse place to leave them than the error was.
      //
      // Best-effort and before the message: an unclearable cue is the part that traps them.
      await reply.settle?.().catch(() => {});
      await reply.send(input.text);
    },

    // --- the voice flow -------------------------------------------------------------------------

    /** Which finished recordings have not been published yet. Cheap and safe to retry. */
    async findNewRecordings(input: { agent: string }): Promise<
      { id: string; title: string; stamp: string; minutes: number }[]
    > {
      const v = deps.voice?.(input.agent);
      if (!v) return [];
      const all = await recap.listRecordings(v.creds, 20);
      const fresh = await recap.unpublished(all, v.brainDir, v.floorMs, v.journal);
      return fresh.map((r) => ({
        id: r.id,
        title: r.title,
        stamp: r.stamp,
        minutes: Math.max(1, Math.round(r.duration / 60000)),
      }));
    },

    /** Download, transcribe, summarise, publish, push — then ask the agent to say what it found.
     *
     *  Everything up to the push is idempotent by path: re-running lands on the same folder and
     *  commits nothing. The notification is last, so a failure anywhere before it means the person
     *  is told about a failure rather than promised a recap that does not exist. */
    async processRecording(input: { agent: string; notify: string; id: string }): Promise<void> {
      const ctx = Context.current();
      const v = deps.voice?.(input.agent);
      if (!v) throw new Error(`no voice configuration for ${input.agent}`);

      const all = await recap.listRecordings(v.creds, 50);
      const rec = all.find((r) => r.id === input.id);
      if (!rec) throw new Error(`recording ${input.id} is no longer listed`);
      // Checked again here, not only at selection: a workflow run that queued a list of recordings
      // before the floor existed would otherwise keep working through it across a redeploy, which
      // is the difference between "fixed" and "fixed for the next poll".
      if (rec.startTime < v.floorMs) {
        console.log(`recap: skipping ${rec.title} — before the floor`);
        return;
      }
      // And re-check publication, for the same reason: a queued list is a snapshot, and the same
      // recording was summarised three times because each run of the list re-derived a slightly
      // different summary and so had something to commit. `publish` cannot catch this — a changed
      // summary IS a change.
      if ((await recap.unpublished([rec], v.brainDir, v.floorMs, v.journal)).length === 0) {
        console.log(`recap: skipping ${rec.title} — already published`);
        return;
      }

      ctx.heartbeat("transcribing");
      // Per chunk, not per recording: a long meeting is many uploads, and a heartbeat only at the
      // start would let Temporal declare a perfectly healthy transcription dead halfway through.
      let note = "transcribing";
      const { text, seconds, by } = await beating(
        () => note,
        () =>
          recap.transcribe(
            v.creds,
            rec,
            v.transcribe,
            v.vocab,
            (done, total) => {
              note = `transcribing ${done}/${total}`;
              ctx.heartbeat(note);
            },
            v.chunkCacheDir,
          ),
      );
      console.log(
        `recap: ${rec.title} transcribed in ${seconds.toFixed(1)}s, ${text.length} chars` +
          (by.length ? ` by ${by.join(" + ")}` : " (every chunk came from a previous attempt)"),
      );

      // A RECORDING WITH NO SPEECH IN IT IS NOT A MEETING TO FILE.
      //
      // Summarising nothing does not fail — it produces a confident page explaining that the
      // meeting contained no substantive discussion, filed under `unclassified`, indistinguishable
      // from a real recap of a bad meeting. That is worse than no page at all: it is a knowledge
      // base entry asserting something about an hour of somebody's life, derived from silence.
      //
      // Left UNPUBLISHED on purpose, so it is picked up again if a provider that can hear it is
      // added later — `unpublished()` answers from the checkout, so nothing is written and nothing
      // is forgotten.
      if (!text.trim()) {
        console.log(`recap: ${rec.title} — every provider transcribed silence; not publishing`);
        // Said verbatim rather than through a turn: the sentence is already known, and the person
        // was told two minutes ago that this recording was being processed. Silence here would read
        // as the pipeline having lost it.
        await deps
          .say?.(
            input.agent,
            input.notify,
            `I couldn't get any speech out of “${rec.title}” — every transcriber returned nothing, so I've left it unprocessed rather than file a recap made out of silence.`,
          )
          .catch(() => {});
        return;
      }

      // What was on the calendar around this recording. Gathered BEFORE summarising because the
      // candidates ride that same call — content decides which meeting this was, and it can only
      // decide between things it has been shown.
      let candidates: calendar.CalEvent[] = [];
      if (v.calendars?.length) {
        ctx.heartbeat("reading calendars");
        const w = calendar.windowFor(rec.startTime, rec.startTime + rec.duration, v.calendarPadMinutes);
        candidates = await calendar.gather(v.calendars, w.from, w.to, {
          exclude: v.calendarExclude,
          log: (m) => console.log(m),
        });
        console.log(
          `recap: ${rec.title} — ${candidates.length} calendar candidate(s) from ${v.calendars.length} feed(s)`,
        );
      }

      ctx.heartbeat("summarising");
      const summary = await beating(
        () => "summarising",
        () => recap.summarize(text, rec.title, v.summarize, v.journal, candidates, v.mission, v.vocab),
      );
      // The model may only claim a meeting it was shown. Anything else is no match — a
      // hallucinated meeting name looks entirely correct and files the recap into a series it does
      // not belong to.
      const matched = recap.resolveMeeting(candidates, summary.meeting);
      summary.meeting = matched?.summary ?? "";

      ctx.heartbeat("publishing");
      const route = recap.resolveRoute(v.journal, summary.route);
      // A matched meeting names the file. Plaud names an untitled recording after its own clock,
      // and `2026-09-07-0310-api-team-standup.md` is the difference between a knowledge base
      // somebody can search and one they cannot.
      const where = recap.pathsFor(
        v.journal,
        rec,
        route,
        summary.meeting || summary.highlights?.[0] || summary.summary,
      );
      const published = await recap.publish(v.brainDir, rec, summary, text, v.pushUrl, v.journal, candidates, by);
      console.log(
        `recap: ${rec.title} ${published ? "published" : "already present"} at ${where.page}` +
          (route ? ` (route ${route}${summary.route && summary.route !== route ? `, model said "${summary.route}"` : ""})` : "") +
          (candidates.length ? ` [calendar: ${summary.meeting ? `matched "${summary.meeting}"` : "no match"}]` : ""),
      );
      // The transcript is in the second brain now, so the saved chunks have nothing left to
      // protect and become one more copy of a customer's meeting sitting on a volume.
      if (v.chunkCacheDir) await recap.clearChunkCache(v.chunkCacheDir, rec);
      if (!published) return; // somebody else got there first; do not announce it twice

      // A real turn, so the agent says it in its own words and can be asked follow-ups in the same
      // conversation. The three highlights are handed over rather than re-derived.
      const top = (summary.highlights ?? []).slice(0, 3);
      await deps.ask?.(
        input.agent,
        input.notify,
        `A recording has just finished processing and is filed in the second brain at ` +
          `${where.page}: “${rec.title}”. Write a short message telling them it is ready ` +
          `and giving the three most useful things from it, in your own words, then offer to answer ` +
          `questions about it. The three: ${top.map((h, i) => `(${i + 1}) ${h}`).join(" ")}`,
      );
    },

    /** Open — or re-open — the durable record for one item of one skill.
     *
     *  This is the record whose absence produced 611 attempts for 4 published recaps. "Not published
     *  yet" and "failing every two minutes for ten hours" were the same state, because the only
     *  durable fact was whether a file existed in a git checkout — a check that can answer "is it
     *  done" and can never answer "is it being worked on, or failing". */
    async openSkillRun(input: { agent: string; skill: string; itemKey: string; version: number }): Promise<void> {
      await deps.skillRun?.open(input.agent, input.skill, input.itemKey, input.version);
    },

    /** Close it, either way. The FAILED case is the one that matters: it is what makes "this
     *  recording has been failing all day" something a person can see without reading a log. */
    async closeSkillRun(input: {
      agent: string;
      skill: string;
      itemKey: string;
      status: "done" | "failed";
      error?: string;
    }): Promise<void> {
      await deps.skillRun?.close(input.agent, input.skill, input.itemKey, input.status, input.error);
    },

    /** ONE STEP of a skill, whichever kind it is.
     *
     *  THE REGISTRY IS HERE, in the worker, and a `tool` step names a verb in it rather than a
     *  command line. A step that shelled out to a CLI would need a tenant credential inside the
     *  agent's shell — and the agent is a language model with a shell. Today the worker resolves
     *  credentials and hands the harness RESULTS, never secrets; keeping that is worth more than the
     *  reuse. A CLI becomes a thin shell over this same registry the day something outside the
     *  worker genuinely needs to invoke a step.
     *
     *  The workflow driving this knows nothing about what any verb means, which is exactly what lets
     *  a tenant reorder or drop steps without a deploy. */
    async runStep(input: {
      agent: string;
      skill: string;
      itemKey: string;
      notify: string;
      step: skill.Step;
      bag: skill.Bag;
    }): Promise<unknown> {
      const ctx = Context.current();
      const v = deps.voice?.(input.agent);
      if (!v) throw new Error(`no voice configuration for ${input.agent}`);
      const step = input.step;
      // A step sees what it DECLARED, not the whole bag. Resolved on this side rather than in the
      // workflow so a large value can travel through workflow state as a reference and be read back
      // here, where a filesystem exists.
      const seen = await resolveRefs(skill.visibleTo(step, input.bag), v);

      const recording = async (): Promise<recap.Recording> => {
        const all = await recap.listRecordings(v.creds, 50);
        const found = all.find((r) => r.id === input.itemKey || r.stamp === input.itemKey);
        if (!found) throw new Error(`recording ${input.itemKey} is no longer listed`);
        return found;
      };

      if (skill.isInfer(step)) {
        // INFERENCE PRODUCES VALUES; CODE DECIDES WHAT HAPPENS TO THEM. The row names WHICH prompt;
        // the runtime owns its text. The answer is checked against the declared schema, because a
        // response that does not conform has to fail the step — that is the difference between a
        // value and a claim.
        if (step.infer.prompt !== "recap-vs-mission") {
          throw new Error(`unknown prompt "${step.infer.prompt}" — a skill names a prompt, it does not carry one`);
        }
        if (step.infer.schema !== "Recap") throw new Error(`unknown schema "${step.infer.schema}"`);
        const transcript = transcriptText(seen.transcript);
        if (!transcript.trim()) return { $stop: true, why: "nothing was transcribed" };
        const r = await recording();
        const answer = await beating(
          () => "summarising",
          () =>
            recap.summarize(
              transcript,
              r.title,
              v.summarize,
              v.journal,
              (seen.candidates as calendar.CalEvent[]) ?? [],
              String(seen.mission ?? ""),
              v.vocab,
            ),
        );
        if (typeof answer?.summary !== "string") throw new Error("the model's answer did not match the Recap schema");
        return answer;
      }

      switch (step.tool) {
        case "transcript get": {
          const r = await recording();
          let note = "transcribing";
          const { text, by } = await beating(
            () => note,
            () =>
              recap.transcribe(
                v.creds,
                r,
                v.transcribe,
                v.vocab,
                (done, total) => {
                  note = `transcribing ${done}/${total}`;
                  ctx.heartbeat(note);
                },
                v.chunkCacheDir,
              ),
          );
          // A recording nothing can hear is not a meeting to file — and it is not an error either.
          if (!text.trim()) return { $stop: true, why: "every provider transcribed silence" };
          // `by` travels WITH the text rather than beside it. Who transcribed a transcript is a
          // fact about that transcript, and the page states it — so splitting them would need a
          // second `out` and would let a recap claim a provider that served a different run.
          return { text: await maybeRef(text, v, `${r.id}-transcript`), by };
        }
        case "calendar candidates": {
          // Empty when nothing is connected, which is NOT a failure. This is what `optional` means
          // in the definition, and the calendars are the case that proves the distinction is real.
          if (!v.calendars?.length) return [];
          const r = await recording();
          const w = calendar.windowFor(r.startTime, r.startTime + r.duration, v.calendarPadMinutes);
          return await calendar.gather(v.calendars, w.from, w.to, {
            exclude: v.calendarExclude,
            log: (m) => console.log(m),
          });
        }
        // No account argument, deliberately: the credential IS the tenant, so an agent cannot ask for
        // anybody else's. Empty is a normal state — no mission, no alignment line, still a recap.
        case "mission get":
          return v.mission ?? "";
        case "brain publish": {
          const r = await recording();
          const summary = seen.recap as recap.Recap | undefined;
          if (!summary?.summary) throw new Error("brain publish was given no recap to publish");
          const transcript = transcriptText(seen.transcript);
          const candidates = (seen.candidates as calendar.CalEvent[]) ?? [];
          // The model may only claim a meeting it was SHOWN. A hallucinated meeting name looks
          // entirely correct and files the recap into a series it does not belong to.
          summary.meeting = recap.resolveMeeting(candidates, summary.meeting)?.summary ?? "";
          const route = recap.resolveRoute(v.journal, summary.route);
          const where = recap.pathsFor(v.journal, r, route, summary.highlights?.[0] ?? summary.summary);
          // ONE tool that writes, commits AND pushes, reporting the outcome of all three. Splitting
          // them would create a state where the agent believes it published and the remote has
          // nothing — the same class of failure as trusting the model to call the step at all.
          const published = await recap.publish(
            v.brainDir,
            r,
            summary,
            transcript,
            v.pushUrl,
            v.journal,
            candidates,
            transcribedByOf(seen.transcript),
          );
          if (v.chunkCacheDir) await recap.clearChunkCache(v.chunkCacheDir, r);
          console.log(`skill: ${r.title} ${published ? "published" : "already present"} at ${where.page}`);
          return { published, page: where.page };
        }
        case "say": {
          const done = seen.published as { published?: boolean; page?: string } | undefined;
          // Nothing new to announce is not a failure — somebody else got there first, and saying it
          // twice is worse than not saying it.
          if (!done?.published) return null;
          const summary = seen.recap as recap.Recap | undefined;
          const top = (summary?.highlights ?? []).slice(0, 3);
          const r = await recording();
          await deps.ask?.(
            input.agent,
            input.notify,
            `A recording has just finished processing and is filed in the second brain at ` +
              `${done.page}: "${r.title}". Write a short message telling them it is ready ` +
              `and giving the three most useful things from it, in your own words, then offer to answer ` +
              `questions about it. The three: ${top.map((h, i) => `(${i + 1}) ${h}`).join(" ")}`,
          );
          return null;
        }
        default:
          // A verb nothing implements is a BROKEN DEFINITION, not a step to skip. Skipping would
          // publish a recap with a piece silently missing, which is the failure mode this whole
          // layer exists to stop.
          throw new Error(`unknown tool "${step.tool}" — the runtime has no verb by that name`);
      }
    },

    /** Say something verbatim to a person, opening a DM if needed. Used for the acknowledgement and
     *  for failures, where spending an LLM turn to relay a known sentence is waste. */
    async sayVerbatim(input: {
      agent: string;
      user: string;
      text: string;
      /** Say this at most once in that many minutes. For a notice raised by something that RETRIES:
       *  a poll on a two-minute schedule reporting a dead credential says it thirty times an hour,
       *  which is thirty notifications for one fact the person can only act on once. */
      onceMinutes?: number;
    }): Promise<void> {
      if (input.onceMinutes) {
        // Keyed on the TEXT, not on "this is the poll warning": a DIFFERENT reason must still be
        // heard. The goal is not to go quiet, it is not to repeat an identical sentence.
        const key = `${input.agent} :: ${input.text}`;
        const at = lastSaid.get(key) ?? 0;
        if (Date.now() - at < input.onceMinutes * 60_000) return;
        lastSaid.set(key, Date.now());
      }
      await deps.say?.(input.agent, input.user, input.text);
    },
  };
}

/** When each distinct notice was last said. In memory deliberately: the worst a restart costs is
 *  one repeated warning, and the alternative is persisting a fact that stops being true the moment
 *  somebody reconnects. */
const lastSaid = new Map<string, number>();

export type Activities = ReturnType<typeof makeActivities>;


/** One turn, start to finish. Split out of the activity so the serializer above owns exactly
 *  one thing — when a turn may run — and this owns what a turn IS. */
async function oneTurn(deps: TurnDeps, input: TurnInput): Promise<void> {
    const ctx = Context.current();
    const found = deps.agent(input.agent);
    if (!found) throw new Error(`worker: no agent "${input.agent}" in the roster`);
    const { conn, run } = found;

    const reply: Reply = conn.reply(input.conversation);
    // One verb for the whole turn, picked before the first cue. Re-picking mid-turn would read
    // as a different agent taking over the answer.
    const verb = randomMysticVerb();
    // The status line IS the immediate cue — "Nelly is thinking…" under the composer. A
    // placeholder MESSAGE posted alongside it is worse than nothing: it flashes "…" and is then
    // overwritten, which reads as a glitch. So no message is posted until there is something real
    // to put in it, and the work log below is a separate note rather than the answer's message.
    await reply.working?.(worklog.statusFor(undefined, verb)).catch(() => {});

    const started = Date.now();
    let answer = "";
    let usage: TurnUsage | undefined;
    let lastEdit = 0;
    let done = false;
    /** Created on first render, not up front. Empty until then. */
    let msgId = "";
    const show = async (text: string): Promise<void> => {
      if (!msgId) msgId = await reply.send(text);
      else await reply.update(msgId, text);
    };

    // --- the work log ---------------------------------------------------------------------
    // Teams parity, and the thing that was missing: which tools ran, and how long the agent has
    // been at it. It lives in its own note above the answer and is driven by a TIMER rather than
    // by events — a turn that greps the second brain for ten seconds emits one event, and a line
    // that does not move is indistinguishable from being stuck.
    const calls: worklog.ToolCall[] = [];
    let current: worklog.ToolCall | undefined;
    let noteId = "";
    let noteText = "";
    /** One note write at a time. Without this the FIRST write is still in flight (a post is
     *  ~300ms) while a second tool event fires a second tick: `noteId` is still empty, so that
     *  tick posts a SECOND note, and whichever resolves last wins the id — leaving the other
     *  stranded in the channel forever as "⚙️ Working… 1s". Two tool events inside one post
     *  latency is not a corner case; it is what any turn that greps the second brain looks like. */
    let posting = false;
    let lastTick = 0;
    const tick = async (): Promise<void> => {
      if (done || ctx.cancellationSignal.aborted) return;
      if (posting) return;
      // Once the answer is streaming, do not CREATE a note: it would post below the reply and
      // read as a footnote. But an EXISTING one keeps ticking — freezing it is what made the
      // clock sit at "2s" for a whole answer and then land on "Moonwalked for 14 seconds", which
      // reads as a jump rather than as time passing.
      if (answer && !noteId) return;
      // Tool events call this directly, so the timer is not the only rate limiter. Each tick is
      // a message edit AND a status set; ten tool calls in two seconds would be twenty Slack
      // calls, which is the burst TICK_MS exists to avoid. While the answer is streaming it is
      // ALSO editing its own message roughly every second, so the log backs off to share the
      // channel's budget rather than race it.
      const now = Date.now();
      if (now - lastTick < (answer ? ANSWERING_TICK_MS : EDIT_INTERVAL_MS)) return;
      lastTick = now;
      posting = true;
      try {
        const elapsed = now - started;
        const text = worklog.liveNote(calls, elapsed, verb);
        if (text !== noteText) {
          noteText = text;
          noteId = (await reply.note?.(noteId || undefined, text)) ?? "";
        }
        // Checked AGAIN, after the note write. The guard at the top of this function was true
        // when the tick started, and a note post takes ~300ms — long enough for the turn to end
        // and settle the cue in between. Setting the status after that leaves "Sapien is
        // working…" under the composer of a thread that has already answered, and nothing ever
        // clears it: `working` and `settle` are the same Slack call, so the last writer wins.
        if (done || ctx.cancellationSignal.aborted) return;
        await reply.working?.(worklog.statusFor(current, verb)).catch(() => {});
      } catch {
        /* a dropped work log must never cost a turn */
      } finally {
        posting = false;
      }
    };
    /** The tick currently in flight, so the end of the turn can wait for it rather than race it.
     *  The re-check above closes the window on its own; this closes it without depending on when
     *  the scheduler resumes a suspended tick. */
    let inflight: Promise<void> = Promise.resolve();
    const runTick = (): Promise<void> => (inflight = tick());
    const ticker = setInterval(() => void runTick(), TICK_MS);
    /** Take down the live cue for good: stop the timer, let any tick already running finish, and
     *  only then clear the status. Every path out of a turn goes through here — answered, failed
     *  or interrupted — because a status line that outlives its turn is the one artefact a person
     *  cannot dismiss themselves. */
    const settleCue = async (): Promise<void> => {
      clearInterval(ticker);
      await inflight.catch(() => {});
      await reply.settle?.().catch(() => {});
    };
    /** Remove the log entirely — for an interrupted turn, whose work nobody will see the result
     *  of, so a trace of it left on screen is only confusing. */
    const dropLog = (): void => {
      clearInterval(ticker);
      if (noteId) void reply.note?.(noteId, null).catch(() => {});
    };

    // Temporal cancels the scope when a new message arrives. Leave the partial visible and say
    // what happened — a reply that silently stops looks like a broken bot.
    ctx.cancelled.catch(() => {
      if (done) return;
      dropLog();
      void reply.settle?.().catch(() => {});
      // Only if something was already on screen. An interrupted turn that had not yet said
      // anything should leave no trace — the correction is about to be answered instead.
      if (!msgId) return;
      void reply
        .finalize(msgId, `${answer.trim()}\n\n_— interrupted; working on your new message_`)
        .catch(() => {});
    });

    // What the agent can read, and who is asking. Without the first the second brain is present
    // on disk but the model has no reason to look at it; without the second "Hi Celine" is a
    // guess rather than a fact from the registry.
    // Who is asking, from the registry — never guessed from a display name, which is spoofable.
    const known = (found.cfg.principals ?? []).find(
      (p) => p.kind === "slack_user_id" && p.value === input.user,
    );
    const parts = [
      found.context ?? "",
      known
        ? `You are speaking with ${known.label}.`
        : input.user
          ? `You are speaking with someone you don't recognise (${input.user}); ask who they are before sharing anything specific.`
          // No sender at all means a system notification, not an unknown person. Treating it as
          // a stranger made the agent refuse to discuss the meeting it had just been handed.
          : "This turn was started by the system, not by a person. Write it as a message to the person in this conversation.",
      input.afterInterruption
        ? "(your previous answer was interrupted by a new message; continue from what the user now says)"
        : "",
      // The runtime is not evidence about the person.
      //
      // Asked who it was speaking to, the agent inspected its own environment, found the
      // operator's account email, and told a customer it looked like a mismatch. It was being
      // honest — and it was reporting infrastructure as if it were a fact about them. The
      // platform is the only authority on identity; everything else in this container belongs to
      // whoever runs the service.
      "You are running on shared platform infrastructure. Its account, credentials, environment " +
        "and file paths say nothing about who you are talking to, and are not yours to inspect " +
        "or mention. Identity comes only from what you are told above. If that is missing, ask " +
        "the person — never infer it from the machine.",
    ].filter(Boolean);
    const preamble = parts.length ? `${parts.join("\n\n")}\n\n` : "";

    // The session this thread continues in. Claimed, not peeked at: `--session-id` creates and
    // may be used once, every later turn resumes, and the one thing that can go wrong with that —
    // no session on disk to resume — is repaired below rather than left to fail forever.
    let session = await deps.claimSession?.(input.agent, input.conversation);

    const consume = async (): Promise<void> => {
      for await (const ev of run(
        {
          prompt: `${preamble}${input.text}`,
          systemPromptFile: found.cfg.system_prompt_file,
          model: deps.modelFor?.(input.conversation),
          sessionId: session?.id,
          sessionNew: session?.isNew,
        },
        // Passing the signal is what makes a steer actually stop the model. Without it the child
        // ran to completion after the person had already moved on — paid for, unread, and still
        // holding the session file the next turn wants to resume.
        ctx.cancellationSignal,
      )) {
        if (ctx.cancellationSignal.aborted) return;
        if (ev.kind === "text" && ev.text) {
          answer += ev.text;
          const now = Date.now();
          if (now - lastEdit >= EDIT_INTERVAL_MS && answer.trim()) {
            lastEdit = now;
            await show(answer).catch(() => {});
          }
        } else if (ev.kind === "tool") {
          // Recorded for the work log, and mirrored into the status line straight away so the
          // cue changes the moment a tool starts rather than on the next tick.
          current = { tool: ev.tool ?? "working", detail: ev.text };
          calls.push(current);
          if (!answer) await runTick();
        } else if (ev.kind === "done") {
          // The authoritative text. A harness that streams deltas AND sends a final would
          // otherwise leave whatever the last edit happened to catch; one that only sends a final
          // would otherwise post nothing at all.
          if (ev.final) answer = ev.final;
          // The turn's own tokens — what the status footer and `!status` report.
          if (ev.usage) usage = ev.usage;
        } else if (ev.kind === "error" && ev.err) {
          throw ev.err;
        }
        // Heartbeat on real progress, so a wedged model is detected quickly but a slow one is not
        // killed for being slow.
        ctx.heartbeat(answer.length);
      }
    };

    try {
      try {
        // KEPT ALIVE ON A TIMER while the model thinks.
        //
        // The stream heartbeats on every event, which reads like enough and is not: between events
        // there IS no event, and a model that has just been handed a 79,000-character transcript
        // reasons for well over the heartbeat timeout before emitting its next token. Temporal then
        // declares a perfectly healthy turn dead, and the person is told their question failed.
        //
        // That happened on a real question about a 112-minute meeting: two tool calls, a large Read,
        // and the activity timed out sixty seconds in — with 38 of its 40 turns unused, so it looked
        // like a model problem rather than a liveness one.
        //
        // Same fix as `transcribe` and `summarize`, and the same lesson: the heartbeat's job is to
        // detect a dead WORKER, not to police how long thinking takes. The stream events still
        // report real progress on top of this.
        await beating(() => `thinking (${answer.length} chars so far)`, consume);
      } catch (e) {
        // A session that cannot be resumed is a lost memory, not a failed turn.
        //
        // The pod holds both halves of this — the id in memory, the transcript on its disk — so
        // they are normally lost together. Normally: a turn killed mid-write, or a `claude` that
        // never got far enough to create the file, leaves an id pointing at nothing, and every
        // future turn in that thread would then fail on the same missing file. Amnesia is a bad
        // day; a thread that answers nothing ever again is a broken agent.
        //
        // Only when the turn produced NOTHING, which is what a resume miss looks like — it fails
        // at startup, before a token. A turn that broke halfway through said something first, and
        // re-running it would say it twice.
        const produced = answer.trim().length > 0 || calls.length > 0;
        if (!session || produced || ctx.cancellationSignal.aborted) throw e;
        console.error(
          `worker: ${input.agent} could not resume session ${session.id} ` +
            `(${String((e as Error)?.message ?? e).slice(0, 140)}); starting a fresh one`,
        );
        session = await deps.resetSession?.(input.agent, input.conversation);
        await reply.reset?.().catch(() => {});
        await consume();
      }
    } catch (e) {
      // A failed turn still owes the person a finished-looking channel. Without this the ⚠️ the
      // workflow posts lands UNDER a stale "⚙️ Working…" note, and "Nelly is thinking…" stays
      // under the composer for good — the turn reads as still running, forever.
      dropLog();
      await settleCue();
      throw e;
    } finally {
      clearInterval(ticker);
    }

    done = true;
    if (usage) deps.recordUsage?.(input.conversation, usage);
    // Slack leaves "is thinking…" on screen until it is cleared, so an answered turn that
    // forgets this looks permanently busy.
    await settleCue();
    if (ctx.cancellationSignal.aborted) {
      dropLog();
      return;
    }

    // Settle the work log into one line of what the turn actually did, or take it down when
    // there is nothing worth keeping above the answer.
    if (noteId) {
      const settled = worklog.settledNote(calls, Date.now() - started, verb);
      await reply.note?.(noteId, settled).catch(() => {});
    }

    const footer = await deps.footer?.(input.agent, input.conversation, usage).catch(() => null);
    const body = answer.trim() || "_(no answer)_";
    // ONE blank line. This was three newlines - two blank lines - on the reasoning that the footer
    // is metadata rather than the last paragraph of the answer, and so wanted visible separation.
    // In Slack it reads as detached instead: a stray line floating below the message, far enough
    // away that it stops looking related to it. One blank line is the separation that was wanted.
    const final = footer ? `${body}\n\n${footer}` : body;
    if (!msgId) msgId = await reply.send(final);
    else await reply.finalize(msgId, final);
}
