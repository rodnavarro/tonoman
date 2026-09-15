// One workflow per conversation. The workflow id IS the conversation key, which buys three things
// at once:
//
//   - affinity, without a lookup table: signalWithStart on that id reaches the right conversation
//     whether or not one is already running;
//   - ordering, for free: Temporal serializes signals to a workflow, so two people typing at once
//     cannot interleave two turns;
//   - interruption, as a first-class operation rather than a race: a message arriving mid-turn
//     cancels the turn's scope.
//
// What a canceled turn leaves behind is the part worth getting right. The partial answer stays in
// the channel, marked as interrupted, and is carried into the next turn — so the next answer knows
// what this one had already found instead of starting blind.
//
// This is the Tonoman runtime, not Tonoman Cloud: an operator running Tonoman on their own machine
// gets the same durability and the same interruption. All Cloud adds is where the roster came from.

import {
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  startChild,
} from "@temporalio/workflow";
import type { Activities } from "./activities";
// From `turnfailure`, NOT from `authflow`. A workflow is bundled into a sandbox with no Node
// built-ins, and `authflow` imports `node:child_process` to drive the harness — importing it here
// fails the webpack build and the worker never starts, which looks like a hang rather than a bad
// import. These are pure string functions, which is also what keeps the workflow deterministic.
import { failureReason, isNotLoggedInError, notLoggedInNotice } from "../turnfailure";
import { isFinalLaunch, recordingKey, talentGate } from "./recordingkey";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";

const { runTurn, postNotice } = proxyActivities<Activities>({
  // A turn is a person waiting on an LLM: minutes, not seconds. The heartbeat is what makes a dead
  // worker detectable in seconds anyway, so the long timeout costs nothing in responsiveness.
  startToCloseTimeout: "20 minutes",
  // 60s, with the activity keeping itself alive on a 15s timer. 30 seconds was a gap the model
  // could exceed just by THINKING after a large tool result, which killed real turns. The margin
  // matters because a big synchronous parse can briefly block the timer too — and a blocked event
  // loop is exactly what this timeout should still catch.
  heartbeatTimeout: "60 seconds",
  // A turn is not idempotent — it posts to a channel and spends money. One attempt, then surface it.
  retry: { maximumAttempts: 1 },
});

export interface Inbound {
  text: string;
  user: string;
  ts: string;
  /** Paths to files attached to the message, on the shared volume for the turn to read. Absent for
   *  an ordinary message — every message today — so the turn is unchanged. */
  mediaPaths?: string[];
}

export interface ConversationInput {
  /** Which agent in the roster serves this conversation. */
  agent: string;
  /** The connector's conversation key — what `reply()` is opened on. */
  conversation: string;
  channel: string;
  /** Only ever set by continueAsNew, to carry a queued message across the history boundary.
   *
   *  NOT set by the caller: `signalWithStart` starts the workflow AND delivers the signal, so a
   *  message passed here as well would be queued twice — which is exactly what made every first
   *  message of a conversation get two answers. The signal is the only carrier from outside. */
  first?: Inbound;
}

export const messageSignal = defineSignal<[Inbound]>("message");

/** How many turns one run serves before continuing as new. Temporal's history is finite; a
 *  long-lived conversation has to hand off rather than grow forever. */
const TURNS_PER_RUN = 200;

