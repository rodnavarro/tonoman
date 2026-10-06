import { describe, expect, it } from "vitest";
import { calendarChoices, checkRecap, localTools, localToolsOf, pickCalendars, pickLogin, plaudLogins, skillsNote } from "./localtools";
import { recapJobPrompt, recapNudge } from "../talents/voice/plaud-and-calendar-meetings/prompt";
import type { AgentConfig } from "../config";

// The tools a skill brings to a turn, called by label as people say them (D-JOBS-ARE-PROMPTS and
// TOOL-CALLED-BY-LABEL in Tonoman Cloud). Neutral cast: Ana, Ben; Team Plaud; Work and Home calendars.

const recap = (instance: string, plaud: unknown, calendar: unknown) => ({ name: "meeting-recap", version: 3, instance, bindings: { plaud, calendar } as never });
const cfg = (talents: unknown[], credentials: unknown[] = []) => ({ guid: "g-1", timezone: "UTC", talents, credentials }) as unknown as AgentConfig;
const WORK = { id: "c1", kind: "ics", alias: "work", label: "Work calendar", scope: "shared", secret_ref: "ics.secret:work", status: "connected" };
const HOME = { id: "c2", kind: "google", alias: "home", label: "Home calendar", scope: "shared", status: "connected" };
const TEAM = { id: "p1", kind: "plaud", alias: "team", label: "Team Plaud", scope: "shared", secret_ref: "plaud.secret:team" };
const OWN = { id: "p0", kind: "plaud", alias: "default", label: "Plaud", scope: "per_person" };

describe("which tools a turn has", () => {
  it("CLI-GRANTED-GROUPS a skill brings its tools to the turn, and only its own", () => {
    expect(localToolsOf({ talents: [{ name: "agenda-brief", version: 1 }] })).toEqual(["calendar"]);
    expect(localToolsOf({ talents: [{ name: "meeting-recap", version: 3 }] }).sort()).toEqual(["calendar", "meeting-recap", "plaud"]);
    expect(localToolsOf({ talents: [{ name: "web-search", version: 1 }] })).toEqual([]);
  });

  it("TOOL-CALLED-BY-LABEL the agent is told each copy's keyword and what its tools use, by label", () => {
    const note = skillsNote(cfg([recap("meeting-recap", { mode: "each_person", credentials: [OWN] }, { mode: "credentials", credentials: [WORK] }), recap("team-recap", { mode: "credentials", credentials: [TEAM] }, { mode: "credentials", credentials: [HOME] })]), () => "Recap a recording.");
    expect(note).toContain("`team-recap` (a copy of meeting-recap)");
    expect(note).toContain('plaud: "Team Plaud"');
    expect(note).toContain('calendar: "Home calendar"');
    expect(note).toContain("plaud: each person's own (\"mine\")");
  });
});

describe("Plaud logins, by label", () => {
  const v = { creds: { tokenJson: "x" }, accounts: [{ user: "UANA", creds: { tokenJson: "", cliAgent: "a", cliUser: "UANA" } }] };
  const c = cfg([recap("meeting-recap", { mode: "each_person", credentials: [OWN] }, undefined), recap("team-recap", { mode: "credentials", credentials: [TEAM] }, undefined)]);

  it("TOOL-CALLED-BY-LABEL a person may use their own ('mine') and every shared login a copy here uses — never someone else's own", () => {
    expect(plaudLogins(c, v as never, "UANA").map((l) => l.label)).toEqual(["mine", "Team Plaud"]);
    expect(plaudLogins(c, v as never, "UBEN").map((l) => l.label)).toEqual(["Team Plaud"]);
  });

  it("TOOL-CALLED-BY-LABEL nothing named means your own; a label is matched whatever its case; a miss says what there is", () => {
    const logins = plaudLogins(c, v as never, "UANA");
    expect(pickLogin(logins, undefined)).toMatchObject({ label: "mine", user: "UANA" });
    expect(pickLogin(logins, "team plaud")).toMatchObject({ label: "Team Plaud" });
    const miss = pickLogin(logins, "Ben's Plaud");
    expect("error" in miss && miss.error).toContain('"mine", "Team Plaud"');
  });

  it("TOOL-CALLED-BY-LABEL with no login of your own and one shared, nothing named means the shared one", () => {
    expect(pickLogin(plaudLogins(c, v as never, "UBEN"), undefined)).toMatchObject({ label: "Team Plaud" });
  });
});

