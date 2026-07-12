// The per-turn loop that lives in the substrate (A1). Written entirely against the
// core contracts: no Telegram-specific and no Claude-specific code, so the same
// loop serves every channel and every harness.
//
// One turn: (a) resolve channel+conversation → agent+session; (b) read the memory
// window; (c) assemble the prompt = identity + window + new message (+ media);
// (d) run the turn; (e) stream the reply back; (f) append both messages to memory
// and commit. The harness is a stateless turn-executor; the loop and memory are ours.

import type { Connector, Envelope, MemoryStore, Message, Reply, ReplyFooter, Streamer, TurnRunner } from "./core/contracts";
import { isAuthError, authNotice, isStaleSessionError, resumeResetNotice, turnErrorNotice } from "./authflow";

// Telegram's typing state expires in ~5s, so ping a little faster (A4).
const TYPING_INTERVAL_MS = 4000;

/** The resolved unit a conversation routes to. v0.1 runs a single agent per
 * connector, so session == conversation. */
export interface Agent {
  name: string;
  role?: string;
  systemPromptFile?: string;
  runner: TurnRunner;
  memory: MemoryStore;
  windowSize: number; // last N transcript messages to inject; <=0 = all
  /** when true (and the harness + store support it), resume the harness's own session across turns
   * (feed only the new message; the harness holds history) instead of re-sending the window every
   * turn — cheaper via prompt caching. `/new` rotates the session. Default off (substrate window). */
  sessionPersist?: boolean;
}

export interface RouterOptions {
  agent: Agent;
  streamer: Streamer;
  now?: () => Date; // injectable for deterministic tests
  /** display-only status footer appended to the finalized reply (gw-command-statusline);
   * returns null when off. Never affects the committed transcript. */
  statusFooter?: ReplyFooter;
}

export class Router {
  constructor(private readonly o: RouterOptions) {}

