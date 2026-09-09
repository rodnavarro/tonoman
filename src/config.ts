// Loads the gateway's settings from a mounted, never-committed file (A1; only the
// *.example.* template is committed, the real settings.json carries secrets and is
// git-ignored). Supports a roster of agents (A11): the top-level `agents` array.
// The older single-agent shape is still accepted and synthesized into a one-entry
// roster, so existing settings keep working unchanged.

import { promises as fs } from "node:fs";

/** A granted host location, surfaced in the sandbox as ~/files/<name> (A9), or at an
 * explicit `target` path when the tooling expects one (e.g. ~/.aws — cfg-mount-target). */
export interface Mount {
  name: string;
  host: string;
  read_only?: boolean;
  /** absolute sandbox path to mount at, instead of ~/files/<name> (cfg-mount-target). */
  target?: string;
}

/** One agent's connector credentials/wiring (A1). Each agent owns its own bot. */
export interface Telegram {
  token: string;
  allowed_user?: string;
  media_dir?: string;
  media_mount?: string;
}

/** One agent's Slack connector wiring (A1, channel-slack). Socket Mode, so the agent DIALS OUT
 * and needs no ingress, no public URL, no TLS certificate and no signing-secret verification —
 * the same shape as Telegram's long-poll. Both tokens are SECRETS: keep them out of the roster
 * file (forward via `secrets[]` / env) and set them on the wired connector at gateway-run time. */
export interface Slack {
  /** Slack team id (`T…`). Not secret, and needed to build a conversation key for a DM the agent
   * opens itself (gw-wake) — the agent has no inbound envelope to take one from. */
  team_id?: string;
  app_token?: string; // `xapp-…`, scope connections:write — opens the Socket Mode socket
  bot_token?: string; // `xoxb-…` — every Web API call
  /** allow-list of Slack user ids (`U…`); empty = accept anyone in the workspace. */
  allowed_users?: string[];
}

/** One agent's MS Teams connector wiring (A1, channel-teams). A turn-driven agent
 * reached on Teams instead of Telegram — Tonoman owns the webhook + outbound, the
 * harness is unchanged. `app_password` is a SECRET: keep it out of the roster file
 * (forward via `secrets[]` / env), set it on the wired connector at gateway-run time. */
export interface Teams {
  app_id: string; // the bot's Entra app (client) id
  app_password?: string; // client secret — supply via env/secret, not the roster
  tenant_id: string;
  allowed_user?: string; // allow-list: sender AAD object id
  /** Path to the ConfigMap-mounted people roster (identity-roster): email→person/role, so a sender
   * is recognized by verified EMAIL not the spoofable display name. Adding an address = edit the
   * mounted file + restart, no image rebuild. */
  people_file?: string;
  /** When true, only senders whose email is in the roster may use the bot; others get a
   * deterministic refusal (no turn, no LLM). Default false. */
  restrict_to_roster?: boolean;
  media_dir?: string;
  media_mount?: string;
  /** webhook listen port the gateway serves (dev tunnel / ingress points here); default 3978. */
  port?: number;
  /** How the "🤖 working…" liveness cue is shown while a turn runs (channel-teams):
   *  - "message" (default): a SEPARATE status message, updated with elapsed for the WHOLE turn
   *    (incl. a mid-turn quiet gap) and deleted when the reply finalizes — so the operator is
   *    never left wondering during a long tool call mid-reply.
   *  - "card": the Teams `informative` streaminfo card (pre-text only; establishes the stream).
   *    Kept as a config-gated alternative. The plain typing bubble shows in both modes. */
  working_cue?: "message" | "card";
}

/** One agent's git-backed memory substrate (A3). The push `token` is a SECRET — it is
 * NOT written by the CLI and should be supplied via env at gateway-run time, never
 * committed (cfg-no-secrets); `set memory git` only manages the non-secret fields. */
export interface Workspace {
  root?: string;
  remote?: string;
  token?: string;
  /** branch to push the memory repo to (default: the repo's current branch). */
  branch?: string;
  /** auto-commit memory throughout the day (turn-end + a periodic dirty-sweep). Default on;
   * set false to disable the automatic cadence (manual commits still work). */
  auto_commit?: boolean;
}

