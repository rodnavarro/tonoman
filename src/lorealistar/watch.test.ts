// One look at LOREALISTAR for one person: what is new, what to say, and what to do when the site
// will not let it in (docs/definition/objects/drop-watch.md in Tonoman Cloud). The site and the
// sign-in service are both faked; the shapes are the real ones, taken from the site on 2026-09-20.
import { describe, it, expect } from "vitest";
import { look, newDrops, dropFacts, dropPage, aliveLine, type WatchState, type LookDeps, type Campaign } from "./watch";
import type { Session } from "./srp";

/** A campaign as the site gives it (the fields a real one has). */
const drop = (o: Partial<Campaign> & { id: string }): Campaign => ({
  type: "DROP",
  name: "Absolut Repair Molecular Serum",
  status: "Active",
  start_date: "2026-09-20T13:00:00Z",
  end_date: "2026-09-30T23:59:00Z",
  image_url: "https://cdn.example/x.jpg",
  initial_qty: 250,
  claimed_qty: 210,
  max_claimed: 1,
  user_claimed_qty: 0,
  points_reward: 0,
  sub_brands: [{ id: "b1", name: "L'Oréal Professionnel" }],
  ...o,
});

const session = (over: Partial<Session> = {}): Session => ({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_000_000, ...over });

function deps(o: { active?: Campaign[]; signIn?: LookDeps["signIn"]; renew?: LookDeps["renew"]; list?: LookDeps["list"] } = {}) {
  const calls: string[] = [];
  const d: LookDeps = {
    now: () => 1_800_000_000_000,
    signIn: o.signIn ?? (async () => (calls.push("signIn"), { ok: true, session: session({ expiresAt: 1_800_000_000_000 + 3_600_000 }) })),
    renew: o.renew ?? (async () => (calls.push("renew"), { ok: true, session: session({ accessToken: "renewed", expiresAt: 1_800_000_000_000 + 3_600_000 }) })),
    list: o.list ?? (async () => (calls.push("list"), { ok: true, campaigns: o.active ?? [] })),
  };
  return { d, calls };
}
const creds = { email: "test+stef@tonoman.com", password: "pw" };
const fresh = (): WatchState => ({ told: [], failures: 0 });

describe("what is new", () => {
  it("DROPS-TOLD-ONCE a drop is known by the site's own id: one already told is not new, however its name or its stock has changed", () => {
    const a = drop({ id: "aaa" });
    const b = drop({ id: "bbb", name: "Metal Detox", claimed_qty: 5 });
    expect(newDrops([a, b], ["aaa"]).map((c) => c.id)).toEqual(["bbb"]);
    expect(newDrops([{ ...a, name: "Renamed", claimed_qty: 249 }], ["aaa"])).toEqual([]);
  });

  it("DROPS-NEW-IS-TOLD-AT-ONCE the figures are the site's: how many are left is what it started with less what is claimed, never below nothing", () => {
    expect(dropFacts(drop({ id: "a", initial_qty: 250, claimed_qty: 210 }))).toMatchObject({ left: 40, of: 250, brand: "L'Oréal Professionnel", link: "https://us.lorealistar.com/activities/drop/a" });
    expect(dropFacts(drop({ id: "a", initial_qty: 10, claimed_qty: 12 })).left).toBe(0);
    // A figure the site did not give is said to be unknown, not made up.
    expect(dropFacts(drop({ id: "a", initial_qty: undefined as never })).left).toBeNull();
  });

  it("DROPS-A-PAGE-EACH each drop is a page: what it was, when it appeared, its figures then", () => {
    const page = dropPage(drop({ id: "abc-123" }), new Date("2026-09-20T13:05:00Z"));
    expect(page.path).toBe("Drops/2026-09-20-absolut-repair-molecular-serum-abc-123.md");
    expect(page.content).toContain("# Absolut Repair Molecular Serum");
    expect(page.content).toContain("40 of 250 left");
    expect(page.content).toContain("https://us.lorealistar.com/activities/drop/abc-123");
    expect(page.content).toContain("id: abc-123");
  });
});

