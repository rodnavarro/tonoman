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
  /** Outside accounts this agent has been GRANTED, identified by `(kind, alias)`. The alias is
   *  what makes more than one of a kind possible — a work calendar and a personal one are both
   *  `google`. `secretRef` names a row in the registry's `secret` table; the material never
   *  travels on the roster. */
  connections?: {
    id: string;
    kind: string;
    alias: string;
    label?: string | null;
    externalAccount?: string | null;
    secretRef?: string | null;
    status?: string;
    expiresAt?: string | null;
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
      // Namespaced by tenant, because two tenants may both call an agent "nelly" and the roster is
      // flat. The guid stays the identity everywhere it matters.
      const localName = `${a.tenant}-${a.name}`;

      if (a.channel !== "slack") {
        console.error(`registry: skipping ${localName} — channel "${a.channel}" is not wired here yet`);
        continue;
      }
      const [botToken, appToken] = await Promise.all([
        this.resolveRef(a.botTokenRef),
        this.resolveRef(a.appTokenRef),
      ]);
      if (!botToken || !appToken) {
        // One agent's missing credential must not take the whole gateway down with it.
        console.error(
          `registry: skipping ${localName} — could not resolve ${!botToken ? "bot" : "app"} token ` +
            `(looked under ${this.secretsDir})`,
        );
        continue;
      }

      const identityFile = await this.writeIdentity(localName, a.identity ?? "");

      agents.push({
        guid: a.guid,
        name: localName,
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
        connections: (a.connections ?? []).map((c) => ({
          id: c.id,
          kind: c.kind,
          alias: c.alias,
          label: c.label ?? undefined,
          external_account: c.externalAccount ?? undefined,
          secret_ref: c.secretRef ?? undefined,
          status: c.status,
          expires_at: c.expiresAt ?? undefined,
        })),
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
