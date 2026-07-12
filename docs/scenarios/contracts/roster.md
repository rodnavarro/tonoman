[[_TOC_]]

# Track: roster — agents as a generic config plug (multi-tenant, multi-harness)

An agent is a **GUID-identified instance**. Tonoman gives each agent a **private,
persistent config volume** on the host and mounts it into the sandbox at **whatever
location its harness keeps state** (Claude Code → `~/.claude`, codex → `~/.codex`,
openclaw → `~/.openclaw`, …). Tonoman does **not interpret** the contents — it only
connects the dots (host folder ↔ container mount) and tracks the agent (GUID +
metadata). **Auth is one of the things that lands in that volume**; so is every
other harness setting. This makes "different config per agent" — different
accounts, models, MCP servers, even different harnesses — a **single mechanism**,
not a feature per knob.

> **Run:** `npm test` → `registry`/`harness` units (the generic-contract, config-volume,
> isolation, GUID-identity, and name-role checks). The live multi-agent proofs are **WIP**.
> Index: [`README.md`](README.md)

> **Architecture (the how):** [§ A11 Agent roster, identity & config plug](../../architecture.md#a11--agent-roster-identity--config-plug) ·
> [§ A2 Harness & brain auth](../../architecture.md#a2--claude-code-harness--headless-oauth) ·
> [§ A3 Substrate-owned memory](../../architecture.md#a3--substrate-owned-git-backed-memory) ·
> [§ A1 Messaging gateway](../../architecture.md#a1--messaging-gateway-harness-neutral).
> Scenarios state behavior only.

---

## Agents as a generic config plug — WIP

### `roster-generic-contract` — Generic agent contract, harness-specific spec — DONE
- The **agent contract is generic**: every agent = `{ GUID, harness, config-volume,
  connector, workspace, memory, model }`.
- Each **harness** supplies only what's harness-specific via a small spec: **where**
  its config home lives inside the sandbox, and **how** its auth/login flow runs.
- Adding an agent of an **existing** harness is **config only**; supporting a **new**
  harness (codex, hermes, openclaw, opencode) is **one implementation of that spec** —
  the gateway, router, and memory are **unchanged**. Model stays per-agent, never
  hardcoded (`cfg-per-agent`).
- _Arch: A11, A2._

### `roster-config-volume` — Persistent config volume, Tonoman stays opaque — DONE
- Each agent gets a **private host config folder** mounted into its sandbox at the
  harness's config home. **Tonoman does not know or validate what's inside** — the
  harness writes whatever it needs to be happy at load.
- The volume **survives stop / restart / recreate**, so a configured agent stays
  configured with no re-setup. Tonoman just re-mounts the same folder.
- At create, Tonoman may **seed** the volume once from the agent package (base
  settings, identity); afterward it never re-reads it. (Shared skill libraries are a
  later substrate service — agents may still create/mutate local skills in the
  volume.)
- _Arch: A11._

### `roster-provision` — `tonoman create agent` stands a new agent up — WIP
- Given an operator wants a **new** agent (e.g. a business-card agent),
- When they run **`tonoman create agent <name> [--harness <kind>] [--from <agent>|--login] [--mount name=host[:ro]] [--skill <dir>] …`**,
- Then Tonoman **provisions it end-to-end, by convention** (no hand-built `podman run`,
  no JSON hand-editing): it mints a **GUID**, writes the agent's **roster entry**
  (`roster-guid-identity`, `cfg-per-agent`), **scaffolds its per-agent state** under the
  active environment root, and **creates its sandbox** from an **assembled `podman run`** —
  adding **zero new config-schema fields** (image derives from harness, the volume layout
  derives from the GUID under the env root; see below).
- **Image is per-runtime, Tonoman-owned — not per-agent.** The sandbox image is chosen by the
  agent's **harness** (`claude-code` → `tonoman/claudecode`), built from a Dockerfile Tonoman
  ships in `images/<runtime>/` (`images/base` → `images/claudecode`, later `images/hermes`).
  The **harness spec owns the image ref** alongside its config-home + login flow
  (`roster-generic-contract`). The `claude-code` image is the **minimal, non-privileged**
  `tonoman/claudecode` (`node:22-slim` + Claude Code CLI + git + the baked-in `podman`/`tonoman`
  shims). So **a business-card agent and a dev agent on the same harness use the same image** —
  they differ only in their per-agent identity + skills (next bullet), never in a per-agent
  image. **No privileged image on the onboarding path:** a dev agent runs containers through the
  **brokered host podman** ([`devcontainerized`](devcontainerized.md), A13 Profile 1, the proven
  default) and stays **non-privileged** — it does not need its own nested podman. The
  privileged podman-in-podman base (A13 Profile 2) is an **explicit opt-in fallback** reachable
  only via `--image <ref>`/profile override — never the default `create agent` image.
- **Identity is per-agent and lives under the env root — created/imported, never baked into
  the image.** `create agent` scaffolds, under the active environment (`cli-env`,
  `~/.tonoman[-<env>]/<guid>/`): **`config/`** (→ harness config-home, rw — auth + registered
  skills), **`memory/`** (→ git-backed memory, rw), and **`identity/`** (→ the read-only
  AGENTS.md/persona dir, ro). The **only** difference between two agents on one harness is the
  files in their `identity/` and the skills registered into `config/skills/` — both plain
  folders the CLI (and, later, the Electron UI) writes or imports. _This replaces the old
  shared-repo identity mount (`<repo>/build/agent/roster`) with a per-agent, per-env folder,
  so identity is editable/importable without rebuilding the image._
- **Skills are registered at create, content stays out of the platform.** `--skill <dir>`
  (repeatable) seeds a skill folder into the new agent's `config/skills/<name>/` (seed-once,
  A11). The OSS repo ships only **generic** skills (`build/agent/skills/` — e.g. a baseline
  `register-business-card` that reads a card → appends a CSV → asks what to do); an
  **org-specific** skill (e.g. an org's domain-specific classifier) lives in that org's content
  repo and is attached by its **roster's `create agent --skill <…>` sequence** — Tonoman
  never contains it. After `--from` so an explicitly-registered skill wins.
- The assembled run also carries the **project grants** from its `mounts` (`cfg-mounts-cli`,
  `~/files/<name>`) and the **ownership label** `tonoman.agent=<guid>` (A11). The baked-in
  shims (`podman`, `tonoman`) come with the image.
- **Credential bootstrap — two explicit paths, a harness-match contract.** Auth is the
  onboarding friction, so `create agent` resolves creds **one of exactly two ways** (no
  implicit host `~/.claude` seeding):
  1. **`--login`** — a **fresh login**: the agent starts unauthenticated and the operator
     runs that harness's login flow (`roster-auth-volume`) — a dedicated, per-agent account.
  2. **`--from <agent>`** — **seed from an existing agent's** config volume (a one-time
     copy into the new agent's **own** volume, keeping volumes isolated,
     `roster-isolation`), so **create → up → it just works**, same account.
- **The seed contract (`--from`): same backend required.** Seeding is only valid when the
  source agent's **harness matches the new agent's** (and matches the new agent's declared
  harness) — you cannot pour a Claude credential store into a codex/openclaw home. A
  mismatch **errors** (`cannot seed creds from "<src>" (<harness-a>) into "<new>"
  (<harness-b>): harness mismatch`). Today only Claude exists so it always matches, but the
  **contract is defined now** so a second harness is safe. _Caveat to verify live with
  `--from`: a shared account whose OAuth refresh rotates can stale a sibling copy — use
  `--login` for truly independent accounts._
- **SAFETY FLOOR — adopt, never destroy** (shared with [`cli-up-down`](cli.md#cli-up-down)):
  create is **create-only-if-absent**; against a name that already resolves to a container it
  **adopts/refuses — never `rm`s or recreates** — so re-running it on a live agent can't
  clobber it. The live smoke runs only under a throwaway env (`TONOMAN_ENV=smoke`, `cli-env`),
  so it physically cannot touch the prod roster.
- _The `podman run` argv is assembled by a **pure `podmanRunArgs(agent, cfg)`** (the
  single source of truth for image + infra mounts + grants + label — parallels
  `podmanVolumeArgs`), **unit-tested** for free. The real provision → up → exec → down
  cycle is proven by a live smoke against a **throwaway agent** under `TONOMAN_ENV=smoke`
  (temp env, guaranteed teardown, target asserted `≠ cody`). Generifies the manual
  bring-up the machine runbook documents today. **Build pending.**_
- _Arch: A11 (provision = GUID + roster entry + sandbox), A9/A13 (grants), A2 (auth)._

### `roster-auth-volume` — Auth flow populates the volume (the auth subsection) — DONE
- A freshly created agent starts **unauthenticated** — its config volume is empty of
  credentials.
- The operator runs **`tonoman auth login <agent>`** — a **Tonoman CLI command**, not
  a raw container command. Tonoman resolves the agent to its sandbox + harness and
  runs that harness's login flow inside it (it uses podman underneath, but the
  operator never types podman). The flow writes the harness's **credential store into
  the volume** (Claude Code: the auto-refreshing `~/.claude/.credentials.json`).
  Because that store lives in the routed volume, the agent becomes authenticated **and
  stays authenticated across restarts** — no re-login, and the credential
  **auto-refreshes in place**. Companion commands: **`tonoman auth status <agent>`**
  and **`tonoman auth logout <agent>`**.
- A token kept in **settings/env** (e.g. Claude `setup-token`) is a valid brain-auth
  path (A2) but lives **outside** the opaque volume; the config-plug model uses the
  **in-volume credential store** so persistence is uniform.
- Re-authing touches **only that one agent's** volume. Each harness's auth footguns
  are enforced per-agent (e.g. Claude's `ANTHROPIC_API_KEY` stays unset, A2).
- **This is where "different subscriptions" lives:** agent A logs into account A,
  agent B into account B — separate volumes, separate accounts, no shared global login.
- _Arch: A11, A2._

### `roster-auth-headless` — Authenticate without a local browser (URL out, code in) — DONE
- Given the operator **can't open a browser where the agent runs** — a remote/headless host,
  or only a phone in hand — and the harness login is an interactive **TUI** (needs a PTY),
- When the operator runs **`tonoman auth login <agent> --headless`**,
- Then Tonoman starts that harness's **own login inside the agent's sandbox under a PTY**,
  captures the OAuth **URL**, and prints it — **no interactive TTY at the operator, and no
  hand-run scripts in the container** (this is the supported path). The login process stays
  alive (it holds the PKCE verifier) waiting for the code.
- And the operator authorizes the URL **on any device**, copies the returned code, and runs
  **`tonoman auth code <agent> <code>`** — Tonoman delivers it to the waiting login, which
  completes the exchange and **persists the creds into the agent's own config volume**
  (`roster-auth-volume`); the command then **verifies via `auth status`** and reports the
  logged-in account (not a guess).
- **Per-agent, not shared:** each agent logs into its **own** account = its **own
  refresh-token chain**, so agents never share one credential and rotate-invalidate each other
  (the concrete fix for the `401` we hit seeding one account across three agents).
- **Security:** the code is single-use; the URL/creds belong to that agent; nothing secret is
  committed (the credential store stays in the opaque volume, A2 footguns enforced per-agent).
- _Tested: the URL extractor (`extractAuthUrl`) is pure + unit-tested against a real captured
  PTY transcript; the orchestration (`startHeadless`/`submitCode`) is live-verified. Arch: A2
  (harness auth in the sandbox), A11 (per-agent volume). Pairs with `roster-auth-volume`._

### `roster-auth-remote` — The same headless login works across the k8s split — DONE
- Given an agent whose harness is **remote** (`claude-code-http`: the agent runs in its own pod,
  the gateway drives it over HTTP) — so there is **no podman and no shared filesystem** between
  the operator/gateway and the agent,
- When the operator runs the SAME **`tonoman auth login <agent> --headless`** and
  **`tonoman auth code <agent> <code>`**,
- Then the flow behaves **identically** to `roster-auth-headless` — URL out, code in, creds land
  in the agent's own store — because the login is driven over the **agent's own HTTP runtime**
  (`POST /auth/login`, `POST /auth/code`, `GET /auth/status`) instead of `podman exec`. The
  operator's command is unchanged; only the transport differs.
- **The agent owns its login.** The PTY/FIFO dance runs **inside the agent**, which is the only
  half that has `claude` and the credential store — the same reason `/usage` moved agent-side.
  The gateway never holds the credential and never needs a container runtime.
- **The login argv comes from the AGENT's own harness spec, never from the wire.** `/auth/login`
  takes no command from the caller — otherwise it would be a remote-exec primitive. Bearer-gated
  like `/turn` and `/usage`.
- **Outcome-true, not status-true:** success requires the credential file to have actually been
  **(re)written** (mtime/size changed) AND `auth status` to report logged-in — `auth status`
  alone would read a PRE-EXISTING credential and report a false ✓ on a login that never happened.
- **One login at a time:** a second `/auth/login` supersedes any pending one (the stale PKCE
  verifier is useless); `/auth/code` with no login in flight is a clean `409`, not a hang.
- _Why this exists: the headless flow was written for `podman exec` and silently did not exist
  across the split — the same gap class that already bit media (bytes on the wire), the broker,
  and account-usage (`/usage`). Closing it means an agent in k8s is authenticated with the
  product, not with hand-run `kubectl exec` incantations._
- _Tested: `extractAuthUrl`/`looksLoggedIn` stay pure + unit-tested; the HTTP auth ops are
  unit-tested against a fake agent server (URL out, code in, 401 unauthorized, 409 no-login,
  false-✓ rejected when the cred didn't change). Arch: A2, A11, A15 (the k8s split)._

### `roster-isolation` — Isolation between agents — DONE
- Each agent's **config volume + workspace + memory + container** are private; no
  agent can read another's config, credential, work product, or memory.
- GUID-named host paths prevent collisions; shared substrate services (tunnel ports,
  control files, A8) are **namespaced per agent**.
- _Arch: A11, A3, A8/A9._

### `roster-guid-identity` — One GUID identity across config, memory, and messaging — DONE
- Tonoman tracks running agents in a **local registry keyed by GUID** (a JSON store
  for v0.1) with metadata (name, harness, model, connector, mounts). Tonoman never
  needs to understand the volume's contents — only this registry.
- The **same GUID** keys the agent's **git memory substrate** (A3) and its config
  volume — **one identity** spans config, memory, and messaging. (Distinct from the
  `catalog-*` scenarios, which list installable agent *types*; this is the *instance*
  registry.)
- _Arch: A11, A3._

### `roster-name-role` — Agent knows its name and role (from the roster) — DONE
- An agent's **name and role live in the Tonoman roster**, not in harness/identity
  content — so one shared, skill-agnostic identity backs differently-named,
  differently-scoped agents.
- The substrate **injects name + role every turn**, so the agent **identifies by its
  roster name** and **presents itself by its role** (e.g. Registrar: register cards;
  Scout: explore git projects + browse via Chrome). Renaming/re-scoping is a roster
  edit, no content change.
- **Skill reality (Claude Code):** an agent's capabilities = its **seeded custom
  skills** (the per-agent specialization — e.g. `register-business-card` only in
  Registrar's volume) **plus the harness's native skills** (bundled in the `claude` CLI:
  `code-review`, `deep-research`, `schedule`, …), which can't be cleanly stripped. The
  roster **role** keeps each agent presenting itself by purpose rather than listing
  ambient harness tooling.
- _Arch: A11 (roster holds name + role; gateway injects them)._
