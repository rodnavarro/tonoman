import { afterEach, describe, expect, it } from "vitest";
import { startCapabilityPlane, type CapabilityPlane } from "./capability-plane";
import type { TurnDeps, VoiceConfig } from "./activities";

describe("capability plane /cap/infer — whose subscription pays", () => {
  let plane: CapabilityPlane | undefined;
  afterEach(async () => {
    await plane?.close();
    plane = undefined;
  });

  const start = async () => {
    const calls: { agent: string; owner?: string }[] = [];
    const deps = {
      agent: () => undefined,
      voice: () => ({}) as VoiceConfig,
      infer: async (agent: string, _p: { system: string; user: string }, owner?: string) => {
        calls.push({ agent, owner });
        return "{}";
      },
    } as unknown as TurnDeps;
    plane = await startCapabilityPlane(deps);
    const infer = (token: string) =>
      fetch(`${plane!.url}/cap/infer`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ system: "s", user: "u" }),
      });
    return { calls, infer };
  };

  it("hands the run's owner to the inference, so a recording is summarised on its owner's login", async () => {
    const { calls, infer } = await start();
    const r = await infer(plane!.mint({ agent: "sapien", item: "rec1", user: "U_OWNER" }));
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ agent: "sapien", owner: "U_OWNER" }]);
  });

  it("passes no owner for a run that has none (a shared account), leaving the agent's own login", async () => {
    const { calls, infer } = await start();
    await infer(plane!.mint({ agent: "sapien", item: "rec1" }));
    expect(calls).toEqual([{ agent: "sapien", owner: undefined }]);
  });
});
