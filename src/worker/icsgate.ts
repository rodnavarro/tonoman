// Connecting a calendar by its published ICS address.
//
// The odd one out among the connectors, and the one the Foley calendar actually needs: there is no
// login, no consent screen and no code — only a URL somebody copies out of Outlook. The 365
// integration was blocked by IT, so this is not a fallback, it is the only way in.
//
// A DIALOG, NOT A TYPED COMMAND, for the same reason as the Plaud address: **the URL IS the
// credential**. Anyone holding it reads the calendar, forever, with no account and no audit. Typed
// into a channel it is retained, searchable, and included in every workspace export — so it goes
// through a private dialog and never touches channel history.
//
// A button first, because a modal needs a `trigger_id` and a plain message does not have one. Only
// an interaction carries it, so `!connect ics` posts something to click.

import type { SlackConnector, SlackInteraction } from "../connector/slack";

export const ICS_CONNECT_ACTION = "tonoman_connect_ics";

export interface IcsGateDeps {
  conn(agent: string): SlackConnector | undefined;
  /** Store the URL and attach the calendar, then say what it found. The health check is the point:
   *  a secret URL that 404s looks exactly like one that works until the first recording. */
  save(agent: string, alias: string, url: string): Promise<{ ok: boolean; message: string }>;
}

/** PURE: a name somebody typed, reduced to something safe to put inside a secret ref.
 *
 *  The alias appears in `ics.url:<alias>`, so it is the STABLE identity of the credential — a
 *  rename would orphan it. Restricted here rather than at the store, because the failure otherwise
 *  is a ref that cannot be looked up and an error nobody can read. */
export function normaliseAlias(raw: string): string {
  return (
    (raw || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "default"
  );
}

/** PURE: is this plausibly an ICS feed address? Deliberately shallow — it rejects what cannot
 *  possibly work and lets the health check judge the rest, because the only real test of a calendar
 *  URL is fetching it. Rejecting a valid feed for looking unusual would be the worse error. */
export function looksLikeIcsUrl(raw: string): { ok: true; url: string } | { ok: false; problem: string } {
  const t = (raw || "").trim();
  if (!t) return { ok: false, problem: "that was empty" };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    // webcal:// is what Outlook and Google hand you from "subscribe", and it is https underneath.
    if (/^webcal:\/\//i.test(t)) return looksLikeIcsUrl(t.replace(/^webcal:/i, "https:"));
    return { ok: false, problem: "that is not a web address" };
  }
  if (u.protocol === "webcal:") return looksLikeIcsUrl(t.replace(/^webcal:/i, "https:"));
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, problem: `${u.protocol} is not a web address` };
  // http is allowed rather than refused: some internal feeds are served that way, and a calendar
  // that will not connect at all is worse than one carried over a link the person already trusts.
  return { ok: true, url: u.toString() };
}

/** The button. The modal cannot be opened from a message — only an interaction carries a
 *  `trigger_id` — so this is the step that earns one. */
export function connectBlocks(conversation: string): { text: string; blocks: unknown[] } {
  return {
    text: "Add a calendar",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*Add a calendar by its published address.*\n" +
            "In Outlook: _Settings → Calendar → Shared calendars → Publish a calendar_, choose " +
            "*Can view all details*, and copy the **ICS** link.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ICS_CONNECT_ACTION,
            style: "primary",
            text: { type: "plain_text", text: "Add calendar" },
            value: conversation,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              "The address goes in a private dialog, not this channel — anyone who has it can read " +
              "the calendar, and a pasted link stays in history and in workspace exports.",
          },
        ],
      },
    ],
  };
}

/** Two fields: what to call it, and the address. The NAME is asked for rather than derived because
 *  a person will have more than one calendar and `ics/default` tells them nothing later. */
export function icsModal(agent: string, conversation: string): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: ICS_CONNECT_ACTION,
    private_metadata: JSON.stringify({ agent, conversation }),
    title: { type: "plain_text", text: "Add a calendar" },
    submit: { type: "plain_text", text: "Connect" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "alias",
        label: { type: "plain_text", text: "What should I call it?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "foley" },
        },
        hint: { type: "plain_text", text: "A short name you will recognise: work, foley, personal." },
      },
      {
        type: "input",
        block_id: "url",
        label: { type: "plain_text", text: "The published ICS address" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "https://outlook.office365.com/owa/calendar/.../calendar.ics" },
        },
        hint: {
          type: "plain_text",
          text: "This goes straight to your agent and is never posted in a channel. Treat it like a password.",
        },
      },
    ],
  };
}

/** Offer it in the channel. Returns false when there is nothing to post to. */
export async function ask(deps: IcsGateDeps, agent: string, conversation: string): Promise<boolean> {
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

/** Read one block's input by block_id. Reading positionally broke the moment a second field was
 *  added — the name and the address arrived in whichever order Slack felt like. */
function valueOf(values: SlackInteraction["values"], blockId: string): string {
  const block = (values as Record<string, Record<string, { value?: string }>> | undefined)?.[blockId];
  if (!block) return "";
  for (const el of Object.values(block)) if (typeof el?.value === "string") return el.value.trim();
  return "";
}

/** Button press or dialog submission. Returns a short line for the log. */
export async function handleInteraction(deps: IcsGateDeps, agent: string, it: SlackInteraction): Promise<string> {
  const conn = deps.conn(agent);
  if (!conn) return "no such agent";

  if (it.kind === "block_actions" && it.actionId === ICS_CONNECT_ACTION) {
    if (!it.triggerId) return "no trigger_id";
    await conn.call("views.open", { trigger_id: it.triggerId, view: icsModal(agent, it.value ?? "") });
    return "opened calendar dialog";
  }

  if (it.kind === "view_submission" && it.callbackId === ICS_CONNECT_ACTION) {
    const meta = safeParse(it.privateMetadata);
    const conversation = String(meta.conversation ?? "");
    const alias = normaliseAlias(valueOf(it.values, "alias"));
    const parsed = looksLikeIcsUrl(valueOf(it.values, "url"));

    if (!parsed.ok) {
      if (conversation) await conn.reply(conversation).send(`⚠️ I couldn't use that address — ${parsed.problem}.`).catch(() => {});
      return `bad ics url: ${parsed.problem}`;
    }

    const r = await deps.save(agent, alias, parsed.url).catch((e) => ({
      ok: false,
      message: `⚠️ I couldn't save that — ${(e as Error).message.slice(0, 160)}`,
    }));

    if (conversation) await conn.reply(conversation).send(r.message).catch(() => {});
    return r.ok ? `connected ics/${alias}` : `ics/${alias} failed`;
  }

  return "not mine";
}
