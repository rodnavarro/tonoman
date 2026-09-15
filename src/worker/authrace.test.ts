import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../core/contracts";
import { isAuthRaceError, withAuthRaceRetry } from "./authrace";

const RACE =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute";

async function* events(...evs: TurnEvent[]): AsyncGenerator<TurnEvent> {
  for (const e of evs) yield e;
}
async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const noSleep = { sleep: async () => {}, log: () => {} };

describe("isAuthRaceError", () => {
  it("recognises the CLI's wording, quoted from the log", () => {
    expect(isAuthRaceError(RACE)).toBe(true);
    expect(isAuthRaceError("claudecode: exit 1: Failed to refresh OAuth token: another Claude Code process is refreshing it")).toBe(true);
  });
  it("is NOT an expired login, which has its own answer", () => {
    expect(isAuthRaceError("OAuth token has expired and could not be refreshed")).toBe(false);
    expect(isAuthRaceError("not logged in")).toBe(false);
    expect(isAuthRaceError("")).toBe(false);
  });
});

describe("withAuthRaceRetry", () => {
  it("retries the same turn when the race is the first thing that happens", async () => {
    let starts = 0;
    const start = (): AsyncIterable<TurnEvent> => {
      starts++;
      return starts < 3
        ? events({ kind: "error", err: new Error(RACE) })
        : events({ kind: "text", text: "hi" }, { kind: "done", final: "hi" });
    };
    const got = await collect(withAuthRaceRetry(start, noSleep));
    expect(starts).toBe(3);
    expect(got.map((e) => e.kind)).toEqual(["text", "done"]);
  });

  it("gives up after the delays are spent and surfaces the error", async () => {
    let starts = 0;
    const start = (): AsyncIterable<TurnEvent> => (starts++, events({ kind: "error", err: new Error(RACE) }));
    const got = await collect(withAuthRaceRetry(start, { ...noSleep, delaysMs: [1, 1] }));
    expect(starts).toBe(3);
    expect(got).toHaveLength(1);
    expect(got[0]!.kind).toBe("error");
  });

  it("never retries once output has been streamed — that would say it twice", async () => {
    let starts = 0;
    const start = (): AsyncIterable<TurnEvent> => (starts++, events({ kind: "text", text: "partial" }, { kind: "error", err: new Error(RACE) }));
    const got = await collect(withAuthRaceRetry(start, noSleep));
    expect(starts).toBe(1);
    expect(got.map((e) => e.kind)).toEqual(["text", "error"]);
  });

  it("passes every other error through on the first try", async () => {
    let starts = 0;
    const start = (): AsyncIterable<TurnEvent> => (starts++, events({ kind: "error", err: new Error("not logged in") }));
    const got = await collect(withAuthRaceRetry(start, noSleep));
    expect(starts).toBe(1);
    expect(got[0]!.kind).toBe("error");
  });

  it("waits the configured delays, in order", async () => {
    const waited: number[] = [];
    let starts = 0;
    const start = (): AsyncIterable<TurnEvent> => {
      starts++;
      return starts < 4 ? events({ kind: "error", err: new Error(RACE) }) : events({ kind: "done", final: "" });
    };
    await collect(withAuthRaceRetry(start, { delaysMs: [3, 8, 15], sleep: async (ms) => void waited.push(ms), log: () => {} }));
    expect(waited).toEqual([3, 8, 15]);
  });
});
