import { describe, expect, it } from "vitest";
import { liveNote, settledNote, statusFor, tally } from "./worklog";
import type { MysticVerb } from "../core/mystic";

const MARINATE: MysticVerb = { ing: "Marinating", ed: "Marinated" };

describe("tally", () => {
  it("counts repeats and keeps first-use order", () => {
    expect(tally([{ tool: "Grep" }, { tool: "Read" }, { tool: "Grep" }, { tool: "Grep" }])).toEqual([
      { tool: "Grep", n: 3 },
      { tool: "Read", n: 1 },
    ]);
  });
});

describe("liveNote", () => {
  it("is the bot marker, the verb and the clock before any tool runs", () => {
    expect(liveNote([], 3_000, MARINATE)).toBe("🤖 Marinating… 3s");
  });

  it("omits the clock under a second — a count that starts at 0 reads as broken", () => {
    expect(liveNote([], 400, MARINATE)).toBe("🤖 Marinating…");
  });

  it("puts the tools above and the ticking verb line last", () => {
    const out = liveNote([{ tool: "Grep", detail: "valuation" }], 12_000, MARINATE);
    expect(out).toBe("🔧 `Grep` — valuation\n🤖 Marinating… 12s");
  });

  it("steps in 10s after a minute, so a long wait does not churn", () => {
    expect(liveNote([], 70_000, MARINATE)).toBe("🤖 Marinating… 1m10s");
    expect(liveNote([], 60_000, MARINATE)).toBe("🤖 Marinating… 1m");
  });

  it("keeps the last few steps and says how many it dropped", () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({ tool: `T${i}` }));
    const out = liveNote(calls, 10_000, MARINATE);
    expect(out).toContain("_…3 earlier steps_");
    expect(out).toContain("`T7`");
    expect(out).not.toContain("`T2`");
    expect(out.endsWith("🤖 Marinating… 10s")).toBe(true);
  });

  it("trims a long detail rather than wrapping the note", () => {
    const out = liveNote([{ tool: "Bash", detail: "x".repeat(300) }], 1_000, MARINATE);
    expect(out.length).toBeLessThan(150);
  });
});

describe("settledNote", () => {
  it("is null when nothing was used — no clutter above a plain answer", () => {
    expect(settledNote([], 2_000, MARINATE)).toBeNull();
  });

  it("reads in past tense with a whole duration, and drops the bot marker", () => {
    const out = settledNote([{ tool: "Grep" }, { tool: "Grep" }, { tool: "Read" }], 14_000, MARINATE);
    expect(out).toBe("Marinated for 14 seconds · Grep ×2, Read");
    expect(out).not.toContain("🤖");
  });

  it("says minutes for a long turn", () => {
    expect(settledNote([{ tool: "Bash" }], 130_000, MARINATE)).toBe("Marinated for 2 minutes · Bash");
  });

  it("never says 0 seconds", () => {
    expect(settledNote([{ tool: "Bash" }], 200, MARINATE)).toBe("Marinated for 1 second · Bash");
  });
});

describe("statusFor", () => {
  it("uses the turn's own verb before any tool has run", () => {
    expect(statusFor(undefined, MARINATE)).toBe("is marinating");
  });

  it("names the running tool once one starts", () => {
    expect(statusFor({ tool: "Bash" }, MARINATE)).toBe("is running bash");
  });

  it("never exceeds Slack's status limit", () => {
    expect(statusFor({ tool: "T".repeat(300) }, MARINATE).length).toBeLessThanOrEqual(100);
  });
});
