# Tonoman

**A control plane for AI agents** — "Kubernetes for agents." Tonoman is a host-side
**Node.js** program (the **gateway**) that runs a roster of agents inside **podman**
sandboxes and owns the shared **substrate**: workspace, memory, messaging, and a
brokered container-dev **runtime**. Tonoman itself is **not** a container — the agents
are; Tonoman supervises them.

Each agent is a harness (Claude Code today; codex / hermes / others behind the same
contract) wired to a chat channel (Telegram today; MS Teams next). The harness never
touches the channel — it speaks to Tonoman through a neutral envelope.

- **Behavior spec:** [`docs/scenarios/`](docs/scenarios/README.md) — specification-by-example, split into runnable tracks; the review gate before code.
- **Architecture (the how):** [`docs/architecture.md`](docs/architecture.md).
- **CLI reference:** [`docs/cli.md`](docs/cli.md).

> **Runs on Node only.** Tonoman ships as plain JavaScript with **zero runtime
> dependencies** — if you have Claude Code, you already have the Node runtime it needs.

## Getting started

Prerequisites: **Node ≥ 18** (build + run), **podman** (sandboxes), the agent image
`localhost/tonoman/dev-agent:dev`, and — for live turns — a Claude subscription to log
in with. `ANTHROPIC_API_KEY` must stay **unset** (it outranks subscription OAuth).

```sh
# 1. Build the CLI (compiles TypeScript → dist/, plain JS)
npm install
npm run build
#    then run as:  node dist/cli.js <command>
#    or link a global `tonoman`:  npm link

# 2. Create your roster config (git-ignored; holds secrets)
cp settings.roster.example.json settings.json
#    edit settings.json: per-agent name, role, container, bot token, mounts

# 3. Bring the agents' sandboxes up (podman) with each agent's config volume mounted
#    at the harness config-home (see docs/cli.md → "Provisioning a sandbox").

# 4. Authenticate each agent (writes creds into that agent's config volume; persists
#    across restarts). A fresh agent starts unauthenticated.
node dist/cli.js auth login  <agent>     # interactive subscription login
node dist/cli.js auth status <agent>     # verify: "loggedIn": true

# 5. Bring the control plane up (one process — the "gateway" service — serves the whole roster)
node dist/cli.js up --config settings.json
#    Omit --config to use $TONOMAN_CONFIG, else ~/.tonoman/settings.json (config +
#    state co-located there) — the "run as an installed user" path: `tonoman up`.
#    Stop it gracefully from another terminal with `tonoman down`.

# 6. Inspect substrate + agent health at any time
node dist/cli.js get services --config settings.json
```

Different agents can log into **different Claude accounts** — each credential lives in
that agent's own config volume, fully isolated (see scenarios roster).

## Chat commands

A message starting with `/` is a **platform command** handled by the gateway, not sent to
the agent. They control the **session** (the conversation's memory) and the **turn** (the
agent's currently-running task). Plain text is a normal turn.

**The default is queue-and-merge (Claude-Code feel).** Just message the agent — say
everything on your mind. If it's busy, your message is **queued** (and **merged** with
anything else waiting) and it gets to it after the current task. A single in-place footer
shows the queue (`🗂 Queued (N) · /pop · /skip`) — no per-message spam. **Interrupting is the
explicit exception** (`/steer`, `/pop`).

| Command | What it does |
|---|---|
| *(plain message)* | **Queued + merged**, runs after the current turn. If idle, runs now. |
| `/steer <message>` | **Interrupt now** and redirect — run `<message>` next, **keeping** the partial work as context (folds in anything queued). |
| `/pop` | Run the **queued** message(s) **now** (interrupt, keep context). |
| `/skip` | Clear the queued message(s). |
| `/interrupt <message>` | **Hard stop**: run `<message>` fresh and **discard** the interrupted turn's context (and any queue). |
| `/new` *(alias `/reset`)* | Start a **fresh session** — clears all conversation context. The prior transcript is kept on disk (dated), not deleted. |
| `/help` | List available commands. |

**Turn model:** exactly one turn runs at a time; a single merged pending slot holds the
queue. The reply **streams into one message** with a live cursor and a `🤖 working… (Nm)`
heartbeat during long quiet phases — not a spray of status posts.

> Scenarios: [`gw-turn-enqueue`](docs/scenarios/contracts/gateway.md), `gw-command-steer`,
> `gw-command-pop`, `gw-command-interrupt`, `gw-command-skip`, `gw-command-new-session`, `gw-stream-heartbeat`.

## Testing

```sh
npm test                              # unit + contract (vitest, fast, no podman)
npx tsx scripts/broker-smoke.ts       # live: policy + broker vs real host podman
npx tsx scripts/control-smoke.ts      # live: full agent→broker control-channel path
```

[`docs/scenarios/`](docs/scenarios/README.md) splits scenarios into **tracks** so you
can run one capability without paying for the full eval; each section is tagged
**DONE / WIP / SKIP** in the status table.

## Status

v0.1, in progress (Node). Implemented: messaging gateway + Claude Code harness
(gateway), substrate-owned git memory (substrate), agent roster & per-agent config
plug (roster), a per-agent browser over CDP (browser), and the **A13 brokered
container-dev runtime** — policy engine (allowlist × path-rewrite × namespacing),
host-side broker, and the file-based control channel (devcontainerized). See the status
table in [`docs/scenarios/`](docs/scenarios/README.md).
