# Live: hermes-service

Proves what fakes can't: a **self-channeled service agent** ([`svc-self-channeled`](../contracts/service.md))
actually boots under Tonoman on the **Hermes** backend ([`hermes-backend`](../contracts/backend-hermes.md)) —
it comes up as a long-lived server, with its **declared CLI** installed at boot, healthy on its port,
and tears down clean. Real container.

> **Run:** `npm run test:live -- src/live/hermes-service.live.test.ts`
> Gated by `TONOMAN_LIVE=1`. **Skips** (doesn't fail) if the `tonoman/hermes` image is absent.
> Uses a throwaway env (`TONOMAN_ENV=smoke`) with guaranteed teardown.

## `hermes-live`

Operator stands up a **service** agent and confirms it's operational (Tonoman drives **no** turn — the
agent owns its own channel):

1. **boots** — `create agent` + `up` a service agent (`harness: hermes`, `service: true`) under a
   throwaway env → its container comes up and **stays up** (long-lived server, not exec-per-turn), and
   Tonoman attaches **no** gateway turn-loop / connector to it.
2. **tools installed** — the declared `setup` ran at boot: the agent's **declared CLI is on PATH**
   (`cfg-agent-tools`) — i.e. it came up with its capability installed.
3. **healthy, no tokens** — the agent's **port answers** a health probe (`health-no-tokens`); Tonoman
   reports it healthy without spending model tokens.
4. **clean teardown** — `down` stops it (adopt-safe); no container/volume is left behind.

Asserts **structure, not model text** (container up + long-lived, declared CLI present, port answers,
clean teardown). The env/secrets wiring and run-arg shape are covered free in
[`contracts/service.md`](../contracts/service.md) + [`contracts/backend-hermes.md`](../contracts/backend-hermes.md).
