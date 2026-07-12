# Turn failure — never silent, self-heal a vanished session

A turn must never end with a dead typing cue. Every failure either **self-heals** or **speaks up**.
Channel-neutral: the router owns this; connectors (Teams, Telegram) just render the reply, so both
surfaces get the same behavior. Extends `gw-auth-actionable` (which already handled auth) to *all*
turn terminations.

Root cause that motivated this (proven live 2026-07-10, Sapien on Teams): a `session_persist` agent's
`/root/.claude` volume was wiped, but the gateway still held the old session id. The runtime ran
`--resume <id>`; the claude CLI failed with `error_during_execution`; the router's catch only knew
about auth errors, so it re-threw → the outer gateway catch logged `gateway: turn error` and sent
nothing. The user saw "typing… then nothing" and read it as a broken bot.

## gw-turn-ended-actionable — no turn dies silently

- **Given** a turn fails for a non-auth, non-abort reason (crash, timeout, `error_during_execution`,
  `httpRunner: agent 500`, …)
- **When** the failure is not auto-recoverable
- **Then** the agent posts one explicit, non-alarming message to the chat — a short (≤200-char,
  secret-free) detail plus "try again, or send /new to start a fresh session" — and does **not**
  commit the failed turn to memory.
- **And** the gateway log still records `gateway: turn error (conv=…, agent=…): <msg>` for the operator.

Notes: an **abort** (`/interrupt`, `/new`, `/steer`) is not a failure — the partial is handled by the
engine as before (the catch re-throws only when `signal.aborted`). An **auth**-shaped error keeps the
existing `authNotice` (gw-auth-actionable) path.

## gw-resume-selfheal — a resume of a vanished session recovers automatically

- **Given** a `session_persist` agent whose harness session store is gone (wiped PVC/volume, cleared
  creds) so the remembered session id no longer resolves
- **When** the turn was **resuming** (`sessionMode && !sessionNew`) and fails with a stale-session
  shape (`isStaleSessionError`: `error_during_execution` / "no conversation found" / "could not
  resume session" / "invalid session")
- **Then** the router rotates to a fresh session (`memory.newSession` → a fresh harness UUID),
  posts "↻ My previous session had expired, so I started a fresh one…", and **retries the turn once**
  with `sessionNew: true` (identity re-sent, empty window) — a chat turn is safe to re-run.
- **And** on retry success the turn commits normally against the fresh session; on retry failure it
  falls through to `gw-turn-ended-actionable` (explicit message, no silence).

The retry is gated to `!sessionNew` so a genuine first-turn execution error is surfaced, not looped.

## teams-stream-reset — the self-heal retry opens a FRESH stream

The self-heal re-runs the turn on the SAME reply. On a growing-prefix channel (Teams `streaminfo`) a
second stream continuing the first 403s (`ContentStreamNotAllowed`). So before the retry the router:
(1) calls `reply.reset?()` — the connector closes any half-open stream (streaminfo-`final` with the
last text) and clears its stream cursors so the next `send()` starts a new stream at seq 1; and (2)
delivers `resumeResetNotice()` as a **standalone** message (`reply.note`, falling back to `send`) so
the notice text never opens a stream the retry's answer would have to extend. Telegram sends each
chunk as its own message, so it needs neither — `reset` is optional and Telegram omits it.

## Carrier note (why the message survives the k8s split)

For a remote agent (`claude-code-http`), the real error text must reach the router: the agent runtime
serializes `err.message` over NDJSON (`server.ts encodeEvent`), and `httpRunner.decodeEvent` rehydrates
it — so `isAuthError` / `isStaleSessionError` classify the actual failure, not a generic "remote error".
The claude harness still flattens an empty-`result` failure to `claude turn failed (<subtype>)`
(`claudecode.ts`); `isStaleSessionError` matches that subtype so the self-heal fires regardless.

## Coverage

- `authflow.test.ts` — `isStaleSessionError` shapes (+ non-matches), `turnErrorNotice` (detail bounded,
  `/new` hint), `resumeResetNotice`.
- `router.test.ts` — non-auth error surfaced (not thrown, not committed); resume-miss rotates + notifies
  + retries once with a fresh session id and commits.
