// Harness- and channel-neutral contracts of the Tonoman messaging gateway (A1).
// Concrete connectors (Telegram), turn-runners (Claude Code), and memory stores
// depend only on the types here. The router and stream consumer are written
// against these and contain zero channel- or harness-specific code: a leak of a
// Telegram- or Claude-specific detail into this module is a contract defect.

import type { ResolvedIdentity } from "../identity";

/** The neutral inbound message a connector produces from its own transport (A1). */
export interface Envelope {
  /** connector id stamped by the connector, e.g. "telegram" */
  channel: string;
  /** stable conversation id within the channel */
  conversation: string;
  /** sender id/display, opaque to the router */
  user: string;
  /** email-verified sender identity (identity-roster), when the connector could resolve one.
   * Absent for channels/senders without email resolution — the router falls back to `user`. */
  identity?: ResolvedIdentity;
  /** message text; may be empty for a media-only message */
  text: string;
  /** shared-mount paths the sandbox can Read (A1) */
  mediaPaths: string[];
}

/** Classifies a normalized turn event (A2). The Claude Code stream-json output is
 * parsed down to these four kinds; downstream code never sees the raw stream. */
export type EventKind = "text" | "tool" | "done" | "error";

/** Token/cost usage for one turn, normalized from the harness result (gw-command-statusline). */
export interface TurnUsage {
  inputTokens: number; // fresh (uncached) input — SUMMED across the turn's internal calls
  cacheWriteTokens: number; // cache-creation input (summed)
  cacheReadTokens: number; // cache-read input (summed — re-read every internal iteration)
  outputTokens: number; // summed
  costUsd?: number;
  /** Peak SINGLE-call context occupancy (tokens), for context % — NOT the summed totals
   * above, which over-count because the cached context is re-read each iteration. */
  contextTokens?: number;
  /** the primary model the turn actually ran (from the harness's per-model usage), e.g.
   * "opus-4-8[1m]" — for display + the right context window. */
  model?: string;
  /** that model's real context window in tokens (e.g. 1_000_000 for an opus 1M variant),
   * so context % isn't a hardcoded 200k guess. */
  contextWindow?: number;
}

/** One normalized event emitted by a harness turn (A2). */
export interface TurnEvent {
  kind: EventKind;
  /** "text": the delta. "tool": a short detail, e.g. "git commit…". */
  text?: string;
  /** "tool": the tool name, e.g. "Bash". Rendered as "🔧 {tool}: {text}". */
  tool?: string;
  /** "done": the complete assistant reply (for memory + final render). */
  final?: string;
  /** "done": token/cost usage for the turn, when the harness reports it (gw-command-statusline). */
  usage?: TurnUsage;
  /** "done": the turn ended by hitting its agentic-loop cap (claude-code --max-turns) rather than
   * finishing — a graceful pause, not a failure. Lets the consumer append a "paused" note. */
  capped?: boolean;
  /** "error": the failure. */
  err?: Error;
}

/** The assembled input for a single turn (A1 step c / A2 / A3). By default a fresh run
 * with the whole window in `prompt`; when the store tracks a harness session, only the NEW
 * message is in `prompt` and the harness resumes its own session (`sessionId`) for cache reuse. */
export interface TurnRequest {
  /** conversation window + the new message (A3) — or JUST the new message when sessionId is set */
  prompt: string;
  /** --append-system-prompt-file path (injected every turn, A3) */
  systemPromptFile?: string;
  /** image(s) on the shared mount for the brain to Read (A1/A2) */
  mediaPaths?: string[];
  /** optional: the harness session to run in (claude-code --session-id/--resume). When set, the
   * harness holds the conversation history itself and only the new message rides in `prompt`. */
  sessionId?: string;
  /** true = this session doesn't exist yet → CREATE it (--session-id); false = RESUME it. */
  sessionNew?: boolean;
}

/** Drives one harness turn and yields normalized events (A2). The iterable
 * completes after a terminal "done" or "error". Implementations honor `signal`. */
