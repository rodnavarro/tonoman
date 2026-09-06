// Wires the substrate (connector + router + memory + stream + runtime broker) and
// the harness adapter together and runs the per-turn loop (A1). This is the
// composition root; all policy lives in the modules it assembles, none here.
//
// v0.1 runs a roster of agents (A11): each is a GUID-identified instance with its
// own isolated memory, control channel, and connector. The harness is selected
// per-agent from a small registry, so the roster never special-cases a harness.

import { execFile, spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config, AgentConfig } from "./config";
import { validate } from "./config";
import { TelegramConnector } from "./connector/telegram";
import { TeamsConnector } from "./connector/teams";
import { SlackConnector } from "./connector/slack";
import type { Connector, Envelope, MemoryStore } from "./core/contracts";
import { Registry as HarnessRegistry, type Spec } from "./harness";
import * as claudecode from "./harness/claudecode";
import * as codex from "./harness/codex";
import * as httpRunner from "./harness/httpRunner";
import * as hermes from "./harness/hermes";
import * as health from "./health";
import { GitStore } from "./memory/gitstore";
import { Store, newGUID, findByName, type Agent as RegAgent } from "./registry";
import { Router } from "./router";
import { parseRoster, type Roster } from "./identity";
import { Consumer } from "./stream";
import { serveControl, makeBrokerExecutor } from "./runtime/control";
import { Ledger } from "./runtime/ledger";
import { ExposeManager, parsePorts, type ContainerInfo } from "./runtime/expose";
import { HostBrowserManager } from "./runtime/hostbrowser";
import { teeConsole, gatewayLogPath } from "./logfile";
import { tcpProxy, type ProxyHandle } from "./runtime/proxy";
import { agentMountPath } from "./mounts";
import { ensureStarted, stopContainer } from "./lifecycle";
import { TurnQueue } from "./turnqueue";
import type { Grant, Policy } from "./runtime/policy";
import { validateModelName, modelHint, modelChoices, fetchModelIds } from "./modelcmd";
import { AsideLane, LiveTurn } from "./aside";
import { compactConversation } from "./compact";
import { parseStatusMode, renderStatus, renderWindows, accountUsageCached, remoteAccountUsageCached, cachedAccountUsage, readOauthToken, STATUS_MODES, type StatusMode, type UsageWindow } from "./statusline";

/** The `/statusline` display mode for one conversation (gw-command-statusline). */
export interface StatusControl {
  get(): StatusMode;
  set(mode: StatusMode): void;
  /** render the current status ON DEMAND (last turn's usage + fresh windows), for
   * `/statusline print` — no agent turn, no tokens. Null when there's nothing to show. */
  snapshot?(): Promise<string | null>;
}

/** The model knob `/model` controls for one conversation (gw-command-model): read the
 * effective model, set it (effect next turn), and the configured default for reset +
 * display. `supported` is false for a harness with no model concept. */
export interface ModelControl {
  get(): string | undefined;
  set(model: string | undefined): void;
  configured: string | undefined;
  supported: boolean;
  /** optional: the tappable picker choices (gw-command-model) — auto-derived model families
   * with an in-code alias fallback. */
  choices?(): Promise<{ label: string; data: string }[]>;
}

/** The auth-backend knob an operator flips live (backend-switch-live): read/set the agent's
 * effective backend (effect next turn), plus the configured default for display/reset. Reached
 * ONLY via the loopback control API (backend-operator-only), never a channel command. */
export interface BackendControl {
  get(): "subscription" | "bedrock" | undefined;
  set(backend: "subscription" | "bedrock" | undefined): void;
  configured: "subscription" | "bedrock" | undefined;
  supported: boolean;
}

/** Loopback handler for `tonoman backend <agent> [mode]` (backend-switch-live). Pure given the
 * control map — validates the agent + mode, reports on no mode, flips on a valid one. Exported so
 * the CLI-facing behavior is unit-testable without a live gateway. */
export function handleBackendControl(
  controls: Map<string, BackendControl>,
  agent: string,
  backend?: string,
): { ok: boolean; msg: string } {
  const ctl = controls.get(agent);
  if (!ctl) {
    const known = [...controls.keys()].join(", ") || "none";
    return { ok: false, msg: `unknown agent "${agent}" (known: ${known})` };
  }
  const cur = ctl.get() ?? "subscription";
  if (backend === undefined || backend === "") {
    return { ok: true, msg: `${agent} backend: ${cur} (configured: ${ctl.configured ?? "subscription"})` };
  }
  if (!ctl.supported) return { ok: false, msg: `${agent}'s harness has no backend switch` };
  if (backend !== "subscription" && backend !== "bedrock")
    return { ok: false, msg: `invalid backend "${backend}" (expected "subscription" or "bedrock")` };
  ctl.set(backend);
  return { ok: true, msg: `${agent} backend: ${cur} → ${backend} (takes effect next turn)` };
}

/** The set of harnesses implemented in v0.1. A new harness is one more entry. Exported
 * so `tonoman create agent` resolves a harness's spec (image, config-home, identity) from
 * the same registry the gateway runs on. */
export function defaultHarnesses(): HarnessRegistry {
  return new HarnessRegistry().add(claudecode.spec()).add(codex.spec()).add(httpRunner.spec()).add(hermes.spec());
}

interface ResolvedAgent {
  cfg: AgentConfig;
  spec: Spec;
  rec: RegAgent;
}

/** Turns the config roster into resolved agents: looks up each harness, assigns a
 * stable GUID (explicit → existing-by-name → freshly minted), and derives per-agent
 * paths and a non-overlapping host port base (A11). Pure — unit-testable. */
export function resolveAgents(
  cfg: Config,
  existing: RegAgent[],
  reg: HarnessRegistry,
  mintGUID: () => string,
): ResolvedAgent[] {
  const out: ResolvedAgent[] = [];
  const usedPorts = new Set<number>();
  for (const a of existing) if (a.port_base && a.port_base > 0) usedPorts.add(a.port_base);

  cfg.agents.forEach((ac, i) => {
    const spec = reg.lookup(ac.harness ?? "");
    if (!spec) throw new Error(`gateway: agent "${ac.name}": unknown harness "${ac.harness}"`);

    let guid = ac.guid;
    if (!guid) {
      const prev = findByName(existing, ac.name);
      guid = prev ? prev.guid : mintGUID();
    }

    const memRoot = ac.workspace?.root || path.join(cfg.state_root ?? "", guid, "memory");
    const configVol = ac.config_volume || path.join(cfg.state_root ?? "", guid, "config");

    let portBase = ac.port_base ?? 0;
    if (portBase <= 0) {
      const prev = findByName(existing, ac.name);
      if (prev && prev.port_base && prev.port_base > 0) {
        portBase = prev.port_base;
      } else {
        portBase = 3000 + i * 10;
        while (usedPorts.has(portBase)) portBase += 10;
      }
    }
    usedPorts.add(portBase);

    out.push({
      cfg: ac,
      spec,
      rec: {
        guid,
        name: ac.name,
        role: ac.role,
        harness: ac.harness!,
        model: ac.model,
        backend: ac.auth, // brain auth backend default (backend-config-default)
        max_turns: ac.max_turns,
        container: ac.container,
        config_volume: configVol,
        config_home: spec.configHome,
        memory_root: memRoot,
        // A service agent owns its own channel (svc-self-channeled); a turn-driven one is
        // reached over a Tonoman connector — telegram or teams (channel-teams).
        channel: spec.service || ac.service ? "self" : ac.channel ?? (ac.teams ? "teams" : "telegram"),
        port_base: portBase,
      },
    });
  });
  return out;
}

