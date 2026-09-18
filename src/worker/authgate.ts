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
import type { InferenceProvider } from "../harness";
import { providerAccountLabel, providerLabel } from "../harness";
import type { SlackConnector, SlackInteraction } from "../connector/slack";
import { firstInputValue } from "../connector/slack";

export const CONNECT_ACTION = "tonoman_connect_inference";

/** How long a device-auth login is waited on before the offer is treated as abandoned. Ten minutes,
 *  because the codex code itself is good for fifteen and somebody who opened the link on a phone is
 *  routinely a few minutes getting through a sign-in. */
export const DEVICE_LOGIN_TIMEOUT_MS = 10 * 60_000;
/** How often the runtime is asked. Often enough that the confirmation lands while the person is
 *  still looking at the message, rare enough that ten minutes is 120 calls and not 12,000. */
export const DEVICE_LOGIN_POLL_MS = 5_000;

export interface AuthGateDeps {
  /** Start the harness's own login and return the OAuth URL. `user` names the person's own login
   *  dir when the agent runs inference per person; omitted for a shared-inference agent. */
  ops(agent: string, user?: string): AuthOps | undefined;
  conn(agent: string): SlackConnector | undefined;
  /** WHICH provider this agent answers on. The gate used to say "Claude" unconditionally, which on
   *  a codex agent sends people to sign in to an account the agent does not use — and then reports
   *  it as a success. Absent = claude, which is every agent that has not asked for otherwise. */
  provider?(agent: string): InferenceProvider;
  /** Report the OUTCOME back to the registry, so the next turn is not gated. `user` names the person
   *  whose own login this was, on a per-person agent — their state is theirs, not the agent's. */
  setAuthState(agent: string, state: "ok" | "error", user?: string): Promise<void>;
  /** A person just completed a login through THIS gate — the normal first step for someone new,
   *  since the gate offers it on its own the moment a turn finds no credential. Optional, best-effort:
   *  the worker uses it to register the person into the tenant, so their very first chat already
   *  knows their name (rather than only learning it when they connect Plaud later). */
  onLogin?(agent: string, user: string): Promise<void>;
}

/** What the agent says when it cannot answer yet. Names the agent, says what is missing, and gives
 *  exactly one thing to do — never a bare error. */
export function connectBlocks(
  agentLabel: string,
  url: string,
  conversation: string,
  provider: InferenceProvider = "claude",
): { text: string; blocks: unknown[] } {
  const account = providerAccountLabel(provider);
  const text = `I don't have an inference login yet, so I can't answer that. Connect a ${account} for ${agentLabel} and I'll pick up where we left off.`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*I don't have an inference login yet*, so I can't answer that.\n\nConnect a ${account} for *${agentLabel}* — open the link, approve, then paste the code back here. I'll pick up where we left off.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: `Open ${providerLabel(provider)} login` },
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
export function codeModal(agent: string, conversation: string, provider: InferenceProvider = "claude"): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: CONNECT_ACTION,
    private_metadata: JSON.stringify({ agent, conversation }),
    title: { type: "plain_text", text: `Connect ${providerLabel(provider)}` },
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
          placeholder: { type: "plain_text", text: `Paste the code from the ${providerLabel(provider)} page` },
        },
        hint: { type: "plain_text", text: "This is sent straight to your agent and never posted in a channel." },
      },
    ],
  };
}

/** What a device-auth login says, in plain words. No jargon and no "OAuth": a person is being asked
 *  to open a page and type ten characters, and that is what it should read like. The code is on its
 *  own line, in backticks, so it can be selected in one gesture on a phone. */
export function devicePrompt(agentLabel: string, account: string, url: string, code: string): string {
  return [
    `Let's connect a ${account} for *${agentLabel}*.`,
    "",
    `1. Open <${url}|this sign-in page> and sign in as yourself.`,
    "2. When it asks for a code, enter this one:",
    "",
    `\`${code}\``,
    "",
    "Then come back — I'll tell you here as soon as it goes through. The code is good for about 15 minutes.",
  ].join("\n");
}

/** Poll the runtime until a device-auth login completes, or the deadline passes.
 *
 *  Nothing comes back through us on this flow — the person finishes on the provider's page and the
 *  CLI exchanges the code on its own — so asking repeatedly IS the mechanism, not a workaround.
 *  `done` is OUTCOME-TRUE at the runtime: the credential moved AND the harness agrees.
 *
 *  Injectable clock + sleep so the ten-minute budget is unit-testable in milliseconds. A poll that
 *  THROWS is not fatal: a runtime restart mid-login is exactly when this is most useful, and one
 *  failed request should not end a wait the person is still in the middle of. */
export async function awaitDeviceLogin(
  ops: AuthOps,
  o: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ ok: boolean; status: string; timedOut: boolean }> {
  if (!ops.pending) return { ok: false, status: "", timedOut: false };
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? DEVICE_LOGIN_POLL_MS;
  const deadline = now() + (o.timeoutMs ?? DEVICE_LOGIN_TIMEOUT_MS);
  let status = "";
  for (;;) {
    try {
      const r = await ops.pending();
      status = r.status || status;
      if (r.done) return { ok: true, status, timedOut: false };
    } catch {
      /* a blip is not an answer; keep waiting until the deadline says otherwise */
    }
    if (now() >= deadline) return { ok: false, status, timedOut: true };
    await sleep(pollMs);
  }
}

