import { describe, expect, it } from "vitest";
import {
  actionFor,
  collectBlocks,
  connectBlocks,
  connectModal,
  connectorOf,
  handleInteraction,
  openActionFor,
  type ConnectGateDeps,
  type ConnectorSpec,
} from "./connectgate";
import type { SlackInteraction } from "../connector/slack";

/** A connector of the redirect shape — Plaud and Claude both are. */
const oauthish = (over: Partial<ConnectorSpec> = {}): ConnectorSpec => ({
  id: "plaud",
  label: "your Plaud account",
  returns: "address",
  begin: async () => "https://provider.test/authorize?x=1",
  complete: async () => ({ ok: true }),
  ...over,
});

/** A connector that collects. Nothing to redirect to. */
const collecting = (over: Partial<ConnectorSpec> = {}): ConnectorSpec => ({
  id: "ics",
  label: "a calendar feed",
  multiple: true,
  fields: [
    { key: "name", label: "What should I call it?", placeholder: "Foley Outlook ICS" },
    { key: "url", label: "The ICS link" },
  ],
  complete: async () => ({ ok: true, message: "Connected *Foley Outlook ICS* — 12 events." }),
  ...over,
});

/** A Slack connector that records rather than sends. */
function spy() {
  const sent: string[] = [];
  const posted: { text: string; blocks: unknown[] }[] = [];
  const calls: { method: string; body: unknown }[] = [];
  const conn = {
    reply: () => ({ send: async (t: string) => void sent.push(t) }),
    postBlocks: async (_c: string, text: string, blocks: unknown[]) => void posted.push({ text, blocks }),
    call: async (method: string, body: unknown) => void calls.push({ method, body }),
  };
  return { sent, posted, calls, conn };
}

function deps(specs: ConnectorSpec[], conn: unknown): ConnectGateDeps {
  const byId = new Map(specs.map((s) => [s.id, s]));
  return {
    conn: () => conn as never,
    spec: (id) => byId.get(id),
    ids: () => [...byId.keys()],
  };
}

describe("connectorOf — one router, and a new connector needs no change to it", () => {
  it("reads the connector out of an action id", () => {
    expect(connectorOf({ kind: "block_actions", userId: "U", actionId: actionFor("ics") })).toBe("ics");
  });

  it("reads it out of a modal's callback id", () => {
    expect(connectorOf({ kind: "view_submission", userId: "U", callbackId: actionFor("google") })).toBe("google");
  });

  it("strips the :open suffix the link button carries", () => {
    expect(connectorOf({ kind: "block_actions", userId: "U", actionId: openActionFor("plaud") })).toBe("plaud");
  });

  it("returns nothing for an interaction that is not a connect at all", () => {
    // The router hands everything else on. Claiming a foreign interaction is how the first
    // implementation took a Plaud address and tried it as a Claude authorization code.
    expect(connectorOf({ kind: "block_actions", userId: "U", actionId: "some_other_button" })).toBeUndefined();
  });
});

describe("the redirect shape", () => {
  it("offers the link and a way back", () => {
    const { text, blocks } = connectBlocks(oauthish(), "https://provider.test/a", "C1");
    expect(text).toContain("your Plaud account");
    expect(JSON.stringify(blocks)).toContain("https://provider.test/a");
    expect(JSON.stringify(blocks)).toContain(actionFor("plaud"));
  });

  it("warns that the redirect will fail to load, because it will", () => {
    // The page is localhost on the person's own machine and nothing is listening. Somebody who has
    // not been told reads a browser error as "it broke" and stops.
    const { blocks } = connectBlocks(oauthish(), "https://p.test/a", "C1");
    expect(JSON.stringify(blocks)).toContain("will fail to load");
  });

  it("collects it in a dialog and says why", () => {
    const md = JSON.stringify(connectModal(oauthish(), "nelly", "C1"));
    expect(md).toContain("private_metadata");
    expect(md).toContain("value");
  });
});

