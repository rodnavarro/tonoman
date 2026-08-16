// The Telegram connector (A1): owns its inbound transport (getUpdates long-poll),
// downloads media to a shared mount the sandbox can Read, normalizes messages to a
// neutral Envelope, and delivers replies over send / update / finalize
// (editMessageText). The only Telegram-specific code in the gateway; the router
// never sees any of it.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Connector, Envelope, Reply } from "../core/contracts";
import type { ConvStore } from "./convstore";

export interface ConnectorOptions {
  token: string; // bot token the gateway owns exclusively (one token = one poller)
  mediaDir?: string; // host dir to download media into (host side of the shared mount)
  mediaMount?: string; // container-visible path for mediaDir (cross-FS mounts)
  allowedUser?: string; // optional allow-list: username or numeric id; empty = accept all
  apiBase?: string; // default https://api.telegram.org
  fileBase?: string; // default https://api.telegram.org/file
  pollTimeout?: number; // long-poll seconds; default 30
  fetchImpl?: typeof fetch; // injectable for tests; defaults to global fetch
  // Records who each chat belongs to so a wake can address a PERSON rather than
  // a chat id. Telegram has no restart problem (chat ids are stable), but the
  // person index is the same need on every channel.
  convStore?: ConvStore<unknown>;
}

export class TelegramConnector implements Connector {
  constructor(private readonly o: ConnectorOptions) {}

  name(): string {
    return "telegram";
  }

  private apiBase(): string {
    return this.o.apiBase || "https://api.telegram.org";
  }
  private fileBase(): string {
    return this.o.fileBase || "https://api.telegram.org/file";
  }
  private url(method: string): string {
    return `${this.apiBase()}/bot${this.o.token}/${method}`;
  }

