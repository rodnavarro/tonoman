// Several agents in one Slack workspace (docs/definition/objects/conversation.md): who a message is
// for, and never answering another bot. Each test is one agent's connector (Echo, bot UBOT) seeing
// what Slack would deliver to it, with Golf (bot UGOLF) as the other agent. Titles start with the
// rule they prove.
import { describe, it, expect } from "vitest";
import { SlackConnector } from "./slack";

class FakeSocket {
  static last: FakeSocket | undefined;
  onmessage?: (ev: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public readonly url: string) {
    FakeSocket.last = this;
  }
  send(): void {}
  close(): void {
    this.onclose?.();
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** Echo's connector. `lastInThread` is who conversations.replies says spoke last among the bots. */
function echo(o: { watched?: string[]; sharedWatch?: (c: string) => boolean; lastInThread?: string } = {}): { conn: SlackConnector; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    const method = String(url).split("/").pop()!.split("?")[0]!;
    calls.push(method);
    const body =
      method === "apps.connections.open"
        ? { ok: true, url: "wss://example.invalid/link" }
        : method === "auth.test"
          ? { ok: true, user_id: "UBOT" }
          : method === "users.info"
            ? { ok: true, user: { id: /UGOLF|UBOT/.test(String(init?.body ?? url)) ? "UGOLF" : "UBEN", is_bot: /UGOLF|UBOT/.test(String(init?.body ?? url)) } }
            : method === "conversations.replies"
              ? {
                  ok: true,
                  messages: [
                    { ts: "1.0", user: "UANA", text: "root" },
                    { ts: "1.1", user: "UBOT", bot_id: "BECHO", text: "echo here" },
                    { ts: "1.2", user: "UGOLF", bot_id: "BGOLF", text: "golf here" },
                    ...(o.lastInThread === "UBOT" ? [{ ts: "1.3", user: "UBOT", bot_id: "BECHO", text: "echo again" }] : []),
                  ],
                }
              : { ok: true, ts: "9.9" };
    return { json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  const conn = new SlackConnector({
    appToken: "xapp-test",
    botToken: "xoxb-test",
    fetchImpl,
    socketImpl: FakeSocket as unknown as typeof WebSocket,
    watchedChannels: () => new Set(o.watched ?? []),
    sharedWatch: o.sharedWatch,
  });
  return { conn, calls };
}

/** Push frames, then a final human DM as a sentinel, and return the texts of every envelope that came
 *  out. Frames are normalized concurrently (one that asks Slack a question can finish after the
 *  sentinel), so collection goes on for a moment after the sentinel. Anything dropped never appears. */
async function seen(conn: SlackConnector, events: Record<string, unknown>[]): Promise<string[]> {
  const ac = new AbortController();
  const it = conn.receive(ac.signal)[Symbol.asyncIterator]();
  const pump = (async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 5));
    let n = 0;
    for (const event of [...events, { type: "message", channel_type: "im", channel: "D1", user: "UANA", text: "sentinel", ts: "99.0" }]) {
      FakeSocket.last!.push({ type: "events_api", envelope_id: String(++n), payload: { team_id: "T1", event } });
    }
  })();
  const out: string[] = [];
  const next = (): Promise<string | undefined> => it.next().then((r) => (r.value as { text: string } | undefined)?.text);
  let pending = next();
  for (;;) {
    const text = await pending;
    pending = next();
    out.push(text!);
    if (text === "sentinel") break;
  }
  // Whatever was still being normalized when the sentinel came out.
  for (;;) {
    const text = await Promise.race([pending, new Promise<undefined>((r) => setTimeout(() => r(undefined), 100))]);
    if (text === undefined) break;
    out.push(text);
    pending = next();
  }
  await pump;
  ac.abort();
  return out.filter((t) => t !== "sentinel");
}

describe("another bot's message", () => {
  it("CONVO-NO-BOT-LOOPS a message Golf's bot posted is never answered — in Echo's own thread, a watched channel, or naming Echo", async () => {
    const { conn } = echo({ watched: ["CW"] });
    const texts = await seen(conn, [
      { type: "message", channel: "C1", user: "UGOLF", bot_id: "BGOLF", text: "reply under echo", ts: "2.1", thread_ts: "1.0", parent_user_id: "UBOT" },
      { type: "message", channel: "CW", user: "UGOLF", bot_id: "BGOLF", text: "in the watched channel", ts: "2.2" },
      { type: "app_mention", channel: "C1", user: "UGOLF", bot_id: "BGOLF", text: "<@UBOT> hey echo", ts: "2.3" },
      { type: "message", subtype: "bot_message", channel: "CW", bot_id: "BX", text: "an integration", ts: "2.4" },
    ]);
    expect(texts).toEqual([]);
  });
});

describe("who a message is for", () => {
  it("CONVO-WHO-IS-ADDRESSED a reply in Echo's own thread that names Golf, and not Echo, is Golf's", async () => {
    const { conn } = echo();
    const texts = await seen(conn, [
      { type: "message", channel: "C1", user: "UANA", text: "<@UGOLF> what do you think?", ts: "3.1", thread_ts: "1.0", parent_user_id: "UBOT" },
      { type: "message", channel: "C1", user: "UANA", text: "<@UBEN> and you, Echo, go on", ts: "3.2", thread_ts: "1.0", parent_user_id: "UBOT" },
    ]);
    // Naming a person is not addressing another agent: Echo still answers the second one.
    expect(texts).toEqual(["and you, Echo, go on"]); // mentions are stripped from what the turn reads
  });

  it("CONVO-WHO-IS-ADDRESSED in a channel two agents both watch, only a message that names one of them is answered", async () => {
    const { conn } = echo({ watched: ["CW"], sharedWatch: (c) => c === "CW" });
    const texts = await seen(conn, [
      { type: "message", channel: "CW", user: "UANA", text: "anyone?", ts: "4.1" },
      { type: "app_mention", channel: "CW", user: "UANA", text: "<@UBOT> you, Echo", ts: "4.2" },
    ]);
    expect(texts).toEqual(["you, Echo"]);
  });

  it("CONVO-WHO-IS-ADDRESSED a channel only Echo watches still answers a plain message, as before", async () => {
    const { conn } = echo({ watched: ["CW"], sharedWatch: () => false });
    expect(await seen(conn, [{ type: "message", channel: "CW", user: "UANA", text: "anyone?", ts: "4.3" }])).toEqual(["anyone?"]);
  });

  it("CONVO-WHO-IS-ADDRESSED a !command with no mention in a shared thread goes to the agent that last answered there", async () => {
    // Golf answered last: Echo leaves it, though the thread is Echo's own.
    const golfLast = echo();
    expect(await seen(golfLast.conn, [{ type: "message", channel: "C1", user: "UANA", text: "!new", ts: "5.1", thread_ts: "1.0", parent_user_id: "UANA" }])).toEqual([]);
    const golfLastOwn = echo();
    expect(await seen(golfLastOwn.conn, [{ type: "message", channel: "C1", user: "UANA", text: "!new", ts: "5.2", thread_ts: "1.0", parent_user_id: "UBOT" }])).toEqual([]);
    // Echo answered last: Echo takes it, even in a thread somebody else started.
    const echoLast = echo({ lastInThread: "UBOT" });
    expect(await seen(echoLast.conn, [{ type: "message", channel: "C1", user: "UANA", text: "!new", ts: "5.3", thread_ts: "1.0", parent_user_id: "UANA" }])).toEqual(["!new"]);
  });
});
