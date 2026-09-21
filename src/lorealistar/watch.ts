// One look at LOREALISTAR for one person: what is new, what to say, and what to do when the site
// will not let it in (docs/definition/objects/drop-watch.md in Tonoman Cloud).
//
// It only looks (DROPS-ONLY-LOOKS): it signs in, lists what is open, and says what it had not said
// before. It claims nothing and changes nothing on the site. It is gentle with the person's account
// (DROPS-GENTLE): a session is kept and renewed, the password is used only when that fails, and a
// login the site has refused is not tried again until the person reconnects.
//
// Everything here is pure, or takes the site as a parameter; `siteOver` is the real one.

import { renew as cognitoRenew, signIn as cognitoSignIn, type Pool, type Renewal, type Session, type SignIn } from "./srp";

/** The site's own sign-in pool (public: it is in the site's pages). */
export const POOL: Pool = { userPoolId: "us-east-1_wDTwPouSP", clientId: "5uau3lmnl89k9paakt8bjurb2a" };
export const SITE = "https://us.lorealistar.com";

// What a drop IS and how it is put into words lives with the Talent that says it (a Talent imports
// nothing that belongs to the runtime); the runtime uses the same.
import { type Campaign } from "../talents/lorealistar/drop-watch/drop";
export { type Campaign, dropFacts, dropLine, dropPage } from "../talents/lorealistar/drop-watch/drop";

/** What is kept between looks, per person. Small, and holds no password. */
export interface WatchState {
  /** The site's ids of drops already told, newest last (DROPS-TOLD-ONCE). */
  told: string[];
  /** Looks that failed in a row. */
  failures: number;
  session?: Session;
  /** The site refused the login: nothing is tried until the person reconnects. */
  needsPerson?: boolean;
  /** The person has been told the site cannot be reached, and is owed a word when it is back. */
  outageTold?: boolean;
}

export type Listing = { ok: true; campaigns: Campaign[] } | { ok: false; unauthorized: boolean; why: string };

export interface LookDeps {
  now(): number;
  signIn(creds: { email: string; password: string }): Promise<SignIn>;
  renew(refreshToken: string): Promise<Renewal>;
  list(accessToken: string): Promise<Listing>;
}

export interface Look {
  state: WatchState;
  /** Drops not told before, to be told now (DROPS-NEW-IS-TOLD-AT-ONCE). */
  news: Campaign[];
  /** Every drop open at this look — for the day's summary. Absent when the look failed. */
  open?: Campaign[];
  /** Something the person should hear about the watch itself. */
  notice?: string;
}

/** A session is renewed when it has less than this left, so a look never starts on one about to die. */
const RENEW_WITHIN_MS = 120_000;
/** Bad looks in a row before the person is told (DROPS-A-BAD-LOOK-IS-NOT-THE-END). */
const TELL_AFTER = 3;
const KEEP_TOLD = 1000;

const isOpenDrop = (c: Campaign): boolean => c.type === "DROP" && c.status === "Active";

/** PURE: the open drops not told before. A drop is known by the site's own id — its name or its
 *  stock changing does not make it new (DROPS-TOLD-ONCE). */
export function newDrops(campaigns: Campaign[], told: string[]): Campaign[] {
  const known = new Set(told);
  return campaigns.filter((c) => isOpenDrop(c) && !known.has(c.id));
}

/** PURE: the day's one line (DROPS-ALIVE-IS-SAID): silence is what a dead watcher sounds like. */
export function aliveLine(day: { looks: number; open: number; newToday: string[] }): string {
  const looked = `LOREALISTAR: I looked ${day.looks} ${day.looks === 1 ? "time" : "times"} today.`;
  const open = day.open === 0 ? "No drops are open" : `${day.open} ${day.open === 1 ? "drop is" : "drops are"} open`;
  if (day.newToday.length) return `${looked} ${open}; new today: ${day.newToday.join(", ")}.`;
  return `${looked} ${open}${day.open === 0 ? "," : ";"} ${day.open === 0 ? "and " : ""}nothing new came up.`;
}

const REFUSED_NOTICE = (why: string): string =>
  `LOREALISTAR did not accept your login (${why.replace(/[.\s]+$/, "")}). I have stopped looking, so your account is not knocked on again. Reconnect with \`!connect lorealistar\` and I will carry on.`;
const OUTAGE_NOTICE = (n: number, why: string): string => `I could not reach LOREALISTAR the last ${n} times I looked (${why}). I will keep trying, and tell you when it is back.`;
const BACK_NOTICE = "LOREALISTAR is answering again. I am watching for drops as before.";

