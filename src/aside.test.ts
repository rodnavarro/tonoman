import { describe, it, expect } from "vitest";
import { LiveTurn, buildAsidePrompt, markAside, fmtElapsed, AsideLane, type LiveSnapshot } from "./aside";
import type { Connector, Message, Reply, TurnEvent, TurnRequest, TurnRunner, Streamer } from "./core/contracts";

// --- fakes -----------------------------------------------------------------
function fakeRunner(events: TurnEvent[]): TurnRunner & { lastReq?: TurnRequest; model?: string } {
  const r: TurnRunner & { lastReq?: TurnRequest; model?: string } = {
    run(req: TurnRequest) {
      r.lastReq = req;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    setModel(m) {
      r.model = m;
    },
    getModel() {
      return r.model;
    },
  };
  return r;
}

/** Minimal streamer: drains events (so markAside runs), throws on error, sends final. */
function fakeStreamer(): Streamer {
  return {
    async consume(reply: Reply, events: AsyncIterable<TurnEvent>): Promise<string> {
      let acc = "";
      let final = "";
      for await (const ev of events) {
        if (ev.kind === "text") acc += ev.text ?? "";
        else if (ev.kind === "done") final = ev.final ?? acc;
        else if (ev.kind === "error") throw ev.err ?? new Error("turn error");
      }
      const out = final || acc;
      await reply.send(out);
      return out;
    },
  };
}

function fakeConn(sent: string[]): Connector {
  const reply: Reply = {
    send: async (t) => (sent.push(t), "id"),
    update: async () => {},
    finalize: async () => {},
    canEdit: () => true,
    working: async () => {},
  };
  return { name: () => "t", receive: async function* () {}, reply: () => reply } as unknown as Connector;
}

const win = (msgs: Array<[string, string]>): Message[] => msgs.map(([role, text]) => ({ role, text, ts: "t" }));

// --- LiveTurn --------------------------------------------------------------
describe("LiveTurn — live snapshot of the in-flight turn (gw-command-btw)", () => {
  it("snapshot reflects partial text + last tool while running, and clears when done", async () => {
    let clock = 1000;
    const live = new LiveTurn(() => clock);
    expect(live.snapshot().running).toBe(false);

    const inner = fakeRunner([
      { kind: "text", text: "Look" },
      { kind: "tool", tool: "Bash" },
      { kind: "text", text: "ing" },
      { kind: "done", final: "Looking done" },
    ]);
    const mon = live.monitor(inner);

    const it = mon.run({ prompt: "x" });
    let midSnap: LiveSnapshot | undefined;
    for await (const ev of it) {
      if (ev.kind === "done") {
        clock = 6000; // 5s elapsed since begin@1000
        midSnap = live.snapshot();
      }
    }
    expect(midSnap?.running).toBe(true);
    expect(midSnap?.partialText).toBe("Looking");
    expect(midSnap?.lastTool).toBe("Bash");
    expect(midSnap?.elapsedMs).toBe(5000);
    // after the stream ends, the snapshot is no longer "running"
    expect(live.snapshot().running).toBe(false);
  });

  it("delegates the model knob (gw-command-model) through the wrapper", () => {
    const inner = fakeRunner([]);
    const mon = new LiveTurn().monitor(inner);
    mon.setModel?.("opus");
    expect(mon.getModel?.()).toBe("opus");
    expect(inner.model).toBe("opus");
  });
});

describe("fmtElapsed", () => {
  it("formats seconds and minutes", () => {
    expect(fmtElapsed(5000)).toBe("5s");
    expect(fmtElapsed(125000)).toBe("2m 5s");
  });
});

// --- buildAsidePrompt ------------------------------------------------------
describe("buildAsidePrompt — out-of-band framing + live snapshot", () => {
  const running: LiveSnapshot = { running: true, elapsedMs: 90000, partialText: "draft text here", lastTool: "Bash" };
  it("frames the question as out-of-band and includes identity + window + question", () => {
    const p = buildAsidePrompt("Cody", "dev agent", win([["user", "build it"]]), running, "how's it going?");
    expect(p).toContain('You are "Cody"');
    expect(p).toContain("dev agent");
    expect(p).toContain("build it"); // window
    expect(p).toContain("OUT OF BAND");
    expect(p).toContain("NOT saved to the conversation");
    expect(p).toContain("how's it going?");
  });
  it("injects the live snapshot when a turn is running (so it can answer status)", () => {
    const p = buildAsidePrompt("Cody", "", [], running, "status?");
    expect(p).toContain("1m 30s"); // elapsed
    expect(p).toContain('running tool "Bash"');
    expect(p).toContain("draft text here");
    expect(p).toContain("how is it going");
  });
  it("says not-mid-task when nothing is running", () => {
    const p = buildAsidePrompt("Cody", "", [], { running: false, elapsedMs: 0, partialText: "" }, "what model?");
    expect(p).toContain("not mid-task");
  });
});

// --- markAside -------------------------------------------------------------
describe("markAside — the aside reads as its own marked reply", () => {
  async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
    const out: TurnEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }
  it("prepends the marker to the first text AND the terminal done.final", async () => {
    const evs = await collect(
      markAside(
        (async function* () {
          yield { kind: "text", text: "hi" } as TurnEvent;
          yield { kind: "text", text: " there" } as TurnEvent;
          yield { kind: "done", final: "hi there" } as TurnEvent;
        })(),
        "MARK ",
      ),
    );
    expect(evs[0]).toEqual({ kind: "text", text: "MARK hi" });
    expect(evs[1]).toEqual({ kind: "text", text: " there" }); // only the first text is marked
    expect(evs[2]).toEqual({ kind: "done", final: "MARK hi there" });
  });
  it("still marks done.final when there were no text events", async () => {
    const evs = await collect(
      markAside((async function* () {
        yield { kind: "done", final: "answer" } as TurnEvent;
      })(), "MARK "),
    );
    expect(evs[0]).toEqual({ kind: "done", final: "MARK answer" });
  });
});

