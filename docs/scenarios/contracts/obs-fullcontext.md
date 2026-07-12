[[_TOC_]]

# Track: observability — full-context capture (fctx-*)

Standing traces answer "what did the agent DO and what did it COST" (prompt, reply, tools, tokens,
cache, $). They deliberately do **not** carry the big static prefix — the **system prompt + tool
schemas** — because it repeats every turn. But when you're debugging *why a turn is expensive* or
*what the model actually saw*, you need the **entire request as sent**: system blocks + every tool
schema + the full message history. The runtime's transcript does **not** contain it (verified: no
system-prompt record), and `claude --debug` does not emit it either — the only faithful source is the
**actual API request**. This capability captures it, **gated behind an explicit flag**, and attaches
it to the same trace — so an operator learning to debug an agent can read exactly what was sent.

> **Run:** `npm test` → fctx unit/contract tests (flag gating, capture shape, transparent forward,
> trace attachment). **FREE.** Live proof rides the observability live track. Index: [`README.md`](README.md)
> Companion: [`observability.md`](observability.md) (the standing, out-of-path trace).

> **Architecture:** [§ A12 observability]. Scenarios state behavior only.

---

## Full-context capture — SPEC

### `fctx-flag-gated` — OFF by default; a deliberate debug flag turns it on
- Given an agent with **no** full-context flag (the default),
- Then **no capture happens**: no proxy is started, the model endpoint is untouched, and the turn runs
  on the normal path with **zero added overhead**. This is not standing observability — it is an
  opt-in debug lens.
- When the operator sets the flag (e.g. `TRACE_FULL_CONTEXT=true`) on the agent, capture turns on for
  that agent's turns until unset. (A live toggle mirrors the backend/model knobs; a durable default is
  a GitOps change.)
- _Arch: A12._

### `fctx-out-of-path` — assembled post-hoc; NOTHING sits in the request path
- Given capture is on,
- Then the full context is **reconstructed after the turn**, never in front of the model: the runtime
  captures the **static prefix** (system blocks + tool schemas + identity) **once at boot**, and the
  post-turn hook reads the **full message history from the transcript** and prepends the cached prefix.
- **No proxy, no gateway, no per-turn interception** — so it is **backend-agnostic by construction**
  (subscription OAuth is never touched) and adds **zero request-path dependency or latency**. Assembly
  reuses the existing zero-dep Langfuse client (`postTrace`).
- _Arch: A12 (side-channel; the request path is untouched)._

### `fctx-captures-entire-request` — system + tools + all messages
- Given capture is on,
- When a turn runs, the attached artifact contains the **whole context**: the **system blocks** (base
  prompt + appended identity) and **every tool schema** (from the boot prefix) plus **all messages**
  (full history + the current prompt, from the transcript) — the thing the transcript alone omits.
- Because the messages are per-turn, the artifact **grows with history**, so session-history bloat is
  directly visible turn over turn.
- _Arch: A12._

### `fctx-boot-prefix` — the static prefix is captured ONCE, backend-neutrally
- Given capture is on,
- When the runtime boots, it captures the static prefix (system + tools + identity) a single time (a
  one-shot local probe reading what the harness assembles) and caches it; per-turn assembly reuses that
  cache — no repeated capture. The prefix is labelled **"captured at boot"** to be explicit that it is
  a snapshot, not re-read each turn.
- Reconstruction is **~faithful, not byte-exact**: the small dynamic block (env/git/date) is from the
  boot snapshot. This is sufficient for understanding/debugging bloat (the actual need); byte-exact
  forensics is out of scope (would require in-path capture, explicitly rejected).
- _Arch: A12._

### `fctx-attaches-to-trace` — the captured context rides the SAME turn's trace, per-turn
- Given capture is on and a sink is configured,
- Then the captured full context is attached to **that turn's** neutral trace as a **distinct artifact**
  (its own observation/field), beside the existing tokens/cost — **not** merged into the clean
  prompt/reply view. Because it is **per-turn**, the operator can watch the context **grow** as history
  accumulates (making session-history bloat directly visible).
- _Arch: A12._

### `fctx-nonfatal` — capture failure falls open to the normal path
- Given capture is on and the capturing hop fails (proxy can't start, forward errors, oversize),
- Then the turn **still completes** on the normal path and the trace is still emitted **without** the
  full-context artifact — a debug lens must never cost a turn or block the agent.
- _Arch: A12 (best-effort, obs-nonfatal sibling)._

### `fctx-size-aware` — large by design, bounded and labelled
- Given a captured context can be tens of thousands of tokens,
- Then it is stored as a separate, clearly-labelled artifact (and only while the flag is on), so it
  never bloats the standing trace view; if it exceeds a safe cap it is truncated with a marker rather
  than dropped silently.
- _Arch: A12._

### `fctx-harness-neutral` — the capture seam isn't Claude-Code-shaped
- Given the capture interface,
- Then a second runtime captures its own "entire request as sent" via **its** endpoint-override
  mechanism, attaching to the **same** neutral trace artifact — zero changes to the trace model or the
  sink. (Claude Code today; Codex/OpenCode the same seam.)
- _Arch: A11, A12._
