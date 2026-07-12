[[_TOC_]]

# Track: substrate — workspace, state & config

Foundational substrate services every agent depends on: its **persistent
workspace** (`ws-*`) and its **configuration & secrets** (`cfg-*`). Cheap to verify
— **unit tests only, no LLM, no podman**.

> **Run:** `npm test` → the memory (gitstore) + config unit suites · **free** (spends no tokens).
> Index: [`README.md`](README.md) · Architecture: [`../architecture.md`](../../architecture.md)
>
> _Scenario IDs are stable, position-free slugs — see [the ID convention](README.md#scenario-ids)._

---

## Workspace & State (substrate) — DONE

### `ws-git-private` — Git-backed **private** workspace (default)
- Given GitHub is authenticated on the host,
- When the business-cards agent is created,
- Then Tonoman uses a **PRIVATE git repo** as that agent's workspace and manages
  it (clone on start, commit + push on change) — the user never runs a git
  command. State **survives restarts**, and the repo gives a visible **history**
  of what the agent did. The repo MUST be private.
- The repo is named by a **stable id**, not the display name — `tonoman-<guid>`
  (each agent has an immutable `agent_id` GUID separate from its mutable display
  name). **Renaming the agent later does NOT change or move the storage**; the
  repo keeps its `tonoman-<guid>` identity.

### `ws-local-fallback` — Local-folder fallback
- Given no GitHub account (or offline),
- Then the same **workspace API** works against a local host folder backend
  instead — zero-friction, no history/portability. (Pluggable backend, same
  contract.)

### `ws-folder-convention` — Folder convention
- Then the workspace uses a stable convention (e.g. `cards/`, `index.md`,
  `memory/`, `sessions/`) so content is predictable across agents and harnesses.

### `ws-session-dated` — Dated transcript files + discoverable state — DONE (dated files); state-root pointer TODO
- Given the substrate-owned, git-backed transcript (A3),
- Then each conversation's transcript is written as **dated files** (e.g.
  `sessions/<conversation>/<YYYY-MM-DD>.jsonl`) so **daily cut-offs are explicit** when
  the workspace repo is pushed to GitHub for persistence — a reader can see exactly which
  day each slice of memory belongs to (today it is one ever-growing `<conversation>.jsonl`
  with no visible cut-off).
- And the per-agent **state root** (memory, sessions, registry) is **discoverable**:
  documented and located so an operator can find an agent's `<agent>/memory/sessions`
  without spelunking (today it is buried under `~/.tonoman/<…>`, with no pointer from the
  repo root next to `settings.json`).
- The read path still injects the recent window — dating the files is a storage/clarity
  concern, not a change to what a turn sees.
- **Implemented** (`gitstore.ts`): `sessions/<conv>/<YYYY-MM-DD>.jsonl` with a `CURRENT`
  pointer naming the active session; a **legacy** flat `sessions/<conv>.jsonl` is read as a
  fallback so upgrading never drops existing memory. The `/new` command
  (`gw-command-new-session`) rotates `CURRENT` to a fresh dated session — same storage,
  starts a new file. _Remaining: a discoverable state-root pointer next to `settings.json`._

### `ws-git-autocommit` — Memory auto-commits through the day, gently — DONE
- Given the substrate-owned git memory (A3) where the agent's non-secret work product +
  self-built tools accumulate,
- Then Tonoman commits and (when a remote+token are configured) **auto-pushes** on its own —
  the operator never runs git. The cadence is **event-driven, not a busy timer**: a commit at
  **every turn boundary** (`router.ts` — the moment memory actually changed), plus a
  **low-frequency safety sweep** (~30 min: `git add -A` + commit, a no-op when nothing changed),
  plus a **commit on graceful shutdown**. There is no tight polling, so idle cost is negligible
  and it never slows the host.
- Per-agent **`workspace.auto_commit: false`** disables the automatic cadence (manual commits
  still work); **`workspace.branch`** sets the push target (default: current branch).
- The default `.gitignore` (`cfg-no-secrets`) guarantees the automatic `git add -A` can never
  include a secret.
- _Implemented: turn-end commit (`router.ts`), sweep + shutdown commit (`gateway.ts`),
  push-to-branch (`gitstore.ts`). Live by running the gateway._

---

## Configuration & Secrets — DONE

_Applies across every track — these are the rules for how settings and secrets
flow into agents._

### `cfg-mounted-settings` — Mounted, never-committed settings
- Settings come from a **mounted, never-committed** file; loaded into the agent
  env on start (survives restarts); skills consume them. Telegram token + codex
  auth load this way today.

