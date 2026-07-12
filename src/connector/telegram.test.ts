import { describe, it, expect } from "vitest";
import { TelegramConnector } from "./telegram";

/** Builds a fake fetch with a scripted sequence of behaviors. */
function fetchSeq(steps: Array<() => unknown>): { impl: typeof fetch; calls: () => number } {
  let i = 0;
  const impl = (async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    const body = step();
    return { json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => i };
}

describe("TelegramConnector.call — resilient to transient transport failures", () => {
  it("retries a thrown fetch (network blip) and then succeeds", async () => {
    const f = fetchSeq([
      () => {
        throw new TypeError("fetch failed");
      },
      () => ({ ok: true, result: { message_id: 5 } }),
    ]);
    const c = new TelegramConnector({ token: "t", fetchImpl: f.impl });
    const r = await c.call<{ message_id: number }>("sendMessage", {});
    expect(f.calls()).toBe(2);
    expect(r).toEqual({ message_id: 5 });
  });

  it("does NOT retry a Telegram API error (ok:false, e.g. 'not modified')", async () => {
    const f = fetchSeq([() => ({ ok: false, description: "message is not modified" })]);
    const c = new TelegramConnector({ token: "t", fetchImpl: f.impl });
    await expect(c.call("editMessageText", {})).rejects.toThrow(/not modified/);
    expect(f.calls()).toBe(1); // single attempt — API logic errors are not transient
  });

  it("gives up after the attempt cap on persistent transport failure", async () => {
    const f = fetchSeq([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const c = new TelegramConnector({ token: "t", fetchImpl: f.impl });
    await expect(c.call("sendMessage", {})).rejects.toThrow(/fetch failed/);
    expect(f.calls()).toBe(3);
  });
});

/** A fetch that records (method, payload) per call and returns scripted bodies. */
function recordingFetch(bodies: unknown[]): { impl: typeof fetch; reqs: { method: string; payload: any }[] } {
  const reqs: { method: string; payload: any }[] = [];
  let i = 0;
  const impl = (async (url: string, init: any) => {
    reqs.push({ method: String(url).split("/").pop() || "", payload: JSON.parse(init.body) });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return { json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, reqs };
}

describe("TelegramConnector — inline-button picks route as commands (gw-command-statusline)", () => {
  it("a tapped button (callback_query) becomes an envelope whose text is the choice, and is ack'd", async () => {
    const f = recordingFetch([
      { ok: true, result: [{ update_id: 7, callback_query: { id: "cb1", from: { id: 42, username: "rod" }, message: { chat: { id: 99 } }, data: "/statusline full" } }] },
      { ok: true, result: true }, // answerCallbackQuery
      { ok: true, result: [] },
    ]);
    const c = new TelegramConnector({ token: "t", fetchImpl: f.impl });
    const ac = new AbortController();
    let got: any;
    for await (const env of c.receive(ac.signal)) {
      got = env;
      ac.abort();
      break;
    }
    expect(got).toMatchObject({ conversation: "99", user: "rod", text: "/statusline full" });
    expect(f.reqs.some((r) => r.method === "answerCallbackQuery" && r.payload.callback_query_id === "cb1")).toBe(true);
  });

  it("sendChoices posts a one-row inline keyboard with callback_data per choice", async () => {
    const f = recordingFetch([{ ok: true, result: { message_id: 1 } }]);
    const c = new TelegramConnector({ token: "t", fetchImpl: f.impl });
    await c.reply("99").sendChoices!("pick:", [
      { label: "none", data: "/statusline none" },
      { label: "full", data: "/statusline full" },
    ]);
    const kb = f.reqs[0].payload.reply_markup.inline_keyboard;
    expect(kb).toEqual([[
      { text: "none", callback_data: "/statusline none" },
      { text: "full", callback_data: "/statusline full" },
    ]]);
  });

  it("note() drives a standalone notice: post (sendMessage) → edit by id (editMessageText) → delete (deleteMessage), stateless across instances", async () => {
    const f = recordingFetch([
      { ok: true, result: { message_id: 7 } }, // post
      { ok: true, result: {} }, // edit
      { ok: true, result: true }, // delete
    ]);
    const c = new TelegramConnector({ token: "t", fetchImpl: f.impl });
    const id = await c.reply("99").note!(undefined, "🗂 Queued (1)");
    expect(id).toBe("7");
    await c.reply("99").note!(id, "🗂 Queued (2)"); // a different reply instance edits by id
    await c.reply("99").note!(id, null); // delete
    expect(f.reqs.map((r) => r.method)).toEqual(["sendMessage", "editMessageText", "deleteMessage"]);
    expect(f.reqs[1].payload.message_id).toBe(7);
    expect(f.reqs[2].payload.message_id).toBe(7);
  });
});
