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

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { toMrkdwn } from "./mrkdwn";
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
  /** Where inbound attachments are downloaded so the turn can read them. The agent's directory on
   *  the shared state volume; absent = attachments are ignored (the text turn still runs). Needs the
   *  app's `files:read` scope — without it the download 403s and is logged, never silent. */
  mediaDir?: string;
  /** The path `mediaDir` appears at to the process that runs `claude`. Same as `mediaDir` when the
   *  runtime shares this pod's filesystem (the local-exec case); a mount path when it does not. */
  mediaMount?: string;
  /** injectable WebSocket ctor for tests; defaults to the global (Node >= 22). */
  socketImpl?: typeof WebSocket;
  /** Block Kit interactions: button clicks and modal submissions.
   *
   *  Kept OFF the envelope stream on purpose. An envelope is a message a person sent to the agent,
   *  and a button press is not that — routing it as one would put "connect_claude" through the
   *  harness as if somebody had typed it. */
  onInteraction?: (p: SlackInteraction) => void;
  /** A registered slash command (`/status`, `/connect`). Like `onInteraction` it is kept OFF the
   *  envelope stream: a slash carries no `thread_ts` and expects its reply on a one-shot
   *  `response_url`, not the channel. The handler returns the text to post back (ephemerally), or
   *  null/"" to post nothing. Wired after construction via `setSlashHandler`, once the worker has
   *  the dispatcher — the same reason `onInteraction` is. */
  onSlash?: (input: SlashInput) => Promise<string | null>;
}

/** A slash command, normalized for the worker's `!` dispatcher. `text` is already the `!`-prefixed
 *  command line (`/status` → `!status`, `/connect plaud` → `!connect plaud`), so the SAME parser and
 *  dispatch answer both; `conversation` is the channel with no thread; `user` is who typed it. */
export interface SlashInput {
  text: string;
  conversation: string;
  user: string;
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
  /** Which modal was submitted. There is more than one now — connecting Claude and connecting
   *  Plaud both end in a dialog — and without this a handler cannot tell them apart, so the first
   *  one registered would take a Plaud address and try it as a Claude authorization code. */
  callbackId?: string;
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

/** The `slash_commands` socket payload — form fields, not an event, so it does not share the event
 *  shape above. `response_url` is a one-shot reply endpoint (good for ~30 min / 5 posts), and there
 *  is no `thread_ts`: a slash is not typed inside a thread the way a message is. */
interface SlashPayload {
  command?: string; // "/status"
  text?: string; // everything the person typed after the command word
  response_url?: string;
  channel_id?: string;
  user_id?: string;
  team_id?: string;
  trigger_id?: string; // used to dedup a slow-ack redelivery, as `ts` does for events
}

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  /** The authenticated download URL (`url_private_download`), or the inline one. Fetched with the
   *  bot token — a private file is not public, so the token IS the access. */
  url_private_download?: string;
  url_private?: string;
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
  /** Files attached to THIS message. Only present on a message the agent was addressed in, so this
   *  never picks up a `file_shared` event for something dropped elsewhere in the workspace. */
  files?: SlackFile[];
}

/** Files larger than this are skipped rather than pulled onto the volume — a multi-hundred-MB
 *  recording attached to a message is not something to download on a whim. Receipts and photos are
 *  comfortably under it. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Extensions trusted from the file's name when the magic bytes are unrecognised — text and audio,
 *  which have no single signature. `claude`'s Read keys on the extension to know how to open it. */
const TRUSTED_EXT = new Set([
  ".txt", ".md", ".csv", ".json", ".log", ".xml", ".yaml", ".yml",
  ".m4a", ".mp3", ".wav", ".ogg", ".opus", ".aac", ".flac",
]);

/** PURE: the file's real extension from its MAGIC BYTES (authoritative), else a trusted name
 *  extension, else `.bin`. Covers the image/PDF set `claude` can read AND audio, which it cannot
 *  transcribe but should still see named correctly rather than as an opaque `.bin`. */
