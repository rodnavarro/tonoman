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
