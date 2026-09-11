import { describe, expect, it } from "vitest";
import { describe as describeVoice, voiceSettings, plaudPerPerson } from "./flowcfg";

describe("voiceSettings — the registry decides", () => {
  it("reads the channel and the recipient from the tenant's own rows", () => {
    const v = voiceSettings({ notify_channel: "C_FROM_DB", notify_user: "U_DB" }, {});
    expect(v.notifyChannel).toBe("C_FROM_DB");
    expect(v.notifyUser).toBe("U_DB");
  });

  it("NEVER takes a channel or a recipient from the environment", () => {
    // A worker-wide default is cross-tenant contamination by construction: a channel id names a
    // place inside ONE workspace, and the second tenant inherited the first tenant's channel —
    // about to announce a person's private recaps into a customer's Slack.
    const v = voiceSettings({}, { VOICE_NOTIFY_CHANNEL: "C_FROM_ENV", VOICE_NOTIFY_USER: "U_ENV" });
    expect(v.notifyChannel).toBe("");
    expect(v.notifyUser).toBe("");
  });

  it("still takes the harmless, non-identifying settings from the environment", () => {
    expect(voiceSettings({}, { VOICE_POLL_SECONDS: "300" }).pollSeconds).toBe(300);
  });

  it("defaults the poll to five minutes rather than to zero", () => {
    // Five, matching the cadence the existing plaud-cron schedule has been running at.
    expect(voiceSettings({}, {}).pollSeconds).toBe(300);
    expect(voiceSettings({ poll_seconds: "0" }, {}).pollSeconds).toBe(300);
    expect(voiceSettings({ poll_seconds: "nonsense" }, {}).pollSeconds).toBe(300);
  });
});

describe("voiceSettings — routing is N rows", () => {
  const props = {
    "journal.path": "%3A%3AMeeting-Journals%3A%3A",
    "journal.fallback": "unclassified",
    "route.foley-meetings": "Foley — the employer",
    "route.axiplex-meetings": "Axiplex — Rod's own company",
  };

  it("reads one route per row, and the id IS the folder", () => {
    const j = voiceSettings(props, {}).journal!;
    expect(j.path).toBe("%3A%3AMeeting-Journals%3A%3A");
    expect(j.fallback).toBe("unclassified");
    expect(j.routes.map((r) => r.id)).toEqual(["axiplex-meetings", "foley-meetings"]);
  });

  it("orders routes stably, so the model's prompt does not churn between polls", () => {
    const a = voiceSettings(props, {}).journal!.routes.map((r) => r.id);
    const b = voiceSettings({ ...props }, {}).journal!.routes.map((r) => r.id);
    expect(a).toEqual(b);
  });

  it("ignores a route row with no description — it would be an unexplained choice", () => {
    const j = voiceSettings({ ...props, "route.empty": "   " }, {}).journal!;
    expect(j.routes.map((r) => r.id)).not.toContain("empty");
  });

  it("has NO journal when the path is missing — the flat layout is the honest default", () => {
    expect(voiceSettings({ "journal.fallback": "unclassified" }, {}).journal).toBeUndefined();
  });

  it("REFUSES a journal with no fallback rather than half-applying one", () => {
    // Without somewhere to put the ambiguous ones, the only alternative is inventing a folder.
    expect(voiceSettings({ "journal.path": "Meetings", "route.x": "..." }, {}).journal).toBeUndefined();
  });

  it("allows a journal with a fallback and no routes — everything lands unclassified, visibly", () => {
    const j = voiceSettings({ "journal.path": "M", "journal.fallback": "unclassified" }, {}).journal!;
    expect(j.routes).toEqual([]);
  });
});

describe("describe", () => {
  it("says where recaps go and how they are filed, because silence looks like success", () => {
    const line = describeVoice(
      voiceSettings(
        {
          credential_ref: "plaud-murphy:PLAUD_TOKEN",
          notify_channel: "C1",
          "journal.path": "MJ",
          "journal.fallback": "unclassified",
          "route.a": "A",
        },
        {},
      ),
    );
    expect(line).toContain("channel C1");
    expect(line).toContain("MJ/{a}");
    expect(line).toContain("unclassified");
  });

  it("names the DM recipient when there is no channel", () => {
    expect(
      describeVoice(voiceSettings({ credential_ref: "plaud-murphy:PLAUD_TOKEN", notify_user: "U1" }, {})),
    ).toContain("DM with U1");
  });
});

describe("voiceSettings — the off switch", () => {
  it("is ON by default, because configuring a flow means meaning to run it", () => {
    expect(voiceSettings({}, {}).enabled).toBe(true);
    expect(voiceSettings({ notify_channel: "C1" }, {}).enabled).toBe(true);
  });

  it("only an explicit false turns it off, so a typo cannot silently stop a pipeline", () => {
    expect(voiceSettings({ enabled: "false" }, {}).enabled).toBe(false);
    expect(voiceSettings({ enabled: "FALSE" }, {}).enabled).toBe(false);
    expect(voiceSettings({ enabled: "no" }, {}).enabled).toBe(true);
    expect(voiceSettings({ enabled: "" }, {}).enabled).toBe(true);
  });

  it("says so loudly in the boot line — a silent flow looks identical to a working one", () => {
    expect(
      describeVoice(voiceSettings({ credential_ref: "plaud-murphy:PLAUD_TOKEN", enabled: "false" }, {})),
    ).toContain("DISABLED");
  });

  it("reports a switched-off flow as OFF, not as waiting for a login", () => {
    // Both are true of a flow with neither; only one of them tells the reader what to do about it.
    expect(describeVoice(voiceSettings({ enabled: "false" }, {}))).toContain("DISABLED");
  });
});

