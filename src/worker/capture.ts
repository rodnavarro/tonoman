// Trying an agent without a channel (CONVO-TRY-*). A tried turn is an ordinary turn — same model,
// same tools, same speaker, same memory of the try conversation — except that what it would post goes
// HERE instead of to Slack or Teams, and comes back to whoever asked: the answer, the notes the
// channel would have shown, and the tools the agent ran.
//
// The tools still act. A try of "make the event" makes the event; that is the point of trying the
// agent rather than a mock of it. Only the conversation itself is kept off every channel.

import type { Reply, TurnUsage } from "../core/contracts";

export interface TriedCall {
  tool: string;
  detail?: string;
}

/** What one tried turn said and did. */
export interface TurnTranscript {
  /** The answer, as the channel would have shown it last (footer included). */
  answer: string;
  /** Every message the turn posted, in order, as each ended up. Usually just the answer. */
  messages: string[];
  /** The work log as it last stood (what the channel shows above the answer). */
  notes: string[];
  /** The tools the agent ran, in order, with what each was run on. */
  calls: TriedCall[];
  usage?: TurnUsage;
  ms: number;
}

/** Where a tried turn reports to: its reply, and the slots the turn fills as it goes. */
export interface CaptureSink {
  reply: Reply;
  calls?: TriedCall[];
  usage?: TurnUsage;
  transcript(ms: number): TurnTranscript;
}

/** PURE (no I/O): a reply that keeps everything it is given. */
export function captureTurn(): CaptureSink {
  let n = 0;
  const messages = new Map<string, string>();
  const order: string[] = [];
  const notes = new Map<string, string>();
  const sink: CaptureSink = {
    reply: {
      async send(text) {
        const id = `m${++n}`;
        messages.set(id, text);
        order.push(id);
        return id;
      },
      async update(id, text) {
        messages.set(id, text);
      },
      async finalize(id, text) {
        messages.set(id, text);
      },
      canEdit: () => true,
      async working() {},
      async settle() {},
      async note(id, text) {
        const key = id ?? `n${++n}`;
        if (text === null) notes.delete(key);
        else notes.set(key, text);
        return key;
      },
      keepsNotes: false,
    },
    transcript(ms) {
      const said = order.map((id) => messages.get(id) ?? "");
      return {
        answer: said[said.length - 1] ?? "",
        messages: said,
        notes: [...notes.values()],
        calls: (sink.calls ?? []).map((c) => ({ tool: c.tool, ...(c.detail ? { detail: c.detail } : {}) })),
        ...(sink.usage ? { usage: sink.usage } : {}),
        ms,
      };
    },
  };
  return sink;
}
