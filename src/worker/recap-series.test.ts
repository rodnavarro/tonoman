// Calendar parity with the original pipeline: a matched recording is filed under its meeting's
// series folder, named after the meeting, with its attendees as participants — and filing it there
// must still count as published, or the poll transcribes it again every two minutes.
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  calendarSection,
  overviewMarkdown,
  participantsSection,
  pathsFor,
  publish,
  recapSlugHint,
  seriesSegment,
  unpublished,
  type Recording,
} from "./recap";
import { voiceSettings } from "./flowcfg";

const journal = { path: "Meeting-Journals", fallback: "unclassified", routes: [{ id: "foley-meetings", when: "Foley" }] };
const rec: Recording = {
  id: "cccccccc3333333333333333333333",
  title: "2026-09-17 10:00:05",
  startTime: Date.parse("2026-09-17T14:00:05Z"),
  duration: 30 * 60_000,
  stamp: "2026-09-17-1400",
};

describe("seriesSegment — a meeting title as one folder", () => {
  it("keeps the casing people recognise and joins words", () => {
    expect(seriesSegment("API Team Standup")).toBe("API-Team-Standup");
  });
  it("can never become a nested path or an illegal name", () => {
    expect(seriesSegment("Q3 / Q4: plan?")).toBe("Q3-Q4-plan");
    expect(seriesSegment("..hidden..")).toBe("hidden");
    expect(seriesSegment("   ")).toBe("");
  });
});

describe("pathsFor with a matched meeting", () => {
  it("files under the series folder and names the file after the meeting", () => {
    const where = pathsFor(journal, rec, "foley-meetings", recapSlugHint({ meeting: "API Team Standup", highlights: ["x"], summary: "s" }), undefined, "API Team Standup");
    expect(where.page).toBe("Meeting-Journals/foley-meetings/API-Team-Standup/2026-09-17-1400-api-team-standup.md");
    expect(where.folder).toBe("Meeting-Journals/foley-meetings/API-Team-Standup/2026-09-17-1400-api-team-standup");
  });
  it("keeps today's path when nothing matched", () => {
    expect(pathsFor(journal, rec, "foley-meetings", "budget review").page).toBe(
      "Meeting-Journals/foley-meetings/2026-09-17-1400-budget-review.md",
    );
  });
});

describe("a recap filed under its series still counts as published", () => {
  it("is not transcribed again on the next poll", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-series-"));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", ["init", "-q"], { cwd: dir });
    const recap = {
      summary: "standup",
      highlights: [],
      decisions: [],
      followups: [],
      route: "foley-meetings",
      meeting: "API Team Standup",
    };
    await publish(dir, rec, recap, "t", "", journal).catch(() => {}); // push fails with no remote; the files are written
    const page = path.join(dir, "Meeting-Journals/foley-meetings/API-Team-Standup/2026-09-17-1400-api-team-standup.md");
    await expect(fs.stat(page)).resolves.toBeTruthy();
    expect(await unpublished([rec], dir, 0, journal)).toHaveLength(0);
  });
});

describe("participants — from the calendar when it matched", () => {
  it("says where the names came from", () => {
    const cal = participantsSection({ summary: "", highlights: [], decisions: [], followups: [], participants: ["Rod Navarro", "Chris"], participantsFrom: "calendar" });
    expect(cal).toContain("## Participants");
    expect(cal).toContain("(from calendar)");
    expect(cal).toContain("- Chris");
    const guessed = participantsSection({ summary: "", highlights: [], decisions: [], followups: [], participants: ["Rod"], participantsFrom: "transcript" });
    expect(guessed).toContain("(inferred from transcript)");
  });
  it("is absent when there are no names, and appears on the page when there are", () => {
    expect(participantsSection({ summary: "", highlights: [], decisions: [], followups: [] })).toBe("");
    const md = overviewMarkdown(rec, { summary: "s", highlights: [], decisions: [], followups: [], participants: ["Rod Navarro"], participantsFrom: "calendar" });
    expect(md).toContain("## Participants");
  });
});

describe("calendarSection times", () => {
  it("prints candidate times in the tenant's timezone, not UTC", () => {
    const md = calendarSection(
      { summary: "", highlights: [], decisions: [], followups: [], meeting: "API Team Standup" },
      [{ summary: "API Team Standup", start: Date.parse("2026-09-17T14:00:00Z"), end: Date.parse("2026-09-17T14:30:00Z"), attendees: [], attendeeEmails: [], uid: "", location: "", source: { kind: "ics", alias: "foley" } }],
      "America/New_York",
    );
    expect(md).toContain("`10:00–10:30`");
  });
});

describe("calendar.route.<alias> — the calendar decides the route", () => {
  it("is read from flow properties by alias", () => {
    const s = voiceSettings({ "calendar.route.foley": "foley-meetings", "calendar.route.personal": " axiplex-meetings ", "calendar.route.": "x" }, {});
    expect(s.calendarRoutes).toEqual({ foley: "foley-meetings", personal: "axiplex-meetings" });
  });
});