### `cfg-per-agent` — Per-agent config is first-class
- **Per-agent** config is first-class (each agent's channel/bot, model, preset
  skills); only `*.example.*` is committed.

### `cfg-no-secrets` — Secrets never land in git — DONE
- Secrets **never land in git** — neither Tonoman's own config nor an agent's pushed memory repo.
- Tonoman config: only `*.example.*` is tracked; the real `settings.json` (tokens) is git-ignored (`cfg-per-agent`).
- **Agent memory repo (the always-pushed one):** `ensureRepo` writes a default `.gitignore`
  (`gitstore.ts` `SECRET_GITIGNORE`) the first time, so the automatic `git add -A`
  (turn-end + auto-push, `ws-git-autocommit`) can **never** sweep a credential into a commit.
  The convention: anything secret lives under **`secrets/`** or is named **`*.secret`** (also
  `.env`, `*.token`, `*.key`, `*.pem`, `*.credentials.json`) — the agent's data and the tools it
  builds ARE versioned/pushed; the keys those tools need are NOT. An agent that maintains its own
  `.gitignore` is left untouched.
- _Implemented + unit-tested (`gitstore.test.ts`): the `.gitignore` is written, never clobbered,
  and a file under `secrets/` is provably untracked while data + tools are tracked._

### `cfg-mounts-cli` — Manage an agent's shared folders from the CLI — DONE
- Given an operator wants to grant an agent a host folder (it surfaces in the sandbox at
  `~/files/<name>`, A9, and becomes an allowed broker bind-grant),
- When they run **`tonoman create mount <name> <host-path> [--ro] [-a NAME]`**,
- Then Tonoman edits **that one agent's** `mounts` in the config **by convention** (no
  hand-editing JSON, no hardcoded paths): it resolves the target agent (the only one, or
  `-a/--agent`), upserts the mount by name, and writes the config back. **Mounts are PER-AGENT** —
  they live under `agents[<name>].mounts` and the broker builds each agent's grants from **its
  own** mounts only, so one agent's folders are **not** visible to another (separate sandboxes,
  separate grants — there is no global mount). **`tonoman get mounts`** shows grants **grouped by
  agent** (so the per-agent nature is always visible) with their `~/files/<name>` mapping (or one
  agent with `-a NAME`); **`tonoman delete mount <name> [-a NAME]`** removes one from a single agent.
- And **`tonoman get mounts -a NAME --podman`** renders the `-v host:/root/files/<name>[:ro]`
  flags from the config, so a sandbox bring-up **derives its bind mounts from the same source of
  truth** — the grant list and the container's `-v` can't drift. (Adding a grant takes effect for
  a *running* sandbox only after it is recreated with the rendered `-v`.)
- The `~/files/<name>` convention lives in **one** place (`agentMountPath`), shared by the
  CLI and the broker grant builder. _Unit-tested (`mounts.test.ts`); the CLI grammar that drives
  these — `get`/`create`/`delete`, the `-a` namespace — is the [`cli`](cli.md) track._
- _Arch: A9 (agent-view mount path), A13 (broker grants). Pairs with `cfg-per-agent`._

### `cfg-ssh-key` — Grant an agent a git SSH key (config-driven, host-agnostic) — SPEC
- Given an operator wants an agent to use **git over SSH** (pull/push), and the **base image carries
  an SSH client** (`openssh-client` in `images/base`, so **every harness inherits it**, like `git`),
- When the agent's config declares **`ssh_key: <host path to a private key>`** (per-agent,
  `cfg-per-agent` — nothing hardcoded; any agent, any git host),
- Then provisioning makes that key usable in the sandbox **without ever exposing it world-readable or
  committing it**: it is mounted as a **podman secret at `/root/.ssh/id_rsa`, mode `0600`** — a plain
  bind mount can't (on Windows it lands `0777` and `ssh` **refuses** a world-readable key; the secret
  carries the right mode and keeps the key out of any `-v` world-readable path and out of git,
  `cfg-no-secrets`). Git is pointed at it via **`GIT_SSH_COMMAND`** = `ssh -o IdentitiesOnly=yes -i
  /root/.ssh/id_rsa -o StrictHostKeyChecking=accept-new`, so **any** SSH git remote works on first
  connect — no per-host `known_hosts` pre-seed, no hardcoded host.
