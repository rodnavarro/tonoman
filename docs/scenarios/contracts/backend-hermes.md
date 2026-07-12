[[_TOC_]]

# Track: backend-hermes — the Hermes runtime as a service backend

The first concrete **service-mode** backend (`svc-self-channeled`): the **Hermes** harness, which runs
a **long-lived server** and **speaks its own chat channel**. As with every harness, adding it is **one
spec implementation** — the gateway, router, and memory are unchanged (`roster-generic-contract`); the
only new dimension is the service-mode opt-out from the turn loop ([`service.md`](service.md)).

> **Run:** `npm test` → the hermes harness-spec unit. The real boot is the live journey
> [`hermes-live`](../live/hermes-service.md). Index: [`README.md`](README.md)

> **Architecture (the how):** [§ A11 roster / config plug](../../architecture.md#a11--agent-roster-identity--config-plug) ·
> [§ A2 Harness & brain auth](../../architecture.md#a2--claude-code-harness--headless-oauth). Scenarios state behavior only.

---

## The Hermes service backend — DONE (implemented: `src/harness/hermes.ts` + `images/hermes`; real boot in [`hermes-live`](../live/hermes-service.md))

### `hermes-backend` — Hermes harness spec (service-mode) — DONE
- Hermes registers as a **harness peer** (alongside `claude-code`/`codex`, `roster-generic-contract`)
  whose **spec marks it service-mode** (`svc-self-channeled`): image **`tonoman/hermes`** (Tonoman
  ships `images/hermes`, built from `images/base`), the container command runs the **Hermes server**,
  config-home = Hermes's data dir.
- **No interactive OAuth login flow.** Hermes authenticates its model via **injected env**
  (`svc-config-env`) — region + credentials + model id — so `--login`/`--from` are **not required**;
  auth is configuration, not a credential-store dance. (`roster-auth-*` remain the contract for
  login-style harnesses.)
- Adding hermes touches **only** its spec + the service-mode path; gateway/router/memory are unchanged.
- _Arch: A11, A2._

---

> Real-container proof that a hermes service agent boots (long-lived, declared CLI installed, healthy on
> its port, clean teardown): [`hermes-live`](../live/hermes-service.md).
