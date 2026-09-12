// Connecting an account, for any connector.
//
// Every one of these is the same shape: open a link, approve, hand something back. Claude is, Plaud
// is, and Google and Outlook will be. Written per connector it is the same forty lines each time,
// and each copy drifts — Claude got buttons and a private dialog while Plaud got a typed command
// with the authorization code pasted into channel history, which is how the second one ended up
// both less pleasant and less safe than the first.
//
// So the flow lives here once and a connector supplies only what differs: its name, how to start,
// how to finish, and what to say afterwards.
//
// The dialog is not decoration. What comes back is a code — or a URL with a code in it — and a code
// pasted into a channel is retained, searchable, and included in workspace exports. Short-lived is
// not the same as safe to log.

import type { SlackConnector, SlackInteraction } from "../connector/slack";
import { firstInputValue, inputValues } from "../connector/slack";

/** Action and callback ids are namespaced so one router can tell connectors apart, and so a new
 *  connector needs no change to the routing at all. */
export const CONNECT_NS = "tonoman_connect";
export const actionFor = (id: string): string => `${CONNECT_NS}:${id}`;
export const openActionFor = (id: string): string => `${CONNECT_NS}:${id}:open`;
/** Which connector an interaction belongs to, or undefined when it is not a connect at all. */
export function connectorOf(it: SlackInteraction): string | undefined {
  const raw = it.callbackId ?? it.actionId ?? "";
  if (!raw.startsWith(`${CONNECT_NS}:`)) return undefined;
  return raw.slice(CONNECT_NS.length + 1).replace(/:open$/, "") || undefined;
}

/** One thing a person types, for a connector that has nothing to redirect to. */
export interface ConnectorField {
  /** Becomes the modal's block id, and the key in what `complete` receives. */
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Refuse an empty submission rather than storing half a connection. */
  required?: boolean;
}

export interface ConnectorSpec {
  /** Stable id, and what the person types: `!connect <id>`. The KIND, not an instance — one `ics`
   *  connector serves however many calendars a tenant attaches. */
  id: string;
  /** How it is named in a sentence, e.g. "your Plaud account". */
  label: string;

  /** What the person supplies, for a connector with no login to send them to.
   *
   *  An ICS feed is a URL somebody already has; there is no provider to redirect to, nothing to
   *  approve, and no code to come back with. `ConnectorSpec` originally assumed the OAuth shape for
   *  everything, which is the same assumption that made a Cognito-login skill look impossible.
   *  Declaring fields instead of a `begin` covers both without a second gate. */
  fields?: ConnectorField[];

  /** Begin a login and return the URL to put in front of the person. Absent when `fields` is set —
   *  there is nowhere to send them. */
  begin?(agent: string): Promise<string>;

  /** Finish. Keyed by field, so a connector that asked for two things gets two things; the
   *  redirect shape receives its paste as `value`. `problem` is shown verbatim on failure, and
   *  `message` REPLACES the confirmation — which is how a connector that can verify itself says
   *  what it actually found rather than "connected". */
  complete(
    agent: string,
    input: Record<string, string>,
  ): Promise<{ ok: boolean; problem?: string; message?: string }>;

  /** Forget it again. Optional: not every connector can be disconnected from here. */
  forget?(agent: string, instance?: string): Promise<void>;
  /** What the person pastes back — a bare code, or the whole address. Only the wording differs. */
  returns?: "code" | "address";
  /** Shown once connected, when `complete` returned no message of its own. */
  connected?(agent: string): string;
  /** True when this agent already has it. Lets `!connect` say so instead of silently replacing.
   *  Meaningless for a connector that can have several instances, which is why it is optional. */
  isConnected?(agent: string): Promise<boolean>;
  /** More than one of these can be attached at once — a work calendar and a personal one. Suppresses
   *  "you already have one", because having one is not a reason to refuse another. */
  multiple?: boolean;
}

export interface ConnectGateDeps {
  conn(agent: string): SlackConnector | undefined;
  spec(id: string): ConnectorSpec | undefined;
  /** Every connector this deployment has, for the "which one?" answer. */
  ids(): string[];
}

const wording = (s: ConnectorSpec): { noun: string; placeholder: string; hint: string } =>
  s.returns === "address"
    ? {
        noun: "address",
        placeholder: "http://localhost:8199/auth/callback?code=...",
        hint: "Paste the whole thing, including everything after the ?. It goes straight to your agent and is never posted in a channel.",
      }
    : {
        noun: "code",
        placeholder: "Paste the code from the sign-in page",
        hint: "This goes straight to your agent and is never posted in a channel.",
      };

/** The offer for a connector that collects rather than redirects: one button, straight to the
 *  dialog. No link, because there is nowhere to send anybody. */
export function collectBlocks(s: ConnectorSpec, conversation: string, lead?: string): { text: string; blocks: unknown[] } {
  const text = `Add ${s.label}.`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${lead ?? `*Let's add ${s.label}.*`}\n\nI'll ask for the details in a private dialog and check it works before saving it.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: `Add ${s.label.replace(/^your /, "")}`.slice(0, 75) },
            action_id: actionFor(s.id),
            value: conversation,
          },
        ],
      },
    ],
  };
}

