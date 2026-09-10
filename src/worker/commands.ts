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

/** What starts a command. One character, on purpose.
 *
 *  `!` is the conventional bot prefix and Slack does nothing special with it.
 *
 *  `.` was briefly accepted too, because `!` is also how Claude Code runs a shell command.
 *  Withdrawn on the reasoning that settles it: that interception happens INSIDE Claude Code, before
 *  anything is ever sent — so a second prefix here cannot help with a keystroke this code never
 *  sees. It was surface for a collision that cannot occur.
 *
 *  `/` is deliberately not one either, and used to be. Slack owns that namespace: an unregistered
 *  slash command is intercepted by Slack, answered with Slack's own error, and never delivered
 *  here. So `/status` has never once reached this function — support that is real in the code and
 *  imaginary in practice, which is worse than not having it. */
const PREFIX = /^!/;

/** Turn a marketing model name into the exact name the Claude CLI understands.
 *
 *  Three shapes, and only these are rewritten:
 *
 *   - a BARE family — `opus`, `sonnet`, `haiku` — is the CLI's own alias, the LATEST of that family.
 *     It is kept as-is, because that is the future-proof value: when a new generation ships, `opus`
 *     follows it and a pinned id does not (see the roster's stored default).
 *
 *   - a family WITH a version — `opus-5`, "Opus 5", `opus5`, `opus 4.8` — names a SPECIFIC model,
 *     which the CLI spells `claude-<family>-<version>` (`claude-opus-5`, `claude-opus-4-8`). This is
 *     the case that used to strand a conversation: the CLI knows `opus` and `claude-opus-5`, never
 *     `opus-5`, so the reasonable read of the Hub's "Claude Opus 5" label failed cryptically on the
 *     next turn. It now becomes the specific id, and — the point of doing this precisely — `opus-4-8`
 *     becomes `claude-opus-4-8` rather than silently collapsing to the latest opus.
 *
 *  Everything else — a full `claude-…` id a person pasted, a Bedrock profile, an unknown string —
 *  passes through UNTOUCHED. The harness owns the real list, so an id it does not know still surfaces
 *  its own error rather than a guess at it, and a deliberate pin is never mangled. */
export function canonicalModel(raw: string): string {
  const s = raw.trim();
  const low = s.toLowerCase();
  if (/^(opus|sonnet|haiku)$/.test(low)) return low; // the CLI alias — the latest of that family
  const m = low.match(/^(opus|sonnet|haiku)[\s._-]*(\d[\d._-]*\d|\d)$/);
  if (m) {
    const version = m[2].replace(/[._]/g, '-').replace(/-+/g, '-');
    return `claude-${m[1]}-${version}`; // a specific model: claude-opus-5, claude-opus-4-8
  }
  return s;
}

/** PURE: strip the FORMATTING off a line so the command inside it can be seen.
 *
 *  Slack delivers markdown source, not rendered text, so a message typed as code arrives as
 *  "`!connect claude`" — backticks and all — and no command matches it.
 *
 *  That is not an exotic way to type it. It is what happens when somebody copies the instruction we
 *  gave them: notLoggedInNotice() says Send `!connect claude`, and pasting that back is the most
 *  obedient thing a person can do. We wrote the trap and then failed to open it.
 *
 *  Only a whole wrap comes off, never a stray backtick inside an argument, and at most a few layers
 *  — a copied line can arrive wrapped in both code and bold. */
