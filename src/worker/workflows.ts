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
import { declaredOut, validateSteps, type Bag, type Step } from "./skill";
// From `turnfailure`, NOT from `authflow`. A workflow is bundled into a sandbox with no Node
// built-ins, and `authflow` imports `node:child_process` to drive the harness — importing it here
// fails the webpack build and the worker never starts, which looks like a hang rather than a bad
// import. These are pure string functions, which is also what keeps the workflow deterministic.
import { failureReason, isNotLoggedInError, notLoggedInNotice } from "../turnfailure";
import { ApplicationFailure, WorkflowExecutionAlreadyStartedError } from "@temporalio/common";

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

const { voicePlan, findNewRecordings, processRecording, sayVerbatim } = proxyActivities<Activities>({
  // Listing is a cheap HTTP call; processing downloads audio and runs two models.
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
  // WHICH RUNTIME, read once per tick. `hardcoded` is the proven pipeline; `skill` hands each
  // recording to the generic interpreter. The poll's job — find what is new, say it landed, dedup —
  // is identical either way; only what processes a recording changes, which is what makes arming and
  // reverting a single registry row rather than a different schedule.
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
      // ONCE AN HOUR, not once a tick. The schedule retries every couple of minutes, which is right
      // — the credential could come back at any time — but the person can only act on this once,
      // and thirty identical warnings an hour is how a useful notice becomes noise to be muted.
      onceMinutes: 60,
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
    // Say it landed BEFORE the slow part, so the person knows it was seen. Identical on both paths:
    // the ack is a fact about the poll, not about which runtime files the recap.
    await sayVerbatim({
      agent: input.agent,
      user: notify,
      text: `I've got a new recording — “${rec.title}”, ${rec.minutes} minute${rec.minutes === 1 ? "" : "s"}. Processing it now; I'll send the highlights shortly.`,
    }).catch(() => {});

    if (plan.runner === "skill" && plan.skill) {
      // Hand this ONE recording to the generic interpreter, as an independent CHILD workflow. Child,
      // not inline, for two reasons: a 112-minute meeting must not hold the poll tick open (and with
      // overlap SKIP, block the next one), and each run wants to be its own retryable, inspectable
      // execution in the Temporal UI — which is the visibility whose absence produced 611 attempts.
      //
      // ABANDON so the run OUTLIVES the poll tick that started it. Deterministic workflowId IS the
      // dedup: a re-tick that lands while this recording is still being processed is rejected here
      // rather than starting a second run of the same meeting.
      try {
        await startChild(runSkillWorkflow, {
          // A recording id is only unique within an account, so a per-member run keys its id on the
          // member too — else two members' recordings sharing an id would dedup against each other.
          // The shared account (no user) keeps the original id, so an in-flight run across a deploy
          // is still recognised.
          workflowId: rec.user ? `skill:${input.agent}:${rec.user}:${rec.id}` : `skill:${input.agent}:${rec.id}`,
          args: [
            {
              agent: input.agent,
              skill: plan.skill.name,
              itemKey: rec.id,
              steps: plan.skill.steps,
              version: plan.skill.version,
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
          console.log(`recap: ${input.agent} — “${rec.title}” already has a skill run in flight; leaving it`);
        } else {
          throw e;
        }
      }
      continue;
    }

    try {
      await processRecording({ agent: input.agent, notify, id: rec.id, user: rec.user });
    } catch (e) {
      // One recording failing must not abandon the rest of the batch.
      await sayVerbatim({
        agent: input.agent,
        user: notify,
        text: `⚠️ I couldn't finish processing “${rec.title}” — ${failureReason(e).slice(0, 200)}`,
      }).catch(() => {});
    }
  }
}


// --- the skill interpreter ----------------------------------------------------------------------

const { runStep, openSkillRun, closeSkillRun } = proxyActivities<Activities>({
  // A step is whatever the verb behind it is: `mission get` is one query, `transcript get`
  // downloads audio and runs a model on it. Sized for the slowest, because the alternative is a
  // per-verb table in the workflow — which would put the runtime's knowledge of its own tools back
  // into code the tenant cannot see.
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "60 seconds",
  retry: {
    maximumAttempts: 8,
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "10 minutes",
  },
});

export interface RunSkillInput {
  agent: string;
  /** Which skill, by name — resolved to its steps on the roster the worker already holds. */
  skill: string;
  /** The one item this run is for. Every run operates on exactly ONE item; the fan-out lives in the
   *  trigger, which is what removes the loop from the step language. */
  itemKey: string;
  /** The steps, and the version they came from, pinned by the caller. Passed IN rather than read
   *  here so that an edit to a live skill cannot change what an in-flight run is doing halfway
   *  through — the run's history would otherwise describe something that never happened. */
  steps: Step[];
  version: number;
  notify?: string;
  /** The member whose Plaud account this recording came from, when the poll fanned out per-person.
   *  Carried so the interpreter can attribute the run; undefined for the shared account. */
  user?: string;
}

/**
 * ONE generic workflow, for every skill there will ever be.
 *
 * This is the whole argument of the layer in one function: there is no new engine. Retries, backoff,
 * durability, per-run history and the Temporal UI all come for free from Temporal, and every one of
 * them was missing from the hand-written pipeline on 2026-09-08.
 *
 * The steps are FLAT and executed in order, because the one construct that would have forced a real
 * DSL — "for each recording" — is hoisted into the trigger instead.
 */
export async function runSkillWorkflow(input: RunSkillInput): Promise<void> {
  // Checked ONCE, before anything runs. A skill that names an input nothing produces is a broken
  // definition, and it must fail as one at the start rather than at step five with three side
  // effects already committed.
  const problems = validateSteps(input.steps);
  if (problems.length) {
    throw ApplicationFailure.create({
      message: `skill ${input.skill} is not runnable: ${problems.join("; ")}`,
      type: "BadSkill",
      nonRetryable: true,
    });
  }

  // The durable record whose absence produced 611 attempts for 4 published recaps. Opened BEFORE
  // the first step, so "being worked on" is a state that exists at all — which it never was.
  await openSkillRun({ agent: input.agent, skill: input.skill, itemKey: input.itemKey, version: input.version });

  const bag: Bag = {};
  try {
    for (const step of input.steps) {
      const result = await runStep({
        agent: input.agent,
        skill: input.skill,
        itemKey: input.itemKey,
        notify: input.notify ?? "",
        step,
        // Only what the step DECLARED. Computed in the activity from the step and the bag, so the
        // workflow never has to know what a verb means.
        bag,
      });
      const out = declaredOut(step);
      // A step that files nothing ran for its effect — `say` is the case, and it is not a gap.
      if (out) bag[out] = result;
      // A step may end the run without failing it: a recording nothing can hear is not a meeting to
      // file, and it is not an error either.
      if (result !== null && typeof result === "object" && (result as { $stop?: boolean }).$stop) break;
    }
    await closeSkillRun({ agent: input.agent, skill: input.skill, itemKey: input.itemKey, status: "done" });
  } catch (e) {
    // Recorded, then rethrown. Temporal owns the retry; this table owns the ANSWER to "is this
    // failing, or has nobody looked at it yet" — which nothing could answer before.
    await closeSkillRun({
      agent: input.agent,
      skill: input.skill,
      itemKey: input.itemKey,
      status: "failed",
      error: failureReason(e).slice(0, 500),
    }).catch(() => {});
    // Parity with the hardcoded path's per-recording failure notice. The trigger already told the
    // person "processing it now; highlights shortly", so a silent failure here leaves them waiting on
    // a recap that is never coming — the precise silent failure this whole layer exists to end.
    // Best-effort and once: the child does not retry, so this fires exactly when the run gives up.
    if (input.notify) {
      await sayVerbatim({
        agent: input.agent,
        user: input.notify,
        text: `⚠️ I couldn't finish processing a recording — ${failureReason(e).slice(0, 200)}`,
      }).catch(() => {});
    }
    throw e;
  }
}
