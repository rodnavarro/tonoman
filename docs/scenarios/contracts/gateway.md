[[_TOC_]]

# Track: gateway — messaging gateway + Claude Code harness (generic spine)

The **content-agnostic** core of Tonoman: run an agent loop under **Claude Code**
(the `claude` CLI, headless) reached through a **Tonoman-owned messaging gateway**.
Claude Code has **no channel of its own**, so messaging becomes a **Tonoman
substrate** — the harness-neutral gateway: connector → envelope → router → turn →
stream → git-backed memory. This track owns the **spine behavior**; it carries no
skill of its own.

The **end-to-end live flow** that exercises this spine — including **headless brain
auth** — is proven by the [`roster`](roster.md) track (`roster-auth-volume`,
`roster-auth-headless`).

> **Run:** `npm test` → spine unit/contract tests (gateway, router, stream,
> Telegram connector, Claude Code harness, turn queue).
> **FREE** — spends no tokens. End-to-end live proof rides the `roster` track.
> Index: [`README.md`](README.md)

> **Architecture (the how):** [§ A1 Messaging gateway](../../architecture.md#a1--messaging-gateway-harness-neutral) ·
> [§ A2 Claude Code harness & headless OAuth](../../architecture.md#a2--claude-code-harness--headless-oauth) ·
> [§ A3 Substrate-owned, git-backed memory](../../architecture.md#a3--substrate-owned-git-backed-memory) ·
> [§ A4 Streaming reply contract](../../architecture.md#a4--streaming-reply-contract).
> Scenarios state behavior only.

---

## Messaging gateway + Claude Code harness — DONE

Three things proven together: **(a)** hermes-equivalent **live streaming** UX
from a substrate the harness doesn't own; **(b)** **substrate-owned, git-backed
memory** (the container is ephemeral); **(c)** **channel pluralism** — Telegram
today, behind one connector interface, so a second channel is purely a new
connector + its credentials. These scenarios state the **generic** spine behavior.

### `gw-sandbox-boot` — Claude Code agent comes up in a sandbox
- Given **any** agent + its `agentic-org` content,
- When Tonoman runs it under the **Claude Code** harness,
- Then it starts in a **podman sandbox** with the agent's identity + preset skills
  mounted from `agentic-org`, its **git workspace** attached (`ws-git-private`), and
  the **brain authenticated via the Claude subscription (OAuth, not an API key)**.
- The identity (`AGENTS.md` + `SOUL.md`) is injected as the system prompt every
  turn — it is what makes the agent run a preset skill on a matching message.
- The **model is a per-agent config field** (`cfg-per-agent`; e.g. `sonnet` for
  cheaper runs, `opus` for best quality) — **never hardcoded**.
- **The sandbox is the security boundary, so the agent runs with permissions
  skipped** — every tool **and skill** (including a skill's own sub-tools, e.g.
  `deep-research` spawning sub-agents) executes without prompts. A per-tool
  allow-list is **not** used: in headless mode it silently denies anything not
  enumerated and breaks skills. For Claude Code this is `--dangerously-skip-permissions`
  (with `IS_SANDBOX=1`, required to allow it as the container's root user).
- The harness has **no channel of its own** — it is reachable only through the
  gateway (`gw-telegram-inbound`).
- _Arch: A2._

### `gw-ephemeral-continuity` — Ephemeral container, continuity from the substrate
- Given the sandbox holds **no durable state** (no `--resume`, no reliance on
  Claude's `~/.claude` session files for memory),
- When the container is stopped, recreated, or scaled to zero between turns,
- Then the **next turn reconstructs full context from the substrate** — the agent
  behaves continuously across restarts because its memory is git-backed.
- _Arch: A3._

### `gw-telegram-inbound` — Messageable on Telegram through the gateway
- Given a Telegram bot token the **gateway owns exclusively**,
- When a user sends a message (text and/or a photo) to the bot,
- Then the gateway receives it, makes any **media available to the agent**, drives
  **one turn** through the Claude Code harness, and the agent replies. The harness
  never touches Telegram — the router sees only a neutral **envelope**.
- _Arch: A1 (connector → envelope, router loop), A2 (turn-runner)._

### `gw-stream-live` — Reply streams back live (hermes-equivalent UX)
- Given a turn is running,
- Then the channel shows a **live activity signal from the moment the message is
  received** — on Telegram the **typing indicator** (`sendChatAction`), re-sent on
  a heartbeat so it persists through the long tool-running phase **before** any
  reply text exists.
- Then the reply **streams into one message** with a live cursor, **tool-progress
  shows live** (e.g. `🔧 Bash: git commit…`), and the message is **finalized**
  (cursor stripped) on completion — the same experience as the containerized-hermes
  agent.
- Re-sending **identical** content is suppressed (no redundant edits; a
  "not modified" rejection is never an error).
- **Readable spacing across steps:** the harness streams the reply as separate content blocks
  (text → tool → text …) and a new text block's deltas carry no leading separator, so naive
  concatenation glues distinct steps (`…done.Next I'll…`). A **paragraph break is inserted when
  text resumes after a tool**; consecutive deltas of the *same* block stay joined (no spurious
  breaks mid-sentence).
- **Delivery is resilient:** a transient transport failure (a thrown `fetch` — e.g. a
  "fetch failed" network blip) is **retried** in the connector, and a delivery error that
  survives retries is **non-fatal** — it never aborts the turn. The agent's work and the
  memory commit still happen; the operator just misses an on-screen edit. (A flaky channel
  must not cost a turn.)
- _Arch: A4._

---

## Long-running turns, liveness & brokered-op accountability — TODO

The live example-stack test surfaced two gaps: a long brokered op (build, DB restore) goes
quiet with no sign of life, and — worse — the agent can **background the work and narrate
success while it never happened** (the migration silently vanished). One scenario makes
brokered ops accountable + observable via a single mechanism (the broker ledger); one keeps
the turn visibly alive.

### `gw-brokered-op-accountable` — brokered ops run in-turn, logged, never silently dropped
- Given the gateway both **runs the turn** and **serves the agent's control channel** (A8),
  and the brokered runtime is **synchronous** (a control request blocks until the host
  command exits, up to its timeout),
- When the agent runs a brokered command (including a multi-minute build/restore),
- Then it runs in the **foreground** so the `claude -p` turn stays open until it completes
  and the agent reports the real outcome **in the same turn** — never "I'll report back"
  (a `claude -p` turn is the unit; a backgrounded command is **orphaned** when the turn
  exits, which is exactly how the migration silently dropped).
- And every brokered command is recorded on a **ledger**: a discoverable **per-agent log**
  line with start + **terminal status** (ts, agent, verb, allow/deny + reason, the rewritten
  argv actually run, exit code, duration); the gateway's turn activity logs to a discoverable
  file too (today there is none — the observability the live test showed missing).
- **The catch:** a command that started but has **no terminal record** when its turn ends is
  **flagged**, not silently absent. The source of truth is the **ledger, not the agent's chat
  reply** — so "narrated success but the work didn't happen" fails here and can't return
  silently. (Foreground/no-background is the agent-side *means*, enforced via Cody's
  `AGENTS.md` + a harness setting where available; the ledger is the safety net regardless.)
- _Arch: A1 (turn loop), A8 (control-channel ledger), A12 (observability), A13 (broker)._

### `gw-auth-actionable` — an auth failure tells the user how to fix it (never silent) — SPEC
- Given an agent whose harness auth is **missing or expired** (never logged in, or its token
  rotated out — e.g. an agent seeded from another's shared credential, `roster-auth-headless`),
- When a user messages it and the turn fails to authenticate (the harness returns a `401` /
  "Invalid authentication credentials" / "Failed to authenticate"),
- Then instead of **silence** (today the error is only logged; the user just sees the typing cue
  stop) the user gets a **clear, actionable reply over the channel** that names the agent and the
  exact fix — e.g. *"⚠️ I'm not authenticated (my login is missing or expired). Operator: run
  `tonoman auth login <agent> --headless`."*
- And the failed turn is **not committed** as a normal exchange (no bogus assistant message in
  memory), and the error is **still logged** (`tonoman logs`) for the operator.
- **Generic** (harness-agnostic): the classifier matches the auth-failure shape, not one harness's
  wording; non-auth turn errors keep their existing behavior.
- _Tested: the `isAuthError` classifier is pure + unit-tested; the router maps an auth error to the
  notice (not a throw). Arch: A1 (turn loop), A2 (harness auth), A12 (observability). Pairs with
  `roster-auth-headless` (the fix it points to)._

### `gw-command-new-session` — `/new` starts a fresh session (a platform command, not a turn)
- Given a message that is exactly `/new` (or `/reset`) — a Tonoman **platform command**, the
  minimal slice of `cmd-dispatch`: a `/`-message is a **command, not a model turn**,
- Then the gateway does **not** run an agent turn; it **rotates the conversation's memory
  session** so the next turn starts with an **empty window**, and replies a short ack.
- The prior transcript is **preserved on disk** — a new dated session file is started and the
  old one is kept, git-versioned (this is the same dated-session storage as `ws-session-dated`):
  **amnesia for the agent, not data loss**.
- Plain (non-`/`) text is still a normal turn; an unknown `/command` gets a brief
  "unknown command" reply instead of being sent to the model. `/help` lists what's available.
- The bot's command menu is registered with the channel (Telegram `setMyCommands`) so `/new`
  is discoverable; richer **inline-button** menus + skill-commands remain `cmd-dispatch`
  (roadmap). _Pattern mirrors hermes (`/new`,`/reset` → reset_session) and openclaw's command
  registry — not reinvented._
- _Arch: A10 (command dispatch), A3 (substrate session rotation)._

### `gw-command-compact` — `/compact` shrinks context but keeps the thread (unlike `/new`) — SPEC
- Given a message that is exactly `/compact` — a platform command, not a model turn — and a
  conversation whose live context has grown (the reason `ctx%` climbs),
- Then the gateway **summarizes the conversation**, **rotates to a fresh session**, and **seeds
  the new session with the summary** — so the harness's context drops (ctx% falls) while
  **continuity survives**: the agent still knows the decisions, facts, and open threads. This is
  the deliberate contrast to `gw-command-new-session` (`/new` = amnesia; `/compact` = remember the gist).
- **Order is the contract:** summarize **first** (while the transcript is intact), **then** rotate,
  **then** seed. If summarizing fails or yields nothing, the gateway **changes nothing** — the
  existing context is left intact and the user is told, never half-cleared.
- The summary is produced by a **one-shot** main-runner turn (no session resume — a standalone
  call fed the transcript), because the remote HTTP harness has **no ephemeral sidecar**. The seed
  rides into the fresh session via the **create-turn window** (`gw-session-resume`: a create turn
  injects the substrate window once; resume turns never re-send it).
- A **short conversation** (nothing to compact) is a no-op with a plain reply. Any **running turn**
  is stopped first (like `/new`). The command is registered in the channel menu + `/help`.
- _Arch: A10 (command dispatch), A3 (substrate session rotation + seed)._

### `gw-turn-enqueue` — a plain message QUEUES by default (does not interrupt; Claude-Code feel)
- Given a turn is **running** and the operator sends a **plain** (non-command) message,
- Then the gateway **does not interrupt** — it **queues** the message to run after the current
  turn finishes, so the operator can "say everything on their mind and let the agent get to it
  eventually." If **no turn is running**, the message runs immediately.
- **Coalescing:** queued messages **merge into one directive** (e.g. "check the worker" +
  "and the api" → a single next turn), with a **short settle window** for rapid follow-ups —
  the agent picks up the merged whole, not N separate turns.
- **One queue footer, not a banner per message:** while messages are queued behind a running
  turn, the gateway shows a **single bottom-line status** it edits in place as the queue grows
  — e.g. `🗂 Queued (2): "check the worker…" · /pop to run now · /skip to clear`. No
  per-message acknowledgement spam. When the running turn ends and the queue is picked up, the
  footer resolves (it does not linger).
- **Requires** the gateway to **watch inbound concurrently while a turn runs** (so it can queue
  mid-turn). This is the deliberate inverse of the earlier interrupt-by-default model: **the
  default is patient (queue); interrupting is the explicit exception** (`/steer`, `/pop`).
- _Arch: A1 (turn loop + concurrent inbound, single merged pending), A10 (footer status)._

### `gw-command-steer` — `/steer <message>` interrupts now, keeping context
- Given a turn is running and the operator wants to redirect it **right now**,
- When the operator sends **`/steer <message>`**,
- Then the gateway **interrupts the in-flight turn** (aborts the `claude -p` run) and runs
  `<message>` as the next turn, **keeping the interrupted turn's partial output as context**
  (committed to the transcript) so the agent course-corrects *without losing what it learned* —
  brokered side-effects already executed remain (real + on the ledger). The steer message
  **merges with anything already queued**, so nothing is lost.
- If **no turn is running**, it just runs as a normal turn.
- _Arch: A1 (turn loop, abort with keep-context reason), A3 (partial preserved as continuity)._

### `gw-command-pop` — `/pop` runs the queued message(s) now
- Given one or more messages are **queued** behind a running turn,
- When the operator sends **`/pop`**,
- Then the gateway **stops waiting**: it interrupts the current turn (**keeping its partial as
  context**, same as `/steer`) and runs the **merged queued** message immediately. Nothing
  queued → a friendly "nothing queued." (`/pop` is "do the queue now"; `/steer <msg>` is
  "add this and do it now" — i.e. enqueue + pop.)
- _Arch: A1 (turn loop), A10 (command dispatch)._

### `gw-command-interrupt` — `/interrupt <message>` hard-stops and starts clean
- Given a turn is running,
- When the operator sends **`/interrupt <message>`**,
- Then the gateway **stops the running turn immediately** and runs `<message>` fresh —
  but **without** the interrupted turn's context: its partial output is **not** committed
  to the transcript, and any queued message is **dropped**. (Session history *before* the
  interrupted turn remains — this is not `/new`.)
- The **clean-cut** counterpart to `/steer`: `/steer` *keeps* the partial as context;
  `/interrupt` drops it (use it when the turn went somewhere you don't want polluting context).
- _Arch: A1 (turn loop, abort), A10 (command dispatch)._

### `gw-command-skip` — `/skip` clears the queued message(s)
- Given one or more messages are **queued** behind the running turn,
- When the operator sends **`/skip`**,
- Then the gateway **clears the queue** so it will **not** auto-run when the turn finishes; the
  running turn continues undisturbed. Nothing queued → a friendly "nothing queued."
- _Arch: A1, A10._

### `gw-command-btw` — `/btw <question>` answers an aside without interrupting (out-of-band) — SPEC
- Given the operator wants to ask a **quick aside** while the agent works, **without** interrupting
  the current turn and **without** waiting in the queue behind it (`gw-turn-enqueue`),
- When the operator sends **`/btw <question>`** (by-the-way),
- Then the gateway answers it **out-of-band**: the answer comes back as **its own reply**, the
  **in-flight turn (if any) is left completely untouched** — not interrupted, not aborted, not
  queued behind — and the aside is **not written to the conversation transcript** (it never becomes
  part of the task history or future context; it can't pollute the running turn).
- The aside is informed by the conversation's **committed context** (the same memory window,
  read-only) **and by a live snapshot of the in-flight turn's progress** — what the agent is
  **currently doing** (its partial answer so far, the current/last tool activity, elapsed time). So
  `/btw` **can** answer the natural by-the-way questions — *"how's the current task going?"*, *"what
  are you doing right now?"*, *"how much longer?"* (an ETA is a **best-effort read of the progress
  snapshot, not a guarantee**) — as well as meta/factual asides (*"what model are you on?"*,
  *"remind me the URL"*). It is **not** for changing the task (that's `/steer`).
- The live snapshot is **read-only and best-effort**: viewing it never alters, pauses, or restarts
  the running turn, and if no turn is running the aside simply answers from committed context.
- It **streams live into its own message** (its own cursor/typing), and an auth failure on the
  aside surfaces the same actionable notice (`gw-auth-actionable`) — it is a full turn, just an
  ephemeral, uncommitted, side one.
- **At most one aside in flight at a time** per conversation (a second `/btw` waits for the first to
  finish, it does not stack); an empty `/btw` gets a short usage hint. The command is registered in
  the channel menu so it's discoverable.
- _Arch note (mechanism, not contract): realized as an **ephemeral sidecar turn** — Tonoman spins a
  **throwaway container from the agent's own harness image** (`podman run --rm --volumes-from
  <caller>` + the harness `runEnv`, e.g. `CLAUDE_CONFIG_DIR`), runs one headless turn, and tears it
  down. This is a **harness-generic primitive** (the same machinery runs a Codex/OpenCode aside
  later) and reuses the existing image, so it adds no per-variant image maintenance. It **shares the
  caller's config mount** so the credential is a **single source of truth** (refresh works, no
  copy ⇒ no rotating-refresh-token divergence — the `roster-auth-headless` failure mode). **Spike-
  verified safe under concurrency:** two `claude -p` sharing one config dir both complete and
  `.claude.json` stays valid (no exclusive lock, atomic writes), and an idle/expired token simply
  surfaces `gw-auth-actionable`. Runs on a **single-slot aside lane** separate from the main
  `TurnQueue`, fed the **read-only live-turn snapshot** (partial assistant text + last tool +
  elapsed) kept per-conversation by tapping the running turn's stream, injected via the aside's
  prompt. A1 (turn loop + live snapshot), A10 (command dispatch), A11 (per-agent isolation), A13
  (broker spins the sidecar)._

### `gw-command-model` — `/model <name>` switches the model, effect next turn — SPEC
- Given an agent running on its **configured** model (`cfg-per-agent`, e.g. `sonnet`),
- When the operator sends **`/model <name>`** (e.g. `/model opus`),
- Then the gateway does **not** run a turn; it records a **model override** that takes effect on the
  **next** turn. A turn **already running is unaffected** — it finishes on the model it began with.
  The reply acks the change (old → new) and states **"takes effect next turn."**
- **`/model`** with no argument shows a **tappable picker** (Telegram inline buttons; same generic
  choice UI as `gw-command-statusline`) of the available model **families** — **auto-derived from the
  Anthropic models API** (`GET /v1/models` with the agent's OAuth token): the **latest per family**
  (opus / sonnet / haiku / and any new family that ships, e.g. `fable`) plus **default**, with the
  current model shown in the prompt. If the fetch fails, it **falls back to the in-code alias list**
  (`opus|sonnet|haiku`) — so the picker always works. (Picking sends `/model <id>`.) **`/model
  default`** (or `/model reset`) clears the override back to the configured model.
- **Validated at command time:** known aliases (`sonnet`, `opus`, `haiku`) and full `claude-*`
  model IDs are accepted; anything else is **rejected immediately** with the valid options listed —
  a typo never degrades into a cryptic failed turn later.
- **Lifetime:** the override is **per-conversation**, **survives `/new`** (it's an operator
  preference, not conversation context), and **resets on gateway restart** (it is not persisted).
- **Generic** (harness-neutral command): a harness with no model knob ignores it and says so; in
  v0.1 the `claude-code` harness maps the override to the next turn's model flag (which it already
  reads per turn). Registered in the channel command menu for discoverability.
- _Arch: A10 (command dispatch), A2 (harness model flag, evaluated per turn)._

### `gw-command-statusline` — `/statusline none|small|full` shows token + account usage — SPEC
- Given an operator wants to see what each turn costs and how much Claude headroom is left,
- When they set **`/statusline small`** (one line) or **`/statusline full`** (a breakdown), then after each
  turn the gateway appends the **usage status as a footer at the bottom of the agent's reply message**
  — **display-only: it is NOT written to the committed transcript** (so it can't pollute context),
  and it rides the same message (a "sticky bottom"), not a separate bubble. **`/statusline none`**
  (the default) shows no footer.
- **Tappable picker (no typing):** **`/statusline`** with no argument shows a **tappable choice of
  `none | small | full | print`** (Telegram inline buttons) — picking a mode sets it; no need to type
  the arg. (Generic command-choice UI: an inline-button list whose taps come back as the chosen
  command, reusable for other pick-one commands like `/model`.)
- **`/statusline print`** — show the status **once, on demand, WITHOUT running an agent turn (no
  tokens):** it renders the **last turn's** usage (full breakdown) + **fresh account windows**
  immediately. If no turn has run yet, it shows the account windows alone (or a short "no turn yet"
  note). `print` is an **action, not a mode** — it doesn't change the persistent none/small/full
  setting.
- **Shows the model it actually ran** (from the harness's per-model usage — a turn can use several,
  e.g. haiku for sub-steps + opus for the main work; the **primary** one, by tokens, is shown), e.g.
  the small line `📊 opus-4-8[1m] · 21.1k tok · ctx 2% · 5h 7% · 7d 19%`.
- **Per-turn tokens (always exact, from the harness result):** fresh **input**, **cache-write**,
  **cache-read** (the cached system + conversation context), **output**. **full** breaks the turn into
  input/cache-write/cache-read/output and labels the cached portion as the **system + context** vs the
  fresh **new input** — an honest split from the API's own numbers, not a guess.
- **Context %** = the **peak single internal call's** occupancy ÷ the model's **REAL** context window,
  **capped at 100**. The window comes from the harness's per-model usage (e.g. **1M** for an opus 1M
  variant), **not a hardcoded 200k** — so an opus-1M turn reads ~2%, not a wrong 14% of 200k. (And NOT
  the turn's summed tokens, which re-count the cached context every iteration and would exceed 100%;
  the result line's per-iteration `iterations[]` gives the true single-call occupancy.)
- **5h / 7d account windows (Claude subscription):** fetched from the **Anthropic OAuth usage API**
  (`GET /api/oauth/usage`, `anthropic-beta: oauth-2025-04-20`) using the agent's own OAuth token — the
  **account-wide** utilization the Claude app shows (`five_hour`, `seven_day`), with reset times in full
  mode. Cached briefly (short TTL) so it isn't re-fetched every turn. **Degrades gracefully:** if the
  call fails or the account isn't OAuth-backed, the windows are omitted (per-turn + context still show) —
  never an error, never a blocked reply.
- The mode is **per-conversation**, **survives `/new`**, **resets on gateway restart** (like `/model`),
  and is registered in the channel command menu.
- _Tested: usage parsing (result line → tokens), the OAuth-usage payload → windows, and the small/full
  renderers are pure + unit-tested; the fetch + token read are thin effectful wrappers. Arch: A2
  (harness result usage), A12 (observability). Pattern proven by hermes' account-usage._

### `gw-command-health` — `/health` deterministic agent health check (no tokens) — SPEC
- Given an operator wants to know an agent is actually working **without spending a turn**,
- When they send **`/health`**, the gateway runs **deterministic checks only** (podman / exec / fs —
  **never the LLM**, no agent turn, no tokens) and replies with a compact report led by an **overall
  verdict — ✅ Healthy / ❌ Unhealthy** (healthy iff every check passed) — and a **✅/❌ per check**:
  - **container** — the agent's sandbox is **up** (podman inspect running);
  - **brain auth** — **authenticated** or not, from the harness's `auth status` **exit code** (a
    metadata check, not a turn) — names the fix when not (`tonoman auth login <agent>`);
  - **tonoman reachable from the agent** — a **brokered round-trip**: the in-sandbox shim calls the
    host broker (e.g. a `podman ps` over the control channel, A13) and returns ok — proving the agent
    can actually reach tonoman, not just that the container is up;
  - **memory** — where the git-backed workspace lives;
  - a **timestamp**.
- **Bounded:** each check has a short timeout so a hung broker/agent fails the line fast (it reports
  "UNREACHABLE", never hangs the command). Registered in the channel command menu.
- _Arch: A12 (observability — the same health signals as `tonoman get services`, surfaced per-agent
  over the channel), A13 (the broker round-trip is the agent→tonoman reachability proof). Deterministic
  twin of the model-driven turn — it answers "are you alive + wired" without asking the brain._

### `gw-stream-heartbeat` — Liveness during a long turn
- Given a turn runs longer than ~60s (a long tool/build/restore phase),
- Then the streamed message carries a **liveness cue** with elapsed time (e.g.
  `🤖 working… (2m)`) — **distinct from the transient typing indicator**, which alone
  leaves the operator unable to tell "alive" from "hung".
- The cue is **computed from elapsed-since-turn-start**, so it **persists and ticks**
  through sporadic stream events rather than flickering away each time one arrives
  (the cue must not be a state a stream delta can wipe). A short turn that finishes
  under the threshold shows no cue.
- It is **purely display**: the cue edits only the outgoing channel message — it never
  feeds the agent, spends agent tokens, or restarts/interrupts the turn; the agent runs
  to its own completion.
- Re-sending identical content is still suppressed; the cue re-renders only when the
  elapsed-minute text actually changes (at most once a minute), and it is **stripped
  from the finalized answer**.
- _Arch: A4 (streaming reply contract)._
