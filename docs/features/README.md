# Feature docs

Deep-dives on individual Tonoman subsystems — how a thing is **wired today**, with sequence diagrams
where there's a flow worth drawing. These complement [`../architecture.md`](../architecture.md), which
stays the **map**: one page of design decisions and cross-references (`_Built on A2, A3…_`), each
section pointing here when a subsystem has earned its own doc.

A subsystem gets a feature doc when it has a **runtime sequence or contract** worth its own page —
not every design gate does. The rest stay in the architecture map.

| Feature | Doc | Architecture map |
|---|---|---|
| **Talents** — self-contained CLIs the runtime spawns | [`tonoman-talents.md`](tonoman-talents.md) | §A15 |

_(More to come — the set of subsystems that get their own doc is being scoped; see the sprint notes.)_
