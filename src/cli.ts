#!/usr/bin/env node
// The Tonoman control-plane CLI — a "Kubernetes for agents". Tonoman does not run
// an agent loop; it orchestrates harnesses (Claude Code, …) that run agent loops
// inside podman sandboxes, and exposes a shared substrate (runtime, memory) to
// them. See docs/architecture.md.
//
// The surface reads like kubectl: a VERB, then a RESOURCE, then an optional NAME,
// then flags — `tonoman <verb> <resource> [name] [flags]`. The agent is the
// namespace: an agent-scoped resource takes `-a/--agent <name>` the way kubectl
// takes `-n <namespace>`. The `--config FILE` global flag may appear anywhere; the
// active environment is ambient (TONOMAN_ENV, currentEnv). See docs/scenarios/contracts/cli.md.

import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { load, type Config, type AgentConfig } from "./config";
import { controlPlaneFrom } from "./core/controlplane";
import * as gateway from "./gateway";
import * as health from "./health";
import { findAgent, upsertMount, removeMount, listMounts, podmanVolumeArgs, agentMountPath } from "./mounts";
import { sinkFromEnv, decodeClaudeTranscript, postTrace, fullContextEnabled, parsePrefix, fullContextSections, type ContextPrefix, type ContextSection } from "./telemetry";
import { CONFIG_HOME, spec as claudecodeSpec } from "./harness/claudecode";
import { runCreateAgent } from "./agentcmd";
import { runLearn } from "./learncmd";
import { parseRepo } from "./learn-git";
import { assembleSkills, parseAssignments } from "./skills";
import { runCreateBrowser, runGetBrowsers, runOpenBrowser, runDeleteBrowser, parseBrowserPurge } from "./browsercmd";
import { gatewayLogPath } from "./logfile";
import { podmanAuthOps, httpAuthOps, type AuthOps } from "./authflow";
import { serveRuntime } from "./agent/server";

const VERSION = "0.1.0-dev";

/** The active environment name, set once via `TONOMAN_ENV` (cli-env). Unset/blank → the
 * default environment. It is an AMBIENT knob, not a per-command flag, so it applies
 * uniformly to every command in the shell and can't be applied to `up` yet forgotten on
 * `down`. People who don't need environments never meet the concept. */
export function currentEnv(): string | undefined {
  const e = process.env.TONOMAN_ENV;
  return e && e.trim() ? e.trim() : undefined;
}

/** The root that holds an environment's config + state: ~/.tonoman by default, or
 * ~/.tonoman-<env> for a named environment (cli-env). Pure in `env`. */
export function envRoot(env?: string): string {
  const home = os.homedir() || ".";
  return path.join(home, env ? `.tonoman-${env}` : ".tonoman");
}

/** Where Tonoman reads its config when no --config flag is given. Precedence: under
 * `TONOMAN_ENV=<name>` the env root wins (a named env owns its config, outranking the
 * ambient $TONOMAN_CONFIG); else $TONOMAN_CONFIG; else ~/.tonoman/settings.json. */
export function defaultConfig(env: string | undefined = currentEnv()): string {
  if (env) return path.join(envRoot(env), "settings.json");
  if (process.env.TONOMAN_CONFIG) return process.env.TONOMAN_CONFIG;
  return path.join(envRoot(), "settings.json");
}

/** Applies a named environment to a loaded config (cli-env): co-locate state under the
 * env root, and SUFFIX every agent's container with `-<env>`. The suffix is the hard
 * guarantee that under `TONOMAN_ENV=dev` Tonoman operates `cody-dev`, never the prod
 * `cody`. The default environment (no `env`) is a no-op — today's behavior, unchanged. */
export function applyEnv(cfg: Config, env: string | undefined = currentEnv()): void {
  if (!env) return;
  cfg.state_root ??= envRoot(env);
  // Suffix only real containers; a remote agent (claude-code-http) has no local container.
  for (const a of cfg.agents ?? []) if (a.container) a.container = `${a.container}-${env}`;
}

/** Extracts the one GLOBAL flag — `--config/-config FILE` (incl. `=` forms) — from
 * ANYWHERE in argv (before or after the verb). The active environment is ambient
 * (`TONOMAN_ENV`, see currentEnv), not a flag. The remaining args are the command. */
export function parseGlobalFlags(argv: string[]): { cfgPath: string; rest: string[] } {
  let explicit: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-config" || a === "--config") explicit = argv[++i];
    else if (a.startsWith("-config=") || a.startsWith("--config=")) explicit = a.slice(a.indexOf("=") + 1);
    else rest.push(a);
  }
  return { cfgPath: explicit ?? defaultConfig(), rest };
}

/** Flags shared by resource commands: `-a/--agent` (the namespace), `--ro`, `--podman`.
 * Extracted wherever they appear; positionals survive in order. */
export function parseMountsArgs(args: string[]): { agent?: string; ro: boolean; podman: boolean; pos: string[] } {
  let agent: string | undefined;
  let ro = false;
  let podman = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--agent" || a === "-a") agent = args[++i];
    else if (a === "--ro" || a === "--read-only") ro = true;
    else if (a === "--podman") podman = true;
    else pos.push(a);
  }
  return { agent, ro, podman, pos };
}

type Resource = "agents" | "mounts" | "services" | "memory" | "browsers";

/** Singular / plural / short forms all resolve to one canonical resource (kubectl `po`/`pods`). */
const RESOURCES: Record<string, Resource> = {
  agent: "agents",
  agents: "agents",
  mount: "mounts",
  mounts: "mounts",
  service: "services",
  services: "services",
  svc: "services",
  memory: "memory",
  mem: "memory",
  browser: "browsers",
  browsers: "browsers",
};

export type Resolved =
  | { kind: "up" | "down" | "auth" | "version" | "help" | "logs" | "runtime" | "sync" }
  | { kind: "get" | "create" | "delete" | "set" | "open" | "close"; resource: Resource }
  | { kind: "backend"; agent: string; mode?: string }
  | { kind: "learn"; args: string[] }
  | { kind: "usage"; exitCode: number; error?: string };