/** Builds the runtime policy for one agent: its GUID + a grant per declared mount,
 * mapping the sandbox view (~/files/<name>, A9) to the host path. */
function policyFor(ra: ResolvedAgent): Policy {
  const grants: Grant[] = (ra.cfg.mounts ?? []).map((m) => ({
    agentPath: agentMountPath(m.name),
    hostPath: m.host,
    readOnly: m.read_only,
  }));
  return { guid: ra.rec.guid, grants };
}

/** Builds the roster from cfg and serves every agent until the signal aborts. */
export async function run(cfg: Config, signal: AbortSignal): Promise<void> {
  validate(cfg);

  // Persist the gateway log (turns, broker ops, errors with full claude stderr, memory
  // warnings) to <state_root>/gateway.log so it's inspectable via `tonoman logs` / Read,
  // not just on whoever's terminal ran `up` (observability for the iterate loop).
  teeConsole(gatewayLogPath(cfg.state_root || path.join(os.homedir() || ".", ".tonoman")));

  // The gateway owns the control-plane lifecycle (cli-up-down). `down` (and Ctrl-C)
  // come in as an abort: an external abort, OR a POST to the loopback /shutdown endpoint
  // below, both trip `inner`. Everything downstream watches inner.signal so a remote
  // `tonoman down` tears the same things down as Ctrl-C.
  const inner = new AbortController();
  signal.addEventListener("abort", () => inner.abort(), { once: true });

  const reg = defaultHarnesses();
  const store = new Store(registryPath(cfg));
  const existing = await store.load();
  const resolved = resolveAgents(cfg, existing, reg, newGUID);

  // Persist the instance registry (A11): one GUID-keyed row per agent.
  for (const ra of resolved) await store.upsert(ra.rec);

  // Service-health API (A12): one local endpoint serving the snapshot. POST /shutdown
  // on the same loopback surface is how `tonoman down` stops the plane gracefully; POST /backend
  // is how `tonoman backend <agent> <mode>` flips an agent's auth backend live (backend-switch-live).
  const hreg = new health.Registry();
  // Per-agent auth-backend knobs, populated by runAgent as each agent comes up (backend-switch-live).
  const backendControls = new Map<string, BackendControl>();
  health
    .serve(cfg.health_addr, hreg, inner.signal, undefined, () => inner.abort(), (agent, backend) =>
      handleBackendControl(backendControls, agent, backend),
    )
    .catch((e) => {
      if (!inner.signal.aborted) console.error(`gateway: health api error: ${(e as Error).message}`);
    });
  console.log(`gateway: health api on http://${cfg.health_addr}/health (POST /shutdown = tonoman down)`);

  // Bring each agent's sandbox up (cli-up-down). Adopt-safe: start-if-stopped, no-op if
  // running; an ABSENT container is reported, never silently created here — provisioning
  // is `tonoman create agent` (roster-provision). The container must be up before turns
  // exec into it.
  for (const ra of resolved) {
    // A remote agent (claude-code-http, k8s split) has no local container — its lifecycle is
    // owned by another runtime (k8s). Nothing to bring up here.
    if (ra.spec.remote) {
      console.log(`gateway: remote agent "${ra.rec.name}" — driven over HTTP at ${ra.cfg.url} (no local container)`);
      continue;
    }
    try {
      const r = await ensureStarted(ra.rec.container);
      if (r === "started") console.log(`gateway: started container ${ra.rec.container}`);
      else if (r === "absent")
        console.warn(`gateway: container "${ra.rec.container}" not found — provision it: tonoman create agent ${ra.rec.name}`);
    } catch (e) {
      console.error(`gateway: bringing up ${ra.rec.container}: ${(e as Error).message}`);
    }
  }

  await Promise.all(resolved.map((ra) => runAgent(cfg, ra, hreg, inner.signal, backendControls)));

  // Shutdown (tonoman down / Ctrl-C): the gateway stops every agent container it owns.
  // stop ≠ rm — volumes/creds/memory persist, so `up` brings each agent back fully
  // configured. Awaited so `down` is graceful, not a yank.
  await Promise.allSettled(
    resolved
      .filter((ra) => !ra.spec.remote) // remote agents have no local container to stop
      .map((ra) =>
        stopContainer(ra.rec.container).then((stopped) => {
          if (stopped) console.log(`gateway: stopped container ${ra.rec.container}`);
        }),
      ),
  );
}

/** Builds one agent's isolated substrate and serves its turn loop. Every resource
 * here is per-agent (memory, control channel, connector), so two agents share
 * nothing but the process (A11 isolation). */