export function undecorate(text: string): string {
  let t = (text ?? "").trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t
      .replace(/^```+\s*([\s\S]*?)\s*```+$/, "$1")
      .replace(/^`([^`]*)`$/, "$1")
      .replace(/^([*_~])([\s\S]*)\1$/, "$2")
      .trim();
    if (t === before) break;
  }
  return t;
}

/** Recognise a command. Returns undefined for ordinary text, which is the common case — so this
 *  runs on every inbound message and must not be clever about it. */
export function parse(text: string): Command | undefined {
  const t = undecorate(text);
  if (!PREFIX.test(t) || !/^![a-z]/i.test(t)) return undefined;
  const m = /^!(\S+)\s*([\s\S]*)$/.exec(t);
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
  /** Start a three-legged login and return the URL to put in front of the person, or a problem to
   *  show them. The registry owns the flow — it holds the client secret and the pending state; the
   *  worker only carries the answer into the channel. */
  beginOauth?(
    agent: string,
    provider: string,
    alias: string,
    conversation: string,
  ): Promise<{ url?: string; problem?: string }>;
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
  /** Offer a fresh Claude login in this conversation. Returns "" when the offer IS the message: it
   *  is posted as blocks, and returning text as well would post the whole thing twice. */
  connectClaude?(agent: string, conversation: string): Promise<string>;
  /** Offer the calendar dialog. Same contract: "" when the blocks are the message. */
  connectIcs?(agent: string, conversation: string): Promise<string>;
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
  "• `!connect google` / `!connect outlook` — add a calendar, so I know which meeting a recording was",
  "• `!connect ics` — add a calendar by its published address, when the account itself is blocked",
  "•  …add a name to keep more than one: `!connect google work`",
  "• `!connect claude` — sign in to the Claude subscription I answer on",
  "• `!disconnect plaud` — forget it again",
  "• `!disconnect claude` — sign out of the Claude subscription I answer on",
  "• `!connections` — what this agent is connected to",
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

/** PURE: one list of what an agent is connected to, from stores that do not know about each other.
 *
 *  THE BUG THIS EXISTS FOR. `!connect plaud` answered "your Plaud account is already connected" and
 *  `!connections`, one line later, answered "nothing is connected yet". Neither was wrong: the
 *  first asks the token store, the second listed `connection` rows, and Plaud predates the
 *  connection model so it has never had a row. A person cannot be expected to know which question
 *  they asked.
 *
 *  THE REGISTRY WINS on any kind it holds. It is the store the connection model is migrating
 *  towards, so once a kind has a row there, that row is the truth and the legacy check is noise.
 *  This is what makes the merge a bridge rather than a permanent second source: when Plaud moves,
 *  its entry here stops being reachable and nothing else changes. */
export function mergeConnections(registry: readonly ConnectionLine[], legacy: readonly ConnectionLine[]): ConnectionLine[] {
  const kinds = new Set(registry.map((c) => c.kind));
  return [...registry, ...legacy.filter((c) => !kinds.has(c.kind))];
}

/** The credentials that live OUTSIDE the registry, asked of the connectors that own them.
 *
 *  Failures are swallowed deliberately: a token store that cannot be read should not turn
 *  `!connections` into an error page. An absent line reads as "not connected", which is the safer
 *  of the two wrong answers here — the other one hides the calendars that ARE connected. */
async function gatherLegacy(deps: CommandDeps, agent: string): Promise<ConnectionLine[]> {
  const out: ConnectionLine[] = [];

  if (await deps.plaudConnected?.(agent).catch(() => false)) {
    out.push({ kind: "plaud", alias: "default", label: "Plaud account", status: "connected" });
  }

  // The Claude subscription belongs here too, and its absence was the other half of the confusion:
  // an agent is plainly "connected to" the thing it answers on, and `!connections` never said so.
  const account = await deps.claudeAccount?.(agent).catch(() => "");
  if (account && !/^not signed in/i.test(account)) {
    out.push({
      kind: "claude",
      alias: "default",
      label: "Claude subscription",
      status: "connected",
      externalAccount: account,
    });
  }

  return out;
}

/** The connector a connection command names, and whatever follows it. A pasted callback address
 *  is one long token, so the split is on the FIRST word only. */
export function splitConnector(arg: string): { which: string; rest: string } {
  const t = (arg ?? "").trim();
  if (!t) return { which: "", rest: "" };
  const i = t.search(/\s/);
  if (i < 0) return { which: t.toLowerCase(), rest: "" };
  return { which: t.slice(0, i).toLowerCase(), rest: t.slice(i + 1).trim() };
}

/** What `!connect` ACTUALLY dispatches. Declared once, because the version of this that lived only
 *  inside a sentence disagreed with the code: `!connect claude` was refused with
 *  `I don't have a "claude" connector. Today: plaud, google, outlook or claude.` - a message that
 *  contradicts itself in one line, reached by following the instruction the agent had just given.
 *  The dispatch below is checked against this list, so the two cannot drift apart again without a
 *  test failing. */
export const CONNECT_KINDS = ["claude", "plaud", "google", "outlook", "ics"] as const;

/** The refusal names what is available HERE - `!code` takes only plaud, `!disconnect` takes two -
 *  rather than reciting one global list in a context where most of it is wrong. */
