// Fans several channels into one Connector (channel-app), so a single agent can be reached
// over Teams AND the Tonoman app at the same time.
//
// Before this, `runAgent` picked exactly one connector per agent, which made adding the app
// an either/or: turning it on for an agent would have taken its Teams or Telegram channel
// away. That is the wrong trade — the app is a control panel *alongside* the chat platform,
// not a replacement for it.
//
// The important property is that conversation ids are passed through UNCHANGED. Namespacing
// them (`teams:19:abc…`) would have been tidier, but conversation ids key the memory store
// and the harness session — rewriting them would orphan every existing transcript and reset
// live sessions on upgrade. Instead we remember which connector produced each conversation
// and route replies back to it. Ids from different channels don't collide in practice
// (Teams uses `19:…@thread.tacv2`, the app mints `app-…`), and a collision would only mean a
// reply routed to the wrong channel — not a crossed transcript.

import type { Connector, Envelope, Reply } from "../core/contracts";

export class MultiConnector implements Connector {
  /** conversation → the connector it arrived on. */
  private readonly owner = new Map<string, Connector>();

  constructor(private readonly conns: Connector[]) {
    if (conns.length === 0) throw new Error("multi: no connectors");
  }

  /** e.g. "teams+app". The router stamps this onto envelopes only for logging; nothing
   * downstream branches on it, so a compound name is safe. */
  name(): string {
    return this.conns.map((c) => c.name()).join("+");
  }

  async *receive(signal: AbortSignal): AsyncIterable<Envelope> {
    const its = this.conns.map((c) => c.receive(signal)[Symbol.asyncIterator]());
    const alive = new Set(its.keys());
    const pending = its.map((it, i) =>
      it.next().then(
        (r) => ({ i, r }),
        // A channel that dies must not take the others down with it: report and retire it.
        (e: Error) => ({ i, r: { done: true, value: undefined } as IteratorResult<Envelope>, err: e }),
      ),
    );

    while (alive.size > 0 && !signal.aborted) {
      const winner = await Promise.race([...alive].map((i) => pending[i]));
      const { i, r } = winner as { i: number; r: IteratorResult<Envelope>; err?: Error };
      const err = (winner as { err?: Error }).err;
      if (err) console.error(`multi: channel ${this.conns[i].name()} failed: ${err.message}`);
      if (r.done) {
        alive.delete(i);
        continue;
      }
      const env = r.value;
      this.owner.set(env.conversation, this.conns[i]);
      yield env;
      pending[i] = its[i].next().then(
        (res) => ({ i, r: res }),
        (e: Error) => ({ i, r: { done: true, value: undefined } as IteratorResult<Envelope>, err: e }),
      );
    }
  }

  /** Routes to the connector this conversation arrived on. An unknown conversation (a
   * reply attempted before any inbound message) falls back to the first connector, which
   * is the primary chat channel — never the app. */
  reply(conversation: string): Reply {
    return (this.owner.get(conversation) ?? this.conns[0]).reply(conversation);
  }

  async registerCommands(commands: { command: string; description: string }[]): Promise<void> {
    await Promise.allSettled(this.conns.map((c) => c.registerCommands?.(commands)));
  }
}