/** Pure dispatch resolver — maps the args (GLOBAL flags already stripped) to a command
 * (or a usage error + exit code), with NO side effects, so routing/aliases/exit-codes
 * are unit-testable. */
export function resolveCommand(argv: string[]): Resolved {
  const cmd = argv[0];
  switch (cmd) {
    case undefined:
      return { kind: "usage", exitCode: 2 };
    case "version":
    case "--version":
    case "-v":
      return { kind: "version" };
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "up":
      return { kind: "up" };
    case "down":
      return { kind: "down" };
    case "auth":
      return { kind: "auth" };
    case "logs":
      return { kind: "logs" };
    case "runtime":
      return { kind: "runtime" };
    case "learn":
      // `tonoman learn` — persist a learning to the right git (learn-durable). Flags parsed by the handler.
      return { kind: "learn", args: argv.slice(1) };
    case "sync":
      // `tonoman sync` — refresh the local registry checkout to canonical upstream (pull merged skills).
      return { kind: "sync" };
    case "backend": {
      // `tonoman backend <agent> [subscription|bedrock]` — live auth-backend switch (backend-switch-live).
      const agent = argv[1];
      if (!agent)
        return { kind: "usage", exitCode: 2, error: "backend: missing agent (try: tonoman backend <agent> [subscription|bedrock])" };
      return { kind: "backend", agent, mode: argv[2] };
    }
    case "get":
    case "create":
    case "delete":
    case "set":
    case "open":
    case "close": {
      const token = argv[1];
      const resource = token ? RESOURCES[token] : undefined;
      if (!resource) {
        return {
          kind: "usage",
          exitCode: 2,
          error: token ? `unknown resource: "${token}"` : `${cmd}: missing resource (try: agents | mounts | services | memory | browser)`,
        };
      }
      if ((cmd === "open" || cmd === "close") && resource !== "browsers") {
        return { kind: "usage", exitCode: 2, error: `${cmd} only supports: browser (e.g. tonoman ${cmd} browser -a <agent>)` };
      }
      return { kind: cmd, resource };
    }
    default:
      return { kind: "usage", exitCode: 2, error: `unknown command: "${cmd}"` };
  }
}

/** Reads the RAW config (no defaults applied) — used by read views and the write
 * path, which must round-trip the file verbatim. */
async function readRaw(cfgPath: string): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(cfgPath, "utf8");
  } catch (e) {
    throw new Error(`config: read ${cfgPath}: ${(e as Error).message}`);
  }
  return JSON.parse(raw) as Config;
}

/** The roster, from whichever control plane this deployment runs under (§1 seam).
 *
 *  Self-hosted Tonoman reads settings.json and behaves exactly as before. Tonoman Cloud sets
 *  TONOMANCLOUD_API_URL and the roster comes from the registry instead, which is what makes an
 *  agent a row rather than a pull request against infrastructure. Nothing downstream — router,
 *  queue, harness, connectors — can tell the difference. */
async function loadRoster(cfgPath: string): Promise<Config> {
  const plane = controlPlaneFrom(process.env, cfgPath);
  const cfg = await plane.roster();
  console.log(`tonoman: roster from ${plane.name()} — ${cfg.agents?.length ?? 0} agent(s)`);
  return cfg;
}

async function runUp(cfgPath: string, env: string | undefined): Promise<void> {
  const cfg = await loadRoster(cfgPath);
  applyEnv(cfg, env); // co-locate state + suffix containers for a named env (cli-env)
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  await gateway.run(cfg, ac.signal);
}

/** `tonoman down` — stop the running control plane gracefully via the gateway's
 * loopback /shutdown endpoint (the gateway then stops its agent containers too).
 * Idempotent: if nothing is listening, the plane is already down. */
async function runDown(cfgPath: string, env: string | undefined): Promise<void> {
  const cfg = await load(cfgPath);
  applyEnv(cfg, env); // the env's gateway has its own health_addr
  const url = `http://${cfg.health_addr}/shutdown`;
  try {
    const resp = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`shutdown returned ${resp.status}`);
    process.stdout.write("Control plane stopping (gateway + agent containers).\n");
  } catch {
    // Not reachable → nothing to stop. `down` is idempotent (mirrors how `get services`
    // degrades when the gateway is down) rather than erroring.
    process.stdout.write(`Control plane is not up (nothing at ${cfg.health_addr}).\n`);
  }
}

/** `tonoman backend <agent> [mode]` — switch an agent's auth backend live via the gateway's
 * loopback /backend endpoint (backend-switch-live), effect next turn. No mode → report current.
 * Operator-only (loopback; in the cluster run it via `kubectl exec` into the gateway pod). */
async function runBackend(cfgPath: string, env: string | undefined, agent: string, mode: string | undefined): Promise<void> {
  const cfg = await load(cfgPath);
  applyEnv(cfg, env); // the env's gateway has its own health_addr
  const url = `http://${cfg.health_addr}/backend`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, backend: mode }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await resp.json().catch(() => ({}))) as { ok?: boolean; msg?: string };
    process.stdout.write((body.msg ?? (resp.ok ? "ok" : `error ${resp.status}`)) + "\n");
    if (!resp.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(`Control plane is not up (nothing at ${cfg.health_addr}).\n`);
    process.exitCode = 1;
  }
}

/** Resolves an agent to the AuthOps that can log it in (roster-auth-headless / roster-auth-remote).
 * A LOCAL agent is driven through `podman exec`; a REMOTE one (claude-code-http, the k8s split) has
 * no podman and no shared filesystem, so it's driven over its own runtime's /auth/* endpoints. The
 * operator's command is the same either way — resolving the transport is our job, not theirs. */
