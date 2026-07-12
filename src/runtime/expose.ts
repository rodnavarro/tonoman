// Reachable service URLs — the host side of the `tonoman url`/`expose`/`unexpose`
// platform capability (devcontainerized-resolve-url / -expose-url).
//
// Why host-side: the agent runs in its own network sandbox where `localhost` is the
// agent, not the host — only the host knows its reachable address. And because agents
// run with permissions skipped inside the sandbox, *opening a port* must be a brokered,
// policy-gated, audited, revocable HOST action — never something the agent does itself.
// So the in-sandbox `tonoman` shim forwards `[__tonoman__, <verb>, …]` over the same
// control channel as podman (A8); the broker dispatches it here.
//
// This module is pure logic + injected host seams (listContainers / forward), so the
// URL math and the default-deny/expose/revoke behavior are unit-tested without podman
// or netsh. The gateway wires the real seams (host `podman ps`, `netsh portproxy`).

/** Sentinel argv[0] the `tonoman` shim sends so the broker can tell a builtin verb
 * apart from a podman command (which never starts with this). */
export const TONOMAN_BUILTIN = "__tonoman__";

export interface PublishedPort {
  hostIP: string;
  hostPort: number;
  containerPort: number;
  proto: string;
}

export interface ContainerInfo {
  name: string;
  ports: PublishedPort[];
  /** podman labels; used (when present) to scope ownership to an agent's GUID. */
  labels?: Record<string, string>;
}

export interface TonomanResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExposeDeps {
  /** the address Tonoman advertises for EXPOSED services (LAN IP / hostname). */
  advertiseHost: string;
  /** the address an un-exposed service is reachable at — host machine only. Default "localhost". */
  hostLocal?: string;
  /** lists this agent's reachable containers (already ownership-scoped by the caller). */
  listContainers: () => Promise<ContainerInfo[]>;
  /** opens/closes a host-side forward for a published port (Windows: netsh portproxy;
   * Linux: a firewall rule / no-op). Throws with a real reason on failure (e.g. needs
   * elevation) — the manager surfaces it rather than reporting false success. */
  forward: (action: "add" | "remove", hostPort: number) => Promise<void>;
  /** opt-in public-tunnel mode (personal only); off by default (enterprise profile). */
  tunnelEnabled?: boolean;
}

/** Parses podman's "Ports" column ("0.0.0.0:8081->8080/tcp, 4510-4559/tcp, 5678/tcp")
 * into the published (host-reachable) ports only — entries without a `host->container`
 * publish (bare/range ports) are dropped: you can't reach them. */
export function parsePorts(s: string): PublishedPort[] {
  const out: PublishedPort[] = [];
  for (const raw of (s ?? "").split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(?:([0-9.]+|\[[^\]]+\]):)?(\d+)->(\d+)\/(\w+)$/);
    if (!m) continue; // no publish mapping → not reachable
    out.push({ hostIP: m[1] ?? "", hostPort: Number(m[2]), containerPort: Number(m[3]), proto: m[4] });
  }
  return out;
}

export class ExposeManager {
  /** hostPort → the service it was exposed for. The single source of truth for
   * "is this reachable over the network", and what `unexpose`/teardown reverses. */
  private readonly exposed = new Map<number, string>();

  constructor(private readonly deps: ExposeDeps) {}

  /** Dispatches one `tonoman` builtin invocation (argv after the sentinel). */
  async handle(args: string[]): Promise<TonomanResult> {
    const verb = (args[0] ?? "").toLowerCase();
    const service = args[1];
    switch (verb) {
      case "url":
      case "urls":
        return this.url(service);
      case "expose":
        return service ? this.expose(service) : usage("expose <service>");
      case "unexpose":
        return service ? this.unexpose(service) : usage("unexpose <service>");
      default:
        return usage("url <service> | expose <service> | unexpose <service>");
    }
  }

  /** Active exposed host ports — for the gateway to tear down on shutdown. */
  exposedPorts(): number[] {
    return [...this.exposed.keys()];
  }