async function runAgent(
  cfg: Config,
  ra: ResolvedAgent,
  hreg: health.Registry,
  signal: AbortSignal,
  backendControls?: Map<string, BackendControl>,
): Promise<void> {
  const rec = ra.rec;

  // Service agent (svc-self-channeled): Tonoman has already booted its container (run() →
  // ensureStarted); it owns its own loop, so we attach NO turn-loop, router, connector,
  // memory substrate, or broker control channel. We only register its health (the container
  // is up + its port answers, health-no-tokens) and return.
  if (ra.spec.service || ra.cfg.service) {
    registerAgentHealth(hreg, ra);
    return;
  }

  const mem = new GitStore({
    root: rec.memory_root,
    remote: ra.cfg.workspace?.remote,
    token: ra.cfg.workspace?.token,
    branch: ra.cfg.workspace?.branch,
    authorName: rec.name,
    authorEmail: "agent@tonoman.local",
  });
  await mem.ensureRepo();

  // Auto-commit cadence (ws-git-autocommit). The natural commit is at every turn boundary
  // (router.ts) + auto-push. Here we add only a LOW-FREQUENCY safety sweep for changes made
  // between turns, plus a final commit on shutdown — commit() is a no-op when nothing
  // changed and the .gitignore keeps secrets out of `git add -A`. Disabled by auto_commit:false.
  if (ra.cfg.workspace?.auto_commit !== false) {
    const sweep = setInterval(() => void mem.commit("auto: periodic sweep").catch(() => {}), 30 * 60 * 1000);
    if (typeof sweep.unref === "function") sweep.unref(); // never keep the process alive
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(sweep);
        void mem.commit("auto: shutdown").catch(() => {});
      },
      { once: true },
    );
  }

  // The broker ledger (A8/A12): one discoverable per-agent log of every brokered op
  // and every turn boundary, in the git-backed workspace. It is the source of truth
  // for "did the work actually run", and the orphan catch for backgrounded-and-dropped
  // commands (gw-brokered-op-accountable). Only authorized (pre-injection) argv is
  // logged — never an injected secret. Turn boundaries are logged for EVERY agent
  // (remote too); only the co-located broker substrate below is podman-local.
  const ledger = new Ledger({ file: path.join(rec.memory_root, "ledger.jsonl") });

  // The runtime broker substrate (control channel + expose + host-browser) is filesystem IPC
  // to a CO-LOCATED sandbox: the agent's in-sandbox `podman`/`tonoman` shim writes requests
  // under its memory root and the broker execs host podman. A REMOTE agent (claude-code-http,
  // k8s split) runs in another runtime and can't reach this host filesystem — and a `billing`
  // billing agent needs none of it (billing runs pod-local). So skip building it for remote.
  if (!ra.spec.remote) {
    // Per-agent runtime broker control channel (A8/A13), namespaced under this agent's own
    // memory root; the broker authorizes requests against this agent's grants (A11).
    const controlDir = path.join(rec.memory_root, "control");

    // Reachable-service-URL capability (devcontainerized-resolve-url/-expose-url): the agent
    // requests `tonoman url/expose <svc>` over the control channel; the broker resolves the URL
    // host-side and performs any port-forward. Scoped to this agent's own containers (A11).
    const advertiseHost = cfg.expose?.advertise_host || detectAdvertiseHost();
    const forward = makeForward(advertiseHost);
    const expose = new ExposeManager({
      advertiseHost,
      listContainers: listAgentContainers(rec.guid, rec.container),
      forward,
      tunnelEnabled: cfg.expose?.tunnel,
    });
    signal.addEventListener(
      "abort",
      () => {
        for (const p of expose.exposedPorts()) void forward("remove", p).catch(() => {}); // tear down on shutdown
      },
      { once: true },
    );

    // Host-browser backend (browser-host-chrome, A14): the agent triggers `tonoman browser
    // ensure` and the broker launches a real Chrome window on the HOST with CDP, reachable by
    // the agent at the advertised IP. The agent only requests; the broker performs the launch.
    const hostBrowser = new HostBrowserManager({
      advertiseHost,
      memoryRoot: rec.memory_root,
      stateBase: path.dirname(rec.memory_root),
    });
    signal.addEventListener("abort", () => hostBrowser.closeRelays(), { once: true }); // tear down CDP relays on shutdown

    const exec = makeBrokerExecutor(policyFor(ra), {
      tonoman: (args) => (String(args[0] ?? "").toLowerCase() === "browser" ? hostBrowser.handle(args.slice(1)) : expose.handle(args)),
      agentLabel: `tonoman.agent=${rec.guid}`, // stamp brokered containers with their owner (A11)
    });

    serveControl(controlDir, exec, {
      signal,
      ledger,
      onReady: (d) => console.log(`gateway: control channel watching ${d} (A8/A13 broker)`),
    }).catch((e) => {
      if (!signal.aborted) console.error(`gateway: control channel error: ${(e as Error).message}`);
    });
  }

  registerAgentHealth(hreg, ra);

  // Non-service path: select the channel connector (channel-teams). validate() guarantees
  // the chosen channel's credentials are present. The harness/router/queue downstream are
  // channel-neutral — only this instantiation differs.
  const channel = ra.cfg.channel ?? (ra.cfg.slack ? "slack" : ra.cfg.teams ? "teams" : "telegram");
  const isTeams = channel === "teams";
  let conn: Connector;
  if (channel === "slack") {
    const sl = ra.cfg.slack ?? {};
    // Both tokens are SECRETS (cfg-no-secrets): prefer them injected via env at run time, fall
    // back to the roster fields for dev. Error clearly rather than dialling with an empty token,
    // which Slack answers with a bare `invalid_auth` that says nothing about which one is missing.
    const appToken = sl.app_token || process.env.SLACK_APP_TOKEN || "";
    const botToken = sl.bot_token || process.env.SLACK_BOT_TOKEN || "";
    const absent = [!appToken && "SLACK_APP_TOKEN", !botToken && "SLACK_BOT_TOKEN"].filter(Boolean);
    if (absent.length > 0) {
      throw new Error(`slack: agent "${rec.name}" is missing ${absent.join(" and ")}`);
    }
    conn = new SlackConnector({ appToken, botToken, allowedUsers: sl.allowed_users });
  } else if (channel === "teams") {
    const tm = ra.cfg.teams!;
    // app_password is a SECRET (cfg-no-secrets): prefer it injected via env at run time,
    // fall back to the roster field for dev. Error clearly if neither is present.
    const appPassword = tm.app_password || process.env.TEAMS_APP_PASSWORD || process.env.TEAMS_CLIENT_SECRET || "";
    if (!appPassword) throw new Error(`teams: agent "${rec.name}" has no app_password (set TEAMS_APP_PASSWORD or teams.app_password)`);
    // identity-roster: load the ConfigMap-mounted people roster (email→person) if configured. A read
    // failure logs and yields no roster (everyone unknown) rather than blocking gateway boot.
    let roster: Roster | undefined;
    if (tm.people_file) {
      try {
        roster = parseRoster(readFileSync(tm.people_file, "utf8"));
        console.log(`teams: loaded people roster (${roster.size} people) from ${tm.people_file}`);
      } catch (e) {
        console.error(`teams: could not read people_file ${tm.people_file}: ${(e as Error).message}`);
      }
    }
    conn = new TeamsConnector({
      appId: tm.app_id,
      appPassword,
      tenantId: tm.tenant_id,
      allowedUser: tm.allowed_user,
      roster,
      restrictToRoster: tm.restrict_to_roster,
      mediaDir: tm.media_dir,
      mediaMount: tm.media_mount,
      port: tm.port,
      workingCue: tm.working_cue,
    });
  } else {
    const tg = ra.cfg.telegram!;
    conn = new TelegramConnector({
      token: tg.token,
      allowedUser: tg.allowed_user,
      mediaDir: tg.media_dir,
      mediaMount: tg.media_mount,
    });
  }

  // Wrap the harness runner with a live-turn tap (gw-command-btw): the snapshot it keeps
  // (partial text + last tool + elapsed) is what a `/btw` aside reads to answer "how's it
  // going". Purely observational — it never alters the turn.
  const live = new LiveTurn();
  // Non-service path: a turn-driven harness always supplies newRunner (service returned above).
  const runner = live.monitor(
    ra.spec.newRunner!({ container: rec.container, model: rec.model, maxTurns: rec.max_turns, url: ra.cfg.url, backend: rec.backend }),
  );
  const windowSize = ra.cfg.window_size ?? 30;

  // The `/model` knob for this conversation (gw-command-model): delegates to the harness's
  // per-turn model field; `configured` is the roster default for reset/display. Lifetime is
  // this gateway run (the runner is rebuilt on restart) and survives /new.
  const modelControl: ModelControl = {
    get: () => runner.getModel?.() ?? rec.model,
    set: (m) => runner.setModel?.(m),
    configured: rec.model,
    supported: typeof runner.setModel === "function",
    // Picker choices: latest model family per the Anthropic models API (agent's OAuth token),
    // falling back to the in-code aliases if the fetch fails (gw-command-model).
    choices: async () => {
      const token = ra.spec.credFile ? await readOauthToken(rec.container, ra.spec.credFile) : null;
      return modelChoices(token ? await fetchModelIds(token) : []);
    },
  };

  // The auth-backend knob for this agent (backend-switch-live): the loopback POST /backend (via
  // `tonoman backend <agent> <mode>`) flips it, effect next turn; the runner snapshots it into each
  // /turn body. Per-AGENT (not per-conversation) — an operator/deployment concern. Resets to the
  // configured default on restart (backend-restart-reverts).
  const backendControl: BackendControl = {
    get: () => runner.getBackend?.() ?? rec.backend,
    set: (b) => runner.setBackend?.(b),
    configured: rec.backend,
    supported: typeof runner.setBackend === "function",
  };
  backendControls?.set(rec.name, backendControl);

  // Account usage (5h/7d headroom) source. A REMOTE agent (claude-code-http, k8s split) has no
  // local container to podman-exec, so it reports its OWN windows over HTTP (/usage); a co-located
  // agent is read by podman-exec of its credential file. Both cache under `usageKey`, so the
  // synchronous footer read (cachedAccountUsage) is identical regardless of source.
  const usageKey = ra.spec.remote ? (ra.cfg.url ?? rec.name) : rec.container;
  const usageEnabled = ra.spec.remote ? !!ra.cfg.url : !!ra.spec.credFile;
  const warmUsage = (): Promise<UsageWindow[]> =>
    ra.spec.remote
      ? remoteAccountUsageCached(usageKey, ra.cfg.url ?? "", process.env.AGENT_RUNTIME_TOKEN)
      : accountUsageCached(rec.container, ra.spec.credFile!);

  // /statusline mode (gw-command-statusline): per-conversation, survives /new, resets on restart
  // (like /model). Default is "small" (a compact per-turn footer is shown by default); override the
  // startup default with TONOMAN_STATUSLINE=none|small|full. `/statusline <mode>` still switches live.
  const envMode = process.env.TONOMAN_STATUSLINE;
  let statusMode: StatusMode = envMode === "none" || envMode === "full" || envMode === "small" ? envMode : "small";
  const statusControl: StatusControl = {
    get: () => statusMode,
    set: (m) => void (statusMode = m),
    // /statusline print: render the last turn's usage + fresh account windows, on demand.
    snapshot: async () => {
      const windows = usageEnabled ? await warmUsage() : [];
      const usage = live.lastUsage();
      if (usage) return renderStatus("full", usage, modelControl.get(), windows, Date.now());
      return windows.length ? renderWindows(windows, Date.now()) : "📊 No turn yet — send a message first.";
    },
  };

  // /compact (gw-command-compact): summarize this conversation, rotate to a fresh session, and seed
  // it with the summary — context (ctx%) drops while continuity survives. Uses the main runner for a
  // one-shot summary (the remote HTTP harness has no ephemeral sidecar), then rotates + seeds `mem`.
  const compact = async (conv: string): Promise<string> =>
    compactConversation({ conversation: conv, runner, memory: mem, windowSize });

  // /health (gw-command-health): deterministic checks only — no agent turn, no tokens.
  const health = async (): Promise<string> => {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const checks: HealthCheckLine[] = [];
    // Remote agent (claude-code-http, k8s split): there's no local container — probe the
    // agent runtime's token-free HTTP /health instead of podman (health-no-tokens preserved).
    if (ra.spec.remote) {
      const url = ra.cfg.url ?? "";
      const probe = await probeRemoteHealth(url);
      checks.push({
        label: "agent runtime",
        ok: probe.ok,
        detail: probe.reachable ? `${url} ${probe.detail}` : `UNREACHABLE (${url}): ${probe.detail}`,
      });
      if (probe.reachable)
        checks.push({
          label: "brain auth",
          ok: probe.cred,
          detail: probe.cred ? "credential present" : "NO credential on the agent PVC — seed it (kubectl cp)",
        });
      return renderHealth(rec.name, ts, checks, rec.memory_root);
    }
    let up = false;
    try {
      up = await containerRunning(rec.container);
    } catch {
      /* treated as down */
    }
    checks.push({ label: "container", ok: up, detail: up ? `up (${rec.container})` : `DOWN (${rec.container})` });
    if (up) {
      if (ra.spec.statusArgs?.length) {
        const authed = await execOk("podman", ["exec", "-e", "IS_SANDBOX=1", rec.container, ...ra.spec.statusArgs]);
        checks.push({ label: "brain auth", ok: authed, detail: authed ? "authenticated" : `NOT authenticated — tonoman auth login ${rec.name}` });
      }
      // agent → tonoman reachability: a brokered round-trip via the in-sandbox podman shim.
      const reachable = await execOk("podman", ["exec", rec.container, "podman", "ps"]);
      checks.push({ label: "tonoman broker (from agent)", ok: reachable, detail: reachable ? "reachable" : "UNREACHABLE" });
    }
    return renderHealth(rec.name, ts, checks, rec.memory_root);
  };

  // Teams streams via the `streaminfo` prefix protocol (teams-stream-progressive): no cursor,
  // no interleaved tool/heartbeat lines, ≥~1.5s throttle (Teams' ~1 req/s), block-fallback
  // past ~4000 chars, always-finalize. These are opt-in and Teams-only — Telegram keeps the
  // configured stream options unchanged (teams-consumer-telegram-safe).
  const streamer = new Consumer(
    isTeams
      ? {
          cursor: "",
          editIntervalMs: Math.max(cfg.stream.edit_interval_ms, 1500),
          heartbeatMs: 0,
          maxLen: 4000,
          prefixStream: true,
        }
      : {
          cursor: cfg.stream.cursor,
          // Slack rate-limits chat.update to roughly one call per second per channel, and a
          // burst answers 429 for the whole stream. Floor the edit interval rather than let a
          // fast turn spend the turn's budget on edits it will immediately overwrite.
          editIntervalMs:
            channel === "slack"
              ? Math.max(cfg.stream.edit_interval_ms, 1200)
              : cfg.stream.edit_interval_ms,
          heartbeatMs: cfg.stream.heartbeat_ms,
        },
  );

  const router = new Router({
    agent: {
      name: rec.name,
      role: rec.role,
      systemPromptFile: ra.cfg.system_prompt_file,
      runner,
      memory: mem,
      windowSize,
      sessionPersist: ra.cfg.session_persist,
    },
    streamer,
    // gw-command-statusline: a display-only footer on the bottom of each reply (never
    // committed). Account windows are read from the cache the turn-start pre-fetch warmed.
    statusFooter: (usage) => {
      // Always LOG per-turn usage (independent of the visible footer mode) so cost is monitorable
      // in the gateway log — a spike (huge ctx/out, or an uncached full re-send) shows up here.
      if (usage) {
        const u = usage;
        const cost = u.costUsd != null ? ` cost=$${u.costUsd.toFixed(4)}` : "";
        console.log(
          `gateway: usage agent=${rec.name} model=${u.model ?? "?"} in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0} ` +
            `cacheR=${u.cacheReadTokens ?? 0} cacheW=${u.cacheWriteTokens ?? 0} ctx=${u.contextTokens ?? 0}${cost}`,
        );
      }
      return statusControl.get() === "none"
        ? null
        : renderStatus(statusControl.get(), usage, modelControl.get(), cachedAccountUsage(usageKey), Date.now());
    },
  });

  // The `/btw` aside lane (gw-command-btw): an ephemeral sidecar turn that answers a quick
  // question out-of-band — its own reply, never committed, concurrent with the running turn,
  // fed the live snapshot. Built only if the harness exposes an ephemeral runner.
  let aside: AsideLane | undefined;
  if (ra.spec.newEphemeralRunner) {
    const ephemeral = ra.spec.newEphemeralRunner({
      volumesFrom: rec.container, // inherit the caller's mounts (shared credential, identity, skills)
      image: ra.spec.image,
      env: ra.spec.runEnv,
      model: rec.model,
    });
    aside = new AsideLane({
      conn,
      streamer,
      runner: ephemeral,
      readWindow: (c, n) => mem.readWindow(c, n),
      windowSize,
      identity: { name: rec.name, role: rec.role, systemPromptFile: ra.cfg.system_prompt_file },
      live,
      currentModel: () => modelControl.get(),
    });
  }

  console.log(
    `gateway: agent "${rec.name}" (${rec.guid}) up: harness=${rec.harness} container=${rec.container} memory=${rec.memory_root} port_base=${rec.port_base}`,
  );

  // Register the channel's command menu (best-effort), so the commands are discoverable.
  void conn
    .registerCommands?.([
      { command: "steer", description: "Interrupt now, keep context: /steer <message>" },
      { command: "pop", description: "Run the queued message(s) now" },
      { command: "skip", description: "Clear the queued message(s)" },
      { command: "interrupt", description: "Hard stop, drop context, start clean: /interrupt <message>" },
      { command: "new", description: "Start a fresh session (clear context)" },
      { command: "compact", description: "Summarize + shrink context, keep the thread: /compact" },
      { command: "model", description: "Switch model for the next turn: /model <opus|sonnet|haiku>" },
      { command: "btw", description: "Ask a quick aside without interrupting: /btw <question>" },
      { command: "statusline", description: "Show token + account usage: /statusline none|small|full|print" },
      { command: "health", description: "Deterministic health check (no tokens): /health" },
      { command: "help", description: "List available commands" },
    ])
    .catch(() => {});

  // A single in-place "queue footer" per conversation (gw-turn-enqueue): while messages
  // are queued behind a running turn, show ONE status line and edit it as the queue grows
  // — not a banner per message. It resolves when the queue is picked up. Best-effort (a
  // dropped footer never costs a turn).
  const footers = new Map<string, string>(); // conv → footer message id
  const renderFooter = async (conv: string, count: number, preview: string, running: boolean): Promise<void> => {
    const reply = conn.reply(conv);
    // The footer is a STANDALONE notice, not part of the streamed reply — drive it through note()
    // (a plain, stateless, edit-by-id message). On Teams reply.send() would open a streaminfo
    // stream that the turn's answer then visually collides with; note() keeps the footer its own
    // independently-editable bubble. Channels without note() fall back to send()/update().
    const id = footers.get(conv);
    try {
      if (count > 0 && running) {
        const clip = preview.replace(/\s+/g, " ").trim().slice(0, 40);
        const text = `🗂 Queued (${count})${clip ? `: "${clip}…"` : ""} · /pop to run now · /skip to clear`;
        if (reply.note) {
          if (!id) footers.set(conv, await reply.note(undefined, text));
          else await reply.note(id, text);
        } else if (!id) footers.set(conv, await reply.send(text));
        else await reply.update(id, text);
      } else if (id) {
        // Queue picked up (or cleared): REMOVE the footer cleanly — the answer then streams as its
        // own message. We deliberately don't leave a marker ("▶…"/"↪ question…"): a long turn would
        // strand it with no answer beneath, which reads as unanswered. True question↔answer linkage
        // is a separate feature (native reply-to). Channels without note() edit to a generic marker.
        if (reply.note) await reply.note(id, null);
        else await reply.update(id, "▶ On your queued message…");
        footers.delete(conv);
      }
    } catch {
      /* footer is best-effort */
    }
  };

  // One turn engine per conversation (A1): exactly one turn at a time + a single merged
  // pending slot. Queue-by-default — a plain message enqueues; /steer//pop//interrupt act
  // mid-turn (gw-turn-enqueue). The inbound loop never blocks on a turn.
  const queues = new Map<string, TurnQueue>();
  const queueFor = (conv: string): TurnQueue => {
    const existing = queues.get(conv);
    if (existing) return existing;
    const q = new TurnQueue(
      async (msg, turnSignal) => {
      const env: Envelope = {
        channel: conn.name(),
        conversation: conv,
        user: msg.user,
        identity: msg.identity,
        text: msg.text,
        mediaPaths: msg.mediaPaths,
      };
      const preview = env.text.length > 40 ? env.text.slice(0, 40) : env.text;
      console.log(`gateway: turn conv=${conv} user=${env.user} text="${preview}" media=${env.mediaPaths.length}`);
      await ledger.turnStart(conv, env.user, preview);
      // Warm the account-usage cache while the turn runs, so the status footer (rendered
      // synchronously at finalize) has fresh 5h/7d windows (gw-command-statusline).
      if (statusControl.get() !== "none" && usageEnabled) {
        void warmUsage().catch(() => {});
      }
      try {
        await router.handle(conn, env, turnSignal);
      } catch (e) {
        console.error(`gateway: turn error (conv=${conv}): ${(e as Error).message}`);
      } finally {
        // The catch (gw-brokered-op-accountable): any brokered op still in-flight now was
        // started but never awaited — flag it on the ledger rather than let it vanish.
        const orphans = await ledger.endTurn(conv);
        if (orphans.length > 0) {
          console.warn(
            `gateway: ${orphans.length} brokered op(s) ORPHANED at turn-end (conv=${conv}, ids=${orphans.join(",")}) — flagged on the ledger.`,
          );
        }
      }
      },
      signal,
      {
        // Drive the single queue footer as the waiting-queue depth changes.
        onPendingChange: (count, preview, running) => void renderFooter(conv, count, preview, running),
      },
    );
    queues.set(conv, q);
    return q;
  };

  for await (const env of conn.receive(signal)) {
    const q = queueFor(env.conversation);
    const cmd = parseCommand(env.text);
    if (cmd) {
      await dispatchCommand(cmd, env, q, conn, mem, modelControl, aside, statusControl, health, compact);
      continue;
    }
    // A plain message is QUEUED by default (merged with anything waiting) and runs after
    // the current turn — say everything on your mind; the agent gets to it (gw-turn-enqueue).
    // /steer or /pop to act now. The footer (onPendingChange) is the acknowledgement.
    q.message(env.text, env.user, env.mediaPaths, env.identity);
  }
}

