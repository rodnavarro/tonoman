// Connecting Plaud through buttons and a dialog, the same way Claude is connected.
//
// The interesting part is not the blocks, it is that there are now TWO modals. A handler that
// takes every view_submission would feed a pasted Plaud address into the Claude login as an
// authorization code — and fail in a way that blames the person for pasting the wrong thing.

import { describe, expect, it } from "vitest";
import type { SlackInteraction } from "../connector/slack";
import { PLAUD_CONNECT_ACTION, connectBlocks, handleInteraction, urlModal } from "./plaudgate";
import { CONNECT_ACTION, handleInteraction as claudeInteraction } from "./authgate";

const conn = () =>
  ({
    call: async () => ({}),
    reply: () => ({ send: async () => "ts" }),
    postBlocks: async () => "ts",
  }) as never;

const deps = (over: Partial<Parameters<typeof handleInteraction>[0]> = {}) => ({
  conn: () => conn(),
  begin: async () => "https://web.plaud.ai/platform/oauth?client_id=x",
  complete: async () => ({ ok: true }),
  notifyChannel: () => "C123",
  ...over,
});

describe("the offer", () => {
  it("gives one link to open and one button to come back through", () => {
    const { blocks } = connectBlocks("https://web.plaud.ai/oauth", "D1");
    const json = JSON.stringify(blocks);
    expect(json).toContain("Open Plaud login");
    expect(json).toContain("I have my address");
    expect(json).toContain(PLAUD_CONNECT_ACTION);
  });

  it("warns that the page will fail to load, because it will", () => {
    // Somebody who is told to sign in and then watches a browser error assumes they broke it.
    expect(JSON.stringify(connectBlocks("u", "D1"))).toContain("fail to load");
  });

  it("says why the address goes in a dialog rather than the channel", () => {
    expect(JSON.stringify(connectBlocks("u", "D1"))).toContain("workspace exports");
  });
});

describe("the dialog", () => {
  it("is tagged so it can be told apart from the Claude one", () => {
    expect(urlModal("nelly", "D1").callback_id).toBe(PLAUD_CONNECT_ACTION);
    expect(urlModal("nelly", "D1").callback_id).not.toBe(CONNECT_ACTION);
  });

  it("carries the conversation, since a modal has no channel of its own", () => {
    expect(String(urlModal("nelly", "D1").private_metadata)).toContain("D1");
  });
});

describe("routing between two gates", () => {
  const submission = (callbackId: string): SlackInteraction => ({
    kind: "view_submission",
    userId: "U1",
    callbackId,
    privateMetadata: JSON.stringify({ agent: "nelly", conversation: "D1" }),
    values: { url: { value: { value: "http://localhost:8199/auth/callback?code=abc&state=xyz" } } },
  });

  it("takes its own submission", async () => {
    let got = "";
    const r = await handleInteraction(
      deps({ complete: async (_a: string, pasted: string) => ((got = pasted), { ok: true }) }) as never,
      "nelly",
      submission(PLAUD_CONNECT_ACTION),
    );
    expect(got).toContain("code=abc");
    expect(r).toBe("plaud connected");
  });

  it("declines somebody else's submission rather than swallowing it", async () => {
    let called = false;
    const r = await handleInteraction(
      deps({ complete: async () => ((called = true), { ok: true }) }) as never,
      "nelly",
      submission(CONNECT_ACTION),
    );
    expect(called).toBe(false);
    expect(r).toBe("not mine");
  });

  it("and the CLAUDE gate declines a Plaud submission — the dangerous direction", async () => {
    // Without this the address, which carries a live authorization code, is handed to the Claude
    // login as if it were a Claude code.
    let submitted = false;
    const r = await claudeInteraction(
      {
        ops: () => ({ startHeadless: async () => "u", submitCode: async () => ((submitted = true), { ok: true, status: "", loginTail: "" }) }),
        conn: () => conn(),
        setAuthState: async () => {},
      } as never,
      "nelly",
      submission(PLAUD_CONNECT_ACTION),
    );
    expect(submitted).toBe(false);
    expect(r).not.toContain("connected");
  });
});

