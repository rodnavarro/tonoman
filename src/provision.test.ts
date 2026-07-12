import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { podmanRunArgs, agentDirs, stateRoot, MEMORY_HOME, sshSecretName, sshRunArgs, SSH_KEY_PATH } from "./provision";
import type { Config, AgentConfig } from "./config";
import type { Spec } from "./harness";

// A fake harness spec — podmanRunArgs reads only image/configHome/identityHome/runEnv.
const SPEC = {
  kind: "claude-code",
  image: "localhost/tonoman/claudecode:latest",
  configHome: "/root/.claude",
  identityHome: "/root/agent",
  runEnv: { CLAUDE_CONFIG_DIR: "/root/.claude" },
} as unknown as Spec;

function cfg(extra?: Partial<Config>): Config {
  return { state_root: "/srv/tonoman", agents: [], stream: { cursor: "", edit_interval_ms: 0 }, health_addr: "x", ...extra } as Config;
}
function agent(extra?: Partial<AgentConfig>): AgentConfig {
  return { name: "cardy", container: "cardy", guid: "g-123", telegram: { token: "t" }, ...extra } as AgentConfig;
}

// roster-provision — the pure podman-run assembly is the single source of truth.
describe("podmanRunArgs — provisioning assembly (roster-provision)", () => {
  it("renders a complete, ordered `podman run` for a sandbox", () => {
    const args = podmanRunArgs(agent(), cfg(), SPEC);
    expect(args.slice(0, 6)).toEqual(["run", "-d", "--name", "cardy", "--label", "tonoman.agent=g-123"]);
    // harness runEnv
    expect(args).toContain("-e");
    expect(args).toContain("CLAUDE_CONFIG_DIR=/root/.claude");
    // ends with the per-runtime image + the long-lived no-op
    expect(args.slice(-3)).toEqual(["localhost/tonoman/claudecode:latest", "sleep", "infinity"]);
  });

  it("image comes from the harness spec (per-runtime, not per-agent)", () => {
    const other = { ...SPEC, image: "localhost/tonoman/hermes:latest" } as Spec;
    expect(podmanRunArgs(agent(), cfg(), other)).toContain("localhost/tonoman/hermes:latest");
  });

  it("honors the (env-applied) container name — a suffixed name routes the run to that env", () => {
    const args = podmanRunArgs(agent({ container: "cardy-smoke" }), cfg(), SPEC);
    expect(args[args.indexOf("--name") + 1]).toBe("cardy-smoke");
  });

  it("mounts config (rw), memory (rw), identity (ro) at the harness homes under <root>/<guid>", () => {
    const a = agent();
    const c = cfg();
    const args = podmanRunArgs(a, c, SPEC);
    const d = agentDirs(c, a);
    expect(args).toContain(`${d.config}:/root/.claude:rw`);
    expect(args).toContain(`${d.memory}:${MEMORY_HOME}:rw`);
    expect(args).toContain(`${d.identity}:/root/agent:ro`);
  });

  it("appends project grants from the same render as `get mounts --podman`", () => {
    const a = agent({ mounts: [{ name: "cards", host: "C:/files/cards" }] });
    const args = podmanRunArgs(a, cfg(), SPEC);
    expect(args).toContain("C:/files/cards:/root/files/cards");
  });

  it("falls back to the agent name for the label when no guid is assigned yet", () => {
    const args = podmanRunArgs(agent({ guid: undefined }), cfg(), SPEC);
    expect(args).toContain("tonoman.agent=cardy");
  });

  it("emits NO runEnv when the harness declares none", () => {
    const noEnv = { ...SPEC, runEnv: undefined } as Spec;
    expect(podmanRunArgs(agent(), cfg(), noEnv)).not.toContain("CLAUDE_CONFIG_DIR=/root/.claude");
  });

  it("grants a git SSH key via a 0600 secret mount + GIT_SSH_COMMAND when ssh_key is set (cfg-ssh-key)", () => {
    const args = podmanRunArgs(agent({ ssh_key: "C:/Users/u/.ssh/id" }), cfg(), SPEC);
    expect(args).toContain("--secret");
    expect(args).toContain(`tonoman-ssh-g-123,type=mount,target=${SSH_KEY_PATH},mode=0600,uid=0,gid=0`);
    const env = args.find((a) => a.startsWith("GIT_SSH_COMMAND="));
    expect(env).toContain(`-i ${SSH_KEY_PATH}`);
    expect(env).toContain("StrictHostKeyChecking=accept-new"); // host-agnostic, any remote
  });

  it("emits NO ssh secret/flags when ssh_key is unset (default)", () => {
    const args = podmanRunArgs(agent(), cfg(), SPEC);
    expect(args).not.toContain("--secret");
    expect(args.some((a) => a.startsWith("GIT_SSH_COMMAND="))).toBe(false);
  });

  it("injects env + forwards secret NAMES for a TURN-DRIVEN agent too (not just services) — a claude-code agent's skill may shell a CLI needing tool creds (e.g. billing → the accounting API/Bedrock)", () => {
    const a = agent({ env: { QBO_ENVIRONMENT: "sandbox" }, secrets: ["AWS_BEARER_TOKEN_BEDROCK", "QBO_CLIENT_SECRET"] });
    const args = podmanRunArgs(a, cfg(), SPEC); // SPEC = claude-code (turn-driven)
    expect(args.slice(-3)).toEqual([SPEC.image, "sleep", "infinity"]); // still the turn-loop no-op, not a service
    expect(args).toContain("QBO_ENVIRONMENT=sandbox"); // non-secret value inline
    expect(args).toContain("AWS_BEARER_TOKEN_BEDROCK"); // secret forwarded by bare NAME
    expect(args).toContain("QBO_CLIENT_SECRET");
    expect(args.some((x) => x.startsWith("AWS_BEARER_TOKEN_BEDROCK="))).toBe(false); // never a value
  });
});

