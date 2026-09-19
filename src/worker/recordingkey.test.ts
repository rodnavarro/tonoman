import { describe, expect, it } from "vitest";
import { isFinalLaunch, MAX_TALENT_LAUNCHES, recordingKey, talentGate } from "./recordingkey";

describe("recordingKey", () => {
  it("drops the of_ prefix Plaud added on 2026-09-15 and leaves the hex core alone", () => {
    expect(recordingKey("of_856a0b961219753745088ca861434e46")).toBe("856a0b961219753745088ca861434e46");
    expect(recordingKey("856a0b961219753745088ca861434e46")).toBe("856a0b961219753745088ca861434e46");
  });
  it("is idempotent and only strips a leading prefix", () => {
    expect(recordingKey(recordingKey("of_abc"))).toBe("abc");
    expect(recordingKey("xof_abc")).toBe("xof_abc");
  });
});

describe("talentGate", () => {
  it("announces only the first time an item is ever seen", () => {
    expect(talentGate(undefined)).toBe("first");
  });
  it("never re-runs a filed item", () => {
    expect(talentGate({ status: "done", attempts: 1 })).toBe("skip-done");
  });
  it("re-launches a failed item quietly while the budget lasts, then gives up", () => {
    expect(talentGate({ status: "failed", attempts: 1 })).toBe("again");
    expect(talentGate({ status: "failed", attempts: MAX_TALENT_LAUNCHES - 1 })).toBe("again");
    expect(talentGate({ status: "failed", attempts: MAX_TALENT_LAUNCHES })).toBe("skip-given-up");
    expect(talentGate({ status: "failed", attempts: 14 })).toBe("skip-given-up");
  });
  it("does not trust `running` as in-flight — the workflow id dedups that", () => {
    expect(talentGate({ status: "running", attempts: 1 })).toBe("again");
  });
  it("force re-runs a done item, and still announces a brand-new one", () => {
    expect(talentGate({ status: "done", attempts: 1 }, true)).toBe("again");
    expect(talentGate(undefined, true)).toBe("first");
  });
});

describe("isFinalLaunch", () => {
  it("is true only for the launch that spends the last of the budget", () => {
    expect(isFinalLaunch(undefined)).toBe(MAX_TALENT_LAUNCHES <= 1);
    expect(isFinalLaunch({ status: "failed", attempts: MAX_TALENT_LAUNCHES - 2 })).toBe(false);
    expect(isFinalLaunch({ status: "failed", attempts: MAX_TALENT_LAUNCHES - 1 })).toBe(true);
  });
});
