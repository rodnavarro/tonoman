// `tonoman <create|get|delete|open|close> browser` — the per-agent browser sidecar (A14,
// docs/scenarios/contracts/browser.md). Each browsing agent gets its OWN headful Chrome (the
// `tonoman/chrome` image) with CDP + noVNC published to host loopback; the agent drives it
// over CDP via `host.containers.internal` (the same host-reach the devcontainerized runtime
// uses), and `open browser` surfaces the live noVNC viewer to the operator.
//
// The PURE arg/name builders (browserContainer, browserProfileVolume, browserRunArgs) are
// separated so the provisioning contract is unit-tested without podman; the effectful runners
// shell out to podman. Adopt-safe: never clobbers a running sidecar.

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as path from "node:path";
import type { Config, AgentConfig } from "./config";
import { findAgent } from "./mounts";
import { agentDirs } from "./provision";

/** The per-runtime browser image (Tonoman-owned; A14). Not the agent's harness image. */
export const CHROME_IMAGE = "localhost/tonoman/chrome:latest";

/** A browsing agent's sidecar container name — derived from the agent's container so the
 * env suffix (cli-env) rides along (`cody-dev` → `cody-dev-chrome`). */
export function browserContainer(agentContainer: string): string {
  return `${agentContainer}-chrome`;
}

/** The persistent Chrome profile volume (logins survive restart; per-agent, A11). Keyed by
 * the stable GUID, not the name, so it survives a rename. */
export function browserProfileVolume(guid: string): string {
  return `tonoman-chrome-${guid}`;
}

/** Pure `podman run …` argv (without leading `podman`) for an agent's browser sidecar.
 * Publishes CDP (9222) + noVNC (6080) to HOST LOOPBACK on auto-allocated ports (`::PORT`),
 * mounts the persistent profile volume, and stamps the ownership label (A11). */
export function browserRunArgs(o: {
  container: string;
  guid: string;
  profileVolume: string;
  novncPassword: string;
  image?: string;
}): string[] {
  return [
    "run",
    "-d",
    "--name",
    o.container,
    "--label",
    `tonoman.agent=${o.guid}`, // ownership scoping (A11)
    "-e",
    `TONOMAN_CHROME_NOVNC_PASSWORD=${o.novncPassword}`,
    // Publish CDP + noVNC on auto-allocated host ports. NB: bind all-interfaces (not
    // 127.0.0.1) so sibling containers reach CDP via host.containers.internal (the proven
    // devcontainerized reach). On WSL2-podman this still surfaces only on Windows loopback
    // (NOT the LAN); on a Linux host it would be LAN-bound — there `open browser` should
    // front it with the gateway proxy (hardening follow-up).
    "-p",
    "0.0.0.0::9222",
    "-p",
    "0.0.0.0::6080",
    "-v",
    `${o.profileVolume}:/home/chrome/.chrome:rw`, // persistent profile (logins survive)
    o.image ?? CHROME_IMAGE,
  ];
}

/** Metadata persisted next to the agent's state so `get`/`open`/`delete browser` find the
 * sidecar's published ports + viewer password without re-querying every time. */
interface BrowserMeta {
  container: string;
  guid: string;
  cdpHostPort: number;
  novncHostPort: number;
  novncPassword: string;
}

function metaPath(cfg: Config, a: AgentConfig): string {
  return path.join(agentDirs(cfg, a).base, "browser.json");
}

/** Promisified `podman …`; resolves stdout, rejects with stderr on non-zero. */
function podman(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("podman", args, { windowsHide: true, maxBuffer: 1 << 24 }, (err, so, se) =>
      err ? reject(new Error((se?.toString() || (err as Error).message).trim())) : resolve((so?.toString() ?? "").trim()),
    ),
  );
}

/** Container state via `podman inspect`: "running" | "exited" | … | "absent". */
async function containerState(name: string): Promise<string> {
  try {
    return (await podman(["inspect", "-f", "{{.State.Status}}", name])).trim() || "unknown";
  } catch {
    return "absent";
  }
}

/** Reads the host loopback port podman bound for a container's exposed port. */
async function publishedPort(container: string, containerPort: number): Promise<number> {
  const out = await podman(["port", container, String(containerPort)]); // e.g. "127.0.0.1:49160"
  const m = out.match(/:(\d+)\s*$/m);
  if (!m) throw new Error(`could not read host port for ${container}:${containerPort} (got "${out}")`);
  return Number(m[1]);
}

/** 8 hex chars for the noVNC viewer password (no crypto dep needed — non-secret-grade,
 * gates casual access; the listener is host-loopback only). */
