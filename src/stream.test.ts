import { describe, it, expect } from "vitest";
import { Consumer, heartbeatLabel } from "./stream";
import type { Reply, TurnEvent } from "./core/contracts";

/** A Reply that records every surface it's asked to show + every working() status label. */
function recordingReply(): { reply: Reply; shown: string[]; worked: string[] } {
  const shown: string[] = [];
  const worked: string[] = [];
  const reply: Reply = {
    canEdit: () => true,
    send: async (s) => {
      shown.push(s);
      return "m1";
    },
    update: async (_id, s) => {
      shown.push(s);
    },
    finalize: async (_id, s) => {
      shown.push(s);
    },
    working: async (status?: string) => {
      if (status) worked.push(status);
    },
  };
  return { reply, shown, worked };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("heartbeatLabel", () => {
  it("shows no minute count under a minute, then ticks in whole minutes", () => {
    expect(heartbeatLabel(5_000)).toBe("🤖 working…");
    expect(heartbeatLabel(60_000)).toBe("🤖 working… (1m)");
    expect(heartbeatLabel(125_000)).toBe("🤖 working… (2m)");
  });
});

describe("Consumer — liveness heartbeat (gw-stream-heartbeat)", () => {
  it("refreshes a working… cue when a turn goes quiet, then clears it from the final", async () => {
    const { reply, shown } = recordingReply();
    // Short heartbeat so the test runs fast; real clock.
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, heartbeatMs: 40 });

    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "Starting migration…\n" };
      await sleep(160); // quiet phase well past the heartbeat interval
      yield { kind: "text", text: "done — 42 tables.\n" };
      yield { kind: "done" };
    }

    const final = await consumer.consume(reply, events());

    // A liveness cue appeared during the quiet phase…
    expect(shown.some((s) => s.includes("🤖 working…"))).toBe(true);
    // …but the final message is clean (no cue left behind — the edit-leak guard).
    expect(final).toBe("Starting migration…\ndone — 42 tables.\n");
    expect(shown[shown.length - 1].includes("working…")).toBe(false);
  });

  it("persists the cue through a later stream event instead of flickering it away", async () => {
    const { reply, shown } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, heartbeatMs: 40 });

    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "Applying migration…\n" };
      await sleep(120); // cue appears during this quiet phase
      yield { kind: "tool", tool: "Bash" }; // a later sporadic event — must NOT wipe the cue
      await sleep(60);
      yield { kind: "done" };
    }

    await consumer.consume(reply, events());

    // A frame that shows the Bash tool line ALSO carries the cue — the event did not
    // clear it (the old bug: each event reset the cue, so it flickered in and out).
    const toolFrames = shown.filter((s) => s.includes("🔧 Bash"));
    expect(toolFrames.length).toBeGreaterThan(0);
    expect(toolFrames.some((s) => s.includes("working…"))).toBe(true);
  });

  it("shows no cue on a short turn that finishes under the threshold", async () => {
    const { reply, shown } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, heartbeatMs: 5_000 });

    async function* events(): AsyncGenerator<TurnEvent> {
      for (let i = 0; i < 5; i++) {
        yield { kind: "text", text: `chunk ${i} ` };
        await sleep(10);
      }
      yield { kind: "done" };
    }

    await consumer.consume(reply, events()); // whole turn well under the 5s threshold
    expect(shown.some((s) => s.includes("working…"))).toBe(false);
  });

  it("separates text blocks split by a tool, but keeps same-block deltas joined (gw-stream-live)", async () => {
    const { reply } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0 });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "Let me check the processes." }; // block 1
      yield { kind: "tool", tool: "Bash", text: "ps" }; // a tool runs
      yield { kind: "text", text: "No sweep is running." }; // block 2 — must NOT glue to block 1
      yield { kind: "tool", tool: "Bash", text: "ls" };
      yield { kind: "text", text: "The stack is up." }; // block 3
      yield { kind: "done" };
    }
    const final = await consumer.consume(reply, events());
    expect(final).toBe("Let me check the processes.\n\nNo sweep is running.\n\nThe stack is up.");
    expect(final).not.toContain("processes.No"); // the reported collapse is gone
  });

  it("does NOT insert breaks between same-block text deltas (no tool between)", async () => {
    const { reply } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0 });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "Starting migration…\n" };
      yield { kind: "text", text: "done — 42 tables.\n" };
      yield { kind: "done" };
    }
    expect(await consumer.consume(reply, events())).toBe("Starting migration…\ndone — 42 tables.\n");
  });

  it("appends a status footer to the displayed final but NOT to the returned text (gw-command-statusline)", async () => {
    const { reply, shown } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0 });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "the answer" };
      yield { kind: "done", final: "the answer", usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 } };
    }
    const footer = (u?: { inputTokens: number }) => (u ? "📊 footer" : null);
    const final = await consumer.consume(reply, events(), undefined, footer);
    expect(final).toBe("the answer"); // transcript stays clean — footer NOT included
    // displayed message carries the footer, separated by a visible blank line (ZWSP paragraph
    // so Teams' markdown doesn't collapse it) — gw-command-statusline
    expect(shown[shown.length - 1]).toBe("the answer\n\n​\n\n📊 footer");
  });

  it("no footer callback ⇒ displayed final equals the returned text", async () => {
    const { reply, shown } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0 });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "done", final: "just this" };
    }
    const final = await consumer.consume(reply, events());
    expect(final).toBe("just this");
    expect(shown[shown.length - 1]).toBe("just this");
  });

  it("returns the partial (does not throw) when interrupted mid-stream", async () => {
    const { reply, shown } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0 });
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "partial output" };
      await gate; // paused mid-stream
      yield { kind: "text", text: " SHOULD-NOT-APPEAR" };
    }

    const p = consumer.consume(reply, events(), ac.signal);
    await sleep(10); // let the first delta render
    ac.abort("steer"); // interrupt
    release(); // unpause the generator
    const final = await p;

    expect(final).toBe("partial output"); // partial returned, not thrown
    expect(shown.join("")).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("a channel delivery failure does NOT abort the turn — final text still returned for commit", async () => {
    const boom: Reply = {
      canEdit: () => true,
      send: async () => {
        throw new Error("fetch failed");
      },
      update: async () => {
        throw new Error("fetch failed");
      },
      finalize: async () => {
        throw new Error("fetch failed");
      },
      working: async () => {},
    };
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0 });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "hello" };
      yield { kind: "done", final: "hello world" };
    }
    const final = await consumer.consume(boom, events()); // must not throw
    expect(final).toBe("hello world"); // returned so the router can still commit the turn
  });

  it("disabled (heartbeatMs=0) never emits a cue even on a long quiet phase", async () => {
    const { reply, shown } = recordingReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, heartbeatMs: 0 });

    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "working on it\n" };
      await sleep(120);
      yield { kind: "done" };
    }

    await consumer.consume(reply, events());
    expect(shown.some((s) => s.includes("working…"))).toBe(false);
  });
});