/** One deterministic /health check result (gw-command-health). */
export interface HealthCheckLine {
  label: string;
  ok: boolean;
  detail: string;
}

/** Renders the /health report: an overall ✅ Healthy / ❌ Unhealthy verdict (healthy iff every
 * check passed) + a ✅/❌ per check + the memory location. Pure — unit-tested. */
export function renderHealth(name: string, ts: string, checks: HealthCheckLine[], memory: string): string {
  const healthy = checks.length > 0 && checks.every((c) => c.ok);
  const lines = [`${healthy ? "✅ Healthy" : "❌ Unhealthy"} — ${name} · ${ts}`];
  for (const c of checks) lines.push(`${c.ok ? "✅" : "❌"} ${c.label}: ${c.detail}`);
  lines.push(`• memory: ${memory}`);
  return lines.join("\n");
}

/** A parsed slash-command: `/new`, `/reset`, `/help`, … (the `@botname` suffix and
 * case are normalized away). Returns null for plain text. */
export interface ParsedCommand {
  name: string;
  args: string;
}
export function parseCommand(text: string): ParsedCommand | null {
  const t = (text ?? "").trim();
  if (!t.startsWith("/")) return null;
  const m = t.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].split("@")[0].toLowerCase(), args: (m[2] ?? "").trim() };
}

