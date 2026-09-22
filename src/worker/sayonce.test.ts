// Saying a thing once, when the thing that says it retries.
//
// The poll runs on a two-minute schedule, which is right: a credential can come back at any time
// and the flow should notice without anybody restarting it. But the notice it raises when the
// credential is dead is one FACT, actionable once — and repeating it every two minutes is thirty
// notifications an hour for a message the person read the first time. A warning that has to be
// muted has stopped being a warning.
import { describe, expect, it, vi } from "vitest";
import { makeActivities } from "./activities";

const deps = (said: string[]) =>
  ({
    say: async (_a: string, _u: string, text: string) => void said.push(text),
  }) as never;

describe("sayVerbatim — a notice raised by something that retries", () => {
  it("says an identical notice once per window, not once per tick", async () => {
    const said: string[] = [];
    const a = makeActivities(deps(said));
    const notice = { agent: "sapien-once-a", user: "U1", text: "the credential expired", onceMinutes: 60 };
    for (let i = 0; i < 30; i++) await a.sayVerbatim(notice);
    expect(said).toEqual(["the credential expired"]);
  });

  it("still says a DIFFERENT reason, because going quiet is the other failure", async () => {
    // The suppression is per message, not "the poll has already complained". A dead credential and
    // an unreachable API are different things to do about it.
    const said: string[] = [];
    const a = makeActivities(deps(said));
    await a.sayVerbatim({ agent: "sapien-once-b", user: "U1", text: "the credential expired", onceMinutes: 60 });
    await a.sayVerbatim({ agent: "sapien-once-b", user: "U1", text: "plaud is unreachable", onceMinutes: 60 });
    expect(said).toHaveLength(2);
  });

  it("keeps one agent's silence from silencing another's", async () => {
    const said: string[] = [];
    const a = makeActivities(deps(said));
    await a.sayVerbatim({ agent: "sapien-once-c", user: "U1", text: "the credential expired", onceMinutes: 60 });
    await a.sayVerbatim({ agent: "nelly-once-c", user: "U2", text: "the credential expired", onceMinutes: 60 });
    expect(said).toHaveLength(2);
  });

  it("says it again once the window has passed", async () => {
    vi.useFakeTimers();
    try {
      const said: string[] = [];
      const a = makeActivities(deps(said));
      const notice = { agent: "sapien-once-d", user: "U1", text: "the credential expired", onceMinutes: 60 };
      await a.sayVerbatim(notice);
      vi.advanceTimersByTime(59 * 60_000);
      await a.sayVerbatim(notice);
      expect(said).toHaveLength(1);
      vi.advanceTimersByTime(2 * 60_000);
      await a.sayVerbatim(notice);
      expect(said).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not suppress anything when no window is asked for", async () => {
    // Every other caller of this activity is announcing a recap, and a recap must never be dropped
    // for looking like the last one.
    const said: string[] = [];
    const a = makeActivities(deps(said));
    for (let i = 0; i < 3; i++) await a.sayVerbatim({ agent: "sapien-once-e", user: "U1", text: "I've got a new recording" });
    expect(said).toHaveLength(3);
  });
});
