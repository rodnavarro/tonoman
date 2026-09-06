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
import type { Connector, Reply, TurnEvent } from "../core/contracts";
import type { AgentConfig } from "../config";

/** How the worker finds an agent's connector and runner. Injected at worker construction so this
 *  module holds no globals and can be unit-tested without Temporal. */
export interface TurnDeps {
  agent(name: string): { cfg: AgentConfig; conn: Connector; context?: string; run: (req: TurnRunReq) => AsyncIterable<TurnEvent> } | undefined;
}

export interface TurnRunReq {
  prompt: string;
  systemPromptFile?: string;
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

export function makeActivities(deps: TurnDeps) {
  return {
    async runTurn(input: TurnInput): Promise<void> {
      const ctx = Context.current();
      const found = deps.agent(input.agent);
      if (!found) throw new Error(`worker: no agent "${input.agent}" in the roster`);
      const { conn, run } = found;

      const reply: Reply = conn.reply(input.conversation);
      // Post the placeholder before any output, so the person sees the agent take the message
      // within a second. Slack has no typing indicator for apps; this message is the cue.
      const msgId = await reply.send("…");

      let answer = "";
      let lastEdit = 0;
      let done = false;
      // Tool narration (Teams parity). Shown ONLY until the first words of the answer arrive, then
      // replaced by the answer itself. A turn that greps the second brain for ten seconds otherwise
      // shows nothing but a placeholder, and silence reads as broken rather than as working.
      let activity = "";

      // Temporal cancels the scope when a new message arrives. Leave the partial visible and say
      // what happened — a reply that silently stops looks like a broken bot.
      ctx.cancelled.catch(() => {
        if (done) return;
        void reply
          .finalize(msgId, `${answer.trim() || "_(nothing yet)_"}\n\n_— interrupted; working on your new message_`)
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
        known ? `You are speaking with ${known.label}.` : `You are speaking with someone you don't recognise (${input.user}); ask who they are before sharing anything specific.`,
        input.afterInterruption
          ? "(your previous answer was interrupted by a new message; continue from what the user now says)"
          : "",
      ].filter(Boolean);
      const preamble = parts.length ? `${parts.join("\n\n")}\n\n` : "";

      for await (const ev of run({ prompt: `${preamble}${input.text}`, systemPromptFile: found.cfg.system_prompt_file })) {
        if (ctx.cancellationSignal.aborted) return;
        if (ev.kind === "text" && ev.text) {
          answer += ev.text;
          const now = Date.now();
          if (now - lastEdit >= EDIT_INTERVAL_MS && answer.trim()) {
            lastEdit = now;
            await reply.update(msgId, answer).catch(() => {});
          }
        } else if (ev.kind === "tool" && !answer) {
          // "🔧 Grep: Meetings/" — the tool and a short detail, the same shape Teams shows.
          activity = `🔧 ${ev.tool ?? "working"}${ev.text ? `: ${ev.text}` : ""}`;
          const now = Date.now();
          if (now - lastEdit >= EDIT_INTERVAL_MS) {
            lastEdit = now;
            await reply.update(msgId, `_${activity.slice(0, 200)}_`).catch(() => {});
          }
        } else if (ev.kind === "done" && ev.final) {
          // The authoritative text. A harness that streams deltas AND sends a final would otherwise
          // leave whatever the last edit happened to catch; one that only sends a final would
          // otherwise post nothing at all.
          answer = ev.final;
        } else if (ev.kind === "error" && ev.err) {
          throw ev.err;
        }
        // Heartbeat on real progress, so a wedged model is detected quickly but a slow one is not
        // killed for being slow.
        ctx.heartbeat(answer.length);
      }

      done = true;
      if (ctx.cancellationSignal.aborted) return;
      await reply.finalize(msgId, answer.trim() || "_(no answer)_");
    },

    async postNotice(input: NoticeInput): Promise<void> {
      const found = deps.agent(input.agent);
      if (!found) return;
      const reply = found.conn.reply(input.conversation);
      await reply.send(input.text);
    },
  };
}

export type Activities = ReturnType<typeof makeActivities>;
