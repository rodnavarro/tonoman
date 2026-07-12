// Host-browser backend (browser-host-chrome, A14). The agent triggers `tonoman browser
// ensure [--host]` through the in-sandbox `tonoman` shim → the broker dispatches it here →
// the broker launches a REAL Chrome window on the HOST with CDP enabled. The agent then
// drives that Chrome over CDP via the host's advertised IP (Chrome's Host-header guard
// accepts an IP), and the operator sees/controls it natively — no noVNC.
//
// Like `tonoman expose`, this is a brokered HOST action: the agent only *requests* it; the
// broker (running on the host) performs the launch. Pure arg-building is split out so it's
// unit-tested without spawning Chrome.

import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import type { TonomanResult } from "./expose";

/** Candidate host-browser executables (Windows), Chrome first, Edge fallback. */
export function hostBrowserCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const pf = env.ProgramFiles ?? "C:/Program Files";
  const pf86 = env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
  const local = env.LOCALAPPDATA ?? "";
  return [
    path.join(pf, "Google/Chrome/Application/chrome.exe"),
    path.join(pf86, "Google/Chrome/Application/chrome.exe"),
    local ? path.join(local, "Google/Chrome/Application/chrome.exe") : "",
    path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
    path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);
}

/** Pure Chrome CDP launch flags. `--remote-allow-origins=*` is required for a remote CDP
 * WebSocket client (modern Chrome enforces the Origin check); the address is bound wide so
 * the agent container can reach it by the host's advertised IP. */
