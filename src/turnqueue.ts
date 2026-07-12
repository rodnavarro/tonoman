// The per-conversation turn engine (A1). Queue-by-default ("Claude-Code feel"): a
// plain message is **enqueued** (merged with anything already waiting) and runs after
// the current turn — the operator can say everything on their mind and let the agent
// get to it. Interrupting is the **explicit** exception:
//
//   message(text)   — plain message: ENQUEUE (merge) + run after the current turn
//   steer(text)     — interrupt the running turn NOW (keep its partial as context),
//                     merge with any queue, run next  (= enqueue + pop)
//   pop()           — run the queued message(s) NOW (interrupt, keep context)
//   interrupt(text) — hard cut: drop the turn's partial context + queue, run fresh
//   reset()         — interrupt + clear queue, drop partial (e.g. /new)
//   cancelPending() — drop the queued message(s) (e.g. /skip)
//
// The abort carries a REASON ("steer" | "interrupt" | "reset"); the gateway's runTurn
// reads signal.reason to decide whether to persist the interrupted turn's partial
// output (steer keeps it for continuity; interrupt/reset discard it). onPendingChange
// drives a single in-place queue footer (no per-message banner).

import type { ResolvedIdentity } from "./identity";

export interface PendingMsg {
  text: string;
  user: string;
  mediaPaths: string[];
  /** email-verified sender identity (identity-roster), carried through the queue so it reaches
   * buildPrompt. Dropping it here silently reverts recognition to the display-name fallback. */
  identity?: ResolvedIdentity;
}

/** Runs one turn for a (merged) message under an abort signal. Resolve when done;
 * when `signal` aborts, the runner should stop promptly so the next turn can start. */
export type RunTurn = (msg: PendingMsg, signal: AbortSignal) => Promise<void>;

export interface TurnQueueOptions {
  /** how long to gather rapid messages into one directive before running. Default 600ms. */
  coalesceMs?: number;
  /** injectable clock (ms); defaults to Date.now. */
  now?: () => number;
  /** Fired whenever the waiting-queue depth changes: (count, preview, running). The
   * gateway renders a single in-place footer from it (shown only while a turn runs).
   * count 0 means the queue is empty / has just been picked up. */
  onPendingChange?: (count: number, preview: string, running: boolean) => void;
}

/** Combines two messages into one (chronological, blank-line separated). */
export function mergePending(a: PendingMsg | null, b: PendingMsg | null): PendingMsg | null {
  if (!a) return b;
  if (!b) return a;
  return {
    text: `${a.text}\n\n${b.text}`.trim(),
    user: b.user || a.user,
    mediaPaths: [...a.mediaPaths, ...b.mediaPaths],
    identity: b.identity ?? a.identity, // latest verified identity wins (mirrors `user`)
  };
}

export class TurnQueue {
  private pending: PendingMsg | null = null;
  private pendingN = 0; // number of queued messages merged into `pending` (for the footer)
  private running = false;
  private draining = false;
  private abort: AbortController | null = null;
  private settleAt = 0;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private readonly onPendingChange?: (count: number, preview: string, running: boolean) => void;

  constructor(private readonly runTurn: RunTurn, private readonly signal: AbortSignal, opts: TurnQueueOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? 600;
    this.now = opts.now ?? Date.now;
    this.onPendingChange = opts.onPendingChange;
  }

  isRunning(): boolean {
    return this.running;
  }
  hasPending(): boolean {
    return this.pending !== null;
  }

  /** A plain message: ENQUEUE it (merged with anything waiting) and run after the
   * current turn. Does NOT interrupt. An idle queue runs after a short coalesce window
   * (so a rapid burst merges into one directive). */
  message(text: string, user: string, mediaPaths: string[] = [], identity?: ResolvedIdentity): void {
    this.enqueue(text, user, mediaPaths, identity);
    this.settleAt = this.now() + this.coalesceMs;
    this.emit();
    void this.drain();
  }

  /** /steer: interrupt the running turn NOW (keeping its partial as context), fold in
   * any queued message, and run next. */
  steer(text: string, user: string, mediaPaths: string[] = [], identity?: ResolvedIdentity): void {
    this.enqueue(text, user, mediaPaths, identity);
    if (this.running) this.abortCurrent("steer");
    this.settleAt = this.now(); // run ASAP
    void this.drain();
  }

  /** /pop: run the queued message(s) NOW — interrupt the current turn (keeping its
   * partial as context) and process the queue immediately. Returns false if nothing
   * is queued. */
  pop(): boolean {
    if (!this.pending) return false;
    if (this.running) this.abortCurrent("steer");
    this.settleAt = this.now();
    void this.drain();
    return true;
  }

  /** /interrupt: hard cut — drop the running turn's partial context AND any queue,
   * then run `text` fresh. */
  interrupt(text: string, user: string, mediaPaths: string[] = [], identity?: ResolvedIdentity): void {
    this.pending = { text, user, mediaPaths, identity };
    this.pendingN = 1;
    this.abortCurrent("interrupt");
    this.settleAt = this.now();
    void this.drain();
  }

  /** /new: interrupt + clear the queue (the partial is dropped). */
  reset(): void {
    this.pending = null;
    this.pendingN = 0;
    this.emit();
    this.abortCurrent("reset");
  }

  /** /skip: cancel the queued message(s). Returns whether anything was dropped. */
  cancelPending(): boolean {
    const had = this.pending !== null;
    this.pending = null;
    this.pendingN = 0;
    this.emit();
    return had;
  }

  private enqueue(text: string, user: string, mediaPaths: string[], identity?: ResolvedIdentity): void {
    this.pending = mergePending(this.pending, { text, user, mediaPaths, identity });
    this.pendingN++;
  }

  private emit(): void {
    this.onPendingChange?.(this.pendingN, this.pending?.text ?? "", this.running);
  }

  private abortCurrent(reason: string): void {
    this.abort?.abort(reason);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending && !this.signal.aborted) {
        const wait = this.settleAt - this.now();
        if (wait > 0) {
          await sleep(wait, this.signal); // coalesce window; new input pushes settleAt out
          continue;
        }
        const msg = this.pending;
        this.pending = null;
        this.pendingN = 0;
        this.emit(); // queue picked up → footer resolves
        const ac = new AbortController();
        this.abort = ac;
        const onParent = () => ac.abort("reset");
        this.signal.addEventListener("abort", onParent, { once: true });
        this.running = true;
        try {
          await this.runTurn(msg, ac.signal);
        } catch {
          /* a turn's own errors must not stall the queue */
        } finally {
          this.running = false;
          this.signal.removeEventListener("abort", onParent);
          this.abort = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

/** A cancellable sleep that resolves immediately when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
