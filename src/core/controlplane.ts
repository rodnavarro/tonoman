// Where the gateway's roster comes from (§1, the OSS/Cloud seam).
//
// Tonoman OSS owns the runtime: connectors, the router, the turn queue, the harness. It does NOT
// own multi-tenancy. But something has to answer "which agents do I serve", and that answer is
// exactly where the two products differ:
//
//   FileControlPlane      a settings.json on disk. What a self-hosted Tonoman uses, and what every
//                         existing deployment uses today. No Cloud, no database, no network.
//
//   RegistryControlPlane  a Tonoman Cloud registry over HTTP. Agents are ROWS, so creating one is
//                         an INSERT and renaming one takes effect on reload — rather than a pull
//                         request against infrastructure.
//
// Keeping this as one small interface is what stops multi-tenancy leaking into the runtime. The
// router, the queue and the harness never learn which one they are running under.
//
// Credentials are the part worth being careful about. The registry stores REFERENCES
// (`<secret>:<key>`), never tokens, and this resolver reads them from secrets mounted into the
// gateway's own pod. So a token is never in the database, never in an API response, and never in
// the roster that crosses the network — it is read from a file by the process that needs it.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentConfig, Config } from "../config";
import { load as loadFile } from "../config";

export interface ControlPlane {
  /** A name for logs — which plane answered. */
  name(): string;
  /** The roster to serve. Called at boot, and again on reload. */
  roster(): Promise<Config>;
}

/** The OSS default: read settings.json. */
export class FileControlPlane implements ControlPlane {
  constructor(private readonly path: string) {}
  name(): string {
    return `file:${this.path}`;
  }
  roster(): Promise<Config> {
    return loadFile(this.path);
  }
}

/** One agent as the registry describes it. Deliberately a plain shape rather than the Cloud
 *  schema's: this is a wire contract between two repositories, so it changes on purpose. */
export interface RegistryAgent {
  guid: string;
  name: string;
  tenant: string;
  tenantId: string;
  role?: string | null;
  harness?: string | null;
  model?: string | null;
  maxTurns?: number | null;
  identity?: string | null;
  authState?: string | null;
  inferenceMode?: string | null;
  credentialSecretRef?: string | null;
  channel: string;
  teamId: string;
  botTokenRef?: string | null;
  appTokenRef?: string | null;
  allowedUsers?: string[] | null;
  principals?: { kind: string; value: string; label: string }[];
  /** flow → key → value, straight from `flow_property`. Opaque to the registry by design. */
  flows?: Record<string, Record<string, string>>;
  /** What the TENANT is trying to do. One sentence, shared by every agent the tenant has. */
  mission?: string;
  /** The tenant's display timezone, IANA. */
  timezone?: string;
  tools?: string[];
  /** Talents GRANTED and enabled for this agent — the catalogue row (name, version, requires) plus
   *  the per-agent attachment's `config`. The registry has already filtered to enabled grants; the
   *  worker finds the one that drives the voice flow by NAME (a Talent is code, not wire steps). */
  talents?: {
    id: string;
    name: string;
    description?: string | null;
    requires?: unknown;
    version: number;
    config?: Record<string, unknown>;
  }[];
  secondbrain?: {
    id: string;
    label: string;
    repoUrl: string;
    branch?: string;
    subpath?: string;
    authKind?: string;
    secretRef?: string | null;
    readOnly?: boolean;
  }[];
  /** Outside credentials this agent has been GRANTED, identified by `(kind, alias)`. The alias is
   *  what makes more than one of a kind possible — a work calendar and a personal one are both
   *  `google`. `secretRef` names a row in the registry's `secret` table; the material never
   *  travels on the roster. */
  credentials?: {
    id: string;
    kind: string;
    alias: string;
    label?: string | null;
    /** 'shared' (one account for the whole tenant) or 'per_person' (each member's own). */
    scope?: string;
    /** The accounts implementing this connection. A shared connection has one, with `accountId`
     *  null; a per-person one has an account per member. The secret material never travels — only
     *  the `secretRef` into the gateway's mounted secret tree. */
    accounts?: {
      accountId?: string | null;
      externalAccount?: string | null;
      secretRef?: string | null;
      status?: string | null;
      expiresAt?: string | null;
    }[];
  }[];
}

export interface RegistryOptions {
  /** e.g. http://tonomancloud-api.prod-tonoman-cloud.svc.cluster.local:8080 */
  baseUrl: string;
  /** Bearer for /v1/system/*. Without it the API refuses, which is the intended failure. */
  token: string;
  /** Where mounted secrets live; a ref `foo:BAR` resolves to <secretsDir>/foo/BAR. */
  secretsDir?: string;
  /** Where to materialize each agent's identity, since the harness takes a FILE. */
  identityDir?: string;
  /** State root for the resulting Config. */
  stateRoot?: string;
  fetchImpl?: typeof fetch;
}