/** Ask, in the conversation. Returns false when the login could not even be started, so the caller
 *  can say something rather than leaving the person watching nothing.
 *
 *  TWO FLOWS, chosen by what the runtime actually started rather than by a second opinion here: a
 *  `code` in the answer means device auth (codex), which shows the person a URL and a code and then
 *  WAITS; no code means the Claude paste-a-code flow, which shows a URL and a button. Reading it off
 *  the runtime's reply keeps one source of truth about which login is in flight. */
export async function ask(
  deps: AuthGateDeps,
  agent: string,
  agentLabel: string,
  conversation: string,
  user?: string,
): Promise<boolean> {
  const ops = deps.ops(agent, user);
  const conn = deps.conn(agent);
  if (!ops || !conn) return false;
  const provider = deps.provider?.(agent) ?? "claude";
  let started: { url: string; code?: string };
  try {
    started = await ops.startHeadless();
  } catch (e) {
    await conn.reply(conversation).send(
      // The REASON, not just that there was one. `startHeadless` now names the address and the
      // failure code, so this line stopped being "couldn't start one - fetch failed".
      `⚠️ I need an inference login, but starting one failed — ${(e as Error).message.slice(0, 200)}`,
    );
    return false;
  }

  if (started.code) {
    const account = providerAccountLabel(provider);
    const text = devicePrompt(agentLabel, account, started.url, started.code);
    // PRIVATELY: a one-time code is theirs and nobody else's, and a channel keeps it in history and
    // in the workspace export. `postEphemeral` needs a person to address, and Slack refuses it in
    // some conversations — so an ordinary post is the fallback rather than silence.
    const sentPrivately = user ? await conn.postEphemeral(conversation, user, text) : false;
    if (!sentPrivately) await conn.reply(conversation).send(text).catch(() => {});
    // The wait runs on its own: `ask` is called from the ingress loop, which must not block for ten
    // minutes on one person's sign-in.
    void watchDeviceLogin(deps, agent, conversation, ops, user, sentPrivately);
    return true;
  }

  const { text, blocks } = connectBlocks(agentLabel, started.url, conversation, provider);
  await conn.postBlocks(conversation, text, blocks);
  return true;
}

/** Wait out a device-auth login and say how it went, in the same place the offer was made.
 *
 *  Reports the outcome to the registry exactly as the paste-a-code path does — the person's own
 *  state when the login was theirs, the agent's when it was the agent's — so the next turn is not
 *  gated over a login that has already worked. */
export async function watchDeviceLogin(
  deps: AuthGateDeps,
  agent: string,
  conversation: string,
  ops: AuthOps,
  user?: string,
  privately = false,
  o: Parameters<typeof awaitDeviceLogin>[1] = {},
): Promise<void> {
  const conn = deps.conn(agent);
  const r = await awaitDeviceLogin(ops, o);
  // Registered BEFORE the state is reported: the per-person auth-state row only UPDATES a principal
  // the tenant already knows, and answers 404 for somebody signing in for the first time — which is
  // precisely the person this gate exists for.
  if (r.ok && user) await deps.onLogin?.(agent, user).catch(() => {});
  await deps.setAuthState(agent, r.ok ? "ok" : "error", user).catch(() => {});
  if (!conn) return;
  const text = r.ok
    ? "✅ Connected. Ask me again and I'll answer."
    : r.timedOut
      ? "⏳ I didn't see that sign-in go through. The code may have expired — say `!connect codex` and I'll start a fresh one."
      : `⚠️ That sign-in didn't complete. ${String(r.status).replace(/\s+/g, " ").slice(0, 200)}`;
  const sent = privately && user ? await conn.postEphemeral(conversation, user, text) : false;
  if (!sent) await conn.reply(conversation).send(text).catch(() => {});
}

/** Handle a button press or a modal submission. Returns a short line for the log. */
export async function handleInteraction(deps: AuthGateDeps, agent: string, it: SlackInteraction): Promise<string> {
  const conn = deps.conn(agent);
  const ops = deps.ops(agent);
  if (!conn || !ops) return "no such agent";

  if (it.kind === "block_actions" && it.actionId === CONNECT_ACTION) {
    if (!it.triggerId) return "no trigger_id";
    await conn.call("views.open", {
      trigger_id: it.triggerId,
      view: codeModal(agent, it.value ?? "", deps.provider?.(agent) ?? "claude"),
    });
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

    let r: Awaited<ReturnType<typeof ops.submitCode>>;
    try {
      r = await ops.submitCode(code);
    } catch (e) {
      // Said to the person, not only logged. A code submitted after the login already finished got a
      // 409 and silence, so it read as still broken when it had in fact worked the first time.
      const why = String((e as Error)?.message ?? e);
      if (conversation) {
        await conn
          .reply(conversation)
          .send(
            /409|no login in progress/i.test(why)
              ? "There's no login waiting for that code — an earlier one may already have worked. Send me a message: if I answer, you're connected; if I ask again, start a new login."
              : `⚠️ I couldn't submit that code — ${why.slice(0, 150)}`,
          )
          .catch(() => {});
      }
      return `code not submitted — ${why.slice(0, 120)}`;
    }
    // OUTCOME-TRUE: `ok` means the credential file actually changed and the harness reports logged
    // in. Anything else is reported as a failure, however encouraging the login output looked.
    // ORDER MATTERS. The per-person auth-state route only UPDATES an `agent_principal` row and
    // answers 404 when the tenant has never heard of the person — which is exactly the case here,
    // since connecting is how somebody new first identifies themselves. Register first, report after.
    // The submitter IS the person who just signed in — the modal carries no user of its own.
    if (r.ok && it.userId) await deps.onLogin?.(agent, it.userId).catch(() => {});
    await deps.setAuthState(agent, r.ok ? "ok" : "error", it.userId).catch(() => {});
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
