// The calendar dialog. The URL is the credential, so most of these are about it never reaching a
// channel, and about a feed being READ before it is stored.
import { describe, it, expect, vi } from "vitest";
import {
  ICS_CONNECT_ACTION,
  connectBlocks,
  icsModal,
  normaliseAlias,
  looksLikeIcsUrl,
  handleInteraction,
  ask,
} from "./icsgate";

function fakeConn() {
  const sent: string[] = [];
  const posted: { text: string; blocks: unknown[] }[] = [];
  const calls: { method: string; args: unknown }[] = [];
  return {
    sent,
    posted,
    calls,
    conn: {
      reply: () => ({ send: async (t: string) => void sent.push(t) }),
      postBlocks: async (_c: string, text: string, blocks: unknown[]) => void posted.push({ text, blocks }),
      call: async (method: string, args: unknown) => void calls.push({ method, args }),
    } as never,
  };
}

describe("normaliseAlias", () => {
  it("reduces what somebody types to something safe to put inside a secret ref", () => {
    // The alias lives in `ics.url:<alias>`, so it is the credential's stable identity.
    expect(normaliseAlias("Foley")).toBe("foley");
    expect(normaliseAlias("  Work Calendar  ")).toBe("work-calendar");
    expect(normaliseAlias("rod's/calendar")).toBe("rod-s-calendar");
    expect(normaliseAlias("--x--")).toBe("x");
  });

  it("falls back to a usable name rather than an empty ref", () => {
    // An empty alias would produce `ics.url:` — a ref that cannot be looked up and an error nobody
    // can read.
    expect(normaliseAlias("")).toBe("default");
    expect(normaliseAlias("///")).toBe("default");
  });

  it("caps the length, because this ends up in a database column and a URL path", () => {
    expect(normaliseAlias("a".repeat(200))).toHaveLength(40);
  });
});

describe("looksLikeIcsUrl", () => {
  it("accepts what Outlook and Google actually hand you", () => {
    const r = looksLikeIcsUrl("https://outlook.office365.com/owa/calendar/abc/xyz/calendar.ics");
    expect(r.ok).toBe(true);
  });

  it("translates webcal:// rather than refusing it", () => {
    // "Subscribe" in both Outlook and Google gives a webcal:// link, which is https underneath.
    // Refusing it would send somebody hunting for a different button that says the same thing.
    const r = looksLikeIcsUrl("webcal://outlook.office365.com/owa/calendar/abc/calendar.ics");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.startsWith("https://")).toBe(true);
  });

  it("rejects only what cannot possibly work, and says why", () => {
    expect(looksLikeIcsUrl("")).toEqual({ ok: false, problem: "that was empty" });
    expect(looksLikeIcsUrl("my calendar")).toEqual({ ok: false, problem: "that is not a web address" });
    const ftp = looksLikeIcsUrl("ftp://example.com/c.ics");
    expect(ftp.ok).toBe(false);
  });

  it("does NOT insist on an .ics suffix", () => {
    // Plenty of valid feeds do not have one, and the only real test of a calendar URL is fetching
    // it — which the health check does. Rejecting a working feed for looking unusual is the worse
    // error of the two.
    expect(looksLikeIcsUrl("https://example.com/feed?token=abc").ok).toBe(true);
  });
});

describe("the dialog keeps the address out of the channel", () => {
  it("posts a BUTTON, because a modal cannot be opened from a message", () => {
    // Only an interaction carries a trigger_id. This is the step that earns one.
    const { blocks } = connectBlocks("C1/T1");
    const actions = (blocks as { type: string; elements?: { action_id?: string; value?: string }[] }[]).find(
      (b) => b.type === "actions",
    );
    expect(actions?.elements?.[0]?.action_id).toBe(ICS_CONNECT_ACTION);
    // The conversation rides on the button, so the modal knows where to answer.
    expect(actions?.elements?.[0]?.value).toBe("C1/T1");
  });

  it("says WHY it is a dialog, where somebody about to paste a link will read it", () => {
    const { blocks } = connectBlocks("C1");
    const text = JSON.stringify(blocks);
    expect(text).toContain("not this channel");
    expect(text).toContain("workspace exports");
  });

  it("asks for a name as well as an address", () => {
    // A person will have more than one calendar, and `ics/default` tells them nothing later.
    const view = icsModal("sapien", "C1") as { blocks: { block_id?: string }[] };
    expect(view.blocks.map((b) => b.block_id)).toEqual(["alias", "url"]);
  });

  it("carries the conversation in private_metadata, which a modal has no channel of its own for", () => {
    const view = icsModal("sapien", "C1/T1") as { private_metadata: string };
    expect(JSON.parse(view.private_metadata)).toEqual({ agent: "sapien", conversation: "C1/T1" });
  });
});

