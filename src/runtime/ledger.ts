// The broker ledger (A8 control channel · A12 observability): an append-only,
// per-agent JSONL record of every brokered command and every turn boundary. It is
// a *discoverable* log — it lives in the agent's git-backed workspace next to its
// sessions — and it serves two roles the live app-stack test showed missing:
//
//   1. Observability. Today a brokered build/restore runs with no host-side trace;
//      this records start + terminal status (verb, argv, exit code, duration) so an
//      operator can see what actually ran on the agent's behalf.
//   2. The catch (probabilistic). An op recorded as started but with NO terminal
//      status when its turn ends is an *orphan* — the agent backgrounded it and the
//      `claude -p` turn dropped it (exactly how the migration silently vanished).
//      `endTurn` flags those rather than letting them be silently absent. The source
//      of truth is this ledger, not the agent's chat reply.
//
//      This is a *probabilistic* catch: it fires only if a broker call is in-flight
//      at turn-end. An orchestrator (e.g. dbops) that dies *between* broker calls can
//      leave a clean ledger with the work incomplete — that case is caught
//      deterministically by outcome verification (devcontainerized-fix-service),
//      not here.
//
// SECURITY: callers pass only the *authorized* argv (post path-rewrite, PRE host-side
// secret injection). The broker injects `-e KEY=VALUE` into a separate executed argv
// that never reaches this module, so the ledger — which is committed and may be
// pushed — can never leak an injected secret.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export type LedgerPhase = "turn-start" | "turn-end" | "op-start" | "op-end" | "op-orphaned";

export interface LedgerEntry {
  phase: LedgerPhase;
  ts: string; // RFC3339, second precision
  id?: string; // brokered op id (the control-request id)
  conv?: string; // turn entries: the conversation
  user?: string; // turn-start: who sent it
  text?: string; // turn-start: short message preview
  verb?: string; // op entries: the podman/compose verb
  argv?: string[]; // op entries: AUTHORIZED argv (pre-injection) — safe to persist
  cwd?: string; // op entries: the agent's working directory
  code?: number | null; // op-end: exit code (null if killed)
  durationMs?: number; // op-end: wall time start→end
  denied?: boolean; // op-end: the policy refused it (nothing ran)
  reason?: string; // op-end: denial reason / error
  orphans?: number; // turn-end: how many in-flight ops were flagged
}

interface InFlight {
  id: string;
  verb: string;
  argv: string[];
  cwd?: string;
  startMs: number;
}

export interface LedgerOptions {
  /** discoverable per-agent ledger file (in the git-backed workspace). */
  file: string;
  /** injectable clock; defaults to wall-clock. */
  clock?: () => Date;
}

export class Ledger {
  private readonly inflight = new Map<string, InFlight>();
  private readonly flagged = new Set<string>(); // orphaned ids already reported
  private dirReady = false;

  constructor(private readonly o: LedgerOptions) {}

  private nowDate(): Date {
    return (this.o.clock ?? (() => new Date()))();
  }

  /** Records the start of a brokered op and marks it in-flight. */
  async opStart(id: string, argv: string[], cwd?: string): Promise<void> {
    const now = this.nowDate();
    const verb = argv[0] ?? "";
    this.inflight.set(id, { id, verb, argv, cwd, startMs: now.getTime() });
    await this.append({ phase: "op-start", ts: iso(now), id, verb, argv, cwd });
  }

  /** Records the terminal status of a brokered op and clears it from in-flight.
   * `argv` is the authorized (pre-injection) argv actually run; omit on plain errors. */
  async opEnd(
    id: string,
    r: { code: number | null; denied?: boolean; reason?: string; argv?: string[] },
  ): Promise<void> {
    const now = this.nowDate();
    const f = this.inflight.get(id);
    this.inflight.delete(id);
    this.flagged.delete(id);
    const durationMs = f ? now.getTime() - f.startMs : undefined;
    await this.append({
      phase: "op-end",
      ts: iso(now),
      id,
      verb: f?.verb,
      argv: r.argv ?? f?.argv,
      cwd: f?.cwd,
      code: r.code,
      durationMs,
      denied: r.denied,
      reason: r.reason,
    });
  }

  /** Records the start of a turn (observability). */
  async turnStart(conv: string, user?: string, text?: string): Promise<void> {
    await this.append({ phase: "turn-start", ts: iso(this.nowDate()), conv, user, text });
  }

  /** The point-in-time snapshot of started-but-not-terminal ops. v0.1 turns are
   * sequential per conversation, so any in-flight op belongs to the running turn. */
  inFlight(): InFlight[] {
    return [...this.inflight.values()];
  }

  /**
   * Ends a turn: flags every still-in-flight op as orphaned (the turn returned
   * without waiting for it) and records the turn boundary. Returns the newly
   * orphaned ids. Idempotent per op — an op already flagged by a prior turn-end is
   * not re-reported. THE CATCH lives here.
   */
  async endTurn(conv: string): Promise<string[]> {
    const orphaned: string[] = [];
    for (const f of this.inflight.values()) {
      if (this.flagged.has(f.id)) continue;
      this.flagged.add(f.id);
      orphaned.push(f.id);
      await this.append({
        phase: "op-orphaned",
        ts: iso(this.nowDate()),
        id: f.id,
        conv,
        verb: f.verb,
        argv: f.argv,
        cwd: f.cwd,
        reason: "started but no terminal status when the turn ended (backgrounded/dropped)",
      });
    }
    await this.append({ phase: "turn-end", ts: iso(this.nowDate()), conv, orphans: orphaned.length });
    return orphaned;
  }

  private async append(e: LedgerEntry): Promise<void> {
    if (!this.dirReady) {
      await fs.mkdir(path.dirname(this.o.file), { recursive: true });
      this.dirReady = true;
    }
    await fs.appendFile(this.o.file, JSON.stringify(e) + "\n", "utf8");
  }
}

/** RFC3339 at second precision (matches the transcript timestamp format). */
function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
