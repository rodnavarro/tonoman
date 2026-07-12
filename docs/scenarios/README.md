[[_TOC_]]

# Tonoman Scenarios

Specification-by-example for Tonoman. Scenarios are the **review gate before code**
and the basis for the test harness. They come in **two kinds**, in two folders — they
answer different questions and run differently.

| Folder | Answers | Count | Tests | Cost |
|---|---|---|---|---|
| [`contracts/`](contracts/README.md) | *"Does this one behavior hold?"* | many, granular | `npm test` (vitest, fakes) | **free** — no container, no tokens |
| [`live/`](live/README.md) | *"Does the product actually work for a real task?"* | few, curated | `npm run test:live` (gated) | **real** — real containers, real tokens |

## contracts/ — behavior specs (free, exhaustive)

One granular behavior per scenario (e.g. `gw-command-steer`, `roster-provision`),
each proven by a **pure/contract unit test** that uses fakes — the `claude` CLI is
never spawned and no token is spent. This is where coverage lives: the whole surface,
asserted deterministically. Stable slug IDs are referenced by the tests. The technical
**how** lives in [`architecture.md`](../architecture.md); contracts state **behavior**.

> Run: `npm test` · Index + run matrix: [`contracts/README.md`](contracts/README.md)

## live/ — integration journeys (on-demand, real tokens)

A **handful** of longer, journey-style scenarios that compose many behaviors and run
against **real containers** spending **real tokens** — the smoke test that the wiring
actually works end-to-end, not just that the units do. They are **not** "a contract
scenario, but live"; they are their own thing: real usage. They are **gated**
(`TONOMAN_LIVE=1`) so `npm test` and CI stay free, and **run on demand** by track.

> Run: `npm run test:live` (or `-- <track-file>` for one) · Charter + list:
> [`live/README.md`](live/README.md)

---

**Rule of thumb:** if you can assert it with a fake, it's a **contract** (put it in
`contracts/`, keep it free). If proving it requires a real container answering a real
prompt, it's a **live integration journey** (put it in `live/`, curate ruthlessly —
every one costs tokens every run).
