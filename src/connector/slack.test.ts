import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { SlackConnector, stripMention, conversationKey, repliesToOwnThread, parseConversation, splitForSlack, SLACK_MSG_LIMIT, sniffMedia } from "./slack";

describe("sniffMedia — name an attachment by what it IS, so claude's Read opens it right", () => {
  it("reads the magic bytes for images, pdf and audio", () => {
    expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff]))).toBe(".jpg");
    expect(sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(".png");
    expect(sniffMedia(Buffer.from("%PDF-1.7"))).toBe(".pdf");
    expect(sniffMedia(Buffer.from("ID3"))).toBe(".mp3");
    expect(sniffMedia(Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"))).toBe(".wav");
    expect(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("ftypM4A ")]))).toBe(".m4a");
  });
  it("falls back to a TRUSTED name extension for text and audio that have no signature", () => {
    expect(sniffMedia(Buffer.from("hello"), "notes.txt")).toBe(".txt");
    expect(sniffMedia(Buffer.from("blob"), "memo.m4a")).toBe(".m4a");
  });
  it("is .bin for the unknown, so a bogus name can never mislabel a file", () => {
    expect(sniffMedia(Buffer.from("blob"), "weird.net")).toBe(".bin");
    expect(sniffMedia(Buffer.from("blob"))).toBe(".bin");
  });
});

describe("splitForSlack — a long answer becomes follow-on messages, never a cut one", () => {
  it("leaves a short answer as a single piece, unchanged", () => {
    expect(splitForSlack("hello")).toEqual(["hello"]);
    const justUnder = "x".repeat(SLACK_MSG_LIMIT);
    expect(splitForSlack(justUnder)).toEqual([justUnder]);
  });

  it("splits a long answer into pieces that are each within the cap", () => {
    const para = "A paragraph that is reasonably long. ".repeat(30).trim(); // ~1100 chars
    const text = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n\n${para}`).join("\n\n"); // ~9k chars
    const pieces = splitForSlack(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(SLACK_MSG_LIMIT);
    // Nothing is lost: the words survive in order (boundary whitespace aside).
    expect(pieces.join("\n\n").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("hard-cuts a single unbroken run longer than the cap rather than looping", () => {
    const pieces = splitForSlack("y".repeat(SLACK_MSG_LIMIT * 2 + 50));
    expect(pieces.length).toBe(3);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(SLACK_MSG_LIMIT);
  });

  it("never leaves a code fence open across a boundary", () => {
    // A fenced block straddling the cap would render as broken code in the first piece.
    const code = "```\n" + "console.log('x');\n".repeat(300) + "```"; // one big fence, >cap
    const pieces = splitForSlack("intro\n\n" + code + "\n\noutro");
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect((p.match(/```/g) || []).length % 2).toBe(0); // balanced in every piece
    }
  });
});

describe("stripMention", () => {
  it("drops the leading bot mention and normalizes whitespace", () => {
    expect(stripMention("<@U123ABC> what are my meetings?")).toBe("what are my meetings?");
  });
  it("drops a mention anywhere in the text, not just the front", () => {
    expect(stripMention("hey <@U123ABC>  can you check")).toBe("hey can you check");
  });
  it("leaves a message with no mention alone", () => {
    expect(stripMention("plain dm text")).toBe("plain dm text");
  });
});

describe("conversation keys", () => {
  it("round-trips a channel conversation", () => {
    const k = conversationKey("T1", "C2");
    expect(k).toBe("T1/C2");
    expect(parseConversation(k)).toEqual({ team: "T1", channel: "C2", threadTs: undefined });
  });
  it("keeps the thread as part of the identity — two threads are two conversations", () => {
    const a = conversationKey("T1", "C2", "1699.0001");
    const b = conversationKey("T1", "C2", "1699.0002");
    expect(a).not.toBe(b);
    expect(parseConversation(a).threadTs).toBe("1699.0001");
  });
});

