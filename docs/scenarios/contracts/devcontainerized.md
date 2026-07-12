[[_TOC_]]

# Track: devcontainerized — the agent spins up its own containers

> **Status: brokered runtime PROVEN END-TO-END (2026-06-14); design in [A13](../../architecture.md#a13--containerized-dev-runtime-brokered-podman).**
> The agent's in-sandbox `podman` shim → host broker → host podman path works: the owned
> fixture stack ([`fixtures/devstack/`](../../../fixtures/devstack/)) was brought up *from
> inside Cody* and lands as **non-privileged host containers visible in Podman Desktop**,
> with build, named volume, bind-mount (path-rewritten), DNS-by-name, a published port
> (dev-against-it), iterate (rebuild), and policy denial all confirmed.

The second member of the remote-app-dev family (the first has the agent build and
serve an app **as host processes**). Where that earlier capability runs apps as host
processes, this track gives
it the ability to **build and run its own containers** — so it can develop and
operate **multi-service apps** (web + API + db + worker) the way a real developer
does, entirely from chat. One agent, one sandbox, many skills.

**Project-agnostic:** the realistic proving target is the example stack (DB +
worker + API) — a multi-service local stack (Postgres + LocalStack + several
source-built services) — but the runtime is generic: it brings
up/builds/logs/iterates **any** project's stack. The example stack is the example,
not the spec.

> **Run:** `npm test` (policy/broker/control unit + contract) · live substrate proof:
> `npx tsx scripts/broker-smoke.ts` + `scripts/control-smoke.ts` · fixture stack:
> [`fixtures/devstack/`](../../../fixtures/devstack/) brought up via the agent's shim.
> Index: [`README.md`](README.md) · Architecture: [`../architecture.md`](../../architecture.md#a13--containerized-dev-runtime-brokered-podman)

---

## Runtime — two profiles (full design: [A13](../../architecture.md#a13--containerized-dev-runtime-brokered-podman))

The runtime is a **substrate** (agent initiates, substrate executes). The agent-facing
surface is **generic**: transparent `podman`/`docker` plus a branded `tonoman up/expose/
logs/down` verb set — *not* a per-project skill. Two profiles:

- **Brokered podman (default).** The default `claude-code` runtime — the minimal,
  non-privileged `tonoman/claudecode` image. Agent's podman is a thin client → a Tonoman
  **policy proxy** (allowlist: verb × flag × ownership) → **rootless, non-privileged
  host podman**. Stacks run as non-privileged, GUID-namespaced siblings; the agent is
  non-privileged; the proxy rewrites mount paths to grants and **injects secrets
  host-side** (the agent never holds them). Preserves the A2 boundary. This is what
  `tonoman create agent` provisions, and what the live agent runs.
- **Nested-privileged (fallback).** Agent runs its own podman nested with `--privileged`
  + `firewall_driver=none` (spike-proven: native `overlay`, build cache, bridge
  networking). Self-contained but privileged → weakens A2; no systemd → the bring-up must
  **poll readiness itself**. Opt-in via `--image`/profile override for
  quick/offline/single-trusted dev — **never the default**.

_sysbox/Kata (non-privileged nesting) is **not** on the onboarding path — root host
install, Docker-first, untested on WSL2 (A13). Managed deployments only._

---

## Scenarios

### `devcontainerized-bring-up-stack` — bring a project's stack up from chat
- Given a dev agent in a **non-privileged** sandbox, a project granted under
  `~/files/<name>`, and the brokered runtime available ([A13](../../architecture.md#a13--containerized-dev-runtime-brokered-podman)),
- When the operator says **"bring up the `<project>` stack"**,
- Then the agent reads the project's **own** compose/README and brings it up through
  the runtime (`tonoman up` / `podman compose up`), which Tonoman executes on the host
  podman as **non-privileged, GUID-namespaced sibling containers**;
- And the agent **verifies real readiness by probing each service directly** (not
  trusting compose health-gating, which doesn't auto-fire here), then replies with
  what's up / healthy / failed — tight, phone-friendly.
- **Generic**: works for any project's stack with **no per-project skill** — the
  runtime is the capability.
- **Policy (design gate)**: a request that would escalate — `--privileged`, a device,
  a mount outside the grant — is **denied by the broker**; the agent reports the
  denial rather than escalating.
- **Secrets**: if a build/run needs a credential, Tonoman injects it host-side (or the
  agent reports exactly what's missing) — the agent never handles the raw secret.
- _Arch: A13. Green on **brokered** (default); also demonstrable on nested-privileged._

### `devcontainerized-iterate` — change → rebuild → verify, across turns
- Given a stack the agent brought up (`devcontainerized-bring-up-stack`) earlier in
  this conversation,
- When the operator asks for a change over one or more turns — e.g. **"add a `/health`
  endpoint to the API"** —
- Then the agent edits the project source under `~/files/<name>`, **rebuilds only the
  affected service**, restarts it (containers **outlive the turn**), and **confirms the
  change** (hits the new endpoint / reruns the project's relevant test or sweep);
- And it commits the change when sensible and reports the result tight.
- **Continuity**: each turn is a fresh `claude -p` (no `--resume`); the agent
  reconstructs what's running from substrate memory + the live stack + the project repo.
- _Arch: A13 (+ A3 memory)._

### `devcontainerized-fix-service` — diagnose & fix a crashing service (outcome-verified)
- Given a stack the agent brought up earlier has one service **crash-looping** (e.g. a
  worker that needs DB schema/data not yet present — the example stack's worker case),
- When the operator says **"the `<service>` is failing — fix it"**,
- Then the agent **diagnoses from the real system** (reads the container logs through the
  runtime), finds and follows the **project's own recovery procedure** (its scripts/README
  — e.g. restore a dump + apply a migration), runs the fix **through the brokered runtime**,
  **restarts the service**, and confirms it.
- **Outcome-verified (the catch):** the scenario passes only if the **real end-state**
  matches — the service is actually `Up`/healthy **and** the expected side-effect is
  present (e.g. the DB schema/tables exist) — **independent of what the agent says in
  chat**. A "done" reply that doesn't match reality **fails**. (Pairs with
  [`gw-brokered-op-accountable`](gateway.md): the fix is a long brokered op that must complete
  in-turn and stay on the broker ledger, not be backgrounded and silently dropped.)
- **Access via config:** the fix may need inputs outside the project grant (a dump, a
  sibling tool); the operator grants them by adding a **mount/grant** in the agent's config,
  and the broker path-rewrites + permits them — the agent never reaches outside its grants.
- _Arch: A13 (brokered runtime + grants), A3 (continuity)._

## Runtime robustness — gaps surfaced by the 2026-06-14 naive-prompt live test (TODO)

A "the worker's broken, fix it" run exposed that brokered ops can **hang** (not just be
denied), and that the agent must **follow the project's own recovery runbook** rather than
hand-assemble steps in the wrong order. **Principle:** a real operator gives a naive prompt
and walks away — the agent must succeed from that, with **no correct-order coaching**. The
re-test uses the **same naive prompt**, outcome-verified; if a corrected/ordered prompt is
needed to pass, it failed.

### `devcontainerized-broker-stdin` — stdin flows through the control channel
- Given an agent pipes input to a brokered command (e.g. `… | podman exec -i pg psql …`),
- Then the in-sandbox shim captures that stdin and the broker feeds it to the host
  command's stdin, so stdin-consuming commands work end-to-end;
- And when a command asks for `-i`/stdin but **none is piped**, the broker closes stdin
  immediately (**EOF**) so the command returns instead of **hanging forever** waiting for
  input — the exact failure that hung the live migration ~10 min.
- _Arch: A8 (control channel carries stdin), A13 (broker)._

### `devcontainerized-broker-cp` — `podman cp` paths are rewritten agent→host
- Given `podman cp <agent-path> <container>:<path>` (or the reverse),
- Then the broker rewrites the agent-view absolute path (`/root/files/<name>/…`, A9) to
  its host path via the grant, leaving the `container:path` ref untouched — so `cp` across
  the sandbox boundary works (today it returns **code 125**: the host can't see the agent path);
- And an absolute host path **outside every grant** is denied (same ownership floor as `-v`).
- _Arch: A13 (policy path-rewrite + ownership)._

### `devcontainerized-broker-timeout` — a hung brokered op fails fast, in-turn
- Given a brokered command that never terminates (waits on stdin, a lock, the network),
- Then the broker **bounds it with a timeout**: it kills the host process and returns a
  clear non-zero **timeout error** within the bound, rather than hanging to the shim's
  10-min ceiling;
- So the agent gets a fast, **in-turn** signal it can react to, instead of the op being
  abandoned/backgrounded into an orphan (the spiral the live test showed). The bound is
  **generous enough for legitimate long builds/restores** and is configurable.
- _Arch: A13 (broker), A8 (in-turn terminal status)._

### `devcontainerized-follow-runbook` — fix from a naive prompt via the project's recovery procedure
- Given a broken service whose correct recovery is documented in the project (a runbook
  README + a restore script — e.g. **restore the staging dump, THEN apply the migration**),
- When the operator gives a **naive** prompt — *"the `<service>` is broken, fix it"* — with
  no steps and no ordering,
- Then the agent **discovers and follows the project's own recovery procedure end-to-end**
  (reads the runbook before acting; does **not** start mid-sequence or hand-assemble steps),
- And it succeeds **outcome-verified** (service `Up` + expected schema/data present)
  **without** the operator specifying the order. If an ordered prompt is needed, it fails.
- _Arch: A2 (identity/AGENTS.md behavior), A13 (runtime). Pairs with `devcontainerized-fix-service`._

## Reachable service URLs — a Tonoman platform capability (TODO — review gate before code)

A live test surfaced that the agent kept handing out `http://localhost:<port>` URLs. Two
problems, one root cause — **only the host knows its own reachable address, and the agent
must not be the thing that opens a port:**
1. The agent's sandbox has its **own** network; `localhost` there is the agent, not the host
   and not the sibling stacks. A hand-built `localhost` URL is meaningless off the host.
2. **Reaching a service from another device** (the operator's phone on WiFi) is not a string
   the agent can compute — published ports may be bound host-loopback-only (the real case:
   podman-in-WSL2 binds `127.0.0.1:<port>` on the Windows host, unreachable from the LAN). It
   is a **host action**, and — because agents run `--dangerously-skip-permissions` in the
   sandbox — it must be a **brokered, policy-gated, audited** host action, never the agent's.

So URL resolution and exposure become a **platform capability over the same brokered control
channel the agent already uses for podman** (A8/A13) — not agent prompt-knowledge, not an
agentic-org skill. Two verbs, default-deny.

### `devcontainerized-resolve-url` — `tonoman url <service>` resolves a reachable URL host-side
- Given a service the agent runs with a published port, in a sandbox where `localhost` is the
  agent (not the host),
- When the operator asks for a way to reach a service (e.g. *"give me a curl for the worker
  health check"*) and the agent runs the brokered **`tonoman url <service>`** verb (same file
  control channel as `podman`, A8),
- Then **Tonoman resolves the URL _authority_ host-side** — `scheme://<advertise_host>:<host-port>`
  — because only the host knows its reachable address (`advertise_host` is configurable; defaults
  to the host-reachable address). Resolution is **scoped to this agent's own containers**
  (GUID/grant ownership, A11) — one agent can't enumerate another's services.
- And the verb returns the **authority only, not the route**: the agent **still probes and
  verifies the path itself** (via `host.containers.internal:<host-port>` from its sandbox) — so
  it confirms `/health/live` (not a guessed `/health`) before answering. The verb must not
  pretend to know paths, or it re-introduces the guessing this is meant to kill.
- **The catch:** "I tested it" means a probe returned 200; a guessed URL — or one tested against
  the sandbox's own `localhost` and reported as working — **fails**.
- Default posture: a service that has **not** been exposed resolves to the **host-reachable**
  URL only; LAN/remote reachability requires `devcontainerized-expose-url`.
- _Proven groundwork 2026-06-14: worker `0.0.0.0:8081->8080`; host `:8081/health/live`→200,
  `/health`→404; from Cody (pasta net) `host.containers.internal:8081/health/live`→200; host
  listener is `127.0.0.1:8081` only (LAN-unreachable → motivates expose). Arch: A8/A13, A2._

### `devcontainerized-expose-url` — `tonoman expose` makes a service reachable, brokered + revocable
- Given agents run `--dangerously-skip-permissions` inside the sandbox and **the host is the
  trust boundary**, and a service whose published port is not reachable beyond host-loopback,
- When the operator (through the agent) requests **`tonoman expose <service>`**,
- Then the exposure is performed **host-side by the broker, never by the agent** — the agent has
  no host shell, no `netsh`/firewall, no host network privilege; it can only *request*. The
  broker **policy-gates it (default-deny)**, **records it on the ledger** (like every brokered
  op), **scopes it to the agent's own containers**, and makes it **revocable** —
  **`tonoman unexpose <service>`** and auto-teardown on `tonoman down`/stack stop;
- And it returns the now-reachable URL authority `http://<advertise_host>:<host-port>` (on this
  Windows/WSL2 dev host: a brokered `netsh portproxy` to the LAN interface + a **one-time
  pre-provisioned** firewall allow — not opened ad-hoc).
- **Security invariants (the enterprise story):**
  - The agent **cannot open a port itself**; exposure is a brokered, audited, revocable grant.
  - Exposing a port grants the sandbox **no new reach into the host** — it is an **inbound-only**
    forward of an **already-published** port; it does not widen the agent→host boundary (unlike
    WSL mirrored networking, a rejected global VM-level change).
  - **Nothing is exposed unless explicitly requested** (default-deny); `tonoman url` without an
    expose stays host-local.
  - **Public-tunnel** exposure (cloudflared/ngrok) is an **opt-in, non-default** mode for
    personal use only — **off in the enterprise profile** (no third-party data egress).
- **Platform portability:** the WSL-loopback quirk is a Windows-dev artifact; on the enterprise's
  Linux hosts published ports are already reachable, so `expose` maps to a firewall/NetworkPolicy
  rule — the **brokered / audited / revocable / default-deny** model is the constant. The hardened
  multi-service form is a **single authenticated Tonoman ingress** (one controlled entry proxying
  to internal ports) rather than N raw open ports.
- **Mechanism (chosen): an in-process reverse-proxy in the gateway.** `expose` binds the
  advertised host interface (the LAN IP, e.g. `192.168.4.80:<port>` — NOT `0.0.0.0`, which would
  collide with the existing `127.0.0.1:<port>` publish) and pipes connections to the
  loopback-published port; `unexpose` closes the listener. It runs as the gateway **user — no
  admin**, is **cross-platform** (no netsh/firewall fork), and is itself the "single authenticated
  ingress" endgame. (Rejected: `netsh portproxy` — admin-bound, Windows-only, collides on
  `0.0.0.0:<port>`.) **Off-host reachability must be PROVEN (a device on the LAN actually loads the
  URL) before this scenario is DONE** — host-loopback success does not imply LAN reachability, and
  a host firewall can still drop inbound to the gateway's new listener.
- **Current limitation (honest):** per-agent ownership scoping is enforced by the `tonoman.agent`
  label, which today is stamped only on `run`/`create`. **Compose-created containers are unlabeled**
  and fall through the "unlabeled ⇒ include" path, so on a multi-agent host they would currently
  be visible to `tonoman url` across agents. Acceptable for the single-agent dev box; tightening =
  propagate the ownership label to compose containers (follow-up) before multi-agent.
- _Arch: A8/A13 (brokered control channel + policy + ledger), A2 (sandbox-is-boundary), A11 (per-agent ownership)._

### Further (TODO — same review gate before code)
- **`devcontainerized-isolation`** — one agent's stack is invisible/unreachable to another (extends `roster-isolation`); enforced by GUID namespacing in the broker (A13).
- **`devcontainerized-multiservice`** (the example-stack headline) — build the source images + bring the **full** example stack to healthy (Postgres + LocalStack + api/worker/mock), with dynamic (a private-registry token) + static secrets injected and the dump restored. Needs the example stack's creds/dump.
