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

describe("capability plane /cap/publish — where a Talent files", () => {
  let plane: CapabilityPlane | undefined;
  afterEach(async () => {
    await plane?.close();
    plane = undefined;
  });

  const rec = { id: "rec-1", title: "Offsite", startTime: Date.UTC(2026, 8, 18, 15), endTime: Date.UTC(2026, 8, 18, 15, 30), duration: 1800000, stamp: "2026-09-18T1500" };
  const start = async (target: unknown) => {
    const written: { files: { path: string }[] }[] = [];
    const deps = {
      agent: () => undefined,
      voice: () => ({ timezone: "UTC" }) as VoiceConfig,
      talentBrain: {
        target: async () => target,
        store: {
          read: async () => null,
          writeFiles: async (req: { files: { path: string }[] }) => {
            written.push(req);
            return { ok: true, paths: req.files.map((f) => f.path), sha: "abc" };
          },
        },
      },
    } as unknown as TurnDeps;
    plane = await startCapabilityPlane(deps);
    const publish = (token: string) =>
      fetch(`${plane!.url}/cap/publish`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ rec, recap: { summary: "s", highlights: [], route: "unclassified" }, transcript: "t" }),
      });
    return { written, publish };
  };

  it("BRAIN-TALENT-TARGET a run that cannot file says which brain and why, and nothing is written", async () => {
    const { written, publish } = await start({ error: "this run cannot write to Engineering" });
    const r = await publish(plane!.mint({ agent: "sapien", item: "rec-1", user: "UANA", talent: "meeting-recap" }));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("Nothing was filed: this run cannot write to Engineering.");
    expect(written).toEqual([]);
  });

  it("BRAIN-TALENT-TARGET a run that can files the page and its transcript into that brain, and says which", async () => {
    const target = { id: "b-ana", name: "Ana's brain", who: "UANA", brain: { id: "b-ana", tenant: "t", repoUrl: "/r" }, authorize: async () => true };
    const { written, publish } = await start(target);
    const r = await publish(plane!.mint({ agent: "sapien", item: "rec-1", user: "UANA", talent: "meeting-recap" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ published: true, brain: "Ana's brain" });
    expect(written[0].files.map((f) => f.path.endsWith("Transcript.md"))).toEqual([false, true]);
  });
});
