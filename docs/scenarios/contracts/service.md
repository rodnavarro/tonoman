[[_TOC_]]

# Track: service — self-channeled service agents (Tonoman boots it; the agent runs its own loop)

Tonoman "**does not own the loop**" (README). The gateway track is the case where Tonoman *drives*
a harness turn-by-turn over a Tonoman connector. This track is the **limit case**: a **service
agent** whose harness runs a **long-lived server that owns its own channel**. Tonoman still
**provisions, boots, lifecycle-manages, and configures** it — everything **except** the turn loop.
This makes a self-channeled agent a **repeatable, declared unit** an operator stands up from config,
exactly like any other agent.

> **Run:** `npm test` → service-mode `podmanRunArgs` units (long-lived boot, env/secrets injection,
> no connector attached). The concrete backend + its real boot are
> [`backend-hermes.md`](backend-hermes.md) / [`../live/hermes-service.md`](../live/hermes-service.md).
> Index: [`README.md`](README.md)

> **Architecture (the how):** [§ A11 Agent roster, identity & config plug](../../architecture.md#a11--agent-roster-identity--config-plug) ·
> [§ A1 Messaging gateway (harness-neutral)](../../architecture.md#a1--messaging-gateway-harness-neutral).
> Scenarios state behavior only.

---

## Self-channeled service agents — DONE (implemented; units in `provision.test.ts`, real boot in [`hermes-live`](../live/hermes-service.md))

### `svc-self-channeled` — Tonoman boots + lifecycle-manages; it does NOT drive the loop — DONE
- An agent may declare **service mode** (e.g. `service: true` / `channel: "self"`). Instead of the
  gateway driving turns (per-message `exec` over a Tonoman connector), Tonoman **boots a long-lived
  agent process** whose **image command runs the agent's own server**, and the agent **owns its own
  channel**.
- For a service agent Tonoman **does not attach** the gateway turn-loop, router, or a Tonoman
  connector. It still does **everything else**: provision (`roster-provision`), **boot** (`up` =
  start, adopt-safe; `down` = stop; `stop`≠`rm`, volumes persist), mount config/identity/memory,
  inject config (`svc-config-env`), and install declared tools at boot (`cfg-agent-tools`).
- **Health without tokens** (`health-no-tokens`): a service agent is healthy when its **container is
  up and its port answers** — never by spending model tokens.
- _Rationale: harness-neutrality taken to its limit — Tonoman runs the agent, the agent runs the
  conversation. Arch: A1 (gateway opt-out), A11 (provision/lifecycle)._

### `svc-config-env` — Process config + secrets injected at boot — DONE
- A service agent's runtime config is its **process env**, injected from the roster at boot: non-secret
  settings (any runtime config the server reads) and **secrets** (channel/model credentials). Tonoman
  passes a declared **`env` / `secrets` map** into `podman run` (`-e`).
- **No secret in the roster file** (`cfg-no-secrets`): secret values are **sourced from the
  environment at run**, never written to `settings.json` or memory; non-secret config may live in the
  roster. (Generalizes how the Telegram token is supplied today to an arbitrary env map.)
- Distinct from the opaque **config volume** (harness state): a self-channeled server is configured
  primarily by **env + mounted identity/skills**; declared CLI tools are installed at boot via the
  existing **`cfg-agent-tools`** `setup` list.
- _Arch: A11, `cfg-no-secrets`, `cfg-agent-tools`._

---

> The first concrete service backend (the **Hermes** runtime) and the real-container boot proof are in
> [`backend-hermes.md`](backend-hermes.md). A service agent's *own* channel — identity, threading — is
> the **harness's** concern, proven where that harness is configured, not by Tonoman.
