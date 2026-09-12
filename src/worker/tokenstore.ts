// Where a connected account's tokens live.
//
// They lived on the volume, in the file the Plaud CLI itself writes. That was right while the only
// connected account was Rod's: the file is next to the thing that uses it, and `plaud` and this
// process agreed about who was signed in.
//
// It stops being right the moment the account belongs to a customer. A file on a PVC is not
// backed up, is readable by anything that can exec into the pod, has no audit trail, and answers
// no question the Hub needs to ask — "is Celine's Plaud about to expire" is a `stat` and a JSON
// parse per agent, or it is a query. And a volume that follows one workload is not somewhere a
// second workload can read from at all.
//
// So this file is the seam. One interface, two implementations, and every reader goes through it —
// which is the point. The per-agent Claude credential shipped this morning needed FIVE separate
// fixes because each call site was moved on its own, and every partial move produced a plausible
// wrong answer instead of a clean failure: a login that had worked reported as failed, two agents
// reporting one quota. There are five token call sites here too. They move together or not at all.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { homeFor } from "./plaudcli";

/** What Plaud's token endpoint returns, plus the one field we add. Field names are theirs. */
export interface TokenSet {
  access_token?: string;
  refresh_token?: string;
  /** Seconds of life, as returned — not a deadline. */
  expires_in?: number;
  /** Ours: the deadline computed at store time, so a restart does not think yesterday's token is
   *  fresh. */
  expires_at?: number;
  [k: string]: unknown;
}

export interface TokenStore {
  /** A Plaud account belongs to a PERSON — two teammates on one agent have two of them — so every
   *  method takes an optional `user`: absent for the agent's one shared token (every account before
   *  per-person existed, and still Sapien's), present for a member's own. The user does not travel
   *  as part of the agent string; each store maps it to where that person's tokens live — a nested
   *  home on the volume, a scoped ref in the registry — which is what keeps one member's account
   *  from ever reading, or overwriting, another's. */
  load(agent: string, user?: string): Promise<TokenSet | undefined>;
  save(agent: string, tokens: TokenSet, user?: string): Promise<void>;
  clear(agent: string, user?: string): Promise<void>;
  /** The MEMBERS who have connected their own account under this agent — the per-person accounts the
   *  poll fans out over. The shared account is never in this list (it has no member). `connectedAt`
   *  is the account's own floor, so a member who joins today does not backfill the tenant's history.
   *  Empty is the ordinary state for a shared tenant, and for a per-person one before anyone connects. */
  listUsers(agent: string): Promise<{ user: string; connectedAt?: number }[]>;
  /** For `!status`, and for saying which of these two is in use without inferring it. */
  readonly where: string;
}

// --- Whose account -------------------------------------------------------------------------------

/** The registry ref for a person's own Plaud tokens, under the agent. The user id is part of the
 *  REF, not the row shape — scope lives in the ref, same as `plaud.tokens:<name>` always could. */
export function plaudRefFor(base: string, user?: string): string {
  return user ? `${base}:${user}` : base;
}

/** A Slack user or bot id: `U…`/`W…` (users) or `B…` (bots), all-caps alphanumeric. The scope
 *  suffix on a per-person ref is ALWAYS one of these, which is what lets `userFromPlaudRef`
 *  distinguish a member's account from a per-AGENT secret like `plaud.tokens:sapien10` — the agent
 *  name is not a Slack id, so it never parses as a member and never gets polled as one. */
export const SLACK_ID = /^[UWB][A-Z0-9]{7,}$/;

/** The user id back out of a per-person ref (`plaud.tokens:<user>`), for the poll and the roster.
 *  Returns undefined unless the suffix is a Slack id — so `plaud.tokens` (shared) and any
 *  per-agent-scoped ref are read as "not a member", never as one. */
export function userFromPlaudRef(ref: string | undefined, base = "plaud.tokens"): string | undefined {
  if (!ref || !ref.startsWith(`${base}:`)) return undefined;
  const suffix = ref.slice(base.length + 1);
  return SLACK_ID.test(suffix) ? suffix : undefined;
}

// --- The volume ----------------------------------------------------------------------------------

/** The CLI's own file. Still the fallback, and still what a single-tenant self-hosted install
 *  wants: no registry to talk to, no network call in the poll path. */
