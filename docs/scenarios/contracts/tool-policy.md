[[_TOC_]]

# Track: tool-policy — per-agent tool surface as a product capability

An agent's harness ships a fixed base cost every turn. For Claude Code that base is a ~28k-token cached
prefix = the base system prompt **plus the full built-in tool schemas** (Read/Write/Edit/Grep/Glob/
WebFetch/WebSearch/Task/NotebookEdit/TodoWrite/…). A single-purpose agent (Atlas shells `billing` via Bash)
carries every one of those schemas even though it never calls them — and on sporadic use each turn is a
cache **miss**, so it re-pays that prefix as cache-creation every time.

tonoman must let an operator **declare the tool surface an agent needs**, and prune the rest — WITHOUT
crippling the agent (a general coding agent must still traverse files and do work). This is a **product**
concern (a config knob owned by tonoman), and **harness-neutral**: each harness maps the declared surface
onto its own mechanism (Claude Code → `permissions.deny` bare-tool rules, the only lever that removes a
schema from the model's context; a subagent-style runtime → a `tools:` allowlist; etc.).

> **Run:** `npm test` → tool-policy unit/contract tests (allowlist → compiled deny rules, settings merge,
> defaults, drift). **FREE** — spends no tokens. Live payoff (prefix shrink) rides the observability
> track: a traced turn shows reduced cache-creation. Index: [`README.md`](README.md)

> **Empirical basis (measured 2026-07-04, Claude Code 2.1.200, `--dangerously-skip-permissions`):**
> deny rules prune tool schemas **even under skip-permissions** (the gate — they are honored, not
> bypassed). Total cached prefix: **all tools 28,563 → keep Bash/Read/Grep/Glob 25,512 (−3,051) → keep
> only Bash/Read 23,994 (−4,569)**. So tool-pruning recovers the **denied tools' schemas only** (~3–4.5k);
> the residual ~24k is the base prompt + kept-tool schemas and is NOT ours to trim. `permissions.allow`
> / `--allowedTools` do **not** prune — they only gate execution. Deny is the lever.

> **Architecture:** [§ A2 harness plug](../../architecture.md#a2--claude-code-harness--headless-oauth) ·
> [§ A12 observability] (the payoff is observable there). Scenarios state behavior only.

---

## Per-agent tool policy — SPEC

### `toolpolicy-off-by-default` — no policy ⇒ full toolset, zero regression
- Given an agent with **no tool policy configured**,
- Then the agent runs with the harness's **full built-in toolset** exactly as today — tonoman writes no
  deny rules and changes no behavior. A general agent (Cody, Cardy) is untouched by default.
- The capability is **opt-in per agent**; the safe default never narrows an agent.
- _Arch: A11 (per-agent config), A2._

### `toolpolicy-declares-surface` — an agent declares the tools it needs (allowlist intent)
- Given an operator wants a single-purpose agent lean,
- Then the agent config declares a **tool allowlist** — the tools it actually uses (e.g. Atlas:
  `[Bash, Read]`; a file-working agent: `[Bash, Read, Grep, Glob]`). The declaration is **harness-neutral
  intent** ("this agent needs these"), not a Claude-Code deny list — tonoman compiles the mechanism.
- _Arch: A11, A12._

### `toolpolicy-compiles-to-deny` — Claude Code adapter compiles the allowlist to deny rules on boot
- Given a Claude Code agent with a tool allowlist,
- When the runtime starts, the harness adapter computes **deny = knownBuiltins − allowlist** and writes
  those as **bare-tool-name `permissions.deny` rules** into `settings.json` — the only Claude Code lever
  that removes a tool's schema from the model's context (not `allow`, which merely gates execution).
- Registration is **idempotent** (safe every boot) and pruning is **verified to survive
  `--dangerously-skip-permissions`** (Atlas's exact spawn) — the feature is not inert in that mode.
- _Arch: A2 (runtime owns its harness config), A12._

### `toolpolicy-keeps-essentials` — never strip an agent into uselessness
- Given any tool policy,
- Then the agent **always retains the ability to traverse files and do work** — the allowlist floor
  keeps at least a shell/read capability, and a policy that would deny the agent's own required tools is
  **rejected at config-validation** (fail closed at declare-time, not silently at runtime). "Lean" never
  means "can't act."
- The recommended lean profile keeps **Bash + Read** (+ Grep/Glob for a file-working agent) and denies
  the heavy unused surface (Web*, Edit/Write/MultiEdit, NotebookEdit, TodoWrite, Task).
- _Arch: A11._

### `toolpolicy-composes-with-telemetry` — deny rules and the trace hook coexist in settings.json
- Given the observability Stop-hook and a tool policy are BOTH active,
- Then boot-time registration is **read-merge**: writing the deny rules preserves the `hooks.Stop` entry
  and vice-versa — both survive together in `settings.json`, in any registration order.
- _Arch: A2, A12. (Two writers, one file — the composition that silently breaks without a test.)_

### `toolpolicy-drift-safe` — an unknown/new builtin fails safe toward capability
- Given the harness introduces a **new built-in tool** tonoman's known-builtins list doesn't yet name,
- Then that tool is **left present** (and logged), never silently denied — drift fails **toward
  capability**, so a harness upgrade can't accidentally disable an agent. (Closing the gap is a
  known-list update, not an incident.)
- _Arch: A2._

### `toolpolicy-harness-neutral` — the declaration is neutral; each harness maps its own mechanism
- Given the neutral tool-allowlist declaration,
- Then a **second harness** applies it via **its own** mechanism (a subagent-style runtime → a native
  `tools:` allowlist that prunes directly; an MCP-only runtime → tool exposure config) with **zero
  changes** to the neutral declaration or the config schema — proving the seam isn't Claude-Code-shaped.
- _Arch: A11 (harness-neutral roster), A12._
