// Connecting a LOREALISTAR login (docs/definition/objects/drop-watch.md in Tonoman Cloud).
//
// A DIALOG, NOT A TYPED COMMAND: it is an email and a PASSWORD. Typed into a channel it is retained,
// searchable, and in every workspace export — so it goes through a private dialog and never touches
// channel history (DROPS-OWN-LOGIN). A button first, because a modal needs a `trigger_id` and only an
// interaction carries one.
//
// WHOSE login it is, is whoever filled in the dialog — Slack says who that was. It is never taken
// from anything the request carries, so nobody connects a login on someone else's behalf.

import type { SlackConnector, SlackInteraction } from "../connector/slack";

export const LOREALISTAR_CONNECT_ACTION = "tonoman_connect_lorealistar";

export interface LorealistarGateDeps {
  conn(agent: string): SlackConnector | undefined;
  /** Try the login against the site and, only if it signs in, keep it (DROPS-LOGIN-PROVED-FIRST). */
  save(agent: string, user: string, email: string, password: string): Promise<{ ok: boolean; message: string }>;
  /** Tell that person what came of it — privately where it can be. */
  tell(agent: string, user: string, conversation: string, text: string): Promise<void>;
}

export function connectBlocks(conversation: string): { text: string; blocks: unknown[] } {
  return {
    text: "Connect LOREALISTAR",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Connect your LOREALISTAR login*, and I will watch for new drops for you and tell you the moment one appears." },
      },
      {
        type: "actions",
        elements: [{ type: "button", action_id: LOREALISTAR_CONNECT_ACTION, style: "primary", text: { type: "plain_text", text: "Connect LOREALISTAR" }, value: conversation }],
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Your email and password go in a private dialog, not this channel. I only look — I never claim anything for you." }],
      },
    ],
  };
}

export function loginModal(agent: string, conversation: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: LOREALISTAR_CONNECT_ACTION,
    private_metadata: JSON.stringify({ agent, conversation }),
    title: { type: "plain_text", text: "Connect LOREALISTAR" },
    submit: { type: "plain_text", text: "Connect" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "email",
        label: { type: "plain_text", text: "Your LOREALISTAR email" },
        element: { type: "email_text_input", action_id: "value" },
      },
      {
        type: "input",
        block_id: "password",
        label: { type: "plain_text", text: "Your LOREALISTAR password" },
        element: { type: "plain_text_input", action_id: "value" },
        hint: { type: "plain_text", text: "This goes straight to your agent, is tried against LOREALISTAR once, and is kept sealed. It is never posted anywhere." },
      },
    ],
  };
}

/** Offer it in the channel. Returns false when there is nothing to post to. */
export async function ask(deps: LorealistarGateDeps, agent: string, conversation: string): Promise<boolean> {
  const conn = deps.conn(agent);
  if (!conn) return false;
  const { text, blocks } = connectBlocks(conversation);
  await conn.postBlocks(conversation, text, blocks);
  return true;
}

function safeParse(s: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(s ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One block's input, by block id. The password is NOT trimmed: a space can be part of one. */
function valueOf(values: SlackInteraction["values"], blockId: string, trim = true): string {
  const block = values?.[blockId];
  if (!block) return "";
  for (const el of Object.values(block)) if (typeof el?.value === "string") return trim ? el.value.trim() : el.value;
  return "";
}

/** Button press or dialog submission. Returns a short line for the log — never the login. */
export async function handleInteraction(deps: LorealistarGateDeps, agent: string, it: SlackInteraction): Promise<string> {
  const conn = deps.conn(agent);
  if (!conn) return "no such agent";

  if (it.kind === "block_actions" && it.actionId === LOREALISTAR_CONNECT_ACTION) {
    if (!it.triggerId) return "no trigger_id";
    await conn.call("views.open", { trigger_id: it.triggerId, view: loginModal(agent, it.value ?? "") });
    return "opened lorealistar dialog";
  }

  if (it.kind === "view_submission" && it.callbackId === LOREALISTAR_CONNECT_ACTION) {
    const conversation = String(safeParse(it.privateMetadata).conversation ?? "");
    // Whoever filled it in — as Slack says, not as the request says.
    const user = it.userId;
    const email = valueOf(it.values, "email");
    const password = valueOf(it.values, "password", false);
    if (!email || !password) {
      await deps.tell(agent, user, conversation, "⚠️ I need both the email and the password you use on LOREALISTAR. Nothing was saved.").catch(() => {});
      return "lorealistar: a field was empty";
    }
    const r = await deps.save(agent, user, email, password).catch((e) => ({ ok: false, message: `I couldn't save that — ${(e as Error).message.slice(0, 160)}` }));
    await deps.tell(agent, user, conversation, r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`).catch(() => {});
    return r.ok ? `connected lorealistar for ${user}` : `lorealistar for ${user} was not connected`;
  }

  return "not mine";
}
