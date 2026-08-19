// Sandbox provisioning — the pure assembly behind `tonoman create agent` (roster-provision,
// A11). `podmanRunArgs` is the SINGLE source of truth for how an agent's container is
// brought up: image (from the harness, per-runtime), infra mounts (config/memory/identity),
// project grants (A9), and the ownership label. It is pure (no podman, no fs) so the
// provisioning contract is unit-tested for free; the adopt-safe lifecycle (create-only-
// if-absent, never rm) lives in the CALLER (src/lifecycle.ts + the CLI), not here.

import * as os from "node:os";
import * as path from "node:path";
import type { Config, AgentConfig } from "./config";
import type { Spec } from "./harness";
import { podmanVolumeArgs } from "./mounts";
import { tuiPort } from "./tui";

/** Where the git-backed memory substrate (A3) + the A13 control channel mount inside the
 * sandbox. The shim reads <MEMORY_HOME>/control, so mounting memory here wires the broker
 * with no extra flag. */
export const MEMORY_HOME = "/root/.tonoman";

/** The environment root that holds <guid>/{config,memory,identity}. After applyEnv (cli-env)
 * a named env sets cfg.state_root to its env root; the default falls back to ~/.tonoman.
 * Kept local (no import of cli.envRoot) to avoid a dependency cycle with the CLI. */
export function stateRoot(cfg: Config): string {
  return cfg.state_root || path.join(os.homedir() || ".", ".tonoman");
}

/** The per-agent host dirs under <root>/<guid>/ that the sandbox bind-mounts. `incoming`
 * lives UNDER memory (so the single memory mount surfaces it at <MEMORY_HOME>/incoming —
 * matching the connector's media_mount convention); the scaffolder creates all of them. */
export function agentDirs(cfg: Config, a: AgentConfig): {
  base: string; config: string; memory: string; identity: string; incoming: string;
} {
  const base = path.join(stateRoot(cfg), a.guid || a.name);
  const memory = path.join(base, "memory");
  return {
    base,
    config: path.join(base, "config"),
    memory,
    identity: path.join(base, "identity"),
    incoming: path.join(memory, "incoming"),
  };
}

/** The podman secret name holding an agent's git SSH key (cfg-ssh-key). Namespaced by the
 * agent's GUID/name so two agents never share a key secret (A11). */
export function sshSecretName(a: AgentConfig): string {
  return `tonoman-ssh-${a.guid || a.name}`;
}

/** The sandbox path the SSH key is mounted at (so git/ssh find it by default). */
export const SSH_KEY_PATH = "/root/.ssh/id_rsa";

/** The `podman run` flags that wire an agent's git-over-SSH key (cfg-ssh-key): mount the
 * key as a secret at 0600 (a bind mount lands 0777 and ssh refuses it), and point git at
 * it host-agnostically (IdentitiesOnly + accept-new ⇒ any SSH remote works on first
 * connect, no per-host known_hosts pre-seed). Pure. */
