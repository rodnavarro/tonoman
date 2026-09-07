import { describe, expect, it, vi } from "vitest";
import { parse, run, type CommandDeps } from "./commands";
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

  it("reports the model, and sets it when the harness has a switch", async () => {
    const setModel = vi.fn();
    const d = deps({ setModel });
    expect(await run(d, "nelly", "c", { name: "model", arg: "" })).toContain("*sonnet*");
    expect(await run(d, "nelly", "c", { name: "model", arg: "opus" })).toContain("next message");
    expect(setModel).toHaveBeenCalledWith("nelly", "opus");
  });

  it("says so plainly when the harness has no model switch", async () => {
    const d = deps({ setModel: undefined });
    expect(await run(d, "nelly", "c", { name: "model", arg: "opus" })).toContain("no model switch");
  });

  it("answers !new with how a fresh conversation is actually started here", async () => {
    const out = await run(deps(), "nelly", "c", { name: "new", arg: "" });
    expect(out).toContain("New chat");
  });

  it("degrades to [] windows rather than failing when the runtime is unreachable", async () => {
    const d = deps({ windows: async () => { throw new Error("connect ECONNREFUSED"); } });
    const out = await run(d, "nelly", "c", { name: "status", arg: "" });
    expect(out).toContain("n/a");
  });
});
