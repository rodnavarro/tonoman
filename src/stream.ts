// Turns a turn's normalized events into a live reply over the abstract send /
// update / finalize contract (A4). It streams assistant text into one message with
// a cursor, throttles progressive edits, shows tool-progress live, and finalizes
// (cursor stripped) on done. A connector that cannot edit degrades to a
// whole-answer send — one code path, different fidelity.

import type { Reply, ReplyFooter, Streamer, TurnEvent } from "./core/contracts";

const DEFAULT_MAX_LEN = 4096; // Telegram message limit

export interface ConsumerOptions {
  cursor: string; // appended to in-progress edits; stripped on finalize
  editIntervalMs: number; // minimum time between progressive edits; 0 = no throttle
  maxLen?: number; // platform message limit; 0 → 4096
  now?: () => number; // injectable clock (ms); defaults to Date.now
  // After this many ms with no streamed delta, refresh a liveness cue ("🤖 working…
  // (Nm)") so a long quiet tool/build/restore phase looks alive rather than hung —
  // distinct from the transient typing indicator (gw-stream-heartbeat). 0 = disabled.
  heartbeatMs?: number;
  // OPT-IN for channels whose streaming protocol requires each progressive update to be a
  // strict GROWING PREFIX of the assistant text (the Teams `streaminfo` protocol,
  // teams-stream-progressive). When true the consumer streams ONLY the accumulated text —
  // no cursor, and the 🔧 tool-progress / 🤖 heartbeat lines are NOT interleaved (they would
  // break the prefix rule; in-flight progress rides the channel's typing indicator instead)
  // — and finalize() is ALWAYS called to close the stream. DEFAULT FALSE: with it off the
  // consumer renders exactly as before, so Telegram is byte-for-byte unchanged
  // (teams-consumer-telegram-safe).
  prefixStream?: boolean;
}

export class Consumer implements Streamer {
  constructor(private readonly o: ConsumerOptions) {}

