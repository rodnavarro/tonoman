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
  /** Begin a login and return the URL to put in front of the person. `user` is the member connecting
   *  on a per-person agent, so the pending login is written under their own scope; absent = shared. */
  begin(agent: string, user?: string): Promise<string>;
  /** Finish with whatever they pasted back. `problem` is shown to them when it fails. `user` MUST be
   *  the same one `begin` was called with — the pending PKCE verifier lives under that scope. */
  complete(agent: string, pasted: string, user?: string): Promise<{ ok: boolean; problem?: string }>;
  /** Where this agent announces recaps, so the confirmation can say where to look. */
  notifyChannel(agent: string): string | undefined;
  /** Start this agent's recording poll, now that it has a credential to poll with.
   *
   *  Exists because the confirmation below promises "record something and I'll pick it up within a
   *  couple of minutes", and that promise was false. The voice flow was worked out once at boot, so
   *  an account connected afterwards was stored, acknowledged — and polled by nothing until the
   *  process restarted. In the cluster that reads as "connected", then silence until the next deploy.
   *
   *  Returns a problem to pass on to the person, or undefined when the poll is running. */
  onConnected?(agent: string): Promise<string | undefined>;
}

/** The offer, in the channel: one link to open and one button to come back through. */
export function connectBlocks(url: string, conversation: string, user?: string): { text: string; blocks: unknown[] } {
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
            // Carries the connecting member alongside the conversation, so the dialog completes the
            // SAME login `begin` started (the pending PKCE verifier is under that member's scope).
            // A bare conversation string when there is no member keeps the shared flow unchanged.
            value: user ? JSON.stringify({ c: conversation, u: user }) : conversation,
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
export function urlModal(agent: string, conversation: string, user?: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: PLAUD_CONNECT_ACTION,
    private_metadata: JSON.stringify({ agent, conversation, user: user ?? null }),
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
export async function ask(deps: PlaudGateDeps, agent: string, conversation: string, user?: string): Promise<boolean> {
  const conn = deps.conn(agent);
  if (!conn) return false;
  let url: string;
  try {
    url = await deps.begin(agent, user);
  } catch (e) {
    await conn
      .reply(conversation)
      .send(`⚠️ I couldn't start the Plaud sign-in — ${(e as Error).message.slice(0, 200)}`)
      .catch(() => {});
    return false;
  }
  const { text, blocks } = connectBlocks(url, conversation, user);
  await conn.postBlocks(conversation, text, blocks);
  return true;
}

/** The button's `value`: a bare conversation string (shared), or `{c, u}` carrying the connecting
 *  member (per-person). Decoded back to `{conversation, user}` so the dialog runs under that member. */
function decodeButtonValue(value: string | undefined): { conversation: string; user?: string } {
  const raw = value ?? "";
  if (raw.startsWith("{")) {
    try {
      const o = JSON.parse(raw) as { c?: string; u?: string };
      return { conversation: String(o.c ?? ""), user: o.u || undefined };
    } catch {
      // fall through to the bare-string reading
    }
  }
  return { conversation: raw };
}

/** Button press or dialog submission. Returns a short line for the log. */
export async function handleInteraction(deps: PlaudGateDeps, agent: string, it: SlackInteraction): Promise<string> {
  const conn = deps.conn(agent);
  if (!conn) return "no such agent";

  if (it.kind === "block_actions" && it.actionId === PLAUD_CONNECT_ACTION) {
    if (!it.triggerId) return "no trigger_id";
    const { conversation, user } = decodeButtonValue(it.value);
    await conn.call("views.open", { trigger_id: it.triggerId, view: urlModal(agent, conversation, user) });
    return "opened plaud address dialog";
  }

  if (it.kind === "view_submission" && it.callbackId === PLAUD_CONNECT_ACTION) {
    const meta = safeParse(it.privateMetadata);
    const conversation = String(meta.conversation ?? "");
    // The member `begin` ran under — completing must use the same scope or the pending login misses.
    const user = typeof meta.user === "string" && meta.user ? meta.user : undefined;
    const pasted = firstInputValue(it.values);
    if (!pasted) return "empty address";

    const r = await deps.complete(agent, pasted, user);
    // BEFORE the confirmation, not after: the next two sentences promise a poll, so the poll has to
    // exist by the time they are read. A failure here changes what the person is TOLD, rather than
    // being logged somewhere nobody is looking while they wait for a recap.
    const caveat = r.ok
      ? await deps.onConnected?.(agent).catch((e) => `I couldn't start the poll — ${(e as Error).message}`)
      : undefined;
    if (conversation) {
      const where = deps.notifyChannel(agent);
      await conn
        .reply(conversation)
        .send(
          !r.ok
            ? `⚠️ That didn't work — ${r.problem ?? "the address wasn't accepted"}.`
            : caveat
              ? `✅ Your Plaud account is connected, but ${caveat}.\n\nNothing will be picked up until that is sorted.`
              : "✅ Your Plaud account is connected.\n\nRecord something and I'll pick it up within a couple of minutes — " +
                `I'll post what I find ${where ? `in <#${where}>` : "here"}.`,
        )
        .catch(() => {});
    }
    if (!r.ok) return `plaud connect failed: ${r.problem ?? "?"}`;
    return caveat ? `plaud connected but not polling: ${caveat}` : "plaud connected";
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
