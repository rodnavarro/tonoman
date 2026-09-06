// The Slack connector (A1): owns its inbound transport (Socket Mode), normalizes messages to a
// neutral Envelope, and delivers replies over send / update / finalize (chat.update). The only
// Slack-specific code in the gateway; the router never sees any of it.
//
// Socket Mode, not the Events API. The app DIALS OUT over a WebSocket, so there is no ingress, no
// public URL, no TLS certificate, no request-signature verification, and no 3-second HTTP ack to
// race — the same reason the Telegram connector long-polls. It costs one app-level token
// (`xapp-…`, scope `connections:write`) alongside the bot token.
//
// Two Slack facts shape the code below:
//   1. Every envelope must be acked on the socket within 3s or Slack redelivers it. We ack FIRST,
//      then normalize — an ack is not a promise to answer, and a slow turn must not cause a
//      duplicate.
//   2. Slack rotates the socket every ~10-60 minutes and warns first (`disconnect`). We treat that
//      as ordinary, not an error: reconnect and keep yielding from the same iterator.

import type { Connector, Envelope, Reply } from "../core/contracts";

export interface SlackOptions {
  /** app-level token (`xapp-…`, scope `connections:write`) — opens the Socket Mode socket. */
  appToken: string;
  /** bot token (`xoxb-…`) — every Web API call (postMessage, update, users.info). */
  botToken: string;
  /** optional allow-list of Slack user ids (`U…`); empty = accept all. */
  allowedUsers?: string[];
  apiBase?: string; // default https://slack.com/api
  fetchImpl?: typeof fetch; // injectable for tests; defaults to global fetch
  /** injectable WebSocket ctor for tests; defaults to the global (Node >= 22). */
  socketImpl?: typeof WebSocket;
  /** Block Kit interactions: button clicks and modal submissions.
   *
   *  Kept OFF the envelope stream on purpose. An envelope is a message a person sent to the agent,
   *  and a button press is not that — routing it as one would put "connect_claude" through the
   *  harness as if somebody had typed it. */
  onInteraction?: (p: SlackInteraction) => void;
}

/** A Block Kit interaction, normalized to the two cases we act on. */
export interface SlackInteraction {
  kind: "block_actions" | "view_submission";
  userId: string;
  /** Short-lived (~3s) token that authorizes opening a modal. Only on block_actions. */
  triggerId?: string;
  /** The action id of the button that was pressed. */
  actionId?: string;
  /** Opaque state carried on the button, so a modal knows which conversation it belongs to. */
  value?: string;
  /** For view_submission: the modal's private_metadata, and the values the person typed. */
  privateMetadata?: string;
  values?: Record<string, Record<string, { value?: string }>>;
}

/** Socket Mode envelope, the outer frame Slack pushes down the WebSocket. */
interface SocketEnvelope {
  type: string; // "hello" | "events_api" | "disconnect" | "slash_commands" | ...
  envelope_id?: string;
  payload?: { event?: SlackEvent; team_id?: string };
  reason?: string;
}

interface SlackEvent {
  type: string; // "app_mention" | "message"
  subtype?: string; // "message_changed", "bot_message", … — all ignored
  channel?: string;
  channel_type?: string; // "im" for a DM
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
}

export class SlackConnector implements Connector {
  /** Recently handled event keys, to drop a redelivery if our ack was slow. Bounded — a
   *  redelivery arrives seconds later, so a short memory is enough and never grows. */
  private readonly seen = new Set<string>();
  private botUserID = "";

  constructor(private readonly o: SlackOptions) {}

  name(): string {
    return "slack";
  }

  private get fetch(): typeof fetch {
    return this.o.fetchImpl ?? globalThis.fetch;
  }
  private apiBase(): string {
    return this.o.apiBase || "https://slack.com/api";
  }