/** A reply that records each call tagged by method (for prefix-stream assertions). */
function taggedReply(): { reply: Reply; calls: { m: "send" | "update" | "finalize"; s: string }[] } {
  const calls: { m: "send" | "update" | "finalize"; s: string }[] = [];
  const reply: Reply = {
    canEdit: () => true,
    send: async (s) => {
      calls.push({ m: "send", s });
      return "stream1";
    },
    update: async (_id, s) => void calls.push({ m: "update", s }),
    finalize: async (_id, s) => void calls.push({ m: "finalize", s }),
    working: async () => {},
  };
  return { reply, calls };
}

describe("Consumer — prefix-stream mode (teams-stream-progressive)", () => {
  it("streams only a GROWING PREFIX: no cursor, no 🔧 tool line, no heartbeat interleaved", async () => {
    const { reply, calls } = taggedReply();
    // cursor + heartbeat are CONFIGURED but must be ignored under prefixStream.
    const consumer = new Consumer({ cursor: "▌", editIntervalMs: 0, heartbeatMs: 10, prefixStream: true });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "3 drafts" };
      yield { kind: "tool", tool: "Bash", text: "billing draft" }; // progress — must NOT enter the streamed text
      await sleep(30); // past the heartbeat interval — cue must NOT appear either
      yield { kind: "text", text: " ready, $4,200" };
      yield { kind: "done", final: "3 drafts ready, $4,200 total" };
    }
    const final = await consumer.consume(reply, events());
    expect(final).toBe("3 drafts ready, $4,200 total");

    const streamed = calls.filter((c) => c.m !== "finalize").map((c) => c.s);
    for (const s of streamed) {
      expect(s).not.toContain("▌"); // no cursor
      expect(s).not.toContain("🔧"); // no tool line
      expect(s).not.toContain("working…"); // no heartbeat cue
      expect("3 drafts ready, $4,200 total".startsWith(s)).toBe(true); // every chunk is a strict prefix of the final
    }
  });

  it("ALWAYS finalizes to close the stream, even when the final equals the last streamed text", async () => {
    const { reply, calls } = taggedReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, prefixStream: true });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "all done" };
      yield { kind: "done", final: "all done" }; // identical to the last streamed chunk
    }
    await consumer.consume(reply, events());
    // The stream MUST be closed — a finalize call is present despite the unchanged text.
    expect(calls.some((c) => c.m === "finalize")).toBe(true);
  });

  it("finalizes with the STREAMED text when the harness's final DIVERGES (avoids Teams 403 ContentStreamNotAllowed / orphan bubble)", async () => {
    const { reply, calls } = taggedReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, prefixStream: true });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "The question maps to listing services. " }; // streamed preamble
      yield { kind: "text", text: "Northgate has 23 service items." };
      yield { kind: "done", final: "Northgate has 23 service items." }; // result DROPPED the preamble
    }
    await consumer.consume(reply, events());
    const fin = calls.find((c) => c.m === "finalize")!;
    // The delivered final must EXTEND what was streamed (start with the streamed preamble) — not
    // the divergent clean result, which Teams would reject as "should contain previously streamed".
    expect(fin.s.startsWith("The question maps to listing services.")).toBe(true);
  });

  it("separates a NEW text block that resumes after a tool, even when the harness result diverges (name.Rod regression)", async () => {
    const { reply, calls } = taggedReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, prefixStream: true });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "Let me pull the staff list to find the right name." }; // preamble
      yield { kind: "tool", tool: "Bash", text: "billing get staff" };
      yield { kind: "text", text: "Rod, you're not in the staff roster." }; // new block — must NOT glue
      // Claude Code's `result` keeps only the post-tool block, so the final DIVERGES from the stream.
      yield { kind: "done", final: "Rod, you're not in the staff roster." };
    }
    await consumer.consume(reply, events());
    const fin = calls.find((c) => c.m === "finalize")!;
    expect(fin.s).toContain("right name.\n\nRod,"); // the paragraph break is present
    expect(fin.s).not.toContain("name.Rod"); // the reported glue is gone
  });

  it("does NOT break a CONTINUATION that resumes after a tool (leading-space delta stays joined)", async () => {
    const { reply, calls } = taggedReply();
    const consumer = new Consumer({ cursor: "", editIntervalMs: 0, prefixStream: true });
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "3 drafts" };
      yield { kind: "tool", tool: "Bash", text: "billing draft" };
      yield { kind: "text", text: " ready, $4,200" }; // continuation — leading space, no break
      yield { kind: "done", final: "3 drafts ready, $4,200 total" };
    }
    const final = await consumer.consume(reply, events());
    expect(final).toBe("3 drafts ready, $4,200 total");
    const fin = calls.find((c) => c.m === "finalize")!;
    expect(fin.s).not.toContain("3 drafts\n\n"); // no spurious paragraph break mid-sentence
  });

  it("teams-consumer-telegram-safe: with prefixStream OFF (default), cursor + tool line render as before", async () => {
    const { reply, shown } = recordingReply();
    const consumer = new Consumer({ cursor: "▌", editIntervalMs: 0 }); // default: prefixStream undefined
    async function* events(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "checking" };
      yield { kind: "tool", tool: "Bash", text: "ps" };
      yield { kind: "done", final: "checking done" };
    }
    await consumer.consume(reply, events());
    // The Telegram-style rendering is intact: a cursor appeared mid-stream and the 🔧 tool line showed.
    expect(shown.some((s) => s.includes("▌"))).toBe(true);
    expect(shown.some((s) => s.includes("🔧 Bash"))).toBe(true);
  });
});

