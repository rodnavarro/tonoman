[[_TOC_]]

# Track: cli — the `tonoman` command-line surface

The **plumbing** of the `tonoman` CLI: how an invocation is **dispatched** to a
command, where the **config** is read from, and how each command **parses its flags
and validates its args** before delegating. Cheap to verify — **unit tests only, no
LLM, no podman**.

Tonoman is a control plane for agents, so the CLI reads like **`kubectl`**: a
**verb**, then a **resource**, then an optional **name**, then flags —
`tonoman <verb> <resource> [name] [flags]`. The **agent is the namespace**: an
agent-scoped resource takes `-a/--agent <name>` exactly the way `kubectl` takes
`-n <namespace>`.

```
tonoman get agents                      # list agents
tonoman get agent cody                  # show one agent
tonoman get mounts -a cody              # cody's shared folders
tonoman get mounts                      # every agent's, grouped
tonoman get services                   # substrate + agent health
tonoman create mount acme C:/p/acme -a cody [--ro]
tonoman delete mount acme -a cody
tonoman auth login cody                 # harness auth (agent is the subject)
tonoman up                              # bring the control plane up (runs the gateway)
tonoman down                            # bring it down (graceful stop)
```

This track owns the CLI's *job as a CLI* — grammar, dispatch, config resolution,
the `-a` namespace, usage/version, arg validation. It does **not** re-specify what
the commands *do*; that behavior lives in the other tracks and is cross-linked:

- `get/create/delete mount` semantics → [`substrate.md` · `cfg-mounts-cli`](substrate.md#cfg-mounts-cli)
- `auth …` semantics → [`roster.md`](roster.md) (`roster-auth-volume`)
- `get services` semantics → [`health.md`](health.md) (`health-list`, `health-live-api`)
- `up` / `down` / the gateway they run → [`gateway.md`](gateway.md)

> **Run:** `npm test` → the `cli` unit suite · **free** (spends no tokens, no podman).
> Index: [`README.md`](README.md) · Architecture: [`../architecture.md`](../../architecture.md)
>
> _Scenario IDs are stable, position-free slugs — see [the ID convention](README.md#scenario-ids)._

---

## Grammar & dispatch — DONE

### `cli-grammar` — `kubectl`-style verb/resource grammar
- Given `tonoman <verb> <resource> [name] [flags]`,
- Then the **verb** selects the action — `get` (read), `create`, `delete` — and the
  **resource** selects the object — `agents`, `mounts`, `services`. Singular/plural
  and short forms are interchangeable (`agent`=`agents`, `mount`=`mounts`,
  `service`=`services`=`svc`), the way `kubectl` accepts `po`/`pods`.
- And a small set of **top-level commands** stand outside the verb/resource grammar
  because they are not CRUD on a resource: **`up`** / **`down`** (bring the control
  plane up / down — `up` runs the **gateway** service, which is what `get services`
  then reports), `auth` (a harness-auth subgroup), `version`, `help`.
- _The verb/resource/alias decision is a pure resolver (`resolveCommand`) so dispatch
  is unit-tested without `process.exit`._

### `cli-dispatch-errors` — A malformed invocation fails loud, never silently
- Then an **unknown verb or resource** (`tonoman frobnicate`, `tonoman get widgets`)
  prints what was wrong + the usage and exits **non-zero (2)** — a typo never
  silently no-ops.
- And **no command at all** prints the usage and exits **2** (nothing to run is a
  usage error, not success).
- And a command missing a **required arg** fails before doing work, printing its own
  one-line `usage:` to stderr and exiting **2** rather than proceeding with
  `undefined`: `create mount` needs a **name and a host path**, `delete mount` needs a
  **name**, `auth` needs an **action and an agent**.

### `cli-version-help` — Version and help are always reachable
- Then `version` (and `--version` / `-v`) prints the version and exits 0; `help` (and
  `--help` / `-h`) prints the usage and exits 0.
- The usage shows the **real** grammar (`get`/`create`/`delete` over
  agents/mounts/services, plus gateway/auth) — not aspirational verbs — because the
  same resolver backs both help and dispatch, so they cannot drift.

---

## Control-plane lifecycle

### `cli-up-down` — `up` / `down` bring **everything** up and down
- Then **`tonoman up`** brings the whole stack up: for every configured agent it
  **ensures the sandbox is running** — start it if stopped, **create + run** it if
  absent (from the assembled `podman run`, see [`roster-provision`](roster.md#roster-provision)) —
  and then runs the long-lived **gateway** service that bridges them. So `up` actually
  brings the **agents** up, not just the bridge.
- And **`tonoman down`** brings it all back down from another terminal: it stops the
  gateway **and stops every agent's container**. `up`/`down` is symmetric.
- **SAFETY FLOOR — adopt, never destroy.** `up` **adopts** an existing container by
  name (start-if-stopped, create-only-if-absent); it **never** `rm`s or recreates one.
  `down` **stops** containers — it never `rm`s them. So **volumes/creds persist** across
  a down/up cycle (`stop ≠ rm`): a brought-down agent keeps its config volume + memory,
  and `up` brings it back **fully configured**. (This is the hard rule that keeps a
  down/up from ever destroying a live agent's state.)
- And `down` is **idempotent**: with nothing running it reports the control plane is
  not up (rather than hanging or erroring) — mirroring how `get services` degrades when
  the gateway is down.
- _Mechanism: `down` is a thin client over the gateway's loopback admin endpoint
  (`POST /shutdown` on the same local HTTP surface `get services` reads), so it is
  cross-platform and triggers the gateway's graceful-abort; the gateway **owns workload
  teardown** (it brings containers up on `up`, stops them on shutdown). **DONE:** the
  adopt-safe **start/stop** lifecycle (`src/lifecycle.ts` `ensureStarted`/`stopContainer`),
  the gateway ensure-up + stop-on-shutdown wiring, the `/shutdown` endpoint (unit), and the
  `down` command (unit) — proven live by `scripts/lifecycle-smoke.ts` against a **throwaway
  container** (fixed smoke name asserted `≠ cody`, guaranteed teardown), exercising
  start/stop/no-op/absent without ever `rm`-ing. **Pending:** **create-if-absent** for an
  agent with no container yet — that is provisioning, [`roster-provision`](roster.md#roster-provision)
  (`tonoman create agent`), which assembles the `podman run` via a pure `podmanRunArgs`._

---

## The agent namespace — DONE

### `cli-agent-scope` — `-a/--agent` is the agent namespace
- Given a resource that **belongs to** an agent (today: `mounts`),
- Then it is scoped with **`-a <name>`** (long form `--agent`), exactly as `kubectl`
  scopes with `-n` — `tonoman get mounts -a cody`, `tonoman create mount … -a cody`.
- And the target agent resolves with **no guessing**: an explicit `-a` wins; with a
  single configured agent it defaults to that one (the common case needs no flag);
  with multiple agents and no `-a`, a mutation **errors and lists the agents** rather
  than picking one.
- When the **agent itself is the resource**, it is named positionally instead
  (`get agent cody`, `auth login cody`) — the `-a` flag is for *scoping to* an agent,
  a name is for *being* the agent. (Mirrors `kubectl get pod foo` vs `-n ns`.)
- `get mounts` with **no** `-a` is a read across **all** agents, grouped by agent.

---

## Reads — DONE

### `cli-get` — `get` reads resources
- Then **`get agents`** lists the configured agents; **`get agent <name>`** shows one;
  **`get services`** (the health view) lists every substrate service + agent with its
  status; **`get mounts [-a <name>]`** lists shared folders — grouped by agent when
  unscoped, or one agent when scoped.
- And **`get mounts -a <name> --podman`** renders that one agent's
  `-v host:/root/files/<name>[:ro]` flags, so a sandbox bring-up derives its bind
  mounts from the same config source of truth (`--podman` needs `-a` — it feeds **one**
  container). _The render itself is specced by [`cfg-mounts-cli`](substrate.md#cfg-mounts-cli)._

---

## Writes — DONE

### `cli-mutate-mounts` — `create` / `delete` a mount
- Then **`create mount <name> <host> [-a <agent>] [--ro]`** adds a shared-folder grant
  to that one agent's config, and **`delete mount <name> [-a <agent>]`** removes it —
  the per-agent, by-convention write (no JSON hand-editing) specced by
  [`cfg-mounts-cli`](substrate.md#cfg-mounts-cli).
- This track owns only that the verbs **parse, validate, resolve the agent, and
  delegate** (and that flags parse regardless of position — `create mount foo /h --ro`
  ≡ `create mount --ro foo /h`); the per-agent isolation and config write are the
  substrate track's. _Parse/resolve helpers (`parseMountsArgs`, `findAgent`) are
  unit-tested; the create/delete handler wiring is smoke-verified end-to-end._

---

## Environments & config resolution — DONE

### `cli-env` — `TONOMAN_ENV` selects an isolated environment (dev never disrupts prod)
- Given an operator wants a **separate dev environment** that can't touch their real
  agents — **without** threading a flag through every command,
- When they **set `TONOMAN_ENV=<name>` once** (e.g. `export TONOMAN_ENV=dev`) and then run
  any command normally — `tonoman up`, `tonoman create agent …`,
- Then Tonoman uses a **dedicated environment root** `~/.tonoman-<name>` (config + state +
  registry co-located there), instead of the default `~/.tonoman`. So under `TONOMAN_ENV=dev`
  it reads `~/.tonoman-dev/settings.json` and keeps its registry/memory under `~/.tonoman-dev`.
- And the env name **namespaces the containers**: every agent's container is **suffixed**
  with `-<name>` (so `cody` under `TONOMAN_ENV=dev` operates `cody-dev`). This is the hard
  guarantee that **a `dev`-env `up`/`down`/`create` can never start, stop, or create the prod
  `cody`** — dev and prod are isolated by construction, not by carefulness.
- The **default** (no `TONOMAN_ENV`, or empty) is `~/.tonoman` with **unsuffixed** container
  names — exactly today's behavior, unchanged. Operators who don't need environments never
  meet the concept: there is **no `-e` flag** on any command — nothing to pass, nothing to
  forget.
- **Set-once, applied uniformly:** because the environment is an **ambient knob, not a
  per-command flag**, it cannot be applied to `up` and forgotten on `down`. _Safety: every
  command **echoes the env it resolved** (`env: dev` / `env: default`) before a destructive
  verb (`up`/`down`/`create`/`delete`) runs, so the operator always sees which environment is
  about to be touched._
- _Pure (`currentEnv` reads `TONOMAN_ENV`; `envRoot` → root; `applyEnv` → container suffix +
  `state_root`), unit-tested. Pairs with [`cli-up-down`](#cli-up-down) (the suffix is why dev
  up/down is safe) and [`roster-provision`](roster.md#roster-provision)._

### `cli-config-resolution` — Where the CLI reads its config (one rule, everywhere)
- Given any command that needs config (`up`, `down`, `auth`, `get`, `create`, `delete`),
- Then the config path resolves by a **single precedence**, identical across every
  command: an explicit **`--config FILE`** wins; else, **under `TONOMAN_ENV=<name>`**, the
  environment root `~/.tonoman-<name>/settings.json` (a named env owns its config, so it
  outranks an ambient `$TONOMAN_CONFIG`, `cli-env`); else **`$TONOMAN_CONFIG`**; else the
  default `~/.tonoman/settings.json`.
- And `--config` is accepted in every common form — `--config FILE`, `-config FILE`, and
  the `=`-joined `--config=FILE` — and **extracting it leaves the remaining args untouched**
  for the command to parse (it may appear anywhere in the argv).
- _Pure (`defaultConfig` reads `TONOMAN_ENV`/`$TONOMAN_CONFIG`; `parseGlobalFlags` strips
  `--config`; `currentEnv`/`envRoot`), unit-tested: precedence + every flag form + `rest`
  preservation. Pairs with `cfg-mounted-settings`._
