// The runtime's half of the LOREALISTAR drop watcher (docs/definition/objects/drop-watch.md in
// Tonoman Cloud). It holds each person's login and what it has told them, looks on their behalf, and
// hands the Talent only what the site said about a drop — never the login (DROPS-LOGIN-SEALED).
//
// Kept the way Plaud's tokens are: sealed in the Cloud, one secret per person, the person in the
// ref's name (`lorealistar.login:<SlackUserId>`), so "who has connected" is read off the refs and no
// value is ever listed.

import { aliveLine, look, type Campaign, type LookDeps, type WatchState } from "../lorealistar/watch";

export interface DropLogin {
  email: string;
  password: string;
}

/** What is kept per person between looks. No password: that is the login's own secret. */
export interface DropRecord extends WatchState {
  /** Drops seen and not yet let go, by the site's id: what the Talent is told when it asks. */
  pending: Record<string, { drop: Campaign; seen: string }>;
  /** The tenant's day these counters are for, and the counters. */
  day?: string;
  looks: number;
  newToday: string[];
  openNow: number;
}

export interface DropStore {
  loadLogin(agent: string, user: string): Promise<DropLogin | undefined>;
  saveLogin(agent: string, user: string, login: DropLogin): Promise<void>;
  clearLogin(agent: string, user: string): Promise<void>;
  loadState(agent: string, user: string): Promise<DropRecord | undefined>;
  saveState(agent: string, user: string, state: DropRecord): Promise<void>;
  /** Everyone who has connected a login for this agent's tenant. */
  users(agent: string): Promise<string[]>;
}

export interface LookResult {
  /** Drops to announce: new to this person, and not yet marked told. */
  news: { id: string; name: string }[];
  /** Something the person should hear about the watch itself. */
  notice?: string;
  /** Yesterday's one line, on the first look of a new day. */
  alive?: string;
}

const FORGET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const fresh = (): DropRecord => ({ told: [], failures: 0, pending: {}, looks: 0, newToday: [], openNow: 0 });

/** PURE: the tenant's calendar day at this instant. */
export function dayIn(timezone: string | undefined, at: number): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export function dropWatcher(o: { store: DropStore; site: Pick<LookDeps, "signIn" | "renew" | "list">; now?: () => number }) {
  const now = o.now ?? (() => Date.now());
  // One look at a time for one person (DROPS-HOW-OFTEN, DROPS-GENTLE): a second asked for meanwhile
  // waits for the first and then looks at what it left.
  const busy = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (busy.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    busy.set(key, tail);
    void tail.then(() => busy.get(key) === tail && busy.delete(key));
    return run;
  };

  return {
    /** DROPS-LOGIN-PROVED-FIRST: tried against the site before it is kept. */
    async connect(agent: string, user: string, email: string, password: string): Promise<{ ok: boolean; message: string }> {
      const login = { email: email.trim(), password };
      if (!/^\S+@\S+\.\S+$/.test(login.email) || !password) return { ok: false, message: "I need the email and the password you use on LOREALISTAR." };
      return oneAtATime(`${agent}\0${user}`, async () => {
        const si = await o.site.signIn(login).catch((e) => ({ ok: false as const, needsPerson: false, why: String((e as Error)?.message ?? e) }));
        if (!si.ok) {
          return {
            ok: false,
            message: si.needsPerson
              ? `LOREALISTAR did not accept that login (${si.why.replace(/[.\s]+$/, "")}). Nothing was saved.`
              : `I could not reach LOREALISTAR to try that login (${si.why.slice(0, 120)}). Nothing was saved — try again in a moment.`,
          };
        }
        const before = await o.store.loadState(agent, user).catch(() => undefined);
        await o.store.saveLogin(agent, user, login);
        // What had been told stays told; the watch starts again with the session the site just gave.
        await o.store.saveState(agent, user, { ...fresh(), ...(before ?? {}), failures: 0, needsPerson: false, outageTold: false, session: si.session });
        return { ok: true, message: "Connected. I will look for new LOREALISTAR drops every few minutes and tell you the moment one appears." };
      });
    },

    async disconnect(agent: string, user: string): Promise<void> {
      await o.store.clearLogin(agent, user);
    },

    /** One look for one person. Never throws. A new drop stays news until `told` says its
     *  announcement was started — so a worker that stops in between never loses one. */
    lookFor(agent: string, user: string, timezone?: string): Promise<LookResult> {
      return oneAtATime(`${agent}\0${user}`, async () => {
        const login = await o.store.loadLogin(agent, user).catch(() => undefined);
        if (!login) return { news: [] };
        const state: DropRecord = { ...fresh(), ...((await o.store.loadState(agent, user).catch(() => undefined)) ?? {}) };
        const at = now();
        const r = await look(state, login, { ...o.site, now });

        // `look` marks what it found as told; here that waits for the announcement to have started.
        const next: DropRecord = { ...state, ...r.state, told: state.told };
        const seen = new Date(at).toISOString();
        for (const c of r.news) {
          if (!next.pending[c.id]) next.newToday = [...next.newToday, c.name];
          next.pending = { ...next.pending, [c.id]: next.pending[c.id] ?? { drop: c, seen } };
        }
        // What the site no longer lists, and has not for a week, is let go. It stays told.
        if (r.open) {
          const open = new Set(r.open.map((c) => c.id));
          next.pending = Object.fromEntries(Object.entries(next.pending).filter(([id, p]) => open.has(id) || at - Date.parse(p.seen) < FORGET_AFTER_MS));
          next.openNow = r.open.length;
        }

        // The day's one line, on the first look of a new day (DROPS-ALIVE-IS-SAID).
        const today = dayIn(timezone, at);
        let alive: string | undefined;
        if (next.day && next.day !== today) {
          alive = aliveLine({ looks: next.looks, open: next.openNow, newToday: next.newToday });
          next.looks = 0;
          next.newToday = [];
        }
        next.day = today;
        next.looks += 1;

        await o.store.saveState(agent, user, next);
        return { news: r.news.map((c) => ({ id: c.id, name: c.name })), notice: r.notice, alive };
      });
    },

    /** These drops' announcements have been started: they are told, and are not news again. */
    told(agent: string, user: string, ids: string[]): Promise<void> {
      return oneAtATime(`${agent}\0${user}`, async () => {
        const state = await o.store.loadState(agent, user);
        if (!state || !ids.length) return;
        await o.store.saveState(agent, user, { ...state, told: [...new Set([...state.told, ...ids])].slice(-1000) });
      });
    },

    /** What the site said about one drop, for this person. */
    async drop(agent: string, user: string, id: string): Promise<{ drop: Campaign; seen: string } | undefined> {
      const state = await o.store.loadState(agent, user).catch(() => undefined);
      const p = state?.pending?.[id];
      return p ? { drop: p.drop, seen: p.seen } : undefined;
    },

    users: (agent: string): Promise<string[]> => o.store.users(agent),
  };
}
export type DropWatcher = ReturnType<typeof dropWatcher>;

