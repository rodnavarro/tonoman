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
  /** LOCAL-DEV dev tunnel (see runtime/tunnel). Opt-in: absent or `enabled:false` = no tunnel and
   * behavior is unchanged — in Kubernetes the webhook has a real ingress, so this stays unset.
   * When enabled, `tonoman up` opens a tunnel to `port` and repoints the Azure bot's messaging
   * endpoint at it (an anonymous quick tunnel gets a new hostname each start, and a stale endpoint
   * makes Teams fail SILENTLY). `azure` holds the ARM coordinates for that repoint; without it the
   * tunnel still opens but the endpoint must be set by hand. */
  tunnel?: {
    enabled?: boolean;
    /** cloudflared binary; falls back to the agent's `tunnel_bin`, then "cloudflared". */
    bin?: string;
    azure?: { resource_group: string; bot_name: string; az_bin?: string };
  };
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
/** Web-TUI wiring (tui-over-web). The launcher (baked in the image) starts ttyd (base-path
 * /term) + the keyboard-aware/scroll wrapper, then `tonoman expose`s the wrapper port. */
export interface Tui {
  /** Opt in. When true, provisioning publishes `port` to host loopback so the brokered
   * `tonoman expose` can LAN-forward it; when false/absent nothing is published. */
  enabled?: boolean;
  /** LAN-facing wrapper port (published to host loopback + exposed). Default 7682. */
  port?: number;
  /** loopback-only ttyd port inside the sandbox (behind the wrapper). Default 7681. */
  ttyd_port?: number;
  /** xterm font size (mobile default 15). */
  font?: number;
}

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
  /** Opt-in web-TUI (tui-over-web): expose an interactive harness TUI (ttyd + tmux,
   * made phone-usable by the baked keyboard-aware/scroll wrapper) over the browser,
   * LAN-reachable through the brokered `tonoman expose`. Absent / `enabled:false` = no
   * TUI and nothing published, so the k8s deploy path is unaffected. `tonoman tui <agent>`
   * brings it up on demand. */
  tui?: Tui;
  tunnel_bin?: string;
  config_volume?: string;
  port_base?: number;
  /** Channel for a turn-driven agent (channel-teams). Usually inferred from which
   * connector block is present (`telegram` → telegram, `teams` → teams); set explicitly
   * to disambiguate. A service agent owns its own channel (derived "self").
   * `"none"` = a CONNECTOR-LESS agent (tui-only): the gateway still boots its container and
   * wires the broker + expose (so brokered podman / `tonoman expose` / the web-TUI work), but
   * attaches NO connector or turn-loop — you reach it only through `tonoman tui`. */
  channel?: "telegram" | "teams" | "none";
  /** Connector wiring for a turn-driven agent (A1). OPTIONAL: a service agent
   * (svc-self-channeled) owns its own channel and needs no Tonoman connector. */
  telegram?: Telegram;
  /** MS Teams connector wiring for a turn-driven agent (channel-teams). Mutually
   * exclusive with `telegram` per agent. */
  teams?: Teams;
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
    if (!a.service && !a.channel) a.channel = a.teams ? "teams" : "telegram";
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
    if (!a.service && a.channel !== "none") {
      const ch = a.channel ?? (a.teams ? "teams" : "telegram");
      if (ch === "teams") {
        if (!a.teams?.app_id) missing.push("teams.app_id");
        if (!a.teams?.tenant_id) missing.push("teams.tenant_id");
      } else if (!a.telegram?.token) {
        missing.push("telegram.token");
      }
    }
    // A remote agent (claude-code-http, k8s split) is reached by URL; its container lives in
    // another runtime (k8s), so it needs `url` and NOT a local `container`.
    const remote = a.harness === "claude-code-http";
    if (remote) {
      if (!a.url) missing.push("url");
    } else if (!a.container) {
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
