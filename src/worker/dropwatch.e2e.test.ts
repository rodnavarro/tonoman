// The drop watcher, end to end across the process boundary (drop-watch.md in Tonoman Cloud): the real
// runtime half, the real capability plane over HTTP, and the real Talent started as its own program
// — with the site faked, and no real person's address (D-TEST-ACCOUNTS). Linux only: it starts `tsx`
// the way the worker does; on a developer's Windows machine it is skipped, and says so.
import { describe, it, expect, afterEach } from "vitest";
import { startCapabilityPlane, type CapabilityPlane } from "./capability-plane";
import { dropWatcher, memoryDropStore } from "./lorealistar";
import type { TurnDeps } from "./activities";
import type { Campaign } from "../lorealistar/watch";

const drop: Campaign = { id: "abc-123", type: "DROP", name: "Absolut Repair Molecular Serum", status: "Active", end_date: "2026-09-30T23:59:00Z", initial_qty: 250, claimed_qty: 210, sub_brands: [{ id: "b1", name: "L'Oréal Professionnel" }] };

describe.skipIf(process.platform === "win32")("the drop watcher, across the process boundary", () => {
  let plane: CapabilityPlane | undefined;
  afterEach(async () => {
    await plane?.close();
    plane = undefined;
  });

  it("DROPS-NEW-IS-TOLD-AT-ONCE DROPS-A-PAGE-EACH DROPS-LOGIN-SEALED a look finds a drop; its run — the Talent's own program — files the page and hands back the site's figures; the password never leaves the runtime", async () => {
    const store = memoryDropStore();
    const drops = dropWatcher({
      store,
      now: () => Date.parse("2026-09-20T13:05:00Z"),
      site: {
        signIn: async () => ({ ok: true, session: { accessToken: "access", refreshToken: "refresh", expiresAt: Date.parse("2026-09-20T14:05:00Z") } }),
        renew: async () => ({ ok: false, expired: true, why: "not used" }),
        list: async () => ({ ok: true, campaigns: [drop] }),
      },
    });
    expect((await drops.connect("mia", "USTEF0001", "test+stef@tonoman.com", "pw-not-real")).ok).toBe(true);
    const look = await drops.lookFor("mia", "USTEF0001", "America/New_York");
    expect(look.news).toEqual([{ id: "abc-123", name: "Absolut Repair Molecular Serum" }]);

    const written: { files: { path: string; content: string }[] }[] = [];
    const seenByTalent: string[] = [];
    const deps = {
      agent: () => undefined,
      voice: () => undefined, // Mia has no recording flow
      talentConfig: () => ({}),
      lorealistar: {
        ...drops,
        drop: async (agent: string, user: string, id: string) => {
          const r = await drops.drop(agent, user, id);
          seenByTalent.push(JSON.stringify(r));
          return r;
        },
      },
      talentBrain: {
        target: async () => ({ id: "b-stef", name: "Stef's brain", who: "USTEF0001", brain: { id: "b-stef", tenant: "t", repoUrl: "/r" }, authorize: async () => true }),
        store: { read: async () => null, writeFiles: async (req: { files: { path: string; content: string }[] }) => (written.push(req), { ok: true, paths: req.files.map((f) => f.path), sha: "abc" }) },
      },
    } as unknown as TurnDeps;
    plane = await startCapabilityPlane(deps);

    const outcome = await plane.spawn({ agent: "mia", item: "drop-abc-123", user: "USTEF0001", talent: "drop-watch" });
    expect(outcome.status).toBe("done");
    expect(outcome.say).toBe("New LOREALISTAR drop: *Absolut Repair Molecular Serum* (L'Oréal Professionnel) — 40 of 250 left, until 2026-09-30. https://us.lorealistar.com/activities/drop/abc-123");
    expect(outcome.brains).toEqual(["b-stef"]);
    expect(written).toHaveLength(1);
    expect(written[0]!.files[0]!.path).toBe("Drops/2026-09-20-absolut-repair-molecular-serum-abc-123.md");
    expect(written[0]!.files[0]!.content).toContain("40 of 250 left");
    // What crossed to the Talent's program: the drop, and nothing of the login.
    expect(seenByTalent).toHaveLength(1);
    expect(seenByTalent[0]).not.toMatch(/pw-not-real|tonoman\.com|refresh|"access"/);
    // Its announcement started, it is told — and is not news again.
    await drops.told("mia", "USTEF0001", ["abc-123"]);
    expect((await drops.lookFor("mia", "USTEF0001")).news).toEqual([]);
  }, 60_000);
});
