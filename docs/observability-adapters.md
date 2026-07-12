# Observability adapters — how each runtime emits traces (research)

Observability is a **harness-neutral tonoman product capability** (not a per-image hack). tonoman owns
the **sink** (where traces go, e.g. self-hosted Langfuse) and the **boot-time wiring**; each harness
plug (`Spec`) contributes only *how its runtime emits telemetry*. This note captures how the current
CLI-agent runtimes integrate with Langfuse, so the `Spec.telemetry` interface covers all of them.

## What each runtime does today (Langfuse, 2026-07)

| Runtime | Adapter **kind** | Where tonoman wires it | Source it reads | Sink env |
|---------|------------------|------------------------|-----------------|----------|
| **Claude Code** | `hook` — a **Stop hook** → transcript → Langfuse | `settings.json` `hooks.Stop` (in `CLAUDE_CONFIG_DIR`) | the `.jsonl` session transcript | `TRACE_TO_LANGFUSE`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` |
| **OpenAI Codex** | `hook` — a **Stop hook** → transcript → Langfuse | `~/.codex/langfuse.json` or env | the **rollout** session file | same `TRACE_TO_LANGFUSE` + `LANGFUSE_*` |
| **OpenCode** | `plugin` — a plugin over the runtime's **native OTEL** | `opencode.json`: `experimental.openTelemetry: true` + plugin in the `plugins` array | OpenCode's OTEL event stream | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASEURL` (note: no `_`) |
| **(any OTEL-native runtime)** | `otel` — point its OTLP exporter at Langfuse | the runtime's `OTEL_*` env | native OTEL spans | `OTEL_EXPORTER_OTLP_ENDPOINT` → Langfuse `/api/public/otel`, `OTEL_EXPORTER_OTLP_HEADERS` = Basic auth |

Sources: Langfuse integration docs for
[Claude Code](https://langfuse.com/integrations/developer-tools/claude-code),
[Codex](https://langfuse.com/integrations/developer-tools/codex),
[OpenCode](https://langfuse.com/integrations/developer-tools/opencode), and the native
[OpenTelemetry](https://langfuse.com/integrations/native/opentelemetry) endpoint.

## The three adapter KINDS (all tonoman needs to model)

1. **`hook`** — register a post-turn hook command + parse a session transcript into the neutral trace.
   **Claude Code and Codex are the SAME shape** — only the config location and the transcript format
   differ, so one adapter kind covers both (each supplies its registration path + a transcript decoder).
2. **`plugin`** — flip a flag and add a plugin in the runtime's own config file (OpenCode). tonoman
   writes/merges that config; the plugin does the export.
3. **`otel`** — the runtime already speaks OpenTelemetry; tonoman just sets `OTEL_*` env to point at
   Langfuse's OTLP endpoint. The most future-proof path — no code, no plugin, as runtimes adopt OTEL.

## What this means for `Spec.telemetry`
Each harness plug declares a small, closed shape:
- **`kind`**: `"hook" | "plugin" | "otel"`.
- **how to register**: for `hook`, write the hook into the runtime's settings + a transcript decoder;
  for `plugin`, merge the plugin+flag into the runtime config; for `otel`, the env is enough.
- tonoman maps its **one sink config** (Langfuse keys + URL) onto each runtime's expected env names
  (normalizing quirks like `LANGFUSE_BASE_URL` ↔ `LANGFUSE_BASEURL`), and the **runtime registers the
  adapter on boot** — no initContainer, no per-image hook baked in.
- Everything converges on **one neutral trace model** (`{agent, session, user, backend, model,
  tokens{in,out,cache}, tools[], skills[], cost, latency}`) so the same dashboards work across runtimes.

**Zero-dep note (tonoman principle):** for the `hook` kind, tonoman ships its **own** transcript→trace
hook as **plain Node** posting to Langfuse's ingestion API via `fetch` — no Python, no Langfuse SDK,
no extra image dependency (unlike the tactical Atlas hook that used python + the SDK, which this
generalization replaces).
