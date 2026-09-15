import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failureReason, isNotLoggedInError, notLoggedInNotice } from "./turnfailure";

describe("turnfailure — safe to import from a Temporal workflow", () => {
  it("imports NOTHING, which is the entire reason this file exists", () => {
    // A workflow is bundled into a sandbox with no Node built-ins. These helpers first lived in
    // `authflow.ts`, which imports `node:child_process` to drive the harness — and the workflow
    // importing it failed the webpack build with `Module not found: node:child_process`. The worker
    // then never started at all, which presents as a HANG rather than as a bad import.
    //
    // Asserted on the source rather than trusted, because the failure is far from the change and
    // the next person to add a helper here will reach for an import without thinking.
    const src = readFileSync(new URL("./turnfailure.ts", import.meta.url), "utf8");
    const imports = src.match(/^\s*import\s/gm) ?? [];
    expect(imports).toEqual([]);
  });
});

describe("isNotLoggedInError — the failure that retrying cannot fix", () => {
  it("recognises what the harness actually says", () => {
    // Observed verbatim from a worker with no credential.
    expect(isNotLoggedInError("Not logged in · Please run /login")).toBe(true);
    expect(isNotLoggedInError("OAuth token expired")).toBe(true);
    expect(isNotLoggedInError("invalid api key")).toBe(true);
  });

  // OBSERVED, not imagined. Everything above was written from a guess at what the harness says, and
  // the line the harness ACTUALLY produced when a subscription's refresh token had been rotated
  // away matched none of it - so the person got "I hit an error and couldn't finish that", the
  // generic message this whole function exists to replace. Copied from the worker log verbatim.
  it("matches what the harness really says when the subscription is gone", () => {
    expect(isNotLoggedInError("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(true);
  });

  it("does not swallow ordinary failures", () => {
    // Over-matching would hide a real bug behind "sign in again", and somebody would sign in
    // repeatedly while the actual fault went unreported.
    expect(isNotLoggedInError("ECONNREFUSED 127.0.0.1:443")).toBe(false);
    expect(isNotLoggedInError("rate limit exceeded")).toBe(false);
    expect(isNotLoggedInError("")).toBe(false);
  });

  it("names the one thing that fixes it, and does not say 'try again'", () => {
    const n = notLoggedInNotice();
    expect(n).toContain("!connect claude");
    expect(n.toLowerCase()).not.toContain("try again");
  });
});

describe("failureReason - the reason, not Temporal's wrapper", () => {
  // The shape that actually reached a person: ActivityFailure("Activity task failed") wrapping the
  // harness's own message. Read as `e.message` this printed the wrapper AND handed the wrapper to
  // isNotLoggedInError, so the agent said "I hit an error and couldn't finish that - Activity task
  // failed" for a plainly diagnosable expired subscription.
  const wrapped = Object.assign(new Error("Activity task failed"), {
    cause: new Error("Failed to authenticate: OAuth session expired and could not be refreshed"),
  });

  it("skips the wrapper and returns what the activity said", () => {
    expect(failureReason(wrapped)).toBe("Failed to authenticate: OAuth session expired and could not be refreshed");
  });

  it("is what makes the auth classification reachable at all", () => {
    expect(isNotLoggedInError("Activity task failed")).toBe(false); // the bug, stated
    expect(isNotLoggedInError(failureReason(wrapped))).toBe(true); // the fix
  });

  it("keeps a real message that arrives unwrapped", () => {
    expect(failureReason(new Error("second brain push rejected"))).toBe("second brain push rejected");
  });

  it("falls back to the wrapper rather than to nothing, when there is no cause", () => {
    // Worse is acceptable; blanker is not - an empty reason reads as the agent having no idea.
    expect(failureReason(new Error("Activity task failed"))).toBe("Activity task failed");
  });

  it("survives a cause cycle", () => {
    const a: { message: string; cause?: unknown } = { message: "Activity task failed" };
    a.cause = a;
    expect(failureReason(a)).toBe("Activity task failed");
  });
});
