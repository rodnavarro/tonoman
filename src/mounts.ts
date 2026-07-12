// Shared-folder (mount/grant) management — the model behind `tonoman get/create/delete mount`.
// A "mount" is a host folder the operator grants an agent: it surfaces in the sandbox
// at ~/files/<name> (A9) and becomes an allowed broker bind-grant. These helpers are
// pure (operate on a parsed Config object) so the CLI is a thin read → mutate → write
// shell over them, and so the convention lives in ONE place — no hardcoded paths.

import type { Config, AgentConfig, Mount } from "./config";

/** The sandbox path an agent sees a granted mount at (A9): /root/files/<name>. The
 * broker rewrites this to the host path. Single source of truth for the convention. */
export const FILES_ROOT = "/root/files";
export function agentMountPath(name: string): string {
  return `${FILES_ROOT}/${name}`;
}

/** The sandbox path a mount binds at: its explicit `target` (cfg-mount-target, e.g. ~/.aws)
 * or the default ~/files/<name>. One place, so the CLI render and the broker grant agree. */
export function mountPath(m: Mount): string {
  return m.target || agentMountPath(m.name);
}

/** Resolves which agent a mounts command targets: the named one, or the only agent
 * when there is exactly one. Throws a clear error otherwise — never guesses. */
export function findAgent(cfg: Config, agent?: string): AgentConfig {
  const agents = cfg.agents ?? [];
  if (agent) {
    const a = agents.find((x) => (x.name ?? "").toLowerCase() === agent.toLowerCase());
    if (!a) throw new Error(`no agent "${agent}" in config (have: ${agents.map((x) => x.name).join(", ") || "none"})`);
    return a;
  }
  if (agents.length === 1) return agents[0];
  if (agents.length === 0) throw new Error("no agents configured");
  throw new Error(`config has multiple agents — pass --agent <name> (have: ${agents.map((x) => x.name).join(", ")})`);
}

/** Adds or replaces a mount on an agent, keyed by name. Returns whether it was new. */
export function upsertMount(a: AgentConfig, m: Mount): "added" | "updated" {
  a.mounts ??= [];
  const i = a.mounts.findIndex((x) => x.name === m.name);
  if (i >= 0) {
    a.mounts[i] = m;
    return "updated";
  }
  a.mounts.push(m);
  return "added";
}

/** Removes a mount by name. Returns whether anything was removed. */
export function removeMount(a: AgentConfig, name: string): boolean {
  if (!a.mounts) return false;
  const before = a.mounts.length;
  a.mounts = a.mounts.filter((x) => x.name !== name);
  return a.mounts.length < before;
}

export function listMounts(a: AgentConfig): Mount[] {
  return a.mounts ?? [];
}

/** Renders the podman `-v` args for an agent's mounts, so a sandbox bring-up derives
 * its bind flags from the config (no second hardcoded list): `-v <host>:/root/files/<name>[:ro]`. */
export function podmanVolumeArgs(a: AgentConfig): string[] {
  return listMounts(a).flatMap((m) => ["-v", `${m.host}:${mountPath(m)}${m.read_only ? ":ro" : ""}`]);
}
