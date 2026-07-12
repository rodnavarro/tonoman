[[_TOC_]]

# Tonoman Architecture

Reusable patterns referenced by the [scenario tracks](scenarios/README.md). Scenarios state
**behavior** (Given/When/Then); the **how** lives here, so multiple scenarios can
point at one pattern. Sections have stable names — scenarios link by name (e.g.
"arch § A1 Messaging gateway").

**Scope:** patterns are extracted **as scenarios are implemented**. This file
currently covers the **gateway cluster** (gateway + Claude Code harness + substrate
memory + streaming). Part A patterns (sandbox/harness, git workspace, secrets)
still live inline in their scenarios (gw-sandbox-boot, substrate, cfg-no-secrets) until a scenario needs to
share them — at which point they move here under A5+.

---

## A1 — Messaging gateway (harness-neutral)

Where the deferred **the messaging substrate** substrate is realized. Some harnesses (Claude Code,
codex) have **no channel of their own**, so messaging is a **Tonoman substrate
service**: Tonoman owns channels + creds, normalizes inbound to a neutral
**envelope**, drives the harness one **turn** at a time, and routes the streamed
reply back. hermes was native (Part A); Claude Code rides this gateway; codex
later rides the *same* substrate — harness-agnosticism made concrete.

```
Telegram ─poll─▶ ┌──────────── Tonoman messaging substrate (Go, host-side, harness-neutral) ────────────┐
 (Teams =        │  Connector          Router (owns the loop)         Turn-runner         Stream         │
  webhook,       │  • own transport    • chan+convo → agent+session   • podman exec        consumer      │
  connector #2)  │  • inbound→envelope  • read memory → build prompt    claude -p           • events →    │
   user ◀edit──  │  • send/update/      • run turn → stream → append    --output-format      send/update/ │
       (stream)  │    finalize            + commit memory               stream-json          finalize     │
                 └───────────────────────────│──────────────────────────────│─────────────────────────────┘
                       podman exec, shared mounts │           normalized events │ {text-delta|tool-progress|done}
                                    ┌─────────────▼──────────────┐
                                    │  Agent sandbox (ephemeral)  │  brain = Claude (reads the card image
                                    │  claude -p, NO --resume     │  natively via Read — no separate vision step)
                                    │  --append-system-prompt-file│  + skills/register-business-card
                                    │  mounts: workspace(git),card│    SKILL.md, reused UNCHANGED
                                    └─────────────────────────────┘
      memory + work product co-versioned in ONE mounted git repo: cards/ (output) + sessions/<convo>.jsonl (memory)
```

### Vocabulary
- **gateway** — Tonoman-owned: owns channels + creds, normalizes inbound to a
  neutral **envelope**, drives the harness one **turn** at a time, routes the
  streamed reply back.
- **connector** — one channel behind one interface (`receive→envelope` +
  `send/update/finalize`), owns its **own** transport. Telegram in v0.1; **Teams**
  is the second-connector gate.
- **router** — maps `channel+conversation → agent+session`; owns the loop (read
  memory → build prompt → run turn → stream → append+commit memory).
- **turn-runner** — the only harness-specific code: `claude -p … --output-format
  stream-json` (see A2).
- **stream consumer** — normalized events → connector `send/update/finalize`
  (see A4).
- **memory store** — JSONL transcript per conversation in the mounted git
  workspace (see A3).

### Connector contract
- **Inbound:** poll/receive its own transport, **download any media to a shared
  mount** the sandbox can read, normalize to envelope
  `{channel, conversation, user, text, media_paths[]}`. The router never sees
  channel specifics.
- **Outbound:** the abstract `send / update / finalize` contract (see A4).
- **One token = one poller** — a Telegram bot token the gateway owns exclusively;
  it cannot be shared with a hermes container.
- **Transports:** Telegram = polling (`getUpdates`); Teams = webhook (Bot
  Framework).

### Router loop (per turn)
(a) resolve `channel + conversation → agent + session`; (b) read the memory
window (A3); (c) assemble the prompt = system prompt + history window + new
message (+ media path); (d) invoke the turn-runner (A2); (e) stream the reply
back (A4); (f) append both messages to memory and commit (A3). The loop lives in
the substrate; the harness is a stateless turn-executor — no orchestrator state
machine, control stays in the model.

### Channel-abstraction invariant (design gate)
The connector interface (`receive → envelope`, `send / update / finalize`, owns
its **own** inbound transport) is the **only** thing a new channel implements.
The router, memory store, turn-runner, and stream consumer contain **zero**
channel-specific code. A channel-specific change leaking into them is a
**contract leak** and a defect — the channel analog of the harness-pluralism
rule. Verified by adding Teams (gw-teams-connector–gw-dual-channel).

_Grounding:_ openclaw already ships this Claude Code backend (the real `claude`
args, the provider stream wrappers; the `stream-json` NDJSON parser lives in
openclaw's plugin SDK). Tonoman mirrors the shape but chooses the
**substrate-history** path — **no `--resume`** (openclaw uses it), so memory stays
ours. The streaming-back patterns mirror hermes' stream consumer (cursor, throttle,
overflow-split, flood-control backoff).

---

## A2 — Claude Code harness & headless OAuth

How the **turn-runner** drives Claude Code headless, and how its brain is
authenticated.

