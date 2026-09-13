# The Claude Code harness & subscription auth

A turn runs by shelling out to **`claude -p`** in the agent's sandbox, streaming its `stream-json`
output back through the gateway. The load-bearing decisions are **how the command is built** and
**how the agent authenticates** — on a Claude **subscription** (OAuth), never an API key, so billing
runs on the plan and each agent (or each person) answers as itself.

This is the feature-level view of architecture.md **§A2**. The turn loop that invokes it is
[`gateway-turn-loop.md`](gateway-turn-loop.md).

---

## The harness command

`Runner.claudeTail()` (`src/harness/claudecode.ts`) builds the flag tail, identical whether the run is
`podman exec`'d into a per-agent container or exec'd locally (the pod-is-the-sandbox case):

```
claude -p --output-format stream-json --include-partial-messages --verbose
        --setting-sources user --dangerously-skip-permissions --strict-mcp-config
        --append-system-prompt-file <identity> [--model <m>] [lean: --max-turns 1 + disallowed tools]
```

The prompt rides on **stdin**, not argv. `IS_SANDBOX=1` is set so `--dangerously-skip-permissions`
is accepted as root. `--strict-mcp-config` keeps ambient connectors out by default. The runner
**guards against `--bare` and unrequested `--resume`**. (The lean variant — every built-in tool
disallowed, `--max-turns 1` — is how the Talent `infer` capability runs.)

---

## Auth: a credential store, not an injected token

Brain auth is a **Claude.ai subscription OAuth credential**, and the whole mechanism is a
**per-config-directory credential store** that `claude` itself manages:

- Each turn runs with **`CLAUDE_CONFIG_DIR` pointed at the agent's config home**, and
  **`ANTHROPIC_API_KEY` deleted** from the environment (plus, on the subscription backend, the Bedrock
  / model overrides cleared) — so `claude` resolves the **OAuth credential** from
  `<config-home>/.credentials.json` and nothing else.
- The config home is chosen **per turn** by `configHomeFor(agent, user)`:
  - `…/agents/<agent>` — the agent's **one shared login** (every agent today).
  - `…/agents/<agent>/users/<user>` — a **per-person** login, when `inference_mode = per_user`, so a
    teammate answers (and bills) on their own subscription. Selected via `TurnRequest.configHome`,
    per turn because one worker process serves every conversation.

### Provisioning a login (the auth gate)

```mermaid
sequenceDiagram
    autonumber
    participant Turn as A turn / !connect claude
    participant Gate as Auth gate
    participant Ops as AuthOps (podman | http)
    participant RT as Agent runtime (/auth/*)
    participant CC as `claude auth login --claudeai` (PTY)
    participant User as Slack (Block Kit)

    Note over Turn: shared agent gates on registry auth_state ≠ "ok";<br/>per-person gates on a missing <config-home>/.credentials.json
    Turn->>Gate: ask(agent, [user], conversation)
    Gate->>Ops: startHeadless(agent, user)
    Ops->>RT: POST /auth/login
    RT->>CC: run under a PTY (script -qfc), detached, FIFO stdin
    CC-->>RT: prints a claude.com OAuth URL
    RT-->>Ops: the URL
    Ops-->>Gate: the URL
    Gate->>User: post the URL as a Block Kit prompt
    User->>Gate: taps, signs in, pastes the code (in a modal, never the channel)
    Gate->>Ops: submitCode(code)
    Ops->>RT: POST /auth/code
    RT->>CC: write code to the FIFO
    Note over RT: verify OUTCOME-TRUE — .credentials.json mtime advanced<br/>AND `claude auth status` reads logged-in
    RT-->>Gate: ok / not
    Gate->>Gate: setAuthState(agent, "ok" | "error")
```

The verification is **outcome-true**: not "we sent the code" but "the credential file actually changed
*and* `claude auth status` agrees." The credential store lives in the agent's volume, persists across
restarts, and auto-refreshes. `!connect claude` invokes the *same* gate a turn does when it finds no
credential — one mechanism, not two.

---

## Corrections folded in from the code (this doc supersedes the older prose)

§A2's prose describes a provisioning mechanism that **is not what the code does**. Verified against the
tree:

- **There is no `CLAUDE_CODE_OAUTH_TOKEN` injection.** A2 says the token is "injected as
  `CLAUDE_CODE_OAUTH_TOKEN` via the mounted settings file." That symbol appears **nowhere in `src/`**.
  The wired path sets **`CLAUDE_CONFIG_DIR`** and deletes `ANTHROPIC_API_KEY`, and `claude` resolves the
  subscription from the credential store produced by `claude auth login --claudeai`.
- **The "two paths" (`claude setup-token`; copy host `.credentials.json`) are not wired.** Neither
  `setup-token` nor a host-file copy exists in `src/`. The actual, single provisioning path is the
  **in-container PTY `claude auth login --claudeai`** diagrammed above (an auto-refreshing credential
  store — close to A2's "Alternative," but produced by an interactive in-sandbox login).
- **`--bare` is correctly never emitted** (A2's claim holds) — but its parenthetical rationale ("bare
  ignores `CLAUDE_CODE_OAUTH_TOKEN`") names the same unwired token, so it no longer applies.
- **`--strict-mcp-config` is emitted by default** — newer than A2's illustrative command box.

_The `configHome`-per-turn mechanism is what §A11 (per-agent config) and the per-person inference story
rest on; the gate's Slack prompt uses the same Block-Kit path as the rest of the connector._
