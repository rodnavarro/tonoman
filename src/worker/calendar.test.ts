import { describe, expect, it } from "vitest";
import {
  candidatesFor,
  describe as describeEvent,
  eventsBetween,
  excluded,
  isCancelled,
  overlaps,
  windowFor,
} from "./calendar";

const SRC = { kind: "ics", alias: "foley" };
const ms = (iso: string): number => Date.parse(iso);

/** An ICS document, assembled so each test says only what it is about. */
function ics(...vevents: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...vevents,
    "END:VCALENDAR",
  ].join("\r\n");
}

function vevent(props: Record<string, string>): string {
  return ["BEGIN:VEVENT", ...Object.entries(props).map(([k, v]) => `${k}:${v}`), "END:VEVENT"].join("\r\n");
}

describe("windowFor — generous on purpose", () => {
  it("pads both sides, because people start recording late and stop early", () => {
    const w = windowFor(ms("2026-09-07T14:00:00Z"), ms("2026-09-07T14:30:00Z"), 30);
    expect(w.from).toBe(ms("2026-09-07T13:30:00Z"));
    expect(w.to).toBe(ms("2026-09-07T15:00:00Z"));
  });

  it("survives a zero or backwards duration rather than matching nothing", () => {
    // Plaud has reported a zero duration for a recording still being written. A window that ends
    // before it begins overlaps nothing at all, and the failure looks like "no calendar entry".
    const w = windowFor(ms("2026-09-07T14:00:00Z"), 0, 30);
    expect(w.to).toBeGreaterThan(w.from);
  });
});

describe("overlaps — half-open, so a meeting that just ended is not a candidate", () => {
  const from = ms("2026-09-07T14:00:00Z");
  const to = ms("2026-09-07T15:00:00Z");

  it("counts an event that straddles the window", () => {
    expect(overlaps({ start: ms("2026-09-07T13:00:00Z"), end: ms("2026-09-07T16:00:00Z") }, from, to)).toBe(true);
  });

  it("excludes one that ends exactly as the window opens", () => {
    expect(overlaps({ start: ms("2026-09-07T13:00:00Z"), end: from }, from, to)).toBe(false);
  });

  it("excludes one that starts exactly as the window closes", () => {
    expect(overlaps({ start: to, end: ms("2026-09-07T16:00:00Z") }, from, to)).toBe(false);
  });
});

describe("isCancelled — two ways a feed says it, and both are seen", () => {
  it("reads STATUS", () => {
    expect(isCancelled("Standup", "CANCELLED")).toBe(true);
  });

  it("reads Outlook's subject prefix, with either spelling", () => {
    // Feeds that publish no STATUS still rename the subject. Missing this files a recap under a
    // meeting that did not happen.
    expect(isCancelled("Canceled: API Standup", undefined)).toBe(true);
    expect(isCancelled("Cancelled: API Standup", undefined)).toBe(true);
  });

  it("does not fire on a meeting that merely discusses cancellations", () => {
    expect(isCancelled("Cancellation policy review", undefined)).toBe(false);
  });
});

describe("excluded — substrings a person typed, not a regex", () => {
  it("matches case-insensitively", () => {
    expect(excluded("Focus Time", ["focus time"])).toBe(true);
    expect(excluded("Lunch break", ["lunch"])).toBe(true);
  });

  it("ignores blank patterns rather than excluding everything", () => {
    // A trailing comma in a settings row produces an empty pattern. Treating "" as a substring
    // match would silently exclude every event and leave no calendar matching at all.
    expect(excluded("API Standup", ["", "   "])).toBe(false);
  });

  it("never throws on what would be an invalid regex", () => {
    expect(excluded("Budget (Q3", ["(unclosed"])).toBe(false);
  });
});