  /** Calls a Slack Web API method with the BOT token. Slack answers 200 with `{ok:false}`, so
   *  the error path is the body, not the status. */
  async call<T = unknown>(method: string, body: Record<string, unknown> = {}, token?: string): Promise<T> {
    const r = await this.fetch(`${this.apiBase()}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token ?? this.o.botToken}`,
      },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? `http ${r.status}`}`);
    return j as T;
  }

  /** Our own bot user id, so we never answer ourselves. Resolved once, best-effort: if it fails
   *  we fall back to the `bot_id` check alone, which already covers the common case. */
  private async resolveBotUser(): Promise<void> {
    if (this.botUserID) return;
    try {
      const a = await this.call<{ user_id?: string }>("auth.test");
      this.botUserID = a.user_id ?? "";
    } catch {
      /* not fatal — subtype/bot_id filtering still applies */
    }
  }

  /** Connects the Socket Mode socket and yields envelopes until `signal` aborts. Reconnects
   *  across Slack's routine socket rotation without interrupting the iterator. */
  async *receive(signal: AbortSignal): AsyncIterable<Envelope> {
    await this.resolveBotUser();
    const WS = this.o.socketImpl ?? globalThis.WebSocket;

    while (!signal.aborted) {
      let url: string;
      try {
        url = (await this.call<{ url: string }>("apps.connections.open", {}, this.o.appToken)).url;
      } catch (e) {
        // A bad app token would spin here, so back off and say why once per attempt.
        console.error(`slack: apps.connections.open failed: ${(e as Error).message}`);
        await sleep(3000, signal);
        continue;
      }

      // Bridge the socket's callbacks to this async iterator: `pending` holds envelopes that
      // arrived before the consumer asked, `wake` releases a consumer that is waiting.
      const pending: Envelope[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const push = (env: Envelope): void => {
        pending.push(env);
        wake?.();
      };
      const finish = (): void => {
        closed = true;
        wake?.();
      };

      const ws = new WS(url);
      const onAbort = (): void => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });

      ws.onclose = finish;
      ws.onerror = finish;
      ws.onmessage = (ev: MessageEvent): void => {
        let frame: SocketEnvelope;
        try {
          frame = JSON.parse(String(ev.data)) as SocketEnvelope;
        } catch {
          return; // not ours to interpret
        }

        // Ack FIRST, always, before any work. Slack redelivers an envelope it has not seen
        // acked within 3s, and a turn takes far longer than that.
        if (frame.envelope_id) {
          try {
            ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
          } catch {
            /* socket already gone; the reconnect below will pick the event up again */
          }
        }

        // Slack warns before it rotates the socket. Ordinary housekeeping, not an error:
        // close and let the outer loop dial again.
        if (frame.type === "disconnect") {
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          return;
        }

        // Block Kit interactions ride the same socket but are not messages. A modal submission
        // must be acked with an EMPTY payload body, or Slack leaves the dialog open showing a
        // spinner even though the submission was accepted.
        if (frame.type === "interactive" && frame.payload) {
          const it = normalizeInteraction(frame.payload as Record<string, unknown>);
          if (it) this.o.onInteraction?.(it);
          return;
        }

        if (frame.type !== "events_api" || !frame.payload?.event) return;
        const env = this.normalize(frame.payload.event, frame.payload.team_id ?? "");
        if (env) push(env);
      };

      try {
        while (!signal.aborted) {
          while (pending.length > 0) yield pending.shift()!;
          if (closed) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }

      // Socket dropped (rotation, network, or Slack restart). Pause briefly so a hard failure
      // cannot become a reconnect storm, then dial again.
      if (!signal.aborted) await sleep(1000, signal);
    }
  }

  reply(conversation: string): Reply {
    return new SlackReply(this, conversation);
  }

  /** Register the interaction handler after construction. The worker builds connectors first and
   *  only then has the dependencies (auth ops, registry client) the handler needs. */
  setInteractionHandler(fn: (p: SlackInteraction) => void): void {
    this.o.onInteraction = fn;
  }

  /** Post a message carrying Block Kit blocks — a button, in practice. Outside the `Reply`
   *  contract on purpose: `Reply` is the streaming-answer surface, and this is an interaction the
   *  agent needs from a person before it can answer at all. `text` is still supplied because it is
   *  what notifications and screen readers use. */
  async postBlocks(conversation: string, text: string, blocks: unknown[]): Promise<string> {
    const t = parseConversation(conversation);
    const res = await this.call<{ ts?: string }>("chat.postMessage", {
      channel: t.channel,
      text,
      blocks,
      ...(t.threadTs ? { thread_ts: t.threadTs } : {}),
      unfurl_links: false,
    });
    return res.ts ?? "";
  }

  /** Turns a Slack event into a neutral envelope, or null to ignore it.
   *
   *  We answer exactly two things: an `app_mention` (someone said @nelly), and a `message` in a
   *  DM. Everything else — channel chatter we were not addressed in, edits, joins, our own
   *  posts — is dropped here rather than in the router. */
  private normalize(e: SlackEvent, teamID: string): Envelope | null {
    if (e.type !== "app_mention" && !(e.type === "message" && e.channel_type === "im")) return null;
    // A subtype means it is not a plain human message: message_changed, message_deleted,
    // channel_join, bot_message. None of them are something to answer.
    if (e.subtype) return null;
    if (e.bot_id) return null;
    if (!e.user || !e.channel) return null;
    if (this.botUserID && e.user === this.botUserID) return null;
    if (this.o.allowedUsers?.length && !this.o.allowedUsers.includes(e.user)) return null;

    // A DM that mentions the bot arrives TWICE — once as message.im and once as app_mention.
    // Both carry the same ts, so keying on channel+ts collapses them to one turn.
    const key = `${e.channel}:${e.ts ?? e.event_ts ?? ""}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);

    return {
      channel: this.name(),
      // The conversation key, and the thing the durable half turns into a workflow id. Thread
      // is part of the identity: two threads in one channel are two conversations.
      conversation: conversationKey(teamID, e.channel, e.thread_ts),
      user: e.user,
      text: stripMention(e.text ?? ""),
      mediaPaths: [],
    };
  }
}

