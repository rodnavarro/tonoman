// W5 — a credential that is REQUIRED and still degrades.
//
// A calendar was marked `optional`, and optional made it invisible: nothing asked a tenant for one,
// nothing told anybody a recap had been filed without being matched to a meeting, and the degraded
// output looked exactly like the good one. Marking it plainly required would have been worse — it
// would have stopped meetings being filed at all for every tenant that has not connected a calendar.
//
// `fallback` is the third strength: ask for it, name what is lost without it, run anyway. These
// tests exist so that a gate added later cannot know about `optional` and have never heard of
// `fallback` — which would quietly stop those tenants' meetings being filed, months from now, for a
// reason nobody would connect to this line.

import { describe, expect, it } from "vitest";
import { blocksRun, missingNote, type CredentialRequirement } from "./contract";
import { meetingRecap } from "./meeting-recap";
import { agendaBrief } from "./agenda-brief";
import { BUILTIN_TALENTS } from "./registry";

describe("blocksRun — only a bare required credential stops a run", () => {
  it("a plain requirement blocks: the Talent genuinely cannot work without it", () => {
    expect(blocksRun({ kind: "plaud" })).toBe(true);
  });

  it("optional does not block — nothing is lost worth mentioning", () => {
    expect(blocksRun({ kind: "calendar", optional: true })).toBe(false);
  });

  it("a fallback does not block either — something IS lost, and running anyway is still right", () => {
    expect(blocksRun({ kind: "calendar", providers: ["ics", "google"], fallback: "filed without matching" })).toBe(false);
  });

  it("a fallback is enough on its own: it does not have to also be marked optional", () => {
    // The trap. A gate written as `if (!req.optional) refuse` reads a required-with-fallback
    // credential as a hard stop, and every tenant without a calendar silently stops being served.
    const calendar: CredentialRequirement = { kind: "calendar", fallback: "filed without matching" };
    expect(calendar.optional).toBeUndefined();
    expect(blocksRun(calendar)).toBe(false);
  });
});

describe("missingNote — what a person is told about what they have not connected", () => {
  it("a fallback requirement says what happens without it, in words", () => {
    expect(missingNote(meetingRecap.requires.find((r) => r.kind === "calendar")!)).toBe(
      "Meetings are filed without calendar matching until a calendar is connected.",
    );
  });

  it("a truly optional credential is not news, and says nothing", () => {
    expect(missingNote({ kind: "calendar", optional: true })).toBe("");
  });

  it("a hard requirement has no fallback text, because there is no 'without it'", () => {
    expect(missingNote({ kind: "plaud" })).toBe("");
  });
});

describe("meeting-recap's calendar requirement", () => {
  const calendar = meetingRecap.requires.find((r) => r.kind === "calendar")!;

  it("is no longer optional — the Hub should ask for one", () => {
    expect(calendar.optional).toBeUndefined();
  });

  it("names the credential kinds that satisfy it, so one requirement covers both", () => {
    // An ICS feed and a Google connection are different rows in the registry and the same answer to
    // "does this agent have a calendar". Three separate requirements would have said that badly.
    expect(calendar.providers).toEqual(["ics", "google"]);
  });

  it("still lets a tenant with no calendar have their meetings filed", () => {
    expect(blocksRun(calendar)).toBe(false);
    expect(missingNote(calendar)).toContain("without calendar matching");
  });

  it("the hard requirements are still hard — this changed one credential, not the rule", () => {
    expect(blocksRun(meetingRecap.requires.find((r) => r.kind === "plaud")!)).toBe(true);
  });

  it("was versioned with the change, because the manifest is data the catalogue stores", () => {
    expect(meetingRecap.version).toBeGreaterThan(2);
  });
});

describe("the manifests the worker registers stay well-formed", () => {
  it("every requirement names a kind, and no requirement is both optional and degradable", () => {
    // Both at once is a contradiction with no meaning: `optional` says nothing is lost, `fallback`
    // says what is. A manifest that claims both would leave the Hub with nothing to render.
    for (const t of BUILTIN_TALENTS) {
      for (const r of t.requires) {
        expect(r.kind).toBeTruthy();
        expect(r.optional && r.fallback).toBeFalsy();
        if (r.providers) expect(r.providers.length).toBeGreaterThan(0);
      }
    }
  });

  it("the agenda brief's calendar is still a hard requirement — it has nothing to fall back to", () => {
    // A brief about a day with no calendar is not a degraded brief, it is a blank page.
    expect(blocksRun(agendaBrief.requires.find((r) => r.kind === "calendar")!)).toBe(true);
  });
});
