// The runtime's half of the drop watcher: it holds each person's login and what it has told them,
// looks on their behalf, and hands the Talent only what the site said (drop-watch.md in Tonoman Cloud).
// The site is faked; tests never use a real person's address (D-TEST-ACCOUNTS).
import { describe, it, expect } from "vitest";
import { dropWatcher, memoryDropStore, type DropRecord } from "./lorealistar";
import type { Campaign } from "../lorealistar/watch";
import type { Session } from "../lorealistar/srp";

const NOW = Date.parse("2026-09-20T13:05:00Z");
const drop = (id: string, o: Partial<Campaign> = {}): Campaign => ({ id, type: "DROP", name: `Drop ${id}`, status: "Active", initial_qty: 250, claimed_qty: 210, ...o });
const session = (): Session => ({ accessToken: "access", refreshToken: "refresh", expiresAt: NOW + 3_000_000 });

function setup(o: { active?: Campaign[]; refuse?: string } = {}) {
  const store = memoryDropStore();
  const calls: string[] = [];
  let clock = NOW;
  let active = o.active ?? [];
  const w = dropWatcher({
    store,
    now: () => clock,
    site: {
      signIn: async (c) => (calls.push(`signIn:${c.email}`), o.refuse ? { ok: false, needsPerson: true, why: o.refuse } : { ok: true, session: session() }),
      renew: async () => (calls.push("renew"), { ok: true, session: session() }),
      list: async () => (calls.push("list"), { ok: true, campaigns: active }),
    },
  });
  return { w, store, calls, at: (t: string) => void (clock = Date.parse(t)), lists: (a: Campaign[]) => void (active = a) };
}
const login = { email: "test+stef@tonoman.com", password: "pw-not-real" };

describe("connecting", () => {
  it("DROPS-LOGIN-PROVED-FIRST a login is tried against the site before it is kept: one the site refuses is answered with the site's own reason, and nothing is stored", async () => {
    const { w, store } = setup({ refuse: "Incorrect username or password." });
    const r = await w.connect("mia", "USTEF", login.email, login.password);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Incorrect username or password");
    expect(await store.loadLogin("mia", "USTEF")).toBeUndefined();
    expect(await store.users("mia")).toEqual([]);
  });

  it("DROPS-OWN-LOGIN a login that works is kept for that person alone, and the session the site gave is kept with it, so the first look does not sign in again", async () => {
    const { w, store, calls } = setup();
    expect((await w.connect("mia", "USTEF", login.email, login.password)).ok).toBe(true);
    expect(await store.loadLogin("mia", "USTEF")).toEqual(login);
    expect(await store.loadLogin("mia", "UANA")).toBeUndefined();
    expect(await store.users("mia")).toEqual(["USTEF"]);
    await w.lookFor("mia", "USTEF");
    expect(calls).toEqual([`signIn:${login.email}`, "list"]); // DROPS-KEEPS-ITS-SESSION, DROPS-GENTLE
  });

  it("DROPS-SAYS-WHY-IT-STOPPED reconnecting starts the watch again, and what had been told stays told", async () => {
    const { w, store } = setup({ active: [drop("a")] });
    await w.connect("mia", "USTEF", login.email, login.password);
    await w.lookFor("mia", "USTEF");
    await w.told("mia", "USTEF", ["a"]);
    await store.saveState("mia", "USTEF", { ...(await store.loadState("mia", "USTEF"))!, needsPerson: true });
    expect((await w.lookFor("mia", "USTEF")).news).toEqual([]);
    await w.connect("mia", "USTEF", login.email, login.password);
    const s = (await store.loadState("mia", "USTEF"))!;
    expect(s.needsPerson).toBeFalsy();
    expect(s.told).toEqual(["a"]);
  });
});