export function fileStore(root?: string): TokenStore {
  // The per-member home is nested UNDER the agent's, so a member's tokens live at
  // `<agent home>/users/<user>/.plaud/tokens.json` and the shared account keeps the exact original
  // path — `homeFor(agent, undefined, root)` is the old `homeFor(agent, root)`.
  const at = (agent: string, user?: string): string =>
    path.join(homeFor(agent, user, root), ".plaud", "tokens.json");
  return {
    where: "the volume",
    async load(agent, user) {
      try {
        return JSON.parse(await fsp.readFile(at(agent, user), "utf8")) as TokenSet;
      } catch {
        return undefined;
      }
    },
    async save(agent, tokens, user) {
      await fsp.mkdir(path.dirname(at(agent, user)), { recursive: true });
      await fsp.writeFile(at(agent, user), JSON.stringify(tokens, null, 2), "utf8");
    },
    async clear(agent, user) {
      await fsp.rm(at(agent, user), { force: true }).catch(() => {});
    },
    async listUsers(agent) {
      // The members are the subdirectories of `<agent home>/users` that actually hold a token file —
      // a half-finished login that only wrote `pending-login.json` is not a connected account.
      const dir = path.join(homeFor(agent, undefined, root), "users");
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return []; // no per-member logins yet — the ordinary state
      }
      const out: { user: string; connectedAt?: number }[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const user = decodeURIComponent(e.name);
        const tokenFile = path.join(dir, e.name, ".plaud", "tokens.json");
        const st = await fsp.stat(tokenFile).catch(() => undefined);
        if (!st) continue;
        out.push({ user, connectedAt: st.mtimeMs });
      }
      return out;
    },
  };
}

// --- Tonoman Cloud -------------------------------------------------------------------------------

export interface CloudOptions {
  baseUrl: string;
  token: string;
  /** Local agent name to registry guid. The worker knows agents by `<tenant>-<name>`; the API
   *  knows them by uuid, and resolves the TENANT itself from that uuid — which is why a worker can
   *  never name a tenant it does not belong to. */
  guidOf(agent: string): string | undefined;
  /** Which secret. Per-tenant by default: `plaud.tokens` (the one SHARED account). A member's own
   *  is `plaud.tokens:<slack-id>` — the suffix is always a Slack id (see `SLACK_ID`), which is what
   *  keeps a member's account distinct from the shared one; scope lives in the ref, no schema change. */
  ref?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Tokens as an encrypted row, through the registry.
 *
 * The worker never holds the key and never talks to Postgres. It asks the API for a credential and
 * gets a credential; the decryption, the audit row and the tenant scoping all happen on the other
 * side of that call. That is deliberate — this process already holds Slack tokens and Claude
 * credentials, and giving it the KEK as well would make one compromised pod the whole estate.
 */
export function cloudStore(o: CloudOptions): TokenStore {
  const ref = o.ref ?? "plaud.tokens";
  const f = o.fetchImpl ?? globalThis.fetch;

  // A member's own tokens are a scoped ref UNDER the tenant's — `plaud.tokens:<user>` — so scope
  // lives in the ref, not in a second row shape, and the shared account keeps the bare `plaud.tokens`
  // ref unchanged (`plaudRefFor(ref, undefined) === ref`).
  const refFor = (user?: string): string => plaudRefFor(ref, user);
  const url = (agent: string, user?: string): string | undefined => {
    const guid = o.guidOf(agent);
    return guid
      ? `${o.baseUrl}/v1/system/agents/${guid}/secrets/${encodeURIComponent(refFor(user))}`
      : undefined;
  };
  const auth = { authorization: `Bearer ${o.token}` };

  return {
    where: "Tonoman Cloud, encrypted",
    async load(agent, user) {
      const u = url(agent, user);
      if (!u) return undefined;
      const r = await f(u, { headers: auth }).catch(() => undefined);
      // 404 is "not connected", which is the ordinary state of a tenant who has not connected.
      if (!r || r.status === 404) return undefined;
      if (!r.ok) {
        // Anything else — a 500 from a failed decrypt, a 503 from a missing key — must NOT read as
        // "not connected". A caller that took it that way would offer to reconnect an account that
        // is connected, and the reconnect would overwrite a row we simply could not read.
        throw new Error(`secrets: ${r.status} reading ${refFor(user)}`);
      }
      const body = (await r.json()) as { value?: string };
      if (!body.value) return undefined;
      try {
        return JSON.parse(body.value) as TokenSet;
      } catch {
        throw new Error(`secrets: ${refFor(user)} is not JSON`);
      }
    },
    async save(agent, tokens, user) {
      const u = url(agent, user);
      if (!u) throw new Error(`secrets: ${agent} has no registry guid, so its tokens have nowhere to go`);
      const r = await f(u, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        // In the body, never the path: a credential in a URL ends up in access logs at both ends.
        body: JSON.stringify({ value: JSON.stringify(tokens) }),
      });
      if (!r.ok) throw new Error(`secrets: ${r.status} storing ${refFor(user)}`);
    },
    async clear(agent, user) {
      const u = url(agent, user);
      if (!u) return;
      await f(u, { method: "DELETE", headers: auth }).catch(() => {});
    },
    async listUsers(agent) {
      // The secrets list route returns REFS, never values, so this asks "who has a Plaud account" as
      // one call and reads the answer out of the ref names — the same place scope has always lived.
      // Secrets are tenant-scoped, so two voice agents in one tenant see the same members; that is
      // already true of the shared `plaud.tokens` and is consistent.
      const guid = o.guidOf(agent);
      if (!guid) return [];
      const r = await f(`${o.baseUrl}/v1/system/agents/${guid}/secrets`, { headers: auth }).catch(() => undefined);
      if (!r || !r.ok) return [];
      const body = (await r.json().catch(() => undefined)) as { secrets?: { ref: string; createdAt?: string }[] } | undefined;
      const out: { user: string; connectedAt?: number }[] = [];
      for (const s of body?.secrets ?? []) {
        const user = userFromPlaudRef(s.ref, ref);
        if (!user) continue; // the bare `plaud.tokens`, an `ics.url:x`, anything that is not a member
        const t = s.createdAt ? Date.parse(s.createdAt) : NaN;
        out.push({ user, connectedAt: Number.isNaN(t) ? undefined : t });
      }
      return out;
    },
  };
}