  private async url(token?: string): Promise<TonomanResult> {
    const all = await this.deps.listContainers();
    const matches = token ? matchByToken(all, token) : all.filter((c) => c.ports.length > 0);
    if (token && matches.length === 0) return notFound(token, all);

    const lines: string[] = [];
    for (const c of matches) {
      if (c.ports.length === 0) {
        lines.push(`${c.name}: no published ports (nothing to reach)`);
        continue;
      }
      for (const p of c.ports) lines.push(this.describe(c.name, p));
    }
    return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }

  private async expose(token: string): Promise<TonomanResult> {
    const all = await this.deps.listContainers();
    const c = uniqueMatch(all, token);
    if ("error" in c) return c.error;
    if (c.value.ports.length === 0) {
      return { code: 1, stdout: "", stderr: `tonoman: '${token}' has no published port — nothing to expose.\n` };
    }

    const opened: number[] = [];
    for (const p of c.value.ports) {
      if (this.exposed.has(p.hostPort)) continue; // already open
      try {
        await this.deps.forward("add", p.hostPort);
        opened.push(p.hostPort);
      } catch (e) {
        for (const port of opened) await this.deps.forward("remove", port).catch(() => {}); // roll back
        return { code: 1, stdout: "", stderr: `tonoman: could not expose ${c.value.name}:${p.hostPort} — ${(e as Error).message}\n` };
      }
      this.exposed.set(p.hostPort, c.value.name);
    }

    const lines = c.value.ports.map((p) => `${c.value.name} → http://${this.deps.advertiseHost}:${p.hostPort}`);
    // Agent-facing note (how I revoke later). I must NOT relay this verb to the operator
    // — to them it's just "reachable; ask me to close it" (see AGENTS.md).
    lines.push(`[exposed — I close it with: tonoman unexpose ${token}]`);
    return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }

  private async unexpose(token: string): Promise<TonomanResult> {
    const all = await this.deps.listContainers();
    const c = uniqueMatch(all, token);
    if ("error" in c) return c.error;

    const closed: number[] = [];
    for (const p of c.value.ports) {
      if (!this.exposed.has(p.hostPort)) continue;
      await this.deps.forward("remove", p.hostPort).catch(() => {});
      this.exposed.delete(p.hostPort);
      closed.push(p.hostPort);
    }
    const msg = closed.length ? `Closed ${c.value.name} (${closed.join(", ")}) — host-only again.` : `${c.value.name} was not exposed.`;
    return { code: 0, stdout: msg + "\n", stderr: "" };
  }

  /** One reachable-URL line for a published port, reflecting exposed state. */
  private describe(name: string, p: PublishedPort): string {
    if (this.exposed.has(p.hostPort)) {
      return `${name} → http://${this.deps.advertiseHost}:${p.hostPort}  (exposed — reachable over the network)`;
    }
    const host = this.deps.hostLocal ?? "localhost";
    return `${name} → http://${host}:${p.hostPort}  (not exposed — host-only; "tonoman expose ${name}" to reach it over the network)`;
  }
}

/** Containers matching a service token: exact name first, else substring (compose
 * names like `billing-worker` contain `worker`). */
function matchByToken(all: ContainerInfo[], token: string): ContainerInfo[] {
  const t = token.toLowerCase();
  const exact = all.filter((c) => c.name.toLowerCase() === t);
  if (exact.length) return exact;
  return all.filter((c) => c.name.toLowerCase().includes(t));
}

/** Resolves a token to exactly one container, or an error result (none / ambiguous)
 * — expose/unexpose must never guess which service the operator meant. */
function uniqueMatch(all: ContainerInfo[], token: string): { value: ContainerInfo } | { error: TonomanResult } {
  const matches = matchByToken(all, token);
  if (matches.length === 0) return { error: notFound(token, all) };
  if (matches.length > 1) {
    const names = matches.map((c) => c.name).join(", ");
    return { error: { code: 1, stdout: "", stderr: `tonoman: '${token}' matches multiple services (${names}) — name one.\n` } };
  }
  return { value: matches[0] };
}

function notFound(token: string, all: ContainerInfo[]): TonomanResult {
  const known = all.map((c) => c.name).join(", ") || "(none running)";
  return { code: 1, stdout: "", stderr: `tonoman: no service '${token}' found. Running: ${known}\n` };
}

function usage(form: string): TonomanResult {
  return { code: 2, stdout: "", stderr: `tonoman: usage: tonoman ${form}\n` };
}