  /** Runs exactly one turn for an inbound envelope. `turnSignal` is the engine's
   * per-turn abort handle (TurnQueue): aborting it stops the runner + stream, and its
   * `reason` decides whether this turn's (partial) output is committed or discarded. */
  async handle(conn: Connector, env: Envelope, turnSignal?: AbortSignal): Promise<void> {
    const a = this.o.agent;
    const conv = env.conversation; // (a) single-agent resolution: session == conversation

    // (b) assemble context. Session-resume mode (opt-in): the harness holds the history in its own
    // session, so we feed ONLY the new message (identity just once, at session creation) and let it
    // --resume — cache reuse, no re-sent window. Otherwise the substrate feeds the window (A3).
    const sessionMode = Boolean(a.sessionPersist && a.memory.harnessSession);
    let sessionId: string | undefined;
    let sessionNew = false;
    let window: Message[] = [];
    let includeIdentity = true;
    if (sessionMode) {
      const s = await a.memory.harnessSession!(conv);
      sessionId = s.id;
      sessionNew = s.isNew;
      includeIdentity = s.isNew; // the identity is already in the session after the first turn
      // On the FIRST turn of a fresh session, inject the substrate window ONCE. Normally it's empty
      // (a brand-new conversation, or `/new`), so this is a no-op — but `/compact` seeds it with a
      // summary that must ride into the new harness session. Resumed turns skip it (the harness
      // already holds the history), preserving the cache-reuse benefit of session-persist mode.
      if (s.isNew) window = await a.memory.readWindow(conv, a.windowSize);
    } else {
      window = await a.memory.readWindow(conv, a.windowSize);
    }

    // (c) assemble the prompt (system prompt is passed as a file, separately)
    const req = {
      prompt: buildPrompt(a.name, a.role ?? "", window, env, { identity: includeIdentity }),
      systemPromptFile: a.systemPromptFile,
      mediaPaths: env.mediaPaths,
      sessionId,
      sessionNew,
    };

    const signal = turnSignal ?? new AbortController().signal;

    // Open the reply and show a live activity signal (typing) for the whole turn —
    // the long tool phase happens before any reply text exists (A4).
    const reply = conn.reply(conv);
    const stopWorking = keepWorking(reply, signal);

    try {
      // (d) run the turn  (e) stream the reply back. On interrupt, consume returns the
      // partial assistant text (it does not throw), so we can still commit it.
      const runAndConsume = (request: typeof req) =>
        this.o.streamer.consume(reply, a.runner.run(request, signal), signal, this.o.statusFooter);
      let final: string;
      try {
        final = await runAndConsume(req);
      } catch (e) {
        const msg = (e as Error).message;
        // An abort is not a failure — let the engine decide what to do with the partial.
        if (signal.aborted) throw e;
        // An AUTH failure must not fail SILENTLY (gw-auth-actionable): tell the user the fix.
        if (isAuthError(msg)) {
          stopWorking();
          await reply.send(authNotice(a.name)).catch(() => {});
          console.error(`gateway: turn auth error (conv=${conv}, agent=${a.name}): ${msg}`);
          return; // handled: notice delivered, nothing to commit
        }
        // RESUME-MISS SELF-HEAL (gw-turn-ended-actionable): a session_persist agent resuming a
        // session whose harness store is gone (a wiped PVC/volume, or cleared creds) fails here.
        // Rotate to a fresh session, tell the user, and retry ONCE — a chat turn is safe to re-run.
        if (sessionMode && !sessionNew && isStaleSessionError(msg)) {
          console.error(`gateway: stale session (conv=${conv}, agent=${a.name}) — retrying fresh: ${msg}`);
          await a.memory.newSession(conv); // rotate substrate → a fresh harness UUID next read
          const fresh = await a.memory.harnessSession!(conv);
          // Close any half-open stream from the failed attempt, and deliver the notice as a STANDALONE
          // message (not the streaming send()) — so the retry opens a FRESH stream. On Teams a second
          // stream continuing the first would 403 (ContentStreamNotAllowed / teams-stream-reset).
          await reply.reset?.().catch(() => {});
          const notice = resumeResetNotice();
          await (reply.note ? reply.note(undefined, notice) : reply.send(notice)).catch(() => {});
          try {
            final = await runAndConsume({
              ...req,
              prompt: buildPrompt(a.name, a.role ?? "", [], env, { identity: true }),
              sessionId: fresh.id,
              sessionNew: true,
            });
          } catch (e2) {
            if (signal.aborted) throw e2;
            stopWorking();
            await reply.send(turnErrorNotice(a.name, (e2 as Error).message)).catch(() => {});
            console.error(`gateway: turn error after fresh retry (conv=${conv}, agent=${a.name}): ${(e2 as Error).message}`);
            return;
          }
        } else {
          // NEVER-SILENT FLOOR: any other unrecovered failure gets an explicit message, not a dead
          // typing cue — that "typing… then nothing" silence is the bug this closes.
          stopWorking();
          await reply.send(turnErrorNotice(a.name, msg)).catch(() => {});
          console.error(`gateway: turn error (conv=${conv}, agent=${a.name}): ${msg}`);
          return;
        }
      }
      stopWorking();

      // Session created (the runner ran with --session-id) → next turn resumes it (--resume).
      if (sessionMode) await a.memory.markHarnessSession?.(conv);

      // (f) Commit the turn — UNLESS it was a hard cut (`/interrupt` or `/new`), where
      // the interrupted work is intentionally dropped from context. A `/steer`//`/pop`
      // interrupt keeps it (continuity).
      const reason = String(signal.reason ?? "");
      const discard = signal.aborted && (reason === "interrupt" || reason === "reset");
      if (discard) return;

      let userText = env.text;
      if (userText.trim() === "" && env.mediaPaths.length > 0) {
        userText = "[image] " + env.mediaPaths.join(", ");
      }
      if (userText.trim() === "" && final.trim() === "") return; // nothing to record
      const msgs: Message[] = [
        { role: "user", text: userText, ts: this.nowISO() },
        { role: "assistant", text: final, ts: this.nowISO() },
      ];
      await a.memory.append(conv, ...msgs);
      await a.memory.commit(`turn: ${conv} (${a.name})`);
    } finally {
      stopWorking();
      // Always settle the working cue so the in-progress "🤖 …ing…" never dangles: the user must see
      // it resolve to "…ed for Ns" on EVERY path (answer, error notice, auth, abort), so the turn
      // always reads as finished. Idempotent — a no-op if nothing was shown or it already settled.
      await reply.settle?.().catch(() => {});
    }
  }