/** The offer: one link to open, one button to come back through. */
export function connectBlocks(s: ConnectorSpec, url: string, conversation: string, lead?: string): { text: string; blocks: unknown[] } {
  const w = wording(s);
  const opening = lead ?? `*Let's connect ${s.label}.*`;
  const text = `Connect ${s.label} — open the link, approve, then bring the ${w.noun} back here.`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `${opening}\n\nOpen the link and sign in as yourself.` +
            (s.returns === "address"
              ? " The page it sends you to afterwards *will fail to load* — that is expected, it is trying to reach me and cannot. Copy the whole address out of your browser bar and bring it back with the button below."
              : " Then bring the code back with the button below."),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: `Open ${s.label.replace(/^your /, "")} login`.slice(0, 75) },
            url,
            // A url button is a link rather than an interaction, but Slack wants an action_id.
            action_id: openActionFor(s.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: `I have my ${w.noun}` },
            action_id: actionFor(s.id),
            value: conversation,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `The ${w.noun} goes in a private dialog, not this channel — a pasted code stays in history and in workspace exports.`,
          },
        ],
      },
    ],
  };
}

/** The dialog that collects it. `private_metadata` carries the conversation; a modal has none. */
export function connectModal(s: ConnectorSpec, agent: string, conversation: string): Record<string, unknown> {
  const w = wording(s);
  return {
    type: "modal",
    callback_id: actionFor(s.id),
    private_metadata: JSON.stringify({ agent, conversation, connector: s.id }),
    title: { type: "plain_text", text: `Connect ${s.label.replace(/^your /, "")}`.slice(0, 24) },
    submit: { type: "plain_text", text: "Connect" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: s.fields
      ? // One block per declared field, block_id = field key. The block id is the only name the
        // sender controls, and it is what lets `inputValues` hand `complete` a keyed record
        // instead of "the first non-empty thing somebody typed".
        s.fields.map((f) => ({
          type: "input",
          block_id: f.key,
          optional: f.required === false,
          label: { type: "plain_text", text: f.label.slice(0, 2000) },
          element: {
            type: "plain_text_input",
            action_id: f.key,
            ...(f.placeholder ? { placeholder: { type: "plain_text", text: f.placeholder.slice(0, 150) } } : {}),
          },
          ...(f.hint ? { hint: { type: "plain_text", text: f.hint.slice(0, 2000) } } : {}),
        }))
      : [
          {
            type: "input",
            block_id: "value",
            label: { type: "plain_text", text: w.noun === "address" ? "The address from your browser" : "Authorization code" },
            element: {
              type: "plain_text_input",
              action_id: "value",
              placeholder: { type: "plain_text", text: w.placeholder },
            },
            hint: { type: "plain_text", text: w.hint },
          },
        ],
  };
}

/** Offer the connection in the channel. False when a login could not even be started, so the
 *  caller can say something rather than leaving the person watching nothing. */
export async function ask(
  deps: ConnectGateDeps,
  agent: string,
  id: string,
  conversation: string,
  lead?: string,
): Promise<boolean> {
  const s = deps.spec(id);
  const conn = deps.conn(agent);
  if (!s || !conn) return false;

  // Nothing to begin. There is no provider to redirect to, so the offer goes straight to the
  // dialog rather than pretending there is a login somewhere.
  if (s.fields) {
    const c = collectBlocks(s, conversation, lead);
    await conn.postBlocks(conversation, c.text, c.blocks);
    return true;
  }

  let url: string;
  try {
    url = await s.begin!(agent);
  } catch (e) {
    await conn
      .reply(conversation)
      .send(`⚠️ I couldn't start the ${s.label} sign-in — ${(e as Error).message.slice(0, 200)}`)
      .catch(() => {});
    return false;
  }
  const { text, blocks } = connectBlocks(s, url, conversation, lead);
  await conn.postBlocks(conversation, text, blocks);
  return true;
}

/** Button press or dialog submission, for whichever connector it belongs to. */
export async function handleInteraction(deps: ConnectGateDeps, agent: string, it: SlackInteraction): Promise<string> {
  const id = connectorOf(it);
  if (!id) return "not mine";
  const s = deps.spec(id);
  const conn = deps.conn(agent);
  if (!s || !conn) return `no connector "${id}"`;

  if (it.kind === "block_actions") {
    if (!it.triggerId) return "no trigger_id";
    await conn.call("views.open", { trigger_id: it.triggerId, view: connectModal(s, agent, it.value ?? "") });
    return `opened ${id} dialog`;
  }

  if (it.kind === "view_submission") {
    const meta = safeParse(it.privateMetadata);
    const conversation = String(meta.conversation ?? "");

    // Keyed for a collecting connector, `{ value }` for the redirect shape — so `complete` has one
    // signature and neither kind has to know the other exists.
    const input = s.fields ? inputValues(it.values) : { value: firstInputValue(it.values) };
    const missing = s.fields?.filter((f) => f.required !== false && !input[f.key]).map((f) => f.label) ?? [];
    if (missing.length) {
      // Refuse rather than store half a connection. A calendar saved without its URL looks
      // attached and matches nothing, which is the failure mode this whole gate exists to avoid.
      if (conversation) {
        await conn
          .reply(conversation)
          .send(`⚠️ I still need: ${missing.join(", ")}.`)
          .catch(() => {});
      }
      return `incomplete ${id} submission`;
    }
    if (!s.fields && !input.value) return `empty ${id} submission`;

    const r = await s.complete(agent, input);
    if (conversation) {
      await conn
        .reply(conversation)
        .send(
          r.ok
            ? // A connector that verified itself says what it FOUND — "12 events, next up API Team
              // Standup" — which is something a person can check. "Connected." is not.
              (r.message ?? s.connected?.(agent) ?? `✅ ${cap(s.label)} is connected.`)
            : `⚠️ That didn't work — ${r.problem ?? "it wasn't accepted"}.`,
        )
        .catch(() => {});
    }
    return r.ok ? `${id} connected` : `${id} connect failed: ${r.problem ?? "?"}`;
  }

  return "not mine";
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function safeParse(s: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(s ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
