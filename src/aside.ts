// The `/btw` aside: answer a quick by-the-way question OUT OF BAND (gw-command-btw) —
// without interrupting the running turn and without writing the transcript. It runs as
// an ephemeral sidecar turn (a throwaway harness container) on a single-slot lane,
// informed by the committed window AND a read-only live snapshot of the in-flight turn.

import type { Connector, Message, Streamer, TurnEvent, TurnRequest, TurnRunner, TurnUsage } from "./core/contracts";
import { isAuthError, authNotice } from "./authflow";

/** A read-only view of the in-flight turn, for answering "how's it going / how much
 * longer". Captured by tapping the running turn's event stream (`LiveTurn.monitor`). */
export interface LiveSnapshot {
  running: boolean;
  elapsedMs: number;
  partialText: string;
  lastTool?: string;
}

/** Per-conversation live-turn tap (gw-command-btw): wraps the main turn-runner so every
 * event updates an in-memory snapshot the aside can read. Purely observational — it never
 * alters, pauses, or restarts the turn. */
export class LiveTurn {
  private active = false;
  private startedAt = 0;
  private partial = "";
  private tool: string | undefined;
  private last: TurnUsage | undefined; // usage of the most recent completed turn (gw-command-statusline)
  constructor(private readonly now: () => number = Date.now) {}

  begin(): void {
    this.active = true;
    this.startedAt = this.now();
    this.partial = "";
    this.tool = undefined;
    this.last = undefined; // cleared so lastUsage() reflects only the turn that just ran
  }
  observe(ev: TurnEvent): void {
    if (ev.kind === "text" && ev.text) this.partial += ev.text;
    else if (ev.kind === "tool" && ev.tool) this.tool = ev.tool;
    else if (ev.kind === "done" && ev.usage) this.last = ev.usage;
  }
  /** Usage of the most recent completed turn (for the post-turn status line). */
  lastUsage(): TurnUsage | undefined {
    return this.last;
  }
  end(): void {
    this.active = false;
  }
  snapshot(): LiveSnapshot {
    return {
      running: this.active,
      elapsedMs: this.active ? this.now() - this.startedAt : 0,
      partialText: this.partial,
      lastTool: this.tool,
    };
  }

