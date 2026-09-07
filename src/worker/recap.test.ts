import { describe, expect, it } from "vitest";
import { floorFor, joinChunks, overviewMarkdown, redact, stampFor, titleFor } from "./recap";

describe("stampFor", () => {
  it("is stable, sortable and unique per minute, so re-processing lands on the same path", () => {
    expect(stampFor(Date.UTC(2026, 8, 6, 18, 30))).toBe("2026-09-06-1830");
    expect(stampFor(Date.UTC(2026, 8, 6, 7, 5))).toBe("2026-09-06-0705");
  });
});

describe("titleFor", () => {
  it("drops the extension Plaud puts on a name", () => {
    expect(titleFor("Weekly sync.mp3")).toBe("Weekly sync");
  });
  it("names an untitled recording rather than leaving it blank", () => {
    expect(titleFor(undefined)).toBe("Untitled meeting");
    expect(titleFor("")).toBe("Untitled meeting");
  });
});

describe("joinChunks", () => {
  it("joins with a blank line and nothing else — the split is an upload artefact, not a section", () => {
    expect(joinChunks(["one.", "two."])).toBe("one.\n\ntwo.");
    expect(joinChunks(["one.", "two."])).not.toMatch(/part|chunk|\[/i);
  });
  it("drops empty chunks, which silence produces", () => {
    expect(joinChunks([" ", "said something", ""])).toBe("said something");
  });
  it("survives a recording that transcribed to nothing at all", () => {
    expect(joinChunks(["", "  "])).toBe("");
  });
});

describe("redact", () => {
  it("never lets a tokenised push URL reach a log", () => {
    const url = "https://x-access-token:ghp_secret@github.com/acme/brain";
    expect(redact(`fatal: could not read ${url}`, url)).not.toContain("ghp_secret");
    expect(redact("https://u:p@host/x", "other")).toBe("https://***:***@host/x");
  });
});

describe("overviewMarkdown", () => {
  const rec = { id: "1", title: "Valuation call", startTime: Date.UTC(2026, 8, 6, 18, 30), duration: 600000, stamp: "2026-09-06-1830" };
  it("links the transcript at the path publish() writes it to", () => {
    const md = overviewMarkdown(rec, { summary: "s", highlights: ["h"], decisions: [], followups: [] });
    expect(md).toContain("(./2026-09-06-1830/Transcript.md)");
  });
  it("says 'none recorded' rather than leaving an empty heading", () => {
    const md = overviewMarkdown(rec, { summary: "s", highlights: [], decisions: [], followups: [] });
    expect(md).toContain("_none recorded_");
  });
});

describe("floorFor", () => {
  // US Eastern in summer: four hours behind UTC.
  const EDT = -240;

  it("is the start of TODAY in the operator's timezone when nothing is set", () => {
    // 2026-09-07 01:00 UTC is still 2026-09-06 21:00 in New York.
    const now = Date.parse("2026-09-07T01:00:00Z");
    expect(new Date(floorFor(undefined, now, EDT)).toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("is midnight UTC when the pod has no timezone", () => {
    const now = Date.parse("2026-09-07T01:00:00Z");
    expect(new Date(floorFor(undefined, now, 0)).toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("takes an explicit date as local midnight, not UTC midnight", () => {
    expect(new Date(floorFor("2026-09-06", 0, EDT)).toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("accepts a full instant when one is given", () => {
    expect(floorFor("2026-09-06T18:30:00Z", 0, 0)).toBe(Date.parse("2026-09-06T18:30:00Z"));
  });

  it("falls back to today rather than to 1970 when the date is nonsense", () => {
    const now = Date.parse("2026-09-07T01:00:00Z");
    expect(floorFor("not-a-date", now, 0)).toBe(Date.parse("2026-09-07T00:00:00Z"));
  });
});