describe("one look", () => {
  it("DROPS-KEEPS-ITS-SESSION with a session that still works, a look is one request: no sign-in, no renewal", async () => {
    const { d, calls } = deps({ active: [drop({ id: "n1" })] });
    const r = await look({ ...fresh(), session: session({ expiresAt: 1_800_000_000_000 + 600_000 }) }, creds, d);
    expect(calls).toEqual(["list"]);
    expect(r.news.map((c) => c.id)).toEqual(["n1"]);
    expect(r.state.told).toEqual(["n1"]);
  });

  it("DROPS-KEEPS-ITS-SESSION a session about to run out is renewed with what the site gave — the password is not used", async () => {
    const { d, calls } = deps();
    await look({ ...fresh(), session: session({ expiresAt: 1_800_000_000_000 + 30_000 }) }, creds, d);
    expect(calls).toEqual(["renew", "list"]);
  });

  it("DROPS-KEEPS-ITS-SESSION only when it can no longer be renewed is the password used again", async () => {
    const { d, calls } = deps({ renew: async () => ({ ok: false, expired: true, why: "Refresh Token has expired" }) });
    const r = await look({ ...fresh(), session: session({ expiresAt: 0 }) }, creds, d);
    expect(calls).toEqual(["signIn", "list"]);
    expect(r.state.session?.accessToken).toBe("access");
  });

  it("DROPS-TOLD-ONCE looked at again, the same drop is not news", async () => {
    const { d } = deps({ active: [drop({ id: "n1" })] });
    const first = await look(fresh(), creds, d);
    const again = await look(first.state, creds, d);
    expect(first.news).toHaveLength(1);
    expect(again.news).toEqual([]);
  });

  it("DROPS-SAYS-WHY-IT-STOPPED a login the site refuses stops the watch and is said once — and is not tried again until the person reconnects", async () => {
    const { d, calls } = deps({ signIn: async () => (calls.push("signIn"), { ok: false, needsPerson: true, why: "Incorrect username or password." }) });
    const r = await look(fresh(), creds, d);
    expect(r.notice).toMatch(/did not accept your login/i);
    expect(r.notice).toMatch(/!connect lorealistar/);
    expect(r.state.needsPerson).toBe(true);
    const again = await look(r.state, creds, d);
    expect(calls).toEqual(["signIn"]); // DROPS-GENTLE: not knocked on again
    expect(again.notice).toBeUndefined();
  });

  it("DROPS-SAYS-WHY-IT-STOPPED a session the site stops honouring mid-look is one renewal and one more try, not a loop", async () => {
    let n = 0;
    const { d, calls } = deps({ list: async () => (calls.push("list"), n++ === 0 ? { ok: false, unauthorized: true, why: "401" } : { ok: true, campaigns: [] }) });
    const r = await look({ ...fresh(), session: session({ expiresAt: 1_800_000_000_000 + 600_000 }) }, creds, d);
    expect(calls).toEqual(["list", "renew", "list"]);
    expect(r.state.failures).toBe(0);
  });

  it("DROPS-A-BAD-LOOK-IS-NOT-THE-END the site being down is tried again next time, quietly; after several in a row the person is told once, and told when it is back", async () => {
    const { d } = deps({ list: async () => ({ ok: false, unauthorized: false, why: "HTTP 503" }) });
    let s: WatchState = { ...fresh(), session: session({ expiresAt: 1_800_000_000_000 + 600_000 }) };
    const notices: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await look(s, creds, d);
      s = r.state;
      notices.push(r.notice);
    }
    expect(notices.filter(Boolean)).toHaveLength(1);
    expect(notices[2]).toMatch(/could not reach LOREALISTAR/i);
    const back = await look(s, creds, deps().d);
    expect(back.notice).toMatch(/again/i);
    expect(back.state.failures).toBe(0);
  });

  it("DROPS-ONLY-LOOKS only drops count, and only open ones: a survey, or a drop that has ended, is not news", async () => {
    const { d } = deps({ active: [drop({ id: "s1", type: "SURVEY" }), drop({ id: "d1", status: "Completed" }), drop({ id: "d2" })] });
    expect((await look(fresh(), creds, d)).news.map((c) => c.id)).toEqual(["d2"]);
  });
});

describe("saying it is alive", () => {
  it("DROPS-ALIVE-IS-SAID a day with nothing new says so in a line: silence is what a dead watcher sounds like", () => {
    expect(aliveLine({ looks: 281, open: 0, newToday: [] })).toBe("LOREALISTAR: I looked 281 times today. No drops are open, and nothing new came up.");
    expect(aliveLine({ looks: 281, open: 2, newToday: ["Metal Detox"] })).toBe("LOREALISTAR: I looked 281 times today. 2 drops are open; new today: Metal Detox.");
  });
});