// --- AsideLane -------------------------------------------------------------
describe("AsideLane — single-slot, out-of-band, not committed (gw-command-btw)", () => {
  function lane(events: TurnEvent[], sent: string[], readWindow = async () => win([])) {
    const runner = fakeRunner(events);
    const live = new LiveTurn();
    const l = new AsideLane({
      conn: fakeConn(sent),
      streamer: fakeStreamer(),
      runner,
      readWindow,
      windowSize: 30,
      identity: { name: "Cody", role: "dev" },
      live,
      currentModel: () => "opus",
      marker: "↩ btw — ",
    });
    return { l, runner };
  }

  it("answers on its own reply, marked, aligning the ephemeral model with current", async () => {
    const sent: string[] = [];
    const { l, runner } = lane([{ kind: "done", final: "looks good" }], sent);
    await l.ask("how's it going?", "c");
    expect(sent[0]).toBe("↩ btw — looks good");
    expect(runner.model).toBe("opus"); // aligned via currentModel
    expect(l.isBusy()).toBe(false);
  });

  it("is single-slot: a second /btw while one runs is refused, not stacked", async () => {
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { l } = lane([{ kind: "done", final: "ok" }], sent, async () => (await gate, win([])));
    const p1 = l.ask("q1", "c"); // parks on readWindow with busy=true
    await l.ask("q2", "c"); // sees busy
    expect(sent.some((s) => s.includes("one aside at a time"))).toBe(true);
    release();
    await p1;
    expect(l.isBusy()).toBe(false);
  });

  it("an auth failure surfaces the actionable notice, not silence (gw-auth-actionable)", async () => {
    const sent: string[] = [];
    const { l } = lane([{ kind: "error", err: new Error("401 Invalid authentication credentials") }], sent);
    await l.ask("anything", "c");
    expect(sent.join(" ")).toMatch(/authenticat/i);
    expect(l.isBusy()).toBe(false);
  });
});
