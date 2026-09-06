import { describe, it, expect } from "vitest";
import { redact, contextNote } from "./secondbrain";

describe("redact", () => {
  it("removes the token from output, because the one place a credential leaks is an error nobody expected to contain one", () => {
    const out = "fatal: could not read from https://x-access-token:ghp_SECRET123@github.com/acme/brain";
    const red = redact(out, "ghp_SECRET123");
    expect(red).not.toContain("ghp_SECRET123");
  });

  it("also strips any user:pass in a URL, whatever the token happened to be", () => {
    const red = redact("remote: https://someone:hunter2@example.com/x.git denied", "");
    expect(red).not.toContain("hunter2");
    expect(red).toContain("//***:***@");
  });

  it("leaves ordinary output alone", () => {
    expect(redact("fatal: repository not found", "tok")).toBe("fatal: repository not found");
  });
});

describe("contextNote", () => {
  it("is empty when nothing is granted, so no note is prepended to the turn", () => {
    expect(contextNote([])).toBe("");
  });

  it("names each source and its path, and says to say so when the answer is not there", () => {
    const note = contextNote([{ dir: "/root/.tonoman/secondbrain/a/1", label: "Murphy second brain" }]);
    expect(note).toContain("Murphy second brain: /root/.tonoman/secondbrain/a/1");
    expect(note.toLowerCase()).toContain("say so");
  });
});
