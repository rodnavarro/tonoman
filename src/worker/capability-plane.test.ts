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

describe("capability plane — what needs no recording flow (talent.md, drop-watch.md in Tonoman Cloud)", () => {
  let plane: CapabilityPlane | undefined;
  afterEach(async () => {
    await plane?.close();
    plane = undefined;
  });

  const start = async (target: unknown, drops: Record<string, Record<string, unknown>> = {}) => {
    const written: { files: { path: string; content: string }[]; note: string }[] = [];
    const asked: { agent: string; user: string; id: string }[] = [];
    const deps = {
      agent: () => undefined,
      // An agent with no recording flow at all: Mia.
      voice: () => undefined,
      talentBrain: {
        target: async () => target,
        store: {
          read: async () => null,
          writeFiles: async (req: { files: { path: string; content: string }[]; note: string }) => {
            written.push(req);
            return { ok: true, paths: req.files.map((f) => f.path), sha: "abc" };
          },
        },
      },
      lorealistar: {
        drop: async (agent: string, user: string, id: string) => {
          asked.push({ agent, user, id });
          const d = drops[`${user}/${id}`];
          return d ? { drop: d, seen: "2026-09-20T13:05:00.000Z" } : undefined;
        },
      },
    } as unknown as TurnDeps;
    plane = await startCapabilityPlane(deps);
    const call = (route: string, token: string, body: unknown) =>
      fetch(`${plane!.url}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { written, asked, call };
  };
  const brain = { id: "b-stef", name: "Stef's brain", who: "USTEF", brain: { id: "b-stef", tenant: "t", repoUrl: "/r" }, authorize: async () => true };
  const mint = (user?: string) => plane!.mint({ agent: "mia", item: "drop-abc", user, talent: "drop-watch" });

  it("TALENT-NEEDS-NO-RECORDINGS a Talent that has nothing to do with recordings is served on an agent with no recording flow; one that does is still refused there", async () => {
    const { call } = await start(brain);
    expect((await call("/cap/page", mint("USTEF"), { path: "Drops/x.md", content: "# x" })).status).toBe(200);
    expect((await call("/cap/transcribe", mint("USTEF"), { audioUrl: "https://x" })).status).toBe(404);
  });

  it("TALENT-FILES-A-PAGE the page goes where the Talent said, in the brain the run is pointed at, and the answer says which", async () => {
    const { written, call } = await start(brain);
    const r = await call("/cap/page", mint("USTEF"), { path: "Drops/2026-09-20-serum-abc.md", content: "# Serum\n40 of 250 left\n", note: "LOREALISTAR drop: Serum" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ filed: true, path: "Drops/2026-09-20-serum-abc.md", brain: "Stef's brain" });
    expect(written).toHaveLength(1);
    expect(written[0]!.files).toEqual([{ path: "Drops/2026-09-20-serum-abc.md", content: "# Serum\n40 of 250 left\n" }]);
    expect(written[0]!.note).toBe("LOREALISTAR drop: Serum");
  });

  it("TALENT-FILES-A-PAGE a path that would leave the brain, or is not a page, is refused and nothing is written", async () => {
    const { written, call } = await start(brain);
    for (const path of ["../outside.md", "/etc/passwd.md", "Drops/../../x.md", "C:/x.md", ".git/config.md", "Drops/x.txt", "Drops//x.md", ""]) {
      expect((await call("/cap/page", mint("USTEF"), { path, content: "x" })).status, path).toBe(400);
    }
    expect((await call("/cap/page", mint("USTEF"), { path: "Drops/x.md", content: "" })).status).toBe(400);
    expect(written).toEqual([]);
  });

  it("TALENT-FILES-A-PAGE a run with no brain to file into, or one it may not write, is told so — and nothing is written", async () => {
    const none = await start(undefined);
    const r = await none.call("/cap/page", mint("USTEF"), { path: "Drops/x.md", content: "x" });
    expect(r.status).toBe(409);
    await plane!.close();
    const refused = await start({ error: "this run cannot write to Engineering" });
    const r2 = await refused.call("/cap/page", mint("USTEF"), { path: "Drops/x.md", content: "x" });
    expect(r2.status).toBe(403);
    expect((await r2.json()).error).toBe("Nothing was filed: this run cannot write to Engineering.");
    expect(refused.written).toEqual([]);
  });

  it("DROPS-LOGIN-SEALED the Talent is told what the site said about a drop — for the person its run is for, whoever it names — and nothing of their login", async () => {
    const drop = { id: "abc", type: "DROP", name: "Serum", status: "Active", initial_qty: 250, claimed_qty: 210 };
    const { asked, call } = await start(brain, { "USTEF/abc": drop });
    // It cannot ask on anyone else's behalf: the person is the run's own, not a field of the request.
    const r = await call("/cap/lorealistar-drop", mint("USTEF"), { id: "abc", user: "UANA" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ drop, seen: "2026-09-20T13:05:00.000Z" });
    expect(asked).toEqual([{ agent: "mia", user: "USTEF", id: "abc" }]);
    expect(JSON.stringify(body)).not.toMatch(/password|email|token/i);
    // A drop the runtime does not have for that person: an empty answer, not somebody else's.
    expect(await (await call("/cap/lorealistar-drop", mint("USTEF"), { id: "nope" })).json()).toEqual({});
    // And a run that is for nobody is refused.
    expect((await call("/cap/lorealistar-drop", mint(undefined), { id: "abc" })).status).toBe(400);
  });
});