- The host path is read **only at provision time** to create the secret; it is **never** written into
  `settings.json` nor the agent's pushed memory. Recreating the sandbox re-applies the secret mount
  from config (grant and container can't drift, like `cfg-mounts-cli`).
- **Generic + harness-agnostic:** the SSH client is in the **base** image and `ssh_key` is a plain
  config field — a card agent, a dev agent, or a research agent get git-over-SSH the same way.
- _Arch: A11 (per-agent provisioning), A2 (sandbox boundary, secret-mounted not baked), `cfg-no-secrets`.
  Pairs with `cfg-mounts-cli`. Spike-verified: a podman secret mounts the key `600 root:root`._

### `cfg-mount-target` — A mount can target an explicit sandbox path — SPEC
- Given some host folders must land at a **specific path** the tooling expects — e.g. AWS creds at
  `~/.aws`, not under `~/files/<name>` (`cfg-mounts-cli`'s default),
- When a mount declares an optional **`target`** (an absolute sandbox path),
- Then provisioning binds the host folder **there** (`-v <host>:<target>[:ro]`) instead of
  `~/files/<name>`; without `target` the default `~/files/<name>` is unchanged. The convention still
  lives in one place (the bind render), so the grant list and the container's `-v` can't drift.
- **Secret-aware:** prefer **read-only** for a credentials dir so the agent reads but cannot mutate
  the operator's config; the host path is never written to git (`cfg-no-secrets`). **Exception:** a
  tool that writes a cache under the dir needs **read-write** — e.g. the **AWS CLI** caches
  assume-role creds under `~/.aws` and fails `read-only file system` otherwise; mount `.aws` **rw**.
  Pairs with `cfg-ssh-key` (same "land a host secret where the tool expects it"; SSH there needs a
  0600 secret because it enforces key perms — `.aws` doesn't).
- _Arch: A9 (mount render), A11. Generalizes `cfg-mounts-cli`._

### `cfg-agent-tools` — Tools: a per-agent setup list + the agent installs the rest — SPEC
- Given the base image stays **thin** (no per-tool bloat) but agents need varied tooling (AWS CLI,
  dotnet, jq…), and a pinned tool name can rot (renamed/removed package),
- When an agent declares an optional **`setup`** list (install commands), Tonoman runs it **once at
  `create`** — baked into the container layer (persists across stop/start; only re-run on a
  destroy+recreate), **not** per turn — so known, always-needed tools are **pre-warmed** and the agent
  doesn't spend its first turn installing them.
- And **the agent is told (in its identity) it may install any tool it needs at turn time** — the
  sandbox **is** the boundary and it runs as root with permissions skipped (`gw-sandbox-boot`), so a
  missing tool is **self-healing**: it `apt-get`/`pip install`s on demand. This makes `setup` an
  **optimization, not a hard dependency** — a failed/renamed package in the list degrades to "the
  agent installs it during the turn," never "stuck."
- **What we DON'T do:** bake tools into the base/harness image (every agent would pay for every
  tool), nor build a per-agent derived image (reintroduces image maintenance) — until a heavy,
  slow-to-install toolchain justifies it.
- _Arch: A2 (sandbox is the boundary ⇒ agent may install), A11 (per-agent setup). Pairs with
  `cfg-mount-target` (e.g. Cody: mount `.aws` + `setup` the AWS CLI ⇒ it mints its own CodeArtifact token)._

### `cfg-memory-cli` — Configure an agent's memory from the CLI — DONE
- Given an operator wants their agent's memory **git-backed + pushed** (so non-secret work
  persists across machines / is visible on GitHub),
- When they run **`tonoman set memory git --remote <url> [--branch <b>] [--auto-commit on|off] [-a NAME]`**,
- Then Tonoman writes the **non-secret** fields (`workspace.remote`/`branch`/`auto_commit`) into
  **that one agent's** config. **`git` is the memory TYPE** — the grammar `set memory <type>` leaves
  room for other memory backends later. The **push token is a secret**: it is **never** written by
  the CLI nor into `settings.json`; it is supplied via env at gateway-run time (until present,
  pushes are skipped and commits stay local — `cfg-no-secrets`).
- And **`tonoman get memory [-a NAME]`** shows each agent's memory **root**, **remote**
  (credential-stripped), **branch**, **auto-commit**, and live **git status** (clean/dirty +
  last commit) — a thin read, grouped by agent.
- _The `set`/`get` verbs + the `memory` resource are unit-tested in the cli resolver; the
  read/write handlers are smoke-verified. Pairs with [`ws-git-autocommit`](#ws-git-autocommit)
  and `cfg-no-secrets`._