export function resolveAuthOps(cfg: Config, agentName: string): AuthOps {
  const ac = findAgent(cfg, agentName);
  const spec = gateway.defaultHarnesses().lookup(ac.harness ?? "");
  if (!spec) throw new Error(`agent "${ac.name}" has unknown harness "${ac.harness}"`);

  // A service harness (svc-self-channeled) authenticates via injected env (svc-config-env), not an
  // interactive login — it has no login flow at all.
  if (spec.service) {
    throw new Error(`agent "${ac.name}" runs the service harness "${ac.harness}" — auth is injected env (svc-config-env), no login flow`);
  }

  // REMOTE (the k8s split) is decided BEFORE the login-args check, and that order is load-bearing.
  // A remote harness deliberately declares NO loginArgs/statusArgs: the argv comes from the AGENT's
  // own harness spec, pod-side, never from this process and never off the wire (that's what keeps
  // /auth/login from being a remote-exec hole). Checking for those args first therefore rejected
  // every remote agent as if it were a service harness, which made `tonoman auth login --headless`
  // impossible across the split — the exact flow roster-auth-remote exists to provide.
  if (spec.remote) {
    if (!ac.url) throw new Error(`agent "${ac.name}" is remote (${ac.harness}) but has no "url" in the roster`);
    return httpAuthOps(ac.url, process.env.AGENT_RUNTIME_TOKEN);
  }

  // Local (podman): we drive `claude` in the agent's container, so we DO need its argv.
  if (!spec.loginArgs || !spec.statusArgs) {
    throw new Error(`agent "${ac.name}" runs harness "${ac.harness}", which declares no login/status commands — no login flow`);
  }
  return podmanAuthOps(ac.container, spec.loginArgs, spec.statusArgs, spec.credFile);
}

async function runAuth(cfgPath: string, env: string | undefined, args: string[]): Promise<void> {
  const action = args[0];
  const positional = args.filter((a) => !a.startsWith("-"));
  const headless = args.includes("--headless");

  // `tonoman auth code <agent> <code>` — finish a headless login (roster-auth-headless).
  if (action === "code") {
    const agent = positional[1];
    const code = positional[2];
    if (!agent || !code) {
      process.stderr.write("usage: tonoman auth code <agent> <code>\n");
      process.exit(2);
      return;
    }
    // The roster, not the file: under Cloud the agent being authenticated exists only as a row.
    const cfg = await loadRoster(cfgPath);
    applyEnv(cfg, env);
    const r = await resolveAuthOps(cfg, agent).submitCode(code);
    process.stdout.write(r.ok ? `Authenticated "${agent}" ✓\n` : `Submitted code for "${agent}", but auth status isn't logged-in yet — check the detail below.\n`);
    if (r.status) process.stdout.write(`  auth status: ${r.status.replace(/\s+/g, " ").slice(0, 240)}\n`);
    if (!r.ok && r.loginTail) process.stdout.write(`  login output: ${r.loginTail.replace(/\s+/g, " ").slice(0, 240)}\n`);
    return;
  }

  if (positional.length < 2) {
    process.stderr.write("usage: tonoman auth <login [--headless] | code <agent> <code> | status | logout> <agent>\n");
    process.exit(2);
    return;
  }
  const agent = positional[1];
  const cfg = await loadRoster(cfgPath);
  applyEnv(cfg, env); // auth execs into the env's (suffixed) container

  // `tonoman auth login <agent> --headless` — print the OAuth URL; no local browser/TTY needed.
  // Works for a local (podman) agent AND one across the k8s split (roster-auth-remote).
  if (action === "login" && headless) {
    const url = await resolveAuthOps(cfg, agent).startHeadless();
    process.stdout.write(`Open this URL to authenticate "${agent}" (any device — e.g. your phone):\n\n  ${url}\n\nSign in with the account this agent should own, authorize, then finish with:\n  tonoman auth code ${agent} <CODE>\n`);
    return;
  }
  await gateway.auth(action, agent, cfg);
}

function printAgent(ag: AgentConfig): void {
  const n = listMounts(ag).length;
  process.stdout.write(`▸ ${ag.name}\n`);
  if (ag.role) process.stdout.write(`    role:    ${ag.role}\n`);
  process.stdout.write(`    harness: ${ag.harness ?? "claude-code"}   model: ${ag.model ?? "(default)"}   container: ${ag.container}\n`);
  process.stdout.write(`    mounts:  ${n}${n ? ` (get mounts -a ${ag.name})` : ""}\n`);
}

/** `tonoman get <agents|mounts|services> [name] [flags]` — read views. */
async function runGet(resource: Resource, cfgPath: string, args: string[]): Promise<void> {
  if (resource === "services") {
    const cfg = await load(cfgPath); // needs defaults (health_addr)
    const rep = await health.fetchReport(cfg.health_addr);
    process.stdout.write(health.render(rep));
    return;
  }

  if (resource === "memory") {
    await runGetMemory(cfgPath, args);
    return;
  }

  if (resource === "browsers") {
    await runGetBrowsers(cfgPath, args);
    return;
  }

  const { agent, podman, pos } = parseMountsArgs(args);
  const cfg = await readRaw(cfgPath);

  if (resource === "agents") {
    const name = pos[0];
    if (name) {
      printAgent(findAgent(cfg, name)); // by-name; errors if unknown
      return;
    }
    const agents = cfg.agents ?? [];
    if (agents.length === 0) {
      process.stdout.write("(no agents configured)\n");
      return;
    }
    for (const ag of agents) process.stdout.write(`▸ ${ag.name}${ag.role ? ` — ${ag.role}` : ""}\n`);
    return;
  }

  // resource === "mounts"
  if (podman) {
    const a = findAgent(cfg, agent); // --podman feeds ONE container's bring-up → needs a specific agent
    process.stdout.write(podmanVolumeArgs(a).join(" ") + "\n");
    return;
  }
  // grouped by agent (no -a) or one agent (-a) — the per-agent nature is always visible.
  const agents = agent ? [findAgent(cfg, agent)] : (cfg.agents ?? []);
  if (agents.length === 0) {
    process.stdout.write("(no agents configured)\n");
    return;
  }
  for (const ag of agents) {
    process.stdout.write(`▸ ${ag.name}\n`); // mounts belong to THIS agent only
    const ms = listMounts(ag);
    if (ms.length === 0) process.stdout.write("    (no shared folders)\n");
    else for (const m of ms) process.stdout.write(`    ${m.name}\t${m.host} -> ${agentMountPath(m.name)}${m.read_only ? "  (ro)" : ""}\n`);
  }
}

