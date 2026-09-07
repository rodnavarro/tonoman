import { describe, expect, it } from "vitest";
import { describe as describeVoice, voiceSettings } from "./flowcfg";

describe("voiceSettings — the registry decides, the environment only fills gaps", () => {
  it("prefers a registry row over the environment", () => {
    const v = voiceSettings({ notify_channel: "C_FROM_DB" }, { VOICE_NOTIFY_CHANNEL: "C_FROM_ENV" });
    expect(v.notifyChannel).toBe("C_FROM_DB");
  });

  it("falls back to the environment for a tenant with no rows yet", () => {
    const v = voiceSettings({}, { VOICE_NOTIFY_CHANNEL: "C_FROM_ENV", VOICE_POLL_SECONDS: "300" });
    expect(v.notifyChannel).toBe("C_FROM_ENV");
    expect(v.pollSeconds).toBe(300);
  });

  it("treats an empty row as absent, so a blanked field does not beat the fallback", () => {
    expect(voiceSettings({ notify_channel: "" }, { VOICE_NOTIFY_CHANNEL: "C_ENV" }).notifyChannel).toBe("C_ENV");
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
      voiceSettings({ notify_channel: "C1", "journal.path": "MJ", "journal.fallback": "unclassified", "route.a": "A" }, {}),
    );
    expect(line).toContain("channel C1");
    expect(line).toContain("MJ/{a}");
    expect(line).toContain("unclassified");
  });

  it("names the DM recipient when there is no channel", () => {
    expect(describeVoice(voiceSettings({ notify_user: "U1" }, {}))).toContain("DM with U1");
  });
});
