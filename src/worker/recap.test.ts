import { describe, expect, it } from "vitest";
import { alignmentSection, budgetTranscript, calendarSection, floorFor, isTimestampTitle, joinChunks, overviewMarkdown, parseRecapJson, pathsFor, redact, resolveMeeting, slugFor, resolveAlignment, stampFor, titleFor, transcribedBy } from "./recap";

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

  it("does NOT shift a full instant by the timezone — it already carries its own", () => {
    // Shifting it moved a floor of 01:35Z four hours into the FUTURE, which stops the poll
    // outright instead of bounding it.
    expect(floorFor("2026-09-07T01:35:00Z", 0, EDT)).toBe(Date.parse("2026-09-07T01:35:00Z"));
  });

  it("falls back to today rather than to 1970 when the date is nonsense", () => {
    const now = Date.parse("2026-09-07T01:00:00Z");
    expect(floorFor("not-a-date", now, 0)).toBe(Date.parse("2026-09-07T00:00:00Z"));
  });
});

describe("naming a recording", () => {
  it("refuses a slug when Plaud only gave it a timestamp", () => {
    // This produced `2026-09-07-0310-2026-09-06-23-10-46.md`: the date twice, in two formats.
    expect(isTimestampTitle("2026-09-06 23:10:46")).toBe(true);
    expect(isTimestampTitle("2026-09-06T23:10")).toBe(true);
    expect(slugFor("2026-09-06 23:10:46")).toBe("");
  });

  it("keeps a real title, including one that merely starts with a date", () => {
    expect(isTimestampTitle("08-28 Interview Panel")).toBe(false);
    expect(slugFor("Jobs and Gates Reflect")).toBe("jobs-and-gates-reflect");
  });

  it("falls back to what the meeting was about when the title is a clock", () => {
    const rec = { id: "1", title: "2026-09-06 23:10:46", startTime: Date.UTC(2026, 8, 7, 3, 10), duration: 60000, stamp: "2026-09-07-0310" };
    const j = { path: "MJ", fallback: "unclassified", routes: [{ id: "axiplex", when: "..." }] };
    const p = pathsFor(j, rec, "axiplex", "Reviewed the Tonoman Cloud demo plan");
    expect(p.page).toBe("MJ/axiplex/2026-09-07-0310-reviewed-the-tonoman-cloud-demo-plan.md");
  });

  it("uses the bare stamp when there is nothing to name it after at all", () => {
    const rec = { id: "1", title: "2026-09-06 23:10:46", startTime: 0, duration: 0, stamp: "2026-09-07-0310" };
    const j = { path: "MJ", fallback: "unclassified", routes: [] };
    expect(pathsFor(j, rec, "unclassified", "").page).toBe("MJ/unclassified/2026-09-07-0310.md");
  });
});


// --- The calendar match -------------------------------------------------------------------------

const ev = (summary: string, from: string, to: string, attendees: string[] = []) => ({
  summary,
  start: Date.parse(from),
  end: Date.parse(to),
  attendees,
  attendeeEmails: [],
  uid: "",
  location: "",
  source: { kind: "ics", alias: "foley" },
});

const CANDIDATES = [
  ev("API Team Standup", "2026-09-07T14:00:00Z", "2026-09-07T14:30:00Z", ["Rod Navarro"]),
  ev("Entity Sync Touch Base", "2026-09-07T14:15:00Z", "2026-09-07T15:00:00Z"),
];

describe("resolveMeeting — a closed set, because a wrong name looks right", () => {
  it("accepts a name the model was actually shown", () => {
    expect(resolveMeeting(CANDIDATES, "API Team Standup")?.summary).toBe("API Team Standup");
  });

  it("is tolerant of case and surrounding whitespace", () => {
    expect(resolveMeeting(CANDIDATES, "  api team standup ")?.summary).toBe("API Team Standup");
  });

  it("REFUSES a plausible name that was not among the candidates", () => {
    // The failure this exists to stop. Unlike a wrong route — which lands in a folder somebody
    // reviews — a hallucinated meeting name puts a confident, wrong title on the page and files
    // the recording into a series it does not belong to. It looks entirely correct.
    expect(resolveMeeting(CANDIDATES, "API Team Sync")).toBeUndefined();
    expect(resolveMeeting(CANDIDATES, "Weekly Standup")).toBeUndefined();
  });

  it("treats no answer as no match, which is the common case", () => {
    // Most recordings are not on anybody's calendar.
    expect(resolveMeeting(CANDIDATES, "")).toBeUndefined();
    expect(resolveMeeting(CANDIDATES, undefined)).toBeUndefined();
    expect(resolveMeeting([], "API Team Standup")).toBeUndefined();
  });
});