function shortToken(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** `tonoman create browser -a <agent>` — provision (or adopt) the agent's browser sidecar. */
export async function runCreateBrowser(cfgPath: string, args: string[]): Promise<void> {
  const { agent } = parseAgent(args);
  const cfg = await readRaw(cfgPath);
  const a = findAgent(cfg, agent);
  const guid = a.guid || a.name;
  const container = browserContainer(a.container);

  const state = await containerState(container);
  if (state === "running") {
    process.stdout.write(`Browser for "${a.name}" already running (${container}) — adopt-safe, not recreated.\n`);
    await writeMetaFromLive(cfg, a, container, guid);
    await printEndpoints(cfg, a);
    return;
  }
  if (state !== "absent") {
    // exists but stopped → start it (adopt), don't recreate (keeps the profile + ports)
    await podman(["start", container]);
  } else {
    const novncPassword = shortToken();
    const profileVolume = browserProfileVolume(guid);
    await podman(browserRunArgs({ container, guid, profileVolume, novncPassword }));
    // stash the password now (the live container generated none — we supplied it)
    await fs.mkdir(agentDirs(cfg, a).base, { recursive: true });
    await fs.writeFile(metaPath(cfg, a), JSON.stringify({ container, guid, novncPassword } as Partial<BrowserMeta>, null, 2));
  }
  await writeMetaFromLive(cfg, a, container, guid);
  process.stdout.write(`Browser up for "${a.name}" (${container}).\n`);
  await printEndpoints(cfg, a);
}

/** Refresh the persisted ports from the live container (host ports are known only post-run). */
async function writeMetaFromLive(cfg: Config, a: AgentConfig, container: string, guid: string): Promise<void> {
  const cdpHostPort = await publishedPort(container, 9222);
  const novncHostPort = await publishedPort(container, 6080);
  let novncPassword = "";
  try {
    novncPassword = (JSON.parse(await fs.readFile(metaPath(cfg, a), "utf8")) as BrowserMeta).novncPassword ?? "";
  } catch {
    /* none yet */
  }
  const meta: BrowserMeta = { container, guid, cdpHostPort, novncHostPort, novncPassword };
  const dirs = agentDirs(cfg, a);
  await fs.mkdir(dirs.base, { recursive: true });
  await fs.writeFile(metaPath(cfg, a), JSON.stringify(meta, null, 2));
  // Also drop the AGENT-FACING endpoint into the agent's memory (mounted at /root/.tonoman),
  // so the browser-bot skill auto-discovers its CDP URL without being told the port.
  await fs.mkdir(dirs.memory, { recursive: true });
  await fs.writeFile(
    path.join(dirs.memory, "browser.json"),
    JSON.stringify({ cdp: `http://host.containers.internal:${cdpHostPort}`, cdpHostPort, note: "your browser sidecar; connect by IP (resolve host.containers.internal)" }, null, 2),
  );
}

async function readMeta(cfg: Config, a: AgentConfig): Promise<BrowserMeta | undefined> {
  try {
    return JSON.parse(await fs.readFile(metaPath(cfg, a), "utf8")) as BrowserMeta;
  } catch {
    return undefined;
  }
}

/** The noVNC viewer URL. `autoconnect=true` + `password` pre-fill so it connects without a
 * prompt; `view_only=1` for watch-only. */
function viewerUrl(m: BrowserMeta, viewOnly = false): string {
  return `http://127.0.0.1:${m.novncHostPort}/vnc.html?autoconnect=true&resize=remote&password=${m.novncPassword}${viewOnly ? "&view_only=1" : ""}`;
}

async function printEndpoints(cfg: Config, a: AgentConfig): Promise<void> {
  const m = await readMeta(cfg, a);
  if (!m) return;
  process.stdout.write(`    CDP (agent):  http://host.containers.internal:${m.cdpHostPort}  (the browser-bot skill resolves this to an IP)\n`);
  process.stdout.write(`    viewer:       ${viewerUrl(m)}\n`);
  process.stdout.write(`    vnc password: ${m.novncPassword}   (paste if the viewer prompts)\n`);
  process.stdout.write(`    (run 'tonoman open browser -a ${a.name}' to open it)\n`);
}

/** `tonoman get browsers [-a NAME]` — list sidecars + endpoints + live status. */
export async function runGetBrowsers(cfgPath: string, args: string[]): Promise<void> {
  const { agent } = parseAgent(args);
  const cfg = await readRaw(cfgPath);
  const agents = agent ? [findAgent(cfg, agent)] : (cfg.agents ?? []);
  if (agents.length === 0) {
    process.stdout.write("(no agents configured)\n");
    return;
  }
  for (const a of agents) {
    const container = browserContainer(a.container);
    const state = await containerState(container);
    process.stdout.write(`▸ ${a.name} — browser (${container}): ${state}\n`);
    if (state === "running") {
      const m = await readMeta(cfg, a);
      if (m) {
        process.stdout.write(`    CDP:    http://host.containers.internal:${m.cdpHostPort}\n`);
        process.stdout.write(`    viewer: ${viewerUrl(m)}\n`);
        process.stdout.write(`    vnc password: ${m.novncPassword}\n`);
      }
    }
  }
}

/** `tonoman open browser -a <agent>` — surface the live noVNC viewer (host-loopback). The
 * sidecar already publishes noVNC to 127.0.0.1; the operator opens it locally. LAN/phone
 * reach (broker-forward to advertise_host) is the documented follow-up. */
export async function runOpenBrowser(cfgPath: string, args: string[]): Promise<void> {
  const { agent } = parseAgent(args);
  const cfg = await readRaw(cfgPath);
  const a = findAgent(cfg, agent);
  const container = browserContainer(a.container);
  if ((await containerState(container)) !== "running") {
    process.stderr.write(`No running browser for "${a.name}". Start one: tonoman create browser -a ${a.name}\n`);
    process.exit(1);
    return;
  }
  await writeMetaFromLive(cfg, a, container, a.guid || a.name);
  const m = (await readMeta(cfg, a))!;
  // INTERACTIVE by default — you can click/type to log a site in (MFA/CAPTCHA/credentials you
  // won't hand the agent); the persistent profile keeps the session (browser-interactive-login).
  // No restart of the agent or browser — it's just how this viewer session connects. `--view-only`
  // for pure watching. The x11vnc server is interactive-capable either way.
  const viewOnly = args.includes("--view-only");
  const url = viewerUrl(m, viewOnly);
  process.stdout.write(
    viewOnly
      ? `Watch ${a.name} browse (view-only):\n  ${url}\n  vnc password: ${m.novncPassword} (paste if prompted)\n`
      : `Take the wheel in ${a.name}'s browser (interactive — click/type to log in, then let the agent continue):\n  ${url}\n  vnc password: ${m.novncPassword} (paste if prompted)\n  (use --view-only to just watch)\n`,
  );
  // best-effort: open it in the host's default browser (Windows). Non-fatal if it fails.
  execFile("cmd", ["/c", "start", "", url], { windowsHide: true }, () => {});
}

/** `tonoman close browser -a <agent>` — stop the sidecar (profile volume persists). */
export async function runDeleteBrowser(cfgPath: string, args: string[], opts: { purge?: boolean; stopOnly?: boolean }): Promise<void> {
  const { agent } = parseAgent(args);
  const cfg = await readRaw(cfgPath);
  const a = findAgent(cfg, agent);
  const guid = a.guid || a.name;
  const container = browserContainer(a.container);
  const state = await containerState(container);
  if (state === "absent") {
    process.stdout.write(`No browser for "${a.name}".\n`);
    return;
  }
  if (opts.stopOnly) {
    await podman(["stop", container]).catch(() => {});
    process.stdout.write(`Stopped ${a.name}'s browser (${container}); profile + sidecar kept.\n`);
    return;
  }
  await podman(["rm", "-f", container]).catch(() => {});
  if (opts.purge) {
    await podman(["volume", "rm", "-f", browserProfileVolume(guid)]).catch(() => {});
    await fs.rm(metaPath(cfg, a), { force: true }).catch(() => {});
    process.stdout.write(`Removed ${a.name}'s browser + profile (purged).\n`);
  } else {
    process.stdout.write(`Removed ${a.name}'s browser (${container}); profile volume kept (logins survive). --purge to wipe.\n`);
  }
}

// ---- small local helpers (kept out of cli.ts to avoid bloat) ----

function parseAgent(args: string[]): { agent?: string; pos: string[]; purge: boolean } {
  let agent: string | undefined;
  let purge = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--agent" || a === "-a") agent = args[++i];
    else if (a === "--purge") purge = true;
    else pos.push(a);
  }
  return { agent, pos, purge };
}

/** Parses --purge for delete (re-exported shape). */
export function parseBrowserPurge(args: string[]): boolean {
  return parseAgent(args).purge;
}

async function readRaw(cfgPath: string): Promise<Config> {
  const raw = await fs.readFile(cfgPath, "utf8").catch((e) => {
    throw new Error(`config: read ${cfgPath}: ${(e as Error).message}`);
  });
  return JSON.parse(raw) as Config;
}
