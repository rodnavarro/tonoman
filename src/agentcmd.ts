// `tonoman create agent` — provisioning by convention (roster-provision, A11). Mints a
// GUID, writes the roster entry, scaffolds the per-agent <root>/<guid>/{config,memory,
// identity} dirs, and creates the sandbox from the pure podmanRunArgs() — adding ZERO new
// config-schema fields (image derives from the harness, the layout from the GUID under the
// env root). Adopt-safe: never `rm`s/recreates an existing container (the SAFETY FLOOR,
// src/lifecycle.ts). Credential bootstrap is one of two explicit paths — `--login` (fresh)
// or `--from <agent>` (seed the new volume from an existing agent's, same-harness required).

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { Config, AgentConfig, Mount } from "./config";
import type { Spec } from "./harness";
import { defaultHarnesses } from "./gateway";
import { newGUID, Store } from "./registry";
import { podmanRunArgs, agentDirs, sshSecretName } from "./provision";
import { containerState, createIfAbsent } from "./lifecycle";

/** Creates/replaces the podman secret holding an agent's git SSH key (cfg-ssh-key) from a
 * host key file. Idempotent (remove-then-create). The key is read by podman client-side at
 * create time and never written into config or the agent's memory. */
export async function ensureSshSecret(name: string, keyFile: string): Promise<void> {
  await new Promise<void>((resolve) => execFile("podman", ["secret", "rm", name], () => resolve())); // ignore "no such secret"
  await new Promise<void>((resolve, reject) =>
    execFile("podman", ["secret", "create", name, keyFile], (err) =>
      err ? reject(new Error(`ssh_key: podman secret create ${name} from "${keyFile}": ${err.message}`)) : resolve(),
    ),
  );
}

/** Pre-warms an agent's tools (cfg-agent-tools) by running each `setup` command once in the
 * container. BEST-EFFORT: a failed/renamed package is logged, not fatal — the agent can
 * install it on demand at turn time (its sandbox is root). */
export async function runSetup(container: string, cmds: string[]): Promise<void> {
  for (const cmd of cmds) {
    await new Promise<void>((resolve) =>
      execFile("podman", ["exec", container, "sh", "-lc", cmd], { maxBuffer: 1 << 24 }, (err) => {
        process.stdout.write(err ? `  setup FAILED (agent can self-install later): ${cmd}\n` : `  setup ok: ${cmd}\n`);
        resolve();
      }),
    );
  }
}

/** Parsed `create agent` invocation. PURE — separated so flag/positional handling is
 * unit-testable without touching podman or the filesystem. */
export interface CreateAgentOpts {
  name?: string;
  harness: string;
  from?: string;
  login: boolean;
  image?: string;
  role?: string;
  model?: string;
  telegramToken?: string;
  /** channel for a turn-driven agent (channel-teams); defaults to telegram. */
  channel?: "telegram" | "teams";
  /** Teams connector wiring (when --channel teams). app_password is a SECRET — forward it via
   * --secret TEAMS_APP_PASSWORD, never a flag. */
  teamsAppId?: string;
  teamsTenant?: string;
  teamsAllowedUser?: string;
  teamsPort?: number;
  mounts: Mount[];
  /** skill dirs to seed into the agent's config/skills/ at create (content stays out of
   * the OSS repo — a roster registers its own via this; A11 seed-once). */
  skills: string[];
  /** host path to a private SSH key to grant for git-over-SSH (cfg-ssh-key). */
  sshKey?: string;
  /** install commands to pre-warm tools once at create (cfg-agent-tools). */
  setup: string[];
  /** force service mode (svc-self-channeled) for a hand-picked harness; normally implied by
   * the harness spec (e.g. hermes is intrinsically a service). */
  service?: boolean;
  /** host port to publish for a service agent's health/dashboard port (svc-config-env / health probe). */
  port?: number;
  /** additional container ports to publish (host:same) for a service agent, e.g. the chat
   * platform webhook (Teams 3978) a dev tunnel / ingress targets. */
  ports: number[];
  /** non-secret process config for a service agent: `-e KEY=VALUE` (svc-config-env). */
  env: Record<string, string>;
  /** NAMES of secret env vars forwarded from the gateway env at boot (cfg-no-secrets). */
  secrets: string[];
}

