import { describe, expect, it, vi } from "vitest";
import { makeActivities, accountsOf, accountFor, accountsFromUsers, type TurnDeps, type VoiceConfig } from "./activities";
import * as recap from "./recap";
import type { Step } from "./skill";

/** The voice plan is the one decision the poll trigger reads each tick: which runtime, and — when it
 *  is the interpreter — the skill to run. It is deliberately the ONLY place the fallback logic lives,
 *  so that "armed but nothing to run" degrades to the proven path rather than to a flow that silently
 *  does nothing. These tests pin that fallback. */

const STEPS: Step[] = [{ id: "s1", tool: "mission get", out: "mission" }];

function depsWithVoice(v: Partial<VoiceConfig> | undefined): TurnDeps {
  // Only `voice` is exercised by voicePlan; the rest of TurnDeps is never touched, so a narrow stub
  // is honest here rather than a full fake.
  return { agent: () => undefined, voice: () => (v ? (v as VoiceConfig) : undefined) };
}

describe("voicePlan — which runtime, and the skill to run", () => {
  it("is hardcoded when the agent has no voice config at all", async () => {
    const acts = makeActivities(depsWithVoice(undefined));
    expect(await acts.voicePlan({ agent: "nelly" })).toEqual({ runner: "hardcoded" });
  });

  it("is hardcoded when the runner is not armed, even with a skill present", async () => {
    const acts = makeActivities(depsWithVoice({ runner: "hardcoded", skill: { name: "meeting-recap", steps: STEPS, version: 3 } }));
    expect(await acts.voicePlan({ agent: "nelly" })).toEqual({ runner: "hardcoded" });
  });

  it("FALLS BACK to hardcoded when armed for skill but no skill is granted", async () => {
    // The failure this avoids: a runner pointed at an interpreter with nothing to interpret is a
    // flow that does nothing and reports success. Better to run the proven path.
    const acts = makeActivities(depsWithVoice({ runner: "skill", skill: undefined }));
    expect(await acts.voicePlan({ agent: "nelly" })).toEqual({ runner: "hardcoded" });
  });

  it("runs the skill, pinned to its version, when armed and granted", async () => {
    const acts = makeActivities(depsWithVoice({ runner: "skill", skill: { name: "meeting-recap", steps: STEPS, version: 3 } }));
    expect(await acts.voicePlan({ agent: "nelly" })).toEqual({
      runner: "skill",
      skill: { name: "meeting-recap", steps: STEPS, version: 3 },
    });
  });

  it("FALLS BACK to hardcoded on a per-person agent even when armed for skill", async () => {
    // The skill interpreter does not yet thread the member, so it would read one shared account for
    // everyone. Until it does, a per-person agent must run the hardcoded path, which does thread it.
    const acts = makeActivities(
      depsWithVoice({
        runner: "skill",
        skill: { name: "meeting-recap", steps: STEPS, version: 3 },
        accounts: [{ user: "U0A", creds: { tokenJson: "", cliAgent: "murphy", cliUser: "U0A" } }],
      }),
    );
    expect(await acts.voicePlan({ agent: "murphy" })).toEqual({ runner: "hardcoded" });
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