describe("looking", () => {
  it("DROPS-TOLD-ONCE a drop stays news until its announcement has been started: a worker that stops in between never loses one, and never says one twice after", async () => {
    const { w } = setup({ active: [drop("a")] });
    await w.connect("mia", "USTEF", login.email, login.password);
    expect((await w.lookFor("mia", "USTEF")).news.map((n) => n.id)).toEqual(["a"]);
    // The worker stopped before it could start the announcement: the next look still has it.
    expect((await w.lookFor("mia", "USTEF")).news.map((n) => n.id)).toEqual(["a"]);
    await w.told("mia", "USTEF", ["a"]);
    expect((await w.lookFor("mia", "USTEF")).news).toEqual([]);
  });

  it("DROPS-LOGIN-SEALED what the Talent can ask for is what the site said about a drop — for that person, and nothing of their login", async () => {
    const { w } = setup({ active: [drop("a", { name: "Serum" })] });
    await w.connect("mia", "USTEF", login.email, login.password);
    await w.lookFor("mia", "USTEF");
    const got = await w.drop("mia", "USTEF", "a");
    expect(got?.drop).toMatchObject({ id: "a", name: "Serum", initial_qty: 250 });
    expect(got?.seen).toBe("2026-09-20T13:05:00.000Z");
    expect(JSON.stringify(got)).not.toMatch(/pw-not-real|tonoman\.com|access|refresh/);
    expect(await w.drop("mia", "UANA", "a")).toBeUndefined(); // somebody else's is not theirs
    expect(await w.drop("mia", "USTEF", "zzz")).toBeUndefined();
  });

  it("DROPS-OWN-LOGIN someone who has not connected is not looked for at all", async () => {
    const { w, calls } = setup({ active: [drop("a")] });
    expect(await w.lookFor("mia", "UNOBODY")).toEqual({ news: [] });
    expect(calls).toEqual([]);
  });

  it("DROPS-SAYS-WHY-IT-STOPPED a login the site stops accepting is said once, with how to put it right, and not knocked on again", async () => {
    const { w, store, calls } = setup();
    await w.connect("mia", "USTEF", login.email, login.password);
    // The session is gone and the password no longer works.
    await store.saveState("mia", "USTEF", { ...(await store.loadState("mia", "USTEF"))!, session: undefined });
    const refusing = dropWatcher({ store, now: () => NOW, site: { signIn: async () => (calls.push("signIn-2"), { ok: false, needsPerson: true, why: "Incorrect username or password." }), renew: async () => ({ ok: false, expired: true, why: "x" }), list: async () => ({ ok: true, campaigns: [] }) } });
    const first = await refusing.lookFor("mia", "USTEF");
    expect(first.notice).toMatch(/did not accept your login/i);
    expect(first.notice).toContain("!connect lorealistar");
    const again = await refusing.lookFor("mia", "USTEF");
    expect(again.notice).toBeUndefined();
    expect(calls.filter((c) => c === "signIn-2")).toHaveLength(1);
  });
});

describe("saying it is alive", () => {
  it("DROPS-ALIVE-IS-SAID the first look of a new day says how the day before went — how many looks, what is open, what was new — and a day with nothing new says so", async () => {
    const { w, at, lists } = setup({ active: [drop("a", { name: "Metal Detox" })] });
    await w.connect("mia", "USTEF", login.email, login.password);
    expect((await w.lookFor("mia", "USTEF")).alive).toBeUndefined(); // the first day has no yesterday
    await w.told("mia", "USTEF", ["a"]);
    await w.lookFor("mia", "USTEF");
    at("2026-09-21T13:00:00Z");
    const next = await w.lookFor("mia", "USTEF");
    expect(next.alive).toBe("LOREALISTAR: I looked 2 times today. 1 drop is open; new today: Metal Detox.");
    expect((await w.lookFor("mia", "USTEF")).alive).toBeUndefined(); // once
    lists([]);
    at("2026-09-22T13:00:00Z");
    expect((await w.lookFor("mia", "USTEF")).alive).toBe("LOREALISTAR: I looked 2 times today. No drops are open, and nothing new came up.");
  });

  it("DROPS-ALIVE-IS-SAID a day is the tenant's day, not the server's", async () => {
    const { w, at } = setup();
    await w.connect("mia", "USTEF", login.email, login.password);
    at("2026-09-21T01:00:00Z"); // still the 20th in New York
    await w.lookFor("mia", "USTEF", "America/New_York");
    at("2026-09-21T03:30:00Z"); // 23:30 on the 20th in New York
    expect((await w.lookFor("mia", "USTEF", "America/New_York")).alive).toBeUndefined();
    at("2026-09-21T04:30:00Z"); // 00:30 on the 21st
    expect((await w.lookFor("mia", "USTEF", "America/New_York")).alive).toMatch(/I looked 2 times today/);
  });
});

describe("what is kept", () => {
  it("DROPS-TOLD-ONCE what is remembered about drops does not grow for ever: ones long gone from the site are let go", async () => {
    const { w, store, at, lists } = setup({ active: [drop("a")] });
    await w.connect("mia", "USTEF", login.email, login.password);
    await w.lookFor("mia", "USTEF");
    await w.told("mia", "USTEF", ["a"]);
    lists([]);
    at("2026-10-05T13:00:00Z");
    await w.lookFor("mia", "USTEF");
    const s = (await store.loadState("mia", "USTEF")) as DropRecord;
    expect(Object.keys(s.pending)).toEqual([]);
    expect(s.told).toEqual(["a"]); // still told: if the site lists it again, it is not news
  });
});