/** `tonoman <create|delete> mount …` — per-agent, by-convention writes (no JSON
 * hand-editing). Resolves the target agent (the only one, or -a) then delegates. */
async function runMutate(verb: "create" | "delete", resource: Resource, cfgPath: string, args: string[]): Promise<void> {
  if (resource !== "mounts") {
    process.stderr.write(`${verb} only supports: mount (e.g. tonoman ${verb} mount <name> <host> -a <agent>)\n`);
    process.exit(2);
  }
  const { agent, ro, pos } = parseMountsArgs(args);
  const cfg = await readRaw(cfgPath);
  const save = (): Promise<void> => fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  const a = findAgent(cfg, agent); // the only agent, or -a; errors + lists on ambiguity

  if (verb === "create") {
    const name = pos[0];
    const host = pos[1];
    if (!name || !host) {
      process.stderr.write("usage: tonoman create mount <name> <host-path> [--ro] [-a NAME]\n");
      process.exit(2);
    }
    const r = upsertMount(a, { name, host, read_only: ro || undefined });
    await save();
    process.stdout.write(`${r} "${name}" → ${agentMountPath(name)} (host ${host}${ro ? ", ro" : ""}) for ${a.name}.\n`);
    process.stdout.write(`(recreate the sandbox to mount it — its -v comes from: tonoman get mounts -a ${a.name} --podman)\n`);
    return;
  }

  // verb === "delete"
  const name = pos[0];
  if (!name) {
    process.stderr.write("usage: tonoman delete mount <name> [-a NAME]\n");
    process.exit(2);
  }
  const removed = removeMount(a, name);
  if (removed) await save();
  process.stdout.write(removed ? `Removed "${name}" from ${a.name}.\n` : `No shared folder "${name}" on ${a.name}.\n`);
}

/** Strips any credentials embedded in a git URL so a remote is never printed with a token. */
function sanitizeRemote(url: string): string {
  return url.replace(/\/\/[^/@]+@/, "//");
}

/** The agent's memory git root (mirrors the gateway's derivation). */
function memRoot(cfg: Config, a: AgentConfig): string {
  return a.workspace?.root || path.join(cfg.state_root ?? "", a.guid || a.name, "memory");
}

/** Best-effort `git -C <root> …`; returns trimmed stdout, or "" on any error. */
function gitOut(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile("git", ["-C", root, ...args], { windowsHide: true }, (err, so) => resolve(err ? "" : (so?.toString() ?? "").trim())),
  );
}

/** `tonoman get memory [-a NAME]` — show each agent's git-memory config + live status. */
async function runGetMemory(cfgPath: string, args: string[]): Promise<void> {
  const { agent } = parseMountsArgs(args);
  const cfg = await readRaw(cfgPath);
  const agents = agent ? [findAgent(cfg, agent)] : (cfg.agents ?? []);
  if (agents.length === 0) {
    process.stdout.write("(no agents configured)\n");
    return;
  }
  for (const a of agents) {
    const ws = a.workspace ?? {};
    const root = memRoot(cfg, a);
    const last = await gitOut(root, ["log", "-1", "--format=%h %s (%cr)"]);
    const dirty = await gitOut(root, ["status", "--porcelain"]);
    process.stdout.write(`▸ ${a.name} — memory (git)\n`);
    process.stdout.write(`    root:        ${root}\n`);
    process.stdout.write(`    remote:      ${ws.remote ? sanitizeRemote(ws.remote) : "(local only — no push)"}\n`);
    process.stdout.write(`    branch:      ${ws.branch ?? "(current)"}\n`);
    process.stdout.write(`    auto-commit: ${ws.auto_commit === false ? "off" : "on"}\n`);
    process.stdout.write(`    status:      ${last ? (dirty ? "dirty (uncommitted changes)" : "clean") : "no git repo yet"}\n`);
    if (last) process.stdout.write(`    last commit: ${last}\n`);
  }
}

/** `tonoman set memory git --remote URL [--branch B] [--auto-commit on|off] [-a NAME]` —
 * configure an agent's git memory (the non-secret fields only; the push token comes from
 * env, never written here). `git` is the memory TYPE — room for other types later. */
async function runSetMemory(resource: Resource, cfgPath: string, args: string[]): Promise<void> {
  if (resource !== "memory") {
    process.stderr.write(`set only supports: memory (e.g. tonoman set memory git --remote <url> [-a NAME])\n`);
    process.exit(2);
    return;
  }
  let remote: string | undefined;
  let branch: string | undefined;
  let autoStr: string | undefined;
  let agent: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--remote") remote = args[++i];
    else if (a === "--branch") branch = args[++i];
    else if (a === "--auto-commit") autoStr = args[++i];
    else if (a === "--agent" || a === "-a") agent = args[++i];
    else pos.push(a);
  }
  if (pos[0] !== "git") {
    process.stderr.write("usage: tonoman set memory git --remote <url> [--branch <b>] [--auto-commit on|off] [-a NAME]\n");
    process.exit(2);
    return;
  }
  const cfg = await readRaw(cfgPath);
  const a = findAgent(cfg, agent);
  a.workspace ??= {};
  if (remote !== undefined) a.workspace.remote = remote;
  if (branch !== undefined) a.workspace.branch = branch;
  if (autoStr !== undefined) a.workspace.auto_commit = !/^(off|false|no|0)$/i.test(autoStr);
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  process.stdout.write(
    `Set ${a.name} memory (git): remote=${a.workspace.remote ? sanitizeRemote(a.workspace.remote) : "(none)"} branch=${a.workspace.branch ?? "(current)"} auto-commit=${a.workspace.auto_commit === false ? "off" : "on"}.\n`,
  );
  if (a.workspace.remote && !a.workspace.token) {
    process.stdout.write("Note: the push token is a secret — set it via env at gateway-run time, never in settings.json. Pushes are skipped until a token is present.\n");
  }
}

