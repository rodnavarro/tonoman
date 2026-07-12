// The small, harness-specific spec that lets the generic agent roster stay
// harness-neutral (A11). The generic contract — roster, GUID identity, registry,
// memory, connector — is identical across harnesses. A harness plugs in by
// supplying only what differs: where it keeps state inside the sandbox (so Tonoman
// knows where to bind-mount the config volume) and how to build its turn-runner.

import type { TurnRunner } from "./core/contracts";
import type { Sink } from "./telemetry";

/** How a harness's runtime emits telemetry (obs-adapter-*). The SINK + boot-time wiring are tonoman's
 * job; a harness plug declares only its `kind` + how to register the adapter into the runtime's config.
 * Adding a new runtime's tracing is ONE `telemetry` declaration (obs-harness-neutral):
 *   - "hook":   register a post-turn hook + decode a transcript → neutral trace (Claude Code, Codex).
 *   - "plugin": enable the runtime's own plugin/OTEL in its config (OpenCode).
 *   - "otel":   point the runtime's OTLP exporter at the sink — env only (any OTEL-native runtime). */
export interface TelemetrySpec {
  kind: "hook" | "plugin" | "otel";
  /** Wire this runtime's telemetry for `sink` into its config at `configDir` (idempotent, best-effort).
   * `cliPath` is this tonoman build's entry, so a `hook` adapter points the hook at tonoman itself. */
  register(ctx: { configDir: string; cliPath: string; sink: Sink }): Promise<void> | void;
}

/** Per-agent inputs a harness needs to build its turn-runner. */
export interface RunnerParams {
  container: string;
  model?: string;
  maxTurns?: number; // cap the harness's internal agentic loop (claude-code --max-turns)
  /** base URL of a REMOTE agent runtime (claude-code-http): the gateway drives turns over
   * HTTP instead of `podman exec`. Ignored by local (podman) harnesses. */
  url?: string;
  /** initial auth backend (backend-*): "subscription" | "bedrock". The gateway's backend knob
   * flips it live thereafter. */
  backend?: "subscription" | "bedrock";
}

/** Inputs for an EPHEMERAL turn-runner (gw-command-btw): a throwaway sandbox spun from
 * the harness image that inherits a live agent's mounts (credential + identity + skills)
 * via `--volumes-from` and is torn down after one turn. Harness-generic primitive. */
export interface EphemeralParams {
  /** the live caller container whose mounts (config volume incl. credential, identity,
   * skills) the throwaway sandbox inherits — the credential stays a single source of truth. */
  volumesFrom: string;
  /** the harness image to run the throwaway sandbox from. */
  image: string;
  /** harness env to set so config resolves to the shared volume (e.g. CLAUDE_CONFIG_DIR). */
  env?: Record<string, string>;
  /** model for the aside turn (usually the agent's current model). */
  model?: string;
}

/** Everything harness-specific the roster needs (A11). Declarative so the registry
 * is trivially testable and a fake harness can prove the roster is harness-neutral. */
export interface Spec {
  /** config key for this harness, e.g. "claude-code". */
  kind: string;
  /** the Tonoman-owned, PER-RUNTIME sandbox image for this harness (A11) — built from
   * images/<runtime>/ in the repo, e.g. "tonoman/claudecode". The image is per-harness,
   * not per-agent: every agent of this harness runs the same image and differs only in
   * its per-agent identity + skills. */
  image: string;
  /** where this harness keeps state inside the sandbox; the config volume is
   * bind-mounted here (A11). e.g. "/root/.claude" for Claude Code. */
  configHome: string;
  /** where the per-agent identity dir (AGENTS.md/persona) bind-mounts READ-ONLY, e.g.
   * "/root/agent" for Claude Code (consumed via --append-system-prompt-file, A2). */
  identityHome: string;
  /** harness-specific environment to set on the sandbox at `podman run` time, e.g.
   * Claude Code's `CLAUDE_CONFIG_DIR=/root/.claude` so ALL its state (incl. the sibling
   * profile) stays in the config volume and survives a recreate. Optional. */
  runEnv?: Record<string, string>;
  // --- Service-mode (svc-self-channeled / backend-hermes) ----------------------
  /** Service harness: Tonoman boots a LONG-LIVED server that owns its own channel and
   * does NOT drive turns. When true the gateway attaches no turn-loop/router/connector;
   * provisioning runs `serviceCommand` instead of `sleep infinity`, and `newRunner`/
   * `loginArgs`/… are not required (auth is env, svc-config-env). */
  service?: boolean;
  /** the container command a service harness boots (e.g. `["gateway"]`). The image's own
   * ENTRYPOINT wraps it; for a non-service harness Tonoman runs `sleep infinity` instead. */
  serviceCommand?: string[];
  /** the in-container port a service harness listens on; published to the host and used for
   * the token-free health probe (health-no-tokens). */
  servicePort?: number;
  /** builds the turn-runner for an agent of this harness. Omitted by service harnesses
   * (Tonoman does not drive their turns). */
  newRunner?(p: RunnerParams): TurnRunner;
  /** builds an EPHEMERAL turn-runner for an out-of-band aside (gw-command-btw): each turn
   * spins a throwaway sandbox (`podman run --rm --volumes-from`) and tears it down. Optional
   * — a harness that omits it simply has no `/btw` aside capability. */
  newEphemeralRunner?(p: EphemeralParams): TurnRunner;
  /** in-sandbox interactive login (writes the credential store into configHome). Omitted by
   * service harnesses (auth is injected env, svc-config-env — no login dance). */
  loginArgs?: string[];
  /** in-sandbox auth status (non-interactive). Omitted by service harnesses. */
  statusArgs?: string[];
  /** in-sandbox logout (clears the credential store). Omitted by service harnesses. */
  logoutArgs?: string[];
  /** absolute path (in the sandbox) of the credential file a login writes — lets a headless
   * login VERIFY by the file actually changing (outcome-true), not just by `auth status`. */
  credFile?: string;
  /** Remote harness (k8s split): the agent runs in ANOTHER runtime and is driven over HTTP
   * (claude-code-http), so this gateway owns none of its podman lifecycle. When true the gateway
   * skips container bring-up/teardown and the co-located broker substrate, and health/`/health`
   * probe the agent's HTTP endpoint instead of `podman`. Auth is a pod-side op (no login flow). */
  remote?: boolean;
  /** How this harness's runtime emits telemetry (obs-*). The runtime registers it on boot when a sink
   * is configured. Omitted → the harness has no tracing adapter yet. */
  telemetry?: TelemetrySpec;
}

/** Maps a harness kind to its spec. */
export class Registry {
  private specs = new Map<string, Spec>();

  add(s: Spec): this {
    this.specs.set(s.kind, s);
    return this;
  }

  lookup(kind: string): Spec | undefined {
    return this.specs.get(kind);
  }
}