/** `<team>/<channel>[/<thread_ts>]` — flat, sortable, and parseable without ambiguity, since
 *  neither a team nor a channel id contains a slash. */
export function conversationKey(team: string, channel: string, threadTs?: string): string {
  return threadTs ? `${team}/${channel}/${threadTs}` : `${team}/${channel}`;
}

/** PURE: split a conversation key back into its parts. Unit-tested. */
export function parseConversation(conversation: string): { team: string; channel: string; threadTs?: string } {
  const [team = "", channel = "", threadTs] = conversation.split("/");
  return { team, channel, threadTs };
}

/** PURE: normalize a Block Kit interaction payload to the two cases we act on, or null. Unit-tested
 *  because the payload shape is deeply nested and a silent miss here looks like a dead button. */
export function normalizeInteraction(p: Record<string, unknown>): SlackInteraction | undefined {
  const user = (p.user as { id?: string } | undefined)?.id ?? "";
  if (p.type === "block_actions") {
    const action = (p.actions as { action_id?: string; value?: string }[] | undefined)?.[0];
    if (!action?.action_id) return undefined;
    return {
      kind: "block_actions",
      userId: user,
      triggerId: String(p.trigger_id ?? ""),
      actionId: action.action_id,
      value: action.value,
    };
  }
  if (p.type === "view_submission") {
    const view = p.view as
      | { private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string }>> } }
      | undefined;
    return {
      kind: "view_submission",
      userId: user,
      privateMetadata: view?.private_metadata,
      values: view?.state?.values,
    };
  }
  return undefined;
}

/** PURE: pull the first non-empty input value out of a modal's state, whatever block it sits in.
 *  Addressing it by block id would break the moment the modal is restyled. */
export function firstInputValue(values?: Record<string, Record<string, { value?: string }>>): string {
  for (const block of Object.values(values ?? {})) {
    for (const input of Object.values(block)) {
      if (input?.value && input.value.trim()) return input.value.trim();
    }
  }
  return "";
}

/** PURE: drop the leading `<@U123>` the platform prepends to an app_mention, so the harness sees
 *  the sentence the person actually typed rather than an id it has no use for. Unit-tested. */
export function stripMention(text: string): string {
  return text.replace(/<@[UWB][A-Z0-9]*>/g, " ").replace(/\s+/g, " ").trim();
}

class SlackReply implements Reply {
  private readonly target: { team: string; channel: string; threadTs?: string };

  constructor(private readonly c: SlackConnector, conversation: string) {
    this.target = parseConversation(conversation);
  }

  /** Slack edits messages in place, so the turn streams rather than arriving in chunks. */
  canEdit(): boolean {
    return true;
  }

  async send(text: string): Promise<string> {
    const res = await this.c.call<{ ts?: string }>("chat.postMessage", {
      channel: this.target.channel,
      text: text || "…",
      // Stay in the thread we were addressed in; a top-level mention answers top-level.
      ...(this.target.threadTs ? { thread_ts: this.target.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return res.ts ?? "";
  }

  async update(msgID: string, text: string): Promise<void> {
    await this.edit(msgID, text);
  }

  async finalize(msgID: string, text: string): Promise<void> {
    await this.edit(msgID, text);
  }

  private async edit(msgID: string, text: string): Promise<void> {
    if (!msgID) return;
    try {
      await this.c.call("chat.update", { channel: this.target.channel, ts: msgID, text: text || "…" });
    } catch (e) {
      // Slack rejects an edit that changes nothing, and rate-limits a fast stream. Neither is
      // worth failing a turn over — the next update carries the same text forward.
      const m = (e as Error).message;
      if (/msg_too_long|ratelimited|edit_window_closed/.test(m)) return;
      throw e;
    }
  }

  /** Slack has no typing indicator for apps. The streamed message itself is the cue: the first
   *  `send` posts within a second of the mention, so the person sees an answer forming. */
  async working(): Promise<void> {
    /* no-op by design — see above */
  }

  /** Standalone notice (telegram/teams parity): post / edit-by-id / delete a plain message,
   *  stateless across reply instances — what the gateway's queue footer needs. */
  async note(id: string | undefined, text: string | null): Promise<string> {
    try {
      if (id && text === null) {
        await this.c.call("chat.delete", { channel: this.target.channel, ts: id });
        return "";
      }
      if (id) {
        await this.edit(id, text ?? "");
        return id;
      }
      return await this.send(text ?? "");
    } catch {
      return id ?? ""; // a dropped notice never costs a turn
    }
  }
}

/** Abortable sleep — resolves early when the signal fires, so shutdown is immediate. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
