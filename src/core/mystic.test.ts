import { describe, expect, it } from "vitest";
import { MYSTIC_VERBS, activeLine, compactElapsed, randomMysticVerb, settledLine } from "./mystic";

const V = { ing: "Cogitating", ed: "Cogitated" };

describe("MYSTIC_VERBS", () => {
  it("stores both forms explicitly — no -ing/-ed rule survives 'Vibing'/'Vibed'", () => {
    expect(MYSTIC_VERBS.every((v) => v.ing && v.ed && v.ing !== v.ed)).toBe(true);
    expect(MYSTIC_VERBS).toContainEqual({ ing: "Moonwalking", ed: "Moonwalked" });
  });
  it("always picks a real verb", () => {
    for (let i = 0; i < 50; i++) expect(MYSTIC_VERBS).toContainEqual(randomMysticVerb());
  });
});

describe("compactElapsed", () => {
  it("is empty under a second, so a count never starts at 0", () => {
    expect(compactElapsed(0)).toBe("");
    expect(compactElapsed(999)).toBe("");
  });
  it("counts exact seconds in the first minute, so the cue is visibly moving", () => {
    expect(compactElapsed(5_000)).toBe("5s");
    expect(compactElapsed(47_000)).toBe("47s");
  });
  it("steps every 10s after a minute, so a long wait does not churn", () => {
    expect(compactElapsed(60_000)).toBe("1m");
    expect(compactElapsed(70_000)).toBe("1m10s");
    expect(compactElapsed(155_000)).toBe("2m30s"); // 2m35s floors to the 10s step
  });
});

describe("activeLine", () => {
  it("carries the bot marker while the turn is still running", () => {
    expect(activeLine(V, 5_000)).toBe("🤖 Cogitating… 5s");
    expect(activeLine(V, 100)).toBe("🤖 Cogitating…");
  });
});

describe("settledLine", () => {
  it("switches to past tense and DROPS the marker — that is what reads as finished", () => {
    expect(settledLine(V, 34_000)).toBe("Cogitated for 34 seconds");
    expect(settledLine(V, 34_000)).not.toContain("🤖");
  });
  it("never says zero, and gets the singular right", () => {
    expect(settledLine(V, 200)).toBe("Cogitated for 1 second");
  });
  it("rounds to whole minutes past a minute", () => {
    expect(settledLine(V, 130_000)).toBe("Cogitated for 2 minutes");
  });
});