// --- Which one -----------------------------------------------------------------------------------

let current: TokenStore | undefined;

/** Chosen once at boot. Cloud when there is a registry to talk to, the volume otherwise, so an
 *  existing self-hosted deployment does not change behaviour by upgrading. */
export function chooseStore(env: NodeJS.ProcessEnv, guidOf: (agent: string) => string | undefined): TokenStore {
  const baseUrl = env.TONOMANCLOUD_API_URL;
  if (!baseUrl || env.TONOMAN_TOKENS_ON_VOLUME === "1") return fileStore();
  return cloudStore({ baseUrl, token: env.TONOMANCLOUD_API_TOKEN ?? "", guidOf });
}

/** Install the store the process will use. Called once, from the worker's startup. */
export function useStore(s: TokenStore): void {
  current = s;
}

/** The store in force. Defaults to the volume so that a unit test, a CLI invocation, or any path
 *  that never called `useStore` behaves exactly as it did before this file existed. */
export function tokens(): TokenStore {
  return (current ??= fileStore());
}

/** The store for a call that named an explicit root.
 *
 *  An explicit `root` has always meant "this directory on disk", and it still does. Without this,
 *  every `root` argument in the codebase would be silently ignored the moment the cloud store is
 *  installed — the signatures would keep claiming something the functions no longer honoured, and
 *  the tests that pass one would be exercising the wrong store while still going green. */
export function storeFor(root?: string): TokenStore {
  return root ? fileStore(root) : tokens();
}

/** Only for tests, which need to put it back. */
export function resetStore(): void {
  current = undefined;
}

/** Stamp a deadline on a token set, so a restart can tell a fresh token from a day-old one.
 *  Lives here because both the login and the refresh have to do it identically — and when they did
 *  not, a token minted yesterday looked immortal. */
export function stamp(t: TokenSet): TokenSet {
  return typeof t.expires_in === "number" ? { ...t, expires_at: Date.now() + t.expires_in * 1000 } : t;
}
