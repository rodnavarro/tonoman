import { describe, expect, it } from "vitest";
import { makeActivities, type TurnDeps, type VoiceConfig } from "./activities";
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
});