describe("calendars, by label", () => {
  it("TALENT-BINDING-PER-TOOL a copy reads only the calendars it is set to; the agent, any its copies use", () => {
    const c = cfg([recap("meeting-recap", undefined, { mode: "credentials", credentials: [WORK] }), recap("team-recap", undefined, { mode: "credentials", credentials: [HOME] })]);
    expect(calendarChoices(c, "team-recap").map((x) => x.label)).toEqual(["Home calendar"]);
    expect(calendarChoices(c).map((x) => x.label).sort()).toEqual(["Home calendar", "Work calendar"]);
  });

  it("TOOL-CALLED-BY-LABEL calendars are named by label or alias; an unknown one is refused with what there is", () => {
    const choices = calendarChoices(cfg([recap("meeting-recap", undefined, { mode: "credentials", credentials: [WORK, HOME] })]));
    expect((pickCalendars(choices, "home") as { label: string }[]).map((x) => x.label)).toEqual(["Home calendar"]);
    expect(pickCalendars(choices, "Holidays")).toEqual({ error: expect.stringContaining('"Work calendar"') });
  });
});

describe("a recap is checked before it is filed", () => {
  const good = { summary: "They agreed the launch date.", highlights: ["Launch moves to May"], decisions: ["May 4"], followups: [], participants: ["Ana"], meeting: "Launch sync" };

  it("RECAP-CHECKED-BEFORE-FILED a meeting the calendar did not show is refused, with the ones it did", () => {
    const r = checkRecap({ ...good, meeting: "Board meeting" }, { candidates: [{ summary: "Launch sync" }] });
    expect("problems" in r && r.problems.join(" ")).toContain('"Launch sync"');
  });

  it("RECAP-CHECKED-BEFORE-FILED every problem is said at once — missing summary, too many highlights, a route not offered", () => {
    const r = checkRecap({ highlights: ["1", "2", "3", "4", "5", "6"], route: "nowhere" }, { candidates: [], routes: ["clients"], fallback: "unclassified" });
    expect("problems" in r && r.problems.length).toBe(3);
  });

  it("RECAP-CHECKED-BEFORE-FILED a good recap passes, read from the JSON the agent wrote, fences and all", () => {
    const r = checkRecap("```json\n" + JSON.stringify(good) + "\n```", { candidates: [{ summary: "launch sync" }] });
    expect("recap" in r && r.recap.meeting).toBe("Launch sync");
  });
});