/** One look. Never throws: whatever goes wrong is in the state and, when the person should hear of
 *  it, in the notice. */
export async function look(state: WatchState, creds: { email: string; password: string }, deps: LookDeps): Promise<Look> {
  // DROPS-GENTLE: a login the site has refused is not tried again until the person reconnects.
  if (state.needsPerson) return { state, news: [] };

  const bad = (s: WatchState, why: string): Look => {
    const failures = s.failures + 1;
    const tell = failures >= TELL_AFTER && !s.outageTold;
    return { state: { ...s, failures, outageTold: s.outageTold || tell }, news: [], notice: tell ? OUTAGE_NOTICE(failures, why.slice(0, 120)) : undefined };
  };

  let s: WatchState = { ...state };

  // A session to look with: the one kept, renewed when it is about to run out, and only when it can
  // no longer be renewed, the password (DROPS-KEEPS-ITS-SESSION).
  const fresh = async (): Promise<{ session?: Session; stop?: Look }> => {
    if (s.session?.refreshToken) {
      const r = await deps.renew(s.session.refreshToken).catch((e) => ({ ok: false as const, expired: false, why: String((e as Error)?.message ?? e) }));
      if (r.ok) return { session: { ...r.session, refreshToken: r.session.refreshToken || s.session.refreshToken } };
      if (!r.expired) return { stop: bad(s, r.why) };
    }
    const si = await deps.signIn(creds).catch((e) => ({ ok: false as const, needsPerson: false, why: String((e as Error)?.message ?? e) }));
    if (si.ok) return { session: si.session };
    if (si.needsPerson) return { stop: { state: { ...s, session: undefined, needsPerson: true }, news: [], notice: REFUSED_NOTICE(si.why) } };
    return { stop: bad(s, si.why) };
  };

  if (!s.session || s.session.expiresAt - deps.now() < RENEW_WITHIN_MS) {
    const got = await fresh();
    if (got.stop) return got.stop;
    s = { ...s, session: got.session };
  }

  let listing = await deps.list(s.session!.accessToken).catch((e): Listing => ({ ok: false, unauthorized: false, why: String((e as Error)?.message ?? e) }));
  if (!listing.ok && listing.unauthorized) {
    // The site stopped honouring it early: one renewal, one more try — not a loop.
    const got = await fresh();
    if (got.stop) return got.stop;
    s = { ...s, session: got.session };
    listing = await deps.list(s.session!.accessToken).catch((e): Listing => ({ ok: false, unauthorized: false, why: String((e as Error)?.message ?? e) }));
    if (!listing.ok && listing.unauthorized) return bad({ ...s, session: undefined }, listing.why);
  }
  if (!listing.ok) return bad(s, listing.why);

  const open = listing.campaigns.filter(isOpenDrop);
  const news = newDrops(open, s.told);
  const notice = s.outageTold ? BACK_NOTICE : undefined;
  return {
    state: { ...s, told: [...s.told, ...news.map((c) => c.id)].slice(-KEEP_TOLD), failures: 0, outageTold: false },
    news,
    open,
    notice,
  };
}

// ------------------------------------------------------------------------------------ the real site

/** The site itself: its sign-in pool, and its list of what is open. */
export function siteOver(fetchImpl: typeof fetch = fetch): Pick<LookDeps, "signIn" | "renew" | "list"> {
  return {
    signIn: (creds) => cognitoSignIn(POOL, creds.email, creds.password),
    renew: (refreshToken) => cognitoRenew(POOL, refreshToken),
    list: async (accessToken) => {
      const url = `${SITE}/com/api/v1/campaigns?status=Active&_sort=created_at&_order=desc&participated_only=false&_start=0&_end=50`;
      const r = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 401 || r.status === 403) return { ok: false, unauthorized: true, why: `HTTP ${r.status}` };
      if (!r.ok) return { ok: false, unauthorized: false, why: `HTTP ${r.status}` };
      const j = (await r.json().catch(() => null)) as unknown;
      const rows = Array.isArray(j) ? j : Array.isArray((j as { data?: unknown })?.data) ? (j as { data: unknown[] }).data : null;
      if (!rows) return { ok: false, unauthorized: false, why: "the site's answer was not a list" };
      return { ok: true, campaigns: rows.filter((c): c is Campaign => !!c && typeof (c as Campaign).id === "string") };
    },
  };
}
