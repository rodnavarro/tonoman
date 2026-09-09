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

describe("contextNote — whose accounts are whose, and what time it is", () => {
  const ready = [{ dir: "/brain/wiki-p", label: "Rod wiki-p" }];

  it("lists the tenant's connections, so the agent answers about THEIRS", () => {
    // Asked about calendars with none of this, the agent answered from its own tool inventory and
    // told Rod to authorize a claude.ai connector — nothing to do with the three Google calendars
    // the tenant actually had.
    const note = contextNote(ready, "America/New_York", [
      { kind: "google", alias: "work", label: null, status: "connected" },
      { kind: "ics", alias: "foley", label: "Foley Outlook ICS", status: "pending" },
    ]);
    expect(note).toContain("google/work");
    expect(note).toContain("ics/foley (Foley Outlook ICS)");
  });

  it("marks a connection that is NOT usable, rather than listing it as if it worked", () => {
    const note = contextNote(ready, "", [{ kind: "ics", alias: "foley", status: "pending" }]);
    expect(note).toMatch(/ics\/foley.*pending, not usable yet/);
  });

  it("says plainly when nothing is connected", () => {
    expect(contextNote(ready, "", [])).toMatch(/no outside accounts connected/);
  });

  it("names the timezone and which field carries local time", () => {
    const note = contextNote(ready, "America/New_York");
    expect(note).toContain("America/New_York");
    expect(note).toContain("local_time");
  });

  it("says nothing about a clock when the tenant is on UTC", () => {
    // Nothing to disambiguate, and an instruction with no purpose is context spent for nothing.
    expect(contextNote(ready, "UTC")).not.toContain("ALWAYS answer in their local time");
  });

  it("is still empty when there is no second brain at all", () => {
    expect(contextNote([], "America/New_York", [{ kind: "google", alias: "work" }])).toBe("");
  });
});
