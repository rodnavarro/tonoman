// `tonoman tunnel <up|down|status> <agent>` — the effectful half of runtime/tunnel.
//
// Keeps the dev tunnel's lifecycle with the PLATFORM rather than a per-agent shell script: the
// same verbs work for any agent on any channel that needs a public webhook, and `tonoman up`
// reuses `startAgentTunnel` so a configured agent gets its tunnel automatically.
//
// The child is spawned DETACHED with its pid persisted to <stateRoot>/<guid>/tunnel.json, so a
// later process (`tunnel down`, `tunnel status`, or a restarted gateway) can still manage it —
// the orphaned-background-process problem this feature exists to solve.

import { promises as fs } from "node:fs";
import { spawn, execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { Config, AgentConfig } from "./config";
import { agentDirs } from "./provision";
import { startTunnel, repointBot, messagingEndpoint, type TunnelConfig, type TunnelDeps, type TunnelState } from "./runtime/tunnel";

/** Default webhook port — must match the Teams connector's default (see connector/teams.ts). */
const DEFAULT_TEAMS_PORT = 3979;

/** Real seams over node's child_process. The tunnel child is detached + unref'd so it outlives
 * the CLI invocation that started it (the whole point: it must stay up alongside the gateway). */
export function nodeDeps(logFile?: string): TunnelDeps {
  return {
    async spawnTunnel(bin, args, onOutput) {
      const child = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const handle = (b: Buffer) => {
        const s = b.toString();
        onOutput(s);
        if (logFile) void fs.appendFile(logFile, s).catch(() => {});
      };
      child.stdout?.on("data", handle);
      child.stderr?.on("data", handle); // cloudflared prints its banner on stderr
      child.on("error", (e) => onOutput(`ERROR ${e.message}`));
      if (!child.pid) throw new Error(`tunnel: failed to spawn ${bin}`);
      child.unref();
      return child.pid;
    },
    repoint(azBin, args) {
      // Windows: `az` is az.cmd, and since Node 18 a .cmd/.bat cannot be spawned directly
      // (EINVAL, CVE-2024-27980) — it must go through a shell. The path is quoted because it
      // normally lives under "Program Files", and args are quoted for the same reason.
      const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(azBin);
      const q = (s: string) => (/[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      const fail = (err: Error, stderr: unknown) =>
        new Error(`tunnel: repoint failed (${azBin} ${args.slice(0, 2).join(" ")}): ${String(stderr || err.message).split("\n")[0]}`);
      return new Promise<void>((resolve, reject) => {
        const done = (err: Error | null, _o: unknown, stderr: unknown) => (err ? reject(fail(err, stderr)) : resolve());
        if (viaShell) execFile(q(azBin), args.map(q), { shell: true, maxBuffer: 1 << 24 }, done);
        else execFile(azBin, args, { maxBuffer: 1 << 24 }, done);
      });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}

function stateRootOf(cfg: Config): string {
  return cfg.state_root || path.join(os.homedir() || ".", ".tonoman");
}

/** Where a running tunnel's pid/url is recorded, beside the agent's other per-agent state. */
export function tunnelStatePath(cfg: Config, a: AgentConfig): string {
  return path.join(agentDirs({ ...cfg, state_root: stateRootOf(cfg) } as Config, a).base, "tunnel.json");
}

async function readState(p: string): Promise<TunnelState | undefined> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as TunnelState;
  } catch {
    return undefined;
  }
}

/** Whether a recorded pid is still alive (signal 0 = existence check, no signal delivered). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves an agent's tunnel config, merging the agent-level `tunnel_bin` fallback. */
export function tunnelConfigFor(a: AgentConfig): { cfg: TunnelConfig; port: number } | undefined {
  const t = a.teams?.tunnel;
  if (!t?.enabled) return undefined;
  return { cfg: { ...t, bin: t.bin || a.tunnel_bin || "cloudflared" }, port: a.teams?.port ?? DEFAULT_TEAMS_PORT };
}

/** Brings an agent's tunnel up (idempotent: a live one is adopted, never duplicated) and records
 * it. Returns undefined when the agent hasn't opted in. Shared with the gateway. */
export async function startAgentTunnel(cfg: Config, a: AgentConfig, log: (m: string) => void = () => {}): Promise<TunnelState | undefined> {
  const resolved = tunnelConfigFor(a);
  if (!resolved) return undefined;
  const sp = tunnelStatePath(cfg, a);
  const existing = await readState(sp);
  if (existing && pidAlive(existing.pid)) {
    log(`tunnel: already up (pid ${existing.pid}) ${existing.url}`);
    return existing;
  }
  await fs.mkdir(path.dirname(sp), { recursive: true });
  const deps = nodeDeps(path.join(path.dirname(sp), "tunnel.log"));
  const st = await startTunnel(resolved.cfg, resolved.port, deps, log);
  // Persist BEFORE repointing: if the repoint fails, the tunnel is still recorded and therefore
  // still manageable (`tunnel down`) instead of becoming an orphaned process.
  await fs.writeFile(sp, JSON.stringify(st, null, 2) + "\n", "utf8");
  try {
    await repointBot(resolved.cfg, st.url, deps, log);
  } catch (e) {
    // Loud, not fatal: the tunnel is up and tracked, but Teams will not reach it until the bot
    // endpoint is corrected — and that failure mode is otherwise completely silent.
    log(`tunnel: WARNING — tunnel is up but the bot endpoint was NOT updated: ${(e as Error).message}`);
    log(`tunnel: set it manually → ${messagingEndpoint(st.url)}`);
  }
  return st;
}

/** Stops an agent's tunnel and clears its state. Idempotent. */
export async function stopAgentTunnel(cfg: Config, a: AgentConfig, log: (m: string) => void = () => {}): Promise<boolean> {
  const sp = tunnelStatePath(cfg, a);
  const st = await readState(sp);
  if (!st) {
    log("tunnel: not running (no state)");
    return false;
  }
  let killed = false;
  if (pidAlive(st.pid)) {
    try {
      process.kill(st.pid);
      killed = true;
    } catch (e) {
      log(`tunnel: could not stop pid ${st.pid}: ${(e as Error).message}`);
    }
  }
  await fs.rm(sp, { force: true });
  log(killed ? `tunnel: stopped (pid ${st.pid})` : "tunnel: was not running; cleared stale state");
  return killed;
}

/** `tonoman tunnel <up|down|status> <agent>` */
export async function runTunnel(cfgPath: string, _env: string | undefined, args: string[]): Promise<void> {
  const [action, name] = args;
  if (!action || !name || !["up", "down", "status"].includes(action)) {
    process.stderr.write("usage: tonoman tunnel <up|down|status> <agent>\n");
    process.exit(2);
    return;
  }
  const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Config;
  const a = (cfg.agents ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  if (!a) throw new Error(`tunnel: no such agent "${name}" in ${cfgPath}`);
  const log = (m: string): void => {
    process.stdout.write(m + "\n");
  };

  if (action === "status") {
    const st = await readState(tunnelStatePath(cfg, a));
    if (!st) return log(`tunnel: down (${name})`);
    return log(pidAlive(st.pid) ? `tunnel: up (${name}) ${st.url} → :${st.port} (pid ${st.pid}, since ${st.startedAt})` : `tunnel: DEAD (${name}) — stale pid ${st.pid}; run 'tonoman tunnel up ${name}'`);
  }
  if (action === "down") {
    await stopAgentTunnel(cfg, a, log);
    return;
  }
  // up
  if (!tunnelConfigFor(a)) {
    throw new Error(`tunnel: agent "${name}" has no teams.tunnel.enabled config — nothing to start (this is local-dev only; in k8s use a real ingress).`);
  }
  const st = await startAgentTunnel(cfg, a, log);
  if (st) log(`tunnel: ready — Teams endpoint ${messagingEndpoint(st.url)}`);
}