export function sshRunArgs(secretName: string): string[] {
  return [
    "--secret",
    `${secretName},type=mount,target=${SSH_KEY_PATH},mode=0600,uid=0,gid=0`,
    "-e",
    `GIT_SSH_COMMAND=ssh -i ${SSH_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  ];
}

/** Assembles the full `podman run …` argv (without the leading `podman`) for an agent's
 * sandbox — the single source of truth for image + infra mounts + grants + label.
 *
 * PURE: derives everything from (agent, cfg, spec); no side effects, no podman. The
 * container NAME comes from the (already env-applied, cli-env) config, so a named env's
 * `-<env>` suffix is honored and dev can never target prod. The IMAGE comes from the
 * HARNESS spec (per-runtime, not per-agent). IDENTITY is the agent's own ro dir, not a
 * shared repo path. Adopt-safety (create-only-if-absent, never rm) is the caller's job. */
export function podmanRunArgs(a: AgentConfig, cfg: Config, spec: Spec): string[] {
  const d = agentDirs(cfg, a);
  // Service-ness is intrinsic to the harness (spec); the agent flag only confirms/forces it.
  const service = !!(spec.service || a.service);
  const args = [
    "run",
    "-d",
    "--name",
    a.container,
    "--label",
    `tonoman.agent=${a.guid || a.name}`, // ownership scoping (A11)
  ];
  // harness-specific run env (e.g. Claude's CLAUDE_CONFIG_DIR; Hermes' dashboard toggle).
  for (const [k, v] of Object.entries(spec.runEnv ?? {})) args.push("-e", `${k}=${v}`);

  if (service) {
    // A self-channeled service (svc-self-channeled) keeps its own persistent state in the
    // config volume (e.g. Hermes' /opt/data) + an optional ro identity dir. It does NOT use
    // Tonoman's git-memory/control-channel substrate (no turn-loop/broker), so that mount is
    // omitted. `:U` chowns the bind mount to the container's runtime user so the server can
    // write its own state dir in rootless podman.
    args.push("-v", `${d.config}:${spec.configHome}:rw,U`, "-v", `${d.identity}:${spec.identityHome}:ro`);
  } else {
    // infra mounts: config volume (rw, the opaque credential/skill store), git memory +
    // control channel (rw), per-agent identity (ro).
    args.push(
      "-v",
      `${d.config}:${spec.configHome}:rw`,
      "-v",
      `${d.memory}:${MEMORY_HOME}:rw`,
      "-v",
      `${d.identity}:${spec.identityHome}:ro`,
    );
  }
  // project grants (A9) — same render as `get mounts --podman`, so they cannot drift.
  args.push(...podmanVolumeArgs(a));
  // git-over-SSH key, if granted (cfg-ssh-key): secret-mounted 0600 + GIT_SSH_COMMAND.
  // The secret itself is created (from a.ssh_key) by the caller before `podman run`.
  if (a.ssh_key) args.push(...sshRunArgs(sshSecretName(a)));

  // Process config + secrets injected at boot (svc-config-env / cfg-no-secrets) — for BOTH
  // service AND turn-driven agents: a turn-driven agent (e.g. a claude-code agent whose skill
  // shells a CLI like `billing`) needs its tool creds (the accounting API, Bedrock) in the container env too, not
  // just self-channeled services. Non-secret env is written inline (-e KEY=VALUE); each declared
  // secret is a BARE `-e NAME` so podman forwards the value from the gateway's own environment at
  // run — never persisted to settings.json.
  for (const [k, v] of Object.entries(a.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const name of a.secrets ?? []) args.push("-e", name);

  // Web-TUI (tui-over-web): publish the wrapper port to HOST LOOPBACK only, so the
  // brokered `tonoman expose` can LAN-forward it on demand. Loopback bind keeps it off
  // the LAN until expose runs (default-deny). Opt-in and works for turn-driven agents
  // too (unlike the service ports below), so a dev agent gets a phone-reachable TUI
  // without becoming a service. A non-tui agent publishes nothing (k8s path unaffected).
  if (a.tui?.enabled) {
    const p = tuiPort(a.tui);
    args.push("-p", `127.0.0.1:${p}:${p}`);
  }

  if (service) {
    // Publish the dashboard/health port to the host for the token-free health probe (health-no-tokens).
    const hostPort = a.port ?? spec.servicePort;
    if (hostPort && spec.servicePort) args.push("-p", `${hostPort}:${spec.servicePort}`);
    // Plus any ADDITIONAL server ports (host:same) — e.g. the chat platform's webhook listener
    // (Teams 3978) a dev tunnel / cluster ingress points at.
    for (const p of a.ports ?? []) args.push("-p", `${p}:${p}`);
    // (env + secrets are injected above, for both service and turn-driven agents.)
    // the per-runtime image, then the harness's own long-lived server command (the image's
    // ENTRYPOINT wraps it). Tonoman boots it but does not drive its turns (svc-self-channeled).
    args.push(spec.image, ...(spec.serviceCommand ?? []));
  } else {
    // the per-runtime image, then the long-lived no-op (the gateway drives turns via exec).
    args.push(spec.image, "sleep", "infinity");
  }
  return args;
}
