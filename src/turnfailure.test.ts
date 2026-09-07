import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNotLoggedInError, notLoggedInNotice } from "./turnfailure";

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