export function sniffMedia(buf: Buffer, name?: string): string {
  const b = (i: number): number => (i < buf.length ? buf[i]! : -1);
  const ascii = (off: number, s: string): boolean => buf.toString("latin1", off, off + s.length) === s;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return ".jpg";
  if (b(0) === 0x89 && ascii(1, "PNG")) return ".png";
  if (ascii(0, "GIF8")) return ".gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return ".webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return ".wav";
  if (ascii(0, "%PDF")) return ".pdf";
  if (ascii(0, "ID3") || (b(0) === 0xff && (b(1) & 0xe0) === 0xe0)) return ".mp3";
  if (ascii(4, "ftyp")) {
    if (ascii(8, "heic") || ascii(8, "heix") || ascii(8, "mif1") || ascii(8, "heif")) return ".heic";
    if (ascii(8, "M4A") || ascii(8, "mp4") || ascii(8, "isom")) return ".m4a";
  }
  const ext = path.extname(name || "").toLowerCase();
  return TRUSTED_EXT.has(ext) ? ext : ".bin";
}

export class SlackConnector implements Connector {
  /** Recently handled event keys, to drop a redelivery if our ack was slow. Bounded — a
   *  redelivery arrives seconds later, so a short memory is enough and never grows. */
  private readonly seen = new Set<string>();
  /** Content key → when it was last accepted. The second line of defence against one message
   *  becoming two turns; see normalize(). */
  private readonly recentContent = new Map<string, number>();
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