/** A minimal stand-in for the Socket Mode WebSocket: records what we sent back (the acks) and
 *  lets a test push frames down as if Slack had. */
class FakeSocket {
  static last: FakeSocket | undefined;
  readonly sent: string[] = [];
  onmessage?: (ev: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public readonly url: string) {
    FakeSocket.last = this;
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(): void {
    this.onclose?.();
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function connector(): { conn: SlackConnector; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const method = String(url).split("/").pop()!;
    calls.push(method);
    const body =
      method === "apps.connections.open"
        ? { ok: true, url: "wss://example.invalid/link" }
        : method === "auth.test"
          ? { ok: true, user_id: "UBOT" }
          : { ok: true, ts: "111.222" };
    return { json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;

  const conn = new SlackConnector({
    appToken: "xapp-test",
    botToken: "xoxb-test",
    fetchImpl,
    socketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  return { conn, calls };
}

/** Drives receive() until it has yielded `want` envelopes, then aborts. */
async function collect(
  conn: SlackConnector,
  want: number,
  drive: (sock: FakeSocket) => void,
): Promise<{ envs: Awaited<ReturnType<typeof first>>[]; sock: FakeSocket }> {
  const ac = new AbortController();
  const envs: never[] = [] as never[];
  const it = conn.receive(ac.signal)[Symbol.asyncIterator]();
  // Let receive() reach the socket before frames are pushed.
  const pump = (async (): Promise<void> => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    drive(FakeSocket.last!);
  })();
  const out: unknown[] = [];
  for (let i = 0; i < want; i++) out.push((await it.next()).value);
  await pump;
  ac.abort();
  return { envs: out as never[], sock: FakeSocket.last! };
}
type first = never;

describe("SlackConnector.receive", () => {
  it("acks every envelope before doing any work, so Slack does not redeliver", async () => {
    const { conn } = connector();
    const { sock } = await collect(conn, 1, (s) =>
      s.push({
        type: "events_api",
        envelope_id: "env-1",
        payload: { team_id: "T1", event: { type: "app_mention", channel: "C9", user: "U7", text: "<@UBOT> hi", ts: "1.1" } },
      }),
    );
    expect(sock.sent.map((s) => JSON.parse(s))).toContainEqual({ envelope_id: "env-1" });
  });

  it("normalizes a mention into an envelope with the mention stripped", async () => {
    const { conn } = connector();
    const { envs } = await collect(conn, 1, (s) =>
      s.push({
        type: "events_api",
        envelope_id: "e",
        payload: { team_id: "T1", event: { type: "app_mention", channel: "C9", user: "U7", text: "<@UBOT> hi", ts: "1.1" } },
      }),
    );
    expect(envs[0]).toMatchObject({ channel: "slack", conversation: "T1/C9", user: "U7", text: "hi" });
  });

  it("collapses the duplicate a DM-with-mention produces, so one message is one turn", async () => {
    const { conn } = connector();
    // Slack delivers a DM that mentions the bot as BOTH message.im and app_mention, same ts.
    const { envs } = await collect(conn, 2, (s) => {
      s.push({
        type: "events_api",
        envelope_id: "a",
        payload: { team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", user: "U7", text: "<@UBOT> yo", ts: "5.5" } },
      });
      s.push({
        type: "events_api",
        envelope_id: "b",
        payload: { team_id: "T1", event: { type: "app_mention", channel: "D1", user: "U7", text: "<@UBOT> yo", ts: "5.5" } },
      });
      // A second, genuinely different message proves the dedupe is per-ts, not a stuck gate.
      s.push({
        type: "events_api",
        envelope_id: "c",
        payload: { team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", user: "U7", text: "again", ts: "6.6" } },
      });
    });
    expect(envs.map((e: { text: string }) => e.text)).toEqual(["yo", "again"]);
  });

  it("ignores our own posts, bot messages and edits", async () => {
    const { conn } = connector();
    const { envs } = await collect(conn, 1, (s) => {
      s.push({ type: "events_api", envelope_id: "1", payload: { team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", user: "UBOT", text: "self", ts: "1" } } });
      s.push({ type: "events_api", envelope_id: "2", payload: { team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", bot_id: "B1", text: "bot", ts: "2" } } });
      s.push({ type: "events_api", envelope_id: "3", payload: { team_id: "T1", event: { type: "message", subtype: "message_changed", channel_type: "im", channel: "D1", user: "U7", text: "edit", ts: "3" } } });
      s.push({ type: "events_api", envelope_id: "4", payload: { team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", user: "U7", text: "real", ts: "4" } } });
    });
    expect(envs[0]).toMatchObject({ text: "real" });
  });

  it("ignores channel chatter it was not addressed in", async () => {
    const { conn } = connector();
    const { envs } = await collect(conn, 1, (s) => {
      // A plain channel message (no channel_type "im", not an app_mention) is not ours.
      s.push({ type: "events_api", envelope_id: "1", payload: { team_id: "T1", event: { type: "message", channel: "C9", user: "U7", text: "team chatter", ts: "1" } } });
      s.push({ type: "events_api", envelope_id: "2", payload: { team_id: "T1", event: { type: "app_mention", channel: "C9", user: "U7", text: "<@UBOT> now me", ts: "2" } } });
    });
    expect(envs[0]).toMatchObject({ text: "now me" });
  });

  it("downloads an attached file with the bot token and hands the turn its path, named by content", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "slack-media-"));
    let authHeader = "";
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes("/download/")) {
        authHeader = init?.headers?.authorization ?? "";
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
        return { ok: true, arrayBuffer: async () => png } as unknown as Response;
      }
      const method = String(url).split("/").pop()!;
      const body =
        method === "apps.connections.open"
          ? { ok: true, url: "wss://example.invalid/link" }
          : method === "auth.test"
            ? { ok: true, user_id: "UBOT" }
            : { ok: true };
      return { json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const conn = new SlackConnector({
      appToken: "xapp",
      botToken: "xoxb-secret",
      fetchImpl,
      socketImpl: FakeSocket as unknown as typeof WebSocket,
      mediaDir: dir,
      mediaMount: dir,
    });
    const { envs } = await collect(conn, 1, (s) =>
      s.push({
        type: "events_api",
        envelope_id: "e",
        payload: {
          team_id: "T1",
          event: {
            type: "message",
            // Real Slack tags a message carrying an upload as `file_share` — the connector must
            // still answer it, or the attachment (and its caption) is dropped entirely.
            subtype: "file_share",
            channel_type: "im",
            channel: "D1",
            user: "U7",
            text: "<@UBOT> what's on this receipt",
            ts: "1.1",
            files: [{ id: "F1", name: "receipt.jpg", size: 8, url_private_download: "https://files.slack.com/files-pri/T1-F1/download/receipt.jpg" }],
          },
        },
      }),
    );
    const env = envs[0] as unknown as { text: string; mediaPaths: string[] };
    expect(authHeader).toBe("Bearer xoxb-secret"); // the bot token IS the access to a private file
    expect(env.mediaPaths).toHaveLength(1);
    // Named by its MAGIC BYTES (png), not the .jpg in the name — so Read treats it correctly.
    expect(env.mediaPaths[0]).toMatch(/\.png$/);
    expect(env.text).toBe("what's on this receipt"); // the text turn is unchanged alongside the file
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("threads the conversation key so two threads in one channel stay separate", async () => {
    const { conn } = connector();
    const { envs } = await collect(conn, 1, (s) =>
      s.push({
        type: "events_api",
        envelope_id: "e",
        payload: { team_id: "T1", event: { type: "app_mention", channel: "C9", user: "U7", text: "<@UBOT> in thread", ts: "9.9", thread_ts: "8.8" } },
      }),
    );
    expect(envs[0]).toMatchObject({ conversation: "T1/C9/8.8" });
  });

  it("applies the user allow-list", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      const method = String(url).split("/").pop()!;
      calls.push(method);
      const body = method === "apps.connections.open" ? { ok: true, url: "wss://x/y" } : { ok: true, user_id: "UBOT" };
      return { json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const conn = new SlackConnector({
      appToken: "a",
      botToken: "b",
      allowedUsers: ["UOK"],
      fetchImpl,
      socketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    const { envs } = await collect(conn, 1, (s) => {
      s.push({ type: "events_api", envelope_id: "1", payload: { team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", user: "UNOPE", text: "blocked", ts: "1" } } });
      s.push({ type: "events_api", envelope_id: "2", payload: { team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", user: "UOK", text: "allowed", ts: "2" } } });
    });
    expect(envs[0]).toMatchObject({ text: "allowed" });
  });
});

describe("SlackConnector — watched channel (reply-in-thread, Wave 6)", () => {
  /** A connector that watches one channel, exactly as `wireVoice` wires it when a Talent's
   *  `reply_in_thread` config is on. `watchedChannels` is a live callback — read per message — so a
   *  test can flip what it returns and see the next message treated differently, which is the point. */
  function watching(watched: () => Set<string>): SlackConnector {
    const fetchImpl = (async (url: string) => {
      const method = String(url).split("/").pop()!;
      const body =
        method === "apps.connections.open"
          ? { ok: true, url: "wss://x/y" }
          : method === "auth.test"
            ? { ok: true, user_id: "UBOT" }
            : { ok: true, ts: "1.1" };
      return { json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return new SlackConnector({
      appToken: "a",
      botToken: "b",
      fetchImpl,
      socketImpl: FakeSocket as unknown as typeof WebSocket,
      watchedChannels: watched,
    });
  }

  it("admits a plain (un-mentioned) message in a watched channel and roots its own thread", async () => {
    const conn = watching(() => new Set(["C-WATCH"]));
    const { envs } = await collect(conn, 1, (s) =>
      s.push({
        type: "events_api",
        envelope_id: "e",
        // A public-channel message: channel_type "channel", NO @mention. Today this is dropped;
        // in a watched channel it is a turn, threaded on its own ts so the reply lands under it.
        payload: { team_id: "T1", event: { type: "message", channel_type: "channel", channel: "C-WATCH", user: "U7", text: "any recap on the standup?", ts: "3.3" } },
      }),
    );
    expect(envs[0]).toMatchObject({ conversation: "T1/C-WATCH/3.3", text: "any recap on the standup?" });
  });

  it("keeps an existing thread as the root in a watched channel", async () => {
    const conn = watching(() => new Set(["C-WATCH"]));
    const { envs } = await collect(conn, 1, (s) =>
      s.push({
        type: "events_api",
        envelope_id: "e",
        payload: { team_id: "T1", event: { type: "message", channel_type: "channel", channel: "C-WATCH", user: "U7", text: "follow-up", ts: "4.4", thread_ts: "3.3" } },
      }),
    );
    expect(envs[0]).toMatchObject({ conversation: "T1/C-WATCH/3.3" });
  });

  it("still drops a plain message in a channel that is NOT watched", async () => {
    const conn = watching(() => new Set(["C-WATCH"]));
    // Junk in an unwatched channel, then a real message in the watched one: only the second yields,
    // proving the unwatched plain message was dropped (the gate is per-channel, not global).
    const { envs } = await collect(conn, 1, (s) => {
      s.push({ type: "events_api", envelope_id: "1", payload: { team_id: "T1", event: { type: "message", channel_type: "channel", channel: "C-OTHER", user: "U7", text: "not for us", ts: "1.1" } } });
      s.push({ type: "events_api", envelope_id: "2", payload: { team_id: "T1", event: { type: "message", channel_type: "channel", channel: "C-WATCH", user: "U7", text: "for us", ts: "2.2" } } });
    });
    expect(envs).toHaveLength(1);
    expect(envs[0]).toMatchObject({ text: "for us", conversation: "T1/C-WATCH/2.2" });
  });
});

describe("SlackConnector — slash commands", () => {
  /** A slash frame yields NO envelope (it is answered on `response_url`, off the stream), so we
   *  can't drive it with `collect`, which waits for envelopes. Instead: start receive(), push the
   *  frame, give the async `onSlash` → `respondUrl` a tick, then abort. Captures every non-Slack
   *  POST (the `response_url` reply) as `{ url, body }`. */
  function slashRig(handler: (input: { text: string; conversation: string; user: string }) => Promise<string | null>) {
    const posts: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      const s = String(url);
      if (s.startsWith("https://slack.com") || s.includes("/api/")) {
        const method = s.split("/").pop()!;
        const body = method === "apps.connections.open" ? { ok: true, url: "wss://x/y" } : { ok: true, user_id: "UBOT" };
        return { json: async () => body } as unknown as Response;
      }
      // The response_url reply — not a Web API method.
      posts.push({ url: s, body: init?.body ? JSON.parse(init.body) : undefined });
      return { json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const conn = new SlackConnector({ appToken: "a", botToken: "b", fetchImpl, socketImpl: FakeSocket as unknown as typeof WebSocket });
    conn.setSlashHandler(handler);
    return { conn, posts };
  }

  async function driveSlash(conn: SlackConnector, frame: unknown): Promise<FakeSocket> {
    const ac = new AbortController();
    const it = conn.receive(ac.signal)[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise((r) => setTimeout(r, 5)); // let receive() reach the socket
    FakeSocket.last!.push(frame);
    await new Promise((r) => setTimeout(r, 25)); // let onSlash + respondUrl run
    ac.abort();
    await pump.catch(() => {});
    return FakeSocket.last!;
  }

  const slashFrame = (over: Record<string, unknown> = {}) => ({
    type: "slash_commands",
    envelope_id: "slash-1",
    payload: { command: "/status", text: "", response_url: "https://hooks.slack.invalid/c/1", channel_id: "C9", user_id: "U7", team_id: "T1", trigger_id: "tg-1", ...over },
  });

  it("acks the slash envelope first, so Slack does not redeliver", async () => {
    const { conn } = slashRig(async () => "ok");
    const sock = await driveSlash(conn, slashFrame());
    expect(sock.sent.map((s) => JSON.parse(s))).toContainEqual({ envelope_id: "slash-1" });
  });

  it("normalizes `/status` to the `!status` line the dispatcher already understands", async () => {
    let seen: { text: string; conversation: string; user: string } | undefined;
    const { conn } = slashRig(async (i) => {
      seen = i;
      return null;
    });
    await driveSlash(conn, slashFrame({ command: "/status", text: "" }));
    expect(seen).toEqual({ text: "!status", conversation: "T1/C9", user: "U7" });
  });

  it("carries the argument through — `/connect plaud` becomes `!connect plaud`", async () => {
    let seen = "";
    const { conn } = slashRig(async (i) => {
      seen = i.text;
      return null;
    });
    await driveSlash(conn, slashFrame({ command: "/connect", text: "plaud" }));
    expect(seen).toBe("!connect plaud");
  });

  it("posts the reply to response_url, ephemerally, so the channel does not see it", async () => {
    const { conn, posts } = slashRig(async () => "here is your status");
    await driveSlash(conn, slashFrame());
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://hooks.slack.invalid/c/1");
    expect(posts[0].body).toMatchObject({ response_type: "ephemeral", text: "here is your status" });
  });

  it("posts nothing when the command answered another way (empty string)", async () => {
    const { conn, posts } = slashRig(async () => "");
    await driveSlash(conn, slashFrame({ command: "/connect", text: "plaud" }));
    expect(posts).toHaveLength(0);
  });

  it("drops a slow-ack redelivery of the same slash (deduped on trigger_id)", async () => {
    let runs = 0;
    const { conn } = slashRig(async () => {
      runs++;
      return "ok";
    });
    const ac = new AbortController();
    const it = conn.receive(ac.signal)[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise((r) => setTimeout(r, 5));
    FakeSocket.last!.push(slashFrame({ trigger_id: "tg-dup" }));
    FakeSocket.last!.push(slashFrame({ trigger_id: "tg-dup" }));
    await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    await pump.catch(() => {});
    expect(runs).toBe(1);
  });
});

describe("repliesToOwnThread — a reply under the agent's own message needs no mention", () => {
  const BOT = "U0BOT";
  it("answers a reply in a thread the agent started", () => {
    expect(repliesToOwnThread({ type: "message", ts: "2.0", thread_ts: "1.0", parent_user_id: BOT }, BOT)).toBe(true);
  });
  it("ignores a thread somebody else started, a top-level message, and the thread root itself", () => {
    expect(repliesToOwnThread({ type: "message", ts: "2.0", thread_ts: "1.0", parent_user_id: "U0PERSON" }, BOT)).toBe(false);
    expect(repliesToOwnThread({ type: "message", ts: "2.0" }, BOT)).toBe(false);
    expect(repliesToOwnThread({ type: "message", ts: "1.0", thread_ts: "1.0", parent_user_id: BOT }, BOT)).toBe(false);
  });
  it("never matches when the agent's own id is unknown", () => {
    expect(repliesToOwnThread({ type: "message", ts: "2.0", thread_ts: "1.0", parent_user_id: BOT }, undefined)).toBe(false);
  });
});

describe("asking Slack the way Slack answers", () => {
  // Real Slack refuses a JSON body on its read methods with `invalid_arguments`; this fake does the
  // same, where the old one accepted anything — which is how every brain answer went private live.
  const READS = new Set(["conversations.info", "conversations.members", "users.info", "auth.test", "bots.info"]);
  const strictSlack = (handlers: Record<string, (args: URLSearchParams) => unknown>) =>
    (async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => {
      const method = String(url).split("/").pop()!.split("?")[0]!;
      const type = init?.headers?.["content-type"] ?? "";
      if (READS.has(method) && type.includes("json")) return { json: async () => ({ ok: false, error: "invalid_arguments" }) } as unknown as Response;
      const args = type.includes("json") ? new URLSearchParams(Object.entries(JSON.parse(String(init?.body ?? "{}"))).map(([k, v]) => [k, String(v)])) : new URLSearchParams(String(init?.body ?? ""));
      const h = handlers[method];
      return { json: async () => (h ? h(args) : { ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;

  it("BRAIN-AUDIENCE the speaker's own DM counts as the speaker alone, as real Slack reports it", async () => {
    const conn = new SlackConnector({
      appToken: "xapp",
      botToken: "xoxb",
      fetchImpl: strictSlack({
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
        "conversations.info": (a) => (a.get("channel") === "D1" ? { ok: true, channel: { id: "D1", is_im: true, user: "UANA" } } : { ok: false, error: "channel_not_found" }),
      }),
    });
    expect(await conn.audience("T1/D1", "UANA")).toEqual({ kind: "self" });
  });

  it("BRAIN-AUDIENCE a private channel's members are counted from real Slack's answer", async () => {
    const conn = new SlackConnector({
      appToken: "xapp",
      botToken: "xoxb",
      fetchImpl: strictSlack({
        "auth.test": () => ({ ok: true, user_id: "UBOT" }),
        "conversations.info": () => ({ ok: true, channel: { id: "G1", is_private: true, name: "eng" } }),
        "conversations.members": (a) => (a.get("channel") === "G1" ? { ok: true, members: ["UANA", "UBEN", "UBOT"] } : { ok: false, error: "channel_not_found" }),
      }),
    });
    expect(await conn.audience("T1/G1/1.2", "UANA")).toEqual({ kind: "members", members: ["UANA", "UBEN"], name: "eng" });
  });
});