/** `tonoman logs [-a NAME] [-n N] [-f]` — view the gateway log (turns, broker ops, errors
 * with full claude stderr, memory warnings). `-a` filters to an agent's lines; `-f` follows. */
async function runLogs(env: string | undefined, args: string[]): Promise<void> {
  let n = 200;
  let follow = false;
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n" || a === "--lines") n = Number(args[++i]) || n;
    else if (a === "-f" || a === "--follow") follow = true;
    else if (a === "-a" || a === "--agent") agent = args[++i];
  }
  const file = gatewayLogPath(envRoot(env));
  const match = (line: string): boolean => !agent || line.includes(agent);
  let buf: string;
  try {
    buf = await fs.readFile(file, "utf8");
  } catch {
    process.stdout.write(`(no gateway log yet at ${file} — start the gateway with 'tonoman up')\n`);
    return;
  }
  const lines = buf.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - n - 1)).filter((l) => l && match(l));
  if (tail.length) process.stdout.write(tail.join("\n") + "\n");
  if (!follow) return;
  // follow: poll for growth and stream new (filtered) lines until Ctrl-C.
  let size = Buffer.byteLength(buf, "utf8");
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    let st: { size: number };
    try {
      st = await fs.stat(file);
    } catch {
      continue;
    }
    if (st.size < size) size = 0; // file rotated/truncated → re-read from start
    if (st.size <= size) continue;
    const fh = await fs.open(file, "r");
    const len = st.size - size;
    const b = Buffer.alloc(len);
    await fh.read(b, 0, len, size);
    await fh.close();
    size = st.size;
    for (const line of b.toString("utf8").split("\n")) if (line && match(line)) process.stdout.write(line + "\n");
  }
}

/** `tonoman runtime [--port N]` — boot the agent runtime HTTP server (k8s split). This runs
 * INSIDE the agent container; the gateway drives turns over HTTP (harness claude-code-http)
 * instead of `podman exec`. Stateless: model/maxTurns/systemPrompt arrive per request. Port
 * from --port, else $AGENT_RUNTIME_PORT, else 8080. Bearer from $AGENT_RUNTIME_TOKEN. */
/** Read all of stdin as a string (for the trace hook's Stop payload). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

/** Read + parse a JSONL transcript into entries (tolerant; [] on any error). */
async function readTranscript(p: string): Promise<unknown[]> {
  try {
    return (await fs.readFile(p, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      })
      .filter((x): x is unknown => x !== null);
  } catch {
    return [];
  }
}

/** Where the boot-captured static prefix (system + tools) is cached (fctx-boot-prefix). */
function prefixPath(configDir: string): string {
  return path.join(configDir, ".tonoman-fullctx-prefix.json");
}
async function readPrefix(configDir: string): Promise<ContextPrefix | null> {
  try {
    return JSON.parse(await fs.readFile(prefixPath(configDir), "utf8")) as ContextPrefix;
  } catch {
    return null;
  }
}

/** Capture the static prefix ONCE at boot (fctx-boot-prefix / fctx-out-of-path): run a throwaway
 * `claude` probe pointed at a loopback that captures the request body (system + tool schemas) and
 * short-circuits — nothing reaches a real model, nothing sits in the per-turn path. Best-effort:
 * failure just means no prefix (the hook still attaches the live messages). Idempotent (skips if cached). */
async function capturePrefix(configDir: string, identityFile?: string): Promise<void> {
  if (await readPrefix(configDir)) return; // already captured this boot's config
  const prefixFrom = (captured: string[]): ContextPrefix | null => {
    for (const body of captured) {
      try {
        const p = parsePrefix(JSON.parse(body));
        if (p && (p.system.length || p.tools.length)) return p;
      } catch {
        /* not JSON */
      }
    }
    return null;
  };
  // One probe: a throwaway `claude` whose model endpoint points at a loopback that captures the request
  // body (system + tool schemas) and short-circuits. `route` decides which endpoint env to override.
  const probe = async (route: "bedrock" | "anthropic"): Promise<string[]> => {
    const captured: string[] = [];
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (b) captured.push(b);
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"captured"}}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, IS_SANDBOX: "1", CLAUDE_CONFIG_DIR: configDir };
      if (route === "bedrock") env.ANTHROPIC_BEDROCK_BASE_URL = base;
      else {
        delete env.CLAUDE_CODE_USE_BEDROCK; // force the Anthropic/OAuth path onto our loopback
        env.ANTHROPIC_BASE_URL = base;
      }
      const args = ["-p", "ping", "--dangerously-skip-permissions", "--setting-sources", "user"];
      if (identityFile) args.push("--append-system-prompt-file", identityFile);
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (child?: ReturnType<typeof spawn>): void => {
          if (settled) return;
          settled = true;
          try {
            child?.kill();
          } catch {
            /* ignore */
          }
          resolve();
        };
        const child = spawn("claude", args, { env, windowsHide: true });
        const timer = setTimeout(() => finish(child), 25000);
        const poll = setInterval(() => {
          if (captured.length) {
            clearTimeout(timer);
            clearInterval(poll);
            finish(child);
          }
        }, 200);
        child.on("exit", () => (clearTimeout(timer), clearInterval(poll), finish()));
        child.on("error", () => (clearTimeout(timer), clearInterval(poll), finish()));
      });
      return captured;
    } finally {
      server.close();
    }
  };
  // Prefer the agent's real backend so the captured prefix matches production. If Bedrock's endpoint
  // override isn't honoured (nothing captured), fall back to the Anthropic/OAuth path — the tool
  // schemas are identical across backends and prod keeps OAuth creds for the live switch, so this is a
  // faithful-enough snapshot. Best-effort throughout (fctx-nonfatal).
  const bedrock = ["1", "true", "yes"].includes((process.env.CLAUDE_CODE_USE_BEDROCK || "").toLowerCase());
  let prefix = prefixFrom(bedrock ? await probe("bedrock") : await probe("anthropic"));
  if (!prefix && bedrock) prefix = prefixFrom(await probe("anthropic"));
  if (prefix) {
    await fs.writeFile(prefixPath(configDir), JSON.stringify(prefix));
    process.stdout.write(`tonoman runtime: full-context prefix captured (${prefix.system.length} system blocks, ${prefix.tools.length} tools)\n`);
  } else {
    process.stderr.write("tonoman runtime: full-context prefix capture yielded nothing (non-fatal)\n");
  }
}