describe("calendarSection — what it chose between, not just what it chose", () => {
  const recap = {
    summary: "s",
    highlights: [],
    decisions: [],
    followups: [],
    meeting: "API Team Standup",
    meetingReason: "the transcript opens with the standup round-robin",
  };

  it("marks the winner and still lists the ones it passed over", () => {
    // "Why is this filed under the wrong meeting" is unanswerable from a page that shows only the
    // winner, and a bad calendar match fails quietly — plausible title, deliberate-looking folder.
    const md = calendarSection(recap, CANDIDATES);
    expect(md).toContain("**→**");
    expect(md).toContain("API Team Standup");
    expect(md).toContain("Entity Sync Touch Base");
    expect(md).toContain("the transcript opens with the standup round-robin");
  });

  it("says plainly that nothing matched rather than looking broken", () => {
    const md = calendarSection({ ...recap, meeting: "", meetingReason: "" }, CANDIDATES);
    expect(md).toContain("No calendar entry matched");
  });

  it("names which calendar each candidate came from", () => {
    expect(calendarSection(recap, CANDIDATES)).toContain("ics/foley");
  });

  it("is empty when no calendar is connected, so the page is what it is today", () => {
    expect(calendarSection(recap, [])).toBe("");
  });
});

describe("overviewMarkdown with a calendar", () => {
  const rec = {
    id: "r1",
    title: "API Team Standup",
    startTime: Date.parse("2026-09-07T14:00:00Z"),
    duration: 1_800_000,
    stamp: "2026-09-07-1400",
  };
  const recap = {
    summary: "s",
    highlights: [],
    decisions: [],
    followups: [],
    meeting: "API Team Standup",
  };

  it("puts the meeting in frontmatter, so a series is queryable from the vault", () => {
    // "Every API Team Standup" is the question a knowledge base exists to answer, and it cannot be
    // asked of prose.
    expect(overviewMarkdown(rec, recap, undefined, CANDIDATES)).toContain('meeting: "API Team Standup"');
  });

  it("omits the meeting and the section entirely when there is no calendar", () => {
    const md = overviewMarkdown(rec, { summary: "s", highlights: [], decisions: [], followups: [] });
    expect(md).not.toContain("meeting:");
    expect(md).not.toContain("## Calendar");
  });
});

describe("pathsFor — a matched meeting names the file", () => {
  it("uses the meeting name when Plaud only gave a timestamp", () => {
    // The whole parity win, and it reuses the hint that already existed for exactly this: Plaud
    // names an untitled recording after its own clock, which helps nobody find it later.
    const rec = { id: "1", title: "2026-09-06 23:10:46", startTime: 0, duration: 0, stamp: "2026-09-07-0310" };
    const j = { path: "MJ", fallback: "unclassified", routes: [] };
    expect(pathsFor(j, rec, "foley", "API Team Standup").page).toBe(
      "MJ/foley/2026-09-07-0310-api-team-standup.md",
    );
  });
});

describe("transcribedBy — the page must not claim a provider that did not serve", () => {
  it("names the provider that actually transcribed", () => {
    expect(transcribedBy(["groq"])).toBe("groq");
  });

  it("names BOTH when a recording fell through mid-way", () => {
    // A meeting whose first chunks went to a local server and whose rest went to Groq was
    // transcribed by two different models. Saying only the first is the more comfortable lie.
    expect(transcribedBy(["local-whisper", "groq"])).toBe("local-whisper + groq");
  });

  it("says 'not recorded' rather than guessing, when every chunk came from the cache", () => {
    expect(transcribedBy([])).toMatch(/not recorded/);
  });

  it("puts whatever it says onto the page, instead of a hardcoded name", () => {
    const rec = { id: "r1", title: "Standup", stamp: "2026-09-08-1422", startTime: Date.UTC(2026, 8, 8, 14, 22), duration: 329_000 };
    const page = overviewMarkdown(rec, { summary: "s", highlights: [], decisions: [], followups: [] }, undefined, [], ["local-whisper"]);
    expect(page).toContain("**Transcribed by:** local-whisper");
    expect(page).not.toContain("whisper-large-v3-turbo");
  });
});