/** One agent in the roster (A11). */
export interface AgentConfig {
  guid?: string;
  name: string;
  role?: string;
  harness?: string;
  container: string;
  /** base URL of a REMOTE agent runtime (harness "claude-code-http", k8s split): the gateway
   * drives turns over HTTP instead of `podman exec`. When set, `container` is not required —
   * the agent's lifecycle is owned elsewhere (k8s), not by this gateway. */
  url?: string;
  system_prompt_file?: string;
  model?: string;
  /** Brain auth backend (backend-*): "subscription" (Claude OAuth — the dev default) or "bedrock"
   * (AWS Bedrock — inference in the customer's own AWS account, the privacy-credible prod backend).
   * Live-switchable via `tonoman backend`; this roster/helm value is the DURABLE default (a restart
   * reverts to it). Default "subscription". */
  auth?: "subscription" | "bedrock";
  /** AWS region for `auth: bedrock` (backend-bedrock-turn) — REQUIRED when auth is bedrock. */
  region?: string;
  /** Bedrock model / cross-region inference-profile id for `auth: bedrock` (e.g.
   * `us.anthropic.claude-sonnet-4-6`). Surfaced to the agent pod as ANTHROPIC_MODEL; leave `model`
   * unset for a bedrock agent so `--model` does not shadow it. */
  bedrock_model?: string;
  window_size?: number;
  max_turns?: number; // cap the agentic tool-loop per turn (claude-code --max-turns); 0 = uncapped
  /** resume the harness's own session across turns (claude-code --resume) instead of re-sending the
   * window each turn — cheaper via prompt caching; `/new` rotates it. Default off (substrate window). */
  session_persist?: boolean;
  mounts?: Mount[];
  tunnel_bin?: string;
  config_volume?: string;
  port_base?: number;
  /** Channel for a turn-driven agent (channel-teams). Usually inferred from which
   * connector block is present (`telegram` → telegram, `teams` → teams); set explicitly
   * to disambiguate. A service agent owns its own channel (derived "self"). */
  channel?: "telegram" | "teams" | "slack";
  /** Connector wiring for a turn-driven agent (A1). OPTIONAL: a service agent
   * (svc-self-channeled) owns its own channel and needs no Tonoman connector. */
  telegram?: Telegram;
  /** MS Teams connector wiring for a turn-driven agent (channel-teams). Mutually
   * exclusive with `telegram` per agent. */
  teams?: Teams;
  /** Slack connector wiring for a turn-driven agent (channel-slack). Mutually exclusive
   * with `telegram` / `teams` per agent. */
  slack?: Slack;
  /** What the control plane believes about this agent's inference credential:
   * `unconfigured` | `ok` | `expired` | `error`.
   *
   * A FACT about the agent, not a probe of the filesystem — that distinction is the point. A file
   * check answers "is there a credential file", which is how an agent can report healthy for weeks
   * over a credential that expired and carried no refresh token.
   *
   * Undefined means "not tracked", which is the file-roster case: a self-hosted deployment keeps
   * today's behaviour and is never gated. */
  auth_state?: "unconfigured" | "ok" | "expired" | "error";
  /** Who this agent recognises, and as whom. A Slack user id resolves to a name the agent can use,
   * which is how "Hi Celine" happens — from the registry, never from a spoofable display name.
   * Deliberately unrelated to console access (§7): talking to an agent is not signing in. */
  principals?: { kind: string; value: string; label: string }[];
  /** Second-brain sources this agent has been GRANTED (§8). A list, not one repo: the end state
   * binds an Azure DevOps repo over SSH alongside a GitHub one. Empty when the tool is not granted,
   * which is what makes revoking it in the console remove the checkout rather than hide a button. */
  secondbrain?: {
    id: string;
    label: string;
    repo_url: string;
    branch?: string;
    subpath?: string;
    auth_kind?: string;
    secret_ref?: string | null;
    read_only?: boolean;
  }[];
  /** Settings for the FLOWS this agent runs, as the registry holds them: flow → key → value.
   *
   *  Flat keys, on purpose. The registry stores rows and knows nothing about what they mean; the
   *  runtime that owns a flow is the only thing that should have to understand `journal.path` or
   *  `route.<id>`. That is what keeps adding a meeting category an INSERT rather than a migration
   *  here and a redeploy there. */
  flows?: Record<string, Record<string, string>>;
  /** What the TENANT is trying to do, in their own words — one row, shared by every agent the
   *  tenant has. Every recap is measured against it.
   *
   *  A lens on ATTENTION, not a topic filter: it exists so a recap can say a meeting cost the
   *  scarce thing rather than only ever reporting how it helped. Empty is ordinary — every tenant
   *  is in that state until somebody writes one — and means the recap simply does not judge. */
  mission?: string;
  /** IANA timezone for DISPLAY, from the tenant. "America/New_York", never an offset. Empty or
   *  "UTC" means render in UTC, which is what every recap did before this existed. */
  timezone?: string;
  /** Outside accounts this agent may use, from the registry (§8). Identified by `(kind, alias)`:
   *  the KIND is what the platform knows how to talk to, the ALIAS is which one of them this is.
   *  That is what lets a tenant attach a work calendar and a personal one without either becoming
   *  a second connector. `secret_ref` names the credential; it is never the credential. */
  connections?: {
    id: string;
    kind: string;
    alias: string;
    label?: string;
    external_account?: string;
    secret_ref?: string;
    status?: string;
    expires_at?: string;
  }[];
  workspace?: Workspace;
  // --- Service-mode (svc-self-channeled / svc-config-env) ----------------------
  /** Service agent: Tonoman boots + lifecycle-manages a long-lived self-channeled server
   * (e.g. the Hermes harness) but does NOT drive its turns. The harness `spec` is the
   * primary source of service-ness; this confirms/forces it for a hand-authored roster. */
  service?: boolean;
  /** Host port to publish for a service agent's health/dashboard port (maps to the harness
   * `servicePort`); defaults to the harness port when unset. Used for the token-free health probe. */
  port?: number;
  /** ADDITIONAL container ports a service agent should publish (host:same) — e.g. the chat
   * platform's own webhook listener (the Teams Bot Framework port 3978), which a dev tunnel /
   * ingress points at. The health probe still uses the dashboard `servicePort` (creds-free). */
  ports?: number[];
  /** Non-secret process config injected at boot (svc-config-env): `-e KEY=VALUE`. May live
   * in the roster file (it is not a secret). */
  env?: Record<string, string>;
  /** NAMES of secret env vars to forward from the gateway's own environment at boot
   * (svc-config-env / cfg-no-secrets): emitted as bare `-e NAME` so podman passes the VALUE
   * through at run — the value is NEVER written to settings.json. */
  secrets?: string[];
  /** Host path to a private SSH key to grant this agent for git-over-SSH (cfg-ssh-key).
   * Read ONLY at provision time to create a podman secret (mounted 0600 at
   * /root/.ssh/id_rsa) — NEVER written back into settings.json nor the agent's memory. */
  ssh_key?: string;
  /** Install commands run ONCE at provision to pre-warm tools (cfg-agent-tools), e.g.
   * the AWS CLI. The agent may also install tools on demand at turn time. */
  setup?: string[];
}