### Turn-runner command
```
podman exec -e IS_SANDBOX=1 <agent> claude -p "<prompt>" --output-format stream-json \
  --include-partial-messages --verbose --setting-sources user \
  --dangerously-skip-permissions --append-system-prompt-file <identity>
```
- Assembled prompt on **stdin**; **no `--resume`** (memory is substrate-owned, A3).
- Parses NDJSON stdout into normalized events `{text-delta | tool-progress | done}`.
- `--include-partial-messages` yields **token-level deltas** (confirmed by
  openclaw's production config). _Smoke test asserts deltas actually stream._
- `--model` selects the Claude model from **per-agent config** (cfg-per-agent) — e.g.
  `sonnet` for cheaper runs, `opus` for best quality. **Never hardcoded.**
- `--append-system-prompt-file` injects the agent **identity** (`AGENTS.md`) every
  turn; that identity is what makes the model invoke the preset skill (without it,
  it improvises its own format).
- **`--dangerously-skip-permissions` (the sandbox is the boundary).** Headless `-p`
  has no one to approve tool calls; a per-tool **allow-list silently denies anything
  not enumerated** — including a skill's own sub-tools (e.g. `deep-research` spawns
  `Task`/sub-agents), so skills fail in non-obvious ways. The container is the
  isolation boundary, so the turn-runner skips permission prompts entirely instead of
  maintaining a brittle allow-list. `IS_SANDBOX=1` is **required** because `claude`
  refuses `--dangerously-skip-permissions` when running as root otherwise.

### Brain auth — subscription OAuth, not API key
- Brain = **Claude.ai subscription via OAuth** (the analog of hermes' codex seed,
  **NOT** an API key), injected as **`CLAUDE_CODE_OAUTH_TOKEN`** via the mounted,
  never-committed settings file (cfg-mounted-settings).
- **Hard invariants:** `ANTHROPIC_API_KEY` must stay **unset** (it outranks OAuth
  and silently bypasses the subscription); the turn-runner uses plain `-p`,
  **never `--bare`** (bare ignores `CLAUDE_CODE_OAUTH_TOKEN`). Without valid OAuth
  the agent does not run; the token is **never committed** (cfg-no-secrets).
- **Billing** runs against the Claude **subscription** (Pro/Max), not API credits.

### Headless provisioning (two paths)
- **Primary — long-lived token:** `claude setup-token` (one interactive host
  browser OAuth) mints a **1-year, inference-scoped** token; Tonoman stores it in
  the agent's never-committed settings file and injects it as
  `CLAUDE_CODE_OAUTH_TOKEN`. Container-friendly and cross-machine — no
  per-container browser step.
- **Alternative — seed the credential store:** copy the host
  `~/.claude/.credentials.json` (Linux/Windows portable, mode `0600`) into the
  sandbox's `~/.claude/` — the direct analog of seeding `~/.codex/auth.json`.
  Interactive OAuth creds **auto-refresh**; the long-lived `setup-token` does not.
- **Renewal seam:** the long-lived token expires in ~1 year → re-run
  `setup-token` and update the settings file. No auto-renew (fine for v0.1; noted
  for always-on). The same `CLAUDE_CODE_OAUTH_TOKEN` + settings mechanism is what
  the onboarding wizard will later wrap.

---

## A3 — Substrate-owned, git-backed memory

The agent's workspace is **one git repo** = its whole brain: `cards/` (work
product) **and** `sessions/<conversation>.jsonl` (memory), co-versioned in the
mounted git workspace (substrate).

- **The format is ours**, never Claude's private session files — so we never have
  to migrate off a harness internal. One event per line: role, text, timestamp,
  compact tool summary.
- **Injected every turn:** because each turn is a fresh `claude -p` (no
  `--resume`, A2), the router passes the system prompt
  (`--append-system-prompt-file`) and the conversation window (in the prompt body)
  on **every** turn. The window is the recent transcript (last N turns or a token
  budget); the agent infers the conversation sequence from this context.
- **Append + commit (auto, gentle):** after each turn the router writes both messages to the
  JSONL and **commits** (and **auto-pushes** if a remote+token are configured) — the user runs
  no git command. The cadence is event-driven (turn boundary) plus a low-frequency safety sweep
  (~30 min) and a shutdown commit — no busy timer, so it never slows the host; per-agent
  `workspace.auto_commit:false` disables it (`ws-git-autocommit`). The git log is a legible
  record of every conversation; restarting the container (gw-ephemeral-continuity) loses
  nothing — the next turn reads the committed transcript.
- **Secret-safety (never commit credentials):** `ensureRepo` writes a default `.gitignore`
  (once, never clobbered) so the automatic `git add -A` can't sweep a secret. The convention:
  agent data + the **tools the agent builds** are versioned/pushed; any key/token/PEM they need
  lives under **`secrets/`** (or `*.secret`) and is ignored (`cfg-no-secrets`). The push token
  itself is supplied via env at run time, never written to `settings.json`. Memory is configured
  with **`tonoman set memory git --remote … [--branch …] [--auto-commit …]`** (`git` is the
  memory type — room for more later); **`tonoman get memory`** shows root/remote/branch/status
  (`cfg-memory-cli`).
