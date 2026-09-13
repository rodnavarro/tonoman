# Feature docs

Deep-dives on individual Tonoman subsystems — how a thing is **wired today**, with sequence diagrams
where there's a flow worth drawing. These complement [`../architecture.md`](../architecture.md), which
stays the **map**: one page of design decisions and cross-references (`_Built on A2, A3…_`), each
section pointing here when a subsystem has earned its own doc.

A subsystem gets a feature doc when it has a **runtime sequence or contract** worth its own page —
not every design gate does. The rest stay in the architecture map.

| Feature | Doc | Architecture map |
|---|---|---|
| **Messaging gateway turn loop** — inbound message → streamed reply | [`gateway-turn-loop.md`](gateway-turn-loop.md) | §A1, §A4 |
| **Claude Code harness & subscription auth** — the `claude -p` command + the OAuth credential store | [`auth-and-harness.md`](auth-and-harness.md) | §A2 |
| **Git-backed memory** — the substrate-owned JSONL transcript + harness-session cache reuse | [`git-memory.md`](git-memory.md) | §A3 |
| **Agent roster & reconcile-on-change** — the worker's whole view of an agent; reload diff | [`roster-and-reload.md`](roster-and-reload.md) | §A11 |
| **Talents** — self-contained CLIs the runtime spawns | [`tonoman-talents.md`](tonoman-talents.md) | §A15 |
| **Second brain** — the per-account, git-backed knowledge store agents file into | [`second-brain.md`](second-brain.md) | §A3 |

The remaining architecture sections (A5 tunnels, A6 long-lived agents, A7 web, A8 tunnels API, A9
mounts, A10 commands, A12 observability, A13 podman runtime, A14 browser) are design gates and
rationale without a distinct runtime sequence — they stay in the [map](../architecture.md).
