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

/** Every command this agent answers. The ONE list — the help text, the unknown-command reply and
 *  the dispatch all read from it, so a command cannot exist in one and not the others. */
export const KNOWN = [
  "help",
  "commands",
  "status",
  "usage",
  "statusline",
  "model",
  "connect",
  "connections",
  "disconnect",
  "logout",
  "code",
  "callback",
  "new",
] as const;

/** What starts a command.
 *
 *  `!` is the conventional bot prefix and Slack does nothing special with it. `.` is here because
 *  `!` is also how Claude Code runs a shell command, and somebody who lives in that terminal reaches
 *  for it by habit — two characters of regex is a cheap way to let a habit differ from a default.
 *
 *  `/` is deliberately NOT one of them, and used to be. Slack owns that namespace: an unregistered
 *  slash command is intercepted by Slack, answered with Slack's own error, and never delivered
 *  here. So `/status` has never once reached this function — the support was real in the code and
 *  imaginary in practice, which is worse than not having it. */
const PREFIX = /^[!.]/;

/** Recognise a command. Returns undefined for ordinary text, which is the common case — so this
 *  runs on every inbound message and must not be clever about it. */
export function parse(text: string): Command | undefined {
  const t = (text ?? "").trim();
  if (!PREFIX.test(t) || !/^[!.][a-z]/i.test(t)) return undefined;
  const m = /^[!.](\S+)\s*([\s\S]*)$/.exec(t);
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), arg: (m[2] ?? "").trim() };
}

/** PURE: the closest command to something somebody typed, or undefined.
 *
 *  Prefix matching in both directions rather than an edit distance: `!connections` should suggest
 *  `!connect`, and `!conn` should too. That is the actual shape of the mistake — people guess at a
 *  longer or shorter form of a command they half-remember, not at an anagram of one. */
export function nearest(name: string, known: readonly string[] = KNOWN): string | undefined {
  const n = name.toLowerCase();
  const hit = known.find((k) => k === n) ?? known.find((k) => n.startsWith(k) || k.startsWith(n));
  return hit;
}

/** One outside account, as a person needs to see it: what it is, what they called it, and whether
 *  it is actually working. */
export interface ConnectionLine {
  kind: string;
  alias: string;
  label?: string;
  status?: string;
  externalAccount?: string;
}

export interface CommandDeps {
  /** What this agent is connected to. Absent on a deployment with no registry behind it. */
  connections?(agent: string): Promise<ConnectionLine[]>;
  /** The conversation's status-footer mode. */
  getMode(conversation: string): StatusMode;
  setMode(conversation: string, mode: StatusMode): void;
  /** The last turn's usage in this conversation, if one has run. */
  lastUsage(conversation: string): TurnUsage | undefined;
  /** Account headroom (5h / 7d). Fetched from the agent's own runtime; [] when unavailable. */
  windows(agent: string): Promise<UsageWindow[]>;
  /** Which Claude account THIS agent runs on. Empty when the deployment cannot say.
   *
   *  Worth a line in `!status` because it is otherwise unknowable from the outside: two agents
   *  answering identically may be spending two different people's subscriptions, or the same one
   *  twice, and nothing in a reply distinguishes those. */
  claudeAccount?(agent: string): Promise<string>;
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
  /** Sign this agent out of its Claude subscription. */
  disconnectClaude?(agent: string): Promise<string>;
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
  "• `!disconnect claude` — sign out of the Claude subscription I answer on",
  "• `!connections` — what this agent is connected to",
  "• `!new` — forget this thread and start over",
  "• `!help` — this",
  "",
  "_`.` works too, if you prefer it to `!`._",
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
  return `I don't have a "${which}" connector. Today it is \`plaud\` or \`claude\`.`;
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
      if (!which) return "Which one? `!disconnect plaud` or `!disconnect claude`.";
      if (which === "claude") {
        if (!deps.disconnectClaude) return "I have no way to sign out of Claude on this deployment.";
        return deps.disconnectClaude(agent);
      }
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
      const account = (await deps.claudeAccount?.(agent).catch(() => "")) ?? "";
      const who = account ? `🔑 Claude account: ${account}` : "";
      const u = deps.lastUsage(conversation);
      // Account headroom is always answerable; per-turn numbers only after a turn has run here.
      const body =
        u === undefined
          ? `${renderWindows(windows, now)}\n\n_No turn has run in this thread yet, so there is nothing per-turn to report._`
          : (renderStatus("full", u, deps.getModel(agent, conversation), windows, now) ?? renderWindows(windows, now));
      return who ? `${who}\n\n${body}` : body;
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

    case "connections": {
      if (!deps.connections) return "I can't see connections on this deployment.";
      const list = await deps.connections(agent);
      if (list.length === 0) {
        // Not an error, and worth saying in words. An empty list and a broken lookup look identical
        // if the answer is a blank line.
        return "Nothing is connected yet. `!connect plaud` to start, or ask me to add a calendar.";
      }
      const lines = list.map((c) => {
        // The NAME first, because that is what a person gave it and what they will use to refer to
        // it. The kind is a detail; `Foley Outlook ICS` means something, `ics` does not.
        const name = c.label || c.alias;
        const who = c.externalAccount ? ` — ${c.externalAccount}` : "";
        // Only when it is NOT connected. A green tick on every line trains people to stop reading;
        // a line that says something only when something is wrong keeps its meaning.
        const bad = c.status && c.status !== "connected" ? `  ⚠️ ${c.status}` : "";
        return `• *${name}* (\`${c.kind}/${c.alias}\`)${who}${bad}`;
      });
      return [`*Connected* — ${list.length} thing${list.length === 1 ? "" : "s"}:`, ...lines].join("\n");
    }

    default: {
      // NEVER fall through to a turn.
      //
      // It used to return null here, which handed `!connections` to the harness as ordinary text —
      // and the harness, being Claude Code, answered confidently about ITS OWN connectors: Google
      // Drive, Gmail, MCP. A plausible answer to a question nobody asked, about a different system
      // entirely. Silence would have been better; this is better than silence.
      //
      // The prefix is deliberate and learned, so anything wearing it is a command attempt. Saying
      // so costs one message; guessing wrong costs somebody their afternoon.
      const guess = nearest(cmd.name);
      return (
        `I don't know \`!${cmd.name}\`.` +
        (guess ? ` Did you mean \`!${guess}\`?` : "") +
        `\n\n${HELP}`
      );
    }
  }
}