export class RegistryControlPlane implements ControlPlane {
  constructor(private readonly o: RegistryOptions) {}

  name(): string {
    return `registry:${this.o.baseUrl}`;
  }

  private get secretsDir(): string {
    return this.o.secretsDir ?? "/etc/tonoman/secrets";
  }
  private get identityDir(): string {
    return this.o.identityDir ?? "/root/.tonoman/identity";
  }

  /** Resolve `<secret>:<key>` from the mounted secret tree. Returns "" when the ref is absent or
   *  unreadable — the caller decides whether that is fatal, because a missing bot token should
   *  disable ONE agent, never stop the gateway serving the others. */
  private async resolveRef(ref: string | null | undefined): Promise<string> {
    if (!ref) return "";
    const i = ref.indexOf(":");
    if (i < 0) return "";
    const secret = ref.slice(0, i);
    const key = ref.slice(i + 1);
    // Refuse anything that could climb out of the mount: a ref comes from the database, and the
    // database is edited through a web form.
    if (!/^[A-Za-z0-9._-]+$/.test(secret) || !/^[A-Za-z0-9._-]+$/.test(key)) return "";
    try {
      return (await fs.readFile(path.join(this.secretsDir, secret, key), "utf8")).trim();
    } catch {
      return "";
    }
  }

