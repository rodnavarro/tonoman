// In-channel commands for the Slack worker.
//
// Slack is the one channel where a leading `/` is NOT available to us: an unregistered slash
// command never reaches the app at all — Slack intercepts it and tells the person it is not a
// valid command. Registering one is a change to the app manifest, which is a deploy of the Slack
// app rather than of this worker, and it arrives without `thread_ts`, so a command typed inside an
// assistant thread cannot be mapped back to the conversation it was typed in.
//
// So the prefix here is `!`. It reaches the app today, it carries full thread context because it
// is an ordinary message, and it is the same dispatch a registered slash command would use if one
// is added later (`parse` accepts both prefixes).
//
// The parser is PURE. `run` takes its capabilities as deps so the dispatch is testable without a
// Slack connection, a harness, or Temporal.

import { parseStatusMode, renderStatus, renderWindows, STATUS_MODES, type StatusMode, type UsageWindow } from "../statusline";
import type { TurnUsage } from "../core/contracts";

export interface Command {
  name: string;
  /** Everything after the command word, trimmed. */
  arg: string;
}

/** Recognise a command. Returns undefined for ordinary text, which is the common case — so this
 *  runs on every inbound message and must not be clever about it. */
export function parse(text: string): Command | undefined {
  const t = (text ?? "").trim();
  if (!/^[!/][a-z]/i.test(t)) return undefined;
  const m = /^[!/](\S+)\s*([\s\S]*)$/.exec(t);
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), arg: (m[2] ?? "").trim() };
}

export interface CommandDeps {
  /** The conversation's status-footer mode. */
  getMode(conversation: string): StatusMode;
  setMode(conversation: string, mode: StatusMode): void;
  /** The last turn's usage in this conversation, if one has run. */
  lastUsage(conversation: string): TurnUsage | undefined;
  /** Account headroom (5h / 7d). Fetched from the agent's own runtime; [] when unavailable. */
  windows(agent: string): Promise<UsageWindow[]>;
  /** Which model THIS conversation runs. Scoped to the conversation, never to the process: one
   *  worker serves every thread in the tenant, so a process-wide knob meant one person's `!model`
   *  changed the model under everybody else mid-conversation. */
  getModel(agent: string, conversation: string): string | undefined;
  setModel(agent: string, conversation: string, model: string | undefined): void;
  /** Forget this conversation's history and start it over. Optional: a deployment that keeps no
   *  session has nothing to forget, and `!new` says so instead of claiming a reset. */
  resetSession?(agent: string, conversation: string): void;
  /** Connect this agent's Plaud account. Returns the text to post — a login link the person
   *  opens themselves, because the account being connected is theirs and not ours. */
  connectPlaud?(agent: string, conversation: string): Promise<string>;
  /** Forget this agent's Plaud account and revoke it upstream. */
  disconnectPlaud?(agent: string): Promise<string>;
  /** Finish a connection with the callback URL the person pasted back. */
  finishPlaud?(agent: string, pasted: string): Promise<string>;
  /** Whether this agent already has a Plaud account connected. */
  plaudConnected?(agent: string): Promise<boolean>;
}

const HELP = [
  "*Commands* — type these as an ordinary message.",
  "• `!status` — token use for the last turn and how much of your Claude plan is left",
  `• \`!statusline ${STATUS_MODES.join("|")}\` — whether that shows under every answer`,
  "• `!model` — which model this conversation runs; `!model <name>` to change it here only",
  "• `!connect plaud` — connect your Plaud account, so I can pick up your recordings",
  "• `!disconnect plaud` — forget it again",
  "• `!new` — forget this thread and start over",
  "• `!help` — this",
].join("\n");

/** `!new`, when there IS something to clear.
 *
 *  This text used to say the opposite — "I keep no memory across them" — and it was true then,
 *  because a thread had no memory to keep. Now that a thread continues one harness session, `!new`
 *  drops it and the next message starts over. A command that describes the behaviour it had
 *  BEFORE the feature landed is worse than no command at all. */
const NEW_DONE = [
  "🧹 Forgotten. This thread starts over from your next message.",
  "_Nothing is deleted — I just stop reading back past here._",
].join("\n");

/** `!new` where the deployment keeps no session at all: say so rather than claim a reset. */
const NEW_NOOP = [
  "Every thread is its own conversation — I keep no memory across them.",
  "Start a fresh one with the ✏️ *New chat* button at the top of this pane, or by replying in a new thread.",
  "That is what `/new` did on Telegram and Teams; in Slack the thread already is it.",
].join("\n");

/** The connector a connection command names, and whatever follows it. A pasted callback address
 *  is one long token, so the split is on the FIRST word only. */