describe("the tools, answered", () => {
  const rec = { id: "R-1", title: "Launch sync", startTime: Date.parse("2026-10-06T10:00:00Z"), duration: 30 * 60000, stamp: "2026-10-06-1000" };
  const made = () => {
    const calls = { transcribed: 0, published: [] as unknown[], closed: [] as unknown[] };
    const deps = {
      agentByGuid: (g: string) => (g === "g-1" ? { name: "Rex", cfg: cfg([recap("meeting-recap", { mode: "each_person", credentials: [OWN] }, { mode: "credentials", credentials: [WORK] })]) } : undefined),
      voice: () => ({ creds: { tokenJson: "" }, accounts: [{ user: "UANA", creds: { tokenJson: "", cliUser: "UANA" } }], floorMs: 0, calendarPadMinutes: 30 }) as never,
      plaudCreds: async () => ({ tokenJson: "" }),
      listRecordings: async () => [rec],
      transcribe: async () => {
        calls.transcribed++;
        return { text: "Ana: let's launch on May 4.", seconds: 1800, by: ["groq"] };
      },
      feeds: async () => [{ kind: "ics", alias: "work", url: "https://example.test/work.ics" }],
      gather: async () => [{ summary: "Launch sync", start: rec.startTime, end: rec.startTime + rec.duration, attendees: ["Ana", "Ben"], source: { kind: "ics", alias: "work" } }],
      describeDay: () => "a clear day",
      publish: async (_n: string, _u: string | undefined, p: unknown) => {
        calls.published.push(p);
        return { published: true, path: "Meetings/2026-10-06-1000-launch-sync.md", route: "clients" };
      },
      closeRun: async (...a: unknown[]) => void calls.closed.push(a),
    };
    return { call: localTools(deps as never), calls };
  };

  it("TOOL-CALLED-BY-LABEL a transcript is read through your own login and kept for the filing a moment later", async () => {
    const { call, calls } = made();
    const t = await call("g-1", "UANA", "plaud", "transcript", { id: "R-1" });
    expect(t.status).toBe(200);
    expect(t.text).toContain("Launch sync");
    expect(t.text).toContain("May 4");
    const f = await call("g-1", "UANA", "meeting-recap", "file", { id: "R-1", recap: JSON.stringify({ summary: "They set the date.", highlights: ["May 4"], decisions: [], followups: [], meeting: "Launch sync" }) });
    expect(f).toMatchObject({ status: 200, text: expect.stringContaining("Meetings/2026-10-06-1000-launch-sync.md") });
    expect(calls.transcribed).toBe(1);
  });

  it("RECAP-JOB-POST-HOOK filing closes the job's run as done, for the copy that asked", async () => {
    const { call, calls } = made();
    await call("g-1", "UANA", "meeting-recap", "file", { id: "R-1", recap: { summary: "x", highlights: [], decisions: [], followups: [], meeting: "" } });
    expect(calls.closed[0]).toEqual(["Rex", "meeting-recap", "R-1", expect.stringContaining("Filed")]);
  });

  it("RECAP-CHECKED-BEFORE-FILED a refused recap files nothing and says what to fix", async () => {
    const { call, calls } = made();
    const f = await call("g-1", "UANA", "meeting-recap", "file", { id: "R-1", recap: { summary: "x", highlights: [], decisions: [], followups: [], meeting: "Invented" } });
    expect(f.status).toBe(400);
    expect(calls.published).toHaveLength(0);
    expect(calls.closed).toHaveLength(0);
  });

  it("TOOL-CALLED-BY-LABEL someone with no Plaud of their own and none shared is told how to connect", async () => {
    const { call } = made();
    const r = await call("g-1", "UBEN", "plaud", "list", {});
    expect(r).toMatchObject({ status: 400, text: expect.stringContaining("!connect plaud") });
  });
});

describe("the recap job is a prompt", () => {
  it("D-JOBS-ARE-PROMPTS the prompt names the copy, the recording, and its login and calendars by label", () => {
    const p = recapJobPrompt({ copy: "team-recap", id: "R-1", title: "Launch sync", startedAt: Date.parse("2026-10-06T10:00:00Z"), minutes: 30, login: "Team Plaud", calendars: ["Home calendar"], journal: { routes: [{ id: "clients", when: "a client meeting" }], fallback: "unclassified" } });
    expect(p).toContain('tonoman plaud transcript --id R-1 --login "Team Plaud"');
    expect(p).toContain('--calendars "Home calendar"');
    expect(p).toContain("tonoman meeting-recap file --id R-1 --login \"Team Plaud\" --copy team-recap");
    expect(p).toContain('"clients" (a client meeting)');
  });

  it("D-JOBS-ARE-PROMPTS the first copy on the person's own login needs no label at all", () => {
    const p = recapJobPrompt({ copy: "meeting-recap", id: "R-1", title: "x", startedAt: 0, minutes: 1, login: "mine", calendars: [] });
    expect(p).toContain("`tonoman plaud transcript --id R-1`");
    expect(p).not.toContain("--copy");
    expect(recapNudge({ copy: "meeting-recap", id: "R-1", title: "x", login: "mine" })).toContain("tonoman meeting-recap file --id R-1`");
  });
});