        // A registered slash command. It rides this socket but is not a message: no `thread_ts`,
        // and its reply belongs on the one-shot `response_url` (ephemeral — a `/status` read or a
        // `/connect` login link is personal, and the channel should not see it), not the channel.
        // The ack already went out above. We dedup on `trigger_id` the same way `normalize` dedups
        // an event on `ts`, then route the SAME text a `!` command produces through the worker's
        // dispatcher — one code path answers both prefixes.
        if (frame.type === "slash_commands" && frame.payload) {
          const p = frame.payload as unknown as SlashPayload;
          const key = `slash:${p.trigger_id ?? `${p.command}:${p.channel_id}:${p.user_id}`}`;
          if (this.seen.has(key)) return;
          this.seen.add(key);
          if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);
          const conversation = conversationKey(p.team_id ?? "", p.channel_id ?? "");
          const text = `!${(p.command ?? "").replace(/^\//, "")}${p.text ? ` ${p.text}` : ""}`.trim();
          const responseUrl = p.response_url;
          void (async () => {
            try {
              const out = await this.o.onSlash?.({ text, conversation, user: p.user_id ?? "" });
              if (out && responseUrl) await this.respondUrl(responseUrl, out);
            } catch (e) {
              console.error(`slack: slash ${p.command} failed: ${(e as Error).message}`);
              if (responseUrl) await this.respondUrl(responseUrl, "Sorry — that command failed.").catch(() => {});
            }
          })();
          return;
        }

        if (frame.type !== "events_api" || !frame.payload?.event) return;
        // The ack already went out above, so downloading attachments here (async) cannot cause a
        // redelivery. Errors are handled inside normalize; a rejected promise would only mean no
        // envelope, never a crash of the socket handler.
        void this.normalize(frame.payload.event, frame.payload.team_id ?? "")
          .then((env) => {
            if (env) push(env);
          })
          .catch((e) => console.error(`slack: normalize failed: ${(e as Error).message}`));
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

  /** Register the slash-command handler after construction — same timing reason as the interaction
   *  handler: the worker only has the `!`-command dispatcher once its deps are built. */
  setSlashHandler(fn: (input: SlashInput) => Promise<string | null>): void {
    this.o.onSlash = fn;
  }

  /** Reply to a slash command on its one-shot `response_url`. Ephemeral by default: a slash reply
   *  is personal (a status read, a login link), so the channel should not see it. Unlike `call`,
   *  the URL is not a Web API method and takes NO bot token — it wants a JSON body with
   *  `response_type` + `text`, and the text is run through the same `toMrkdwn` the channel path uses
   *  so a slash answer reads identically to a `!` one. */
  private async respondUrl(url: string, text: string, ephemeral = true): Promise<void> {
    await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        response_type: ephemeral ? "ephemeral" : "in_channel",
        text: toMrkdwn(text) || "…",
      }),
    });
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
  private async normalize(e: SlackEvent, teamID: string): Promise<Envelope | null> {
    if (e.type !== "app_mention" && !(e.type === "message" && e.channel_type === "im")) return null;
    // A subtype usually means it is not a plain human message: message_changed, message_deleted,
    // channel_join, bot_message — none of them something to answer. The ONE exception is
    // `file_share`: a person uploading a file (with an optional caption) is a real turn, and it is
    // the only way an attachment ever arrives — dropping it here is why attachments never landed.
    if (e.subtype && e.subtype !== "file_share") return null;
    if (e.bot_id) return null;
    if (!e.user || !e.channel) return null;
    if (this.botUserID && e.user === this.botUserID) return null;
    if (this.o.allowedUsers?.length && !this.o.allowedUsers.includes(e.user)) return null;

    // ONE message must be ONE turn, and Slack gives several ways for it not to be: a DM that
    // mentions the bot arrives as both message.im and app_mention; a socket that drops before our
    // ack is seen gets the envelope redelivered; and a reconnect can overlap the old connection.
    //
    // Two keys, because the first one alone was observed to miss. `channel:ts` collapses the
    // duplicate delivery of one message. The second is a short-lived content key that catches a
    // redelivery whose ts we somehow did not match — it can only ever drop a genuine repeat of the
    // identical text, by the same person, in the same channel, inside a few seconds, which is a far
    // better failure than answering everything twice.
    const ts = e.ts ?? e.event_ts ?? "";
    const key = `${e.channel}:${ts}`;
    const contentKey = `${e.channel}:${e.user}:${e.text ?? ""}`;
    const now = Date.now();
    const recent = this.recentContent.get(contentKey);
    if (this.seen.has(key) || (recent && now - recent < 5_000)) {
      if (process.env.TONOMAN_TRACE) {
        console.log(`slack: dropped duplicate ${e.type} ts=${ts} chan=${e.channel}`);
      }
      return null;
    }
    this.seen.add(key);
    this.recentContent.set(contentKey, now);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value as string);
    // Bound the content map the same way; it only needs to remember seconds.
    if (this.recentContent.size > 200) {
      for (const [k, t] of this.recentContent) if (now - t > 60_000) this.recentContent.delete(k);
    }
    if (process.env.TONOMAN_TRACE) {
      console.log(`slack: accepted ${e.type} ts=${ts} chan=${e.channel} user=${e.user}`);
    }

    return {
      channel: this.name(),
      // The conversation key, and the thing the durable half turns into a workflow id. Thread
      // is part of the identity: two threads in one channel are two conversations.
      conversation: conversationKey(teamID, e.channel, e.thread_ts),
      user: e.user,
      text: stripMention(e.text ?? ""),
      // Files attached to the message, downloaded so the turn can read them. Empty for an ordinary
      // message, which is every message today — so nothing about a text turn changes.
      mediaPaths: await this.downloadFiles(e.files ?? []),
    };
  }

  /** Download the files attached to a message into `mediaDir`, returning the paths the turn will
   *  hand the model. Best-effort per file: a failed download is logged and skipped (NEVER silent —
   *  a swallowed download is the "agent says it sees nothing" bug), and the text turn still runs. */
  private async downloadFiles(files: SlackFile[]): Promise<string[]> {
    if (!files.length || !this.o.mediaDir) return [];
    await this.cleanMedia().catch(() => {});
    const out: string[] = [];
    for (const f of files) {
      const url = f.url_private_download || f.url_private;
      if (!url) continue;
      if (typeof f.size === "number" && f.size > MAX_MEDIA_BYTES) {
        console.error(`slack: attachment "${f.name ?? f.id}" is ${f.size} bytes, over the ${MAX_MEDIA_BYTES} cap — skipping`);
        continue;
      }
      try {
        // `url_private*` is authenticated: the bot token IS the access, and the app needs the
        // `files:read` scope. Without it Slack answers 403 — logged here, not swallowed.
        const resp = await this.fetch(url, { headers: { authorization: `Bearer ${this.o.botToken}` } });
        if (!resp.ok) throw new Error(`http ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const ext = sniffMedia(buf, f.name);
        await fs.mkdir(this.o.mediaDir, { recursive: true });
        const file = `${randomUUID()}${ext}`;
        await fs.writeFile(path.join(this.o.mediaDir, file), buf);
        out.push(this.o.mediaMount ? `${this.o.mediaMount}/${file}` : path.join(this.o.mediaDir, file));
      } catch (err) {
        console.error(`slack: attachment download failed (${f.mimetype ?? "?"}): ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Remove downloaded attachments older than a day, so a volume does not accumulate every receipt
   *  anyone ever sent. Best-effort: a turn is never held up or failed over cleanup. */
  private async cleanMedia(): Promise<void> {
    if (!this.o.mediaDir) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await fs.readdir(this.o.mediaDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = path.join(this.o.mediaDir, name);
      const st = await fs.stat(p).catch(() => undefined);
      if (st && st.isFile() && st.mtimeMs < cutoff) await fs.rm(p, { force: true }).catch(() => {});
    }
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
      | {
          callback_id?: string;
          private_metadata?: string;
          state?: { values?: Record<string, Record<string, { value?: string }>> };
        }
      | undefined;
    return {
      kind: "view_submission",
      userId: user,
      callbackId: view?.callback_id,
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

/** PURE: every input a modal collected, keyed by BLOCK id.
 *
 *  `firstInputValue` answers "the one thing they typed", which is right for a dialog that asks for
 *  a code. A connector that collects a name AND a URL needs them apart, and the block id is the
 *  only name the sender controls — so the modal sets one block per field and reads them back here.
 *  Empty inputs are dropped rather than returned blank, so a caller can ask "is it there". */
export function inputValues(
  values?: Record<string, Record<string, { value?: string }>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [blockId, block] of Object.entries(values ?? {})) {
    for (const input of Object.values(block)) {
      if (input?.value && input.value.trim()) {
        out[blockId] = input.value.trim();
        break;
      }
    }
  }
  return out;
}

/** PURE: drop the leading `<@U123>` the platform prepends to an app_mention, so the harness sees
 *  the sentence the person actually typed rather than an id it has no use for. Unit-tested. */
export function stripMention(text: string): string {
  return text.replace(/<@[UWB][A-Z0-9]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Slack caps one message's text. A streamed answer that grows past the cap used to freeze at the
 *  last edit that fit — the model produced the whole thing and the person saw it cut mid-sentence.
 *  So a long final answer is split into follow-on messages in the same thread instead. 3900, not
 *  4000: the split runs on the CONVERTED mrkdwn, and there is no reason to sit on the exact edge. */
export const SLACK_MSG_LIMIT = 3900;

/** PURE: split text into pieces no longer than `limit`, cutting at the last paragraph break before
 *  the cap, else the last line break, else a hard cut. A code fence left open by a cut is closed at
 *  the end of its piece and reopened at the start of the next, so no piece renders as broken
 *  markdown. Text within the cap returns as a single piece — the common case, unchanged. */
export function splitForSlack(text: string, limit = SLACK_MSG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit; // a single unbroken run longer than the cap — cut it hard
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, ""); // the boundary newlines belong to neither piece
  }
  if (rest) pieces.push(rest);
  // Carry an unbalanced ``` fence across the boundary so neither piece renders as broken code.
  // `open` is the true fence state entering a piece; `odd` is whether the piece's OWN fences flip it.
  let open = false;
  return pieces.map((p) => {
    const odd = ((p.match(/```/g) || []).length % 2) === 1;
    let out = open ? "```\n" + p : p; // a block left open by the previous piece: reopen it here
    const nowOpen = open !== odd;
    if (nowOpen) out = out + "\n```"; // this piece leaves a block open: close it at its own end
    open = nowOpen;
    return out;
  });
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
    // Slack speaks mrkdwn, not markdown. Converting here rather than at each call site means every
    // outbound path — answers, notices, the work log — is translated exactly once.
    //
    // Splits, for the ONE case that reaches send() with a whole long answer: a turn that delivered
    // everything in a final event with no streamed deltas, so `oneTurn` posts fresh rather than
    // editing. A streaming partial arrives here too but is small (the first ~second of output), so
    // it is one message and is superseded by the next update exactly as before.
    const pieces = splitForSlack(toMrkdwn(text) || "…");
    let first = "";
    for (let i = 0; i < pieces.length; i++) {
      const ts = await this.postRaw(pieces[i]!);
      if (i === 0) first = ts;
    }
    return first;
  }

  private async postRaw(mrkdwn: string): Promise<string> {
    const res = await this.c.call<{ ts?: string }>("chat.postMessage", {
      channel: this.target.channel,
      text: mrkdwn || "…",
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

  /** The FINAL answer, which unlike an intermediate update is not superseded by anything — so it
   *  must actually land. A long answer is split across follow-on messages in the same thread rather
   *  than frozen at the last chunk that fit (the bug where the model wrote the whole thing and the
   *  person saw it cut mid-sentence). `msgID` empty = nothing streamed, so post the first piece fresh. */
  async finalize(msgID: string, text: string): Promise<void> {
    const pieces = splitForSlack(toMrkdwn(text) || "…");
    if (msgID) await this.editFinal(msgID, pieces[0]!);
    else await this.postRaw(pieces[0]!);
    for (let i = 1; i < pieces.length; i++) await this.postRaw(pieces[i]!);
  }

  private async edit(msgID: string, text: string): Promise<void> {
    if (!msgID) return;
    try {
      await this.c.call("chat.update", { channel: this.target.channel, ts: msgID, text: toMrkdwn(text) || "…" });
    } catch (e) {
      // Slack rejects an edit that changes nothing, and rate-limits a fast stream. Neither is
      // worth failing a turn over — the next update carries the same text forward. This is ONLY for
      // intermediate updates; the final answer goes through editFinal, which must not vanish.
      const m = (e as Error).message;
      if (/msg_too_long|ratelimited|edit_window_closed/.test(m)) return;
      throw e;
    }
  }

  /** Edit for the FINAL piece: unlike `edit`, a rate-limited final is retried once rather than
   *  dropped (dropping it is exactly how a complete answer ended up frozen at a partial), and a
   *  genuine `msg_too_long` is surfaced rather than swallowed — a piece is ≤ the cap, so it means a
   *  real bug, not a superseded edit. */
  private async editFinal(msgID: string, mrkdwn: string): Promise<void> {
    try {
      await this.c.call("chat.update", { channel: this.target.channel, ts: msgID, text: mrkdwn || "…" });
    } catch (e) {
      const m = (e as Error).message;
      if (/ratelimited/.test(m)) {
        await new Promise((r) => setTimeout(r, 1200));
        await this.c.call("chat.update", { channel: this.target.channel, ts: msgID, text: mrkdwn || "…" }).catch(() => {});
        return;
      }
      if (/edit_window_closed/.test(m)) return; // the message is too old to edit; nothing to do
      throw e;
    }
  }

  /** The status cue.
   *
   *  Slack gives apps no typing indicator in an ordinary channel — that was only ever available to
   *  real user sessions over RTM. But in an **assistant thread** (the Agents & AI Apps surface)
   *  `assistant.threads.setStatus` renders a proper "Nelly is thinking…" line under the composer,
   *  and it takes arbitrary text, so tool narration goes there instead of into the answer.
   *
   *  Only meaningful inside an assistant thread, which is a DM with a thread. Elsewhere Slack
   *  answers with an error and the streamed message remains the only cue — so a failure here is
   *  swallowed rather than costing a turn. */
  async working(status?: string): Promise<void> {
    if (!this.target.threadTs) return; // not an assistant thread; nothing to set
    try {
      await this.c.call("assistant.threads.setStatus", {
        channel_id: this.target.channel,
        thread_ts: this.target.threadTs,
        status: (status ?? "is thinking").slice(0, 100),
      });
    } catch {
      /* not an assistant thread, or the scope is missing — the message itself is still the cue */
    }
  }

  /** Clear the status. Slack leaves "is thinking…" on screen until it is set to empty, so an
   *  answered turn that forgets this looks permanently busy. */
  async settle(): Promise<void> {
    if (!this.target.threadTs) return;
    try {
      await this.c.call("assistant.threads.setStatus", {
        channel_id: this.target.channel,
        thread_ts: this.target.threadTs,
        status: "",
      });
    } catch {
      /* best effort */
    }
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