describe("eventsBetween — a single event", () => {
  it("resolves a zoned event to the right instant", () => {
    // 10:00 New York on a summer date is 14:00Z. The whole point of working in instants: nothing
    // here has to be told what timezone the tenant is in.
    const doc = ics(
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "TZNAME:EDT",
      "DTSTART:19700308T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "TZNAME:EST",
      "DTSTART:19701101T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
      vevent({
        UID: "a@x",
        SUMMARY: "API Standup",
        "DTSTART;TZID=America/New_York": "20260907T100000",
        "DTEND;TZID=America/New_York": "20260907T103000",
      }),
    );
    const out = eventsBetween(doc, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(ms("2026-09-07T14:00:00Z"));
    expect(out[0]!.end).toBe(ms("2026-09-07T14:30:00Z"));
  });

  it("skips all-day entries", () => {
    // Holidays and out-of-office markers. Nobody records one, and keeping them means every
    // recording on a public holiday matches "Labor Day".
    const doc = ics(vevent({ UID: "b@x", SUMMARY: "Labor Day", "DTSTART;VALUE=DATE": "20260907" }));
    expect(eventsBetween(doc, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC)).toHaveLength(0);
  });

  it("skips a cancelled occurrence", () => {
    const doc = ics(
      vevent({
        UID: "c@x",
        SUMMARY: "Standup",
        STATUS: "CANCELLED",
        DTSTART: "20260907T140000Z",
        DTEND: "20260907T143000Z",
      }),
    );
    expect(eventsBetween(doc, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC)).toHaveLength(0);
  });

  it("gives an event with no DTEND a length rather than treating it as an instant", () => {
    // Legal, if rare. A zero-length event overlaps nothing and would silently vanish.
    const doc = ics(vevent({ UID: "d@x", SUMMARY: "Ad hoc", DTSTART: "20260907T140000Z" }));
    const out = eventsBetween(doc, ms("2026-09-07T13:00:00Z"), ms("2026-09-07T15:00:00Z"), SRC);
    expect(out).toHaveLength(1);
    expect(out[0]!.end).toBeGreaterThan(out[0]!.start);
  });

  it("carries attendee names and addresses, and dedupes them", () => {
    const doc = ics(
      vevent({
        UID: "e@x",
        SUMMARY: "Sync",
        DTSTART: "20260907T140000Z",
        DTEND: "20260907T150000Z",
        "ATTENDEE;CN=Rod Navarro": "mailto:rod@rodnavarro.com",
        "ATTENDEE;CN=Celine Dufresne": "mailto:celine@murphy.example",
      }),
    );
    const [e] = eventsBetween(doc, ms("2026-09-07T13:00:00Z"), ms("2026-09-07T16:00:00Z"), SRC);
    expect(e!.attendees).toEqual(["Rod Navarro", "Celine Dufresne"]);
    expect(e!.attendeeEmails).toEqual(["rod@rodnavarro.com", "celine@murphy.example"]);
  });

  it("reports no attendees for a feed that strips them, without failing", () => {
    // This is the published Foley ICS. Empty means UNKNOWN here, not "nobody was invited".
    const doc = ics(
      vevent({ UID: "f@x", SUMMARY: "API Standup", DTSTART: "20260907T140000Z", DTEND: "20260907T150000Z" }),
    );
    const [e] = eventsBetween(doc, ms("2026-09-07T13:00:00Z"), ms("2026-09-07T16:00:00Z"), SRC);
    expect(e!.attendeeEmails).toEqual([]);
    expect(e!.summary).toBe("API Standup");
  });
});

describe("eventsBetween — recurrence, which is the whole difficulty", () => {
  const weekly = ics(
    vevent({
      UID: "w@x",
      SUMMARY: "API Team Standup",
      DTSTART: "20260105T140000Z",
      DTEND: "20260105T143000Z",
      RRULE: "FREQ=WEEKLY;BYDAY=MO",
    }),
  );

  it("finds an occurrence months after the series began", () => {
    // The failure this guards is silent: without expansion the standup appears once, in January,
    // and every later week is simply absent from the calendar.
    const out = eventsBetween(weekly, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(ms("2026-09-07T14:00:00Z"));
    expect(out[0]!.summary).toBe("API Team Standup");
  });

  it("returns nothing on a day the series does not fall on", () => {
    expect(eventsBetween(weekly, ms("2026-09-08T00:00:00Z"), ms("2026-09-09T00:00:00Z"), SRC)).toHaveLength(0);
  });

  it("honours EXDATE — a skipped week is not a meeting", () => {
    const doc = ics(
      vevent({
        UID: "x@x",
        SUMMARY: "Standup",
        DTSTART: "20260105T140000Z",
        DTEND: "20260105T143000Z",
        RRULE: "FREQ=WEEKLY;BYDAY=MO",
        EXDATE: "20260907T140000Z",
      }),
    );
    expect(eventsBetween(doc, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC)).toHaveLength(0);
  });

  it("prefers an override's own name over the series' when an occurrence was renamed", () => {
    const doc = ics(
      vevent({
        UID: "o@x",
        SUMMARY: "Standup",
        DTSTART: "20260105T140000Z",
        DTEND: "20260105T143000Z",
        RRULE: "FREQ=WEEKLY;BYDAY=MO",
      }),
      vevent({
        UID: "o@x",
        "RECURRENCE-ID": "20260907T140000Z",
        SUMMARY: "Standup — entity sync deep dive",
        DTSTART: "20260907T140000Z",
        DTEND: "20260907T153000Z",
      }),
    );
    const out = eventsBetween(doc, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe("Standup — entity sync deep dive");
  });

  it("keeps an orphan override whose master the feed did not publish", () => {
    // Published feeds routinely window what they emit, so a modified occurrence can arrive with no
    // series behind it. That override IS the meeting that happened; dropping it loses the meeting.
    const doc = ics(
      vevent({
        UID: "orphan@x",
        "RECURRENCE-ID": "20260907T140000Z",
        SUMMARY: "Moved planning session",
        DTSTART: "20260907T140000Z",
        DTEND: "20260907T150000Z",
      }),
    );
    const out = eventsBetween(doc, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe("Moved planning session");
  });

  it("catches a long event that began before the window and is still running", () => {
    // The all-day workshop a recording lands in the middle of. Starting the expansion exactly at
    // the window would skip it entirely.
    const doc = ics(
      vevent({
        UID: "long@x",
        SUMMARY: "Quarterly planning workshop",
        DTSTART: "20260907T090000Z",
        DTEND: "20260907T170000Z",
      }),
    );
    const out = eventsBetween(doc, ms("2026-09-07T13:30:00Z"), ms("2026-09-07T15:00:00Z"), SRC);
    expect(out).toHaveLength(1);
  });

  it("terminates on an unbounded daily rule instead of hanging the worker", () => {
    // Legal, ordinary, and infinite. This process also serves conversations, so a runaway
    // expansion is an agent that stops answering.
    const doc = ics(
      vevent({
        UID: "daily@x",
        SUMMARY: "Daily",
        DTSTART: "20200101T140000Z",
        DTEND: "20200101T143000Z",
        RRULE: "FREQ=DAILY",
      }),
    );
    const out = eventsBetween(doc, ms("2026-09-07T00:00:00Z"), ms("2026-09-08T00:00:00Z"), SRC);
    expect(out.length).toBeLessThanOrEqual(1);
  });
});

describe("eventsBetween — a bad feed degrades to no calendar, never to no recap", () => {
  it("returns nothing for unparseable text", () => {
    // An HTML error page from an expired share link is the realistic case. The recording must
    // still be transcribed and filed; it just loses its meeting name.
    expect(eventsBetween("<html>Sign in</html>", 0, 9e12, SRC)).toEqual([]);
  });

  it("returns nothing for an empty document", () => {
    expect(eventsBetween("", 0, 9e12, SRC)).toEqual([]);
  });

  it("skips a single broken event rather than losing the whole calendar", () => {
    const doc = ics(
      vevent({ UID: "bad@x", SUMMARY: "Broken", DTSTART: "not-a-date" }),
      vevent({ UID: "good@x", SUMMARY: "Fine", DTSTART: "20260907T140000Z", DTEND: "20260907T150000Z" }),
    );
    const out = eventsBetween(doc, ms("2026-09-07T13:00:00Z"), ms("2026-09-07T16:00:00Z"), SRC);
    expect(out.map((e) => e.summary)).toContain("Fine");
  });
});

describe("candidatesFor — across every calendar the agent has", () => {
  const base = { attendees: [], attendeeEmails: [], uid: "", location: "" };
  const work = { kind: "google", alias: "work" };
  const personal = { kind: "google", alias: "personal" };

  const events = [
    { ...base, summary: "Personal thing", start: ms("2026-09-07T14:10:00Z"), end: ms("2026-09-07T14:40:00Z"), source: personal },
    { ...base, summary: "API Standup", start: ms("2026-09-07T14:00:00Z"), end: ms("2026-09-07T14:30:00Z"), source: work },
    { ...base, summary: "Focus Time", start: ms("2026-09-07T14:00:00Z"), end: ms("2026-09-07T16:00:00Z"), source: work },
    { ...base, summary: "Yesterday", start: ms("2026-09-06T14:00:00Z"), end: ms("2026-09-06T15:00:00Z"), source: work },
  ];

  it("keeps two calendars' entries side by side, tagged by where they came from", () => {
    // The N-source case. Two Google calendars are distinguishable by alias, which is exactly what
    // the connection model's `(kind, alias)` identity exists to make possible.
    const out = candidatesFor(events, ms("2026-09-07T13:45:00Z"), ms("2026-09-07T15:00:00Z"));
    expect(out.map((e) => `${e.source.alias}:${e.summary}`)).toEqual([
      "work:API Standup",
      "work:Focus Time",
      "personal:Personal thing",
    ]);
  });

  it("drops the blocks a person said to ignore", () => {
    const out = candidatesFor(events, ms("2026-09-07T13:45:00Z"), ms("2026-09-07T15:00:00Z"), {
      exclude: ["focus time"],
    });
    expect(out.map((e) => e.summary)).not.toContain("Focus Time");
  });

  it("drops what is outside the window", () => {
    const out = candidatesFor(events, ms("2026-09-07T13:45:00Z"), ms("2026-09-07T15:00:00Z"));
    expect(out.map((e) => e.summary)).not.toContain("Yesterday");
  });

  it("is stably ordered, so the prompt does not change between polls for no reason", () => {
    const a = candidatesFor(events, ms("2026-09-07T13:45:00Z"), ms("2026-09-07T15:00:00Z"));
    const b = candidatesFor([...events].reverse(), ms("2026-09-07T13:45:00Z"), ms("2026-09-07T15:00:00Z"));
    expect(a.map((e) => e.summary)).toEqual(b.map((e) => e.summary));
  });

  it("does not pick a winner — that is content's job, not time's", () => {
    // Two meetings overlap the same recording. Choosing by proximity here is what the old pipeline
    // did first and had to undo; the transcript is the only thing that knows which this was.
    const out = candidatesFor(events, ms("2026-09-07T14:05:00Z"), ms("2026-09-07T14:15:00Z"));
    expect(out.length).toBeGreaterThan(1);
  });
});

describe("describe — what a person reads is what the model read", () => {
  it("names the source, so a wrong match says which calendar it came from", () => {
    const line = describeEvent({
      summary: "API Standup",
      start: ms("2026-09-07T14:00:00Z"),
      end: ms("2026-09-07T14:30:00Z"),
      attendees: ["Rod Navarro"],
      attendeeEmails: [],
      uid: "w@x",
      location: "Teams",
      source: { kind: "ics", alias: "foley" },
    });
    expect(line).toContain("API Standup");
    expect(line).toContain("ics/foley");
    expect(line).toContain("Rod Navarro");
    expect(line).toContain("Teams");
  });
});