/** Internal `__trace-hook` (obs-adapter-hook): Claude Code pipes the Stop payload to stdin; read the
 * transcript, decode to the neutral trace, post to the sink. Best-effort — never throws (obs-nonfatal). */
async function runTraceHook(): Promise<void> {
  const sink = sinkFromEnv();
  if (!sink) return;
  let payload: { transcript_path?: string; session_id?: string } = {};
  try {
    payload = JSON.parse(await readStdin()) as { transcript_path?: string; session_id?: string };
  } catch {
    return;
  }
  if (!payload.transcript_path) return;
  const backend = ["1", "true", "yes"].includes((process.env.CLAUDE_CODE_USE_BEDROCK || "").toLowerCase()) ? "bedrock" : "subscription";
  const extra = { session: payload.session_id, agent: process.env.AGENT_NAME, backend };
  // The Stop hook can fire before Claude flushes the turn's FINAL entries — so we re-read briefly
  // until the trace is complete (bounded, best-effort). Wait for BOTH usage AND the reply text: on a
  // turn with extended thinking, Claude writes the `thinking` entry (which ALREADY carries usage)
  // BEFORE the final `text` entry, so a usage-only guard would exit early and post an EMPTY output
  // (obs-trace-neutral: the reply is the whole point). The reply already streamed to the user, so
  // this short wait never delays the response.
  let entries = await readTranscript(payload.transcript_path);
  let trace = decodeClaudeTranscript(entries, extra);
  for (let i = 0; i < 10 && !((trace.tokens.input || trace.tokens.output) && trace.reply); i++) {
    await new Promise((r) => setTimeout(r, 300));
    entries = await readTranscript(payload.transcript_path);
    trace = decodeClaudeTranscript(entries, extra);
  }
  // full-context (fctx-*): when enabled, break the ENTIRE context (boot-captured system+tools + the
  // full message history) into per-section spans and attach them. Off by default → undefined → no-op.
  let sections: ContextSection[] | undefined;
  if (fullContextEnabled()) {
    const configDir = process.env.CLAUDE_CONFIG_DIR || CONFIG_HOME;
    // Peel any appended identity (the agent's AGENTS.md, injected via --append-system-prompt-file) out
    // of the base system block into its own span — same file we inject each turn, so it's exact.
    const appended: { label: string; text: string }[] = [];
    const idFile = process.env.AGENT_IDENTITY_FILE;
    if (idFile) {
      try {
        appended.push({ label: `identity: ${path.basename(idFile)}`, text: await fs.readFile(idFile, "utf8") });
      } catch {
        /* identity optional — degrade to the base block */
      }
    }
    sections = fullContextSections(await readPrefix(configDir), entries, appended);
  }
  await postTrace(sink, trace, undefined, sections);
}

/** Clone (or fast-forward) a repo into a WRITABLE working checkout at `dir` (learn-durable). Used for
 * BOTH the agent's own brain (personal LEARNED.md commits) and the org registry (so a skill can be
 * ITERATED locally — edited + tested live — before a `tonoman learn` PR persists it upstream; the RO
 * mount that blocked this was the bug). No-op unless dir + repo + a GitHub token are all set. The token
 * rides only the clone URL (never a logged argv). A local (uncommitted) edit survives the best-effort
 * pull, so in-progress iteration isn't clobbered. */
async function ensureCheckout(dir: string | undefined, repo: string | undefined, label: string): Promise<void> {
  const tok = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (!dir || !repo || !tok) return; // not configured — that's fine
  const { owner, name } = parseRepo(repo);
  const url = `https://x-access-token:${tok}@github.com/${owner}/${name}.git`;
  const runGit = (a: string[]): Promise<void> =>
    new Promise((resolve, reject) =>
      execFile("git", a, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err) =>
        err ? reject(new Error(`git ${a.find((x) => !x.startsWith("-")) ?? a[0]} exit ${(err as { code?: number }).code ?? "?"}`)) : resolve(),
      ),
    );
  const cloned = await fs.stat(path.join(dir, ".git")).then(() => true).catch(() => false);
  if (cloned) await runGit(["-C", dir, "pull", "--ff-only"]).catch(() => {}); // best-effort; local edits survive
  else await runGit(["clone", url, dir]); // full clone: a working checkout to iterate + PR from
  process.stdout.write(`tonoman runtime: ${label} checkout ready at ${dir}\n`);
}

/** Assemble the agent's skill set on boot (learn-durable read-side): baked PLATFORM skills
 * (TONOMAN_PLATFORM_SKILLS, default /opt/tonoman/skills) + the org REGISTRY (TONOMAN_REGISTRY_DIR,
 * a mounted checkout or clone), filtered to this agent's assignments. Scripts land on PATH. */