const HELP_TEXT = [
  "How it works: just message me — if I'm busy, your message is QUEUED (and merged with",
  "anything else waiting), and I get to it after the current task. Say everything on your mind.",
  "",
  "Commands:",
  "/steer <message> — interrupt now and redirect me, keeping what I was doing as context",
  "/pop — run the queued message(s) now (interrupt, keep context)",
  "/skip — clear the queued message(s)",
  "/interrupt <message> — hard stop and start clean (drop what I was doing)",
  "/new — start a fresh session (clear all context)",
  "/compact — summarize our conversation and shrink my context, but keep the thread (unlike /new)",
  "/model <name> — switch my model for the next turn (opus | sonnet | haiku); /model alone shows current",
  "/btw <question> — ask a quick aside without interrupting what I'm doing (answered separately, off the record)",
  "/statusline none|small|full — token + Claude usage after each turn; /statusline print shows it now (no turn); /statusline alone = picker",
  "/health — deterministic check that I'm up, authenticated, and can reach tonoman (no tokens)",
  "/help — this list",
].join("\n");

/** Dispatches a platform command against the conversation's turn engine. Commands
 * never run a model turn directly — they control the session and the in-flight turn. */
export async function dispatchCommand(
  cmd: ParsedCommand,
  env: Envelope,
  q: TurnQueue,
  conn: Connector,
  mem: MemoryStore,
  model?: ModelControl,
  aside?: AsideLane,
  status?: StatusControl,
  health?: () => Promise<string>,
  compact?: (conv: string) => Promise<string>,
): Promise<void> {
  // Command acknowledgements (/new, /model, /pop, …) are one-shot plain messages — route them
  // through note() so on Teams they don't open an unfinalized streaminfo stream (which renders as
  // an EMPTY message). Falls back to send() on channels without note(). sendChoices stays as-is.
  const raw = conn.reply(env.conversation);
  const reply = {
    send: (text: string): Promise<string> => (raw.note ? raw.note(undefined, text) : raw.send(text)),
    sendChoices: raw.sendChoices ? raw.sendChoices.bind(raw) : undefined,
  };
  switch (cmd.name) {
    case "health": {
      // /health — deterministic agent health check, no agent turn / no tokens (gw-command-health).
      await reply.send(health ? await health() : "Health check isn't available for this agent.");
      return;
    }
    case "statusline": {
      // /statusline none|small|full|print — per-conversation usage display (gw-command-statusline).
      if (!status) {
        await reply.send("Status line isn't available for this agent.");
        return;
      }
      const arg = cmd.args.trim();
      // print: show the status ONCE now, no agent turn (an action, not a mode).
      if (arg.toLowerCase() === "print") {
        const text = status.snapshot ? await status.snapshot() : null;
        await reply.send(text || "📊 No usage to show yet.");
        return;
      }
      if (!arg) {
        // Show a tappable picker (no typing) when the channel supports it; else a text hint.
        if (reply.sendChoices) {
          await reply.sendChoices(`📊 Status line (now: ${status.get()}) — pick one:`, [
            ...STATUS_MODES.map((m) => ({ label: m, data: `/statusline ${m}` })),
            { label: "print", data: "/statusline print" },
          ]);
        } else {
          await reply.send(`📊 Status line: ${status.get()}. Set with /statusline ${STATUS_MODES.join("|")} (or print).`);
        }
        return;
      }
      const mode = parseStatusMode(arg);
      if (!mode) {
        await reply.send(`Unknown mode "${arg}". Use: /statusline ${STATUS_MODES.join("|")}.`);
        return;
      }
      status.set(mode);
      await reply.send(mode === "none" ? "📊 Status line off." : `📊 Status line: ${mode} — shown after each turn.`);
      return;
    }
    case "btw": {
      // /btw — answer a quick aside out-of-band, without interrupting the running turn and
      // without committing it (gw-command-btw). The aside owns its own reply + busy message.
      if (!aside) {
        await reply.send("Asides (/btw) aren't available for this agent.");
        return;
      }
      if (!cmd.args.trim()) {
        await reply.send("Usage: /btw <question> — ask a quick aside without interrupting what I'm doing.");
        return;
      }
      // Fire-and-forget: the aside runs concurrently and owns its own reply + errors. We must
      // NOT await it here — this dispatch runs on the inbound-receive loop, so awaiting a
      // (up-to-120s) aside would stall intake of every following message, contradicting the
      // whole "ask without interrupting" premise. The lane's busy-guard serializes asides.
      void aside.ask(cmd.args.trim(), env.conversation).catch(() => {});
      return;
    }
    case "model": {
      // /model — switch the model for the NEXT turn; a running turn is unaffected
      // (gw-command-model). No arg → report current; `default`/`reset` → clear override.
      if (!model || !model.supported) {
        await reply.send("This agent's harness has no model switch.");
        return;
      }
      const arg = cmd.args.trim();
      const fmt = (m: string | undefined) => m ?? "(account default)";
      if (!arg) {
        // Tappable picker when the channel supports it (gw-command-model); else a text hint.
        if (reply.sendChoices && model.choices) {
          await reply.sendChoices(`🧠 Model (now: ${fmt(model.get())}) — pick one:`, await model.choices());
        } else {
          const cur = model.get();
          const isOverride = cur !== model.configured;
          await reply.send(
            `🧠 Model: ${fmt(cur)}${isOverride ? ` (override; configured: ${fmt(model.configured)})` : ""}.\n` +
              `Switch with /model <name> — ${modelHint()}. /model default to reset.`,
          );
        }
        return;
      }
      if (/^(default|reset)$/i.test(arg)) {
        const prev = model.get();
        model.set(model.configured);
        await reply.send(`🧠 Model reset to configured ${fmt(model.configured)} (was ${fmt(prev)}) — takes effect next turn.`);
        return;
      }
      const v = validateModelName(arg);
      if (!v.ok) {
        await reply.send(v.error);
        return;
      }
      const prev = model.get();
      if (v.model === prev) {
        await reply.send(`🧠 Already on ${fmt(prev)}.`);
        return;
      }
      model.set(v.model);
      await reply.send(`🧠 Model: ${fmt(prev)} → ${v.model} — takes effect next turn (a turn already running finishes on ${fmt(prev)}).`);
      return;
    }
    case "new":
    case "reset": {
      q.reset(); // stop any running turn (its partial is dropped) before rotating
      const id = await mem.newSession(env.conversation);
      console.log(`gateway: /${cmd.name} → new session ${id} for conv=${env.conversation}`);
      await reply.send("🧹 New session — context cleared. Starting fresh.");
      return;
    }
    case "compact": {
      // /compact — summarize the session, rotate to a fresh one, seed it with the summary so
      // context (ctx%) drops but continuity survives (gw-command-compact). Unlike /new (amnesia).
      if (!compact) {
        await reply.send("Compaction isn't available for this agent.");
        return;
      }
      q.reset(); // stop any running turn before summarizing + rotating (like /new)
      await reply.send("🗜 Compacting our conversation — summarizing, then clearing…");
      await reply.send(await compact(env.conversation));
      return;
    }
    case "steer": {
      if (!cmd.args) {
        await reply.send("Usage: /steer <message> — interrupt now and redirect me (keeping context).");
        return;
      }
      q.steer(cmd.args, env.user, env.mediaPaths, env.identity);
      return; // the redirected turn's reply is the acknowledgement
    }
    case "pop":
      if (!q.pop()) await reply.send("Nothing queued.");
      return;
    case "interrupt": {
      if (!cmd.args) {
        await reply.send("Usage: /interrupt <message> — hard stop and start clean.");
        return;
      }
      q.interrupt(cmd.args, env.user, env.mediaPaths, env.identity);
      await reply.send("⛔ Interrupted — starting fresh on that.");
      return;
    }
    case "skip":
      await reply.send(q.cancelPending() ? "🗑️ Cleared the queued message(s)." : "Nothing queued.");
      return;
    case "help":
      await reply.send(HELP_TEXT);
      return;
    default:
      await reply.send(`Unknown command: /${cmd.name}. Try /help.`);
      return;
  }
}

