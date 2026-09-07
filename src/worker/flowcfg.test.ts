import { describe, expect, it } from "vitest";
import { describe as describeVoice, voiceSettings } from "./flowcfg";

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