async function assembleAgentSkills(): Promise<void> {
  const registry = process.env.TONOMAN_REGISTRY_DIR; // mounted config_repo checkout (local) or a clone (cloud)
  const platform = process.env.TONOMAN_PLATFORM_SKILLS || "/opt/tonoman/skills";
  const target = path.join(process.env.CLAUDE_CONFIG_DIR || CONFIG_HOME, "skills");
  let assigned: string[] | undefined;
  if (registry) {
    const y = await fs.readFile(path.join(registry, "assignments.yaml"), "utf8").catch(() => "");
    if (y) assigned = parseAssignments(y, process.env.AGENT_NAME || "");
  }
  const r = await assembleSkills({
    target,
    platformDir: platform,
    registryDir: registry ? path.join(registry, "skills") : undefined,
    libDir: registry ? path.join(registry, "lib") : undefined,
    binDir: "/usr/local/bin",
    assigned,
  });
  const scripts = r.scripts.map((s) => s.replace(/\.(mjs|js)$/, ""));
  process.stdout.write(`tonoman runtime: skills assembled — ${r.skills.join(", ") || "none"}${scripts.length ? ` · scripts: ${scripts.join(", ")}` : ""}\n`);
}

/** `tonoman sync` (learn-durable) — the governed "pull the merged upstream" verb, so the agent never
 * has to improvise raw git. Fetches the org registry and HARD-RESETS the local checkout to canonical
 * `main` (local un-PR'd scratch is intentionally discarded — that's what "sync to canonical" means),
 * then re-assembles the skill set. Prints a JSON receipt. */
async function runSync(): Promise<void> {
  const dir = process.env.TONOMAN_REGISTRY_DIR;
  if (!dir) {
    process.stdout.write(JSON.stringify({ ok: false, error: "no TONOMAN_REGISTRY_DIR configured" }) + "\n");
    return;
  }
  const runGit = (a: string[]): Promise<void> =>
    new Promise((resolve, reject) =>
      execFile("git", a, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err) =>
        err ? reject(new Error(`git ${a.find((x) => !x.startsWith("-")) ?? a[0]} exit ${(err as { code?: number }).code ?? "?"}`)) : resolve(),
      ),
    );
  await runGit(["-C", dir, "fetch", "origin", "main"]);
  await runGit(["-C", dir, "reset", "--hard", "origin/main"]);
  await assembleAgentSkills();
  const sha = await new Promise<string>((resolve) =>
    execFile("git", ["-C", dir, "rev-parse", "--short", "HEAD"], (e, so) => resolve(e ? "?" : (so ?? "").toString().trim())),
  );
  process.stdout.write(JSON.stringify({ ok: true, synced: "registry", ref: sha }) + "\n");
}

async function runRuntime(args: string[]): Promise<void> {
  let port = Number(process.env.AGENT_RUNTIME_PORT) || 8080;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") port = Number(args[++i]) || port;
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length)) || port;
  }
  const token = process.env.AGENT_RUNTIME_TOKEN || undefined;
  const identityFile = process.env.AGENT_IDENTITY_FILE || undefined;
  // learn-durable: writable working checkouts of the brain (personal LEARNED.md) and the org registry
  // (so skills can be iterated locally, then persisted via PR). Best-effort — turns run regardless.
  await ensureCheckout(process.env.TONOMAN_BRAIN_DIR, process.env.TONOMAN_BRAIN_REPO, "brain").catch((e) => process.stderr.write(`tonoman runtime: brain checkout skipped (${(e as Error).message})\n`));
  await ensureCheckout(process.env.TONOMAN_REGISTRY_DIR, process.env.TONOMAN_CONFIG_REPO, "registry").catch((e) => process.stderr.write(`tonoman runtime: registry checkout skipped (${(e as Error).message})\n`));
  // Assemble the agent's skills from the baked PLATFORM set + the org REGISTRY (assignment-filtered).
  // Best-effort — a turn still runs against whatever skills already resolved.
  await assembleAgentSkills().catch((e) => process.stderr.write(`tonoman runtime: skill assembly skipped (${(e as Error).message})\n`));
  // Observability (obs-runtime-registers): if a trace sink is configured, the runtime wires the
  // harness's telemetry ITSELF on boot via the harness Spec's telemetry adapter — no initContainer,
  // no image-baked hook. Harness-neutral: a Codex/OpenCode runtime would use its own spec's adapter.
  const sink = sinkFromEnv();
  const telemetry = claudecodeSpec().telemetry;
  if (sink && telemetry) {
    try {
      await telemetry.register({ configDir: process.env.CLAUDE_CONFIG_DIR || CONFIG_HOME, cliPath: process.argv[1] || "", sink });
      process.stdout.write(`tonoman runtime: registered ${telemetry.kind} telemetry (sink configured)\n`);
    } catch (e) {
      process.stderr.write(`tonoman runtime: telemetry registration failed (non-fatal): ${(e as Error).message}\n`);
    }
    // full-context (fctx-boot-prefix): capture the static system+tools prefix ONCE at boot so the
    // hook can assemble the entire context post-hoc. Non-fatal; only when the flag is on.
    if (fullContextEnabled()) {
      try {
        await capturePrefix(process.env.CLAUDE_CONFIG_DIR || CONFIG_HOME, identityFile);
      } catch (e) {
        process.stderr.write(`tonoman runtime: full-context prefix capture failed (non-fatal): ${(e as Error).message}\n`);
      }
    }
  }
  // Claude-Code-specific tools to drop from every turn (context-floor trim). Backend-scoped env:
  // a Codex/OpenCode runtime would read its OWN knob with its own tool taxonomy (see RunnerOptions).
  const disallowedTools = (process.env.CLAUDE_CODE_DISALLOWED_TOOLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  serveRuntime({ port, token, identityFile, disallowedTools: disallowedTools.length ? disallowedTools : undefined });
  process.stdout.write(
    `tonoman runtime: agent HTTP server on :${port} ${token ? "(bearer required)" : "(no auth — set AGENT_RUNTIME_TOKEN)"}` +
      `${identityFile ? ` identity=${identityFile}` : ""}${disallowedTools.length ? ` disallowedTools=${disallowedTools.join(",")}` : ""}\n`,
  );
  // Stay up until signalled (the pod's main process).
  await new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });
}