describe("handleInteraction", () => {
  const deps = (save: (a: string, alias: string, url: string) => Promise<{ ok: boolean; message: string }>, f = fakeConn()) => ({
    f,
    deps: { conn: () => f.conn, save },
  });

  it("opens the dialog on the button press", async () => {
    const { f, deps: d } = deps(async () => ({ ok: true, message: "" }));
    const msg = await handleInteraction(d, "sapien", {
      kind: "block_actions",
      userId: "U1",
      triggerId: "T",
      actionId: ICS_CONNECT_ACTION,
      value: "C1",
    });
    expect(msg).toBe("opened calendar dialog");
    expect(f.calls[0]?.method).toBe("views.open");
  });

  it("reads the fields BY BLOCK ID, not by position", async () => {
    // Slack does not promise an order, and reading positionally put the address in the name field
    // roughly half the time — which fails as "that is not a web address" and blames the person.
    let seen: { alias?: string; url?: string } = {};
    const { deps: d } = deps(async (_a, alias, url) => {
      seen = { alias, url };
      return { ok: true, message: "done" };
    });
    await handleInteraction(d, "sapien", {
      kind: "view_submission",
      userId: "U1",
      callbackId: ICS_CONNECT_ACTION,
      privateMetadata: JSON.stringify({ agent: "sapien", conversation: "C1" }),
      // Deliberately reversed.
      values: {
        url: { value: { value: "https://example.com/c.ics" } },
        alias: { value: { value: "Foley" } },
      },
    });
    expect(seen).toEqual({ alias: "foley", url: "https://example.com/c.ics" });
  });

  it("refuses a bad address without calling save, so nothing half-lands", async () => {
    const save = vi.fn(async () => ({ ok: true, message: "" }));
    const { f, deps: d } = deps(save);
    await handleInteraction(d, "sapien", {
      kind: "view_submission",
      userId: "U1",
      callbackId: ICS_CONNECT_ACTION,
      privateMetadata: JSON.stringify({ conversation: "C1" }),
      values: { alias: { value: { value: "x" } }, url: { value: { value: "not a url" } } },
    });
    expect(save).not.toHaveBeenCalled();
    expect(f.sent[0]).toContain("not a web address");
  });

  it("answers in the conversation the button came from", async () => {
    const { f, deps: d } = deps(async () => ({ ok: true, message: "✅ Connected foley — 12 events" }));
    await handleInteraction(d, "sapien", {
      kind: "view_submission",
      userId: "U1",
      callbackId: ICS_CONNECT_ACTION,
      privateMetadata: JSON.stringify({ conversation: "C1" }),
      values: { alias: { value: { value: "foley" } }, url: { value: { value: "https://e.com/c.ics" } } },
    });
    expect(f.sent[0]).toContain("12 events");
  });

  it("turns a thrown save into a sentence rather than a silent failure", async () => {
    const { f, deps: d } = deps(async () => {
      throw new Error("registry unreachable");
    });
    await handleInteraction(d, "sapien", {
      kind: "view_submission",
      userId: "U1",
      callbackId: ICS_CONNECT_ACTION,
      privateMetadata: JSON.stringify({ conversation: "C1" }),
      values: { alias: { value: { value: "foley" } }, url: { value: { value: "https://e.com/c.ics" } } },
    });
    expect(f.sent[0]).toContain("registry unreachable");
  });

  it("leaves an interaction that is not its own alone", async () => {
    const save = vi.fn(async () => ({ ok: true, message: "" }));
    const { deps: d } = deps(save);
    const msg = await handleInteraction(d, "sapien", {
      kind: "view_submission",
      userId: "U1",
      callbackId: "tonoman_connect_plaud",
      values: {},
    });
    expect(msg).toBe("not mine");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("ask", () => {
  it("posts the offer and reports that it did", async () => {
    const f = fakeConn();
    const ok = await ask({ conn: () => f.conn, save: async () => ({ ok: true, message: "" }) }, "sapien", "C1");
    expect(ok).toBe(true);
    expect(f.posted).toHaveLength(1);
  });

  it("reports false rather than throwing when there is nowhere to post", async () => {
    const ok = await ask({ conn: () => undefined, save: async () => ({ ok: true, message: "" }) }, "nobody", "C1");
    expect(ok).toBe(false);
  });
});