export interface StreamConfig {
  cursor: string;
  edit_interval_ms: number;
  /** liveness-cue interval during a quiet turn (gw-stream-heartbeat); 0 = disabled. */
  heartbeat_ms?: number;
}

/** Reachable-service-URL settings (devcontainerized-expose-url). */
export interface ExposeConfig {
  /** address Tonoman advertises for EXPOSED services (LAN IP / hostname). When unset,
   * the gateway auto-detects the host's primary LAN IPv4. */
  advertise_host?: string;
  /** opt-in public-tunnel exposure (personal use only) — OFF by default; the
   * enterprise profile never egresses through a third-party tunnel. */
  tunnel?: boolean;
}

/** The gateway configuration: a roster of agents plus shared streaming settings
 * and a Tonoman state root. */
export interface Config {
  state_root?: string;
  /** Org-level tonoman config repo (learn-durable): a git repo (e.g. github.com/example-org/tonoman-config)
   * holding the shared skill registry (`./skills`), agent→skill `assignments.yaml`, and org knobs
   * (`./org`). The runtime clones it to resolve an agent's shared skills; durable shared-skill changes
   * open a PR against it. Unset → the org is personal-only (no shared registry; `scope=shared` writes
   * are refused, never mis-routed to an agent's own repo). Distinct from the deploy repo (helm/Argo). */
  config_repo?: string;
  health_addr: string;
  agents: AgentConfig[];
  /** Run turns IN THIS PROCESS's container rather than `podman exec` into a per-agent one
   *  (local-exec). Set by the registry control plane: under Tonoman Cloud an agent is a row, so
   *  there is no container to exec into and the pod is the isolation boundary. Self-hosted rosters
   *  leave it unset and keep the per-agent container model. */
  local_exec?: boolean;
  stream: StreamConfig;
  expose?: ExposeConfig;
  // legacy single-agent shape (back-compat)
  agent?: Partial<AgentConfig>;
  telegram?: Telegram;
  workspace?: Workspace;
}

/** Reads and parses a settings file, applying defaults. Call validate() before
 * running the gateway. */
export async function load(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (e) {
    throw new Error(`config: read ${path}: ${(e as Error).message}`);
  }
  let c: Config;
  try {
    c = JSON.parse(raw) as Config;
  } catch (e) {
    throw new Error(`config: parse ${path}: ${(e as Error).message}`);
  }
  applyDefaults(c);
  return c;
}

