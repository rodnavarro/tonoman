# Live integration scenarios

Journeys against **real containers** spending **real tokens** — the smoke test that the
wiring works end-to-end, which the free [`contracts/`](../contracts/README.md) suite (fakes)
can't prove. Few and curated: each one costs tokens every run.

> **Run:** `npm run test:live` (all) or `-- src/live/<track>.live.test.ts` (one).
> Gated by `TONOMAN_LIVE=1` (the script sets it), so `npm test`/CI stay free.
> Target agent: `TONOMAN_LIVE_AGENT` (default `cody`).

**Rules:** assert **structure, not model text** (exit ok, reply arrived, file written, no
leftover container); **skip** (don't fail) if the agent isn't authenticated; use throwaway
state so re-runs are safe; keep prompts tiny.

## Scenarios

| ID | Journey | Test |
|---|---|---|
| [`int-control-loop`](control-loop.md) | real task + `/btw` (live progress) + `/model` | `src/live/control-loop.live.test.ts` |
| [`hermes-live`](hermes-service.md) | a hermes **service** agent boots (declared CLI installed, healthy on its port, clean teardown) | `src/live/hermes-service.live.test.ts` |