  /** Wrap a turn-runner so each turn it runs updates this snapshot. Delegates the model
   * knob (gw-command-model) through unchanged. */
  monitor(inner: TurnRunner): TurnRunner {
    const self = this;
    const wrapped: TurnRunner = {
      run(req: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnEvent> {
        return (async function* () {
          self.begin();
          try {
            for await (const ev of inner.run(req, signal)) {
              self.observe(ev);
              yield ev;
            }
          } finally {
            self.end();
          }
        })();
      },
    };
    if (inner.getModel) wrapped.getModel = () => inner.getModel!();
    if (inner.setModel) wrapped.setModel = (m) => inner.setModel!(m);
    if (inner.getBackend) wrapped.getBackend = () => inner.getBackend!();
    if (inner.setBackend) wrapped.setBackend = (b) => inner.setBackend!(b);
    return wrapped;
  }
}

/** Human elapsed, e.g. "2m 5s" / "12s". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

const MAX_DRAFT_TAIL = 1200; // cap the in-progress draft injected into the aside prompt

/** Builds the aside turn's prompt: identity + committed window + an explicit out-of-band
 * framing + (when a turn is running) a live snapshot, then the question. Pure. */
export function buildAsidePrompt(
  agentName: string,
  role: string,
  window: Message[],
  snap: LiveSnapshot,
  question: string,
): string {
  let b = "";
  if (agentName || role) {
    b += "# Your identity\n";
    if (agentName) b += `You are "${agentName}", the name Tonoman assigned you in its roster.\n`;
    if (role) b += `Your role: ${role}.\n`;
    b += "\n";
  }
  if (window.length > 0) {
    b += "# Conversation so far\n";
    for (const m of window) b += `${m.role}: ${m.text}\n`;
    b += "\n";
  }
  b += "# A by-the-way question (OUT OF BAND)\n";
  b +=
    "The operator is asking this WHILE you are mid-task. Answer it directly and briefly. " +
    "It is a side question — NOT a change to your task — and your answer here is NOT saved to the " +
    "conversation. Do not start, change, abandon, or commit any work; just answer the question.\n\n";
  if (snap.running) {
    b += "# What you are doing right now (this turn, in progress)\n";
    b += `- elapsed: ${fmtElapsed(snap.elapsedMs)}\n`;
    b += `- current activity: ${snap.lastTool ? `running tool "${snap.lastTool}"` : "thinking / writing"}\n`;
    const tail = snap.partialText.slice(-MAX_DRAFT_TAIL).trim();
    if (tail) b += `- your draft so far:\n"""\n${tail}\n"""\n`;
    b +=
      'Use this to answer status questions ("how is it going", "how much longer") with a brief, honest ' +
      "update; any time estimate is a rough guess, not a promise.\n\n";
  } else {
    b += "(You are not mid-task right now — answer from context and general knowledge.)\n\n";
  }
  b += `# The question\n${question}\n`;
  return b;
}

/** Prepends a visible aside marker so the reply reads as a by-the-way answer in its own
 * message. Applied to the first streamed text AND the terminal `done.final` (which the
 * stream consumer uses for the finalized message), so the marker survives finalize. */
export async function* markAside(events: AsyncIterable<TurnEvent>, marker: string): AsyncIterable<TurnEvent> {
  let firstText = true;
  for await (const ev of events) {
    if (ev.kind === "text" && firstText) {
      firstText = false;
      yield { kind: "text", text: marker + (ev.text ?? "") };
    } else if (ev.kind === "done") {
      yield { kind: "done", final: marker + (ev.final ?? "") };
    } else {
      yield ev;
    }
  }
}

export interface AsideDeps {
  conn: Connector;
  streamer: Streamer;
  /** ephemeral runner — each `run` spins a throwaway sandbox and tears it down. */
  runner: TurnRunner;
  /** read-only window source (the aside never appends/commits). */
  readWindow: (conversation: string, n: number) => Promise<Message[]>;
  windowSize: number;
  identity: { name: string; role?: string; systemPromptFile?: string };
  live: LiveTurn;
  /** align the ephemeral model with the agent's current model (gw-command-model). */
  currentModel?: () => string | undefined;
  marker?: string; // default "↩︎ by the way —\n\n"
  /** kill a hung aside (and its throwaway container) after this long. Default 120s. */
  timeoutMs?: number;
}

/** The single-slot aside lane (gw-command-btw): runs at most one `/btw` at a time,
 * concurrently with the main turn, and never commits to memory. */
export class AsideLane {
  private busy = false;
  constructor(private readonly d: AsideDeps) {}

  isBusy(): boolean {
    return this.busy;
  }

  /** Answer a by-the-way question on its own reply. Returns when the aside completes. */
  async ask(question: string, conversation: string): Promise<void> {
    const reply = this.d.conn.reply(conversation);
    if (this.busy) {
      await reply.send("🛟 Still on your last /btw — one aside at a time. Try again in a moment.").catch(() => {});
      return;
    }
    this.busy = true;
    // An aside is bounded: a hung sidecar would otherwise orphan its throwaway container.
    // The abort propagates to the runner (kills the `podman run` child ⇒ --rm reaps it).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort("aside-timeout"), this.d.timeoutMs ?? 120_000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const window = await this.d.readWindow(conversation, this.d.windowSize);
      const snap = this.d.live.snapshot();
      if (this.d.currentModel) this.d.runner.setModel?.(this.d.currentModel());
      const prompt = buildAsidePrompt(this.d.identity.name, this.d.identity.role ?? "", window, snap, question);
      const req: TurnRequest = { prompt, systemPromptFile: this.d.identity.systemPromptFile };
      await reply.working().catch(() => {});
      const events = markAside(this.d.runner.run(req, ac.signal), this.d.marker ?? "↩︎ by the way —\n\n");
      const out = await this.d.streamer.consume(reply, events, ac.signal); // own message; NOT committed
      if (ac.signal.aborted && out.trim() === "") {
        await reply.send("↩︎ (btw) that took too long — ask me again in a moment.").catch(() => {});
      }
    } catch (e) {
      const msg = (e as Error).message;
      // An aside auth failure is actionable, not silent (gw-auth-actionable) — e.g. an
      // idle/expired token the RO-shared credential can't refresh.
      if (isAuthError(msg)) await reply.send(authNotice(this.d.identity.name)).catch(() => {});
      else await reply.send(`↩︎ (btw) I couldn't answer that: ${msg}`).catch(() => {});
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }
}