- **Compaction seam (deferred — same format):** when a conversation exceeds the
  window budget, older turns are **summarized** (openclaw's compaction-checkpoint
  pattern) into the same JSONL stream, behind the **same contract** — no change to
  the router or turn-runner. v0.1 ships the windowed transcript; **not on the v0.1
  critical path.**

---

## A4 — Streaming reply contract

The stream consumer turns normalized turn events into a live reply via an
abstract **`send / update / finalize`** contract.

- **Activity signal (typing).** From the moment a message is received, the
  connector shows a busy cue — Telegram's `sendChatAction: typing` — re-sent on a
  **heartbeat** (Telegram's typing state expires in ~5s) by the router while the
  turn runs, so the user sees activity through the long tool phase **before** any
  reply text exists. A connector with no activity cue no-ops. (Mirrors hermes'
  `send_typing` + `_keep_typing`.) The abstract hook is `Reply.Working`.
- **Telegram fidelity:** the reply **streams into one message** via progressive
  edits with a **configurable cursor** (default a typing cue that renders on all
  clients — `▉` shows as tofu on some); **tool-progress shows live** (e.g.
  `🔧 Bash: git commit…`); the message is **finalized** (cursor stripped) on
  `done` — the same experience as the containerized-hermes agent.
- **Formatting:** intermediate edits stream **plain** (mid-stream markdown can be
  half-formed); the **final** message renders a small markdown subset
  (`**bold**`, `` `code` ``, `*italic*`) as **Telegram HTML** (`parse_mode=HTML`),
  with a **plain-text fallback** if the generated HTML is rejected. Formatting is
  a connector concern — the router/consumer stay format-agnostic.
- **Idempotent edits.** Re-sending content identical to what's on screen is
  suppressed by the consumer, and a platform "message is not modified" rejection
  is treated as success — never a turn-failing error.
- **Robustness:** throttling + overflow-split + flood-control backoff (patterns
  from hermes' `stream_consumer.py` / openclaw's `draft-stream-loop.ts`).
- **Graceful degradation:** a connector that cannot do smooth edits **degrades to
  chunked updates** rather than breaking — **one code path**, different fidelity.
  Telegram renders the cursor stream; Teams renders correct, chunkier updates; no
  special-casing upstream.

---

## A5 — Network-exposed previews (LAN reachability)

Some agents serve a **running artifact** (a web app, an API) the operator opens
from another device. Reaching it from a phone on the same WiFi requires:

- **Publish the port to the host.** The agent's container is started with the
  preview port(s) published (`podman run -p <port>:<port>`), and the server binds
  **`0.0.0.0`** (not `127.0.0.1`) so it's reachable outside the container.
- **Firewall.** Reaching a published port from another LAN device needs an inbound
  allow on the host (e.g. a Windows firewall rule).
- **Web + API.** The same applies to an API port (a Next.js API route on the web
  port, or a separate backend port) — each port the operator or the page must reach.
- **Exposure is on-demand, not automatic.** The gateway does **not** auto-send any
  URL. The agent surfaces reachability explicitly when asked — for off-LAN access
  (the common case) via a **public tunnel** (A8), which is outbound-only and sidesteps
  the LAN/firewall constraints above entirely.

_Referenced by devcontainerized-expose-url, A8._

---

## A6 — Long-lived agents (servers that outlive a turn)

The business-card agent is **ephemeral** (gw-ephemeral-continuity: no durable in-container state,
fine to scale to zero between turns). A dev agent is the opposite — its **dev
server must keep running between turns** — so **container persistence is a
per-agent property**, not a universal rule.

- **Detached server.** The agent starts the server so it survives the turn's
  `claude -p` exit (e.g. `nohup … &` / a detached process); the **container stays
  up** between turns rather than scaling to zero.
- **Continuity.** Each turn is still a fresh `claude -p` (no `--resume`); the agent
  reconstructs *what it's building* from substrate memory (A3) + the persistent
  workspace files, and finds the server already running — a turn restart doesn't
  rebuild from scratch.
- **Supervision (seam).** If the server dies it should be restarted; v0.1 may rely
  on the agent checking/restarting on the next turn, with a substrate supervisor as
  the later seam.

_Referenced by devcontainerized-iterate (long-lived stacks across turns)._

---

## A7 — Web research (agent web tools)

Some turns need live external information (e.g. "the last 5 events this month").
The agent uses its **built-in web tools** — Claude Code's `WebSearch`/`WebFetch`
— which must be **permitted** (added to `--allowedTools`, A2) and need outbound
internet from the sandbox (already available). The heavier **headful browser
sidecar** is the alternative for sites that need real rendering/interaction/login —
the agent drives a real Chrome over **CDP** (full design: [A14](#a14--browser-substrate-per-agent-chrome-over-cdp)).
v0.1 prefers the built-in tools for light cases.

_Referenced by devcontainerized-iterate (agent web research during dev); browser substrate is A14._

---

## A8 — On-demand tunnels via a substrate control API

Exposing a running app to the public internet is **agent-initiated but
substrate-executed**: the agent calls a **`create-tunnel` skill**, which calls a
small **control API the gateway exposes to the sandbox**; the gateway opens a
**Cloudflare quick tunnel** to the requested port and returns the URL. Nothing is
exposed automatically.

- **Control channel (the agent→substrate seam).** Implemented over the **shared
  memory mount** (`~/.tonoman/control/`), not networking — on Windows/WSL podman
  forwards container→host *published* ports but not the reverse, so a host HTTP
  endpoint isn't reachable from the sandbox. The skill writes
  `requests/<port>.req`; the gateway (watching the host side) opens the tunnel and
  writes `responses/<port>.url`. Tunnels are this seam's first capability; other
  substrate calls slot in behind the same request/response channel. (An HTTP
  control API is a viable alternative where container→host networking is available.)
- **`create-tunnel` skill.** A thin, harness-neutral skill: it drops a request for
  a port on the control channel and reads back the URL. The skill knows the
  interface; it does **not** run `cloudflared` itself.
- **On-demand & per-port.** The operator (via the agent) exposes a specific port
  when wanted — a frontend and an API independently. The gateway caches one tunnel
  per port for the session.
- **Cloudflare quick tunnel.** `cloudflared tunnel --url http://localhost:<port>` —
  random `*.trycloudflare.com`, **no account/auth**, **outbound-only** (no inbound
  firewall / port-forward). Re-running mints a new URL; named tunnels are the
  durable seam.
- **Security.** Public-but-unguessable and temporary; exposure is deliberate and
  owned by the platform (so policy/visibility can live here later).
- **Config.** `agent.tunnel_bin` (path to `cloudflared`); the control channel lives
  under the memory mount. No auto-append of any URL (removed): exposure is always
  explicit via the skill.

_Referenced by devcontainerized-expose-url._

---

## A9 — Granted-mount workspace

An agent's view of the host is exactly the set of **configured mounts under one
root**: `~/files/<name>` per grant. **Access = what you grant**; nothing else is
visible. It's a unified filesystem the agent develops across.

- **Grants.** Config lists `{ name, host, read_only }`; each becomes `~/files/<name>`
  in the sandbox (podman `-v`, `:ro` when read-only). For the demo, host `~/p` →
  `~/files/p`.
- **Memory is separate.** The agent's substrate memory (A3) lives on its **own**
  mount (`~/.tonoman/`), never under `~/files/` — so sessions never pollute the
  operator's project repos and `files/` stays pure user content.
- **Multi-repo.** `~/files/**` may hold many git repos; `list-projects` discovers
  them; the agent develops in any, or `git init`s a new folder.
- **Least-privilege, UI-managed later.** Grants are fixed at container creation;
  changing them recreates the container — exactly what the Tonoman UI will do
  (toggle a grant → recreate). Per-mount read-only is the first policy knob.
- **Generalizes substrate.** The single private-repo workspace (ws-git-private) is the degenerate
  case (one grant); a dev agent grants a projects directory.

_Referenced by devcontainerized-bring-up-stack, devcontainerized-iterate._

---

## A10 — Commands & usage transparency

A message starting with `/` is a **command**, parsed by the gateway before any
model turn:

- **Skill commands** — `/<skill>` explicitly invokes one of the agent's available
  skills (Claude-Code-style). The mounted skills *are* the menu; `/help` lists them.
- **Platform commands** — Tonoman-owned, handled by the substrate with **no model
  turn** (instant, spends no tokens): `/usage`, `/help`, … exposing stats/controls
  **common to every agent**, independent of harness.
- Anything not starting with `/` is a normal turn.

**Channel-neutral menus (Teams-ready).** An interactive menu (e.g. `/usage`
Off/On/Detailed) is an abstract capability: connectors that support it render
buttons (Telegram inline keyboard + callback-query), others **fall back to a text
menu** (`/usage off|on|detailed`). The command layer never assumes buttons — the
same graceful-degradation rule as A4. Inline-keyboard/callback handling is
Telegram-specific and lives in the connector; the command layer just sees "the user
chose mode X."

**Canonical usage schema (Tonoman-owned).** `TurnEvent.Done` carries a normalized
`Usage{input, output, cacheRead, cacheCreate, cost}` parsed from the harness result
(Claude `result.usage` + `total_cost_usd`). Tonoman computes the input breakdown it
controls — **system prompt / context window / new message** (from its own prompt
assembly) — and derives **harness overhead** = total input − injected. This
canonical set is identical across harnesses (Claude Code, codex, hermes);
harness-specific detail is additive and shown only in **Detailed**.

**Footer modes.** `/usage` sets a per-conversation mode (off / on / detailed),
persisted in the agent's memory store. The stream consumer/gateway renders the
footer per mode on finalize; cumulative session totals are tracked per conversation.

_Referenced by cmd-dispatch–cmd-usage-stats._

---

## A11 — Agent roster, identity & config plug

One gateway runs a **roster** of agents. An agent is a **GUID-identified instance**,
not a harness type — so the roster holds many agents of the same harness (different
configs) and mixed harnesses side by side, all from one config.

**Generic contract + harness spec.** The agent contract is generic:
`{ GUID, harness, config-volume, connector, workspace, memory, model }`. Each harness
plugs in via a **small spec** — only the harness-specific parts:
- **config-home path** — where this harness keeps its state inside the sandbox
  (Claude `~/.claude`, codex `~/.codex`, openclaw `~/.openclaw`, …);
- **auth/login flow** — the command(s) that populate that home;
- **sandbox image** — the Tonoman-owned, per-runtime image the agent runs in
  (`claude-code` → `tonoman/claudecode`, built from `images/<runtime>/` in the repo).
The `TurnRunner` selection (A2) keys off `harness`, and so does the image: **the image
is per-runtime, not per-agent** — a business-card agent and a dev agent on the same
harness use the *same* image and differ only in their per-agent identity + skills
(below). The default `claude-code` image is the **minimal, non-privileged** sandbox
(`node:22-slim` + Claude Code + git + the baked `podman`/`tonoman` shims); it runs
containers through the **brokered host podman** (A13 Profile 1), so it never needs its
own nested/privileged podman. A new harness = one impl of this spec (config-home +
login + image); gateway/router/memory unchanged.

**The config plug (Tonoman stays opaque).** Tonoman gives each agent a private host
folder and bind-mounts it into the sandbox at the harness's config-home path:

```
~/.tonoman[-<env>]/           # default root, or ~/.tonoman-<env> under TONOMAN_ENV=<env>
  agents.json                 # instance registry: guid → {name, harness, model, connector, mounts, …}
  <guid>/
    config/                   # ↔ harness config-home (e.g. /root/.claude), rw — auth + registered skills, opaque to Tonoman
    memory/                   # git-backed substrate (A3), keyed by the same guid
    identity/                 # ↔ /root/agent, ro — the agent's AGENTS.md + persona files (per-agent, CLI-authored/imported)
    incoming/                 # media, etc.
```

The whole root is selected by **`TONOMAN_ENV`** (unset → `~/.tonoman`; `TONOMAN_ENV=dev`
→ `~/.tonoman-dev`, with every container suffixed `-dev`), so a dev environment is
isolated from prod by construction — set once, no per-command flag. **Identity is
per-agent and lives here, not baked into the image:** `identity/` holds the agent's
`AGENTS.md`/persona, written or imported by the CLI (later the Electron UI), and
bind-mounted read-only at the harness identity path (`--append-system-prompt-file`,
A2). So two agents on one harness differ **only** in `identity/` + which skills are
registered into `config/skills/`. Tonoman **does not read or validate** `config/`; the
harness owns its contents. On
restart Tonoman simply re-mounts the same folder, so the agent loads exactly as it
last configured itself. Tonoman may *seed* the volume once at create time (base
settings/identity from the agent package) but never interprets it afterward. (Shared
skill libraries are a later substrate service; agents may still create/mutate local
skills inside the volume.)

**Lifecycle: unauth → login → persisted.** A new agent's `config/` has no
credentials → unauthenticated. The operator runs **`tonoman auth login <agent>`** —
the substrate resolves the agent to its sandbox + harness and runs that harness's
login flow inside it (via `podman exec -it`; the operator never types podman). The
auth flow is part of the harness **Spec** (`LoginArgs`/`StatusArgs`/`LogoutArgs`), so
a new harness contributes its own login without touching the CLI. The flow writes the
harness's **credential store into the volume** — for Claude Code the auto-refreshing
`~/.claude/.credentials.json` (the seed-the-credential-store path of A2, *not*
`setup-token`, whose token lives in env/settings outside the volume). Because the
store is in the volume it **persists across restart and auto-refreshes in place**.
Re-auth touches only that agent's volume. _Proven live: two agents authenticated to
two different Claude accounts (distinct subscriptions), each in its own volume, and a
container destroy+recreate comes back authenticated with no re-login._

**Provisioning (`tonoman create agent`).** Standing up a new agent is **by convention,
adding zero new config-schema fields**: Tonoman mints a GUID, writes the roster entry,
scaffolds `<root>/<guid>/{config,memory,identity}`, and creates the sandbox from a
**pure `podmanRunArgs(agent, cfg)`** — the single source of truth that derives the
container name (env-suffixed), the **image (from `harness`)**, the infra mounts
(config-home, memory, identity ro), the project grants (A9), and the `tonoman.agent`
ownership label. Credential bootstrap is one of two explicit paths — **`--login`**
(fresh) or **`--from <agent>`** (seed the new agent's volume from an existing agent's,
**required to be the same harness** or it errors) — never an implicit host `~/.claude`
seed. Provisioning inherits the **adopt-safe floor** (A11/lifecycle): create is
create-only-if-absent — against an existing container it adopts/refuses, **never `rm`s
or recreates** — so it cannot clobber a live agent.

**One GUID across the substrate.** The GUID is the agent's stable identity: it keys
the config volume, the **git memory substrate** (A3), and the registry row. Names are
metadata; the GUID prevents path collisions and is the join key everywhere. The
instance registry (`agents.json`) is local for v0.1 and distinct from the catalog catalog
of installable agent *types*.

**Name & role awareness (roster-name-role).** An agent's display **name and role live in the
roster**, so one shared, skill-agnostic identity file backs differently-named,
differently-scoped agents. The gateway injects name + role into the prompt body every
turn (not via `--append-system-prompt`, which Claude Code forbids alongside the
identity `--append-system-prompt-file`). The agent identifies by its roster name and
presents itself by its role; renaming/re-scoping is a roster edit with no content change.

**Skill scoping (Claude Code).** An agent's capabilities = its **seeded custom skills**
(registered into `config/skills/` at provision via `tonoman create agent --skill <dir>`,
seed-once — the per-agent specialization) **plus the harness's native skills** (bundled in
the `claude` CLI: `code-review`, `deep-research`,
`schedule`, …). The natives are not plugins and can't be cleanly stripped
(`--disable-slash-commands` removes custom skills too; `--bare` breaks OAuth), so
specialization is expressed by *which custom skills are seeded* + the roster **role**,
not by removing natives. The OSS repo ships only **generic** skills (`build/agent/skills/`);
**org-specific** skills are content in the org's own repo and are attached by its roster's
`create agent --skill <…>` — Tonoman stays content-agnostic.

**Isolation, concurrency, namespacing.** Separate container + separate `config/`
mount → no cross-agent visibility of credentials/config/memory. Each harness's
auth-precedence footguns are enforced per-agent (Claude `ANTHROPIC_API_KEY`-unset,
A2; codex `auth.json`). Agents run as independent loops, so turns are concurrent and
**billing/rate-limits are per-account**. Shared substrate must be partitioned by
GUID: each agent gets its own **host port range**, **control channel** (A8) under its
own memory dir, and **tunnelManager** instance — two containers cannot both map the
same host port.

**v0.1 scope (simplicity).** The contract, config-plug, registry, and GUID identity
are built **harness-neutral now**, but only **Claude Code** is implemented end-to-end
(multi-account proven live). codex / hermes / openclaw are **deferred behind the
spec** — a config-home path + a login flow, no gateway/router/memory change.

_Referenced by roster-generic-contract–roster-two-agents-live._

---

## A12 — Service health & observability

The gateway runs **substrate services** that are not containers (per-agent tunnels
A8, control channel A8, git memory A3) plus supervises the **agents**. `tonoman
services` (health) makes them all visible.

**Health registry.** A small in-process `health.Registry` holds a set of **checks**
— `func(ctx) Service`, each returning `{name, kind, agent, status, detail}` with
status `ok | degraded | down | unknown`. `Snapshot(ctx)` runs them all and returns
the list. Each subsystem registers its own check, so a **new service appears in the
output automatically** (health-autoregister) — the command never enumerates service types.

**Live API + thin client.** The running gateway serves a tiny **local HTTP health
API** (default `127.0.0.1:<health_addr>`, loopback-only) returning the snapshot as
JSON: `{overall, services:[…]}`. `tonoman get services` is a **thin client** — it GETs
that endpoint and renders a table; if the gateway is down the connection fails fast
and the CLI says so rather than printing stale data (health-live-api). One resource carrying
many services, not an endpoint per service.

**Hard invariant: health checks never make an LLM call.** Every check is a pure
OS/process probe (`podman inspect`, `os.Stat`, an in-memory map read). The health
package has no access to the turn-runner and never execs `claude -p`. The *only* path
that spends model tokens is an inbound user message driving one turn — there is no
cron, scheduler, poller-driven turn, or health loop that touches the model, so an
idle roster (and each agent's subscription) accrues **zero** inference cost.

**What's checked (v0.1).**
- **Substrate, per agent:** `memory` (the git workspace exists/initialized),
  `control` (the A8 watch dir is present/writable), `tunnels` (count + URLs from the
  per-agent tunnel manager).
- **Agent, per agent:** container liveness via `podman inspect` (running → ok,
  stopped → down, inspect error → unknown).
- Skills are files, not a running service, so they are **out of scope** here — they
  surface as the agent's loaded skills, not a health line.

_Referenced by health-list–health-autoregister._

---

## A13 — Containerized dev runtime (brokered podman)

The devcontainerized track needs an agent to **build and run multi-service container
stacks** for the operator's projects. The capability is a **runtime substrate**, the
same shape as tunnels (A8): the **agent initiates, the substrate executes**. Two
profiles, differing only in *who runs the containers and at what privilege*.

### Profile 1 — brokered podman (default)
The agent's `podman`/`docker` are a thin client (`CONTAINER_HOST` → a Tonoman
**policy-proxy** unix socket, bind-mounted in from the host). The proxy enforces
policy, then forwards to a **rootless, non-privileged host podman**. Project stacks
run as **non-privileged siblings** of the agent sandbox; the agent itself stays
**non-privileged**. This preserves the A2 posture — *the agent cannot run arbitrary
podman, only allowlisted operations* — so `--dangerously-skip-permissions` inside a
confined sandbox remains sound.

- **Policy = allowlist (default-deny), three layers:**
  1. **Verb allowlist** — the safe dev set (`run`/`create`, `build`, `compose`,
     `ps`, `logs`, `exec`, `cp`, `pull`, `images`, `stop`/`start`/`rm`,
     `network`/`volume`). Unknown verb → denied. It allowlists *operations*, not
     projects, so it is **generic** across any project.
  2. **Flag policy** on privilege-capable verbs (`run`/`create`): deny
     `--privileged`, `--device`, dangerous `--cap-add`, `--security-opt`,
     `--pid/network/ipc/userns=host`; **constrain `-v/--mount` sources to grants**.
  3. **Ownership scoping** — auto-prefix names/networks/volumes `tonoman-<guid>-*`;
     `exec`/`logs`/`rm`/`stop` restricted to the agent's own resources.
- **User-extensible, owner-responsible.** A per-agent config may *widen* the
  allowlist (extra verbs/flags/devices) with an explicit risk ack. A small **hard
  floor is non-overridable**: never allow mounting the broker/podman socket,
  escaping the grant root, or touching another agent's resources — those compromise
  the platform/other tenants, not just the owner.
- **Path rewrite.** The proxy maps mount sources from the agent's view
  (`~/files/<name>`, A9) to the host view via the grant map, so bind sources
  (`./init.sql`, `appsettings.Local.json`) resolve on the host podman.
- **Secret brokering.** The proxy injects build/runtime secrets host-side
  (a private-registry token, CRM creds, PEM) — **the agent never holds them**.
- **Namespacing & ports** per agent GUID + `port_base` (A11) → multi-tenant-safe.
- **Healthchecks work**: host podman runs under the machine's systemd, so the
  healthcheck timer fires and compose `depends_on: service_healthy` is honored.
- **Seam.** Generalizes the A8 control channel. The agent-facing surface is **dual**:
  transparent `podman`/`docker` (intuition + generality + works with any project's
  existing docs) **plus** a branded **`tonoman` verb set** (`up`/`expose`/`logs`/`down`)
  that adds the value-adds — build+compose+**real-readiness-wait**+report, secret
  injection, namespacing, tunnels. The allowlist policy sits under *both* surfaces.

### Profile 2 — nested-privileged (fallback / self-contained)
The agent sandbox runs its **own** podman, nested, with `--privileged` +
`firewall_driver=none` + permissive short-names (spike-proven, 2026-06-14: native
`overlay` storage, build cache, bridge networking). Self-contained — the stack dies
with the sandbox, stock podman, no proxy — **but `--privileged` weakens the A2
boundary** (effectively root on the podman VM). Use for quick/offline/single-trusted
dev; **not the default**. Open gap: no systemd → healthcheck timer doesn't fire, so
the bring-up must **poll readiness itself**.

### Not on the onboarding path — sysbox/Kata
Purpose-built non-privileged nesting (sysbox) exists, but it is a **root host-level
install** (daemons + kernel params), **Docker-first** (podman is not a supported
engine), and **untested on WSL2** — too much friction for the "stock podman, install
and go" promise. Reserve for a *managed* Linux+Docker deployment, not self-install.

### Design gate
The **default profile keeps the host/runtime out of the agent's direct reach**: the
agent can only request allowlisted, ownership-scoped, grant-constrained operations
through the broker, and never holds the project's secrets. Any profile that hands the
agent privileged or un-brokered runtime access is an **explicit, opt-in deviation**,
named as such — never the default.

_Referenced by devcontainerized-bring-up-stack (+ the devcontainerized-* track)._

---

## Live-handoff prerequisites (v0.1 gateway)

The gateway builds and unit-tests green without any of this, but a **live** turn
(card-flow-live real / card-handoff) depends on sandbox wiring that no unit test can see. Verify
before going live:

- **Container & brain auth (gw-sandbox-boot, gw-headless-auth).** A podman container named
  `agent.container` with the `claude` CLI installed, the brain authenticated —
  `CLAUDE_CODE_OAUTH_TOKEN` set, **`ANTHROPIC_API_KEY` unset** (A2) — and the
  agent identity + the `register-business-card` skill mounted **where Claude Code
  discovers them** (so `--setting-sources user` loads the skill). If the skill
  isn't discovered, the turn silently degrades to *describing* the card instead
  of registering it.
- **Tool permission in headless `-p`.** The turn-runner passes
  `--dangerously-skip-permissions` with `-e IS_SANDBOX=1` (the sandbox is the
  boundary, A2). Confirm in-container that `claude -p` executes tools **and skills**
  (including a skill's sub-tools) without a denial; `IS_SANDBOX=1` is required or
  `claude` refuses the flag as root.
- **Shared mounts at identical paths.** The host-side connector downloads media
  to `telegram.media_dir` and the router writes that **host path** into the
  prompt; `claude` resolves it via `Read` **inside the container**. So
  `media_dir` and `workspace.root` must be bind-mounts visible at the **same
  absolute path** in host and container. The skill commits `cards/` in-container
  while the memory store commits `sessions/` from the host — one repo, two
  writers, coherent only if it's one shared mount. Consequence: run the gateway
  on the **podman host with matching Linux paths**; a Windows dev host (`C:\…`)
  will not satisfy this.

---

## A14 — Browser substrate (per-agent Chrome over CDP)

The concrete realization of A7's "headful browser sidecar." Some turns need a **real,
interactive browser** — client-rendered sites, logged-in sessions, click-through flows.
The agent drives its **own** headful Chrome over the **Chrome DevTools Protocol (CDP)**.
Spec: the [`browser`](scenarios/contracts/browser.md) track (`browser-*`). **Status: locked design
2026-06-16, review gate before code.**

**Why CDP over the alternatives.** `computer-use` (screenshot + coordinate + vision) is
slow, costly, and flaky — a small layout shift breaks it. Headless Playwright is a heavy
opinionated stack. CDP drives the **DOM/accessibility tree** directly: the agent reads a
**snapshot with stable element refs** and acts on refs (`click <ref>`/`type <ref>`) with
auto-waiting. Note Playwright *is* a CDP client — it speaks CDP underneath and adds the
snapshot/ref/auto-wait utilities — so "CDP vs Playwright" is a layering choice, not an
either/or (see below), and the ecosystem trend confirms the lane (hermes added a raw-CDP
passthrough; openclaw is CDP-first).

**Shape — per-agent sidecar, brokered, one image.**
- **`tonoman/chrome` image** (lifted from openclaw's `Dockerfile.sandbox-browser`):
  chromium + Xvfb + x11vnc + websockify + noVNC; exposes **CDP `:9222`** and **noVNC
  `:6080`**; Chrome headful under Xvfb with `--remote-debugging-port` + a persistent
  `--user-data-dir`. **`claudecode` stays unchanged** — no browser baked in (rejected:
  bloats every agent, even non-browsers; rejected: a 2nd claudecode image = a maintenance
  smell).
- **Per-agent, not shared.** Each browsing agent gets its **own** Chrome → no CDP-command
  collision, **own persistent login profile** (its own `--user-data-dir` volume, managed
  like the config/credential volume), own lifecycle, ownership-scoped by `tonoman.agent=<guid>`
  (A11). A shared Chrome was rejected: one cookie jar, agents collide, one crash takes all down.
- **Self-service via the broker (A8/A13).** The browser is a **substrate** the agent
  initiates and the substrate executes. The agent's `browser-bot` skill calls
  **`tonoman browser ensure`** through the in-sandbox shim on first use; the host **broker**
  provisions that agent's sidecar if absent (idempotent, adopt-safe), wires the agent↔sidecar
  network + profile volume, and returns the CDP endpoint. **No operator step** — setup stays
  painless. `tonoman create browser -a <agent>` is the same op, operator front door (pre-warm).
- **Driving layer.** Tonoman **core is raw CDP, zero-dep** (WebSocket JSON-RPC + `/json/version`
  discovery + loopback proxy/host-header normalization — ported from openclaw's `cdp.*` modules).
  The **`browser-bot` skill** uses `playwright-core` (`connectOverCDP`, no browser download)
  for the accessibility-snapshot + ref ergonomics — confined to the skill/image, so core stays
  pure.
- **Watch it live = noVNC.** `tonoman open browser -a <agent>` opens the sidecar's noVNC viewer
  (published host-side at create) — the agent's actual Chrome live (tabs, mouse, clicks) in any
  browser, phone included. Raw VNC `:5900` exists but noVNC is the default (no client to install).
  LAN/phone reach beyond host-loopback is a broker-forward to `advertise_host` (hardening follow-up,
  like `devcontainerized-expose-url`).
- **Interactive by default (operator-assisted login).** The viewer is **interactive** — the x11vnc
  server isn't view-only, so the operator can click/type directly in the agent's Chrome to complete
  an MFA/CAPTCHA/login the agent can't or shouldn't automate, then hand back; the **persistent
  profile keeps the session** (`browser-interactive-login`). It's a **per-viewer-session mode, not a
  server toggle** — `--view-only` opts into watch-only, and switching needs **no restart** of the
  agent or the browser.

**Two backends, one agent surface.** (1) **Sidecar** (default) — the containerized `tonoman/chrome`
above, isolated + headless-capable. (2) **Host Chrome** (`browser-host-chrome`, PROVEN) — the agent
triggers `tonoman browser ensure` and the **broker launches a real Chrome window on the operator's
host** (with `--remote-allow-origins=*` + a dedicated debug profile), for native watch/collaborate
and easy login. Because Chrome ≥111 binds CDP to **loopback only** and a container can't reach the
host's loopback, the broker runs an **in-process TCP relay** (`advertise_host`:relayPort →
`127.0.0.1:<cdp>`) — same role as the sidecar's socat / the `expose` proxy — and the agent connects
by IP. The `browser-bot` skill is identical against either backend (it reads `~/.tonoman/browser.json`).

**CLI grammar** (`VERB RESOURCE [-a agent]`, like `mounts`): `create`/`get`/`open`/`close`/
`delete browser [-a agent]` (operator) + self-scoped `tonoman browser ensure` (in-sandbox, the
agent-triggered path). Both front doors resolve to one brokered op.

**Security invariants.** Agent can't open a port/viewer (brokered, policy-gated, ledgered,
revocable); per-agent isolation (own sidecar/net/profile, ownership label); profile volume is a
credential store (secret-safe, never committed — A3 `cfg-no-secrets`); exposing the viewer is an
inbound-only forward of an already-bound port (no new agent→host reach).

_Referenced by A7 (web research), the [`browser`](scenarios/contracts/browser.md) track; reuses openclaw
(`Dockerfile.sandbox-browser` + `cdp.*`); built on A8/A13 (broker), A11 (per-agent ownership),
A2 (sandbox boundary)._

---

## References

### Icons & emoji
Tonoman's chat UX leans on a small, consistent set of emoji as status icons — the
`🤖 working… (Nm)` heartbeat (A4), `✅`/`❌` health verdicts (A12), `🔧` tool-progress,
and `🗂 Queued` (A10). They render natively on every channel (no asset pipeline), but
designs vary per platform, so we treat the **glyph meaning** as the contract, not the
pixels.

- **Robot (`🤖`) designs across platforms** — <https://emojipedia.org/robot#designs>
