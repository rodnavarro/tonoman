import { describe, expect, it } from "vitest";
import { fmtElapsed, liveNote, settledNote, statusFor, tally } from "./worklog";

describe("fmtElapsed", () => {
  it("reads in seconds under a minute", () => {
    expect(fmtElapsed(0)).toBe("0s");
    expect(fmtElapsed(4_200)).toBe("4s");
    expect(fmtElapsed(59_999)).toBe("59s");
  });

  it("pads the seconds once minutes appear, so the number does not jump width", () => {
    expect(fmtElapsed(64_000)).toBe("1m 04s");
    expect(fmtElapsed(190_000)).toBe("3m 10s");
  });

  it("never renders a negative elapsed", () => {
    expect(fmtElapsed(-5_000)).toBe("0s");
  });
});

describe("tally", () => {
  it("counts repeats and keeps first-use order", () => {
    expect(
      tally([{ tool: "Grep" }, { tool: "Read" }, { tool: "Grep" }, { tool: "Grep" }]),
    ).toEqual([
      { tool: "Grep", n: 3 },
      { tool: "Read", n: 1 },
    ]);
  });
});

describe("liveNote", () => {
  it("is just the clock before any tool runs", () => {
    expect(liveNote([], 3_000)).toBe("⚙️ *Working…* 3s");
  });

  it("shows the detail when the harness gave one", () => {
    expect(liveNote([{ tool: "Grep", detail: "valuation" }], 1_000)).toContain("`Grep` — valuation");
  });

  it("keeps the last few steps and says how many it dropped", () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({ tool: `T${i}` }));
    const out = liveNote(calls, 10_000);
    expect(out).toContain("_…3 earlier steps_");
    expect(out).toContain("`T7`");
    expect(out).not.toContain("`T2`");
  });

  it("trims a long detail rather than wrapping the note", () => {
    const out = liveNote([{ tool: "Bash", detail: "x".repeat(300) }], 1_000);
    expect(out.length).toBeLessThan(140);
  });
});

describe("settledNote", () => {
  it("is null when nothing was used — no clutter above a plain answer", () => {
    expect(settledNote([], 2_000)).toBeNull();
  });

  it("summarises the tools with counts", () => {
    expect(settledNote([{ tool: "Grep" }, { tool: "Grep" }, { tool: "Read" }], 12_000)).toBe(
      "⚙️ Worked for 12s · Grep ×2, Read",
    );
  });
});

describe("statusFor", () => {
  it("names the running tool and the clock", () => {
    expect(statusFor({ tool: "Bash" }, 5_000)).toBe("is running bash · 5s");
  });

  it("falls back to thinking before any tool", () => {
    expect(statusFor(undefined, 1_000)).toBe("is thinking · 1s");
  });

  it("never exceeds Slack's status limit", () => {
    expect(statusFor({ tool: "T".repeat(300) }, 1_000).length).toBeLessThanOrEqual(100);
  });
});
