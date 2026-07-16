[[_TOC_]]

# Track: channel-teams — Microsoft Teams as a Tonoman-native connector

The **second channel** (the README vocabulary's *"MS Teams is the second connector"*).
Telegram proved the `Connector`/`Reply` seam (`gateway` track); this track adds **MS Teams
over the Bot Framework** as a peer connector so a **turn-driven** agent — under **any**
harness, Claude Code today — is reachable on Teams. The harness, router, turn queue,
git-memory, and the stream consumer are **untouched**: they speak only the neutral
contracts (`core/contracts.ts`), so a new channel is a new connector + its credentials.

> **This is distinct from `backend-hermes`.** There, **Hermes** owns its *own* Teams loop
> inside its container (`harness: hermes`, `service: true`; Tonoman just boots it). Here,
> **Tonoman owns the Teams transport** in the gateway process and drives turns against the
> harness — exactly as it does for Telegram. The two are mutually exclusive per agent
> (`spec.service || cfg.service`) and coexist cleanly. **Channel ⊥ harness:** the grid is
> `{telegram, teams} × {claude-code, hermes, …}`; this track fills **teams × claude-code**.

> **Run:** `npm test` → Teams connector unit/contract tests (inbound normalize + auth +
> conversationReference, outbound activity POST + bot-token mint/cache, typing, chunked
> delivery, config + channel selection). **FREE** — no container, no tokens, `fetch` faked.
> The end-to-end live round-trip rides the `live/` track (a Teams + claude-code journey).

> **Architecture (the how):** [§ A1 Messaging gateway](../../architecture.md#a1--messaging-gateway-harness-neutral) ·
> [§ A4 Streaming reply contract](../../architecture.md#a4--streaming-reply-contract).
> Patterns drawn from the proven **hermes** Teams adapter (typing-refresh loop, single
> final send, client-credentials bot token, conversationReference capture) and **openclaw**
> (`@openclaw/msteams`: inbound JWKS JWT validation, the native `streaminfo` streaming
> protocol — see `teams-stream-progressive`, deferred). Scenarios state behavior only.

---

## Connector parity + the Teams-specific surface — SPEC (review gate)

A Teams connector must satisfy the same `Connector`/`Reply` contract Telegram does, so the
gateway needs **no upstream change** beyond *selecting* it. What's genuinely new vs. Telegram
— and why this is a real transport, not just config — is: **push** (webhook) not **pull**
(poll); **inbound JWT validation** (the listener is internet-exposed); a richer
**conversationReference** to reply later; and a **client-credentials bot token** on every
outbound call. These scenarios state that surface.

### `teams-inbound` — Messageable on Teams through the gateway
- Given a Teams bot (Entra app + Azure Bot) whose **messaging endpoint** the gateway serves,
- When an allow-listed user sends a message (text and/or an image) to the bot,
- Then the gateway receives it, makes any **media available to the agent** (a shared-mount
  path), drives **one turn** through the configured harness, and the agent replies. The
  harness never touches Teams — the router sees only a neutral **envelope** (`channel:
  "teams"`), exactly as for Telegram.
- _Arch: A1 (connector → envelope, router loop), A2 (turn-runner)._

### `teams-webhook-listener` — Inbound is a webhook the gateway serves (push, not poll)
- Given Bot Framework **pushes** activities (`POST /api/messages`) rather than offering a
  long-poll, unlike Telegram's `getUpdates`,
- Then the connector's `receive()` runs a **small HTTP listener in the gateway host process**
  (the same place Telegram's poll client runs — **not** inside the agent container), bridging
  each inbound POST into the async iterable the gateway's inbound loop drains.
- The POST is **ACK'd 200 immediately** (the turn does not hold the HTTP request open — a
  turn can run minutes; the reply is delivered **asynchronously** to the stored
  `serviceUrl`, `teams-reply-send`).
- **Endpoint location is config, not code:** a **dev tunnel** points at the gateway host's
  listener locally; **cluster ingress** points at it in k8s — the connector code is identical
  (mirrors the Telegram-vs-endpoint split already proven for the gateway).
- _Arch: A1 (connector owns its inbound transport)._

### `teams-inbound-auth` — Every inbound activity's Bot Framework token is validated
- Given the listener is **internet-exposed** (anyone can POST to the tunnel/ingress) — a
  threat Telegram's outbound-only poll never had,
- When an activity arrives, the connector **validates the inbound `Authorization` bearer**
  against the Bot Framework / Entra signing keys (issuer + audience = the bot's app id, JWKS
  signature) **before** acting on it; an unsigned, wrong-audience, or expired token is
  **rejected** (HTTP 401, no envelope produced, no turn).
- This is a **hard requirement** of owning the transport (openclaw's
  `createBotFrameworkJwtValidator` is the reference); it is not optional hardening.
- _Arch: A1. Pattern: openclaw `sdk.ts` JWKS validator._

### `teams-allowlist` — Only allow-listed senders are served
- Given an optional `allowed_user` (the sender's **AAD object id**, the stable Teams identity),
- When a message arrives from someone **not** on the allow-list, it is **dropped** (no turn,
  no reply) — the same default-safe gate as Telegram's `allowedUser`; empty allow-list =
  accept all (dev). (Application-level authorization, distinct from `teams-inbound-auth`'s
  transport authentication.)
- _Arch: A1._

### `teams-conversation-reference` — Capture enough to reply later
- Given Teams outbound needs more than Telegram's bare `chat.id`,
- Then on **every** inbound activity the connector captures and stashes per conversation: the
  **`serviceUrl`**, **`conversation.id`**, **`from`** (id + `aadObjectId`), **`recipient`**
  (the bot), **`channelId`**, and **`conversation.tenant.id`** — the `conversationReference`.
- `reply(conversation)` constructs every outbound activity from the **stored reference** (a
  reply can be sent long after the inbound HTTP request was ACK'd). If no reference is cached
  for a conversation, an outbound is a no-op (nothing to address) rather than an error.
- _Arch: A1. Pattern: hermes `_conv_refs` / openclaw stored `ConversationReference`._

### `teams-outbound-token` — Outbound authenticates with a cached client-credentials bot token
- Given Bot Framework REST requires the **bot's own** bearer (not the inbound token),
- Then before an outbound POST the connector mints a token via **client-credentials**
  (`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope
  **`https://api.botframework.com/.default`**), **caches it** until `expiry − 60s`, and
  reuses it across replies/typing; it refreshes when stale.
- The target **`serviceUrl` is validated against a host allow-list** (e.g.
  `smba.trafficmanager.net`) before a bearer is sent to it (SSRF guard) — a serviceUrl that
  fails the check is refused.
- _Arch: A1. Pattern: hermes `_bot_framework_token` cache + serviceUrl allow-list._

### `teams-reply-send` — A reply is a message activity POSTed to the conversation
- Given a finalized reply (or a chunk of one),
- Then the connector POSTs a **message activity**
  (`{ "type": "message", "text": …, "textFormat": "markdown" }`, with the captured
  **`tenant` in `channelData`** so proactive sends aren't 403'd) to
  **`{serviceUrl}v3/conversations/{conversationId}/activities`** with `Authorization: Bearer
  <botToken>`, and returns the new **activity id**.
- Teams renders only a **markdown subset** (bold/italic/inline-code; not tables/raw HTML), so
  the same block-spacing normalization Telegram uses applies; tables are flattened.
- _Arch: A1, A4. Pattern: hermes `_standalone_send` raw REST recipe._

### `teams-working-status` — `working()` shows the typing bubble + a labeled "🤖 working…" that updates the WHOLE turn (default)
- Given the operator should always know the bot is alive — including a **mid-turn quiet gap** (the
  agent streamed some text, then runs a long tool before more text), where "the message just
  completes after a silence" feels broken,
- Then `working()` shows **both** familiar affordances (as Telegram does):
  - **(1) the classic typing bubble** — a plain `{ "type": "typing" }` activity (no streaminfo)
    each tick, pre-text. Carrying no streaminfo, it is **orthogonal to the stream sequence**.
  - **(2) a labeled status MESSAGE** (config `working_cue: "message"`, the default) — a **separate**
    message the connector creates (after a short delay, so a quick reply never flashes one),
    **updates in place** with the elapsed label, and **deletes when the reply finalizes** (the
    completed reply stays; only the status vanishes). Because it's an independent message — not part
    of the prefix-locked stream — it can update **for the whole turn, including after text has
    started**, closing the mid-turn-quiet gap. Fail-soft: if the delete is rejected it's blanked to
    `✓` so a stale "🤖 working…" never lingers.
- The label is **elapsed-aware** — it **steps every 10s in the first minute** (`🤖 working…` →
  `(10s)` → … → `(50s)`) then **per minute** (`(1m)`, `(2m)`, …) — and **deduped by the label**, so
  it re-posts only when the step changes (well within Teams' ~1 req/s).
- The streamed reply is a **separate** streaminfo stream (`teams-stream-progressive`), unaffected
  by the status message.

### `teams-working-card` — config-gated alternative: an `informative` streaminfo cue (pre-text only)
- Given `working_cue: "card"`,
- Then instead of the status message, `working()` posts a labeled `informative` streaminfo update
  (`{ "type": "typing", "text": "🤖 working…", entities: [streaminfo informative] }`) — a progress
  bar that **establishes the stream**, so the **first text chunk continues it** (`streaming`, next
  `streamSequence`, same `streamId`; openclaw's `sendInformativeUpdate` → `pushStreamChunk`). The
  typing bubble still shows. Same elapsed-stepping + dedup. **Pre-text only** — once text starts the
  cue is suppressed (an informative update can't resume mid-stream without breaking the prefix), so
  this mode does **not** cover the mid-turn quiet gap. Kept as a config-gated option.
- For a **group/channel** chat (no streaming), `working()` posts only the plain typing bubble.
- Each post is **best-effort / fail-soft** — a failed tick never aborts the turn. (Tonoman replies
  by **direct REST to `serviceUrl`**, not a held-open SDK TurnContext, so there's no ~30s
  proxy-expiry to fight; the refresh is purely so the visible cue doesn't disappear.)
- _Arch: A4. Pattern: openclaw `sendInformativeUpdate` + activity update/delete REST; hermes typing loop._

### `teams-stream-progressive` — `canEdit()=true`: text reveals live via the Teams `streaminfo` protocol
- Given the operator wants the **Telegram-like live experience** — text appearing as the
  agent works — the connector reports **`canEdit()=true`** for a **personal (1:1)**
  conversation and maps the consumer's `send`/`update`/`finalize` onto Microsoft's
  **streaming-activity protocol**:
  - **first** chunk (`send`) → POST a **typing** activity carrying a **`streaminfo`** entity
    (`streamType: "streaming"`, `streamSequence: 1`); capture the returned activity **`id`**
    as the **`streamId`**, return it as the msgID;
  - **subsequent** chunks (`update`) → POST typing+`streaminfo` with the `streamId` and an
    **incrementing `streamSequence`**, the text being the **grown prefix**;
  - **finalize** → POST a **message** activity with `streaminfo` `streamType: "final"` (no
    `streamSequence`), `textFormat: "markdown"`, tenant in `channelData`. **finalize always
    closes the stream** (even if the text equals the last streamed chunk) — an unclosed stream
    leaves the indicator hanging.
- **The final must CONTAIN what was streamed.** Teams rejects a stream-close whose text doesn't
  extend the already-streamed content (`403 ContentStreamNotAllowed`). The harness's final result
  can diverge from the streamed deltas (e.g. the agent streamed a preamble its result dropped), so
  the consumer finalizes with the **streamed accumulation** when the canonical result doesn't extend
  it — closing the stream cleanly (no orphaned bubble / lingering stop). _(Learned live.)_
- **Strict-prefix is honored by the consumer, opt-in** (`teams-consumer-telegram-safe`): for a
  Teams stream the consumer renders a **strictly-growing assistant-text prefix** — **no
  cursor**, and the **tool-progress and heartbeat lines are not interleaved** into the
  streamed text (they would break the prefix rule; in-flight progress is carried by the
  typing indicator instead). Edits are throttled to **≥~1.5s** (Teams' ~1 req/s limit).
- _Arch: A4. Pattern: openclaw `streaming-message.ts` (`TeamsHttpStream`) + `draft-stream-loop.ts`._

### `teams-stream-fallback` — block-send when streaming can't apply (group, or over the char cap)
- Given streaming is **1:1-only** and bounded, the connector reports **`canEdit()=false`** for
  a **group/channel** conversation, and a reply that never opened a live stream **falls back to a
  single block send** past **~4000 chars**,
- Then the reply is delivered as **one message, chunked** on line boundaries (code fences
  preserved) — the consumer's existing whole-answer path. In-turn liveness still comes from
  the typing indicator (`teams-typing`). (The ~4000-char cap rides the consumer's existing
  `maxLen` guard; the group check lives in the connector.)
- _An **already-open** stream that crosses the **time** cap is handled by `teams-stream-cap-close`,
  not a block send — the stream is closed cleanly and grown in place._
- _Arch: A4 (the `canEdit()=false` degrade is already in the contract + consumer)._

### `teams-stream-keepalive` — a long tool gap keeps the stream live (no mid-turn freeze)
- Given a streamed chunk was assumed to "carry liveness", but a turn commonly streams a little text and
  then runs a **long tool** (tens of seconds) before the next chunk — during that gap `update()` is not
  called, so nothing refreshes the stream. Teams then **expires the typing indicator** and **freezes the
  "stop" control**, which reads as a hung bot. _(Learned live — the mid-turn freeze, distinct from the
  end-of-turn 403.)_
- Given the router already drives a **~4s wall-clock heartbeat** (`keepWorking` → `reply.working()`) that
  fires **even when no new text arrives**,
- Then on each heartbeat, while the stream is **open and under the age cap**, the connector **re-emits a
  streaming keepalive** — a `streamType: "streaming"` typing activity carrying the **last streamed prefix**
  with an incremented `streamSequence` — so Teams' indicator + "stop" stay **live** through the gap (throttled
  so a tick right after a real chunk doesn't double-post). The visible text doesn't change during a
  tool gap (there's no new text), but the indicator no longer dies.
- On **crossing the age cap**, the heartbeat itself triggers `teams-stream-cap-close` (so the cap fires
  **without** needing a new chunk — the case a purely `update()`-driven cap misses). After the cap, the
  heartbeat keeps a **plain typing bubble** alive until `finalize` grows the reply in place.
- _Arch: A4. The `message`-cue status trace still ticks in parallel; this restores the STREAM's own liveness._

### `teams-stream-cap-close` — a long turn closes its stream cleanly at the age cap, then grows in place
- Given Teams live-streams for only a **bounded lifetime** (~2 min server-side), and a turn can run
  **far longer** (many back-to-back tools), the connector caps streaming at **~45s** (`maxStreamAgeMs`,
  safely under Teams' limit). **Crossing the cap must not abandon the open stream** — an open-but-silent
  stream leaves Teams' **"stop ✕" control orphaned** and the typing bubble expires, so the user stares at
  a frozen "still generating" UI for minutes, and the eventual `finalize` then `403 ContentStreamNotAllowed`
  (its total lifetime long past the limit) and only survives via the plain-message fallback. _(Learned live —
  the "null Ordway id" turn.)_
- When an **open** stream (`send()` already ran) crosses the age cap on the next `update()`,
- Then the connector **closes the stream cleanly right then** — a `streamType: "final"` message carrying the
  **streamed prefix so far** (a strict prefix of the eventual answer, so Teams accepts it; sent well under the
  ~2-min limit, so it does **not** 403) — and **records that message's id**. Streaming stops; further `update()`s
  no-op (they only keep the latest prefix for finalize). The **stop control disappears** and no orphaned bubble
  lingers.
- **Liveness continues** through the separate status trace (`teams-working-status`) — the `🤖 working… (Nm)`
  cue + last `🔧 tool` line keep ticking for the rest of the turn — so the turn never looks frozen.
- On `finalize`, because the stream is already closed, the connector **grows the recorded message IN PLACE**
  to the full answer — a **plain edit** (`updateActivity`, no `streaminfo`) that **cannot 403** on the streaming
  limit and leaves **exactly one** message (no partial+full duplicate). The `🤖 …ed for N min` trace settles
  just above it (Claude-style "thought for…"). If the in-place edit fails (message gone / not editable), it falls
  back to a **plain message** so the answer still lands.
- _Arch: A4. Supersedes the old "past ~45s → block send" clause of `teams-stream-fallback` for a stream that
  already started. Pattern: close-then-edit rather than close-then-repost, so the live bubble simply completes._

### `teams-consumer-telegram-safe` — the streaming accommodations never touch Telegram
- Given the prefix-stream behavior (`teams-stream-progressive`) needs consumer changes
  (empty cursor, suppressed tool/heartbeat lines, always-finalize),
- Then those are **opt-in `ConsumerOptions`**, **default off**; with them off the consumer
  renders **exactly as today** — cursor, live `🔧 tool` line, and `🤖 working… (Nm)` heartbeat
  all intact — so **Telegram is byte-for-byte unchanged**, and the `harness: hermes` Teams
  demo (which doesn't use this consumer at all) is unaffected. The Teams agent's gateway wiring
  sets the prefix-stream options; Telegram's does not.
- _A regression guard encoding the constraint: Teams streaming must not change Telegram._
- _Arch: A4._

### `teams-media-inbound` — Inbound attachments download, auth decided by shape
- Given a Teams attachment can arrive in two shapes that need **opposite** auth:
  - an **inline image** — `image/*` with a `contentUrl` on a Bot Framework host
    (`smba.trafficmanager.net`) — which a plain GET 401s, so it needs
    `Authorization: Bearer <botToken>`;
  - a **file** picked in a 1:1 chat (a receipt/card) — `application/vnd.microsoft.teams.file.
    download.info`, whose real bytes are at **`content.downloadUrl`** (a pre-authenticated
    SharePoint URL that **401s if you attach the bot token**), NOT at `contentUrl` (a landing
    page).
- Then `resolveAttachment(att)` settles the URL, filename, and auth flag **off the network** (a
  pure, testable decision): file.download.info → `downloadUrl`, **no** auth; image on a BF host →
  `contentUrl`, **with** the bot token; any other/non-allowlisted host → no auth (the token is
  never handed to a host we don't trust). The connector downloads to its media dir and exposes the
  path as a `mediaPath`. A download failure is **non-fatal but never silent** — it is `console.error`'d
  (a swallowed download is exactly the "the agent says it sees nothing" bug).
- _Arch: A1. Pattern: hermes/openclaw attachment-auth-by-shape._

### `split-media-carried` — Inbound media crosses the gateway↔agent split
- Given the k8s split runs the gateway and the agent in **separate containers with no shared
  filesystem**, a file the connector downloaded on the gateway is invisible to the agent by path
  alone (this is why the runtime was `v1 text-only`),
- When a turn carries `req.mediaPaths`, the **httpRunner** reads each file, base64s it (per-file
  cap `MAX_MEDIA_BYTES`; oversize/missing skipped + logged), and ships it in the `/turn` body as
  `media: [{name, b64}]`,
- Then the **agent runtime** writes each item under `AGENT_MEDIA_DIR` (default `/root/media`) using
  **only its basename** (`path.basename` → no traversal / arbitrary write), sets `turnReq.mediaPaths`
  to those local paths, and **deletes them after the turn**. Because `AGENT_MEDIA_DIR` matches the
  connector's `media_dir`, the path the prompt already embeds (`buildPrompt`) resolves agent-side —
  no shared volume, identical local and in-cluster.
- Channel- **and** harness-neutral: it rides the `mediaPaths` seam, so Telegram media crosses the
  split the same way, and any harness reached over HTTP inherits it.
- _Arch: A1 (media seam), the k8s split (server.ts / httpRunner.ts). Coverage: `httpRunner.test.ts`
  (body.media base64), `server.test.ts` (materialize + basename-only + per-turn cleanup)._

### `teams-config` — A `teams` config block selects the channel; validation + selection seams
- Given an agent definition,
- Then a **`teams`** block (`app_id`, `app_password` [secret ref], `tenant_id`, optional
  `allowed_user`, `media_mount`, `port`) declares a **turn-driven Teams** agent. `validate()`
  requires Teams creds **instead of** `telegram.token` for such an agent; `resolveAgents`
  derives **`channel: "teams"`**; `runAgent` **selects the `TeamsConnector`** in place of the
  hardcoded Telegram one. Everything downstream (router, queue, footer, commands, AsideLane)
  is unchanged — it is channel-neutral.
- **Coexistence:** a `teams` turn-driven agent, a `telegram` turn-driven agent, and a
  `harness: hermes` service agent can all be in the roster at once — channel and harness are
  independent config axes.
- _Arch: A1 (connector selection), config (`AgentConfig` channel discriminator)._

### `teams-outbound-observable` — an outbound auth/permission failure is LOGGED, never silent
- Given the stream consumer **swallows** reply-delivery errors so a flaky channel never aborts a
  turn (`teams-delivery-resilient`) — which means a **misconfig** (bad bot secret, missing service
  principal → `AADSTS7000229`, bot not authorized to post → 401/403) would otherwise be an
  **invisible no-reply**,
- Then the connector **logs the cause loudly** before the consumer swallows it: a failed
  **bot-token mint** logs the underlying error + the fix (`az ad sp create --id <appId>`), and an
  outbound **401/403** logs that the bot isn't authorized to post. **And it fails fast at boot:**
  the connector mints a bot token once when `receive()` starts, so a credential/SP misconfig
  surfaces in the gateway log at **`tonoman up`** — not as a silent no-reply on the first message.
- _A turn-safety swallow must not become a debugging black hole — the operator always has a logged
  cause. (Learned live: a missing service principal produced a silent no-reply.)_
- _Arch: A1, A12 (observability)._

### `teams-delivery-resilient` — Flaky delivery never costs a turn
- Given Bot Framework can throttle (429, `Retry-After`) or blip,
- Then a **transient** transport failure is **retried** (bounded backoff, honoring
  `Retry-After`), and a delivery error that **survives** retries is **non-fatal** — it never
  aborts the turn: the agent's work and the memory commit still happen; the operator just
  misses an on-screen message. (Same guarantee as `gw-stream-live`.)
- _Arch: A1, A4. Pattern: openclaw `messenger.ts` backoff + `Retry-After`._