function unknownConnector(which: string, allowed: readonly string[]): string {
  const q = allowed.map((c) => `\`${c}\``);
  const list = q.length > 1 ? `${q.slice(0, -1).join(", ")} or ${q[q.length - 1]}` : (q[0] ?? "none");
  return `I don't have a "${which}" connector here. I can do: ${list}.`;
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
      if (which && which !== "plaud") return unknownConnector(which, ["plaud"]);
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
      if (which !== "plaud") return unknownConnector(which, ["plaud", "claude"]);
      if (!deps.disconnectPlaud) return "I have no way to disconnect an account on this deployment.";
      return deps.disconnectPlaud(agent);
    }

    case "connect": {
      const { which, rest } = splitConnector(cmd.arg);
      if (!which) return `Which one? ${CONNECT_KINDS.map((c) => `\`!connect ${c}\``).join(", ")}.`;
      if (!(CONNECT_KINDS as readonly string[]).includes(which)) return unknownConnector(which, CONNECT_KINDS);

      // The subscription this agent ANSWERS on, as opposed to an outside account it reads. Listed
      // with the others because that is not a distinction a person has any reason to know - and
      // `!disconnect claude` has always existed, so the missing half read as a broken command.
      if (which === "claude") {
        if (!deps.connectClaude) return "I have no way to sign in to Claude on this deployment.";
        return deps.connectClaude(agent, conversation);
      }

      // A published calendar address, which has no login at all - only a URL. Collected in a dialog
      // rather than typed here because the URL IS the credential: anyone holding it reads the
      // calendar forever, and a pasted link stays in channel history and in workspace exports.
      if (which === "ics") {
        if (!deps.connectIcs) return "I can't add a calendar on this deployment.";
        return deps.connectIcs(agent, conversation);
      }

      // The calendar providers. Three-legged, and they land on our OWN callback rather than on a
      // dead page somebody has to copy out of a browser bar — those apps are ours, so we chose the
      // redirect. Nothing comes back through the channel at all.
      if (which === "google" || which === "outlook") {
        if (!deps.beginOauth) return "I can't connect that on this deployment.";
        // Everything after the connector name is what they want to CALL it — "work", "personal".
        // A tenant can have several of each, and this is how a person tells them apart afterwards.
        const alias =
          (rest || "default").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
          "default";
        const r = await deps.beginOauth(agent, which, alias, conversation);
        if (!r.url) return `⚠️ I couldn't start that — ${r.problem ?? "no reason given"}.`;
        const what = which === "google" ? "Google Calendar" : "Outlook Calendar";
        return (
          `*Connect ${what}* — <${r.url}|open this and approve>.\n` +
          "You'll land on a page that says it worked. Nothing to copy back.\n" +
          `I'll file it as *${alias}*` +
          (alias === "default" ? " — put a name after the command if you want more than one." : ".")
        );
      }

      if (!deps.connectPlaud) return "I have no way to connect an account on this deployment.";
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
      // Marketing name → CLI alias, so `!model opus-5` (a reasonable read of the Hub's "Claude Opus
      // 5") means `opus` rather than a model that does not exist. A full `claude-…` id or an unknown
      // name still passes through and surfaces the harness's own error — the harness owns the real
      // list; this only rescues the family names a person actually types. Scoped to THIS conversation.
      const model = canonicalModel(cmd.arg);
      deps.setModel(agent, conversation, model);
      const note = model !== cmd.arg.trim() ? ` (\`${cmd.arg.trim()}\` → \`${model}\`)` : "";
      return `🧠 Model set to *${model}* for this conversation${note} — from the next message.`;
    }

    case "connections": {
      if (!deps.connections) return "I can't see connections on this deployment.";
      // The registry is only ONE of the places a credential lives, and answering from it alone is
      // how `!connect plaud` came to say "already connected" one line above `!connections` saying
      // "nothing is connected yet". Both were right about their own store. See mergeConnections.
      const list = mergeConnections(await deps.connections(agent), await gatherLegacy(deps, agent));
      if (list.length === 0) {
        // Not an error, and worth saying in words. An empty list and a broken lookup look identical
        // if the answer is a blank line.
        return `Nothing is connected yet. Try ${CONNECT_KINDS.map((c) => `\`!connect ${c}\``).join(", ")}.`;
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
