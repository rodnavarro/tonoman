// The turn, as a Temporal activity.
//
// It reuses the runtime that already exists rather than reimplementing it: the harness Runner
// spawns `claude` and yields TurnEvents, and the connector's Reply posts and edits in the channel.
// The activity is the thin thing between them — which is the point, because a durable turn should
// not be a second implementation of a turn.
//
// The activity does the posting rather than returning text for the caller to post. That is what
// makes streaming survive the split: the process running the model is the process holding the
// channel credential, so a partial answer reaches the person as it is produced, and a cancellation
// leaves that partial visible and labelled rather than vanishing.

import { Context } from "@temporalio/activity";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Connector, Reply, TurnEvent, TurnUsage } from "../core/contracts";
import type { AgentConfig } from "../config";
import * as recap from "./recap";
import * as inference from "./inference";
import { meetingRecap } from "./talents/meeting-recap";
import * as calendar from "./calendar";
import * as worklog from "./worklog";
import { decideRoute, privateReason, THREAD_NOTE, THREAD_NOTE_FAILED, type Audience } from "../brains/delivery";
import type { McpServerSpec } from "../brains/broker";
import type { BrainRef, BrainStore } from "../brains/store";
import { randomMysticVerb } from "../core/mystic";
import type { CapabilityPlane } from "./capability-plane";
import { isAuthError } from "../authflow";
import { authFailureState, notLoggedInNotice } from "../turnfailure";

/** How the worker finds an agent's connector and runner. Injected at worker construction so this
 *  module holds no globals and can be unit-tested without Temporal. */
export interface TurnDeps {
  agent(name: string): { cfg: AgentConfig; conn: Connector; context?: string; run: (req: TurnRunReq, signal?: AbortSignal) => AsyncIterable<TurnEvent> } | undefined;
  /** What this agent needs to run the voice flow, or undefined if it is not configured for one. */
  voice?(name: string): VoiceConfig | undefined;
  /** The capability plane, started at worker boot. `runTalent` spawns a Talent CLI through it; the
   *  plane provides the Talent transcription/inference/publish over localhost. Undefined in tests and
   *  on a file roster with no plane. */
  talentPlane?: CapabilityPlane;
  /** Run an inference on the AGENT'S OWN inference provider — the Claude Code harness (its
   *  subscription), not a side model — and return the reply text. A headless turn: the prompt runs
   *  through the agent's runner and the `done` text is captured, never posted. This is what the
   *  Talent `infer` capability routes to, so a recap is the agent thinking, on its own brain. The
   *  provider is the agent's harness today (claude-code); codex / an OpenAI subscription plug in at
   *  this one dispatch point later.
   *
   *  `owner` is the person the item belongs to (a recording's owner). On an agent whose inference is
   *  per person, the inference runs on THAT person's subscription — the same rule a turn follows for
   *  its speaker — rather than on the agent's own login. */
  infer?(agent: string, p: { system: string; user: string }, owner?: string): Promise<string>;
  /** Read one connected Google calendar for a window, through the registry's token refresh. */
  googleCalendar?(agent: string, feed: calendar.CalendarFeed, from: number, to: number): Promise<calendar.CalEvent[]>;
  /** A granted Talent's saved config for this agent (`agent_talent.config`), or `{}`. */
  talentConfig?(agent: string, talent: string): Record<string, unknown>;
  /** Say something verbatim to a person, opening a DM if needed. */
  say?(agent: string, user: string, text: string): Promise<void>;
  /** Record what this agent's — or this PERSON's — inference credential is now worth (W3). Called
   *  from a login outcome and from the tail of a turn that failed for want of one. Best-effort by
   *  contract: it must never become a new way for a turn to fail. */
  reportAuthState?(
    agent: string,
    state: "ok" | "error" | "expired" | "unconfigured",
    user?: string,
    /** The provider the outcome is about. An outcome for a provider the agent no longer uses is
     *  dropped (INFER-SWITCH-COUNTS-CURRENT); absent = the agent's current one. */
    provider?: "claude" | "codex",
  ): Promise<void>;
  /** How this agent's provider is named to a person ("Claude" / "Codex"), for a notice that has to
   *  tell somebody which login to start. */
  providerLabel?(agent: string): string;
  /** The durable record of one item of one Talent run: opened before the run, closed either way.
   *
   *  Behind a hook rather than a direct database call for the same reason everything else here is:
   *  the worker holds no connection string. It asks the registry, over the same system-token API it
   *  already uses for the roster. */
  talentRun?: {
    open(
      agent: string,
      talent: string,
      itemKey: string,
      version: number,
      o?: { trigger?: "schedule" | "command" | "hub"; requestedBy?: string; forUser?: string },
    ): Promise<void>;
    close(
      agent: string,
      talent: string,
      itemKey: string,
      status: "done" | "failed",
      error?: string,
      /** What the run produced: the announcement text, and where the output can be read. */
      result?: { summary: string; links?: { label: string; url: string }[] },
    ): Promise<void>;
    /** The durable status of one item, for the recording-level idempotency guard: a prior `done`
     *  lets a re-run skip the transcription + inference it would otherwise re-pay. Best-effort like
     *  the rest — it returns `undefined` on any read failure so the guard fails OPEN (the run
     *  proceeds), never blocking a genuinely-new recording because the registry blinked. */
    status?(
      agent: string,
      talent: string,
      itemKey: string,
    ): Promise<{ status: "running" | "done" | "failed"; attempts: number } | undefined>;
  };
  /** Run text as a turn addressed to a person. `drewOn`: brains the text draws on (a Talent's filing). */
  ask?(agent: string, user: string, text: string, drewOn?: string[]): Promise<void>;
  /** The display-only status footer for a finished turn: the model, the turn's tokens, context
   *  occupancy, and how much of the Claude plan's 5h/7d windows is left. Null for none. */
  footer?(agent: string, conversation: string, usage: TurnUsage | undefined): Promise<string | null>;
  /** Remember the turn's usage, so `!status` can report it later without spending a turn. */
  recordUsage?(agent: string, conversation: string, usage: TurnUsage): void;
  /** The model this conversation is set to, if it has chosen one.
   *
   *  Per CONVERSATION. The harness's own model knob is per process, so one worker serving two
   *  people meant `!model opus` in one thread silently moved everybody else too — which is what
   *  happened the first time two users shared this worker. */
  /** The model for a turn: the conversation's `!model` choice, else the agent's CURRENT default. */
  modelFor?(agent: string, conversation: string): string | undefined;
  /** The harness session this conversation continues in, MARKED AS IN USE by the act of asking.
   *
   *  Without one, every message is a fresh `claude` run: the agent answers a question perfectly and
   *  then cannot remember it thirty seconds later ("I don't have anything above this to convert —
   *  this looks like the start of our conversation"). The window is not re-sent on stdin because
   *  the harness holds it; only the new message rides in the prompt.
   *
   *  Claiming rather than peeking is what keeps `--session-id` to exactly one use per id, which is
   *  its contract. Every later turn resumes, and the one way that can be wrong — no session on disk
   *  — is the one case `resetSession` below repairs. */
  claimSession?(agent: string, conversation: string): Promise<{ id: string; isNew: boolean }>;
  /** Abandon this conversation's session and hand back a fresh one. The resume-miss repair, and
   *  what `!new` does. */
  resetSession?(agent: string, conversation: string): Promise<{ id: string; isNew: boolean }>;
  brains?: TurnBrains;
  /** Where a Talent run files its pages (BRAIN-TALENT-TARGET). `undefined` = the agent's second brain,
   *  as it always has (BRAIN-MIGRATION); an error = the run cannot file, and says which brain and why. */
  talentBrain?: {
    target(agent: string, user: string | undefined, talent: string): Promise<TalentBrainTarget | { error: string } | undefined>;
    store: Pick<BrainStore, "read" | "writeFiles">;
  };
}

export interface TalentBrainTarget {
  /** The agent the run is for — so a restart can finish the filing and tell the person. */
  agentGuid?: string;
  id: string;
  name: string;
  brain: BrainRef;
  who: string;
  authorize: () => Promise<boolean>;
}