  async consume(reply: Reply, events: AsyncIterable<TurnEvent>, signal?: AbortSignal, footer?: ReplyFooter): Promise<string> {
    const now = this.o.now ?? Date.now;
    const maxLen = this.o.maxLen && this.o.maxLen > 0 ? this.o.maxLen : DEFAULT_MAX_LEN;
    const prefixStream = this.o.prefixStream ?? false;
    // A prefix-streaming channel (Teams) forbids a trailing cursor and interleaved lines —
    // every update must be a growing prefix of the assistant text.
    const cursor = prefixStream ? "" : this.o.cursor;

    // The on-message heartbeat cue would break the prefix rule, so it is off for a
    // prefix-streaming channel (the typing indicator carries liveness there instead).
    const heartbeatMs = prefixStream ? 0 : this.o.heartbeatMs ?? 0;

    let acc = "";
    let activeTool = ""; // a tool-progress line shown beneath the text while a tool runs
    // Claude streams the reply as separate content blocks (text → tool → text …); the deltas
    // of a NEW text block after a tool carry no leading separator, so naive concatenation glues
    // distinct steps ("…find the right name.Rod, you're not…"). Insert ONE paragraph break when
    // text resumes after a tool — same-block deltas (no tool between) stay joined (gw-stream-live).
    let breakBeforeText = false;
    let msgID = "";
    let sent = false;
    let lastEdit = 0;
    let haveLast = false;
    let lastSent = ""; // last content put on screen — skip identical re-sends

    const turnStart = now();

    const render = (): string => {
      let t = acc;
      // A prefix-streaming channel must not interleave the tool line (it would break the
      // strict-prefix rule); its typing indicator carries that liveness instead.
      if (activeTool && !prefixStream) {
        if (t) t += "\n";
        t += "🔧 " + activeTool;
      }
      // Liveness footer: once the turn has run past the heartbeat threshold, append a
      // ticking elapsed cue. It is computed here from elapsed-since-turn-start (not
      // stored in a variable a stream event could clear), so it PERSISTS and ticks
      // through sporadic events instead of flickering. Purely display: it edits the
      // outgoing message only — it never feeds the agent or restarts the turn.
      if (heartbeatMs > 0) {
        const elapsed = now() - turnStart;
        if (elapsed >= heartbeatMs) {
          if (t) t += "\n";
          t += heartbeatLabel(elapsed);
        }
      }
      return t + cursor;
    };

    const flush = async (force: boolean): Promise<void> => {
      const display = render();
      if (display.split(cursor).join("").trim() === "") return; // nothing meaningful yet
      if (runeLen(display) > maxLen) return; // too long to preview; final chunking delivers it
      if (display === lastSent) return; // identical — skip (avoids "not modified")
      try {
        if (!sent) {
          if (!reply.canEdit()) return; // degrade: deliver the whole answer at done
          msgID = await reply.send(display);
          sent = true;
          lastSent = display;
          lastEdit = now();
          haveLast = true;
          return;
        }
        if (!force && this.o.editIntervalMs > 0 && haveLast && now() - lastEdit < this.o.editIntervalMs) return; // throttled
        await reply.update(msgID, display);
        lastSent = display;
        lastEdit = now();
        haveLast = true;
      } catch {
        // A transient channel-delivery failure (after the connector's own retries) must
        // NOT kill the turn — the agent's work + memory commit still happen. lastSent is
        // left unchanged so the next flush / finalize re-attempts this content.
      }
    };

    // The heartbeat timer only re-renders the outgoing message so the elapsed cue
    // appears/ticks during a quiet phase (the loop is parked awaiting the agent, so a
    // timer is the only thing that can refresh the view). It NEVER touches the agent:
    // it calls flush → reply.update (an edit to the Telegram message), spends no agent
    // tokens, and does not restart or interrupt the turn — the agent runs to its own
    // completion. The lastSent dedup means it edits at most once per minute roll-over.
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    if (heartbeatMs > 0) {
      timer = setInterval(() => {
        if (stopped) return;
        void flush(true); // re-render; render() decides whether the elapsed cue shows
      }, Math.min(heartbeatMs, 15_000));
    }

    try {
      for await (const ev of events) {
        if (signal?.aborted) break; // interrupted (/steer, /interrupt, /pop) → deliver the partial
        switch (ev.kind) {
          case "text": {
            // Insert a readability break when a NEW text block resumes after a tool, so distinct
            // steps don't glue ("…find the right name.Rod, you're not…"). This applies to a
            // prefix-streaming channel (Teams) too: the break only ever APPENDS to acc, so the
            // growing-prefix invariant holds, and deliverFinal already finalizes with `acc` when it
            // diverges from the harness's result (line ~166) — so Teams shows the separated text
            // instead of the glued result. SKIP the break when the resumed text is a CONTINUATION —
            // Claude split one sentence around the tool call, so it begins with whitespace
            // (e.g. "3 drafts"→tool→" ready" must stay "3 drafts ready") (teams-stream-progressive).
            const t = ev.text ?? "";
            const continuation = t.startsWith(" ") || t.startsWith("\n");
            if (breakBeforeText && acc !== "" && !acc.endsWith("\n") && !continuation) acc += "\n\n";
            breakBeforeText = false;
            acc += t;
            activeTool = ""; // new assistant text supersedes the tool-progress line
            await flush(false);
            break;
          }
          case "tool": {
            let label = ev.tool ?? "";
            if (ev.text) label += ": " + ev.text;
            activeTool = label;
            breakBeforeText = true; // the next text is a new block — break before it
            // gw-tool-narration: surface the tool to the user. Non-prefix channels (Telegram) show
            // the inline "🔧 …" line via render(); a prefix-streaming channel (Teams) can't interleave
            // it, so route it into the connector's status cue via working() instead (a Teams status
            // trace, orthogonal to the growing-prefix stream). Channels that show it inline ignore the arg.
            if (label) {
              console.error(`gateway: tool → ${label}`); // surface tool activity in the log too (not a black box)
              void reply.working("🔧 " + label);
            }
            await flush(true); // a tool change is worth showing immediately
            break;
          }
          case "done": {
            stopHeartbeat(); // before deliverFinal, so no tick re-adds the cue after finalize
            const final = ev.final || acc;
            // What we DELIVER. A prefix-streaming channel (Teams) rejects a final that doesn't
            // CONTAIN what was already streamed (403 ContentStreamNotAllowed). The harness's
            // final result can diverge from the streamed deltas — e.g. the agent streamed a
            // preamble its result dropped. If `final` doesn't extend what Teams already has
            // (lastSent), finalize with the streamed accumulation `acc` instead — `acc` always
            // extends lastSent (it only ever grew), so the stream closes cleanly with no orphan
            // bubble / lingering stop. (Non-prefix channels keep finalizing the canonical result.)
            const deliverText = prefixStream && sent && !final.startsWith(lastSent) ? acc : final;
            // gw-command-statusline: append a display-only footer to the BOTTOM of the
            // finalized message; the RETURNED text stays clean (footer never hits the transcript).
            const foot = footer ? footer(ev.usage) : null;
            // Separate the answer from the status footer with a VISIBLE blank line. A bare
            // "\n\n" is collapsed to a single break by Teams' markdown renderer, so we interpose
            // a zero-width-space paragraph — an empty line that survives collapsing on Teams and
            // stays invisible on Telegram (gw-command-statusline).
            const display = foot ? `${deliverText}\n\n​\n\n${foot}` : deliverText;
            await this.deliverFinal(reply, sent, msgID, display, maxLen, lastSent, prefixStream);
            return final;
          }
          case "error":
            throw ev.err ?? new Error("stream: turn error");
        }
      }
    } catch (e) {
      if (!signal?.aborted) throw e; // a real turn error still propagates; an abort delivers the partial
    } finally {
      stopHeartbeat();
    }
    // Reached when the stream closed without a `done`, OR the turn was interrupted:
    // deliver whatever accumulated so far (the partial is the agent's work-in-progress).
    stopHeartbeat();
    await this.deliverFinal(reply, sent, msgID, acc, maxLen, lastSent, prefixStream);
    return acc;
  }