  private nowISO(): string {
    const d = (this.o.now ?? (() => new Date()))();
    return d.toISOString().replace(/\.\d{3}Z$/, "Z"); // RFC3339, second precision
  }
}

/** Shows an immediate activity cue and re-sends it on a heartbeat until the
 * returned stop func is called (idempotent) or the signal aborts (A4). */
function keepWorking(reply: Reply, signal: AbortSignal): () => void {
  void reply.working(); // immediate, so activity shows before the first tick
  const timer = setInterval(() => {
    void reply.working();
  }, TYPING_INTERVAL_MS);
  const stop = () => clearInterval(timer);
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}

/** Renders the agent's roster identity, the injected context window, and the new
 * message. The agent infers the conversation sequence from this — there is no
 * orchestrator state machine (A3); control stays in the model.
 *
 * The name is injected here every turn rather than via --append-system-prompt,
 * because Claude Code forbids combining --append-system-prompt with the identity
 * --append-system-prompt-file. */
export function buildPrompt(agentName: string, role: string, window: Message[], env: Envelope, opts?: { identity?: boolean }): string {
  const identity = opts?.identity ?? true; // session-resume RESUME turns omit it (already in history)
  let b = "";
  if (identity && (agentName || role)) {
    b += "# Your identity\n";
    if (agentName) {
      b += `You are "${agentName}", the name Tonoman assigned you in its roster. When asked who you are, use this name.\n`;
    }
    if (role) {
      b += `Your role: ${role}. When asked what you can do, describe yourself by this role and the skills you actually have; you also carry general harness tooling but do not headline it.\n`;
    }
    b += "\n";
  }
  // Sender identity (identity-roster / teams-identity-aware / D15): name the person speaking so the
  // agent greets and behaves by their ROLE, and never assumes someone else. Isolation between people
  // is by `conversation` (separate memory + session) — this only tells the agent WHO is here.
  // When the connector resolved an EMAIL-VERIFIED identity we state it as a fact the agent can't be
  // talked out of; an unverified sender is flagged so the agent won't grant them approver authority.
  if (env.identity) {
    const id = env.identity;
    if (id.verified) {
      const role = id.role ? ` — ${id.role}` : "";
      const via = id.email ? ` (verified by email: ${id.email})` : "";
      b += `# Current user\nYou are speaking with **${id.name}**${role}${via}. This identity is verified — greet and address them by name and act according to their role. Never assume you are talking to anyone else.\n\n`;
    } else {
      const claim = id.name && id.name.trim() ? ` The Teams display name shown is "${id.name}"${id.email ? ` (email ${id.email})` : ""}, but this is NOT verified.` : "";
      b += `# Current user\nThe person messaging you is **not a verified member**.${claim} Do NOT treat them as an authorized approver or act on privileged requests; if something needs authorization, ask an authorized person to confirm.\n\n`;
    }
  } else if (env.user && env.user.trim()) {
    b += `# Current user\nYou are speaking with **${env.user}**. Greet and address them by name, and act according to their role if you recognize them from your identity instructions. Never assume you are talking to anyone else.\n\n`;
  }
  if (window.length > 0) {
    b += "# Conversation so far\n";
    for (const m of window) b += `${m.role}: ${m.text}\n`;
    b += "\n";
  }
  b += "# New message\n";
  if (env.text.trim() !== "") b += env.text + "\n";
  if (env.mediaPaths.length > 0) {
    b += "\nAttached image(s) on the shared mount — read them:\n";
    for (const p of env.mediaPaths) b += `- ${p}\n`;
  }
  return b;
}