  /** The harness takes an identity FILE, and the registry holds identity TEXT. Writing it out on
   *  each roster load is what makes an edit in the Hub take effect on reload. */
  private async writeIdentity(name: string, identity: string): Promise<string | undefined> {
    if (!identity.trim()) return undefined;
    const file = path.join(this.identityDir, `${name.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
    await fs.mkdir(this.identityDir, { recursive: true });
    await fs.writeFile(file, identity, "utf8");
    return file;
  }

  async roster(): Promise<Config> {
    const f = this.o.fetchImpl ?? globalThis.fetch;
    const r = await f(`${this.o.baseUrl}/v1/system/roster`, {
      headers: { authorization: `Bearer ${this.o.token}` },
    });
    if (!r.ok) {
      throw new Error(`registry: roster ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    const body = (await r.json()) as { agents: RegistryAgent[] };

    const agents: AgentConfig[] = [];
    for (const a of body.agents) {
      // The agent's STABLE identity is its guid, and that is now what keys the worker end to end —
      // the `wired` map, the Temporal workflow inputs, the session store, the on-disk credential and
      // identity dirs. It was `${a.tenant}-${a.name}`, which changed the moment somebody renamed the
      // agent: the rename re-keyed everything and orphaned the login on disk. The guid never moves,
      // so a rename is now invisible to the worker's plumbing and reaches only how the agent calls
      // itself (displayName). The tenant-prefixed name lives on as `label`, for logs and the
      // TONOMAN_AGENTS filter, where a human — not the machine — is the reader.
      const label = `${a.tenant}-${a.name}`;
      const localName = a.guid || label;

      if (a.channel !== "slack") {
        console.error(`registry: skipping ${label} — channel "${a.channel}" is not wired here yet`);
        continue;
      }
      const [botToken, appToken] = await Promise.all([
        this.resolveRef(a.botTokenRef),
        this.resolveRef(a.appTokenRef),
      ]);
      if (!botToken || !appToken) {
        // One agent's missing credential must not take the whole gateway down with it.
        console.error(
          `registry: skipping ${label} — could not resolve ${!botToken ? "bot" : "app"} token ` +
            `(looked under ${this.secretsDir})`,
        );
        continue;
      }

      const identityFile = await this.writeIdentity(localName, a.identity ?? "");

      agents.push({
        guid: a.guid,
        name: localName,
        // The tenant's own name for the agent, unprefixed — what it calls itself. `name` above is
        // now the guid; this is the one a person set and can rename, and the same whitelist hazard
        // applies: added at both ends, dropped here, it would vanish.
        displayName: a.name,
        // The tenant slug, carried so the worker can render the readable `${tenant}-${displayName}`
        // label in logs and match TONOMAN_AGENTS — the human-facing name that `name` used to be.
        tenant: a.tenant,
        // Empty on purpose: no per-agent container, because the pod is the sandbox. The harness
        // reads this to choose local-exec over `podman exec`.
        container: "",
        role: a.role ?? undefined,
        harness: (a.harness as AgentConfig["harness"]) ?? "claude-code",
        model: a.model ?? undefined,
        max_turns: a.maxTurns ?? undefined,
        system_prompt_file: identityFile,
        // Carried through so the runtime can refuse a turn and ask for a login, rather than
        // spending one to discover there is no credential.
        auth_state: (a.authState as AgentConfig["auth_state"]) ?? "unconfigured",
        // Shared unless the registry says per-person, so an agent with no opinion (and every
        // file-roster agent) keeps the single shared login.
        inference_mode: a.inferenceMode === "per_user" ? "per_user" : "shared",
        principals: a.principals ?? [],
        flows: a.flows ?? {},
        // Mapped EXPLICITLY, like everything else here. This mapping is a whitelist by design — the
        // runtime takes only what it understands — and the cost of that is real: a field added to
        // the roster and to the worker, but not to this list, is silently dropped in between. The
        // recap simply came out with no Alignment section, which looks exactly like a model
        // declining to judge.
        mission: a.mission ?? "",
        // Mapped here too, and this is the field that taught the lesson: `mission` was added to the
        // registry, the roster and the voice flow, and dropped in this whitelist in between.
        timezone: a.timezone ?? "UTC",
        // Same whitelist, same hazard: the voice flow finds its Talent by NAME among these grants,
        // so a Talent that arrives on the roster but is dropped here would leave the voice flow with
        // no grant and silently idle. A Talent is code, so only name/version/config travel.
        talents: (a.talents ?? []).map((s) => ({
          name: s.name,
          version: s.version,
          config: s.config,
        })),
        // Present only when the tool is granted — the registry decides, not the runtime.
        secondbrain: (a.secondbrain ?? []).map((s) => ({
          id: s.id,
          label: s.label,
          repo_url: s.repoUrl,
          branch: s.branch,
          subpath: s.subpath,
          auth_kind: s.authKind,
          secret_ref: s.secretRef,
          read_only: s.readOnly,
        })),
        // A connection is a definition; its accounts arrive in `accounts`. The FLAT fields below
        // carry the SHARED account (the one every member uses, `accountId` null), which is every
        // connection today — so the calendar loop, contextNote and the `!connect` roster patch keep
        // reading `secret_ref`/`status` unchanged. `scope` and the full `accounts` ride along for
        // the per-member voice flow. Same whitelist hazard as everything else here: an account field
        // added to the roster and dropped in this map vanishes with no error.
        credentials: (a.credentials ?? []).map((c) => {
          const accounts = c.accounts ?? [];
          const shared = accounts.find((x) => (x.accountId ?? null) === null) ?? accounts[0];
          return {
            id: c.id,
            kind: c.kind,
            alias: c.alias,
            label: c.label ?? undefined,
            external_account: shared?.externalAccount ?? undefined,
            secret_ref: shared?.secretRef ?? undefined,
            status: shared?.status ?? undefined,
            expires_at: shared?.expiresAt ?? undefined,
            scope: c.scope,
            accounts: accounts.map((x) => ({
              account_id: x.accountId ?? null,
              external_account: x.externalAccount ?? undefined,
              secret_ref: x.secretRef ?? undefined,
              status: x.status ?? undefined,
              expires_at: x.expiresAt ?? undefined,
            })),
          };
        }),
        channel: "slack",
        slack: {
          team_id: a.teamId,
          app_token: appToken,
          bot_token: botToken,
          allowed_users: a.allowedUsers ?? [],
        },
      } as AgentConfig);
    }

    return {
      state_root: this.o.stateRoot ?? "/root/.tonoman",
      health_addr: "127.0.0.1:8787",
      agents,
      // The pod is the sandbox: there is no per-agent container to exec into, because an agent is
      // a row. `claude` is spawned as a direct child of this process.
      local_exec: true,
      stream: { cursor: "", edit_interval_ms: 1200 },
    } as Config;
  }
}

/** Pick a plane from the environment. Cloud sets TONOMANCLOUD_API_URL; everything else keeps
 *  reading its file, so no existing deployment changes behaviour by upgrading. */
export function controlPlaneFrom(env: NodeJS.ProcessEnv, configPath: string): ControlPlane {
  const baseUrl = env.TONOMANCLOUD_API_URL;
  if (!baseUrl) return new FileControlPlane(configPath);
  return new RegistryControlPlane({
    baseUrl,
    token: env.TONOMANCLOUD_API_TOKEN ?? "",
    secretsDir: env.TONOMAN_SECRETS_DIR,
    identityDir: env.TONOMAN_IDENTITY_DIR,
    stateRoot: env.TONOMAN_STATE_ROOT,
  });
}
