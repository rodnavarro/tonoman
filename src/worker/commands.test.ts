import { describe, expect, it, vi } from "vitest";
import { parse, run, splitConnector, type CommandDeps } from "./commands";
import type { StatusMode } from "../statusline";

describe("parse", () => {
  it("accepts the ! prefix that actually reaches a Slack app", () => {
    expect(parse("!status")).toEqual({ name: "status", arg: "" });
    expect(parse("  !statusline full  ")).toEqual({ name: "statusline", arg: "full" });
  });

  it("accepts / too, so a registered slash command uses the same dispatch", () => {
    expect(parse("/model sonnet")).toEqual({ name: "model", arg: "sonnet" });
  });

  it("lower-cases the command but not the argument", () => {
    expect(parse("!MODEL Opus-4-8")).toEqual({ name: "model", arg: "Opus-4-8" });
  });

  it("leaves ordinary text alone", () => {
    expect(parse("what were we talking about?")).toBeUndefined();
    expect(parse("")).toBeUndefined();
    // A bare "!" or an emphatic sentence is not a command.
    expect(parse("!!!")).toBeUndefined();
    expect(parse("! status")).toBeUndefined();
  });
});

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  let mode: StatusMode = "small";
  return {
    getMode: () => mode,
    setMode: (_c, m) => {
      mode = m;
    },
    lastUsage: () => undefined,
    windows: async () => [{ key: "5h", usedPct: 9, resetAt: undefined }],
    getModel: () => "sonnet",
    setModel: () => {},
    ...over,
  };
}

describe("run", () => {
  it("returns null for a command it does not own, so the turn still happens", async () => {
    expect(await run(deps(), "nelly", "c", { name: "deploy", arg: "" })).toBeNull();
  });

  it("answers !status from account headroom even before any turn has run", async () => {
    const out = await run(deps(), "nelly", "c", { name: "status", arg: "" });
    expect(out).toContain("5h: 9% used");
    expect(out).toContain("no turn has run in this thread yet".replace("no", "No"));
  });

  it("includes per-turn numbers once a turn has run", async () => {
    const out = await run(
      deps({ lastUsage: () => ({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900, outputTokens: 50 }) }),
      "nelly",
      "c",
      { name: "status", arg: "" },
    );
    expect(out).toContain("Usage — this turn");
  });

  it("sets and reports the statusline mode", async () => {
    const d = deps();
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "" })).toContain("*small*");
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "full" })).toContain("*full*");
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "" })).toContain("*full*");
  });

  it("refuses an unknown mode rather than silently keeping the old one", async () => {
    const d = deps();
    expect(await run(d, "nelly", "c", { name: "statusline", arg: "loud" })).toContain("don't know");
    expect(d.getMode("c")).toBe("small");
  });

  it("reports the model and sets it for THIS conversation only", async () => {
    const setModel = vi.fn();
    const d = deps({ setModel });
    expect(await run(d, "nelly", "c", { name: "model", arg: "" })).toContain("*sonnet*");
    expect(await run(d, "nelly", "c", { name: "model", arg: "opus" })).toContain("next message");
    // The conversation is carried through, which is the whole point: one person changing the model
    // must not move it under everybody else the worker is serving.
    expect(setModel).toHaveBeenCalledWith("nelly", "c", "opus");
  });

  it("scopes the change to the conversation it was typed in", async () => {
    const setModel = vi.fn();
    const d = deps({ setModel });
    await run(d, "nelly", "celine-thread", { name: "model", arg: "opus" });
    expect(setModel).toHaveBeenCalledWith("nelly", "celine-thread", "opus");
    expect(setModel).not.toHaveBeenCalledWith("nelly", "rod-thread", "opus");
  });

  it("'default' clears the override rather than setting a model named default", async () => {
    const setModel = vi.fn();
    const d = deps({ setModel });
    expect(await run(d, "nelly", "c", { name: "model", arg: "default" })).toContain("default model");
    expect(setModel).toHaveBeenCalledWith("nelly", "c", undefined);
  });

  it("!new actually forgets the thread — it does not just describe forgetting", async () => {
    // It used to only print "I keep no memory across them", which was true when a thread had no
    // memory to keep. A thread now continues one harness session, so a `!new` that printed the
    // old text would be describing the behaviour of the release before it.
    const forgotten: string[][] = [];
    const out = await run(
      deps({ resetSession: (agent, conversation) => forgotten.push([agent, conversation]) }),
      "nelly",
      "c",
      { name: "new", arg: "" },
    );
    expect(forgotten).toEqual([["nelly", "c"]]);
    expect(out).toContain("Forgotten");
  });

  it("says how a fresh conversation is started when there is no session to forget", async () => {
    // A deployment with no session memory must not claim a reset it did not perform.
    const out = await run(deps(), "nelly", "c", { name: "new", arg: "" });
    expect(out).toContain("New chat");
    expect(out).not.toContain("Forgotten");
  });

  it("degrades to [] windows rather than failing when the runtime is unreachable", async () => {
    const d = deps({ windows: async () => { throw new Error("connect ECONNREFUSED"); } });
    const out = await run(d, "nelly", "c", { name: "status", arg: "" });
    expect(out).toContain("n/a");
  });
});

describe("connection commands name their connector", () => {
  it("splits the connector off the first word, leaving a pasted address intact", () => {
    // The callback address is one long token with its own `?` and `&`; splitting on anything but
    // the first space would tear it apart.
    const { which, rest } = splitConnector("plaud http://localhost:8199/auth/callback?code=abc&state=xyz");
    expect(which).toBe("plaud");
    expect(rest).toBe("http://localhost:8199/auth/callback?code=abc&state=xyz");
  });

  it("asks which one rather than assuming, even while there is only one", () => {
    // Calendars are next. A bare `!connect` that silently means Plaud today is a bare `!connect`
    // that means something else later, and every written instruction becomes wrong at that moment.
    expect(splitConnector("")).toEqual({ which: "", rest: "" });
  });

  it("takes a lone word as the connector with nothing after it", () => {
    expect(splitConnector("  PLAUD  ")).toEqual({ which: "plaud", rest: "" });
  });
});