/** Token-free probe of a remote agent runtime's /health (claude-code-http, k8s split):
 * did we reach it, is it healthy (200), and does it report a seeded credential. Never spends
 * model tokens (the agent's /health only stats the credential file + `claude --version`). */
async function probeRemoteHealth(url: string): Promise<{ ok: boolean; reachable: boolean; cred: boolean; detail: string }> {
  if (!url) return { ok: false, reachable: false, cred: false, detail: "no url configured" };
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(3000) });
    let cred = false;
    try {
      const j = (await r.json()) as { cred?: boolean };
      cred = !!j?.cred;
    } catch {
      /* non-JSON body */
    }
    return { ok: r.ok, reachable: true, cred, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, reachable: false, cred: false, detail: (e as Error).message };
  }
}

/** Adds an agent's substrate + liveness checks to the registry (A12). */
function registerAgentHealth(reg: health.Registry, ra: ResolvedAgent): void {
  const rec = ra.rec;

  // Remote agent (claude-code-http, k8s split): no local container — probe the agent runtime's
  // token-free HTTP /health, plus the gateway-side git-memory check. No podman/control checks.
  if (ra.spec.remote) {
    reg.add(async () => {
      const s: health.Service = { name: "runtime", kind: "agent", agent: rec.name, status: "unknown" };
      const probe = await probeRemoteHealth(ra.cfg.url ?? "");
      s.status = probe.ok ? "ok" : "down";
      s.detail = probe.reachable
        ? `${ra.cfg.url} ${probe.detail}${probe.cred ? "" : " — NO credential on PVC"}`
        : `${ra.cfg.url} unreachable: ${probe.detail}`;
      return s;
    });
    reg.add(async () => {
      const s: health.Service = { name: "memory", kind: "substrate", agent: rec.name, status: "down" };
      try {
        const st = await fs.stat(path.join(rec.memory_root, ".git"));
        if (st.isDirectory()) {
          s.status = "ok";
          s.detail = rec.memory_root;
        }
      } catch {
        s.detail = "no git repo at " + rec.memory_root;
      }
      return s;
    });
    return;
  }

  reg.add(async () => {
    const s: health.Service = { name: "container", kind: "agent", agent: rec.name, status: "unknown" };
    try {
      const running = await containerRunning(rec.container);
      s.status = running ? "ok" : "down";
      s.detail = `${rec.container} ${running ? "running" : "not running"}`;
    } catch (e) {
      s.detail = `${rec.container}: ${(e as Error).message}`;
    }
    return s;
  });

  // Service agent (svc-self-channeled): health is container-up + its PORT answers, never by
  // spending model tokens (health-no-tokens). It uses none of Tonoman's git-memory/control
  // substrate, so those checks don't apply.
  if (ra.spec.service || ra.cfg.service) {
    const hostPort = ra.cfg.port ?? ra.spec.servicePort;
    if (hostPort) {
      reg.add(async () => {
        const s: health.Service = { name: "port", kind: "agent", agent: rec.name, status: "unknown" };
        try {
          const r = await fetch(`http://127.0.0.1:${hostPort}/`, { signal: AbortSignal.timeout(3000) });
          s.status = "ok";
          s.detail = `:${hostPort} answered (${r.status})`;
        } catch (e) {
          s.status = "down";
          s.detail = `:${hostPort} no answer: ${(e as Error).message}`;
        }
        return s;
      });
    }
    return;
  }

  reg.add(async () => {
    const s: health.Service = { name: "memory", kind: "substrate", agent: rec.name, status: "down" };
    try {
      const st = await fs.stat(path.join(rec.memory_root, ".git"));
      if (st.isDirectory()) {
        s.status = "ok";
        s.detail = rec.memory_root;
      }
    } catch {
      s.detail = "no git repo at " + rec.memory_root;
    }
    return s;
  });

  reg.add(async () => {
    const dir = path.join(rec.memory_root, "control", "requests");
    const s: health.Service = { name: "control", kind: "substrate", agent: rec.name, status: "unknown" };
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) {
        s.status = "ok";
        s.detail = "watching " + dir;
      }
    } catch {
      s.detail = "no watch dir yet at " + dir;
    }
    return s;
  });
}

