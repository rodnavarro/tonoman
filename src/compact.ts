// `/compact` (gw-command-compact): shrink a conversation's live context without losing the thread.
// `/new` is amnesia; `/compact` summarizes the session, rotates to a fresh one, and SEEDS it with
// the summary — so the harness's context drops (the reason ctx% falls) while continuity survives.
//
// The summary is produced by a one-shot main-runner turn (NO session resume — a standalone call fed
// the transcript), because the remote HTTP harness has no ephemeral sidecar. The orchestrator is
// written against the core contracts (runner + memory), so it's channel- and harness-neutral and
// unit-testable with fakes.

import type { MemoryStore, Message, TurnEvent, TurnRunner } from "./core/contracts";

/** Prefix on the seeded summary message, so the next turn's prompt frames it as prior context. */
export const COMPACT_SEED_PREFIX = "# Summary of the earlier conversation (compacted)\n";

/** The prompt that asks the harness to summarize the conversation so far into a compact,
 * continuation-ready brief. Pure: takes the transcript, returns the prompt text. */
export function buildSummaryPrompt(history: Message[]): string {
  // This runs as a normal agent turn, so the persona biases toward a chatty REPLY. Instruct hard:
  // a third-person handoff brief, NOT a message to anyone — it becomes the seed of the next session.
  let b = "SYSTEM TASK — not a message to the user. Write a compact hand-off brief of the conversation";
  b += " below, so a fresh session can continue it seamlessly.\n";
  b += "Rules: write in the THIRD PERSON as notes-to-self. Do NOT greet, address, or reply to anyone.";
  b += " No preamble, no sign-off, no offers to help — output ONLY the brief.\n";
  b += "Capture: decisions made, key facts and values (names, amounts, ids, paths), work completed,";
  b += " work in progress, and any open threads or promises still outstanding.\n\n";
  b += "# Conversation transcript\n";
  for (const m of history) b += `${m.role}: ${m.text}\n`;
  return b;
}

/** Drains a runner turn to its final assistant text (the summary), ignoring tool/text deltas.
 * Throws on a terminal error event so the caller can leave the live context untouched. */
export async function collectFinal(events: AsyncIterable<TurnEvent>): Promise<string> {
  let final = "";
  for await (const ev of events) {
    if (ev.kind === "done") final = ev.final ?? "";
    else if (ev.kind === "error") throw ev.err ?? new Error("compact: summary turn failed");
  }
  return final;
}

export interface CompactDeps {
  conversation: string;
  runner: TurnRunner;
  memory: MemoryStore;
  /** transcript messages to summarize; <=0 = all (default all). */
  windowSize?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Runs the compaction and returns a user-facing receipt. Order matters and is the contract:
 * summarize FIRST (while the transcript is intact), THEN rotate, THEN seed — so a failure at any
 * step leaves the existing context untouched rather than half-cleared. */
export async function compactConversation(d: CompactDeps): Promise<string> {
  const history = await d.memory.readWindow(d.conversation, d.windowSize ?? 0);
  const substantive = history.filter((m) => m.text && m.text.trim() !== "");
  if (substantive.length < 2) {
    return "🗜 Nothing to compact yet — the conversation is already short.";
  }
  // 1) Summarize via a one-shot turn (fresh: no sessionId ⇒ no resume, doesn't touch the live session).
  let summary = "";
  try {
    summary = (await collectFinal(d.runner.run({ prompt: buildSummaryPrompt(substantive) }, d.signal))).trim();
  } catch {
    return "🗜 Couldn't produce a summary just now — nothing changed, your context is intact.";
  }
  if (!summary) return "🗜 Couldn't produce a summary just now — nothing changed, your context is intact.";
  // 2) Rotate to a fresh session (this is what drops the harness context / ctx%).
  await d.memory.newSession(d.conversation);
  // 3) Seed the fresh session with the summary so the next turn continues with the gist.
  const ts = (d.now ?? (() => new Date()))().toISOString().replace(/\.\d{3}Z$/, "Z");
  await d.memory.append(d.conversation, { role: "assistant", text: COMPACT_SEED_PREFIX + summary, ts });
  await d.memory.commit(`compact: ${d.conversation}`);
  return "🗜 Compacted — kept a summary of where we are and cleared the rest. Context is fresh; I still remember the gist.";
}