function applyDefaults(c: Config): void {
  c.stream ??= { cursor: "", edit_interval_ms: 0 };
  if (!c.stream.cursor) c.stream.cursor = " 🤖"; // typing cue that renders everywhere
  if (!c.stream.edit_interval_ms || c.stream.edit_interval_ms <= 0) c.stream.edit_interval_ms = 900;
  if (c.stream.heartbeat_ms == null) c.stream.heartbeat_ms = 60_000; // ~1m liveness cue; set 0 to disable
  if (!c.health_addr) c.health_addr = "127.0.0.1:8787"; // loopback service-health API (A12)

  c.expose ??= {};
  c.expose.tunnel ??= false; // default-deny: no third-party tunnel unless explicitly enabled

  c.agents ??= [];
  // Back-compat: fold the legacy single-agent shape into the roster.
  if (c.agents.length === 0 && (c.agent?.container || c.telegram?.token)) {
    c.agents = [
      {
        name: c.agent?.name ?? "",
        container: c.agent?.container ?? "",
        system_prompt_file: c.agent?.system_prompt_file,
        model: c.agent?.model,
        window_size: c.agent?.window_size,
        mounts: c.agent?.mounts,
        tunnel_bin: c.agent?.tunnel_bin,
        ssh_key: c.agent?.ssh_key,
        setup: c.agent?.setup,
        telegram: c.telegram as Telegram,
        workspace: c.workspace,
      },
    ];
  }

  for (const a of c.agents) {
    if (!a.harness) a.harness = "claude-code";
    if (!a.auth) a.auth = "subscription"; // brain auth backend default (backend-config-default)
    if (!a.window_size || a.window_size <= 0) a.window_size = 30;
    // Cap the per-turn agentic tool-loop by default so an open-ended turn can't loop unbounded
    // and drain the account's usage window. Set max_turns: 0 to opt a heavy dev agent out.
    if (a.max_turns == null) a.max_turns = 10;
    if (!a.name) a.name = "agent";
    // Infer the channel from which connector block is present (channel-teams); a service
    // agent owns its own channel, so leave it unset.
    if (!a.service && !a.channel) a.channel = a.slack ? "slack" : a.teams ? "teams" : "telegram";
  }
}

/** Checks that the fields needed to run the gateway are present, per agent. */
export function validate(c: Config): void {
  if (!c.agents || c.agents.length === 0) throw new Error("config: no agents configured");
  const seen = new Set<string>();
  c.agents.forEach((a, i) => {
    const who = a.name || `agents[${i}]`;
    if (seen.has(a.name)) throw new Error(`config: duplicate agent name "${a.name}" (names must be unique)`);
    seen.add(a.name);

    const missing: string[] = [];
    // A service agent owns its own channel (svc-self-channeled) — no Tonoman connector.
    // A turn-driven agent needs its channel's credentials: telegram.token, or — for a
    // Teams agent (channel-teams) — teams.app_id + teams.tenant_id (app_password is a
    // secret injected at run time, so it is not required in the roster file).
    if (!a.service) {
      const ch = a.channel ?? (a.slack ? "slack" : a.teams ? "teams" : "telegram");
      if (ch === "teams") {
        if (!a.teams?.app_id) missing.push("teams.app_id");
        if (!a.teams?.tenant_id) missing.push("teams.tenant_id");
      } else if (ch === "slack") {
        // Both Slack tokens are secrets injected at run time, so the roster carries neither.
        // Presence is checked where the connector is wired, not here.
      } else if (!a.telegram?.token) {
        missing.push("telegram.token");
      }
    }
    // A remote agent (claude-code-http, k8s split) is reached by URL; its container lives in
    // another runtime (k8s), so it needs `url` and NOT a local `container`.
    const remote = a.harness === "claude-code-http";
    if (remote) {
      if (!a.url) missing.push("url");
    } else if (!a.container && !c.local_exec) {
      // A roster with no container is only valid in local-exec mode, where the POD is the sandbox
      // and `claude` is spawned as a direct child. That is what a Tonoman Cloud gateway does: an
      // agent is a row, so there is no per-agent container to exec into. A self-hosted roster still
      // names one, and still gets the old error if it forgets.
      missing.push("container");
    }
    // Auth backend (backend-config-default): known values only; bedrock needs a region.
    if (a.auth && a.auth !== "subscription" && a.auth !== "bedrock")
      throw new Error(`config: agent "${who}" invalid auth "${a.auth}" (expected "subscription" or "bedrock")`);
    if (a.auth === "bedrock" && !a.region) missing.push("region (required for auth: bedrock)");
    if (!a.workspace?.root && !c.state_root) missing.push("workspace.root or state_root");
    if (missing.length) throw new Error(`config: agent "${who}" missing required fields: ${missing.join(", ")}`);
  });
}
