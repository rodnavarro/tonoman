// "You need to log in first" — asked by the agent, in the channel, because the REGISTRY says this
// agent has no inference configured.
//
// The decision is a fact about the agent row (`auth_state`), not a probe of the filesystem. That
// distinction is the whole point: a file check answers "is there a credential file", which is what
// let jarvis report healthy for 54 days over a credential that had expired and carried no refresh
// token. The row answers "does this agent have working inference", and it is only ever written
// from an outcome — the credential file actually changed AND the harness reports logged in.
//
// The code comes back through a MODAL, never the channel. A pasted OAuth code in channel history is
// retained, searchable, and included in workspace exports; short-lived is not the same as safe to
// log. The modal's submission goes straight to the agent's own runtime.

import type { AuthOps } from "../authflow";
import type { SlackConnector, SlackInteraction } from "../connector/slack";
import { firstInputValue } from "../connector/slack";

export const CONNECT_ACTION = "tonoman_connect_inference";

export interface AuthGateDeps {
  /** Start the harness's own login and return the OAuth URL. */
  ops(agent: string): AuthOps | undefined;
  conn(agent: string): SlackConnector | undefined;
  /** Report the OUTCOME back to the registry, so the next turn is not gated. */
  setAuthState(agent: string, state: "ok" | "error"): Promise<void>;
}

/** What the agent says when it cannot answer yet. Names the agent, says what is missing, and gives
 *  exactly one thing to do — never a bare error. */
export function connectBlocks(agentLabel: string, url: string, conversation: string): { text: string; blocks: unknown[] } {
  const text = `I don't have an inference login yet, so I can't answer that. Connect a Claude subscription for ${agentLabel} and I'll pick up where we left off.`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*I don't have an inference login yet*, so I can't answer that.\n\nConnect a Claude subscription for *${agentLabel}* — open the link, approve, then paste the code back here. I'll pick up where we left off.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Open Claude login" },
            url,
            // A url button is a link, not an interaction — Slack requires an action_id anyway.
            action_id: `${CONNECT_ACTION}_open`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "I have my code" },
            action_id: CONNECT_ACTION,
            value: conversation,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "The code goes in a private dialog, not this channel — a pasted code stays in history and in workspace exports.",
          },
        ],
      },
    ],
  };
}

/** The modal that collects the code. `private_metadata` carries the conversation so the submission
 *  knows which agent and channel it belongs to; a modal has no channel of its own. */
export function codeModal(agent: string, conversation: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: CONNECT_ACTION,
    private_metadata: JSON.stringify({ agent, conversation }),
    title: { type: "plain_text", text: "Connect Claude" },
    submit: { type: "plain_text", text: "Connect" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "code",
        label: { type: "plain_text", text: "Authorization code" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Paste the code from the Claude page" },
        },
        hint: { type: "plain_text", text: "This is sent straight to your agent and never posted in a channel." },
      },
    ],
  };
}

/** Ask, in the channel. Returns false when the login could not even be started, so the caller can
 *  say something rather than leaving the person watching nothing. */
export async function ask(deps: AuthGateDeps, agent: string, agentLabel: string, conversation: string): Promise<boolean> {
  const ops = deps.ops(agent);
  const conn = deps.conn(agent);
  if (!ops || !conn) return false;
  let url: string;
  try {
    url = await ops.startHeadless();
  } catch (e) {
    await conn.reply(conversation).send(
      `⚠️ I need an inference login, but I couldn't start one — ${(e as Error).message.slice(0, 200)}`,
    );
    return false;
  }
  const { text, blocks } = connectBlocks(agentLabel, url, conversation);
  await conn.postBlocks(conversation, text, blocks);
  return true;
}

/** Handle a button press or a modal submission. Returns a short line for the log. */
export async function handleInteraction(deps: AuthGateDeps, agent: string, it: SlackInteraction): Promise<string> {
  const conn = deps.conn(agent);
  const ops = deps.ops(agent);
  if (!conn || !ops) return "no such agent";

  if (it.kind === "block_actions" && it.actionId === CONNECT_ACTION) {
    if (!it.triggerId) return "no trigger_id";
    await conn.call("views.open", { trigger_id: it.triggerId, view: codeModal(agent, it.value ?? "") });
    return "opened code modal";
  }

  // Only THIS modal. There is a second one now (connecting Plaud), and a handler that takes every
  // view_submission would feed a pasted Plaud address into the Claude login as an authorization
  // code — failing in a way that blames the person for the wrong thing.
  //
  // Undefined is treated as ours: a modal opened by a build before callback_id was carried through
  // should still complete rather than be silently ignored mid-login.
  if (it.kind === "view_submission" && (it.callbackId === undefined || it.callbackId === CONNECT_ACTION)) {
    const meta = safeParse(it.privateMetadata);
    const conversation = String(meta.conversation ?? "");
    const code = firstInputValue(it.values);
    if (!code) return "empty code";

    const r = await ops.submitCode(code);
    // OUTCOME-TRUE: `ok` means the credential file actually changed and the harness reports logged
    // in. Anything else is reported as a failure, however encouraging the login output looked.
    await deps.setAuthState(agent, r.ok ? "ok" : "error").catch(() => {});
    if (conversation) {
      await conn
        .reply(conversation)
        .send(
          r.ok
            ? "✅ Connected. Ask me again and I'll answer."
            : `⚠️ That code didn't complete the login. ${String(r.status || r.loginTail).replace(/\s+/g, " ").slice(0, 200)}`,
        )
        .catch(() => {});
    }
    return r.ok ? "login ok" : "login not ok";
  }
  return "ignored";
}

function safeParse(s?: string): Record<string, unknown> {
  try {
    return JSON.parse(s ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
