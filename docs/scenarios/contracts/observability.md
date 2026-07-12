[[_TOC_]]

# Track: observability — harness-neutral tracing + usage as a product capability

You can't run a fleet of agents blind. tonoman must let an operator **see what every agent did** (the
prompt, the tool calls, the reply), **what it cost** (tokens/model/latency), and **why it's bloated**
(too many skills? an expensive model on a cheap task? a fat system prompt?). This is a **product**
concern, not a per-image hack — and it must be **harness-neutral**: Claude Code today, Codex/OpenCode
tomorrow. tonoman owns the **sink** (where traces go) and the **boot-time wiring**; each harness plug
declares only *how its runtime emits telemetry* (see [`../../observability-adapters.md`](../../observability-adapters.md)).

> **Run:** `npm test` → observability unit/contract tests (neutral trace mapping, sink config, each
> adapter's registration). **FREE** — spends no tokens. Live proof rides the roster/live track.
> Index: [`README.md`](README.md)

> **Architecture:** [§ A2 harness plug](../../architecture.md#a2--claude-code-harness--headless-oauth) ·
> [§ A12 observability]. Scenarios state behavior only.

---

## Harness-neutral observability — SPEC

### `obs-sink-config` — the trace sink is ONE tonoman config, off by default
- Given an operator wants agents' turns traced to a sink (e.g. self-hosted Langfuse),
- Then the sink is configured **once at the tonoman level** (endpoint + keys), applied to every agent —
  **not** per-agent secrets or per-image env. With **no sink configured, tracing is OFF** and adds zero
  cost/behavior (a turn runs identically).
- The sink lives in the **customer domain** (the enterprise profile never egresses traces to a third
  party) — an in-cluster Langfuse over cluster DNS, no external hop.
- _Arch: A12 (one sink, many agents)._

### `obs-runtime-registers` — the RUNTIME wires telemetry on boot (no initContainer, no baked hook)
- Given a sink is configured and the agent's harness declares a telemetry adapter,
- When the agent runtime starts, it **registers that adapter itself** (writes the runtime's hook config,
  or the plugin config, or sets OTEL env) **before the first turn** — the tonoman runtime owns the
  wiring because it owns the harness process.
- **No separate initContainer and no per-image baked hook** — those couple the image tag to the pod
  spec and are exactly what broke a deploy. Registration is idempotent (safe on every boot) and a
  no-op when tracing is off.
- _Arch: A2 (runtime owns its harness), A12._

### `obs-trace-neutral` — every turn emits ONE harness-neutral trace
- Given tracing is on,
- When a turn completes, exactly **one trace** is emitted in a **harness-neutral model**:
  `{ agent, session, user, backend, model, tokens{input,output,cache_read,cache_creation}, tools[]
  (name + input + output), skills[], cost, latency, prompt, reply }`.
- The **same model regardless of runtime**, so one dashboard answers the fleet questions across Claude
  Code / Codex / OpenCode: **cost per agent/user**, **skill count**, **expensive-model-on-cheap-task**,
  **prompt/identity bloat** (the cache-creation blob), **abuse** (aggregate by user).
- _Arch: A12._

### `obs-adapter-hook` — the `hook` adapter: post-turn hook → transcript → neutral trace
- Given a harness whose telemetry `kind` is **`hook`** (Claude Code, Codex),
- Then registration writes a **post-turn hook command** into that runtime's settings (Claude Code:
  `settings.json` `hooks.Stop`; Codex: `~/.codex` config), and a **transcript decoder** maps that
  runtime's session transcript (Claude Code `.jsonl`; Codex rollout) into the neutral trace.
- **Claude Code and Codex share this adapter kind** — only the registration path + transcript format
  differ, supplied per-harness; the decode → neutral-trace → sink pipeline is identical.
- _Arch: A2, A12._

### `obs-adapter-plugin` — the `plugin` adapter: enable the runtime's own plugin/OTEL
- Given a harness whose telemetry `kind` is **`plugin`** (OpenCode),
- Then registration **merges the plugin + its flag into the runtime's config** (e.g. `opencode.json`
  `experimental.openTelemetry: true` + the plugin in the `plugins` array); the runtime's plugin does
  the export. tonoman writes config, not code.
- _Arch: A2, A12._

### `obs-adapter-otel` — the `otel` adapter: point the runtime's OTLP exporter at the sink
- Given a harness whose telemetry `kind` is **`otel`** (any OTEL-native runtime),
- Then registration is **just env** — set the runtime's `OTEL_EXPORTER_OTLP_ENDPOINT` at the sink's
  OTLP endpoint (Langfuse `/api/public/otel`) + auth header. No hook, no plugin. The future-proof path.
- _Arch: A12._

### `obs-sink-mapping` — one sink config maps onto each runtime's env-name quirks
- Given the single sink config (public key, secret key, base URL),
- Then each adapter maps it to **that runtime's expected env names**, normalizing quirks (e.g.
  `LANGFUSE_BASE_URL` for Claude Code/Codex vs `LANGFUSE_BASEURL` for OpenCode) — the operator sets it
  once; tonoman adapts.
- _Arch: A12._

### `obs-nonfatal` — telemetry is best-effort and never costs a turn
- Given tracing is on and the sink is unreachable or a trace fails to serialize,
- Then the **turn still completes and commits** — telemetry is fire-and-forget, failures are logged,
  never surfaced to the user and never abort the turn. (A flaky sink must not cost work.)
- _Arch: A12 (observability is a side-channel, A4-style resilience)._

### `obs-zero-dep` — tonoman's `hook` implementation is plain Node, zero-dep
- Given the `hook` adapter for a Node-based runtime (Claude Code),
- Then tonoman ships its **own** transcript→trace hook as **plain Node** posting to the sink's ingestion
  API via `fetch` — **no Python, no vendor SDK, no extra image dependency** (matching tonoman's zero-dep
  plain-JS principle). This replaces the tactical Atlas hook (python + Langfuse SDK + initContainer).
- _Arch: A2 (ships plain JS, zero runtime deps)._

### `obs-harness-neutral` — a second harness proves the interface, not a Claude-Code special case
- Given the telemetry interface,
- Then adding tracing for a **second runtime** (Codex or OpenCode) is **one `Spec.telemetry`
  declaration** (kind + registration + decoder) and **zero changes** to the sink, the neutral trace
  model, or the runtime-registration flow — proving the seam is harness-neutral, not Claude-Code-shaped.
- _Arch: A11 (harness-neutral roster), A12._
