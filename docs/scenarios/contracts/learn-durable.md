[[_TOC_]]

# Track: learn-durable — an agent persists what it learns, routed to the right git

An agent should be able to internalize a correction from chat so it survives `/new`, a restart, and a
full pod replacement — without a developer, a repo checkout, or a tonoman session. The user just says it;
the agent persists it.

The thing that makes this durable (and NOT the conversation window, which dies on `/new`) is a **memory
substrate**: a single `persist(request)` seam that writes the change to **git** and re-loads it every
session. The substrate is adapter-based; the first (and today only) adapter is **git**. A durable write
is routed to a destination by **ownership scope**:

- **Personal** — the agent's own memory / own skills → the agent's **own brain repo**, **commit to
  `main`** + push. No gate: it's the agent's private brain.
- **Shared** — a skill in the org's **shared skill registry**, assigned to the agent → **open a pull
  request** against the org config repo. Reviewed, merged, re-pulled. No agent rewrites a shared skill live.

The shared registry is not a someday-thing: it is a **configured git repo** (`config_repo`, e.g.
`github.com/example-org/tonoman-config`) holding `./skills` (the registry), `assignments.yaml`
(agent → skills), and `./org` (org-wide knobs). This repo is *declarative agent knowledge* — distinct
from the deploy repo (helm/Argo/secrets), which stays elsewhere.

> **Worked example** (used throughout): the user tells Sapien *"from now on, tag every receipt to one of
> my three LLCs via `--link`."* That's a change to a **shared** skill (`finance-intake`) → it opens a PR
> on `example-org/tonoman-config`. A private preference (*"call this landlord 'Gainesville'"*) is **personal**
> → it commits to Sapien's own brain on `main`.

> **Run:** `npm test` → learn-durable unit/contract tests (routing, git adapter dispatch, confirm gate).
> FREE — no tokens, git is faked. Index: [`README.md`](README.md)

## learn-route-by-scope — a durable write picks its git by ownership

- **Given** a durable-write request `{ scope, target, content, reason }`
- **When** `scope = personal` → route to the agent's **own brain repo**, mode = **commit-to-`main`**
- **And when** `scope = shared` → route to the org **`config_repo`**, mode = **open-PR**
- **Then** the substrate NEVER commits a shared skill directly, and NEVER turns a personal note into a PR.
- **And** the substrate returns a **receipt** — a commit SHA (personal) or a PR URL (shared) — that the
  agent reports back to the user (so a durable change is never silent).

## learn-personal-commit — a personal learning lands in the agent's own git on main

- **Given** the agent learns a private policy or fact (e.g. a preferred vendor label, a per-user habit)
- **When** it persists with `scope = personal` to its brain repo's always-loaded policy file
  (`LEARNED.md`)
- **Then** the git adapter appends/edits the entry, **commits to `main` and pushes**, returns the SHA.
- **And** `LEARNED.md` is a file the runtime **re-injects every session** (alongside the identity), so the
  rule is in force from the **next turn** on (atomic — never mid-turn).

## learn-shared-skill-pr — a shared-skill change is proposed, not self-applied

- **Given** `finance-intake` is a **shared** skill assigned to the agent (`assignments.yaml`), living in
  `config_repo/skills/finance-intake`
- **When** a change to the skill's procedure is persisted (`scope = shared`)
- **Then** the git adapter **opens a PR** against `config_repo` on a fresh branch (skill diff + reason),
  and returns the **PR URL**; the agent tells the user *"proposed — pending review"*.
- **And** the agent's **live behavior is unchanged** until the PR merges and the registry is re-pulled —
  shared capability changes go through review, not unilateral self-edit.

## learn-registry-from-config — the shared registry is a configured repo, not vapor

- **Given** `config_repo` is set on the gateway config
- **Then** shared skills are resolved from `config_repo/skills`, an agent's shared set from
  `config_repo/assignments.yaml` (`agent → [skills]`), and shared-skill writes target that repo.
- **And** an agent whose org has **no `config_repo`** is **personal-only**: a `scope = shared` write is
  refused with an explicit "no shared skill registry configured" (never silently dropped, never
  mis-routed to the agent's own repo).

## learn-confirm-before-write — durable writes are confirmed, destination shown

- **Given** a durable write is about to happen
- **When** the agent proposes it, it states **what** and **where**: *"commit to your brain (`main`)"* vs
  *"open a PR to the shared finance-intake skill"* — the scope and destination are explicit.
- **Then** it writes only after the user confirms; a decline is a clean no-op (no silent self-modification).

## learn-durable-across-new-and-restart — the whole point

- **Given** a personal rule was committed to the brain repo (or a shared PR merged + re-pulled)
- **When** the user runs `/new`, or the agent/pod restarts (re-clone of brain + `config_repo`)
- **Then** the rule is **still applied** — re-injected from the git-backed file — because it never lived
  in the conversation window.

## Ownership axis (why scope, not artifact type)

The routing axis is **ownership**, not "memory vs. skill":

| Artifact | Owned by the agent (personal) | From the shared registry (shared) |
|----------|-------------------------------|-----------------------------------|
| a fact / preference | own brain `LEARNED.md` → commit `main` | (n/a — org facts live in `org/`) |
| a skill (procedure)  | own brain `skills/` → commit `main`    | `config_repo/skills/` → **PR** |

A personal skill and a shared skill of the same name may coexist: **shared is canonical; personal is an
override layer** the agent applies on top (an org standardizes; an agent may still specialize).

## Not yet / decisions captured

- **Writable, always-loaded `LEARNED.md`**: the brain is mounted read-only today; the personal path needs
  one writable, re-injected policy file. First increment wires exactly this.
- **Assignment source of truth** is `config_repo/assignments.yaml` (central + git-tracked), NOT the agent's
  own config (which would defeat central governance).
- **PR credentials**: the agent needs a GitHub token scoped to open PRs on `config_repo`; personal commits
  use the brain repo's existing push credential.

## Coverage

- `learn.test.ts` — routing by scope; commit-to-main vs open-PR dispatch; receipt shape; no-`config_repo`
  refusal; deterministic branch.
- `learn-git.test.ts` — live adapter with git + the GitHub API faked: `parseRepo`; `openPr`
  clone→branch→write→push→PR (+ 422 returns the existing PR; token in the auth header); `commitToMain`
  temp-clone push-`HEAD:main`; **in-place `brainDir`** mode pulls + appends (not clobbers) + no clone.
- `learncmd.test.ts` — `parseLearnArgs` (flags, required, bad values); `runLearn` prints the JSON receipt.
- `server.test.ts` — the runtime **appends `LEARNED.md`** to the identity system prompt (present → combined
  tmp; absent → mounted identity unchanged).
- `config.test.ts` — `config_repo` surfaces from the settings file (and is undefined when absent).

Proven live from the baked Sapien image: shared learn opens a PR on `example-org/tonoman-config`; personal
learn commits `LEARNED.md` to `sapien-agent` `main` (authored by `sapien-agent`) and it lands on GitHub.