export async function conversationWorkflow(input: ConversationInput): Promise<void> {
  const queue: Inbound[] = [];
  if (input.first) queue.push(input.first);

  let inFlight: CancellationScope | undefined;
  let interrupted = false;

  setHandler(messageSignal, (m: Inbound) => {
    queue.push(m);
    // STEER, not queue-and-wait. Someone correcting themselves mid-answer should not have to ask
    // for the correction to be applied — the queue-with-/pop default is right for Teams and wrong
    // for a chat where the next message is usually "no, I meant…".
    if (inFlight) {
      inFlight.cancel();
      inFlight = undefined;
    }
  });

  let served = 0;
  while (served < TURNS_PER_RUN) {
    // Idle out rather than run forever: a conversation nobody is using should not hold a slot. A
    // later message simply starts a new run under the same id.
    const gotOne = await condition(() => queue.length > 0, "1 hour");
    if (!gotOne) return;

    const m = queue.shift()!;
    served++;

    try {
      await CancellationScope.cancellable(async () => {
        inFlight = CancellationScope.current();
        await runTurn({
          agent: input.agent,
          conversation: input.conversation,
          channel: input.channel,
          text: m.text,
          user: m.user,
          mediaPaths: m.mediaPaths,
          afterInterruption: interrupted,
        });
        interrupted = false;
      });
    } catch (e) {
      if (isCancellation(e)) {
        // Steered. The activity's own cancellation path has already left the partial in the channel
        // labelled; we only remember it happened so the next turn is told why its context is thin.
        interrupted = true;
        continue;
      }
      // Never die silently: a turn that failed still owes the person an explanation, or they are
      // left watching a message that never finishes.
      //
      // And "no inference credential" gets its OWN explanation. "I hit an error" is true and
      // useless there: retrying cannot help, because nothing is wrong with the message — the agent
      // has nothing to answer on. The gate normally catches it first, from `auth_state`, but that
      // is a snapshot; a credential expiring between roster refreshes leaves the gate open and the
      // turn failing, and the person reads a stack-trace fragment.
      // failureReason, NOT e.message. An activity that throws arrives here as an ActivityFailure
      // whose message is the constant "Activity task failed" - the real one is on `cause`. Read
      // straight, this both printed that constant where the reason belonged AND asked
      // isNotLoggedInError about it, so no classifier change could ever have taken effect.
      const why = failureReason(e);
      await postNotice({
        agent: input.agent,
        conversation: input.conversation,
        channel: input.channel,
        text: isNotLoggedInError(why)
          ? notLoggedInNotice()
          : `⚠️ I hit an error and couldn't finish that — ${why.slice(0, 200)}`,
      }).catch(() => {});
    } finally {
      inFlight = undefined;
    }
  }

  // History bound reached. Anything still queued rides along, so no message is dropped at the seam.
  await continueAsNew<typeof conversationWorkflow>({ ...input, first: queue.shift() });
}

// --- the voice flow -----------------------------------------------------------------------------

const {
  voicePlan,
  findNewRecordings,
  processRecording,
  runTalent,
  sayVerbatim,
  openTalentRun,
  closeTalentRun,
  talentRunStatus,
} = proxyActivities<Activities>({
  // Listing is a cheap HTTP call; processing downloads audio and runs two models. openTalentRun /
  // closeTalentRun are quick DB writes that ride the same block — the timeout is a ceiling, not a cost.
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "60 seconds",
  retry: {
    // Enough attempts that a rate limit can actually be WAITED OUT. The transcriber throws with
    // the provider's OWN delay attached (`nextRetryDelay`), so these attempts are spaced by what
    // Groq asked for — "try again in 19m48s" — rather than by a backoff we invented and it has no
    // reason to respect. `maximumAttempts: 2` was the policy this began with, and two attempts
    // cannot survive a daily quota: the poll simply gave up and the schedule started over two
    // minutes later, forever.
    //
    // The intervals below are for everything ELSE — a transient network fault, a slow segment —
    // where nobody has told us when to come back.
    maximumAttempts: 8,
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "10 minutes",
  },
});

export interface PollInput {
  /** Roster name of the agent whose second brain receives the recaps. */
  agent: string;
  /** Slack user id to notify. */
  notify: string;
  /** Kept for compatibility with schedules created before the interval moved to the schedule
   *  itself. Unused: the cadence is the schedule's, which is the point of using one. */
  everySeconds?: number;
  /** At most this many recordings in one tick. Absent means all of them, which is the right
   *  default for a flow that has been keeping up.
   *
   *  It exists for the BACKLOG. Nine unprocessed meetings is the moment to see one land correctly
   *  before committing the rest of a daily quota to the other eight — and `temporal schedule
   *  trigger` with this set to 1 is how you do that without editing anything. Whatever is left is
   *  still there on the next tick; nothing is skipped, only deferred. */
  maxPerRun?: number;
  /** Restrict this run to ONE recording, by id or by stamp (`2026-09-08-1422`).
   *
   *  For measuring and for repair, not for the schedule. The poll takes the newest first, which is
   *  the right default and the wrong thing when you want to send a known five minutes of audio at a
   *  metered API and compare the answer against the provider's dashboard. */
  only?: string;
}

