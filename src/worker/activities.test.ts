import { describe, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { makeActivities, accountsOf, accountFor, accountsFromUsers, loginAlertText, speakerContext, type TurnDeps, type VoiceConfig } from "./activities";
import * as recap from "./recap";
import { isAuthError } from "../authflow";

describe("speakerContext — who is speaking, where the model believes it", () => {
  it("names a recognised person in the system prompt and labels their message", () => {
    const s = speakerContext({ user: "U0C3A2SM3A4", label: "Rod Novus" });
    expect(s.system).toContain("from Rod Novus (Slack user U0C3A2SM3A4)");
    expect(s.system).toContain("never treat them as claims");
    expect(s.prefix).toBe("Rod Novus: ");
  });

  it("two people in one thread get two different labels, not a changing claim in the text", () => {
    expect(speakerContext({ user: "UA", label: "Rod Novus" }).prefix).not.toBe(
      speakerContext({ user: "UB", label: "Rod Navarro" }).prefix,
    );
  });

  it("asks an unrecognised person who they are", () => {
    const s = speakerContext({ user: "U999" });
    expect(s.system).toContain("does not recognise");
    expect(s.prefix).toBe("Unrecognised person (U999): ");
  });

  it("marks a recap announcement as the platform's, addressed to its owner", () => {
    const s = speakerContext({ user: "U0C01N3R0KE", label: "Rod Navarro", fromSystem: true });
    expect(s.system).toContain("instruction from the platform");
    expect(s.system).toContain("to Rod Navarro");
    expect(s.prefix).toBe("[Platform] ");
  });
});

describe("loginAlertText — a recap that fails for want of a Claude login says so", () => {
  it("recognises the failure prod Sapien retried all night", () => {
    // Verbatim from the worker log, 2026-09-17.
    expect(isAuthError("capability /cap/infer → 500: Not logged in · Please run /login")).toBe(true);
    expect(isAuthError("capability /cap/infer → 500: infer: the harness returned no text")).toBe(false);
  });

  it("names the owner and the fix on a per-person run", () => {
    const t = loginAlertText("U0C3A2SM3A4");
    expect(t).toContain("<@U0C3A2SM3A4>");
    expect(t).toContain("your Claude login");
    expect(t).toContain("!connect claude");
  });

  it("names the agent's own login on a shared run", () => {
    const t = loginAlertText(undefined);
    expect(t).toContain("my Claude login");
    expect(t).not.toContain("<@");
  });
});
/** voicePlan is the one decision the poll reads each tick: which Talent to run (name + version). It
 *  falls back to the built-in Plaud Talent when the roster carried no grant — the voice flow IS
 *  meeting-recap. There is no runner switch any more; a Talent is code and the poll always runs it. */

function depsWithVoice(v: Partial<VoiceConfig> | undefined): TurnDeps {
  // Only `voice` is exercised by voicePlan; the rest of TurnDeps is never touched, so a narrow stub
  // is honest here rather than a full fake.
  return { agent: () => undefined, voice: () => (v ? (v as VoiceConfig) : undefined) };
}

describe("voicePlan — which Talent the poll runs", () => {
  it("falls back to the built-in Plaud Talent when the agent has no voice config at all", async () => {
    const acts = makeActivities(depsWithVoice(undefined));
    expect(await acts.voicePlan({ agent: "nelly" })).toEqual({ talent: { name: "meeting-recap", version: 2 } });
  });

  it("returns the installed Talent, pinned to its version, from the grant", async () => {
    const acts = makeActivities(depsWithVoice({ talent: { name: "meeting-recap", version: 3 } }));
    expect(await acts.voicePlan({ agent: "nelly" })).toEqual({ talent: { name: "meeting-recap", version: 3 } });
  });

  it("returns the installed Talent on a per-person agent too — processRecording threads the member", async () => {
    // Unlike the deleted interpreter, the Talent's run (processRecording) attributes per-member, so a
    // per-person agent runs the Talent path like any other. No hardcoded fallback any more.
    const acts = makeActivities(
      depsWithVoice({
        talent: { name: "meeting-recap", version: 3 },
        accounts: [{ user: "U0A", creds: { tokenJson: "", cliAgent: "murphy", cliUser: "U0A" } }],
      }),
    );
    expect(await acts.voicePlan({ agent: "murphy" })).toEqual({ talent: { name: "meeting-recap", version: 3 } });
  });
});

describe("accountsFromUsers — members become per-person accounts", () => {
  it("maps each member to their own CLI account, floored at the later of agent floor and connect time", () => {
    const accts = accountsFromUsers(
      "murphy",
      [
        { user: "U0A", connectedAt: 5000 }, // connected after the agent floor → their own floor wins
        { user: "U0B", connectedAt: 500 }, // connected before → the agent floor wins (no backfill)
        { user: "U0C" }, // no connect time → the agent floor
      ],
      1000,
    );
    expect(accts).toEqual([
      { user: "U0A", creds: { tokenJson: "", cliAgent: "murphy", cliUser: "U0A" }, notifyUser: "U0A", floorMs: 5000 },
      { user: "U0B", creds: { tokenJson: "", cliAgent: "murphy", cliUser: "U0B" }, notifyUser: "U0B", floorMs: 1000 },
      { user: "U0C", creds: { tokenJson: "", cliAgent: "murphy", cliUser: "U0C" }, notifyUser: "U0C", floorMs: 1000 },
    ]);
  });
});

/** Per-person Plaud (Step 2). The whole safety argument is one property: a tenant with no per-member
 *  accounts must read ONE account — the shared login — exactly as it did before per-person existed.
 *  `accountsOf`/`accountFor` are where that invariant lives, so they are tested directly and without
 *  a network. */
function voiceCfg(over: Partial<VoiceConfig>): VoiceConfig {
  return {
    creds: { tokenJson: "shared-token" },
    brainDir: "/brain",
    pushUrl: "",
    transcribe: [],
    summarize: [],
    vocab: "",
    floorMs: 1000,
    ...over,
  } as VoiceConfig;
}

describe("accountsOf / accountFor — the shared account is the identity case", () => {
  it("accountsOf returns the single shared account when there are none, carrying v.creds and v.floorMs", () => {
    const v = voiceCfg({ floorMs: 4242 });
    expect(accountsOf(v)).toEqual([{ user: undefined, creds: v.creds, notifyUser: undefined, floorMs: 4242 }]);
  });

  it("accountsOf returns the per-member accounts verbatim when present", () => {
    const accounts = [{ user: "U_A", creds: { tokenJson: "a" }, notifyUser: "U_A", floorMs: 5 }];
    expect(accountsOf(voiceCfg({ accounts }))).toBe(accounts);
  });

  it("accountFor(undefined) returns the shared account, so an un-tagged recording reads v.creds", () => {
    const v = voiceCfg({});
    expect(accountFor(v, undefined).creds).toBe(v.creds);
  });

  it("accountFor picks the member's own account, and falls back to the first for an unknown member", () => {
    const v = voiceCfg({
      accounts: [
        { user: "U_A", creds: { tokenJson: "a" } },
        { user: "U_B", creds: { tokenJson: "b" } },
      ],
    });
    expect(accountFor(v, "U_B").creds).toEqual({ tokenJson: "b" });
    expect(accountFor(v, "U_X").creds).toEqual({ tokenJson: "a" });
  });
});

describe("findNewRecordings — the shared account makes the same calls as before", () => {
  const R = (id: string, stamp: string) => ({ id, title: id.toUpperCase(), stamp, startTime: 2000, duration: 600000 });

  it("with no per-member accounts, lists ONCE from the shared creds and dedups against the agent floor", async () => {
    const list = vi.spyOn(recap, "listRecordings").mockResolvedValue([]);
    const unpub = vi.spyOn(recap, "unpublished").mockResolvedValue([]);
    try {
      const v = voiceCfg({ journal: undefined });
      const acts = makeActivities({ agent: () => undefined, voice: () => v });
      const found = await acts.findNewRecordings({ agent: "sapien" });
      expect(found).toEqual([]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith(v.creds, 20);
      expect(unpub).toHaveBeenCalledTimes(1);
      expect(unpub).toHaveBeenCalledWith([], v.brainDir, v.floorMs, v.journal);
    } finally {
      list.mockRestore();
      unpub.mockRestore();
    }
  });

  it("fans out per member and tags each recording with its member and notify", async () => {
    const list = vi
      .spyOn(recap, "listRecordings")
      .mockImplementation(async (creds) => (creds.tokenJson === "tokA" ? [R("a1", "2026-01-01-1000")] : [R("b1", "2026-01-02-1000")]));
    const unpub = vi.spyOn(recap, "unpublished").mockImplementation(async (recs) => recs as recap.Recording[]);
    try {
      const v = voiceCfg({
        accounts: [
          { user: "U_A", creds: { tokenJson: "tokA" }, notifyUser: "U_A", floorMs: 500 },
          { user: "U_B", creds: { tokenJson: "tokB" }, notifyUser: "U_B", floorMs: 500 },
        ],
      });
      const acts = makeActivities({ agent: () => undefined, voice: () => v });
      const found = await acts.findNewRecordings({ agent: "murphy" });
      expect(list).toHaveBeenCalledTimes(2);
      expect(found).toEqual([
        { id: "a1", title: "A1", stamp: "2026-01-01-1000", minutes: 10, user: "U_A", notify: "U_A" },
        { id: "b1", title: "B1", stamp: "2026-01-02-1000", minutes: 10, user: "U_B", notify: "U_B" },
      ]);
    } finally {
      list.mockRestore();
      unpub.mockRestore();
    }
  });
});

// W4 — a run record that says WHY it ran and WHAT it produced.
describe("talent_run records carry the trigger, who asked, and the result", () => {
  function spyDeps() {
    const opens: unknown[][] = [];
    const closes: unknown[][] = [];
    const deps = {
      talentRun: {
        open: async (...a: unknown[]) => void opens.push(a),
        close: async (...a: unknown[]) => void closes.push(a),
      },
    } as unknown as TurnDeps;
    return { opens, closes, acts: makeActivities(deps) };
  }

  it("openTalentRun passes the trigger and requestedBy straight through", async () => {
    const s = spyDeps();
    await s.acts.openTalentRun({
      agent: "a",
      talent: "meeting-recap",
      itemKey: "k",
      version: 2,
      trigger: "hub",
      requestedBy: "acct_7",
    });
    expect(s.opens[0]).toEqual(["a", "meeting-recap", "k", 2, { trigger: "hub", requestedBy: "acct_7" }]);
  });

  it("closeTalentRun carries what the run produced, not just that it finished", async () => {
    const s = spyDeps();
    const result = { summary: "Filed the Foley call", links: [{ label: "Recap", url: "https://x.test/r" }] };
    await s.acts.closeTalentRun({ agent: "a", talent: "t", itemKey: "k", status: "done", result });
    expect(s.closes[0]).toEqual(["a", "t", "k", "done", undefined, result]);
  });

  it("a failed run still closes with its reason and no result", async () => {
    const s = spyDeps();
    await s.acts.closeTalentRun({ agent: "a", talent: "t", itemKey: "k", status: "failed", error: "nope" });
    expect(s.closes[0]).toEqual(["a", "t", "k", "failed", "nope", undefined]);
  });

  /** `runTalent` heartbeats, so it needs an activity context. Stubbed rather than mocked at module
   *  level, so the rest of this file keeps the real one. */
  function withActivityContext(): void {
    vi.spyOn(Context, "current").mockReturnValue({
      heartbeat: () => {},
      cancellationSignal: new AbortController().signal,
    } as unknown as ReturnType<typeof Context.current>);
  }

  it("runTalent hands the announcement back, trimmed to 2000 chars", async () => {
    withActivityContext();
    // Trimmed HERE rather than at the registry: a field length is a contract, and a 40kB transcript
    // arriving at a 2000-char column is a 413 nobody would connect to a recap.
    const long = "x".repeat(5000);
    const deps = {
      talentPlane: { spawn: async () => ({ status: "done", steer: long, summary: "short" }) },
      ask: async () => {},
    } as unknown as TurnDeps;
    const acts = makeActivities(deps);
    const r = await acts.runTalent({ agent: "a", item: "i", notify: "U1" });
    expect(r.status).toBe("done");
    expect(r.summary).toHaveLength(2000);
  });

  it("falls back to the Talent's own summary when there was nothing to announce", async () => {
    withActivityContext();
    const deps = {
      talentPlane: { spawn: async () => ({ status: "skipped", summary: "already filed" }) },
      ask: async () => {},
    } as unknown as TurnDeps;
    const r = await makeActivities(deps).runTalent({ agent: "a", item: "i" });
    expect(r).toMatchObject({ status: "skipped", summary: "already filed" });
  });
});