describe("voiceSettings — whose Plaud account", () => {
  it("takes the credential from the tenant's own row", () => {
    expect(voiceSettings({ credential_ref: "plaud-murphy:PLAUD_TOKEN" }, {}).credentialRef).toBe(
      "plaud-murphy:PLAUD_TOKEN",
    );
  });

  it("NEVER falls back to a worker-wide credential", () => {
    // PLAUD_TOKEN_FILE was one path on one pod, and one pod runs every agent this worker has — so
    // both tenants polled whichever account happened to be mounted, and the second person to log
    // in would have replaced the first. Same mistake as a worker-wide notify channel, except the
    // contents are somebody's recordings rather than somebody's channel.
    const v = voiceSettings({}, { PLAUD_TOKEN_FILE: "/etc/tonoman/recap/plaud.json" });
    expect(v.credentialRef).toBe("");
  });

  it("says it is waiting for a login, which is a state and not a fault", () => {
    // A tenant before its person has logged in is the NORMAL state, and the boot line has to read
    // that way — "waiting for Celine", not "broken".
    const line = describeVoice(voiceSettings({ notify_channel: "C1" }, {}));
    expect(line).toContain("waiting for a Plaud login");
    expect(line).not.toContain("DISABLED");
  });
});


describe("voiceSettings — calendars", () => {
  it("splits the exclusion list a person typed, and drops the blanks", () => {
    // A trailing comma is the ordinary result of editing this in a form. An empty pattern treated
    // as a substring match excludes EVERY event and switches calendar matching off silently.
    const v = voiceSettings({ "calendar.exclude": "Focus Time, Lunch , ,Calendly Meeting Block," });
    expect(v.calendarExclude).toEqual(["Focus Time", "Lunch", "Calendly Meeting Block"]);
  });

  it("has no exclusions when nothing is configured", () => {
    expect(voiceSettings({}).calendarExclude).toEqual([]);
  });

  it("leaves the window unset so the module's own default applies", () => {
    // Not defaulted here: two defaults for one number is how they drift apart.
    expect(voiceSettings({}).calendarPadMinutes).toBeUndefined();
    expect(voiceSettings({ "calendar.window_minutes": "45" }).calendarPadMinutes).toBe(45);
  });

  it("has NO timezone setting, because matching does not need one", () => {
    // Deliberate. Matching is in epoch milliseconds; the old pipeline needed America/New_York only
    // because it searched a local-day window, which is also why it got DST boundaries wrong.
    expect(Object.keys(voiceSettings({ "calendar.tz": "America/New_York" }))).not.toContain("calendarTz");
  });
});

describe("voiceSettings — the runner switch", () => {
  it("defaults to the proven hardcoded pipeline when nothing is set", () => {
    // A working pipeline must never change runtime because of a missing row.
    expect(voiceSettings({}).runner).toBe("hardcoded");
  });

  it("arms the skill interpreter only on an explicit 'skill'", () => {
    expect(voiceSettings({ runner: "skill" }).runner).toBe("skill");
    expect(voiceSettings({ runner: "SKILL" }).runner).toBe("skill");
  });

  it("treats anything else — a typo included — as hardcoded, never as armed", () => {
    // The dangerous direction is silently arming; a mistyped value must fall to the safe side.
    expect(voiceSettings({ runner: "skil" }).runner).toBe("hardcoded");
    expect(voiceSettings({ runner: "hardcoded" }).runner).toBe("hardcoded");
    expect(voiceSettings({ runner: "" }).runner).toBe("hardcoded");
  });
});

describe("voiceSettings — Plaud scope (per-person)", () => {
  it("defaults to shared, so an existing agent is unchanged", () => {
    expect(voiceSettings({}, {}).plaudScope).toBe("shared");
    expect(plaudPerPerson({})).toBe(false);
    expect(plaudPerPerson(undefined)).toBe(false);
  });

  it("reads an explicit per_person opt-in, case-insensitively", () => {
    expect(voiceSettings({ plaud_scope: "per_person" }, {}).plaudScope).toBe("per_person");
    expect(voiceSettings({ plaud_scope: "PER_PERSON" }, {}).plaudScope).toBe("per_person");
    expect(plaudPerPerson({ plaud_scope: "per_person" })).toBe(true);
    // Anything else is shared — a typo can never move a tenant off their one working account.
    expect(voiceSettings({ plaud_scope: "each" }, {}).plaudScope).toBe("shared");
    expect(plaudPerPerson({ plaud_scope: "each" })).toBe(false);
  });
});
