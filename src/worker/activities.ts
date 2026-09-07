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
import * as recap from "./recap";

/** How the worker finds an agent's connector and runner. Injected at worker construction so this
 *  module holds no globals and can be unit-tested without Temporal. */
export interface TurnDeps {
  agent(name: string): { cfg: AgentConfig; conn: Connector; context?: string; run: (req: TurnRunReq) => AsyncIterable<TurnEvent> } | undefined;
  /** What this agent needs to run the voice flow, or undefined if it is not configured for one. */
  voice?(name: string): VoiceConfig | undefined;
  /** Say something verbatim to a person, opening a DM if needed. */
  say?(agent: string, user: string, text: string): Promise<void>;
  /** Run text as a turn addressed to a person. */
  ask?(agent: string, user: string, text: string): Promise<void>;
}

export interface VoiceConfig {
  creds: recap.PlaudCreds;
  /** The second-brain checkout the recap is written into. */
  brainDir: string;
  /** Push URL carrying the credential — used for one command, never left on disk. */
  pushUrl: string;
  groqKey: string;
  vocab: string;
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
      // The status line IS the cue — "Nelly is thinking…" under the composer. A placeholder message
      // posted alongside it is worse than nothing: it flashes "…" and then gets overwritten, which
      // reads as a glitch. So no message is posted until there is something real to put in it.
      await reply.working?.("is thinking").catch(() => {});

      let answer = "";
      let lastEdit = 0;
      let done = false;
      /** Created on first render, not up front. Empty until then. */
      let msgId = "";
      const show = async (text: string): Promise<void> => {
        if (!msgId) msgId = await reply.send(text);
        else await reply.update(msgId, text);
      };
      // Tool narration (Teams parity). Shown ONLY until the first words of the answer arrive, then
      // replaced by the answer itself. A turn that greps the second brain for ten seconds otherwise
      // shows nothing but a placeholder, and silence reads as broken rather than as working.
      let activity = "";

      // Temporal cancels the scope when a new message arrives. Leave the partial visible and say
      // what happened — a reply that silently stops looks like a broken bot.
      ctx.cancelled.catch(() => {
        if (done) return;
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
      ].filter(Boolean);
      const preamble = parts.length ? `${parts.join("\n\n")}\n\n` : "";

      for await (const ev of run({ prompt: `${preamble}${input.text}`, systemPromptFile: found.cfg.system_prompt_file })) {
        if (ctx.cancellationSignal.aborted) return;
        if (ev.kind === "text" && ev.text) {
          answer += ev.text;
          const now = Date.now();
          if (now - lastEdit >= EDIT_INTERVAL_MS && answer.trim()) {
            lastEdit = now;
            await show(answer).catch(() => {});
          }
        } else if (ev.kind === "tool" && !answer) {
          // Tool narration goes ONLY in the status line, never as a message. Slack renders it there
          // as the agent's activity; as a message it would be a line the answer then overwrites.
          activity = `${(ev.tool ?? "working").toLowerCase()}${ev.text ? `: ${ev.text}` : ""}`;
          const now = Date.now();
          if (now - lastEdit >= EDIT_INTERVAL_MS) {
            lastEdit = now;
            await reply.working?.(`is ${activity}`.slice(0, 100)).catch(() => {});
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
      // Slack leaves "is thinking…" on screen until it is cleared, so an answered turn that
      // forgets this looks permanently busy.
      await reply.settle?.().catch(() => {});
      if (ctx.cancellationSignal.aborted) return;
      const final = answer.trim() || "_(no answer)_";
      if (!msgId) msgId = await reply.send(final);
      else await reply.finalize(msgId, final);
    },

    async postNotice(input: NoticeInput): Promise<void> {
      const found = deps.agent(input.agent);
      if (!found) return;
      const reply = found.conn.reply(input.conversation);
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
      const fresh = await recap.unpublished(all, v.brainDir);
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

      ctx.heartbeat("transcribing");
      const { text, seconds } = await recap.transcribe(v.creds, rec, v.groqKey, v.vocab);
      console.log(`recap: ${rec.title} transcribed in ${seconds.toFixed(1)}s, ${text.length} chars`);

      ctx.heartbeat("summarising");
      const summary = await recap.summarize(text, rec.title, v.groqKey);

      ctx.heartbeat("publishing");
      const published = await recap.publish(v.brainDir, rec, summary, text, v.pushUrl);
      console.log(`recap: ${rec.title} ${published ? "published" : "already present"} at Meetings/${rec.stamp}.md`);
      if (!published) return; // somebody else got there first; do not announce it twice

      // A real turn, so the agent says it in its own words and can be asked follow-ups in the same
      // conversation. The three highlights are handed over rather than re-derived.
      const top = (summary.highlights ?? []).slice(0, 3);
      await deps.ask?.(
        input.agent,
        input.notify,
        `A recording has just finished processing and is filed in the second brain at ` +
          `Meetings/${rec.stamp}.md: “${rec.title}”. Write a short message telling them it is ready ` +
          `and giving the three most useful things from it, in your own words, then offer to answer ` +
          `questions about it. The three: ${top.map((h, i) => `(${i + 1}) ${h}`).join(" ")}`,
      );
    },

    /** Say something verbatim to a person, opening a DM if needed. Used for the acknowledgement and
     *  for failures, where spending an LLM turn to relay a known sentence is waste. */
    async sayVerbatim(input: { agent: string; user: string; text: string }): Promise<void> {
      await deps.say?.(input.agent, input.user, input.text);
    },
  };
}

export type Activities = ReturnType<typeof makeActivities>;