  /** Long-polls getUpdates and yields envelopes until the signal aborts. */
  async *receive(signal: AbortSignal): AsyncIterable<Envelope> {
    let offset = 0;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.getUpdates(offset, signal);
      } catch {
        // transient transport error: back off briefly, don't spin.
        await sleep(2000, signal);
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        const env = await this.normalize(u);
        if (env) yield env;
      }
    }
  }

  reply(conversation: string): Reply {
    return new TelegramReply(this, conversation);
  }

  /** Registers the bot's command menu (Telegram setMyCommands) so `/new` etc. show
   * in the `/` autocomplete. Best-effort — a failure never blocks serving. */
  async registerCommands(commands: { command: string; description: string }[]): Promise<void> {
    try {
      await this.call("setMyCommands", { commands });
    } catch {
      /* menu registration is a nicety, not required to serve */
    }
  }

  // --- inbound -------------------------------------------------------------

  private async getUpdates(offset: number, signal: AbortSignal): Promise<Update[]> {
    const timeout = this.o.pollTimeout && this.o.pollTimeout > 0 ? this.o.pollTimeout : 30;
    return (await this.call<Update[]>("getUpdates", { offset, timeout }, signal)) ?? [];
  }

  /** Turns a Telegram update into a neutral envelope, applying the allow-list and
   * downloading any photo to the shared mount. */
  private async normalize(u: Update): Promise<Envelope | null> {
    if (u.callback_query) return this.normalizeCallback(u.callback_query);
    const m = u.message;
    if (!m) return null;
    const user = m.from?.username || m.from?.first_name || "";
    const uid = m.from ? String(m.from.id) : "";
    if (this.o.allowedUser && this.o.allowedUser !== user && this.o.allowedUser !== uid) {
      return null; // not on the allow-list
    }
    const chat = String(m.chat.id);
    this.o.convStore?.put(chat, { chatId: chat }, [
      user,
      uid,
      m.from?.first_name ?? "",
    ]);
    const env: Envelope = {
      channel: this.name(),
      conversation: chat,
      user,
      text: m.text || m.caption || "",
      mediaPaths: [],
    };
    if (m.photo && m.photo.length > 0) {
      // Telegram sends several resolutions; the largest is last.
      const largest = m.photo[m.photo.length - 1];
      try {
        env.mediaPaths = [await this.downloadFile(largest.file_id)];
      } catch {
        /* media download failure is non-fatal */
      }
    }
    return env;
  }

  /** A tapped inline button (gw-command-statusline): ack it (stop the spinner) and route
   * its `data` as a normal inbound message, so the pick flows through command dispatch. */
  private async normalizeCallback(cq: CallbackQuery): Promise<Envelope | null> {
    const user = cq.from?.username || cq.from?.first_name || "";
    const uid = cq.from ? String(cq.from.id) : "";
    if (this.o.allowedUser && this.o.allowedUser !== user && this.o.allowedUser !== uid) return null;
    void this.call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {}); // best-effort ack
    const chat = cq.message?.chat?.id;
    if (chat == null || !cq.data) return null;
    return { channel: this.name(), conversation: String(chat), user, text: cq.data, mediaPaths: [] };
  }

  /** Resolves a file_id and saves it under mediaDir, returning the sandbox path. */
  private async downloadFile(fileID: string): Promise<string> {
    const f = await this.call<{ file_path: string }>("getFile", { file_id: fileID });
    if (!f?.file_path) throw new Error("telegram: getFile returned no path");
    if (!this.o.mediaDir) throw new Error("telegram: no mediaDir configured");
    await fs.mkdir(this.o.mediaDir, { recursive: true });
    const dlURL = `${this.fileBase()}/bot${this.o.token}/${f.file_path}`;
    const resp = await fetch(dlURL);
    if (!resp.ok) throw new Error(`telegram: download ${f.file_path}: status ${resp.status}`);
    const ext = path.extname(f.file_path) || ".jpg";
    const name = fileID + ext;
    const buf = Buffer.from(await resp.arrayBuffer());
    await fs.writeFile(path.join(this.o.mediaDir, name), buf); // write bytes host-side
    // Reference by the container-visible path so the sandbox can Read it.
    return this.o.mediaMount ? `${this.o.mediaMount}/${name}` : path.join(this.o.mediaDir, name);
  }

  // --- transport -----------------------------------------------------------

  /** POSTs a JSON payload to a Bot API method and returns the decoded result.
   * Retries **transport** failures (a thrown `fetch` — e.g. "fetch failed" network
   * blips) a few times with backoff, so a transient hiccup never aborts a turn. A
   * Telegram **API** error (ok:false, e.g. "message is not modified") is NOT retried —
   * it's returned to the caller (edit() handles "not modified"). */
  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T | null> {
    const doFetch = this.o.fetchImpl ?? fetch;
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await doFetch(this.url(method), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
        const env = (await resp.json()) as { ok: boolean; result?: T; description?: string };
        if (!env.ok) throw new Error(`telegram: ${method} failed: ${env.description ?? resp.status}`);
        return env.result ?? null;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw e;
        // Only transport-level failures are transient (a thrown fetch is a TypeError in
        // undici, e.g. "fetch failed"). API errors (our thrown Error above) are not retried.
        const transient = e instanceof TypeError;
        if (!transient || attempt === maxAttempts) throw e;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    throw lastErr;
  }
}

class TelegramReply implements Reply {
  constructor(private readonly c: TelegramConnector, private readonly chatID: string) {}

  canEdit(): boolean {
    return true;
  }

  async send(text: string): Promise<string> {
    const res = await this.c.call<{ message_id: number }>("sendMessage", {
      chat_id: chatIDValue(this.chatID),
      text,
    });
    return res ? String(res.message_id) : "";
  }

  /** Edits the streaming message with plain text (mid-stream markdown could be
   * half-formed, so we don't parse it until finalize). */
  async update(msgID: string, text: string): Promise<void> {
    await this.edit(msgID, text, "");
  }

