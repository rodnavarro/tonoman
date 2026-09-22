// Connecting a LOREALISTAR login: a private dialog, the person's own, proved before it is kept
// (drop-watch.md in Tonoman Cloud). Tests never use a real person's address (D-TEST-ACCOUNTS).
import { describe, it, expect } from "vitest";
import { LOREALISTAR_CONNECT_ACTION, ask, connectBlocks, handleInteraction, loginModal, type LorealistarGateDeps } from "./lorealistargate";
import type { SlackConnector, SlackInteraction } from "../connector/slack";

function setup(result: { ok: boolean; message: string } = { ok: true, message: "Connected." }) {
  const posted: { conversation: string; text: string; blocks: unknown[] }[] = [];
  const opened: Record<string, unknown>[] = [];
  const saved: { agent: string; user: string; email: string; password: string }[] = [];
  const told: { agent: string; user: string; conversation: string; text: string }[] = [];
  const conn = {
    postBlocks: async (conversation: string, text: string, blocks: unknown[]) => void posted.push({ conversation, text, blocks }),
    call: async (_m: string, body: Record<string, unknown>) => (opened.push(body), {}),
  } as unknown as SlackConnector;
  const deps: LorealistarGateDeps = {
    conn: (agent) => (agent === "mia" ? conn : undefined),
    save: async (agent, user, email, password) => (saved.push({ agent, user, email, password }), result),
    tell: async (agent, user, conversation, text) => void told.push({ agent, user, conversation, text }),
  };
  return { deps, posted, opened, saved, told };
}
const values = (email: string, password: string): SlackInteraction["values"] => ({ email: { value: { value: email } }, password: { value: { value: password } } });

describe("connecting a LOREALISTAR login", () => {
  it("DROPS-OWN-LOGIN `!connect lorealistar` offers a button; the email and password go in a private dialog, never in a channel", async () => {
    const { deps, posted, opened } = setup();
    expect(await ask(deps, "mia", "T1/C-GENERAL")).toBe(true);
    expect(posted[0]!.conversation).toBe("T1/C-GENERAL");
    expect(JSON.stringify(posted[0]!.blocks)).toContain(LOREALISTAR_CONNECT_ACTION);
    expect(JSON.stringify(connectBlocks("T1/C-GENERAL").blocks)).toMatch(/private dialog/i);
    await handleInteraction(deps, "mia", { kind: "block_actions", userId: "USTEF", triggerId: "trig", actionId: LOREALISTAR_CONNECT_ACTION, value: "T1/C-GENERAL" });
    const view = opened[0]!.view as { blocks: { block_id: string }[] };
    expect(view.blocks.map((b) => b.block_id)).toEqual(["email", "password"]);
    expect(JSON.stringify(loginModal("mia", "T1/C-GENERAL"))).toMatch(/never posted/i);
  });

  it("DROPS-OWN-LOGIN the login is kept for whoever filled in the dialog — never for someone a request names", async () => {
    const { deps, saved } = setup();
    const r = await handleInteraction(deps, "mia", {
      kind: "view_submission",
      userId: "USTEF",
      callbackId: LOREALISTAR_CONNECT_ACTION,
      privateMetadata: JSON.stringify({ agent: "mia", conversation: "T1/C-GENERAL", user: "UANA" }),
      values: values(" test+stef@tonoman.com ", "pw-not-real"),
    });
    expect(saved).toEqual([{ agent: "mia", user: "USTEF", email: "test+stef@tonoman.com", password: "pw-not-real" }]);
    expect(r).toBe("connected lorealistar for USTEF");
  });

  it("DROPS-LOGIN-PROVED-FIRST what came of it is told to that person, in the site's own words when it refused — and the password is never said back", async () => {
    const { deps, told } = setup({ ok: false, message: "LOREALISTAR did not accept that login (Incorrect username or password). Nothing was saved." });
    await handleInteraction(deps, "mia", { kind: "view_submission", userId: "USTEF", callbackId: LOREALISTAR_CONNECT_ACTION, privateMetadata: JSON.stringify({ conversation: "T1/C-GENERAL" }), values: values("test+stef@tonoman.com", "pw-not-real") });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ agent: "mia", user: "USTEF", conversation: "T1/C-GENERAL" });
    expect(told[0]!.text).toContain("Incorrect username or password");
    expect(JSON.stringify(told)).not.toContain("pw-not-real");
  });

  it("DROPS-OWN-LOGIN a dialog sent in with a field empty is not tried against the site at all", async () => {
    const { deps, saved, told } = setup();
    await handleInteraction(deps, "mia", { kind: "view_submission", userId: "USTEF", callbackId: LOREALISTAR_CONNECT_ACTION, privateMetadata: "{}", values: values("test+stef@tonoman.com", "") });
    expect(saved).toEqual([]);
    expect(told[0]!.text).toMatch(/email and the password/i);
  });

  it("an interaction that is somebody else's is left alone", async () => {
    const { deps, saved } = setup();
    expect(await handleInteraction(deps, "mia", { kind: "view_submission", userId: "USTEF", callbackId: "tonoman_connect_ics", values: values("a@b.co", "x") })).toBe("not mine");
    expect(saved).toEqual([]);
  });
});