export interface TurnRunner {
  run(req: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnEvent>;
  /** optional: the harness's current model knob, evaluated per turn (gw-command-model).
   * A harness with no model concept omits these; `/model` reports "no model switch". A
   * change takes effect on the NEXT turn (an in-flight turn keeps the model it began with). */
  getModel?(): string | undefined;
  setModel?(model: string | undefined): void;
  /** optional: the harness's auth backend knob (backend-switch-live), evaluated per turn like
   * the model. A harness with no backend concept omits these; a change takes effect NEXT turn. */
  getBackend?(): "subscription" | "bedrock" | undefined;
  setBackend?(backend: "subscription" | "bedrock" | undefined): void;
}

/** One line of the substrate-owned transcript (A3). JSON keys match the Go store
 * (role/text/ts/tools) so transcripts written by either implementation interop. */
export interface Message {
  role: "user" | "assistant" | string;
  text: string;
  /** RFC3339 timestamp; serialized as "ts". */
  ts: string;
  /** compact summary of tools the turn used. */
  tools?: string;
}

/** The git-backed JSONL transcript, one per conversation, in the agent's mounted
 * git workspace alongside its work product (A3). */
export interface MemoryStore {
  /** recent transcript for a conversation; n<=0 returns all. */
  readWindow(conversation: string, n: number): Promise<Message[]>;
  /** append messages to the conversation's JSONL transcript. */
  append(conversation: string, ...msgs: Message[]): Promise<void>;
  /** commit the workspace (and push if a remote is configured). */
  commit(message: string): Promise<void>;
  /** start a fresh session for a conversation (the `/new` command): subsequent turns
   * read an empty window. The prior transcript is preserved on disk. Returns the new
   * session id. */
  newSession(conversation: string): Promise<string>;
  /** optional: the HARNESS session id (a UUID) mapped to the conversation's CURRENT substrate
   * session, so a harness that resumes its own session (claude-code --resume) reuses cache
   * across turns instead of re-sending the window. `isNew` = the harness session hasn't been
   * created yet (→ --session-id); it flips false after markHarnessSession. `/new` rotates the
   * substrate session, which yields a fresh harness UUID automatically. */
  harnessSession?(conversation: string): Promise<{ id: string; isNew: boolean }>;
  /** optional: mark the conversation's harness session as created (so the next turn resumes it). */
  markHarnessSession?(conversation: string): Promise<void>;
}

/** The one thing a new channel implements (A1): it owns its inbound transport and
 * its outbound delivery. */
export interface Connector {
  /** the channel id stamped onto envelopes, e.g. "telegram". */
  name(): string;
  /** start the transport and yield envelopes until `signal` aborts. */
  receive(signal: AbortSignal): AsyncIterable<Envelope>;
  /** open an outbound handle for streaming a response into a conversation. */
  reply(conversation: string): Reply;
  /** optional: register the channel's command menu (e.g. Telegram setMyCommands) so
   * platform commands like /new are discoverable. Best-effort; channels without a
   * menu concept omit it. */
  registerCommands?(commands: { command: string; description: string }[]): Promise<void>;
}

/** The abstract send / update / finalize contract the stream consumer speaks (A4).
 * A connector that cannot edit reports canEdit()=false and the consumer degrades
 * to chunked send — one code path, different fidelity. */
export interface Reply {
  /** post a new message and return its id, for later edits. */
  send(text: string): Promise<string>;
  /** edit an existing message in place (progressive streaming). */
  update(msgID: string, text: string): Promise<void>;
  /** write the terminal content (cursor stripped) into msgID. */
  finalize(msgID: string, text: string): Promise<void>;
  /** whether progressive in-place edits are supported. */
  canEdit(): boolean;
  /** signal that the agent is busy (e.g. Telegram "typing…"); may no-op. An optional `status` is
   * the current activity (e.g. "🔧 Bash: rn wiki sync", gw-tool-narration): a channel whose
   * streaming forbids interleaving progress into the answer text (Teams' growing-prefix streaminfo)
   * renders it in its separate status cue; channels that show progress inline may ignore it. */
  working(status?: string): Promise<void>;
  /** optional: close any in-flight stream and reset streaming state so the NEXT send() starts a
   * FRESH stream (teams-stream-reset). The gateway calls this when it re-runs a turn on the same
   * reply (the resume-miss self-heal): a channel like Teams whose stream is a growing prefix would
   * otherwise 403 when a second stream continues the first. Channels that send each chunk as a new
   * message have nothing to reset and omit it. */
  reset?(): Promise<void>;
  /** optional: settle any in-progress "working" cue to its finished form (e.g. Teams' status trace
   * "🤖 Marinating…" → "Marinated for 12s") so it NEVER dangles as in-progress — the turn must always
   * read as finished, on every path (answer, error notice, auth, abort). Idempotent + best-effort:
   * a no-op if nothing was shown or it already settled. Channels without a persistent cue omit it. */
  settle?(): Promise<void>;
  /** optional: post a message with a tappable choice list (e.g. Telegram inline buttons).
   * Each choice's `data` is delivered back as a normal inbound message text when tapped, so
   * picks flow through the same command dispatch (gw-command-statusline). Channels without
   * inline buttons omit this; callers fall back to a typed command. */
  sendChoices?(text: string, choices: { label: string; data: string }[]): Promise<string>;
  /** optional: post / edit / remove a STANDALONE status notice (e.g. the queue footer) that is
   * NOT part of the streamed reply. Stateless and addressed by id, so the gateway can drive it
   * across reply instances: `note(undefined, text)` posts and returns a new id; `note(id, text)`
   * edits that message in place; `note(id, null)` removes it. Distinct from send()/update() so a
   * channel whose streaming send opens a special stream (e.g. Teams streaminfo) can keep notices
   * as plain, independently-editable messages. Channels without it: callers fall back to send(). */
  note?(id: string | undefined, text: string | null): Promise<string>;
}

/** Builds a display-only footer appended to the BOTTOM of the finalized reply
 * (gw-command-statusline). Receives the turn's usage; returns the footer text, or null
 * for none. The footer is shown but NOT included in the text returned for the transcript. */
export type ReplyFooter = (usage?: TurnUsage) => string | null;

/** Drives a connector's Reply from a turn's event stream (A4). Injected so the
 * router stays agnostic to streaming fidelity. */
export interface Streamer {
  /** push events to reply; return the final assistant text (for the transcript). An
   * optional `footer` is appended to the displayed final only (not the returned text). */
  consume(reply: Reply, events: AsyncIterable<TurnEvent>, signal?: AbortSignal, footer?: ReplyFooter): Promise<string>;
}