/** The host's primary LAN IPv4 to advertise for exposed services — the first
 * external IPv4 on a real adapter (skipping WSL/Hyper-V/virtual/loopback, which are
 * not reachable from another device). Falls back to localhost. Override via
 * `expose.advertise_host` in settings.json. */
export function detectAdvertiseHost(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/vEthernet|WSL|Hyper-V|Virtual|Loopback|Default Switch|Docker|VMware|VirtualBox/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "localhost";
}

/** Parses a podman `{{.Labels}}` field ("k1=v1,k2=v2") into an object. */
export function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of (s ?? "").split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

/** Lists the containers this agent may resolve/expose: running host containers with
 * their published ports, EXCLUDING the agent's own sandbox and any container owned by
 * a different agent (by the `tonoman.agent` ownership label). Unlabeled containers
 * (e.g. compose-created) are included for now — full ownership tightens once compose
 * containers also carry the label. */
function listAgentContainers(ownGuid: string, ownContainer: string): () => Promise<ContainerInfo[]> {
  return () =>
    new Promise((resolve) => {
      execFile("podman", ["ps", "--format", "{{.Names}}\t{{.Ports}}\t{{.Labels}}"], (err, stdout) => {
        if (err) return resolve([]);
        const out: ContainerInfo[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [name, ports, labels] = line.split("\t");
          if (!name || name === ownContainer) continue; // never the agent's own sandbox
          const lab = parseLabels(labels ?? "");
          const owner = lab["tonoman.agent"];
          if (owner && owner !== ownGuid) continue; // owned by another agent (A11 isolation)
          out.push({ name, ports: parsePorts(ports ?? ""), labels: lab });
        }
        resolve(out);
      });
    });
}