/** PURE: the text of a transcript value, whichever shape it arrived in. */
function transcriptText(v: unknown): string {
  if (typeof v === "string") return v;
  const t = (v as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
}

/** PURE: who transcribed it, for the page to state. Empty when the value predates provenance or
 *  every chunk came from a cache that records none — which `transcribedBy` then says out loud
 *  rather than guessing at. */
function transcribedByOf(v: unknown): string[] {
  const by = (v as { by?: unknown } | null)?.by;
  return Array.isArray(by) ? (by as string[]) : [];
}

/** Keep an activity's heartbeat alive on a TIMER while `work` runs.
 *
 *  WHY A TIMER AND NOT MORE CALLS. `heartbeatTimeout` is how long Temporal waits before declaring
 *  an activity dead, and the only heartbeats during a transcription fired BETWEEN chunks — so the
 *  real gap was the wall time of ONE 600-second chunk. That made a liveness timeout into an
 *  accidental throughput limit: a slower provider, or one busy machine, and a perfectly healthy
 *  transcription is killed and started again from the beginning.
 *
 *  It mattered less while a single fast cloud provider bounded the gap. It stops being an
 *  abstraction the moment any local server is in the list, because the gap becomes a property of
 *  somebody's hardware. With this, progress reporting and liveness go back to being separate
 *  things: `onProgress` still says how far along we are, and the heartbeat says the worker is
 *  alive — which is the only question the timeout was ever asking.
 *
 *  `note()` is read at each tick rather than captured, so the heartbeat carries the CURRENT step
 *  and a stalled activity says which chunk it stalled on. */
async function beating<T>(note: () => string, work: () => Promise<T>): Promise<T> {
  const ctx = Context.current();
  const timer = setInterval(() => {
    // Never let the keep-alive be what fails the activity: outside an activity context, or once
    // cancellation has begun, heartbeating throws and the real work is still fine.
    try {
      ctx.heartbeat(note());
    } catch {
      /* the work below is what matters */
    }
  }, 15_000);
  // `unref` so a pending timer can never hold the worker process open at shutdown.
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** One Plaud account feeding an agent's voice flow.
 *
 *  An agent watches ONE account today — the tenant's shared login — and still does for every tenant
 *  that has not gone per-person. A per-person tenant watches one account per member, so the poll
 *  fans out over these and attributes each recording to the member whose account it came from. */
export interface VoiceAccount {
  /** The member this account belongs to — a Slack user id — or undefined for the tenant's one
   *  shared account (every agent before per-person, and still Sapien's). */
  user?: string;
  /** How to read this account's recordings. */
  creds: recap.PlaudCreds;
  /** Who a recap from this account is announced to, when set. The shared account leaves this unset
   *  so the poll's own `notify` is used, exactly as before. */
  notifyUser?: string;
  /** Earliest recording this account may reach — a member's own connect time, so somebody who joins
   *  today does not backfill the tenant's whole history. Falls back to the agent floor. */
  floorMs?: number;
}

export interface VoiceConfig {
  /** Where this agent's recaps are announced: a Slack channel id.
   *
   *  A property of the FLOW, per agent, not of the worker — one worker runs every agent a tenant
   *  has, and "which channel does Nelly post recaps to" is a different question for each of them.
   *  Empty falls back to a DM with `notify`, which works but makes it impossible to tell from the
   *  outside whether a recap went to Rod or to Celine.
   *
   *  Belongs in the agent's registry row; it arrives from the environment until that column
   *  exists, which is why it is shaped like configuration rather than read from `process.env`
   *  where it is used. */
  notifyChannel?: string;
  creds: recap.PlaudCreds;
  /** The second-brain checkout the recap is written into. */
  brainDir: string;
  /** Push URL carrying the credential — used for one command, never left on disk. */
  pushUrl: string;
  /** Who transcribes, in order of preference. A LIST because one key was three separate
   *  impossibilities: no tenant could bring its own transcription, a rotated key killed every
   *  meeting while a working spare sat unused, and there was nowhere to put a local server. */
  transcribe: inference.Provider[];
  /** Who summarises. A SEPARATE list, because it is a different job with a different constraint:
   *  the transcription tier's 8000-token context cannot summarise a 62-minute meeting at any
   *  price, and that is a fact about the summariser, not about the audio. */
  summarize: inference.Provider[];
  /** What the TENANT is trying to do — one sentence, from the registry, shared by every agent the
   *  tenant has. Empty means this flow does not judge, which is the ordinary state until somebody
   *  writes one. */
  mission?: string;
  /** The tenant's display timezone, IANA. Used for rendering only — matching is epoch milliseconds
   *  and the filename stamp stays UTC. */
  timezone?: string;
  vocab: string;
  /** Where a half-finished transcription keeps the chunks it already paid for, so a retry resumes.
   *  On the volume rather than in memory, because the thing being survived is a process that died
   *  or a quota that will not reset for hours. */
  chunkCacheDir?: string;
  /** Where meetings are filed, when this flow classifies them. Absent = the flat `Meetings/`
   *  layout, which is what a tenant with no folder scheme wants. */
  journal?: recap.Journal;
  /** How often the poll looks, from the registry. */
  pollSeconds?: number;
  /** Who a DM would go to, when no channel is configured. */
  notifyUser?: string;
  /** Epoch ms before which a recording is none of our business. Without it the first poll
   *  backfills the customer's entire Plaud history and announces each one as if it had just
   *  happened. */
  floorMs: number;
  /** Calendars this agent may read, URLs already resolved from the secret store. Empty is the
   *  ordinary state and costs nothing: the flow behaves exactly as it did before calendars. */
  calendars?: calendar.CalendarFeed[];
  /** Titles that are blocks rather than meetings — "Focus Time", "Lunch". From the registry. */
  calendarExclude?: string[];
  /** Which route a match on each calendar (by alias) files under. From `calendar.route.<alias>`. */
  calendarRoutes?: Record<string, string>;
  /** How far either side of a recording to look. Generous by default; see calendar.ts. */
  calendarPadMinutes?: number;
  /** The installed voice Talent — its name and version, populated from the roster the worker already
   *  holds. Present when the agent has a plaud-poll Talent granted and enabled. The poll pins the
   *  version onto the run so an edit to a live Talent cannot rewrite what an in-flight run is doing.
   *  There is no runner switch any more: a Talent is code, and the poll always runs it. */
  talent?: { name: string; version: number };
  /** Per-member Plaud accounts, when this agent's Plaud connection is per-person. Undefined or empty
   *  is the ordinary state: the poll reads the single shared `creds` exactly as it always has. */
  accounts?: VoiceAccount[];
}

/** The accounts this agent's poll iterates.
 *
 *  The invariant that keeps every existing tenant byte-identical: with no per-member accounts this
 *  is exactly the one shared account the flow always had — same `creds`, same floor — so
 *  `findNewRecordings`/`processRecording` make the same calls they made before per-person existed. */
export function accountsOf(v: VoiceConfig): VoiceAccount[] {
  return v.accounts && v.accounts.length
    ? v.accounts
    : [{ user: undefined, creds: v.creds, notifyUser: undefined, floorMs: v.floorMs }];
}

/** The account a recording belongs to — the member whose account it came from, else the shared one.
 *  `accountFor(v, undefined)` returns the shared account, which is why an un-tagged recording reads
 *  `v.creds` exactly as before. */
export function accountFor(v: VoiceConfig, user?: string): VoiceAccount {
  const all = accountsOf(v);
  return all.find((a) => a.user === user) ?? all[0];
}

/** Turn the members who have connected (from `TokenStore.listUsers`) into the poll's per-member
 *  accounts. Each reads from its member's own CLI-connected account (`cliAgent` + `cliUser`, the
 *  bearer `tokenJson` unused on that path), announces to that member, and floors at the later of the
 *  agent's floor and the member's own connect time — so somebody who joins today does not backfill
 *  the tenant's history. PURE, so `wireVoice` stays a thin call and this is unit-tested on its own. */
export function accountsFromUsers(
  agent: string,
  users: { user: string; connectedAt?: number }[],
  agentFloorMs: number,
  /** Per-member floor OVERRIDES, from `plaud_floor.<slack-id>` flow properties.
   *
   *  An override wins outright — over the agent floor AND over the member's own connect time — because
   *  that is precisely what it is for: backfilling the recordings somebody already had when they
   *  connected, which the default "floor at your connect time" rule exists to keep out. Keyed by
   *  member, so backfilling one person can never reach into another's account, and removing the row
   *  restores the default with nothing else to undo. */
  floorOverrides: Record<string, number> = {},
): VoiceAccount[] {
  return users.map((u) => ({
    user: u.user,
    creds: { tokenJson: "", cliAgent: agent, cliUser: u.user },
    notifyUser: u.user,
    floorMs: floorOverrides[u.user] ?? Math.max(agentFloorMs, u.connectedAt ?? 0),
  }));
}

export interface TurnRunReq {
  prompt: string;
  systemPromptFile?: string;
  /** The model for THIS turn. Per conversation, never per process — see `modelFor`. */
  model?: string;
  /** The harness session to run in, so the agent remembers the rest of the thread. */
  sessionId?: string;
  /** true = create it (`--session-id`); false = continue it (`--resume`). */
  sessionNew?: boolean;
  /** WHO is speaking (the connector's sender id). Carried so the run closure can pick the speaker's
   *  own credential when the agent runs inference per person; ignored for a shared-inference agent. */
  user?: string;
  /** Paths to attached files on the shared mount, passed through to the harness. */
  mediaPaths?: string[];
  /** A lean inference turn — no tools, no connectors, one turn. Set by Talent `infer`. */
  lean?: boolean;
  /** The brain tool, for this turn only. */
  mcpServers?: McpServerSpec[];
  /** The turn's own working folder. */
  cwd?: string;
}

/** PURE: the session a person's turns in a conversation continue in (D-THREAD-HISTORY). Each person
 *  has their own history of a thread, so one person's reading never rides into another's context.
 *  And one per provider (INFER-SWITCH-COUNTS-CURRENT): after the Hub switches an agent to Codex, the
 *  next turn starts a fresh session instead of trying to resume a Claude one. Claude keeps the
 *  unsuffixed name, so every session made before this still resumes. */
export function sessionKeyOf(conversation: string, user?: string, provider?: "claude" | "codex"): string {
  const base = `${conversation}#${(user ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "platform"}`;
  return provider === "codex" ? `${base}@codex` : base;
}

/** Which provider each person's latest turn in a conversation ran on, so a turn that fails for want
 *  of a login is recorded against THAT provider — not whatever the agent was switched to while it
 *  ran (INFER-SWITCH-COUNTS-CURRENT). Bounded; an entry is only needed until the notice is posted. */
const turnProvider = new Map<string, "claude" | "codex">();
const turnProviderKey = (agent: string, conversation: string, user?: string): string => `${agent}\u0000${conversation}\u0000${user ?? ""}`;

/** What a turn needs from the brains (docs/definition/objects/brain.md). Absent = no brains here. */
export interface TurnBrains {
  /** Open this person's brain access for one turn. Every brain it uses is recorded under `key` the
   *  moment it is used, before anything of it reaches the agent. */
  start(agent: string, user: string, who: string, key: string): { token: string; mcp: McpServerSpec } | undefined;
  /** Close it; the brains the turn used. */
  end(token: string): string[];
  /** Brains this person's history of the conversation has already drawn on. */
  provenance(agent: string, key: string): Promise<string[]>;
  remember(agent: string, key: string, used: string[]): Promise<void>;
  /** Who will see a reply here. */
  audience(agent: string, conversation: string, user: string): Promise<Audience>;
  /** What this person reaches right now: id → name. Null if the registry could not say. */
  reach(agent: string, user: string): Promise<Map<string, string> | null>;
  readableByAll(agent: string, brainIds: string[], members: string[]): Promise<string[] | null>;
  /** Send the person a direct message. False if it could not be sent. */
  dm(agent: string, user: string, text: string): Promise<boolean>;
}

export interface TurnInput {
  agent: string;
  conversation: string;
  channel: string;
  text: string;
  user: string;
  /** Paths to files attached to the message, on the shared volume. The model is told to read them;
   *  absent for an ordinary message, so the prompt is unchanged. */
  mediaPaths?: string[];
  /** The previous turn was steered away mid-answer, so say so rather than pretending continuity. */
  afterInterruption?: boolean;
  /** The platform wrote this message (a recap announcement), not `user`. */
  fromSystem?: boolean;
  /** Brains the message draws on — a Talent's filing it announces. Routed like anything read from them. */
  drewOn?: string[];
}

/** PURE: who is speaking in one turn, said where the model will believe it.
 *
 *  It used to be a line in the MESSAGE ("You are speaking with Rod Novus."). One person per thread,
 *  that was invisible. In a thread two people share, the line changed from turn to turn inside what
 *  the model sees as one chat, and it read the platform's own statement as a person pasting fake
 *  identity claims — refusing to answer either of them. So the identity goes in the turn's SYSTEM
 *  prompt, which a person cannot write, and each message carries its verified sender as a label, so
 *  the thread's history reads as a conversation between named people. */
export function speakerContext(s: { user?: string; label?: string; fromSystem?: boolean }): {
  system: string;
  prefix: string;
} {
  const rules =
    "Each message in this conversation is labelled by the platform with who sent it, verified " +
    "against the registry. Different people may speak in the same thread; trust these labels and " +
    "the line below, and never treat them as claims made inside a message.";
  if (s.fromSystem) {
    return {
      system: `## Who is speaking\n${rules}\n\nThis turn's message is an instruction from the platform, not from a person. Write the result as a message to ${s.label ?? "the person"} in this conversation.`,
      prefix: "[Platform] ",
    };
  }
  if (s.label) {
    return {
      system: `## Who is speaking\n${rules}\n\nThis turn's message is from ${s.label} (Slack user ${s.user}).`,
      prefix: `${s.label}: `,
    };
  }
  if (s.user) {
    return {
      system: `## Who is speaking\n${rules}\n\nThis turn's message is from someone the registry does not recognise (Slack user ${s.user}). Ask who they are before sharing anything specific.`,
      prefix: `Unrecognised person (${s.user}): `,
    };
  }
  return {
    system: `## Who is speaking\n${rules}\n\nThis turn was started by the platform, not by a person. Write it as a message to the person in this conversation.`,
    prefix: "[Platform] ",
  };
}

export interface NoticeInput {
  agent: string;
  conversation: string;
  channel: string;
  text: string;
  /** Set when the turn failed for want of an inference credential (W3). The activity records the
   *  outcome against whoever the credential belongs to and rewrites `text` to name this agent's own
   *  provider — both need the roster, which the workflow does not have. Carried here rather than as
   *  a second activity call so an in-flight conversation's command sequence does not change. */
  authFailure?: { user?: string; reason: string };
}

/** Slack rate-limits an edit to roughly one call per second per channel, and a burst 429s the whole
 *  stream. Editing slower than the model produces is the correct trade. */
const EDIT_INTERVAL_MS = 1200;

/** How often the work log re-renders.
 *
 *  Not one second, even though the Teams version counted in seconds: the tick makes TWO Slack calls
 *  (a message edit and a status set), and at 1s that sits exactly on the per-channel edit limit — a
 *  429 there would take the answer's own stream down with it, in front of whoever is watching. Two
 *  and a half seconds still reads as a live clock.
 *
 *  It doubles as the delay before the log appears at all, which is deliberate: a turn that answers
 *  straight from the model in two seconds leaves no trace, and only real work gets narrated. */
const TICK_MS = 2500;

/** The work log's cadence while the ANSWER is streaming. Slower, because the answer's own message
 *  is being edited on EDIT_INTERVAL_MS at the same time and they share one per-channel budget. The
 *  clock stepping every five seconds still reads as running; two writers at one second each does
 *  not read at all, because one of them gets a 429. */
const ANSWERING_TICK_MS = 5000;

/** One turn at a time per conversation.
 *
 *  Temporal's default activity cancellation is TRY_CANCEL: when a new message steers a turn, the
 *  WORKFLOW moves straight on to the next one without waiting for this activity to unwind. With a
 *  harness session that is not merely untidy — turn N+1 opens `--resume` on the same session file
 *  that turn N is still writing, and two `claude` processes appending to one transcript is how a
 *  remembered conversation becomes a corrupted one.
 *
 *  Chained rather than rejected, because the second message is a correction the person is waiting
 *  on, not a duplicate to drop. The wait is short: the steered turn is aborted through the run
 *  signal, so its child is killed rather than left to finish. */
export function serializer(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    // `then(fn, fn)` — the next turn runs whether the previous one answered or threw. A failed
    // turn that wedged the lock would silence the conversation for good.
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export function makeActivities(deps: TurnDeps) {
  const serialize = serializer();
  return {
    async runTurn(input: TurnInput): Promise<void> {
      return serialize(`${input.agent}/${input.conversation}`, () => oneTurn(deps, input));
    },


    async postNotice(input: NoticeInput): Promise<void> {
      // A turn that failed for want of an inference credential (W3). Two things happen here and both
      // need the ROSTER, which the workflow does not have: the outcome is recorded against whoever
      // the credential belongs to (the speaker on a per-person agent, the agent otherwise), and the
      // notice is rewritten to name THIS agent's provider — the workflow's text says
      // `!connect claude`, which on a codex agent sends somebody to an account it does not use.
      //
      // Both are best-effort and neither can stop the notice being posted: the turn has already
      // failed, and the person is owed an explanation more than the Hub is owed a row.
      let text = input.text;
      if (input.authFailure) {
        const label = deps.providerLabel?.(input.agent) ?? "Claude";
        text = notLoggedInNotice(`!connect ${label.toLowerCase()}`);
        await deps
          .reportAuthState?.(
            input.agent,
            authFailureState(input.authFailure.reason),
            input.authFailure.user,
            turnProvider.get(turnProviderKey(input.agent, input.conversation, input.authFailure.user)),
          )
          .catch((e) => console.error(`activities: ${input.agent} auth-state report failed: ${String(e)}`));
      }
      const found = deps.agent(input.agent);
      if (!found) return;
      const reply = found.conn.reply(input.conversation);
      // Clear the working cue first, because the commonest reason this notice exists is that the
      // turn which set that cue is no longer running to clear it itself — a pod replaced during a
      // deploy, an activity that lost its heartbeat. Slack disables the composer while a status is
      // set, so without this the person is told something went wrong in a thread they can no
      // longer type in, which is a worse place to leave them than the error was.
      //
      // Best-effort and before the message: an unclearable cue is the part that traps them.
      await reply.settle?.().catch(() => {});
      await reply.send(text);
    },

    // --- the voice flow -------------------------------------------------------------------------

    /** Which Talent this agent's poll runs for each recording — its name and version, for the run
     *  record and the dedup id.
     *
     *  Read by the poll trigger at the start of a tick rather than baked into the schedule, so the
     *  choice comes from the worker's live view of the agent (boot-resolved from the registry,
     *  §15.20) rather than from arguments frozen when the schedule was created. Falls back to the
     *  built-in Plaud Talent manifest when the roster carried no grant — the voice flow IS
     *  meeting-recap. There is no runner switch any more: a Talent is code, and the poll always runs
     *  it (`processRecording`, in the child workflow), for shared and per-person accounts alike. */
    async voicePlan(input: { agent: string }): Promise<{ talent: { name: string; version: number } }> {
      const v = deps.voice?.(input.agent);
      return { talent: v?.talent ?? { name: meetingRecap.name, version: meetingRecap.version } };
    },

    /** Which finished recordings have not been published yet. Cheap and safe to retry. */
    async findNewRecordings(input: { agent: string }): Promise<
      { id: string; title: string; stamp: string; minutes: number; user?: string; notify?: string }[]
    > {
      const v = deps.voice?.(input.agent);
      if (!v) return [];
      const out: { id: string; title: string; stamp: string; minutes: number; user?: string; notify?: string }[] = [];
      // One account for every tenant that has not gone per-person, so this loop runs once and makes
      // the same two calls the flow always made. With per-member accounts it runs per account, and
      // each recording is tagged with the member it belongs to so the poll can attribute and route it.
      for (const acct of accountsOf(v)) {
        const all = await recap.listRecordings(acct.creds, 20);
        const fresh = await recap.unpublished(all, v.brainDir, acct.floorMs ?? v.floorMs, v.journal);
        for (const r of fresh) {
          out.push({
            id: r.id,
            title: r.title,
            stamp: r.stamp,
            minutes: Math.max(1, Math.round(r.duration / 60000)),
            user: acct.user,
            notify: acct.notifyUser,
          });
        }
      }
      return out;
    },

    /** Download, transcribe, summarise, publish, push — then ask the agent to say what it found.
     *
     *  Everything up to the push is idempotent by path: re-running lands on the same folder and
     *  commits nothing. The notification is last, so a failure anywhere before it means the person
     *  is told about a failure rather than promised a recap that does not exist. */
    async processRecording(input: { agent: string; notify: string; id: string; user?: string }): Promise<void> {
      const ctx = Context.current();
      const v = deps.voice?.(input.agent);
      if (!v) throw new Error(`no voice configuration for ${input.agent}`);

      // Which account this recording came from — the member's own when per-person, else the one
      // shared account. `accountFor(v, undefined)` returns the shared account and reads `v.creds`
      // exactly as before, so every tenant that has not gone per-person is unchanged here.
      const acct = accountFor(v, input.user);
      const creds = acct.creds;
      const floorMs = acct.floorMs ?? v.floorMs;
      // Recording ids are only unique WITHIN an account, so a per-member run keeps its cached chunks
      // in a subdir keyed by the member — else two members' recordings sharing an id would fight over
      // one cache. The shared account (no user) keeps the original path unchanged.
      const chunkCacheDir =
        input.user && v.chunkCacheDir ? path.join(v.chunkCacheDir, encodeURIComponent(input.user)) : v.chunkCacheDir;

      const all = await recap.listRecordings(creds, 50);
      const rec = all.find((r) => r.id === input.id);
      if (!rec) throw new Error(`recording ${input.id} is no longer listed`);
      // Checked again here, not only at selection: a workflow run that queued a list of recordings
      // before the floor existed would otherwise keep working through it across a redeploy, which
      // is the difference between "fixed" and "fixed for the next poll".
      if (rec.startTime < floorMs) {
        console.log(`recap: skipping ${rec.title} — before the floor`);
        return;
      }
      // And re-check publication, for the same reason: a queued list is a snapshot, and the same
      // recording was summarised three times because each run of the list re-derived a slightly
      // different summary and so had something to commit. `publish` cannot catch this — a changed
      // summary IS a change.
      if ((await recap.unpublished([rec], v.brainDir, floorMs, v.journal)).length === 0) {
        console.log(`recap: skipping ${rec.title} — already published`);
        return;
      }

      ctx.heartbeat("transcribing");
      // Per chunk, not per recording: a long meeting is many uploads, and a heartbeat only at the
      // start would let Temporal declare a perfectly healthy transcription dead halfway through.
      let note = "transcribing";
      const { text, seconds, by } = await beating(
        () => note,
        () =>
          recap.transcribe(
            creds,
            rec,
            v.transcribe,
            v.vocab,
            (done, total) => {
              note = `transcribing ${done}/${total}`;
              ctx.heartbeat(note);
            },
            chunkCacheDir,
          ),
      );
      console.log(
        `recap: ${rec.title} transcribed in ${seconds.toFixed(1)}s, ${text.length} chars` +
          (by.length ? ` by ${by.join(" + ")}` : " (every chunk came from a previous attempt)"),
      );

      // A RECORDING WITH NO SPEECH IN IT IS NOT A MEETING TO FILE.
      //
      // Summarising nothing does not fail — it produces a confident page explaining that the
      // meeting contained no substantive discussion, filed under `unclassified`, indistinguishable
      // from a real recap of a bad meeting. That is worse than no page at all: it is a knowledge
      // base entry asserting something about an hour of somebody's life, derived from silence.
      //
      // Left UNPUBLISHED on purpose, so it is picked up again if a provider that can hear it is
      // added later — `unpublished()` answers from the checkout, so nothing is written and nothing
      // is forgotten.
      if (!text.trim()) {
        console.log(`recap: ${rec.title} — every provider transcribed silence; not publishing`);
        // Said verbatim rather than through a turn: the sentence is already known, and the person
        // was told two minutes ago that this recording was being processed. Silence here would read
        // as the pipeline having lost it.
        await deps
          .say?.(
            input.agent,
            input.notify,
            `I couldn't get any speech out of “${rec.title}” — every transcriber returned nothing, so I've left it unprocessed rather than file a recap made out of silence.`,
          )
          .catch(() => {});
        return;
      }

      // What was on the calendar around this recording. Gathered BEFORE summarising because the
      // candidates ride that same call — content decides which meeting this was, and it can only
      // decide between things it has been shown.
      let candidates: calendar.CalEvent[] = [];
      if (v.calendars?.length) {
        ctx.heartbeat("reading calendars");
        const w = calendar.windowFor(rec.startTime, rec.startTime + rec.duration, v.calendarPadMinutes);
        candidates = await calendar.gather(v.calendars, w.from, w.to, {
          exclude: v.calendarExclude,
          log: (m) => console.log(m),
        });
        console.log(
          `recap: ${rec.title} — ${candidates.length} calendar candidate(s) from ${v.calendars.length} feed(s)`,
        );
      }

      ctx.heartbeat("summarising");
      const summary = await beating(
        () => "summarising",
        () => recap.summarize(text, rec.title, v.summarize, v.journal, candidates, v.mission, v.vocab),
      );
      // The model may only claim a meeting it was shown. Anything else is no match — a
      // hallucinated meeting name looks entirely correct and files the recap into a series it does
      // not belong to.
      const matched = recap.resolveMeeting(candidates, summary.meeting);
      summary.meeting = matched?.summary ?? "";

      ctx.heartbeat("publishing");
      const route = recap.resolveRoute(v.journal, summary.route);
      // A matched meeting names the file. Plaud names an untitled recording after its own clock,
      // and `2026-09-07-0310-api-team-standup.md` is the difference between a knowledge base
      // somebody can search and one they cannot.
      const where = recap.pathsFor(
        v.journal,
        rec,
        route,
        summary.meeting || summary.highlights?.[0] || summary.summary,
      );
      const published = await recap.publish(v.brainDir, rec, summary, text, v.pushUrl, v.journal, candidates, by, v.timezone, input.user);
      console.log(
        `recap: ${rec.title} ${published ? "published" : "already present"} at ${where.page}` +
          (route ? ` (route ${route}${summary.route && summary.route !== route ? `, model said "${summary.route}"` : ""})` : "") +
          (candidates.length ? ` [calendar: ${summary.meeting ? `matched "${summary.meeting}"` : "no match"}]` : ""),
      );
      // The transcript is in the second brain now, so the saved chunks have nothing left to
      // protect and become one more copy of a customer's meeting sitting on a volume.
      if (chunkCacheDir) await recap.clearChunkCache(chunkCacheDir, rec);
      if (!published) return; // somebody else got there first; do not announce it twice

      // A real turn, so the agent says it in its own words and can be asked follow-ups in the same
      // conversation. The three highlights are handed over rather than re-derived.
      const top = (summary.highlights ?? []).slice(0, 3);
      await deps.ask?.(
        input.agent,
        input.notify,
        `A recording has just finished processing and is filed in the second brain at ` +
          `${where.page}: “${rec.title}”. Write a short message telling them it is ready ` +
          `and giving the three most useful things from it, in your own words, then offer to answer ` +
          `questions about it. The three: ${top.map((h, i) => `(${i + 1}) ${h}`).join(" ")}`,
      );
    },

    /** Run a Talent as a self-contained CLI through the capability plane — the replacement for
     *  `processRecording` once cut over. The Talent does the work and REPORTS an outcome; this
     *  activity announces it (a real agent turn, from the Talent's `steer`) and lets a failure
     *  surface as a throw so Temporal retries and the `talent_run` record closes `failed`. The work
     *  itself is a subprocess, so its progress drives the heartbeat and a cancel kills the child. */
    async runTalent(input: {
      agent: string;
      item: string;
      notify?: string;
      user?: string;
      talent?: string;
    }): Promise<{ status: string; summary?: string; links?: { label: string; url: string }[] }> {
      const plane = deps.talentPlane;
      if (!plane) throw new Error("runTalent: the capability plane is not running");
      const ctx = Context.current();
      // Heartbeat on a TIMER, not only on the Talent's progress notes: transcribing a 112-minute
      // recording and running the inference are each a single long capability call during which the
      // Talent emits nothing, and a heartbeat that fired only on progress would let Temporal declare
      // a healthy run dead mid-transcription. The note rides the beat so the Temporal UI stays useful.
      let lastNote = "starting";
      const beat = setInterval(() => ctx.heartbeat(lastNote), 20_000);
      try {
        const outcome = await plane.spawn(
          { agent: input.agent, item: input.item, user: input.user, talent: input.talent },
          {
            signal: ctx.cancellationSignal,
            onProgress: (note) => {
              lastNote = note;
              ctx.heartbeat(note);
            },
          },
        );
        if (outcome.status === "failed") {
          const reason = outcome.reason ?? "talent failed";
          // A LOGIN problem is said out loud now, in the recap's channel, rather than after the launch
          // budget runs out. Temporal retries a failed run inside the same launch, so a signed-out agent
          // retried all night and never reached the final-launch warning: prod Sapien's recap failed
          // quietly until somebody read a log. Once an hour at most, and the run still retries — after
          // a reconnect it completes on its own.
          if (isAuthError(reason) && input.notify) {
            const text = loginAlertText(input.user);
            const key = `${input.agent} :: ${text}`;
            if (Date.now() - (lastSaid.get(key) ?? 0) >= 60 * 60_000) {
              lastSaid.set(key, Date.now());
              await deps.say?.(input.agent, input.notify, text).catch(() => {});
            }
          }
          // A throw, not a return: the workflow's catch closes talent_run `failed` and Temporal
          // retries, exactly as a thrown processRecording did. The reason is the Talent's own.
          throw new Error(reason);
        }
        // Report, don't speak: announce the Talent's steer as a real turn, so follow-ups land in the
        // same conversation. Skipped outcomes (no speech, already filed) carry no steer, say nothing.
        if (outcome.status === "done" && outcome.steer) {
          await deps.ask?.(input.agent, input.notify ?? "", outcome.steer, outcome.brains);
        }
        // The announcement text travels BACK OUT so the run record can hold it (W4). `steer` is what
        // the person was actually told; `summary` is the Talent's own one-liner and the fallback.
        // Capped here rather than at the registry, because a 2000-char field is a contract and a
        // 40kB transcript arriving at it is a 413 nobody will connect to a recap.
        // Not when the run filed into a brain: the run record is read tenant-wide, and what was filed
        // is for the people who can read that brain (BRAIN-NO-DISCLOSURE). The record says only that.
        if (outcome.brains?.length) {
          return { status: outcome.status, summary: "Filed into a brain. Only people who can read it were told what." };
        }
        return {
          status: outcome.status,
          summary: (outcome.steer ?? outcome.summary ?? "").slice(0, 2000) || undefined,
          links: outcome.links,
        };
      } finally {
        clearInterval(beat);
      }
    },

    /** Open — or re-open — the durable record for one item of one Talent run.
     *
     *  This is the record whose absence produced 611 attempts for 4 published recaps. "Not published
     *  yet" and "failing every two minutes for ten hours" were the same state, because the only
     *  durable fact was whether a file existed in a git checkout — a check that can answer "is it
     *  done" and can never answer "is it being worked on, or failing". */
    async openTalentRun(input: {
      agent: string;
      talent: string;
      itemKey: string;
      version: number;
      trigger?: "schedule" | "command" | "hub";
      requestedBy?: string;
      forUser?: string;
    }): Promise<void> {
      await deps.talentRun?.open(input.agent, input.talent, input.itemKey, input.version, {
        trigger: input.trigger,
        requestedBy: input.requestedBy,
        forUser: input.forUser,
      });
    },

    /** Close it, either way. The FAILED case is the one that matters: it is what makes "this
     *  recording has been failing all day" something a person can see without reading a log. */
    async closeTalentRun(input: {
      agent: string;
      talent: string;
      itemKey: string;
      status: "done" | "failed";
      error?: string;
      result?: { summary: string; links?: { label: string; url: string }[] };
    }): Promise<void> {
      await deps.talentRun?.close(
        input.agent,
        input.talent,
        input.itemKey,
        input.status,
        input.error,
        input.result,
      );
    },

    /** The recording-level idempotency guard, read before a run spends anything. Returns the durable
     *  status of this (agent, talent, item), or `undefined` when there is no record OR the read
     *  failed — the workflow treats both the same (go ahead), so a registry blip can only ever let a
     *  done item be re-run, never block a new one. */
    async talentRunStatus(input: {
      agent: string;
      talent: string;
      itemKey: string;
    }): Promise<{ status: "running" | "done" | "failed"; attempts: number } | undefined> {
      return (await deps.talentRun?.status?.(input.agent, input.talent, input.itemKey)) ?? undefined;
    },

    /** Say something verbatim to a person, opening a DM if needed. Used for the acknowledgement and
     *  for failures, where spending an LLM turn to relay a known sentence is waste. */
    async sayVerbatim(input: {
      agent: string;
      user: string;
      text: string;
      /** Say this at most once in that many minutes. For a notice raised by something that RETRIES:
       *  a poll on a two-minute schedule reporting a dead credential says it thirty times an hour,
       *  which is thirty notifications for one fact the person can only act on once. */
      onceMinutes?: number;
    }): Promise<void> {
      if (input.onceMinutes) {
        // Keyed on the TEXT, not on "this is the poll warning": a DIFFERENT reason must still be
        // heard. The goal is not to go quiet, it is not to repeat an identical sentence.
        const key = `${input.agent} :: ${input.text}`;
        const at = lastSaid.get(key) ?? 0;
        if (Date.now() - at < input.onceMinutes * 60_000) return;
        lastSaid.set(key, Date.now());
      }
      await deps.say?.(input.agent, input.user, input.text);
    },
  };
}

/** PURE: what a recap channel is told when a recording cannot be summarised for want of a Claude
 *  login. Names WHOSE login — a per-person run's owner, or the agent's own — and the one fix. */
export function loginAlertText(user?: string): string {
  return user
    ? `⚠️ <@${user}> I can't summarise your new recording — your Claude login isn't working (signed out or expired). Run \`!connect claude\` and I'll pick the recording up again on my own.`
    : "⚠️ I can't summarise a new recording — my Claude login isn't working (signed out or expired). Someone who manages me needs to run `!connect claude`; I'll pick the recording up again on my own.";
}

/** When each distinct notice was last said. In memory deliberately: the worst a restart costs is
 *  one repeated warning, and the alternative is persisting a fact that stops being true the moment
 *  somebody reconnects. */
const lastSaid = new Map<string, number>();

export type Activities = ReturnType<typeof makeActivities>;


/** One turn, start to finish. Split out of the activity so the serializer above owns exactly
 *  one thing — when a turn may run — and this owns what a turn IS. */
async function oneTurn(deps: TurnDeps, input: TurnInput): Promise<void> {
    const ctx = Context.current();
    const found = deps.agent(input.agent);
    if (!found) throw new Error(`worker: no agent "${input.agent}" in the roster`);
    const { conn, run } = found;

    const reply: Reply = conn.reply(input.conversation);
    // AN ANNOUNCEMENT OF WHAT A TALENT FILED goes only to a person who may read where it was filed
    // (BRAIN-PRIVATE-CONFIRMATIONS). A run can file through the agent's own grant, so the person it is
    // for is checked here, before the harness runs or anything is shown. Nobody to check — no person
    // on the announcement — is not a pass: nothing is said.
    if (input.drewOn?.length) {
      const theirs = deps.brains && input.user ? await deps.brains.reach(input.agent, input.user).catch(() => null) : null;
      if (!theirs || input.drewOn.some((b) => !theirs.has(b))) {
        console.error(`worker: ${input.agent} did not announce a filing — ${input.user ? "that person cannot read the brain it went into" : "it names nobody to tell"}`);
        return;
      }
    }
    // One verb for the whole turn, picked before the first cue. Re-picking mid-turn would read
    // as a different agent taking over the answer.
    const verb = randomMysticVerb();
    // The status line IS the immediate cue — "Nelly is thinking…" under the composer. A
    // placeholder MESSAGE posted alongside it is worse than nothing: it flashes "…" and is then
    // overwritten, which reads as a glitch. So no message is posted until there is something real
    // to put in it, and the work log below is a separate note rather than the answer's message.
    await reply.working?.(worklog.statusFor(undefined, verb)).catch(() => {});

    // WHO WILL SEE THIS, decided before anything of the answer is shown (BRAIN-AUDIENCE). Outside the
    // speaker's own DM, a person who reaches any brain has the answer HELD — no streaming, no tool
    // details in the work log — until the end of the turn decides where it goes (BRAIN-PRIVATE-DELIVERY).
    const brains = deps.brains;
    // The provider this turn runs on, fixed now: a switch in the Hub while it runs changes the NEXT
    // turn, and this one finishes — and is recorded — on the provider it started with.
    const provider = found.cfg.inference_provider === "codex" ? "codex" : "claude";
    turnProvider.set(turnProviderKey(input.agent, input.conversation, input.user), provider);
    if (turnProvider.size > 1000) turnProvider.delete(turnProvider.keys().next().value as string);
    const key = sessionKeyOf(input.conversation, input.user, provider);
    let audience: Audience = { kind: "self" };
    let held = false;
    let prior: string[] = [];
    let brainTurn: { token: string; mcp: McpServerSpec } | undefined;
    let staleHistory = false;
    if (brains && input.user) {
      prior = await brains.provenance(input.agent, key).catch(() => ["unknown"]);
      audience = await brains.audience(input.agent, input.conversation, input.user).catch((e: Error) => ({ kind: "unknown", why: e.message }) as Audience);
      // A history that drew on a brain this person no longer reaches is not continued: what it holds
      // is no longer theirs to hear (BRAIN-GRANT-TIMING). The turn starts a fresh session instead.
      if (prior.length) {
        const now = await brains.reach(input.agent, input.user).catch(() => null);
        if (!now || prior.some((b) => !now.has(b))) {
          staleHistory = true;
          prior = [];
        }
      }
      // An announcement of what a Talent filed draws on the brain it filed into.
      if (input.drewOn?.length) {
        await brains.remember(input.agent, key, input.drewOn).catch(() => {});
        prior = [...new Set([...prior, ...input.drewOn])];
      }
      brainTurn = brains.start(input.agent, input.user, input.user, key);
      // Outside the speaker's own DM, a turn that can reach brains — or remembers one — is held. An
      // announcement is held even in their DM: it is posted only after the reach is checked again.
      held = (audience.kind !== "self" && (!!brainTurn || prior.length > 0)) || !!input.drewOn?.length;
    }

    const started = Date.now();
    let answer = "";
    let usage: TurnUsage | undefined;
    let lastEdit = 0;
    let done = false;
    /** Created on first render, not up front. Empty until then. */
    let msgId = "";
    const show = async (text: string): Promise<void> => {
      if (!msgId) msgId = await reply.send(text);
      else await reply.update(msgId, text);
    };

    // --- the work log ---------------------------------------------------------------------
    // Teams parity, and the thing that was missing: which tools ran, and how long the agent has
    // been at it. It lives in its own note above the answer and is driven by a TIMER rather than
    // by events — a turn that greps the second brain for ten seconds emits one event, and a line
    // that does not move is indistinguishable from being stuck.
    const calls: worklog.ToolCall[] = [];
    let current: worklog.ToolCall | undefined;
    let noteId = "";
    let noteText = "";
    /** One note write at a time. Without this the FIRST write is still in flight (a post is
     *  ~300ms) while a second tool event fires a second tick: `noteId` is still empty, so that
     *  tick posts a SECOND note, and whichever resolves last wins the id — leaving the other
     *  stranded in the channel forever as "⚙️ Working… 1s". Two tool events inside one post
     *  latency is not a corner case; it is what any turn that greps the second brain looks like. */
    let posting = false;
    let lastTick = 0;
    const tick = async (): Promise<void> => {
      if (done || ctx.cancellationSignal.aborted) return;
      // A held turn shows that it is working, and nothing of what it is working on.
      if (held && noteId) return;
      if (posting) return;
      // Once the answer is streaming, do not CREATE a note: it would post below the reply and
      // read as a footnote. But an EXISTING one keeps ticking — freezing it is what made the
      // clock sit at "2s" for a whole answer and then land on "Moonwalked for 14 seconds", which
      // reads as a jump rather than as time passing.
      if (answer && !noteId) return;
      // Tool events call this directly, so the timer is not the only rate limiter. Each tick is
      // a message edit AND a status set; ten tool calls in two seconds would be twenty Slack
      // calls, which is the burst TICK_MS exists to avoid. While the answer is streaming it is
      // ALSO editing its own message roughly every second, so the log backs off to share the
      // channel's budget rather than race it.
      const now = Date.now();
      if (now - lastTick < (answer ? ANSWERING_TICK_MS : EDIT_INTERVAL_MS)) return;
      lastTick = now;
      posting = true;
      try {
        const elapsed = now - started;
        const text = worklog.liveNote(calls, elapsed, verb);
        if (text !== noteText) {
          noteText = text;
          noteId = (await reply.note?.(noteId || undefined, text)) ?? "";
        }
        // Checked AGAIN, after the note write. The guard at the top of this function was true
        // when the tick started, and a note post takes ~300ms — long enough for the turn to end
        // and settle the cue in between. Setting the status after that leaves "Sapien is
        // working…" under the composer of a thread that has already answered, and nothing ever
        // clears it: `working` and `settle` are the same Slack call, so the last writer wins.
        if (done || ctx.cancellationSignal.aborted) return;
        await reply.working?.(worklog.statusFor(current, verb)).catch(() => {});
      } catch {
        /* a dropped work log must never cost a turn */
      } finally {
        posting = false;
      }
    };
    /** The tick currently in flight, so the end of the turn can wait for it rather than race it.
     *  The re-check above closes the window on its own; this closes it without depending on when
     *  the scheduler resumes a suspended tick. */
    let inflight: Promise<void> = Promise.resolve();
    const runTick = (): Promise<void> => (inflight = tick());
    const ticker = setInterval(() => void runTick(), TICK_MS);
    /** Take down the live cue for good: stop the timer, let any tick already running finish, and
     *  only then clear the status. Every path out of a turn goes through here — answered, failed
     *  or interrupted — because a status line that outlives its turn is the one artefact a person
     *  cannot dismiss themselves. */
    const settleCue = async (): Promise<void> => {
      clearInterval(ticker);
      await inflight.catch(() => {});
      await reply.settle?.().catch(() => {});
    };
    /** Remove the log entirely — for an interrupted turn, whose work nobody will see the result
     *  of, so a trace of it left on screen is only confusing. */
    const dropLog = (): void => {
      clearInterval(ticker);
      if (noteId) void reply.note?.(noteId, null).catch(() => {});
    };

    // Temporal cancels the scope when a new message arrives. Leave the partial visible and say
    // what happened — a reply that silently stops looks like a broken bot.
    ctx.cancelled.catch(() => {
      if (done) return;
      dropLog();
      void reply.settle?.().catch(() => {});
      // Only if something was already on screen. An interrupted turn that had not yet said
      // anything should leave no trace — the correction is about to be answered instead.
      if (!msgId) return;
      void reply
        .finalize(msgId, `${answer.trim()}\n\n_— interrupted; working on your new message_`)
        .catch(() => {});
    });

    // What the agent can read, and who is asking. Without the first the second brain is present
    // on disk but the model has no reason to look at it; without the second "Hi Celine" is a
    // guess rather than a fact from the registry.
    // Who is asking, from the registry — never guessed from a display name, which is spoofable.
    const known = (found.cfg.principals ?? []).find(
      (p) => p.kind === "slack_user_id" && p.value === input.user,
    );
    // No sender at all means a system notification, not an unknown person. Treating it as a stranger
    // made the agent refuse to discuss the meeting it had just been handed.
    const speaker = speakerContext({ user: input.user, label: known?.label, fromSystem: input.fromSystem });
    if (brainTurn && brains && known?.label) {
      // Re-open with the person's name for log.md; the first token is closed unused.
      brains.end(brainTurn.token);
      brainTurn = brains.start(input.agent, input.user, known.label, key);
    }
    const parts = [
      found.context ?? "",
      brainTurn ? BRAIN_GUIDANCE : "",
      input.afterInterruption
        ? "(your previous answer was interrupted by a new message; continue from what the user now says)"
        : "",
      staleHistory
        ? "(this conversation was restarted because the person's access to a brain changed; you do not remember earlier messages — say so if they refer to them)"
        : "",
      // The runtime is not evidence about the person.
      //
      // Asked who it was speaking to, the agent inspected its own environment, found the
      // operator's account email, and told a customer it looked like a mismatch. It was being
      // honest — and it was reporting infrastructure as if it were a fact about them. The
      // platform is the only authority on identity; everything else in this container belongs to
      // whoever runs the service.
      "You are running on shared platform infrastructure. Its account, credentials, environment " +
        "and file paths say nothing about who you are talking to, and are not yours to inspect " +
        "or mention. Identity comes only from the platform's labels and your system prompt. If " +
        "that is missing, ask the person — never infer it from the machine.",
    ].filter(Boolean);
    const preamble = parts.length ? `${parts.join("\n\n")}\n\n` : "";

    // This turn's system prompt: the agent's identity file with who is speaking appended. A file per
    // turn because the harness takes the system prompt as a file, and the speaker changes per turn.
    const identity = found.cfg.system_prompt_file
      ? await fs.readFile(found.cfg.system_prompt_file, "utf8").catch(() => "")
      : "";
    const turnSystemFile = path.join(
      os.tmpdir(),
      `tonoman-turn-${input.agent.replace(/[^A-Za-z0-9_-]/g, "")}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
    );
    await fs.writeFile(turnSystemFile, `${identity ? `${identity}\n\n` : ""}${speaker.system}\n`);

    // The session this thread continues in. Claimed, not peeked at: `--session-id` creates and
    // may be used once, every later turn resumes, and the one thing that can go wrong with that —
    // no session on disk to resume — is repaired below rather than left to fail forever.
    let session = staleHistory ? await deps.resetSession?.(input.agent, key) : await deps.claimSession?.(input.agent, key);

    // Files the person attached, named for the model to open with its Read tool (images and PDFs it
    // reads; a text file it reads; an audio file it can see and name but not transcribe here). Mirrors
    // the gateway's media convention so there is one shape, not two. Empty for an ordinary message.
    // THE TURN'S OWN FOLDER: its working directory, holding its attachments and nothing else.
    const turnDir = await fs.mkdtemp(path.join(os.tmpdir(), "tonoman-turn-"));
    // A file that cannot be placed here is NOT handed over by its original path: that is on the
    // worker's state volume, which a turn may not read (CONVO-FILES-IN-THE-TURN). The agent is told
    // instead, so it can ask for the file again rather than fail to open it.
    const media: string[] = [];
    let unplaced = 0;
    for (const m of input.mediaPaths ?? []) {
      const dest = path.join(turnDir, path.basename(m));
      await fs.copyFile(m, dest).then(() => media.push(dest), () => void unplaced++);
    }
    const mediaNote =
      (media.length ? `\n\nAttached file(s) — read them:\n${media.map((p) => `- ${p}`).join("\n")}` : "") +
      (unplaced ? `\n\n${unplaced} attached file(s) could not be opened; ask the person to send them again.` : "");

    const consume = async (): Promise<void> => {
      for await (const ev of run(
        {
          prompt: `${preamble}${speaker.prefix}${input.text}${mediaNote}`,
          systemPromptFile: turnSystemFile,
          model: deps.modelFor?.(input.agent, input.conversation),
          mediaPaths: media.length ? media : undefined,
          sessionId: session?.id,
          sessionNew: session?.isNew,
          // WHO is speaking — the run closure turns this into the speaker's own credential when the
          // agent runs inference per person, and ignores it otherwise.
          user: input.user,
          mcpServers: brainTurn ? [brainTurn.mcp] : undefined,
          cwd: turnDir,
        },
        // Passing the signal is what makes a steer actually stop the model. Without it the child
        // ran to completion after the person had already moved on — paid for, unread, and still
        // holding the session file the next turn wants to resume.
        ctx.cancellationSignal,
      )) {
        if (ctx.cancellationSignal.aborted) return;
        if (ev.kind === "text" && ev.text) {
          answer += ev.text;
          const now = Date.now();
          if (!held && now - lastEdit >= EDIT_INTERVAL_MS && answer.trim()) {
            lastEdit = now;
            await show(answer).catch(() => {});
          }
        } else if (ev.kind === "tool") {
          // Recorded for the work log, and mirrored into the status line straight away so the
          // cue changes the moment a tool starts rather than on the next tick.
          current = { tool: ev.tool ?? "working", detail: held ? undefined : ev.text };
          calls.push(current);
          if (!answer) await runTick();
        } else if (ev.kind === "done") {
          // The authoritative text. A harness that streams deltas AND sends a final would
          // otherwise leave whatever the last edit happened to catch; one that only sends a final
          // would otherwise post nothing at all.
          if (ev.final) answer = ev.final;
          // The turn's own tokens — what the status footer and `!status` report.
          if (ev.usage) usage = ev.usage;
        } else if (ev.kind === "error" && ev.err) {
          throw ev.err;
        }
        // Heartbeat on real progress, so a wedged model is detected quickly but a slow one is not
        // killed for being slow.
        ctx.heartbeat(answer.length);
      }
    };

    try {
      try {
        // KEPT ALIVE ON A TIMER while the model thinks.
        //
        // The stream heartbeats on every event, which reads like enough and is not: between events
        // there IS no event, and a model that has just been handed a 79,000-character transcript
        // reasons for well over the heartbeat timeout before emitting its next token. Temporal then
        // declares a perfectly healthy turn dead, and the person is told their question failed.
        //
        // That happened on a real question about a 112-minute meeting: two tool calls, a large Read,
        // and the activity timed out sixty seconds in — with 38 of its 40 turns unused, so it looked
        // like a model problem rather than a liveness one.
        //
        // Same fix as `transcribe` and `summarize`, and the same lesson: the heartbeat's job is to
        // detect a dead WORKER, not to police how long thinking takes. The stream events still
        // report real progress on top of this.
        await beating(() => `thinking (${answer.length} chars so far)`, consume);
      } catch (e) {
        // A session that cannot be resumed is a lost memory, not a failed turn.
        //
        // The pod holds both halves of this — the id in memory, the transcript on its disk — so
        // they are normally lost together. Normally: a turn killed mid-write, or a `claude` that
        // never got far enough to create the file, leaves an id pointing at nothing, and every
        // future turn in that thread would then fail on the same missing file. Amnesia is a bad
        // day; a thread that answers nothing ever again is a broken agent.
        //
        // Only when the turn produced NOTHING, which is what a resume miss looks like — it fails
        // at startup, before a token. A turn that broke halfway through said something first, and
        // re-running it would say it twice.
        const produced = answer.trim().length > 0 || calls.length > 0;
        if (!session || produced || ctx.cancellationSignal.aborted) throw e;
        console.error(
          `worker: ${input.agent} could not resume session ${session.id} ` +
            `(${String((e as Error)?.message ?? e).slice(0, 140)}); starting a fresh one`,
        );
        session = await deps.resetSession?.(input.agent, key);
        await reply.reset?.().catch(() => {});
        await consume();
      }
    } catch (e) {
      // A failed turn still owes the person a finished-looking channel. Without this the ⚠️ the
      // workflow posts lands UNDER a stale "⚙️ Working…" note, and "Nelly is thinking…" stays
      // under the composer for good — the turn reads as still running, forever.
      dropLog();
      await settleCue();
      if (brainTurn && brains) brains.end(brainTurn.token);
      // The workflow posts part of an error's text where the question was asked. A held turn's error
      // could carry what the agent had read, so only a login problem keeps its words.
      if (held && !isAuthError(String((e as Error)?.message ?? e))) throw new Error("The answer could not be finished. Ask again, or ask me in a direct message.");
      throw e;
    } finally {
      clearInterval(ticker);
      await fs.rm(turnSystemFile, { force: true }).catch(() => {});
      await fs.rm(turnDir, { recursive: true, force: true }).catch(() => {});
    }

    done = true;
    // What this turn drew on, remembered for the rest of this person's history of the thread: the
    // agent can repeat it later without looking again (BRAIN-USED-DECIDES).
    const used = brainTurn && brains ? brains.end(brainTurn.token) : [];
    const drawnOn = [...new Set([...prior, ...used])];
    if (usage) deps.recordUsage?.(input.agent, input.conversation, usage);
    // Slack leaves "is thinking…" on screen until it is cleared, so an answered turn that
    // forgets this looks permanently busy.
    await settleCue();
    if (ctx.cancellationSignal.aborted) {
      dropLog();
      return;
    }

    // Settle the work log into one line of what the turn actually did, or take it down when
    // there is nothing worth keeping above the answer.
    if (noteId) {
      const settled = worklog.settledNote(held ? [] : calls, Date.now() - started, verb);
      await reply.note?.(noteId, settled).catch(() => {});
    }

    const footer = await deps.footer?.(input.agent, input.conversation, usage).catch(() => null);
    const body = answer.trim() || "_(no answer)_";
    // ONE blank line. This was three newlines - two blank lines - on the reasoning that the footer
    // is metadata rather than the last paragraph of the answer, and so wanted visible separation.
    // In Slack it reads as detached instead: a stray line floating below the message, far enough
    // away that it stops looking related to it. One blank line is the separation that was wanted.
    let final = footer ? `${body}\n\n${footer}` : body;

    // WHERE IT GOES, decided now — not at the start: people join channels and lose access mid-turn.
    if (brains && input.user && drawnOn.length) {
      const now = await brains.reach(input.agent, input.user).catch(() => null);
      // Everything the answer could draw on must still be the speaker's (BRAIN-GRANT-TIMING).
      if (!now || drawnOn.some((b) => !now.has(b))) {
        final = "I can't share that answer: your access to a brain it drew on changed while I was working. Ask me again.";
      }
    }
    if (brains && input.user && drawnOn.length && audience.kind !== "self") {
      audience = await brains.audience(input.agent, input.conversation, input.user).catch((e: Error) => ({ kind: "unknown", why: e.message }) as Audience);
      const now = await brains.reach(input.agent, input.user).catch(() => null);
      const readable = audience.kind === "members" ? await brains.readableByAll(input.agent, drawnOn, audience.members).catch(() => null) : null;
      if (decideRoute(audience, drawnOn, readable).to === "private") {
        const names = drawnOn.map((b) => now?.get(b)).filter((n): n is string => !!n);
        const sent = await brains.dm(input.agent, input.user, `${privateReason(names, audience)}\n\n${final}`).catch(() => false);
        const note = sent ? THREAD_NOTE : THREAD_NOTE_FAILED;
        if (!msgId) msgId = await reply.send(note);
        else await reply.finalize(msgId, note);
        return;
      }
    }
    if (!msgId) msgId = await reply.send(final);
    else await reply.finalize(msgId, final);
}

/** What a turn with the brain tool is told about it. The rules it restates are the brain object's. */
const BRAIN_GUIDANCE = [
  "You have a brain tool: brain_list, brain_search, brain_read, brain_write. Brains hold this person's",
  "knowledge — their own brain, and any shared with them. Nothing else of theirs is on this machine.",
  "- Start with brain_list: it shows each brain, its index.md, and the map Tonoman keeps (.tonoman/index.md: topics, each",
  "  linking to a hub page under .tonoman/hubs/ that gathers the pages about it). Follow those, then search.",
  "- Answer questions about their work, people and decisions from the brains, and name the brain and page each fact came from.",
  "- To remember something: if you do not know what it is or where it belongs, ask — or research it when asked — and never file a guess.",
  "  Pick the best-fitting brain they can write to, and an existing page before a new one (brain_read it first and pass its revision).",
  "  Add the page to the index or its topic's hub. Say which brain and page you used, and only once brain_write says it is saved.",
  "- If a brain is read only, say so, and offer one they can write to or the text itself.",
  "- If the tool says something was cut or could not be reached, say what you could not look at.",
].join("\n");
