[[_TOC_]]

# Track: backend — pluggable auth backend (Claude subscription ⇄ AWS Bedrock), live-switchable

An agent's **brain auth backend** is a first-class, **switchable** knob: the Claude **subscription**
(OAuth, cheap — the dev default) or **AWS Bedrock** (inference in the customer's own AWS account —
Bedrock does not train on or retain it, so it is the **privacy-credible** prod default). The operator
flips it **live** while the agent runs, effect **next turn** — the same next-turn-switch shape as
[`gw-command-model`](gateway.md). It is **operator-only** (a control-plane action, never a channel
command) so a customer cannot silently route inference to Anthropic. The change is **ephemeral** — on
restart the agent reverts to the **declared default** (durable change = a GitOps PR); this keeps the
running state honest with git.

The backend is **just an environment toggle** on the spawned `claude`: `CLAUDE_CODE_USE_BEDROCK=1` (+
`AWS_REGION`, `ANTHROPIC_MODEL`, AWS SigV4 keys) for Bedrock; absent for subscription (OAuth resolves
from the config dir). Both credential sets live alongside the agent so either is selectable per turn.

> **Run:** `npm test` → backend unit/contract tests (config validate, gateway backend knob, HttpRunner
> body, runtime env delta). **FREE** — spends no tokens. Live Bedrock proof rides the `roster`/live track.
> Index: [`README.md`](README.md)

> **Architecture:** [§ A2 Claude Code harness](../../architecture.md#a2--claude-code-harness--headless-oauth) ·
> [§ A10 command dispatch](../../architecture.md#a10--command-dispatch) · [§ A12 observability].
> Scenarios state behavior only.

---

## Pluggable auth backend — SPEC

### `backend-config-default` — the auth backend is a per-agent config field
- Given an agent's roster config, the **auth backend** is a field `auth: subscription | bedrock`
  (`cfg-per-agent`, like `model`), **default `subscription`**; a Bedrock agent also carries `region`
  and a `bedrock_model` (e.g. `us.anthropic.claude-sonnet-4-6`).
- When the agent boots, it runs on its **configured backend** — no flag flips it implicitly.
- **Validated** at load: `auth: bedrock` **requires** `region` (a Bedrock agent with no region is a
  config error caught at startup, not a cryptic failed turn). Unknown `auth` values are rejected.
- In production the roster/helm default is **`bedrock`** (the privacy posture); dev is `subscription`.
- _Arch: A2 (per-agent config), mirrors `cfg-per-agent`._

### `backend-switch-live` — `tonoman backend <agent> <mode>` flips the backend, effect next turn
- Given an agent running on its current backend,
- When the operator runs **`tonoman backend <agent> bedrock`** (or `subscription`),
- Then the gateway does **not** run a turn; it records a **backend override** that takes effect on the
  **next** turn. A turn **already running is unaffected** (finishes on the backend it began with) —
  the same guarantee as `gw-command-model`. The command **acks** old → new and states **"takes effect
  next turn."**
- **`tonoman backend <agent>`** with no mode **reports** the current effective backend (+ the
  configured default). An invalid mode is **rejected immediately** with the valid options.
- _Arch: A10 (control-plane command), A2 (backend evaluated per turn)._

### `backend-bedrock-turn` — a Bedrock turn runs entirely on AWS (the privacy promise)
- Given the effective backend is **bedrock**,
- When a turn runs, the spawned `claude` is given **`CLAUDE_CODE_USE_BEDROCK=1`**, **`AWS_REGION`**,
  **`ANTHROPIC_MODEL`** (the configured `bedrock_model`), and authenticates with the **AWS SigV4
  keys** present in the agent's environment (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) — **not** the
  subscription OAuth, and **never** an `ANTHROPIC_API_KEY` (the harness keeps that unset).
- Then inference goes to **`bedrock-runtime.<region>.amazonaws.com`** (the customer's AWS account) —
  **no call to Anthropic's API**. This is what makes "no data/training to Anthropic" true for prod.
- The roster `model` is left unset for a Bedrock agent so `--model` does not shadow `ANTHROPIC_MODEL`.
- _Arch: A2 (harness env passthrough — the local-exec spawn merges the backend env delta)._

### `backend-subscription-turn` — a subscription turn runs on the OAuth brain
- Given the effective backend is **subscription**,
- When a turn runs, the spawned `claude` has **`CLAUDE_CODE_USE_BEDROCK` unset** and authenticates via
  the **subscription OAuth** credential in the config dir (`CLAUDE_CONFIG_DIR`); any AWS keys present
  sit **inert** (ignored without the Bedrock flag).
- Then it behaves exactly as today's subscription agent (the dev default).
- _Arch: A2._

### `backend-restart-reverts` — the live switch is ephemeral; restart = the declared default
- Given an operator has flipped an agent's backend live,
- When the **gateway or agent restarts**,
- Then the agent comes back on its **declared default backend** (the roster/helm `auth` value passed by
  the deployment) — the live override is **in-memory only**, not persisted. A **durable** default
  change is a **GitOps PR** to the roster/values. (Same lifetime shape as `gw-command-model`'s override:
  survives a `/new`, resets on restart.)
- _Arch: A10, keeps running state reconcilable with git (GitOps-honest)._

### `backend-operator-only` — the switch is a control-plane action, never a channel command
- Given the privacy posture depends on the backend, a **customer must not be able to change it**,
- When the switch is invoked, it is reachable **only** via the gateway's **loopback control API**
  (`POST /backend` on `health_addr`, the same in-process endpoint `tonoman down` uses) — reachable by
  an **operator** (locally, or in the cluster via `kubectl exec` into the gateway pod), **never as a
  chat/channel command**. A Teams/Telegram user typing `/backend` gets no effect (it is not a
  registered channel command).
- **Privacy sub-note:** a deployment MAY provision **Bedrock-only** (omit the OAuth credential
  entirely) for a hard guarantee that no operator can route to Anthropic; the default demo deployment
  ships **both** credential sets so the live switch is demonstrable, with **bedrock as the default**.
- _Arch: A10 (control-plane vs channel command boundary), A12._

---

## Mechanism (arch note, not contract)
The gateway holds a **mutable per-agent `backend`** (mirrors the `ModelControl` knob — `gateway.ts`),
default from the roster `auth`. `tonoman backend` POSTs to the loopback control API which sets it. On
each turn the gateway **snapshots `backend` into the `/turn` request body** (exactly how `model` is
snapshotted — `httpRunner.ts`); the **agent runtime** (`server.ts`) reads it and builds a **per-turn
env delta** (bedrock: set the Bedrock vars; subscription: ensure `CLAUDE_CODE_USE_BEDROCK` is unset)
merged into the local-exec spawn env (`claudecode.ts`). AWS keys + OAuth creds both live in the pod
(k8s: secret + PVC; local Dev path: `agent.env`/`agent.secrets`), so only `CLAUDE_CODE_USE_BEDROCK`
(+model) toggles per turn. Observability (`gw-command-statusline`) already shows the model the turn
actually ran, so the effective backend is visible in usage.