  /** Delivers the complete reply, cursor- and tool-line-free, splitting into
   * platform-sized chunks. The first chunk finalizes the streamed message (when
   * editable); the rest are fresh sends. */
  private async deliverFinal(reply: Reply, sent: boolean, msgID: string, final: string, maxLen: number, lastSent: string, alwaysFinalize = false): Promise<void> {
    if (final.trim() === "") return;
    const chunks = splitChunks(final, maxLen);
    try {
      if (sent && reply.canEdit()) {
        // A prefix-streaming channel (Teams) must ALWAYS close the stream with finalize, even
        // if the text is unchanged — an unclosed streaminfo leaves the indicator hanging.
        if (alwaysFinalize || chunks[0] !== lastSent) await reply.finalize(msgID, chunks[0]);
      } else {
        await reply.send(chunks[0]);
      }
      for (const ch of chunks.slice(1)) await reply.send(ch);
    } catch {
      // Channel delivery failed after retries — the turn still completes and the
      // transcript still commits; the operator just missed the final on-screen edit.
    }
  }
}

/** Splits text into <=max-char pieces, preferring line boundaries. */
export function splitChunks(s: string, max: number): string[] {
  const r = Array.from(s); // code points, not UTF-16 units
  if (r.length <= max) return [s];
  const chunks: string[] = [];
  let rest = r;
  while (rest.length > max) {
    let cut = max;
    for (let i = max - 1; i >= Math.floor(max / 2); i--) {
      if (rest[i] === "\n") {
        cut = i;
        break;
      }
    }
    chunks.push(rest.slice(0, cut).join("").replace(/\n+$/, ""));
    rest = Array.from(rest.slice(cut).join("").replace(/^\n+/, ""));
  }
  if (rest.length > 0) chunks.push(rest.join(""));
  return chunks;
}

/** The liveness cue shown during a quiet turn. Whole minutes only, so it changes
 * (and so re-renders) at most once a minute — the rest are deduped away. */
export function heartbeatLabel(elapsedMs: number): string {
  const m = Math.floor(elapsedMs / 60_000);
  return m >= 1 ? `🤖 working… (${m}m)` : "🤖 working…";
}

function runeLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