describe("Consumer — tool narration routed to working() (gw-tool-narration)", () => {
  async function* toolThenText(): AsyncIterable<TurnEvent> {
    yield { kind: "tool", tool: "Bash", text: "rn wiki sync" };
    yield { kind: "text", text: "done." };
    yield { kind: "done", final: "done." };
  }

  it("surfaces the tool (with its arg preview) via working() for prefix-stream channels", async () => {
    const { reply, worked } = recordingReply();
    await new Consumer({ cursor: "▌", editIntervalMs: 0, prefixStream: true }).consume(reply, toolThenText());
    expect(worked.some((s) => s.includes("🔧 Bash: rn wiki sync"))).toBe(true);
  });

  it("prefix-stream never interleaves the 🔧 line into the streamed text (growing-prefix safe)", async () => {
    const { reply, shown } = recordingReply();
    await new Consumer({ cursor: "▌", editIntervalMs: 0, prefixStream: true }).consume(reply, toolThenText());
    expect(shown.every((s) => !s.includes("🔧"))).toBe(true); // the inline tool line is suppressed on Teams
  });

  it("non-prefix (Telegram) shows the tool inline AND pings working() — both carry the detail", async () => {
    const { reply, shown, worked } = recordingReply();
    await new Consumer({ cursor: "▌", editIntervalMs: 0 }).consume(reply, toolThenText());
    expect(shown.some((s) => s.includes("🔧 Bash: rn wiki sync"))).toBe(true);
    expect(worked.some((s) => s.includes("🔧 Bash: rn wiki sync"))).toBe(true);
  });
});