/** Parses a `--mount name=host[:ro]` spec. Tolerates Windows host paths (the `=` split is
 * on the FIRST `=`, so the drive `C:` colon survives; only a trailing `:ro` is stripped). */
export function parseMountSpec(s: string | undefined): Mount | undefined {
  if (!s) return undefined;
  const eq = s.indexOf("=");
  if (eq < 0) return undefined;
  const name = s.slice(0, eq);
  let host = s.slice(eq + 1);
  let read_only: boolean | undefined;
  if (host.endsWith(":ro")) {
    host = host.slice(0, -3);
    read_only = true;
  }
  if (!name || !host) return undefined;
  return { name, host, read_only };
}

export function parseCreateAgentArgs(args: string[]): CreateAgentOpts {
  const o: CreateAgentOpts = { harness: "claude-code", login: false, mounts: [], skills: [], setup: [], env: {}, secrets: [], ports: [] };
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--harness") o.harness = args[++i];
    else if (a === "--from") o.from = args[++i];
    else if (a === "--login") o.login = true;
    else if (a === "--image") o.image = args[++i];
    else if (a === "--role") o.role = args[++i];
    else if (a === "--model") o.model = args[++i];
    else if (a === "--telegram-token") o.telegramToken = args[++i];
    else if (a === "--channel") o.channel = args[++i] === "teams" ? "teams" : "telegram";
    else if (a === "--teams-app-id") o.teamsAppId = args[++i];
    else if (a === "--teams-tenant") o.teamsTenant = args[++i];
    else if (a === "--teams-allowed-user") o.teamsAllowedUser = args[++i];
    else if (a === "--teams-port") o.teamsPort = Number(args[++i]) || undefined;
    else if (a === "--ssh-key") o.sshKey = args[++i];
    else if (a === "--service") o.service = true;
    else if (a === "--port") o.port = Number(args[++i]) || undefined;
    else if (a === "--publish") {
      const p = Number(args[++i]);
      if (p) o.ports.push(p);
    }
    else if (a === "--env") {
      const kv = args[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) o.env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--secret") {
      const n = args[++i];
      if (n) o.secrets.push(n);
    } else if (a === "--setup") {
      const c = args[++i];
      if (c) o.setup.push(c);
    } else if (a === "--skill") {
      const s = args[++i];
      if (s) o.skills.push(s);
    } else if (a === "--mount") {
      const m = parseMountSpec(args[++i]);
      if (m) o.mounts.push(m);
    } else pos.push(a);
  }
  o.name = pos[0];
  return o;
}

/** The env root that holds <guid>/{config,memory,identity} + agents.json. A named env
 * (TONOMAN_ENV) is always its own ~/.tonoman-<env> (isolation); the default falls back to
 * the config's state_root, else ~/.tonoman. Kept local to avoid a cycle with the CLI. */
function envRootFor(env: string | undefined, cfg: Config): string {
  const home = os.homedir() || ".";
  if (env) return path.join(home, `.tonoman-${env}`);
  return cfg.state_root || path.join(home, ".tonoman");
}

/** Loads the env's config, or synthesizes a minimal one for a brand-new env (so the first
 * `create agent` in a fresh env "just works" — no hand-authored settings.json needed). */
async function loadOrInit(cfgPath: string, env: string | undefined): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(cfgPath, "utf8")) as Config;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`config: read ${cfgPath}: ${(e as Error).message}`);
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    return {
      state_root: envRootFor(env, {} as Config),
      health_addr: "127.0.0.1:8787",
      stream: { cursor: " 🤖", edit_interval_ms: 900 },
      agents: [],
    } as Config;
  }
}

/** Seeds a minimal identity (AGENTS.md) if the agent doesn't have one yet — the per-agent
 * persona the operator (or the UI) then edits. Never overwrites an existing one. */
