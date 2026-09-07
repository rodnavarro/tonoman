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
  /** The harness's model knob, when the harness has one. */
  getModel(agent: string): string | undefined;
  setModel?(agent: string, model: string | undefined): void;
}

const HELP = [
  "*Commands* — type these as an ordinary message.",
  "• `!status` — token use for the last turn and how much of your Claude plan is left",
  `• \`!statusline ${STATUS_MODES.join("|")}\` — whether that shows under every answer`,
  "• `!model` — which model I am running; `!model <name>` to change it",
  "• `!new` — how to start a fresh conversation",
  "• `!help` — this",
].join("\n");

/** How a new conversation actually works here.
 *
 *  Not a command that clears anything: the workflow id IS the Slack thread, so a new thread is a
 *  new conversation by construction. Saying that plainly is more useful than a `!new` that
 *  pretends to reset something. */
const NEW = [
  "Every thread is its own conversation — I keep no memory across them.",
  "Start a fresh one with the ✏️ *New chat* button at the top of this pane, or by replying in a new thread.",
  "That is what `/new` did on Telegram and Teams; in Slack the thread already is it.",
].join("\n");

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

    case "new":
      return NEW;

    case "status":
    case "usage": {
      const windows = await deps.windows(agent).catch(() => [] as UsageWindow[]);
      const u = deps.lastUsage(conversation);
      // Account headroom is always answerable; per-turn numbers only after a turn has run here.
      if (!u) return `${renderWindows(windows, now)}\n\n_No turn has run in this thread yet, so there is nothing per-turn to report._`;
      return renderStatus("full", u, deps.getModel(agent), windows, now) ?? renderWindows(windows, now);
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
      const current = deps.getModel(agent);
      if (!cmd.arg) return current ? `🧠 I'm running *${current}*.` : "🧠 This harness has no model switch.";
      if (!deps.setModel) return "🧠 This harness has no model switch.";
      deps.setModel(agent, cmd.arg);
      // Deliberately not validated here: the harness owns the list of valid names, and an invalid
      // one surfaces on the next turn as the harness's own error rather than as our guess at it.
      return `🧠 Model set to *${cmd.arg}* — it takes effect on the next message.`;
    }

    default:
      return null;
  }
}