export function splitConnector(arg: string): { which: string; rest: string } {
  const t = (arg ?? "").trim();
  if (!t) return { which: "", rest: "" };
  const i = t.search(/\s/);
  if (i < 0) return { which: t.toLowerCase(), rest: "" };
  return { which: t.slice(0, i).toLowerCase(), rest: t.slice(i + 1).trim() };
}

function unknownConnector(which: string): string {
  return `I don't have a "${which}" connector. Today it is just \`plaud\`.`;
}

/** Runs a command. Returns the text to post, or null when the input was not a command we own —
 *  in which case the caller must treat it as an ordinary message. */
export async function run(
  deps: CommandDeps,
  agent: string,
  conversation: string,
  cmd: Command,
  now: number = Date.now(),
): Promise<string | null> {
  switch (cmd.name) {
    case "help":
    case "commands":
      return HELP;

    // Both connection commands name the connector: `!connect plaud`, `!code plaud <address>`.
    //
    // Plaud is the only one today, so the word is redundant right now and deliberately required
    // anyway. Calendars are already on the list, and the moment a second connector exists a bare
    // `!connect` becomes ambiguous — at which point every instruction written down, and every
    // person who learned the short form, is wrong. Cheaper to be explicit while there is one.
    case "code":
    case "callback": {
      if (!deps.finishPlaud) return "There is no connection waiting for a code here.";
      const { which, rest } = splitConnector(cmd.arg);
      if (which && which !== "plaud") return unknownConnector(which);
      if (!rest) return "Paste the whole address from your browser after `!code plaud`, including the part after the `?`.";
      return deps.finishPlaud(agent, rest);
    }

    case "disconnect":
    case "logout": {
      const { which } = splitConnector(cmd.arg);
      if (!which) return "Which one? Right now there is `!disconnect plaud`.";
      if (which !== "plaud") return unknownConnector(which);
      if (!deps.disconnectPlaud) return "I have no way to disconnect an account on this deployment.";
      return deps.disconnectPlaud(agent);
    }

    case "connect": {
      if (!deps.connectPlaud) return "I have no way to connect an account on this deployment.";
      const { which, rest } = splitConnector(cmd.arg);
      if (!which) return "Which one? Right now I can connect `!connect plaud`.";
      if (which !== "plaud") return unknownConnector(which);
      if (rest.toLowerCase() !== "again" && (await deps.plaudConnected?.(agent).catch(() => false))) {
        // Reconnecting revokes nothing but does replace the tokens, so it is worth one sentence
        // rather than silently doing it to somebody who typed the wrong thing.
        return "✅ Your Plaud account is already connected. Type `!connect plaud again` to sign in with a different one.";
      }
      return deps.connectPlaud(agent, conversation);
    }

    case "new":
      if (!deps.resetSession) return NEW_NOOP;
      deps.resetSession(agent, conversation);
      return NEW_DONE;

    case "status":
    case "usage": {
      const windows = await deps.windows(agent).catch(() => [] as UsageWindow[]);
      const u = deps.lastUsage(conversation);
      // Account headroom is always answerable; per-turn numbers only after a turn has run here.
      if (!u) return `${renderWindows(windows, now)}\n\n_No turn has run in this thread yet, so there is nothing per-turn to report._`;
      return renderStatus("full", u, deps.getModel(agent, conversation), windows, now) ?? renderWindows(windows, now);
    }

    case "statusline": {
      if (!cmd.arg) {
        return `📊 Status line is *${deps.getMode(conversation)}*. Set it with \`!statusline ${STATUS_MODES.join("|")}\`.`;
      }
      const mode = parseStatusMode(cmd.arg);
      if (!mode) return `I don't know the mode "${cmd.arg}". Use \`!statusline ${STATUS_MODES.join("|")}\`.`;
      deps.setMode(conversation, mode);
      return `📊 Status line is now *${mode}*.`;
    }

    case "model": {
      const current = deps.getModel(agent, conversation);
      if (!cmd.arg) {
        return current
          ? `🧠 This conversation is running *${current}*.`
          : "🧠 This conversation is on the default model.";
      }
      if (cmd.arg.toLowerCase() === "default") {
        deps.setModel(agent, conversation, undefined);
        return "🧠 Back to the default model from the next message.";
      }
      deps.setModel(agent, conversation, cmd.arg);
      // Deliberately not validated here: the harness owns the list of valid names, and an invalid
      // one surfaces on the next turn as the harness's own error rather than as our guess at it.
      // Scoped to THIS conversation — it does not move anybody else's model.
      return `🧠 Model set to *${cmd.arg}* for this conversation — from the next message.`;
    }

    default:
      return null;
  }
}
