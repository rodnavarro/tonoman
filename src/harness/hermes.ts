// The Hermes harness plug (backend-hermes) — the first SERVICE-mode backend
// (svc-self-channeled). Unlike a turn-driven harness (claude-code), Hermes runs a
// LONG-LIVED server that speaks its own chat channel (its own Teams/Bot-Framework loop),
// so Tonoman boots + lifecycle-manages + configures it but does NOT drive its turns:
// there is no turn-runner, and auth is injected env (svc-config-env), not an interactive
// login. Adding it is one spec — the gateway/router/memory are unchanged.

import type { Spec } from "../harness";

/** The harness key used in agent config. */
export const KIND = "hermes";

/** The Tonoman-owned per-runtime image (A11), built from images/hermes/ in the repo
 * (FROM the Hermes agent image, which already carries node/npm/git + the hermes venv +
 * the bootstrap entrypoint). Fully qualified with `localhost/` so podman resolves the
 * locally-built image without a short-name prompt; published images swap the prefix. */
export const IMAGE = "localhost/tonoman/hermes:latest";

/** Where Hermes keeps ALL its persistent state inside the sandbox (HERMES_HOME): config.yaml,
 * SOUL.md, skills, sessions, auth.json, memories. The config volume bind-mounts here, so a
 * destroy+recreate comes back fully configured (A11). This is also Hermes' "memory" — a
 * service agent does not use Tonoman's git-memory/control substrate. */
export const CONFIG_HOME = "/opt/data";

/** Where the per-agent identity dir bind-mounts READ-ONLY. Phase C wires the role-aware
 * SOUL/persona from here; kept distinct from CONFIG_HOME so the two mounts never collide. */
export const IDENTITY_HOME = "/opt/identity";

/** The in-container port Hermes' dashboard binds (a long-lived HTTP server that comes up
 * WITHOUT model/Teams credentials) — Tonoman publishes it and uses it for the token-free
 * health probe (health-no-tokens). The Teams webhook listener is a separate concern wired
 * in Phase D; liveness here never spends model tokens. */
export const SERVICE_PORT = 9119;

/** The Hermes harness plug for the roster registry (A11), in SERVICE mode. */
export function spec(): Spec {
  return {
    kind: KIND,
    image: IMAGE,
    configHome: CONFIG_HOME,
    identityHome: IDENTITY_HOME,
    service: true,
    // The image ENTRYPOINT wraps this → `hermes gateway` (messaging platforms + cron). It
    // stays up with no creds (it just can't *answer* until Teams/Bedrock are configured).
    serviceCommand: ["gateway"],
    servicePort: SERVICE_PORT,
    // Bring the dashboard up (a creds-free long-lived HTTP server) so a port always answers
    // the health probe, independent of whether the messaging/model creds are present yet.
    runEnv: {
      HERMES_DASHBOARD: "1",
      HERMES_DASHBOARD_HOST: "0.0.0.0",
      HERMES_DASHBOARD_PORT: String(SERVICE_PORT),
    },
    // No newRunner / loginArgs / statusArgs / logoutArgs: Tonoman does not drive Hermes'
    // turns, and Hermes authenticates its model/channel via injected env (svc-config-env).
  };
}