function usage(): void {
  process.stdout.write(`tonoman — control plane for AI agents

Usage:
  tonoman <command> [flags]
  tonoman <get|create|delete> <resource> [name] [flags]

Commands:
  up                                   Bring the control plane up: agents' containers + gateway
  down                                 Bring it down gracefully: gateway + agents' containers (stop, not rm)
  backend <agent> [mode]               Switch an agent's auth backend live: subscription | bedrock (no mode = show current)
  get <resource> [name]                List/show: agents | mounts | services | memory
  create agent <name>                  Provision a new agent [--from AGENT | --login] [--role R] [--mount n=host[:ro]] [--skill DIR]
  create mount <name> <host>           Add a shared folder to an agent [-a NAME] [--ro]
  delete mount <name>                  Remove a shared folder from an agent [-a NAME]
  set memory git                       Configure an agent's git memory [--remote URL] [--branch B] [--auto-commit on|off] [-a NAME]
  create browser -a NAME               Provision an agent's Chrome sidecar (CDP + noVNC); adopt-safe
  open browser -a NAME                 Open the live noVNC viewer to watch the agent browse
  close browser -a NAME                Stop the agent's browser (profile kept)
  delete browser -a NAME               Remove the agent's browser sidecar [--purge to wipe the profile]
  auth login <agent> [--headless]      Authenticate an agent's harness (--headless: print URL, finish with 'auth code')
  auth code <agent> <code>             Finish a --headless login with the code from the browser
  auth <status|logout> <agent>         Show / clear an agent's harness auth
  logs [-a NAME] [-n N] [-f]           View the gateway log (turns, broker ops, errors); -f to follow
  runtime [--port N]                   Run the agent runtime HTTP server in-container (k8s split;
                                       gateway drives turns over HTTP via the claude-code-http harness)
  version                              Print version
  help                                 Show this help

Resources (for get):
  agents     configured agents          (get agents | get agent <name>)
  mounts     an agent's shared folders  (get mounts [-a NAME] [--podman])
  services   substrate + agent health   (get services)
  memory     an agent's git-memory config + status  (get memory [-a NAME])

Flags:
  -a, --agent NAME   scope a resource to an agent (the agent namespace)
  --config FILE      explicit config file (overrides TONOMAN_ENV / $TONOMAN_CONFIG)

Environment:
  TONOMAN_ENV=NAME   set once to use an isolated environment: config/state in
                     ~/.tonoman-NAME, containers suffixed -NAME (dev never disrupts
                     prod). Unset → ~/.tonoman. Every command echoes its resolved env.

Docs: https://github.com/tonoman-com/tonoman
`);
}

/** Print the resolved environment so the operator always sees which env a (possibly
 * destructive) command will touch. To stderr, so parseable stdout (e.g. `get mounts
 * --podman`) is unaffected. */
function echoEnv(env: string | undefined): void {
  process.stderr.write(`env: ${env ?? "default"}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Internal: the post-turn trace hook (obs-adapter-hook). Registered into the runtime's settings by
  // registerClaudeHook; Claude Code invokes it with the Stop payload on stdin. Not a user command.
  if (argv[0] === "__trace-hook") {
    await runTraceHook();
    return;
  }
  const { cfgPath, rest } = parseGlobalFlags(argv);
  const env = currentEnv();
  const res = resolveCommand(rest);
  switch (res.kind) {
    case "version":
      process.stdout.write(`tonoman ${VERSION}\n`);
      return;
    case "help":
      usage();
      return;
    case "usage":
      if (res.error) process.stderr.write(`${res.error}\n\n`);
      usage();
      process.exit(res.exitCode);
      return;
    case "up":
      echoEnv(env);
      await runUp(cfgPath, env);
      return;
    case "down":
      echoEnv(env);
      await runDown(cfgPath, env);
      return;
    case "auth":
      echoEnv(env);
      await runAuth(cfgPath, env, rest.slice(1));
      return;
    case "logs":
      echoEnv(env);
      await runLogs(env, rest.slice(1));
      return;
    case "runtime":
      echoEnv(env);
      await runRuntime(rest.slice(1));
      return;
    case "learn":
      // In-process, agent-side (learn-durable Model B): a JSON receipt on stdout, no env echo (keeps
      // stdout parseable for the calling agent). Errors surface as a JSON {ok:false} + exit 1 below.
      try {
        await runLearn(res.args);
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }) + "\n");
        process.exit(1);
      }
      return;
    case "sync":
      try {
        await runSync();
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }) + "\n");
        process.exit(1);
      }
      return;
    case "backend":
      echoEnv(env);
      await runBackend(cfgPath, env, res.agent, res.mode);
      return;
    case "get":
      echoEnv(env);
      await runGet(res.resource, cfgPath, rest.slice(2));
      return;
    case "create":
      echoEnv(env);
      if (res.resource === "agents") await runCreateAgent(cfgPath, env, rest.slice(2));
      else if (res.resource === "browsers") await runCreateBrowser(cfgPath, rest.slice(2));
      else await runMutate("create", res.resource, cfgPath, rest.slice(2));
      return;
    case "delete":
      echoEnv(env);
      if (res.resource === "browsers") await runDeleteBrowser(cfgPath, rest.slice(2), { purge: parseBrowserPurge(rest.slice(2)) });
      else await runMutate("delete", res.resource, cfgPath, rest.slice(2));
      return;
    case "set":
      echoEnv(env);
      await runSetMemory(res.resource, cfgPath, rest.slice(2));
      return;
    case "open":
      echoEnv(env);
      await runOpenBrowser(cfgPath, rest.slice(2));
      return;
    case "close":
      echoEnv(env);
      await runDeleteBrowser(cfgPath, rest.slice(2), { stopOnly: true });
      return;
  }
}

// Only run when invoked as the CLI entrypoint — importing this module (e.g. from
// cli.test.ts to reach the pure resolvers) must NOT dispatch or exit.
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`tonoman: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