export function chromeLaunchArgs(o: { port: number; profileDir: string; address?: string; startUrl?: string }): string[] {
  return [
    `--remote-debugging-port=${o.port}`,
    `--remote-debugging-address=${o.address ?? "0.0.0.0"}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${o.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    o.startUrl ?? "about:blank",
  ];
}

interface HostBrowserState {
  port: number; // Chrome's loopback CDP port (127.0.0.1 only — Chrome ≥111 ignores --remote-debugging-address)
  relayPort: number; // the container-reachable relay port (advertiseHost:relayPort → 127.0.0.1:port)
  pid?: number;
  exe: string;
  profileDir: string;
}

export interface HostBrowserDeps {
  /** the host IP the AGENT uses to reach this Chrome (Chrome accepts an IP Host header). */
  advertiseHost: string;
  /** the agent's memory dir (mounted at /root/.tonoman) — where browser.json is written. */
  memoryRoot: string;
  /** dir for the persistent host Chrome profile + state (logins survive). */
  stateBase: string;
  /** override the executable list (tests). */
  candidates?: string[];
  /** override the free-port finder (tests). */
  freePort?: () => Promise<number>;
}

export class HostBrowserManager {
  /** Live TCP relays: chrome loopback CDP port → the 0.0.0.0 server the agent reaches. */
  private readonly relays = new Map<number, net.Server>();
  constructor(private readonly d: HostBrowserDeps) {}

  /** Bring up (or reuse) a TCP relay binding 0.0.0.0:relayPort and piping to Chrome's
   * loopback CDP — Chrome won't bind non-loopback, but the agent can't reach loopback, so
   * the broker bridges it (same role as the sidecar's socat / the expose proxy). */
  private async ensureRelay(cdpPort: number, relayPort?: number): Promise<number> {
    if (relayPort && this.relays.has(relayPort)) return relayPort;
    const port = relayPort ?? (await (this.d.freePort ?? freePort)());
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((client) => {
        const up = net.connect(cdpPort, "127.0.0.1");
        client.on("error", () => up.destroy());
        up.on("error", () => client.destroy());
        client.pipe(up);
        up.pipe(client);
      });
      srv.on("error", reject);
      srv.listen(port, "0.0.0.0", () => {
        srv.unref(); // never keep the gateway alive
        this.relays.set(port, srv);
        resolve();
      });
    });
    return port;
  }

  /** Close all relays (gateway shutdown). */
  closeRelays(): void {
    for (const s of this.relays.values()) s.close();
    this.relays.clear();
  }

  /** Dispatch `tonoman browser <verb> [--host]` (argv after the `browser` token). */
  async handle(args: string[]): Promise<TonomanResult> {
    const verb = (args[0] ?? "ensure").toLowerCase();
    switch (verb) {
      case "ensure":
      case "open":
        return this.ensure();
      case "status":
        return this.status();
      case "close":
        return this.close();
      default:
        return { code: 2, stdout: "", stderr: `tonoman browser: unknown verb "${verb}" (ensure | status | close)\n` };
    }
  }

  private statePath(): string {
    return path.join(this.d.stateBase, "host-browser.json");
  }

  private async readState(): Promise<HostBrowserState | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.statePath(), "utf8")) as HostBrowserState;
    } catch {
      return undefined;
    }
  }

  /** Ensure a host Chrome with CDP is up; reuse if one is already responding. */
  private async ensure(): Promise<TonomanResult> {
    const existing = await this.readState();
    if (existing && (await cdpReady(existing.port, 1))) {
      const relayPort = await this.ensureRelay(existing.port, existing.relayPort); // re-arm relay (lost on gateway restart)
      await this.publishEndpoint(relayPort);
      return this.ok(relayPort, "already running");
    }

    const exe = await firstExisting(this.d.candidates ?? hostBrowserCandidates());
    if (!exe) return { code: 1, stdout: "", stderr: "tonoman browser: no Chrome/Edge found on the host\n" };

    const port = await (this.d.freePort ?? freePort)();
    const profileDir = path.join(this.d.stateBase, "host-chrome-profile");
    await fs.mkdir(profileDir, { recursive: true });

    const child = spawn(exe, chromeLaunchArgs({ port, profileDir }), { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();

    if (!(await cdpReady(port, 40))) {
      return { code: 1, stdout: "", stderr: `tonoman browser: Chrome launched but CDP not ready on :${port}\n` };
    }
    const relayPort = await this.ensureRelay(port);
    await fs.mkdir(this.d.stateBase, { recursive: true });
    await fs.writeFile(this.statePath(), JSON.stringify({ port, relayPort, pid: child.pid, exe, profileDir } as HostBrowserState, null, 2));
    await this.publishEndpoint(relayPort);
    return this.ok(relayPort, "launched on the host (a Chrome window opened on the operator's desktop)");
  }

  /** Write the agent-facing CDP endpoint (the relay) into the agent's memory so browser-bot finds it. */
  private async publishEndpoint(relayPort: number): Promise<void> {
    await fs.mkdir(this.d.memoryRoot, { recursive: true });
    await fs.writeFile(
      path.join(this.d.memoryRoot, "browser.json"),
      JSON.stringify({ cdp: `http://${this.d.advertiseHost}:${relayPort}`, cdpHostPort: relayPort, backend: "host", note: "host Chrome via broker relay; connect by IP" }, null, 2),
    );
  }

  private ok(relayPort: number, how: string): TonomanResult {
    return { code: 0, stdout: `browser ready (host Chrome, CDP http://${this.d.advertiseHost}:${relayPort}) — ${how}\n`, stderr: "" };
  }

  private async status(): Promise<TonomanResult> {
    const s = await this.readState();
    if (s && (await cdpReady(s.port, 1))) return this.ok(s.relayPort, "running");
    return { code: 0, stdout: "no host browser running (run 'tonoman browser ensure')\n", stderr: "" };
  }

  private async close(): Promise<TonomanResult> {
    const s = await this.readState();
    if (s?.pid) await new Promise<void>((r) => execFile("taskkill", ["/PID", String(s.pid), "/T", "/F"], () => r()));
    this.closeRelays();
    await fs.rm(this.statePath(), { force: true }).catch(() => {});
    return { code: 0, stdout: "host browser closed\n", stderr: "" };
  }
}

/** Polls the host's loopback CDP endpoint until /json/version answers (or attempts run out). */
function cdpReady(port: number, attempts: number): Promise<boolean> {
  return new Promise((resolve) => {
    let n = 0;
    const tick = (): void => {
      const req = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 800 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => (++n >= attempts ? resolve(false) : setTimeout(tick, 300)));
      req.on("timeout", () => {
        req.destroy();
        ++n >= attempts ? resolve(false) : setTimeout(tick, 300);
      });
    };
    tick();
  });
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}