describe("the collecting shape — a connector with nowhere to send anybody", () => {
  it("goes straight to the dialog, with no link", () => {
    const { blocks } = collectBlocks(collecting(), "C1");
    const j = JSON.stringify(blocks);
    expect(j).toContain(actionFor("ics"));
    // No url button: inventing a login for something that has none is worse than having no button.
    expect(j).not.toContain('"url"');
  });

  it("renders one modal block per declared field, keyed by field", () => {
    // The block id is the only name the sender controls, and it is what turns "the first non-empty
    // thing somebody typed" into a keyed record.
    const view = connectModal(collecting(), "mia", "C1") as { blocks: { block_id: string }[] };
    expect(view.blocks.map((b) => b.block_id)).toEqual(["name", "url"]);
  });

  it("refuses a submission missing a required field rather than storing half a connection", async () => {
    // A calendar saved without its URL looks attached and matches nothing — silently, forever.
    const { sent, conn } = spy();
    const it: SlackInteraction = {
      kind: "view_submission",
      userId: "U",
      callbackId: actionFor("ics"),
      privateMetadata: JSON.stringify({ conversation: "C1" }),
      values: { name: { name: { value: "Foley" } } },
    };
    const out = await handleInteraction(deps([collecting()], conn), "mia", it);
    expect(out).toContain("incomplete");
    expect(sent.join(" ")).toContain("The ICS link");
  });

  it("passes every field through to complete, keyed", async () => {
    let got: Record<string, string> = {};
    const spec = collecting({
      complete: async (_a, input) => {
        got = input;
        return { ok: true };
      },
    });
    const { conn } = spy();
    await handleInteraction(deps([spec], conn), "mia", {
      kind: "view_submission",
      userId: "U",
      callbackId: actionFor("ics"),
      privateMetadata: JSON.stringify({ conversation: "C1" }),
      values: { name: { name: { value: "Foley Outlook ICS" } }, url: { url: { value: "https://x.test/c.ics" } } },
    });
    expect(got).toEqual({ name: "Foley Outlook ICS", url: "https://x.test/c.ics" });
  });

  it("says what it FOUND, not just that it connected", async () => {
    // A connector that can verify itself has something better to report than "Connected." — and
    // "12 events, next up X" is something a person can actually check.
    const { sent, conn } = spy();
    await handleInteraction(deps([collecting()], conn), "mia", {
      kind: "view_submission",
      userId: "U",
      callbackId: actionFor("ics"),
      privateMetadata: JSON.stringify({ conversation: "C1" }),
      values: { name: { name: { value: "Foley" } }, url: { url: { value: "https://x.test/c.ics" } } },
    });
    expect(sent.join(" ")).toContain("12 events");
  });

  it("reports a rejection verbatim, so the person knows what to fix", async () => {
    const spec = collecting({
      complete: async () => ({ ok: false, problem: "that link returned a web page rather than a calendar" }),
    });
    const { sent, conn } = spy();
    await handleInteraction(deps([spec], conn), "mia", {
      kind: "view_submission",
      userId: "U",
      callbackId: actionFor("ics"),
      privateMetadata: JSON.stringify({ conversation: "C1" }),
      values: { name: { name: { value: "Foley" } }, url: { url: { value: "https://x.test/c" } } },
    });
    expect(sent.join(" ")).toContain("web page rather than a calendar");
  });
});

describe("handleInteraction — routing", () => {
  it("opens the dialog on a button press", async () => {
    const { calls, conn } = spy();
    const out = await handleInteraction(deps([collecting()], conn), "mia", {
      kind: "block_actions",
      userId: "U",
      actionId: actionFor("ics"),
      triggerId: "T1",
      value: "C1",
    });
    expect(calls[0]?.method).toBe("views.open");
    expect(out).toContain("opened");
  });

  it("declines anything that is not a connect", async () => {
    const { conn } = spy();
    const out = await handleInteraction(deps([collecting()], conn), "mia", {
      kind: "block_actions",
      userId: "U",
      actionId: "unrelated",
    });
    expect(out).toBe("not mine");
  });

  it("declines a connector this deployment does not have", async () => {
    const { conn } = spy();
    const out = await handleInteraction(deps([collecting()], conn), "mia", {
      kind: "view_submission",
      userId: "U",
      callbackId: actionFor("outlook"),
    });
    expect(out).toContain("no connector");
  });
});
