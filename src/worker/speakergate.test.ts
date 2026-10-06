// AGENTACCOUNT-UNKNOWN-NO-TURN (agent-account.md in Tonoman Cloud): the deterministic check made
// before any inference.
import { describe, it, expect } from "vitest";
import { knowsSpeaker, noticeLimiter, unknownSpeakerNotice } from "./speakergate";

const PEOPLE = [
  { kind: "slack_user_id", value: "U0AAAAAAA1", label: "Priya Raman" },
  { kind: "email", value: "U0AAAAAAA2", label: "not a Slack id" },
];

describe("who the agent answers", () => {
  it("AGENTACCOUNT-UNKNOWN-NO-TURN a person registered with that Slack id is known; anyone else is not", () => {
    expect(knowsSpeaker(PEOPLE, "U0AAAAAAA1")).toBe(true);
    expect(knowsSpeaker(PEOPLE, "U0AAAAAAA9")).toBe(false);
    // Only a Slack id counts, never another kind of identifier that happens to match.
    expect(knowsSpeaker(PEOPLE, "U0AAAAAAA2")).toBe(false);
    // A registry that knows nobody yet: nobody is known.
    expect(knowsSpeaker([], "U0AAAAAAA1")).toBe(false);
  });

  it("AGENTACCOUNT-UNKNOWN-NO-TURN an agent with no registry answers everyone, as before", () => {
    expect(knowsSpeaker(undefined, "U0AAAAAAA9")).toBe(true);
  });

  it("AGENTACCOUNT-UNKNOWN-NO-TURN the notice is fixed words that say who can add them", () => {
    expect(unknownSpeakerNotice("Atlas")).toBe("I don't know who you are yet, so I can't help here. Ask an owner or admin of your team to allow you on Atlas in Tonoman Cloud.");
    // ACCOUNT-NO-EMAIL-NO-GUESS: the person is shown their own Slack id, which is what an admin allows.
    expect(unknownSpeakerNotice("Atlas", "U0AAAAAAA9")).toBe("I don't know who you are yet, so I can't help here. Ask an owner or admin of your team to allow you on Atlas in Tonoman Cloud — your Slack id is U0AAAAAAA9.");
  });

  it("AGENTACCOUNT-UNKNOWN-NO-TURN three messages in a row get one notice; it is said again after ten minutes", () => {
    let t = 0;
    const gate = noticeLimiter(10 * 60 * 1000, () => t);
    expect(gate.shouldSay("atlas", "D1", "U9")).toBe(true);
    t += 30_000;
    expect(gate.shouldSay("atlas", "D1", "U9")).toBe(false);
    expect(gate.shouldSay("atlas", "D1", "U9")).toBe(false);
    // Another person, another conversation, another agent: each its own.
    expect(gate.shouldSay("atlas", "D1", "U8")).toBe(true);
    expect(gate.shouldSay("atlas", "C2", "U9")).toBe(true);
    expect(gate.shouldSay("globex", "D1", "U9")).toBe(true);
    t += 10 * 60 * 1000;
    expect(gate.shouldSay("atlas", "D1", "U9")).toBe(true);
  });
});