/** Builds the host port-forwarder for `tonoman expose`/`unexpose`: an in-process
 * reverse-proxy (devcontainerized-expose-url). `add` binds the advertised host
 * interface on the service's port and pipes to the loopback-published port; `remove`
 * closes it. Runs as the gateway user — NO admin, cross-platform — and is itself the
 * "single authenticated ingress" endgame. Binding the LAN IP (not 0.0.0.0) avoids
 * colliding with the existing 127.0.0.1:<port> publish. Throws with the real reason on
 * a bind failure so the agent reports an honest error, not false success. */
function makeForward(advertiseHost: string): (action: "add" | "remove", hostPort: number) => Promise<void> {
  const bind = advertiseHost === "localhost" ? "127.0.0.1" : advertiseHost;
  const handles = new Map<number, ProxyHandle>();
  return async (action, hostPort) => {
    if (action === "remove") {
      const h = handles.get(hostPort);
      if (h) {
        handles.delete(hostPort);
        await h.close();
      }
      return;
    }
    if (handles.has(hostPort)) return; // already exposed
    try {
      handles.set(hostPort, await tcpProxy(bind, hostPort, "127.0.0.1", hostPort));
    } catch (e) {
      throw new Error(`could not bind ${bind}:${hostPort} — ${(e as Error).message}`);
    }
  };
}

/** Runs a command and resolves true iff it exits 0 within the timeout (for the deterministic
 * /health checks — bounded so a hung broker/agent fails fast). */
function execOk(cmd: string, args: string[], timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err) => resolve(!err)));
}

/** Whether a podman container is running. A missing container / inspect error is
 * surfaced (never treated as running). */
function containerRunning(name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile("podman", ["inspect", "-f", "{{.State.Running}}", name], (err, stdout) => {
      if (err) reject(new Error("inspect failed"));
      else resolve(stdout.trim() === "true");
    });
  });
}

/** Where the instance registry lives: <state_root>/agents.json, or alongside the
 * agent's memory when no state root is configured (legacy layout). */
function registryPath(cfg: Config): string {
  if (cfg.state_root) return path.join(cfg.state_root, "agents.json");
  if (cfg.agents.length > 0 && cfg.agents[0].workspace?.root) return path.join(cfg.agents[0].workspace.root!, "agents.json");
  return "agents.json";
}

/** `auth status` for a REMOTE agent — asked over its own runtime (roster-auth-remote). */
async function remoteAuthStatus(url: string, token: string | undefined): Promise<string> {
  if (!url) throw new Error("remote agent has no \"url\" in the roster");
  const res = await fetch(`${url.replace(/\/$/, "")}/auth/status`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`agent runtime said ${res.status}`);
  const body = (await res.json()) as { status?: string; loggedIn?: boolean };
  return (body.status || "").trim() || (body.loggedIn ? "logged in" : "NOT logged in");
}

/** Runs an agent's harness auth flow through the substrate — backend for
 * `tonoman auth login|status|logout <agent>`. stdio is inherited so the
 * interactive login (URL + code paste) works in the operator's terminal. */
export async function auth(action: string, agentName: string, cfg: Config): Promise<void> {
  const reg = defaultHarnesses();
  const ac = cfg.agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
  if (!ac) {
    const names = cfg.agents.map((a) => a.name).join(", ");
    throw new Error(`no agent named "${agentName}" in the roster (available: ${names})`);
  }
  const spec = reg.lookup(ac.harness ?? "");
  if (!spec) throw new Error(`agent "${ac.name}" has unknown harness "${ac.harness}"`);
  // A service harness authenticates via injected env (svc-config-env), not an interactive
  // login — it defines no login/status/logout commands.
  if (spec.service) {
    throw new Error(`agent "${ac.name}" runs the service harness "${ac.harness}" (auth is injected env, svc-config-env) — no "${action}" flow`);
  }

  let inner: string[] | undefined;
  let interactive = false;
  switch (action) {
    case "login":
      inner = spec.loginArgs;
      interactive = true;
      break;
    case "status":
      inner = spec.statusArgs;
      break;
    case "logout":
      inner = spec.logoutArgs;
      break;
    default:
      throw new Error(`unknown action "${action}" (use: login | status | logout)`);
  }
  if (!inner || inner.length === 0) throw new Error(`harness "${ac.harness}" defines no "${action}" command`);

  // A REMOTE agent (k8s split) has no container to exec into (roster-auth-remote). Its login runs
  // over its own /auth/* endpoints — reachable only from the gateway's network, and with no TTY to
  // paste a code into, so the headless flow is the ONLY flow. Say so instead of failing on a
  // `podman exec` against container=undefined.
  if (spec.remote) {
    if (action === "status") {
      const st = await remoteAuthStatus(ac.url ?? "", process.env.AGENT_RUNTIME_TOKEN);
      process.stdout.write(st + "\n");
      return;
    }
    throw new Error(
      `agent "${ac.name}" is remote (${ac.harness}) — there's no local container to log into.\n` +
        `Use the headless flow (it works across the split):\n  tonoman auth login ${ac.name} --headless\n  tonoman auth code ${ac.name} <CODE>`,
    );
  }

  const args = ["exec"];
  if (interactive) args.push("-it"); // login needs a TTY for the code paste
  args.push(ac.container, ...inner);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("podman", args, { stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => {
      // `claude auth status` exits non-zero when logged out; that's information.
      if (action === "status" || code === 0) resolve();
      else reject(new Error(`tonoman auth ${action}: podman exited ${code}`));
    });
  });
}
