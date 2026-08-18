// Dev tunnel for a locally-hosted channel webhook (channel-teams). This is the host side of
// `tonoman tunnel <up|down|status> <agent>`, and what `tonoman up` starts when an agent opts in.
//
// LOCAL DEV ONLY. In Kubernetes the webhook is fronted by a real ingress + DNS, so no tunnel is
// ever started and none of this runs — the feature is opt-in via config (`teams.tunnel.enabled`)
// and absent config means the previous behavior, unchanged.
//
// Why start + repoint are ONE operation: an anonymous cloudflared "quick tunnel" gets a NEW
// random hostname every start. The Azure bot's messaging endpoint then points at a dead host and
// Teams fails **silently** — no error surfaces, the bot just never replies. So bringing a tunnel
// up without repointing the bot is a broken state; this module always pairs them.
//
// Pure logic + injected seams (spawn / repoint / clock), so the URL parsing and argv assembly are
// unit-tested without spawning cloudflared or touching Azure.

/** cloudflared's quick-tunnel hostname, as printed on startup. */
const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** Recovers the public URL cloudflared prints during startup. Returns undefined until it appears
 * (the banner is emitted a second or two after launch). PURE — the tricky bit, unit-tested. */
export function extractTunnelUrl(chunk: string): string | undefined {
  const m = chunk.match(QUICK_TUNNEL_RE);
  return m ? m[0] : undefined;
}

/** The endpoint Teams must be pointed at — the Bot Framework always POSTs to /api/messages.
 * Tolerates a trailing slash on the base so config/CLI input can't produce a double slash. */
export function messagingEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/messages`;
}

/** `cloudflared` argv for an anonymous quick tunnel onto the local webhook port. PURE. */
export function cloudflaredArgs(port: number): string[] {
  return ["tunnel", "--url", `http://localhost:${port}`];
}

/** `az` argv that repoints an Azure Bot's messaging endpoint. PURE.
 * Requires the operator to be `az login`'d — this is an ARM operation, NOT something the bot's
 * own client secret can do, so it is deliberately separate from the connector's credentials. */
export function azRepointArgs(resourceGroup: string, botName: string, baseUrl: string): string[] {
  return ["bot", "update", "--resource-group", resourceGroup, "--name", botName, "--endpoint", messagingEndpoint(baseUrl), "-o", "none"];
}

/** What we persist so a LATER process (`tonoman tunnel down|status`, or a fresh gateway) can find
 * and manage a tunnel this process started. */
export interface TunnelState {
  pid: number;
  url: string;
  port: number;
  startedAt: string;
}

/** Azure coordinates needed to repoint the bot. Absent → the tunnel still starts, but the
 * endpoint must be updated by hand (we say so loudly rather than pretending it's wired). */
export interface AzureBotRef {
  resource_group: string;
  bot_name: string;
  az_bin?: string;
}

/** Per-agent tunnel config (config.Teams.tunnel). Opt-in: absent/disabled = no tunnel. */
export interface TunnelConfig {
  enabled?: boolean;
  /** cloudflared binary; falls back to the agent's `tunnel_bin`, then "cloudflared". */
  bin?: string;
  azure?: AzureBotRef;
}

/** Seams the runner needs. Injected so the logic is testable without real processes. */
export interface TunnelDeps {
  /** Launch the tunnel; must stream cloudflared's output to `onOutput` and resolve its pid. */
  spawnTunnel(bin: string, args: string[], onOutput: (chunk: string) => void): Promise<number>;
  /** Run the Azure repoint. Rejects on failure. */
  repoint?(azBin: string, args: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

/** How long to wait for cloudflared to print its hostname before giving up. */
export const URL_TIMEOUT_MS = 45_000;

/**
 * Brings the tunnel up and resolves once its public URL is known. Throws if the URL never
 * appears — a tunnel with no URL is useless, and failing loudly beats leaving a half-open one
 * the operator believes is working.
 *
 * Deliberately does NOT repoint: the caller persists this state FIRST, so a repoint failure can
 * never leave an unmanaged (orphaned) cloudflared behind. See repointBot.
 */
export async function startTunnel(
  cfg: TunnelConfig,
  port: number,
  deps: TunnelDeps,
  log: (msg: string) => void = () => {},
): Promise<TunnelState> {
  const bin = cfg.bin || "cloudflared";
  let url: string | undefined;
  const pid = await deps.spawnTunnel(bin, cloudflaredArgs(port), (chunk) => {
    if (!url) url = extractTunnelUrl(chunk);
  });

  const deadline = deps.now().getTime() + URL_TIMEOUT_MS;
  while (!url && deps.now().getTime() < deadline) await deps.sleep(250);
  if (!url) {
    throw new Error(
      `tunnel: ${bin} did not report a public URL within ${URL_TIMEOUT_MS / 1000}s. ` +
        `If that path is a wrapper/shim (e.g. chocolatey's bin/ shim), point teams.tunnel.bin at the REAL binary — a shim does not forward output, so the URL can never be read.`,
    );
  }
  log(`tunnel: ${url} → http://localhost:${port}`);
  return { pid, url, port, startedAt: deps.now().toISOString() };
}

/**
 * Points the Azure bot's messaging endpoint at `url`. Called AFTER the tunnel state is persisted.
 * With no Azure coordinates it says so plainly rather than silently doing nothing — an un-repointed
 * endpoint is precisely the failure this feature exists to prevent, and it fails invisibly.
 */
export async function repointBot(cfg: TunnelConfig, url: string, deps: TunnelDeps, log: (msg: string) => void = () => {}): Promise<boolean> {
  if (!cfg.azure?.resource_group || !cfg.azure?.bot_name || !deps.repoint) {
    log(`tunnel: NOT repointed (no teams.tunnel.azure config) — set the bot endpoint to ${messagingEndpoint(url)} yourself, or Teams will fail silently.`);
    return false;
  }
  await deps.repoint(cfg.azure.az_bin || "az", azRepointArgs(cfg.azure.resource_group, cfg.azure.bot_name, url));
  log(`tunnel: repointed bot ${cfg.azure.bot_name} → ${messagingEndpoint(url)}`);
  return true;
}
