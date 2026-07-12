# Tonoman CLI reference

`tonoman <verb> <resource> [name] [flags]` — the surface reads like **`kubectl`**: a
verb, a resource, an optional name, then flags. Build with `npm install && npm run
build`, then invoke as `node dist/cli.js …` (or `npm link` a global `tonoman`). Ships
as plain JS — no runtime toolchain beyond Node ≥ 18.

Tonoman is the host-side control plane; agents run in podman sandboxes.

**Isolated environments — `TONOMAN_ENV`.** Set `TONOMAN_ENV=NAME` once (e.g.
`export TONOMAN_ENV=dev`) and every subsequent command uses an isolated environment: config
+ state live in `~/.tonoman-NAME` and every container is **suffixed `-NAME`**, so under
`TONOMAN_ENV=dev` a `tonoman up` operates `cody-dev` and can never start/stop/create the prod
`cody`. Unset (the default): `~/.tonoman`, unsuffixed — the concept is invisible if you don't
need it. It's an **ambient knob, not a per-command flag**, so it can't be applied to `up` and
forgotten on `down`; every command echoes the env it resolved (`env: dev` / `env: default`).

**`--config FILE`** is the one explicit override (config path only). Config-path precedence:
`--config FILE` → (under `TONOMAN_ENV`) `~/.tonoman-NAME/settings.json` → `$TONOMAN_CONFIG` →
`~/.tonoman/settings.json`. The config is the roster that maps agent
**name → container + harness + channel** (see
[`../settings.roster.example.json`](../settings.roster.example.json)). The **agent is
the namespace**: an agent-scoped resource takes `-a/--agent <name>`, the way `kubectl`
takes `-n`.

| Command | Purpose |
|---------|---------|
| `up` | Bring the control plane up — runs the **gateway** service (serves the whole roster) |
| `down` | Bring the control plane down — graceful stop from another terminal |
| `get <resource> [name]` | Read: `agents` · `mounts` · `services` |
| `create mount <name> <host>` | Grant an agent a shared folder (`-a NAME`, `--ro`) |
| `delete mount <name>` | Remove a shared folder from an agent (`-a NAME`) |
| `auth <login\|status\|logout> <agent>` | Authenticate an agent's harness |
| `version` | Print the version |
| `help` | Show usage |

Resource aliases follow `kubectl` (`po`/`pods`): `agent`=`agents`, `mount`=`mounts`,
`service`=`svc`=`services`.

---

## `tonoman up` / `tonoman down`

```
tonoman up   [--config settings.json]
tonoman down [--config settings.json]
```
`up` brings the control plane up: loads the roster and runs the **gateway** service —
serving every agent concurrently until interrupted (Ctrl-C). Each agent gets its own
isolated substrate (memory, control channel, connector) and its own turn loop. Writes/
refreshes the GUID-keyed instance registry at `<state_root>/agents.json`. ("gateway"
is the name of the long-running service `up` puts up; it shows in `get services`.)

`down` brings it back down **gracefully** from another terminal (a thin client over the
gateway's loopback admin endpoint — the same local HTTP surface `get services` reads),
so on-demand resources the gateway opened (reverse-proxy ports, tunnels) are torn down
cleanly — the same path as Ctrl-C on the `up` process. It is **idempotent**: with
nothing running it says the control plane isn't up. `up`/`down` is the **control
plane's** lifecycle — it does **not** remove the durable agent containers (they hold
auth + state and outlive a restart); bringing it back `up` re-attaches to them.

## `tonoman get`

```
tonoman get agents                 # list configured agents
tonoman get agent <name>           # show one agent (role, harness, model, container, mounts)
tonoman get mounts [-a <name>]     # shared folders — grouped by agent, or one with -a
tonoman get mounts -a <name> --podman   # render that agent's `-v` bring-up flags
tonoman get services               # health of substrate services + agents (alias: get svc)
```
`get mounts` with no `-a` is a read across **all** agents, grouped by agent (mounts are
per-agent — see `cfg-mounts-cli`). `--podman` feeds one container's bring-up, so it
requires `-a`.

`get services` prints the health of every running **substrate service** (per-agent
tunnels, control channel, memory) and each **agent** (container liveness), as a table
with an overall status. It's a thin client over the gateway's local health API
(`health_addr`, default `127.0.0.1:8787`); if the gateway isn't running it says so
rather than hanging. Example:

```
KIND       AGENT      SERVICE    STATUS  DETAIL
agent      Scout      container  ok      scout-agent running
substrate  Scout      tunnels    ok      none active (on demand)
substrate  Registrar  memory     ok      <state_root>/registrar/memory
overall: ok
```

## `tonoman create mount` / `tonoman delete mount`

```
tonoman create mount <name> <host> [-a <agent>] [--ro]
tonoman delete mount <name> [-a <agent>]
```
Manage an agent's shared-folder grants (A9) in the config **by convention** — no JSON
hand-editing. The grant surfaces in the sandbox at `~/files/<name>` and becomes an
allowed broker bind-grant. The target agent resolves with no guessing: explicit `-a`,
else the only agent; with multiple agents and no `-a` it errors and lists them. Mounts
are **per-agent** — one agent's folders are not visible to another (scenarios
`cfg-mounts-cli`). A grant takes effect for a *running* sandbox only after it is
recreated with the rendered `-v` (`get mounts -a <name> --podman`).

## `tonoman auth`

```
tonoman auth <login|status|logout> <agent> [--config settings.json]
```
Runs an agent's **harness auth flow** through the substrate (scenarios
`roster-auth-volume`). Tonoman resolves `<agent>` (by name in the roster) to its sandbox
+ harness and runs that harness's flow inside the container — it uses podman underneath,
**but you never type podman**. The credential store lands in the agent's **config
volume**, so it persists across container restarts.

- `login` — interactive subscription login (needs a TTY for the code paste). For Claude
  Code: `claude auth login --claudeai`, writing the auto-refreshing
  `~/.claude/.credentials.json` into the volume.
- `status` — print auth status (e.g. `loggedIn`, account email, subscription type).
- `logout` — clear the credential store from the volume.

Different agents can authenticate to **different accounts** — credentials are isolated
per config volume.

```sh
tonoman auth login  registrar
tonoman auth status registrar     # → "loggedIn": true, "email": ...
tonoman auth logout registrar
```

---

## `tonoman create agent` (provisioning)

```
tonoman create agent <name> [--harness <kind>] [--from <agent> | --login] \
                            [--mount name=host[:ro]] … [--skill <dir>] … [--role R] [--model M] [--image <ref>]
```
Provisions a new agent **by convention** (scenario [`roster-provision`](scenarios/contracts/roster.md#roster-provision)):
mints a GUID, writes the roster entry, scaffolds its per-agent state under the
environment root, and creates the sandbox from an assembled `podman run`. It adds **no
new config-schema fields** — the image is derived from the harness, the volume layout
from the GUID under the env root.

**The image is per-runtime, Tonoman-owned.** It is chosen by the agent's `harness`
(`claude-code` → `tonoman/claudecode`), built from a Dockerfile Tonoman ships in
`images/<runtime>/` (`images/base` → `images/claudecode`). Two agents on the same harness
use the **same** image — they differ only in their per-agent identity + skills below.
`--image <ref>` is an advanced override, never required.

**The per-agent state lives under the env root** (`~/.tonoman[-<env>]/<guid>/`), mounted in:

- **`config/` → harness config-home**, read-write — persistent, Tonoman-opaque, holds
  auth + registered skills: `-v <envRoot>/<guid>/config:/root/.claude:rw`. For Claude Code
  also set `-e CLAUDE_CONFIG_DIR=/root/.claude` so *all* harness state (incl. the sibling
  `~/.claude.json` profile) stays in the volume and survives a destroy+recreate.
- **`memory/` → git-backed substrate**: `-v <envRoot>/<guid>/memory:/root/.tonoman:rw`.
- **`identity/` → the read-only AGENTS.md/persona dir**: `-v <envRoot>/<guid>/identity:/root/agent:ro`.
  This is **per-agent**, scaffolded/imported by the CLI — not a shared repo path. Editing
  an agent's persona is editing files in its `identity/` folder.
- **Granted workspace mounts** (A9), rendered from config so they can't drift:
  `tonoman get mounts -a <agent> --podman`.
- For browser-using agents, join the Chrome sidecar's network: `--network agents-net`
  (drive CDP by the sidecar's **IP**, not hostname).

Custom skills are registered into `config/skills/<skill>/` (seed-once, A11); the agent also
carries the harness's native skills. **Adopt-safe:** `create agent` is create-only-if-absent
— against a name that already resolves to a container it adopts/refuses, never `rm`s or
recreates (so it can't clobber a live agent). A fresh sandbox starts **unauthenticated**
unless seeded with `--from` — see auth below.