describe("budgetTranscript — keep the END, where the decisions are", () => {
  it("leaves a normal meeting completely untouched", () => {
    // A three-hour meeting is ~120k characters, so in practice nothing is ever cut.
    const t = "x".repeat(1000);
    expect(budgetTranscript(t)).toBe(t);
  });

  it("keeps BOTH ends when it must cut, because head-only truncation lost the follow-ups", () => {
    const t = "START" + "x".repeat(5000) + "END";
    const out = budgetTranscript(t, 100);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
  });

  it("says out loud that the middle is gone, so nobody reads it as a complete transcript", () => {
    expect(budgetTranscript("x".repeat(5000), 100)).toMatch(/omitted/);
  });
});

describe("parseRecapJson — a fenced answer must not discard a paid-for transcription", () => {
  const recap = { summary: "s", highlights: [], decisions: [], followups: [] };

  it("reads plain JSON", () => {
    expect(parseRecapJson(JSON.stringify(recap)).summary).toBe("s");
  });

  it("reads JSON a gateway wrapped in a code fence", () => {
    // `response_format: json_object` is an OpenAI feature a gateway may honour, emulate, or drop.
    expect(parseRecapJson("```json\n" + JSON.stringify(recap) + "\n```").summary).toBe("s");
  });

  it("reads JSON with a sentence in front of it", () => {
    expect(parseRecapJson("Here you go: " + JSON.stringify(recap)).summary).toBe("s");
  });

  it("still fails loudly when there is no JSON at all", () => {
    expect(() => parseRecapJson("I could not summarise this.")).toThrow(/did not return JSON/);
  });
});

describe("resolveAlignment — a verdict nobody reached must not appear as one", () => {
  it.each(["advances", "neutral", "detracts"])("accepts %s", (v) => {
    expect(resolveAlignment(v)).toBe(v);
  });

  it("is forgiving about case and whitespace, which is all a model varies", () => {
    expect(resolveAlignment("  Detracts ")).toBe("detracts");
  });

  it("maps anything unrecognised to NOTHING — never to neutral", () => {
    // This is the whole point. Coercing to "neutral" would render a judgement nobody made, in the
    // same typeface as one somebody did, and it would be indistinguishable forever after.
    expect(resolveAlignment("somewhat aligned")).toBe("");
    expect(resolveAlignment("positive")).toBe("");
    expect(resolveAlignment(undefined)).toBe("");
    expect(resolveAlignment("")).toBe("");
  });
});

describe("alignmentSection — the page says it, or says nothing", () => {
  const base = { summary: "s", highlights: [], decisions: [], followups: [] };

  it("is omitted entirely when there is no verdict", () => {
    // An "unknown" heading on every page trains the reader to skip the section.
    expect(alignmentSection(base)).toBe("");
  });

  it("says plainly that a meeting COST attention", () => {
    const out = alignmentSection({ ...base, alignment: "detracts", alignmentReason: "No decision was reached." });
    expect(out).toContain("## Alignment");
    expect(out).toContain("Cost attention");
    expect(out).toContain("No decision was reached.");
  });

  it("renders a verdict without a reason rather than dropping it", () => {
    expect(alignmentSection({ ...base, alignment: "advances" })).toContain("Advances the mission");
  });

  it("puts the verdict in frontmatter, so the vault can be asked which meetings detracted", () => {
    const rec = { id: "r1", title: "Standup", stamp: "2026-09-08-1422", startTime: Date.UTC(2026, 8, 8, 14, 22), duration: 329_000 };
    const page = overviewMarkdown(rec, { ...base, alignment: "detracts", alignmentReason: "Nothing was decided." }, undefined, [], ["groq"]);
    expect(page).toContain("alignment: detracts");
    expect(page).toContain("alignment_reason: ");
  });
});