async function seedIdentity(identityDir: string, a: AgentConfig): Promise<void> {
  const f = path.join(identityDir, "AGENTS.md");
  try {
    await fs.access(f);
    return; // already present — leave it
  } catch {
    /* absent → seed */
  }
  const body =
    `# ${a.name}\n\n` +
    (a.role ? `${a.role}\n\n` : "") +
    `You are **${a.name}**, an agent on the Tonoman control plane. Your git-backed memory ` +
    `lives at /root/.tonoman; folders granted to you appear under /root/files.\n\n` +
    `You run as root in your own sandbox — if a task needs a tool you don't have, install it ` +
    `(apt-get / pip / npm) and continue (cfg-agent-tools).\n`;
  await fs.writeFile(f, body, "utf8");
}

/** Runs `tonoman create agent <name> …`. Effectful; the pure parts are parseCreateAgentArgs
 * + podmanRunArgs (both unit-tested). The real provision is smoke-verified under TONOMAN_ENV=smoke. */
export async function runCreateAgent(cfgPath: string, env: string | undefined, args: string[]): Promise<void> {
  const o = parseCreateAgentArgs(args);
  if (!o.name) {
    process.stderr.write(
      "usage: tonoman create agent <name> [--harness K] [--from AGENT | --login] [--role R] [--model M] [--mount name=host[:ro]] [--ssh-key PATH] [--setup CMD] [--skill DIR] [--telegram-token T | --channel teams --teams-app-id ID --teams-tenant T [--teams-allowed-user OID] [--teams-port N]] [--image REF]\n",
    );
    process.exit(2);
    return;
  }
  if (o.from && o.login) {
    process.stderr.write("create agent: choose ONE of --from <agent> or --login (not both)\n");
    process.exit(2);
    return;
  }

  const spec = defaultHarnesses().lookup(o.harness);
  if (!spec) {
    process.stderr.write(`create agent: unknown harness "${o.harness}"\n`);
    process.exit(2);
    return;
  }

  const cfg = await loadOrInit(cfgPath, env);
  const agents = cfg.agents ?? [];
  if (agents.some((a) => (a.name ?? "").toLowerCase() === o.name!.toLowerCase())) {
    throw new Error(`agent "${o.name}" already exists in ${cfgPath} (use 'tonoman up' to start it)`);
  }

  const root = envRootFor(env, cfg);
  const guid = newGUID();
  const container = env ? `${o.name}-${env}` : o.name; // env suffix applied at runtime (cli-env)

  // The persisted roster entry stores the BASE container name; the env suffix is applied
  // at up/down/create time so the same settings.json works in any env.
  // Service-ness is intrinsic to the harness (spec); --service only confirms/forces it.
  const service = !!(spec.service || o.service);
  const entry: AgentConfig = {
    guid,
    name: o.name,
    role: o.role,
    harness: o.harness,
    container: o.name,
    model: o.model,
    system_prompt_file: `${spec.identityHome}/AGENTS.md`,
    mounts: o.mounts.length ? o.mounts : undefined,
    ssh_key: o.sshKey,
    setup: o.setup.length ? o.setup : undefined,
    // Channel wiring (channel-teams): a Teams agent gets a `teams` block + channel discriminator;
    // otherwise the default Telegram block. app_password stays a secret (via --secret), never here.
    ...(o.channel === "teams"
      ? {
          channel: "teams" as const,
          teams: {
            app_id: o.teamsAppId ?? "",
            tenant_id: o.teamsTenant ?? "",
            ...(o.teamsAllowedUser ? { allowed_user: o.teamsAllowedUser } : {}),
            ...(o.teamsPort ? { port: o.teamsPort } : {}),
          },
        }
      : { telegram: { token: o.telegramToken ?? "" } }),
    ...(service ? { service: true } : {}),
    ...(o.port ? { port: o.port } : {}),
    ...(o.ports.length ? { ports: o.ports } : {}),
    ...(Object.keys(o.env).length ? { env: o.env } : {}),
    ...(o.secrets.length ? { secrets: o.secrets } : {}),
  };

  const runAgent: AgentConfig = { ...entry, container };
  const pathCfg = { ...cfg, state_root: root } as Config;
  const dirs = agentDirs(pathCfg, runAgent);

  // SAFETY FLOOR — never create over an existing container.
  const state = await containerState(container);
  if (state !== "absent") {
    throw new Error(`container "${container}" already exists (${state}) — not recreating (adopt-safe). Use 'tonoman up' to start it.`);
  }

  // Scaffold the per-agent state and seed a minimal identity.
  await fs.mkdir(dirs.config, { recursive: true });
  await fs.mkdir(dirs.incoming, { recursive: true }); // also creates memory/
  await fs.mkdir(dirs.identity, { recursive: true });
  await seedIdentity(dirs.identity, entry);

  // Credential bootstrap.
  if (o.from) {
    const src = agents.find((a) => (a.name ?? "").toLowerCase() === o.from!.toLowerCase());
    if (!src) throw new Error(`--from "${o.from}": no such agent in ${cfgPath}`);
    const srcHarness = src.harness ?? "claude-code";
    if (srcHarness !== o.harness) {
      throw new Error(`cannot seed creds from "${o.from}" (${srcHarness}) into "${o.name}" (${o.harness}): harness mismatch`);
    }
    const srcDirs = agentDirs(pathCfg, src);
    await fs.cp(srcDirs.config, dirs.config, { recursive: true });
    process.stdout.write(`Seeded credentials from "${o.from}" (same harness: ${srcHarness}).\n`);
  }

  // Register skills into config/skills/ (seed-once, A11). After --from so explicitly
  // registered skills win over any seeded from the source. Content stays out of the OSS
  // repo — a roster passes its own skill dirs here (e.g. an org's domain skill).
  if (o.skills.length) {
    const skillsDir = path.join(dirs.config, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    for (const s of o.skills) {
      const nm = path.basename(s.replace(/[/\\]+$/, ""));
      try {
        await fs.cp(s, path.join(skillsDir, nm), { recursive: true });
      } catch (e) {
        throw new Error(`--skill "${s}": ${(e as Error).message}`);
      }
    }
    process.stdout.write(`Registered ${o.skills.length} skill(s) into config/skills/.\n`);
  }

  // git-over-SSH key (cfg-ssh-key): create the podman secret BEFORE `podman run` mounts it.
  if (runAgent.ssh_key) {
    await ensureSshSecret(sshSecretName(runAgent), runAgent.ssh_key);
    process.stdout.write(`Granted git SSH key (secret ${sshSecretName(runAgent)} → ${"/root/.ssh/id_rsa"} 0600).\n`);
  }

  const runSpec: Spec = o.image ? { ...spec, image: o.image } : spec;
  const created = await createIfAbsent(container, podmanRunArgs(runAgent, pathCfg, runSpec));
  if (!created) throw new Error(`container "${container}" appeared concurrently — not recreated (adopt-safe).`);

  // Pre-warm tools once, now that the sandbox is up (cfg-agent-tools). Best-effort — a
  // failed step is logged, not fatal; the agent can install on demand at turn time.
  if (runAgent.setup?.length) {
    process.stdout.write(`Pre-warming ${runAgent.setup.length} setup step(s)…\n`);
    await runSetup(container, runAgent.setup);
  }

  // Persist: roster entry + instance registry row (keyed by GUID).
  cfg.agents = [...agents, entry];
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  await new Store(path.join(root, "agents.json")).upsert({
    guid,
    name: o.name,
    role: o.role,
    harness: o.harness,
    model: o.model,
    container,
    config_volume: dirs.config,
    config_home: spec.configHome,
    memory_root: dirs.memory,
  });

  process.stdout.write(`Created agent "${o.name}" (guid ${guid}, container ${container}, image ${runSpec.image}).\n`);
  if (service) process.stdout.write(`It runs as a SERVICE (own channel; auth via injected env) — start it: tonoman up\n`);
  else if (!o.from) process.stdout.write(`It starts UNAUTHENTICATED — run: tonoman auth login ${o.name}\n`);
}
