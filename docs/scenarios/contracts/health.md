[[_TOC_]]

# Track: health — service health & observability

Tonoman runs **substrate services** that aren't containers (tunnels, the control
channel, per-agent memory) plus the **agents** themselves. Operators need one
place to see they're healthy. Cheap to verify — **unit tests + a no-LLM live
probe** (health checks never spend tokens, `health-no-tokens`).

> **Run:** `npm test` → the health unit suite + live `tonoman get services` · **free** (zero inference).
> Index: [`README.md`](README.md)

> **Architecture (the how):** [§ A12 Service health & observability](../../architecture.md#a12--service-health--observability) ·
> [§ A8 On-demand tunnels](../../architecture.md#a8--on-demand-tunnels-via-a-substrate-control-api) ·
> [§ A11 Agent roster](../../architecture.md#a11--agent-roster-identity--config-plug).
> Scenarios state behavior only.

---

## Service health (`tonoman get services`) — DONE

### `health-list` — One command lists every service's health
- **`tonoman get services`** prints a table of every running service with a **status**
  (ok / degraded / down / unknown) and a short detail. It covers **substrate
  services** — tunnels (A8), the control channel (A8), per-agent memory (A3) — and
  each **agent** (container liveness), so non-container services are finally visible.
- _Arch: A12._

### `health-live-api` — Health comes from a live API the gateway serves
- The running gateway exposes a small **local HTTP health API**; `tonoman get services`
  is a **thin client** that queries it and renders the result. The API is one
  resource with multiple services in it (simple, not a service-per-endpoint sprawl).
- If the gateway isn't running, the command says so clearly (it doesn't hang or
  print stale data).
- _Arch: A12._

### `health-autoregister` — Adding a service makes it show up
- Services register themselves with the health registry, so a **newly added
  substrate service appears in `tonoman get services` automatically** — no change to the
  command. (Skills are files today, not a running service, so they're out of scope
  here; they surface via the agent's loaded-skills, not as a health line.)
- _Arch: A12._

### `health-no-tokens` — Health checks never spend LLM tokens
- A health check is a **pure OS/process probe** — it never drives a turn or calls the
  model. Running `tonoman get services` any number of times costs **zero** inference, and
  an **idle agent accrues no subscription cost** (nothing periodic touches the LLM;
  tokens are spent only by an inbound user message).
- _Arch: A12 (hard invariant)._
