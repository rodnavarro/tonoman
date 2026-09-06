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
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { Activities } from "./activities";

const { runTurn, postNotice } = proxyActivities<Activities>({
  // A turn is a person waiting on an LLM: minutes, not seconds. The heartbeat is what makes a dead
  // worker detectable in seconds anyway, so the long timeout costs nothing in responsiveness.
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "30 seconds",
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
      await postNotice({
        agent: input.agent,
        conversation: input.conversation,
        channel: input.channel,
        text: `⚠️ I hit an error and couldn't finish that — ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      }).catch(() => {});
    } finally {
      inFlight = undefined;
    }
  }

  // History bound reached. Anything still queued rides along, so no message is dropped at the seam.
  await continueAsNew<typeof conversationWorkflow>({ ...input, first: queue.shift() });
}