describe("what the person is told", () => {
  it("names the channel recaps will appear in", async () => {
    let said = "";
    await handleInteraction(
      deps({
        conn: () => ({ call: async () => ({}), reply: () => ({ send: async (t: string) => ((said = t), "ts") }) }) as never,
      }) as never,
      "nelly",
      {
        kind: "view_submission",
        userId: "U1",
        callbackId: PLAUD_CONNECT_ACTION,
        privateMetadata: JSON.stringify({ agent: "nelly", conversation: "D1" }),
        values: { url: { value: { value: "?code=abc" } } },
      },
    );
    expect(said).toContain("<#C123>");
  });

  it("passes the failure back in words rather than a bare cross", async () => {
    let said = "";
    await handleInteraction(
      deps({
        complete: async () => ({ ok: false, problem: "they expire quickly and only work once" }),
        conn: () => ({ call: async () => ({}), reply: () => ({ send: async (t: string) => ((said = t), "ts") }) }) as never,
      }) as never,
      "nelly",
      {
        kind: "view_submission",
        userId: "U1",
        callbackId: PLAUD_CONNECT_ACTION,
        privateMetadata: JSON.stringify({ agent: "nelly", conversation: "D1" }),
        values: { url: { value: { value: "?code=abc" } } },
      },
    );
    expect(said).toContain("expire quickly");
  });
});

describe("connecting has to START the poll, not just store the credential", () => {
  // The bug this covers, in full: an account was connected at 11:53, the reply said "record
  // something and I'll pick it up within a couple of minutes", and nothing polled. The voice flow
  // was worked out once when the process booted, so a credential that arrived afterwards was
  // stored, acknowledged, and watched by nobody until a restart. In the cluster: connected, then
  // silence until the next deploy.
  const submit = (over = {}) =>
    handleInteraction(deps(over) as never, "nelly", {
      kind: "view_submission",
      userId: "U1",
      callbackId: PLAUD_CONNECT_ACTION,
      privateMetadata: JSON.stringify({ agent: "nelly", conversation: "D1" }),
      values: { url: { value: { value: "?code=abc" } } },
    } as SlackInteraction);

  it("starts the poll for the agent whose account it is", async () => {
    const started: string[] = [];
    const r = await submit({ onConnected: async (a: string) => void started.push(a) });
    expect(started).toEqual(["nelly"]);
    expect(r).toBe("plaud connected");
  });

  it("starts it BEFORE the confirmation, so the promise is true when it is read", async () => {
    // Order, not merely occurrence: a poll started after the message is a race with the person
    // walking off to record something.
    const order: string[] = [];
    await submit({
      onConnected: async () => void order.push("poll"),
      conn: () =>
        ({
          call: async () => ({}),
          reply: () => ({ send: async () => (order.push("said"), "ts") }),
        }) as never,
    });
    expect(order).toEqual(["poll", "said"]);
  });

  it("does not start a poll for a login that failed", async () => {
    const started: string[] = [];
    await submit({
      complete: async () => ({ ok: false, problem: "the code had already been used" }),
      onConnected: async (a: string) => void started.push(a),
    });
    expect(started).toEqual([]);
  });

  it("tells the person when the credential landed but the poll did not start", async () => {
    // The state that used to be invisible. Storing a credential and polling with it are two things,
    // and a confirmation that covers only the first is how somebody ends up waiting all morning.
    let said = "";
    const r = await submit({
      onConnected: async () => "this agent has no voice flow configured yet",
      conn: () =>
        ({ call: async () => ({}), reply: () => ({ send: async (t: string) => ((said = t), "ts") }) }) as never,
    });
    expect(said).toContain("no voice flow configured");
    expect(said).toContain("Nothing will be picked up");
    expect(said).not.toContain("couple of minutes");
    expect(r).toContain("not polling");
  });

  it("survives a poll that throws, and says so rather than promising a recap", async () => {
    let said = "";
    await submit({
      onConnected: async () => {
        throw new Error("temporal is unreachable");
      },
      conn: () =>
        ({ call: async () => ({}), reply: () => ({ send: async (t: string) => ((said = t), "ts") }) }) as never,
    });
    expect(said).toContain("temporal is unreachable");
    expect(said).not.toContain("couple of minutes");
  });

  it("still connects when nothing supplies onConnected at all", async () => {
    // It is optional, and the single-machine deployment does not pass one.
    expect(await submit()).toBe("plaud connected");
  });
});