/**
 * ONE pass: find the finished recordings nobody has filed yet, and file them.
 *
 * A Temporal SCHEDULE drives this now, not a timer loop inside the workflow. The loop was the wrong
 * call and the reason it was wrong is worth keeping: I justified it with "a schedule would create an
 * execution every few minutes forever", which is precisely what schedules are for and what
 * retention handles. The test that actually matters is whether the workflow carries state between
 * iterations — and it does not. "Has this been published?" is answered from the git checkout and
 * the floor comes from configuration, so there was nothing for a long-lived execution to hold.
 *
 * What the loop cost was operational. Stopping it meant terminating a running workflow and
 * restarting a pod; a schedule has a pause button. Changing the interval meant a deploy. Not
 * double-processing meant care in the code; a schedule has an overlap policy. And the history had
 * to be bounded by hand with continueAsNew, which is complexity that only existed because of the
 * loop.
 *
 * So this is now what one tick does, and nothing else.
 */
export async function plaudPollWorkflow(input: PollInput): Promise<void> {
  // WHICH TALENT this agent's voice flow runs, read once per tick — its name and version, for the
  // run record and for resolving the code. The poll's job — find what is new, say it landed, dedup —
  // is the same for any Talent; the Talent's `run` (for the Plaud Talent, `processRecording`) is what
  // actually files the recap, in the child workflow below.
  const plan = await voicePlan({ agent: input.agent });

  let found: { id: string; title: string; stamp: string; minutes: number; user?: string; notify?: string }[] = [];
  try {
    found = await findNewRecordings({ agent: input.agent });
  } catch (e) {
    // A dead Plaud token is the expected failure — it expires every 24h. Say so, once, and let the
    // schedule try again on its own cadence rather than swallowing it.
    await sayVerbatim({
      agent: input.agent,
      user: input.notify,
      text: `⚠️ I can't reach your Plaud account — ${failureReason(e).slice(0, 150)}`,
      // ONCE A DAY, not once an hour. The schedule keeps retrying every couple of minutes (right —
      // the credential could come back at any time, and a successful poll silences this on its own),
      // but a person can only act on "reconnect Plaud" once. Hourly was still noise for a token that
      // stays dead for days; a day between reminders is the least that is still a reminder.
      onceMinutes: 1440,
    }).catch(() => {});
    throw e;
  }

  const picked = input.only ? found.filter((r) => r.id === input.only || r.stamp === input.only) : found;
  if (input.only && picked.length === 0) {
    console.log(`recap: ${input.agent} — nothing unpublished matches "${input.only}"; ${found.length} candidate(s)`);
  }
  const batch = input.maxPerRun && input.maxPerRun > 0 ? picked.slice(0, input.maxPerRun) : picked;
  if (batch.length < found.length) {
    console.log(`recap: ${input.agent} — taking ${batch.length} of ${found.length}; the rest wait for the next tick`);
  }

  for (const rec of batch) {
    // Who hears about THIS recording: the member whose account it came from, when the poll fanned
    // out over per-member accounts, else the poll's own `notify`. For every tenant that has not gone
    // per-person `rec.notify` is undefined, so this is `input.notify` exactly as before.
    const notify = rec.notify || input.notify;
    // The recording's KEY — what the run record and the workflow id are keyed on. Not the source's id
    // of the day: Plaud renamed every id once and the checkout-based check above saw a new recording
    // in each. The durable record is the second, id-proof answer to "have we been here before".
    const key = recordingKey(rec.id);

    // ONE durable decision per item, before anything is said or spent. The checkout says "not filed"
    // for a recording that was skipped on purpose (no speech), for one whose page is not in this
    // checkout yet, and for one that has failed all day; the run record tells those apart. A filed
    // item is never launched again; one past its launch budget is left for a person; the rest go to
    // the child, which announces ONLY on the first launch — so a recording is announced once, not
    // once per relaunch (fourteen times, the day the GPU route was down).
    const prior = await talentRunStatus({ agent: input.agent, talent: plan.talent.name, itemKey: key });
    const gate = talentGate(prior);
    if (gate === "skip-done") continue;
    if (gate === "skip-given-up") {
      console.log(`recap: ${input.agent} — “${rec.title}” has failed ${prior?.attempts} launches; leaving it for a person (!talent again)`);
      continue;
    }

    // Hand this ONE recording to the Talent, as an independent CHILD workflow. Child, not inline, for
    // two reasons: a 112-minute meeting must not hold the poll tick open (and with overlap SKIP,
    // block the next one), and each run wants to be its own retryable, inspectable execution in the
    // Temporal UI — the visibility whose absence produced 611 attempts.
    //
    // ABANDON so the run OUTLIVES the poll tick that started it. Deterministic workflowId IS the
    // dedup: a re-tick that lands while this recording is still being processed is rejected here
    // rather than starting a second run of the same meeting.
    try {
      await startChild(runTalentWorkflow, {
        // A recording id is only unique within an account, so a per-member run keys its id on the
        // member too — else two members' recordings sharing an id would dedup against each other.
        // The shared account (no user) keeps the original shape, so an in-flight run across a deploy
        // is still recognised.
        workflowId: rec.user ? `talent:${input.agent}:${rec.user}:${key}` : `talent:${input.agent}:${key}`,
        args: [
          {
            agent: input.agent,
            talent: plan.talent.name,
            version: plan.talent.version,
            itemKey: key,
            // The handle the Talent FETCHES with — the source's current id, which may differ from
            // the key it is remembered under.
            recordingId: rec.id,
            title: rec.title,
            minutes: rec.minutes,
            notify,
            user: rec.user,
          },
        ],
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
    } catch (e) {
      // Already running under this id: the previous tick's run for this recording has not finished.
      // That is the dedup working, not an error — leave it to finish.
      if (e instanceof WorkflowExecutionAlreadyStartedError) {
        console.log(`recap: ${input.agent} — “${rec.title}” already has a talent run in flight; leaving it`);
      } else {
        throw e;
      }
    }
  }
}


// --- run a Talent ------------------------------------------------------------------------------

export interface RunTalentInput {
  agent: string;
  /** Which Talent, by name — the installed voice Talent (the Plaud Talent, `meeting-recap`). */
  talent: string;
  /** The one item this run is for — a recording's KEY (`recordingKey`). Every run is exactly ONE
   *  item; the fan-out lives in the poll, not in the Talent. */
  itemKey: string;
  /** The id the Talent fetches the recording with — the source's current id, which is not always
   *  the key it is remembered under. Defaults to `itemKey` for callers that predate the split. */
  recordingId?: string;
  /** For the one-time acknowledgement, which this workflow now owns (see below). Absent for an
   *  on-demand run, which says nothing until it is done. */
  title?: string;
  minutes?: number;
  /** The Talent's version, pinned by the caller, for the run record. */
  version: number;
  notify?: string;
  /** The member whose Plaud account this recording came from, when the poll fanned out per-person;
   *  undefined for the shared account. Threaded into `processRecording`, which attributes it. */
  user?: string;
  /** Bypass the recording-level idempotency guard and re-run an already-`done` item. The poll never
   *  sets this (a filed recording should stay filed); the on-demand `!talent <name> <id> again`
   *  does, for the deliberate "recap that one again" — a fresh run, a fresh announcement. */
  force?: boolean;
}

/**
 * ONE workflow per recording, for the installed Talent.
 *
 * There is no interpreter and no step engine: a Talent is CODE, and the Plaud Talent's code is the
 * proven pipeline (`processRecording`). This workflow is the thin durable wrapper around that run —
 * retries, backoff, per-run history and the Temporal UI come for free from Temporal, and the
 * talent_run record makes "is this failing, or has nobody looked at it yet" answerable, which
 * nothing could answer before (the 611-attempts lesson).
 */
export async function runTalentWorkflow(input: RunTalentInput): Promise<void> {
  // Recording-level idempotency guard. A prior `done` means this item is already filed, so a re-run
  // would re-pay transcription + inference only to have the CLI's publish step discard it as already
  // present — the same work, the same cost, for nothing. The workflowId dedup above only catches a
  // run still IN FLIGHT; this catches one that already FINISHED (a re-tick after retention, or an
  // on-demand re-ask). `force` is the deliberate "recap it again". The read fails OPEN (returns
  // undefined on any error), so this can only skip a genuinely-done item, never block a new one.
  const prior = await talentRunStatus({ agent: input.agent, talent: input.talent, itemKey: input.itemKey });
  const gate = talentGate(prior, input.force);
  if (gate === "skip-done") {
    console.log(`recap: ${input.agent} — “${input.itemKey}” already filed (talent_run done); skipping re-run`);
    return;
  }
  if (gate === "skip-given-up") {
    console.log(`recap: ${input.agent} — “${input.itemKey}” is past its launch budget; not run again`);
    return;
  }

  // The durable record whose absence produced 611 attempts for 4 published recaps. Opened BEFORE the
  // run, so "being worked on" is a state that exists at all — which it never was. Best-effort inside
  // the activity: a missing row never stops a recording.
  await openTalentRun({ agent: input.agent, talent: input.talent, itemKey: input.itemKey, version: input.version });

  // Say it landed — ONCE, on the first launch of this item, after the record that will remember it
  // is open. It used to be said by the poll before every launch, and a recording that was relaunched
  // fourteen times through an outage was announced fourteen times. A relaunch says nothing: the
  // person was told the first time and has heard nothing since only because it is not done yet.
  if (gate === "first" && input.notify && input.title) {
    const m = input.minutes ?? 0;
    await sayVerbatim({
      agent: input.agent,
      user: input.notify,
      text: `I've got a new recording — “${input.title}”, ${m} minute${m === 1 ? "" : "s"}. Processing it now; I'll send the highlights shortly.`,
    }).catch(() => {});
  }

  try {
    // CUT OVER to the self-contained Talent CLI (spawned via the capability plane). `processRecording`
    // remains for a one-line revert: swap `runTalent` back to it and restart the worker. The announce
    // is the Talent's steer, run as a real agent turn inside runTalent — same behaviour as before.
    await runTalent({
      agent: input.agent,
      notify: input.notify ?? "",
      item: input.recordingId ?? input.itemKey,
      user: input.user,
      talent: input.talent,
    });
    void processRecording; // kept importable for the revert; see above
    await closeTalentRun({ agent: input.agent, talent: input.talent, itemKey: input.itemKey, status: "done" });
  } catch (e) {
    // Recorded, then rethrown. Temporal owns the retry; this record owns the ANSWER to "is this
    // failing, or has nobody looked at it yet".
    await closeTalentRun({
      agent: input.agent,
      talent: input.talent,
      itemKey: input.itemKey,
      status: "failed",
      error: failureReason(e).slice(0, 500),
    }).catch(() => {});
    // The person was told "processing it now; highlights shortly", so a run that gives up for good
    // owes them a word — the precise silent failure this whole layer exists to end. But ONLY the
    // launch that spends the last of the budget says it: the poll relaunches a failed item quietly
    // until then, and one warning per relaunch was the other half of the outage-day noise. A forced
    // re-run is a person watching; it always reports.
    if (input.notify && (input.force || isFinalLaunch(prior))) {
      await sayVerbatim({
        agent: input.agent,
        user: input.notify,
        text: `⚠️ I couldn't finish processing a recording — ${failureReason(e).slice(0, 200)}`,
      }).catch(() => {});
    }
    throw e;
  }
}
