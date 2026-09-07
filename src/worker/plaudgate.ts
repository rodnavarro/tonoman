// Connecting Plaud, with the same shape as connecting Claude.
//
// Both are "open a link, approve, hand something back", and until now only one of them looked like
// that. Claude got buttons and a private dialog; Plaud made you type `!connect plaud`, then type
// `!code plaud <address>` with the address pasted into the channel. Two mechanisms for one idea is
// something a person has to learn twice, and Celine would only ever meet the worse half.
//
// The dialog is not decoration. What comes back from Plaud is a URL with an authorization code in
// it, and a code pasted into a channel is retained, searchable, and included in workspace exports.
// Short-lived is not the same as safe to log — the same reason the Claude gate has always used a
// modal.
//
// The typed commands still work. Somebody mid-flow when this shipped should not find their
// instructions wrong.

import type { SlackConnector, SlackInteraction } from "../connector/slack";
import { firstInputValue } from "../connector/slack";

export const PLAUD_CONNECT_ACTION = "tonoman_connect_plaud";

export interface PlaudGateDeps {
  conn(agent: string): SlackConnector | undefined;
  /** Begin a login and return the URL to put in front of the person. */
  begin(agent: string): Promise<string>;
  /** Finish with whatever they pasted back. `problem` is shown to them when it fails. */
  complete(agent: string, pasted: string): Promise<{ ok: boolean; problem?: string }>;
  /** Where this agent announces recaps, so the confirmation can say where to look. */
  notifyChannel(agent: string): string | undefined;
}

/** The offer, in the channel: one link to open and one button to come back through. */
export function connectBlocks(url: string, conversation: string): { text: string; blocks: unknown[] } {
  const text = "Connect your Plaud account — open the link, approve, then paste the address back here.";
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*Let's connect your Plaud account* so I can pick up your recordings.\n\n" +
            "Open the link and sign in as yourself. The page it sends you to afterwards *will fail to load* — " +
            "that is expected, it is trying to reach me and cannot. Copy the whole address out of your browser bar " +
            "and bring it back with the button below.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Open Plaud login" },
            url,
            // A url button is a link rather than an interaction, but Slack wants an action_id.
            action_id: `${PLAUD_CONNECT_ACTION}_open`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "I have my address" },
            action_id: PLAUD_CONNECT_ACTION,
            value: conversation,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "The address goes in a private dialog, not this channel — it carries a login code, and a pasted code stays in history and in workspace exports.",
          },
        ],
      },
    ],
  };
}

/** The dialog that collects the callback address. */
export function urlModal(agent: string, conversation: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: PLAUD_CONNECT_ACTION,
    private_metadata: JSON.stringify({ agent, conversation }),
    title: { type: "plain_text", text: "Connect Plaud" },
    submit: { type: "plain_text", text: "Connect" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "url",
        label: { type: "plain_text", text: "The address from your browser" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "http://localhost:8199/auth/callback?code=..." },
        },
        hint: {
          type: "plain_text",
          text: "Paste the whole thing, including everything after the ?. It goes straight to your agent and is never posted in a channel.",
        },
      },
    ],
  };
}

/** Offer the connection in the channel. Returns false if a login could not even be started. */
export async function ask(deps: PlaudGateDeps, agent: string, conversation: string): Promise<boolean> {
  const conn = deps.conn(agent);
  if (!conn) return false;
  let url: string;
  try {
    url = await deps.begin(agent);
  } catch (e) {
    await conn
      .reply(conversation)
      .send(`⚠️ I couldn't start the Plaud sign-in — ${(e as Error).message.slice(0, 200)}`)
      .catch(() => {});
    return false;
  }
  const { text, blocks } = connectBlocks(url, conversation);
  await conn.postBlocks(conversation, text, blocks);
  return true;
}

/** Button press or dialog submission. Returns a short line for the log. */
export async function handleInteraction(deps: PlaudGateDeps, agent: string, it: SlackInteraction): Promise<string> {
  const conn = deps.conn(agent);
  if (!conn) return "no such agent";

  if (it.kind === "block_actions" && it.actionId === PLAUD_CONNECT_ACTION) {
    if (!it.triggerId) return "no trigger_id";
    await conn.call("views.open", { trigger_id: it.triggerId, view: urlModal(agent, it.value ?? "") });
    return "opened plaud address dialog";
  }

  if (it.kind === "view_submission" && it.callbackId === PLAUD_CONNECT_ACTION) {
    const meta = safeParse(it.privateMetadata);
    const conversation = String(meta.conversation ?? "");
    const pasted = firstInputValue(it.values);
    if (!pasted) return "empty address";

    const r = await deps.complete(agent, pasted);
    if (conversation) {
      const where = deps.notifyChannel(agent);
      await conn
        .reply(conversation)
        .send(
          r.ok
            ? "✅ Your Plaud account is connected.\n\nRecord something and I'll pick it up within a couple of minutes — " +
                `I'll post what I find ${where ? `in <#${where}>` : "here"}.`
            : `⚠️ That didn't work — ${r.problem ?? "the address wasn't accepted"}.`,
        )
        .catch(() => {});
    }
    return r.ok ? "plaud connected" : `plaud connect failed: ${r.problem ?? "?"}`;
  }

  return "not mine";
}

function safeParse(s: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(s ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