  /** Renders the final reply with a small markdown subset as Telegram HTML
   * (so **bold** / `code` display), falling back to plain text if rejected. */
  async finalize(msgID: string, text: string): Promise<void> {
    try {
      await this.edit(msgID, mdToTelegramHTML(text), "HTML");
    } catch {
      await this.edit(msgID, text, ""); // formatting rejected → plain
    }
  }

  private async edit(msgID: string, text: string, parseMode: string): Promise<void> {
    const payload: Record<string, unknown> = {
      chat_id: chatIDValue(this.chatID),
      message_id: Number(msgID),
      text,
    };
    if (parseMode) payload.parse_mode = parseMode;
    try {
      await this.c.call("editMessageText", payload);
    } catch (e) {
      if ((e as Error).message.includes("message is not modified")) return; // no-op edit
      throw e;
    }
  }

  /** Posts a message with a single row of tappable inline buttons; each button's
   * `callback_data` is its choice (gw-command-statusline). */
  async sendChoices(text: string, choices: { label: string; data: string }[]): Promise<string> {
    const res = await this.c.call<{ message_id: number }>("sendMessage", {
      chat_id: chatIDValue(this.chatID),
      text,
      reply_markup: { inline_keyboard: [choices.map((c) => ({ text: c.label, callback_data: c.data }))] },
    });
    return res ? String(res.message_id) : "";
  }

  /** Standalone notice (teams parity): post / edit-by-id / delete a plain message, stateless across
   * reply instances — what the gateway's queue footer needs. text=null deletes. Best-effort. */
  async note(id: string | undefined, text: string | null): Promise<string> {
    try {
      if (id && text === null) {
        await this.c.call("deleteMessage", { chat_id: chatIDValue(this.chatID), message_id: Number(id) });
        return "";
      }
      if (id) { await this.edit(id, text ?? "", ""); return id; }
      return await this.send(text ?? "");
    } catch {
      return id ?? ""; // a dropped notice never costs a turn
    }
  }

  /** Shows Telegram's "typing…" indicator (expires ~5s; the router re-sends it). */
  async working(): Promise<void> {
    try {
      await this.c.call("sendChatAction", { chat_id: chatIDValue(this.chatID), action: "typing" });
    } catch {
      /* activity cue is best-effort */
    }
  }
}

/** Sends a numeric chat id as a number, falling back to a string. */
function chatIDValue(s: string): number | string {
  const n = Number(s);
  return Number.isInteger(n) && String(n) === s ? n : s;
}

/** Converts a small CommonMark subset (headings, bullets, **bold**, `code`,
 * *italic*) to Telegram HTML, with readable block spacing applied first. Telegram
 * HTML needs only &,<,> escaped; we normalize spacing, escape, then insert tags. */
export function mdToTelegramHTML(s: string): string {
  s = normalizeBlocks(s);
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>"); // headings → bold (own line)
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  return s;
}

/** Makes a chat reply readable: normalizes bullets to "• ", puts a blank line around
 * headings, and collapses runaway blank lines — turning a wall of text into spaced
 * blocks. Content is preserved; only whitespace/markers change. */
export function normalizeBlocks(s: string): string {
  const lines = s.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  const isHeading = (l: string) => /^#{1,6}[ \t]+\S/.test(l);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (/^[ \t]*[-*+][ \t]+\S/.test(l)) l = l.replace(/^[ \t]*[-*+][ \t]+/, "• "); // bullet marker
    if (isHeading(l) && out.length > 0 && out[out.length - 1] !== "") out.push(""); // blank before heading
    out.push(l);
    if (isHeading(l) && lines[i + 1] !== undefined && lines[i + 1] !== "") out.push(""); // blank after heading
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// --- Bot API shapes (only the fields we route on) --------------------------

interface Update {
  update_id: number;
  message?: TgMessage;
  callback_query?: CallbackQuery;
}
interface CallbackQuery {
  id: string;
  from?: { id: number; username?: string; first_name?: string };
  message?: { chat: { id: number } };
  data?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number; height: number }[];
}