// svc-self-channeled / svc-config-env — a service harness boots its own long-lived server.
const SVC_SPEC = {
  kind: "hermes",
  image: "localhost/tonoman/hermes:latest",
  configHome: "/opt/data",
  identityHome: "/opt/identity",
  service: true,
  serviceCommand: ["gateway"],
  servicePort: 9119,
  runEnv: { HERMES_DASHBOARD: "1" },
} as unknown as Spec;

describe("podmanRunArgs — service mode (svc-self-channeled / svc-config-env)", () => {
  it("boots the harness server command, not the turn-loop no-op", () => {
    const args = podmanRunArgs(agent(), cfg(), SVC_SPEC);
    expect(args.slice(-2)).toEqual(["localhost/tonoman/hermes:latest", "gateway"]);
    expect(args).not.toContain("sleep"); // never the exec-per-turn no-op
  });

  it("mounts config (rw,U) + identity (ro) but NOT Tonoman's git-memory/control substrate", () => {
    const a = agent();
    const c = cfg();
    const args = podmanRunArgs(a, c, SVC_SPEC);
    const d = agentDirs(c, a);
    expect(args).toContain(`${d.config}:/opt/data:rw,U`); // server writes its own state dir
    expect(args).toContain(`${d.identity}:/opt/identity:ro`);
    expect(args).not.toContain(`${d.memory}:${MEMORY_HOME}:rw`); // no turn-loop substrate
  });

  it("publishes the service port to the host for the token-free health probe", () => {
    expect(podmanRunArgs(agent(), cfg(), SVC_SPEC)).toContain("-p");
    expect(podmanRunArgs(agent(), cfg(), SVC_SPEC)).toContain("9119:9119");
    // an explicit host port overrides the default
    expect(podmanRunArgs(agent({ port: 13978 }), cfg(), SVC_SPEC)).toContain("13978:9119");
  });

  it("publishes ADDITIONAL ports host:same (e.g. the Teams webhook) alongside the health port", () => {
    const args = podmanRunArgs(agent({ ports: [3978] }), cfg(), SVC_SPEC);
    expect(args).toContain("9119:9119"); // dashboard/health still published
    expect(args).toContain("3978:3978"); // the chat webhook a dev tunnel / ingress targets
  });

  it("injects non-secret env inline and forwards declared secrets by NAME (cfg-no-secrets)", () => {
    const a = agent({ env: { AWS_REGION: "us-east-1" }, secrets: ["AWS_BEARER_TOKEN_BEDROCK", "TEAMS_CLIENT_SECRET"] });
    const args = podmanRunArgs(a, cfg(), SVC_SPEC);
    expect(args).toContain("AWS_REGION=us-east-1"); // non-secret value written inline
    // secrets are bare `-e NAME` (podman forwards the VALUE from the gateway env) — never a value here
    expect(args).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(args).toContain("TEAMS_CLIENT_SECRET");
    expect(args.some((x) => x.startsWith("AWS_BEARER_TOKEN_BEDROCK="))).toBe(false);
    expect(args.some((x) => x.startsWith("TEAMS_CLIENT_SECRET="))).toBe(false);
  });

  it("still carries the harness runEnv + ownership label", () => {
    const args = podmanRunArgs(agent(), cfg(), SVC_SPEC);
    expect(args).toContain("HERMES_DASHBOARD=1");
    expect(args).toContain("tonoman.agent=g-123");
  });
});

describe("ssh helpers — git-over-SSH grant (cfg-ssh-key)", () => {
  it("namespaces the secret per agent (guid, else name)", () => {
    expect(sshSecretName(agent())).toBe("tonoman-ssh-g-123");
    expect(sshSecretName(agent({ guid: undefined }))).toBe("tonoman-ssh-cardy");
  });
  it("sshRunArgs mounts at 0600 and points git at the key, host-agnostically", () => {
    const a = sshRunArgs("tonoman-ssh-x");
    expect(a[0]).toBe("--secret");
    expect(a[1]).toBe(`tonoman-ssh-x,type=mount,target=${SSH_KEY_PATH},mode=0600,uid=0,gid=0`);
    expect(a[2]).toBe("-e");
    expect(a[3]).toContain("IdentitiesOnly=yes");
    expect(a[3]).toContain("accept-new");
  });
});

describe("agentDirs / stateRoot — per-agent host layout (roster-provision)", () => {
  it("keys the layout by guid under the env state root; incoming lives under memory", () => {
    const a = agent();
    const c = cfg({ state_root: "/srv/tonoman-dev" });
    const d = agentDirs(c, a);
    expect(d.base).toBe(path.join("/srv/tonoman-dev", "g-123"));
    expect(d.identity).toBe(path.join("/srv/tonoman-dev", "g-123", "identity"));
    expect(d.incoming).toBe(path.join(d.memory, "incoming"));
  });

  it("stateRoot falls back to ~/.tonoman when the config sets none", () => {
    expect(stateRoot({ agents: [] } as unknown as Config)).toBe(path.join(os.homedir(), ".tonoman"));
  });
});