// --------------------------------------------------------------------------------------- stores

/** In memory: for tests. */
export function memoryDropStore(): DropStore {
  const logins = new Map<string, DropLogin>();
  const states = new Map<string, DropRecord>();
  const k = (agent: string, user: string) => `${agent}\0${user}`;
  return {
    loadLogin: async (a, u) => logins.get(k(a, u)),
    saveLogin: async (a, u, l) => void logins.set(k(a, u), l),
    clearLogin: async (a, u) => void (logins.delete(k(a, u)), states.delete(k(a, u))),
    loadState: async (a, u) => states.get(k(a, u)),
    saveState: async (a, u, s) => void states.set(k(a, u), JSON.parse(JSON.stringify(s)) as DropRecord),
    users: async (a) => [...logins.keys()].filter((x) => x.startsWith(`${a}\0`)).map((x) => x.split("\0")[1]!),
  };
}

const LOGIN_REF = "lorealistar.login";
const STATE_REF = "lorealistar.state";
const SLACK_ID = /^[UWB][A-Z0-9]{7,}$/;

/** Sealed in the Cloud, by reference (DROPS-LOGIN-SEALED) — exactly as Plaud's tokens are kept. */
export function cloudDropStore(o: { baseUrl: string; token: string; guidOf: (agent: string) => string | undefined; fetchImpl?: typeof fetch }): DropStore {
  const f = o.fetchImpl ?? globalThis.fetch;
  const auth = { authorization: `Bearer ${o.token}` };
  const url = (agent: string, ref: string): string => {
    const guid = o.guidOf(agent);
    if (!guid) throw new Error(`secrets: ${agent} has no registry id, so nothing of its can be kept`);
    return `${o.baseUrl.replace(/\/+$/, "")}/v1/system/agents/${guid}/secrets/${encodeURIComponent(ref)}`;
  };
  const load = async <T>(agent: string, ref: string): Promise<T | undefined> => {
    const r = await f(url(agent, ref), { headers: auth });
    if (r.status === 404) return undefined;
    // Not "not connected": a row that cannot be read must never be answered by asking to reconnect.
    if (!r.ok) throw new Error(`secrets: ${r.status} reading ${ref.split(":")[0]}`);
    const body = (await r.json()) as { value?: string };
    return body.value ? (JSON.parse(body.value) as T) : undefined;
  };
  const save = async (agent: string, ref: string, value: unknown): Promise<void> => {
    // In the body, never the path: a credential in a URL ends up in access logs at both ends.
    const r = await f(url(agent, ref), { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ value: JSON.stringify(value) }) });
    if (!r.ok) throw new Error(`secrets: ${r.status} storing ${ref.split(":")[0]}`);
  };
  const safe = (user: string): string => {
    if (!SLACK_ID.test(user)) throw new Error("that is not a person's Slack id");
    return user;
  };
  return {
    loadLogin: (a, u) => load<DropLogin>(a, `${LOGIN_REF}:${safe(u)}`),
    saveLogin: (a, u, l) => save(a, `${LOGIN_REF}:${safe(u)}`, l),
    async clearLogin(a, u) {
      for (const ref of [`${LOGIN_REF}:${safe(u)}`, `${STATE_REF}:${safe(u)}`]) await f(url(a, ref), { method: "DELETE", headers: auth }).catch(() => {});
    },
    loadState: (a, u) => load<DropRecord>(a, `${STATE_REF}:${safe(u)}`),
    saveState: (a, u, s) => save(a, `${STATE_REF}:${safe(u)}`, s),
    async users(agent) {
      const guid = o.guidOf(agent);
      if (!guid) return [];
      const r = await f(`${o.baseUrl.replace(/\/+$/, "")}/v1/system/agents/${guid}/secrets`, { headers: auth }).catch(() => undefined);
      if (!r || !r.ok) return [];
      const body = (await r.json().catch(() => undefined)) as { secrets?: { ref: string }[] } | undefined;
      return (body?.secrets ?? []).map((s) => s.ref).filter((ref) => ref.startsWith(`${LOGIN_REF}:`)).map((ref) => ref.slice(LOGIN_REF.length + 1)).filter((u) => SLACK_ID.test(u));
    },
  };
}
