[[_TOC_]]

# Tonoman Scenarios — contracts

> This is the **contracts** tree: granular behavior specs, each proven by a **free**
> unit/contract test (`npm test`, fakes — no container, no tokens). For the on-demand
> **integration journeys** that run against real containers, see
> [`../live/README.md`](../live/README.md); the router is [`../README.md`](../README.md).

Specification-by-example for Tonoman v0.1. These are the **review gate before any
code** and the basis for the test harness. Stable **slug IDs** (e.g.
`card-register`) are referenced by tests — see [Scenario IDs](#scenario-ids). The
technical **how** lives in [`architecture.md`](../../architecture.md) — scenarios state
**behavior** and link to the pattern.

**Tonoman** is a control plane for AI agents ("Kubernetes for agents"): it
orchestrates **harnesses** that run agent loops inside **sandboxes**, exposes a
shared **substrate** (workspace, skills, messaging, secrets, browser) via stable
APIs, and runs the **agents** an operator defines. It does **not** own the loop.

v0.1 proves the whole shape **locally** through the **gateway** track — an agent
running under the **Claude Code** harness, messaged over **Telegram** via a
Tonoman-owned gateway. Harness-agnosticism (hermes, **Claude Code**, and codex as
interchangeable peers) is a v0.1 principle: an earlier hermes prototype proved the
flow first; the **same flow now runs under Claude Code through the gateway**.

---

## Tracks

Scenarios are split into **tracks** — each a self-contained capability the test
harness exercises. The whole suite runs with `npm test`; build with `npm run build`
(see [run matrix](#run-matrix)).

| Track | File | Scope (ID prefix) | Cost to run | Status |
|-------|------|-------------------|-------------|--------|
| **cli** | [`cli.md`](cli.md) | the `tonoman` command surface `cli-*` | **free** (unit only) | DONE |
| **substrate** | [`substrate.md`](substrate.md) | workspace `ws-*`, config/secrets `cfg-*` | **free** (unit only) | DONE |
| **health** | [`health.md`](health.md) | service health `health-*` | **free** (unit + no-LLM live) | DONE |
| **gateway** | [`gateway.md`](gateway.md) | generic gateway + Claude Code spine `gw-*` | **free** (unit/contract) | DONE |
| **roster** | [`roster.md`](roster.md) | agents as config plug / identity / auth `roster-*` | **free** (unit) + paid live | WIP |
| **devcontainerized** | [`devcontainerized.md`](devcontainerized.md) | agent spins up its own containers `devcontainerized-*` | **free** (broker/policy unit) + live | WIP |
| **browser** | [`browser.md`](browser.md) | agents drive a real browser over CDP `browser-*` | **free** (provisioning/launch unit) + live | WIP |
| **service** | [`service.md`](service.md) | self-channeled service agents `svc-*` (Tonoman boots; the agent owns its loop) | **free** (run-args unit) + live | SKIP |
| **backend-hermes** | [`backend-hermes.md`](backend-hermes.md) | the Hermes runtime as a service backend `hermes-*` | **free** (spec unit) + live | SKIP |
| **channel-teams** | [`channel-teams.md`](channel-teams.md) | MS Teams as a Tonoman-native connector `teams-*` (turn-driven, channel ⊥ harness) | **free** (connector unit, faked `fetch`) + live | SPEC |

The **substrate**, **health**, and **gateway** spines are verified by **unit /
contract tests** (free); the brokered **devcontainerized** runtime is unit-tested and
live-proven end-to-end. The **browser** track ships the per-agent Chrome sidecar and
host-Chrome backend (provisioning/launch unit-tested; host-Chrome live-proven).

---

## Vocabulary

- **harness** — an agent-loop runtime (hermes in the earlier prototype; **Claude
  Code** and codex are interchangeable peers).
- **sandbox** — the isolated run environment (podman container in v0.1).
- **substrate** — shared services that cross the sandbox boundary (**workspace**,
  skills, **messaging**, secrets, browser), exposed via stable APIs.
- **agent** — a named, configured unit: identity/soul + preset skills + a harness
  + channels + a workspace. Content (identity + skills) comes from the mounted
  **`agentic-org`** repo; Tonoman stays content-agnostic.
- **workspace** — the agent's persistent state. A substrate service; **default
  backend = a private git repo**, local-folder fallback.
- **channel** — a messaging source (Telegram in v0.1; **MS Teams is the second
  connector**; abstraction extends to Discord/web/SMS/...).

**Interfaces:** **Desktop app** (Wails, the lead) · **`app.tonoman.com`** (web
catalog) · **CLI** — a `kubectl`-style `tonoman <verb> <resource>` surface
(`up`/`down`, `get`/`create`/`delete` over agents/mounts/services, `auth`; see the
[`cli`](cli.md) track). The desktop app + catalog land later; today's tracks are
driven from the CLI / test harness.

---

## Scenario IDs

Every scenario has a stable, **position-free slug ID** of the form
`<track-prefix>-<mnemonic>` (e.g. `card-register`, `gw-stream-live`). The rules:

- **Allocate once, never renumber, never reuse.** The ID is a permanent handle, not
  an outline position — document order is presentation only. Adding, removing, or
  reordering a scenario **never** disturbs any other ID.
- **The prefix is the track**, so a track's tests group by prefix; adding a new
  `gw-*` test joins the track automatically.
- Tests reference the slug in their name and a comment. Removing a scenario =
  delete it; no gap to explain.

## Implementation status

A scenario's status reflects *automated coverage in this repo* (not the hermes
prototype): **DONE** (passing test, unit and/or live) · **WIP** (partial) · **SKIP**
(specced, not implemented here). The Node suite has **235 unit tests**.

| Scenario ID | Behavior | Status | Test |
|-------------|----------|--------|------|
| **cli** (free) | | | cli unit suite (resolver + flag parsers) |
| `cli-grammar` | `kubectl`-style verb/resource grammar, with resource aliases | DONE | unit (cli resolver) |
| `cli-dispatch-errors` | unknown verb/resource + missing args → usage, exit 2 | DONE | unit (resolver) + smoke (handler arg-validation) |
| `cli-version-help` | `version`/`help` reachable by every alias; help = real grammar | DONE | unit (cli resolver) |
| `cli-up-down` | `up` starts agents' containers + gateway; `down` stops everything (adopt-safe: `stop`≠`rm`, volumes persist) | DONE (adopt) | unit (`/shutdown` + `down` resolver) + lifecycle smoke; create-if-absent → `roster-provision` |
| `cli-agent-scope` | `-a/--agent` is the agent namespace; named when agent IS the resource | DONE | unit (flags + `findAgent`) + smoke |
| `cli-get` | `get agents`/`agent <name>`/`mounts`/`services` read views | DONE | unit (resolver) + smoke (render) |
| `cli-mutate-mounts` | `create`/`delete mount` parse, validate, resolve agent, delegate | DONE | unit (mounts model) + smoke (wiring) |
| `cli-env` | `TONOMAN_ENV=NAME` → isolated env: config/state in `~/.tonoman-NAME`, containers suffixed `-NAME` (dev never disrupts prod; set-once, no `-e` flag) | DONE | unit (cli: `currentEnv`/`envRoot`/`applyEnv`) |
| `cli-config-resolution` | one config precedence everywhere (incl. `-e`); every flag form; rest preserved | DONE | unit (cli) |
| **substrate** (free) | | | memory (gitstore) + config units |
| `ws-git-private` | private git workspace, GUID-named, survives restart | DONE | unit |
| `ws-local-fallback` | local-folder backend, same API | DONE | unit |
| `ws-folder-convention` | stable folder layout | DONE | unit |
| `ws-session-dated` | dated transcript files + discoverable state root | DONE | unit (memory/gitstore) |
| `ws-git-autocommit` | memory auto-commits (turn-end + ~30m sweep + shutdown) + auto-push, gently; `auto_commit:false` opts out | DONE | unit (gitstore) + gateway/router wiring |
| `cfg-mounted-settings` | never-committed settings mounted into env | DONE | unit (config) |
| `cfg-per-agent` | per-agent config first-class | DONE | unit (config) |
| `cfg-no-secrets` | no secret tracked in git; agent memory repo gets a default secret-safe `.gitignore` (`secrets/`, `*.secret`, …) | DONE | unit (config + gitstore) |
| `cfg-mounts-cli` | `tonoman create/delete/get mounts` manages shared folders by convention; `get mounts --podman` renders bring-up `-v` | DONE | unit (mounts) |
| `cfg-ssh-key` | `ssh_key` → git-over-SSH via a 0600 podman secret + GIT_SSH_COMMAND (accept-new); openssh in base image | DONE | unit (provision) + live (ADO) |
| `cfg-mount-target` | a mount may declare an explicit sandbox `target` (e.g. `~/.aws`) instead of `~/files/<name>` | DONE | unit (mounts) |
| `cfg-agent-tools` | per-agent `setup` install list pre-warmed once at create + identity grants on-demand install (sandbox is root) | DONE | unit (agentcmd) |
| `cfg-memory-cli` | `tonoman set memory git --remote/--branch/--auto-commit` + `get memory` (token stays out of config) | DONE | unit (cli resolver) + smoke |
| **health** (free) | | | health units |
| `health-list` | `tonoman get services` lists every service's health | DONE | unit |
| `health-live-api` | thin client over gateway's local health API | DONE | unit |
| `health-autoregister` | new substrate service shows up automatically | DONE | unit |
| `health-no-tokens` | health checks never spend LLM tokens (invariant) | DONE | unit |
| **gateway** (free) | | | gateway / router / stream / Telegram connector / Claude Code harness / turnqueue units |
| `gw-sandbox-boot` | Claude Code agent comes up in a podman sandbox | DONE | unit |
| `gw-ephemeral-continuity` | ephemeral container, memory from substrate | DONE | unit |
| `gw-telegram-inbound` | messageable via the gateway (neutral envelope) | DONE | unit |
| `gw-stream-live` | reply streams back live (typing → cursor → finalize) | DONE | unit |
| `gw-stream-heartbeat` | liveness cue (`working… (Nm)`) during a long turn; persists (elapsed-based), display-only | DONE | unit (stream) |
| `gw-brokered-op-accountable` | brokered ops run in-turn + on a logged ledger; in-flight-at-turn-end flagged (the catch) + observability | DONE | unit + e2e (ledger + control/gateway) |
| `gw-auth-actionable` | an auth-failure turn (401/expired) replies to the user with the fix (`tonoman auth login <agent> --headless`) instead of failing silently; turn not committed, error still logged | DONE | unit (`isAuthError`) + router maps error→notice |
| `gw-command-new-session` | `/new` rotates the session (platform command, not a turn) | DONE | unit |
| `gw-command-compact` | `/compact` summarizes → rotates → seeds the fresh session (ctx drops, thread survives); order summarize→rotate→seed, no-op if summary fails | DONE | unit (compact + router + gateway) |
| `gw-turn-enqueue` | a plain message queues by default (does not interrupt) | DONE | unit (turnqueue + gateway) |
| `gw-command-steer` | `/steer <msg>` interrupts now, keeps partial as context | DONE | unit (turnqueue + gateway) |
| `gw-command-pop` | `/pop` runs the queued message(s) now | DONE | unit (turnqueue + gateway) |
| `gw-command-skip` | `/skip` clears the queued message(s) | DONE | unit (turnqueue + gateway) |
| `gw-command-interrupt` | `/interrupt <msg>` hard-stops and starts clean | DONE | unit (turnqueue + gateway) |
| `gw-command-model` | `/model <name>` switches the model for the next turn (running turn unaffected); validated at command time; survives `/new`, resets on restart | DONE | unit (modelcmd + claudecode + gateway) |
| `gw-command-btw` | `/btw <q>` answers an aside out-of-band (own reply, not committed, running turn untouched) with a live view of the in-flight turn; ephemeral sidecar + shared credential | DONE | unit (aside + claudecode + gateway); ephemeral primitive proven live |
| `gw-command-statusline` | `/statusline none\|small\|full\|print` — sticky footer with model + per-turn tokens + context % (real per-model window) + 5h/7d account usage; tappable picker; `print` shows it now (no turn) | DONE | unit (statusline + claudecode usage + gateway); endpoints proven live |
| `gw-command-health` | `/health` — deterministic check (no tokens): container up, brain authenticated, tonoman reachable from the agent (brokered round-trip), memory, timestamp | DONE | unit (gateway); broker round-trip proven live |
| **roster** (free unit + paid live) | | | registry / harness units |
| `roster-generic-contract` | generic agent contract + harness spec | DONE | unit |
| `roster-config-volume` | persistent opaque config volume | DONE | unit |
| `roster-provision` | `tonoman create agent` provisions GUID + roster entry + per-agent scaffold + sandbox on the per-harness image (adopt-safe; `--login`/`--from`) | DONE | unit (`podmanRunArgs` + `parseCreateAgentArgs`) + provision smoke (real podman) |
| `roster-isolation` | per-agent volume/workspace/memory isolation | DONE | unit |
| `roster-guid-identity` | one GUID across config/memory/messaging | DONE | unit |
| `roster-name-role` | agent name + role injected each turn from roster | DONE | unit |
| `roster-auth-volume` | `tonoman auth login/status/logout <agent>` writes the harness credential store into the agent's config volume; auth persists + auto-refreshes across restarts; per-agent account (no shared global login) | DONE | unit (authflow: `looksLoggedIn`/`isAuthError`/`authNotice`) + live |
| `roster-auth-headless` | `tonoman auth login <agent> --headless` prints the OAuth URL (login runs in-sandbox under a PTY); `tonoman auth code <agent> <code>` finishes it → creds persist in the volume, verified via `auth status`. Per-agent account = own refresh chain (the 401 fix). No hand-run scripts | DONE | unit (`extractAuthUrl`) + live |
| `roster-auth-remote` | the SAME headless login works for a **remote** agent (`claude-code-http`, k8s split — no podman, no shared FS): driven over the agent's own `/auth/login` + `/auth/code`, argv from the agent's harness spec (never the wire), outcome-true (cred file must actually change) | DONE | unit (fake agent server) + live |
| **devcontainerized** | | | broker / policy / control units + live-proven runtime |
| `devcontainerized-broker-stdin` | stdin flows through the control channel; EOF when none piped (no hang) | DONE | unit (broker/control/shim) |
| `devcontainerized-broker-cp` | `podman cp` agent paths rewritten to host; out-of-grant denied | DONE | unit (policy) |
| `devcontainerized-broker-timeout` | hung brokered op killed + non-zero error within bound, in-turn | DONE | unit (broker) |
| `devcontainerized-resolve-url` | `tonoman url <service>` resolves a reachable URL host-side | DONE | unit (expose + proxy); phone-proven live |
| `devcontainerized-expose-url` | `tonoman expose` makes a service reachable, brokered + revocable | DONE | unit (expose + proxy); phone-proven live |
| `devcontainerized-fix-service` | diagnose & fix a crashing service, outcome-verified | DONE | live-proven |
| `devcontainerized-follow-runbook` | fix from a naive prompt by following the project's own recovery procedure | DONE | live-proven |
| `devcontainerized-bring-up-stack` | bring a project's stack up from chat (non-priv, namespaced, host-visible) | WIP | fixture/live, not unit-tested |
| `devcontainerized-iterate` | change → rebuild affected service → verify, across turns | WIP | fixture/live, not unit-tested |
| `devcontainerized-isolation` | one agent's stack invisible to another (GUID namespacing) | WIP | fixture/live, not unit-tested |
| `devcontainerized-multiservice` | full example stack to healthy (the headline) | WIP | fixture/live, not unit-tested |
| **browser** | | | per-agent Chrome over CDP; design [A14](../../architecture.md#a14--browser-substrate-per-agent-chrome-over-cdp) |
| `browser-sidecar` | per-agent `tonoman/chrome` sidecar (CDP :9222 + noVNC :6080, own net + profile volume); one image, not baked into claudecode; adopt-safe | DONE | unit (provisioning: name/volume/run-args/ownership) |
| `browser-host-chrome` | second backend: agent triggers `tonoman browser ensure` → broker launches the operator's HOST Chrome with CDP + an in-process relay (Chrome binds loopback); agent drives it, operator watches/controls natively; not isolated (collaboration mode) | DONE | live-proven + unit (launch args + discovery) |
| `browser-cli` | `create/get/open/close/delete browser [-a agent]`; parses/validates/dispatches like the rest of the surface | DONE | unit (purge parse) + wired in cli |
| `browser-open-on-host` | `tonoman open browser -a <agent>` surfaces the live noVNC viewer (host-loopback); `close` revokes | WIP | shipped (viewer URL + open); not unit-tested |
| `browser-profile-persists` | per-agent persistent profile (`--user-data-dir` volume); login survives restart; no cross-agent bleed | WIP | shipped (per-GUID profile volume) + unit (volume naming) |
| `browser-interactive-login` | operator takes the wheel in the live viewer (MFA/CAPTCHA/login), no agent/browser restart; persistent profile keeps the session; `--view-only` opts out | WIP | shipped (interactive viewer by default); not unit-tested |
| `browser-isolation` | one agent's browser invisible/undrivable to another (per-agent sidecar/net/profile, ownership label, A11) | WIP | shipped (per-agent container/volume + ownership label) + unit (label) |
| `browser-bot-skill` | generic `browser-bot` skill: accessibility-snapshot + element refs (playwright-core in the image), not pixels/CSS | WIP | generic skill ships (`build/agent/skills/browser-bot/`); not auto-tested |
| `browser-drive-cdp` | agent drives over **raw CDP** (navigate/read/click/screenshot), outcome-verified; Tonoman core pulls no browser lib | WIP | driving live-proven via host-chrome; no generic auto-test |
| **service** (free unit + live) | | | service-mode provision units |
| `svc-self-channeled` | Tonoman boots + lifecycle-manages a long-lived agent; does **not** attach the gateway loop/connector (the agent owns its own channel) | SKIP | unit (`podmanRunArgs` service mode) |
| `svc-config-env` | env/secrets injected into the agent process at boot (`-e`); secrets never committed; CLI tools via `cfg-agent-tools` | SKIP | unit (`podmanRunArgs` env) |
| **backend-hermes** (free unit + live) | | | harness spec unit |
| `hermes-backend` | Hermes harness spec: service-mode, image `tonoman/hermes`, model-via-env (no OAuth login flow) | SKIP | unit (harness spec) |
| **channel-teams** (free unit + live) | | | Teams connector units (faked `fetch`) |
| `teams-inbound` | messageable on Teams through the gateway (neutral envelope, `channel: "teams"`); media available; harness never sees Teams | SPEC | unit |
| `teams-webhook-listener` | inbound is a webhook served in the gateway host process (push, ACK 200, async reply); endpoint = dev tunnel / ingress by config | SPEC | unit |
| `teams-inbound-auth` | every inbound activity's Bot Framework JWT validated (issuer/audience/JWKS) before a turn; bad token → 401, no turn | SPEC | unit |
| `teams-allowlist` | only allow-listed senders (AAD object id) served; empty list = accept all | SPEC | unit |
| `teams-conversation-reference` | capture serviceUrl + conversation.id + from/recipient + channelId + tenant per inbound; reply built from the stored ref | SPEC | unit |
| `teams-outbound-token` | outbound uses a cached client-credentials bot token (scope `api.botframework.com/.default`, refresh −60s); serviceUrl host-allow-listed (SSRF guard) | SPEC | unit |
| `teams-reply-send` | reply = message activity POSTed to `{serviceUrl}v3/conversations/{id}/activities` (markdown, tenant in channelData); returns activity id | SPEC | unit |
| `teams-working-status` | default `working_cue:"message"`: typing bubble + a SEPARATE status message, delayed/deduped, stepping 10s→minute, updated the WHOLE turn (covers the mid-turn quiet gap), deleted at finalize (fail-soft → `✓`) | SPEC | unit |
| `teams-working-card` | config-gated `working_cue:"card"`: typing bubble + an `informative` streaminfo cue that establishes the stream (first text continues it); pre-text only (no mid-turn coverage); plain typing in groups | SPEC | unit |
| `teams-stream-progressive` | `canEdit()=true` (v1): text reveals live via the Teams `streaminfo` protocol (prefix chunks, incrementing streamSequence, final message closes); ≥1.5s throttle | SPEC | unit |
| `teams-stream-fallback` | block-send when streaming can't apply — group/channel (`canEdit()=false`) or past ~4000 chars / ~45s; chunked, code-fence-safe | SPEC | unit |
| `teams-consumer-telegram-safe` | the streaming accommodations (empty cursor, no tool/heartbeat interleave, always-finalize) are **opt-in** ConsumerOptions, default off → Telegram byte-identical; hermes Teams demo unaffected | SPEC | unit |
| `teams-media-inbound` | inbound attachments downloaded with the bot bearer token to the shared mount; failure non-fatal | SPEC | unit |
| `teams-config` | `teams` config block selects the channel; `validate()` requires Teams creds vs telegram.token; `resolveAgents`→`"teams"`; connector selected in `runAgent`; coexists with telegram + hermes-service | SPEC | unit |
| `teams-delivery-resilient` | transient delivery retried (honors `Retry-After`); survived error is non-fatal — never aborts a turn | SPEC | unit |
| `teams-outbound-observable` | an outbound auth/permission failure (bad secret, missing SP → AADSTS7000229, 401/403) is LOGGED with the fix + probed at boot — a turn-safety swallow never becomes a silent no-reply | SPEC | unit |

---

## Run matrix

**Whole suite:**
- Build: `npm run build`
- Unit / contract: `npm test` (333 tests) — no tokens, no podman.
- Live (needs podman + agent image): the brokered-runtime smoke scripts
  (`npx tsx scripts/broker-smoke.ts`, `scripts/control-smoke.ts`), the **lifecycle** smoke
  (`scripts/lifecycle-smoke.ts` — `cli-up-down` adopt/stop against a throwaway container),
  the **provision** smoke (`scripts/provision-smoke.ts` — `roster-provision`: `create agent`
  brings up a real sandbox on `tonoman/claudecode` under `TONOMAN_ENV=smoke`, exec-verified,
  guaranteed teardown), and the `fixtures/devstack/` stack brought up via the agent's shim.

The unit suite covers the **substrate**, **health**, **gateway**, **roster**
(contract), **devcontainerized** (broker/policy/control), and **browser**
(provisioning/launch) tracks — all free. Live proof of the brokered runtime, the
multi-agent roster, and the browser backends needs podman + a `~/.claude` credential.

---

# v0.1 Definition of Done

- **Substrate holds:** state persists in a **private git workspace**
  (`ws-git-private`) and **secrets stay out of git** (`cfg-no-secrets`).
- **The gateway spine proves the principles:** the generic spine (gateway) runs an
  agent under the **Claude Code** harness in a podman sandbox (`gw-sandbox-boot`); a
  Telegram message routes **through Tonoman's gateway** (not the harness) and the
  reply **streams back live** with no harness/channel leakage (`gw-telegram-inbound`,
  `gw-stream-live`); memory is **substrate-owned, git-backed JSONL**
  (`gw-ephemeral-continuity`); turn controls — queue-by-default + `/steer` / `/pop` /
  `/skip` / `/interrupt` / `/new` — keep the operator in control
  (`gw-turn-enqueue` … `gw-command-new-session`). The `Connector` seam is
  channel-neutral, so a second channel plugs in with no upstream change; codex rides
  the same substrate as a further harness peer.
- Browser + config/secrets substrate preserved where on the path.
- **The devcontainerized track proves remote app development from chat:** the agent
  develops/iterates **multi-service stacks entirely from Telegram** (no CLI) over a
  **granted-mount workspace** (`~/files/<name>`), spinning up its **own containers**
  through the brokered podman runtime, and exposes a running service **on demand**
  via the brokered `tonoman expose` verb, reachable from a phone (`devcontainerized-*`).
- **Operability:** a `/` **command system** (skill commands + Tonoman platform
  commands), and **`/usage`** showing Tonoman's canonical per-turn token stats with
  a channel-neutral menu (e.g. Telegram buttons, with a text fallback on channels
  without them).
- **Agent identity & configuration (roster):** an agent is a **GUID-identified
  instance** with a **private, persistent config volume** Tonoman mounts at the
  harness's config home **without interpreting it**; auth is one thing that lands
  there, so the agent comes back configured across restarts. Agents run
  **concurrently with per-account billing**; the **same GUID** keys the git memory
  substrate. Harness-neutral by contract so codex / hermes / openclaw drop in as a
  config-home spec + login flow (`roster-*`).
