import { describe, it, expect } from "vitest";
import { SlackConnector, stripMention, conversationKey, parseConversation } from "./slack";

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
