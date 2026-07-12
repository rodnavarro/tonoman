[[_TOC_]]

# Track: browser — agents drive a real browser over CDP

> **Status: WIP — the per-agent Chrome sidecar and the host-Chrome backend ship**
> (provisioning + launch are unit-tested; host-Chrome is live-proven). Design in
> [A14](../../architecture.md#a14--browser-substrate-per-agent-chrome-over-cdp). Supersedes the
> earlier shared `chrome-sidecar` prototype and the Playwright-first `use-chrome-cdp` skill.

Some turns need a **real browser**, not raw HTML: sites that render client-side, need a logged-in
session, or must be *clicked through*. Built-in `WebSearch`/`WebFetch` ([A7](../../architecture.md#a7--web-research-agent-web-tools))
handle the light cases; this track is the heavy one. An agent drives its **own** headful Chrome over
the **Chrome DevTools Protocol (CDP)** — chosen over headless Playwright/`computer-use` because CDP +
the DOM/accessibility tree act on **structured elements**, not screenshots+pixels (the reason
vision-based `computer-use` stays flaky). The agent-facing skill is **`browser-bot`**.

**Why CDP, not pixels:** `computer-use` drives by screenshot + coordinate + vision — slow, costly,
breaks on a layout shift. `browser-bot` drives by CDP: the agent reads an **accessibility-tree
snapshot with stable element refs** and acts on refs (`click <ref>`, `type <ref>`), with
auto-waiting. Reliable lane.

## Locked design (the decisions these scenarios encode)
- **One new image, `tonoman/chrome`** (lifted from openclaw's `Dockerfile.sandbox-browser`: chromium
  + Xvfb + x11vnc + websockify + noVNC; CDP `:9222`, noVNC `:6080`). **`claudecode` is unchanged** —
  no browser baked in (rejected: bloats every agent incl. non-browsers; rejected: a 2nd claudecode
  image — a maintenance smell).
- **Per-agent sidecar, not shared.** Each browsing agent gets its **own** Chrome → no CDP-command
  collision, **own login profile**, own lifecycle. (Shared-Chrome rejected: one cookie jar, agents
  collide, a crash takes everyone down.)
- **Self-service via the broker (painless setup).** The agent provisions its own browser **on first
  use** through the A8/A13 control channel — no operator step. Operator CLI is the manual/observe path.
- **Raw CDP in Tonoman core (zero-dep); Playwright in the skill/image.** Core only exposes the CDP
  endpoint + the noVNC viewer. `browser-bot` uses `playwright-core` (pulled in the `tonoman/chrome`
  image / on demand — `connectOverCDP`, no browser download) for the snapshot/ref/auto-wait ergonomics.
- **Watch it live = noVNC.** `tonoman open browser -a <agent>` forwards the sidecar's noVNC to the
  host and opens a viewer URL — a live screen of the agent's Chrome (tabs, clicks, typing), no VNC
  client to install, works from a phone.

## Coherent CLI grammar (fits `VERB RESOURCE [-a agent]`, like `mounts`)
```
# operator (host)                              # what it does
tonoman create browser -a reacher              spin reacher's tonoman/chrome sidecar (own net + profile volume); adopt-safe
tonoman get browsers                           list sidecars + each agent's CDP / noVNC endpoints + status
tonoman open  browser -a reacher               forward noVNC + open the live viewer (watch it work)
tonoman close browser -a reacher               tear the viewer forward down
tonoman delete browser -a reacher [--purge]    remove the sidecar (profile volume persists unless --purge)

# agent (in-sandbox shim, self-scoped — no -a; broker knows the caller)
tonoman browser ensure                         what browser-bot calls on first use → broker auto-provisions if absent (idempotent)
```
`create browser` and `browser ensure` are the **same brokered op**, two front doors (mirrors how
`expose` works today). The op also wires the agent↔sidecar network and the persistent profile volume.

> **Run (when built):** `npm test` (CLI grammar + broker dispatch + CDP-helper units — free) · live
> proof: a `browser-smoke` script (real podman: spin `tonoman/chrome`, drive a page over CDP,
> outcome-verify extraction) + phone-proven `open browser`. Index: [`README.md`](README.md) ·
> Architecture: [`../architecture.md`](../../architecture.md#a14--browser-substrate-per-agent-chrome-over-cdp)

---

## Scenarios

### `browser-sidecar` — a per-agent Chrome sidecar, one image
- Given the `tonoman/chrome` image (chromium + Xvfb + x11vnc + websockify + noVNC; CDP `:9222`,
  noVNC `:6080`) and an agent,
- When a browser is provisioned for that agent (`tonoman create browser -a <agent>` or auto via
  `browser ensure`),
- Then Tonoman starts **one sidecar dedicated to that agent**, on the agent's own network, with a
  **persistent profile volume**, labelled `tonoman.agent=<guid>` (ownership, A11), and Chrome
  launched headful under Xvfb with `--remote-debugging-port` + a persistent `--user-data-dir`;
- And it is **adopt-safe** — never clobbers an existing sidecar; a second `create` is a no-op that
  reports the running one.
- **Not baked in:** `claudecode` carries no browser; browsing agents get the capability via this
  sidecar, not a heavier agent image.
- _Arch: A14, A11 (ownership/image), A13 (brokered start)._

### `browser-host-chrome` — drive the operator's host Chrome (second backend) — PROVEN
- Given the operator wants to collaborate in their **own** browser — a native window on their
  desktop, their existing logins, no noVNC — rather than the containerized sidecar,
- When the agent **just triggers it** (`tonoman browser ensure` via the shim — auto, no operator
  step), or the operator runs it,
- Then the **broker launches Chrome on the host** with `--remote-debugging-port` +
  `--remote-allow-origins=*` + a dedicated debug profile (a host action performed by the broker,
  **never** the agent — A2), writes the agent-facing endpoint to `~/.tonoman/browser.json`, and the
  agent drives it over CDP;
- And the operator **sees and controls it natively** (a real Chrome window on the desktop) — the
  simplest watch + take-the-wheel, no viewer to open.
- **Reach (the real-world detail):** Chrome ≥111 binds CDP to **loopback only** (it ignores
  `--remote-debugging-address`), and a container can't reach the host's loopback — so the broker
  runs an **in-process TCP relay** from a container-reachable interface (`advertise_host`:relayPort)
  to Chrome's `127.0.0.1:<cdp>` (same role as the sidecar's socat / the `expose` proxy). The agent
  connects to `http://<advertise_host>:<relayPort>` (by IP — Chrome's Host-header guard accepts an
  IP). The relay is torn down on `tonoman down`. _On WSL2 this surfaces on the Windows host's
  interfaces; a host firewall scoping the relay to the container subnet is the hardening follow-up._
- **Trade-off vs the sidecar (default):** host Chrome is **not containerized/isolated** (it runs on
  the host with the operator's environment), so it's the **collaboration / login-heavy** mode; the
  sidecar stays the isolated, per-agent, headless-capable default. Same CDP agent surface either way
  — the `browser-bot` skill doesn't care which backend it's attached to.
- _Proven 2026-06-16: reacher ran `tonoman browser ensure` → broker launched host Chrome + relay →
  reacher drove it over CDP (navigated + extracted). Arch: A14 (host-Chrome backend + relay), A13
  (broker launches a host process, like `expose`), A2._

### `browser-drive-cdp` — drive over raw CDP, outcome-verified
- Given an agent with a running sidecar,
- When the agent opens a URL, reads page content, and acts (click/type) over **CDP**,
- Then navigation, a text/extraction read, an action, and a screenshot all succeed against the
  **real page** — verified by the actual end-state (extracted text / resulting navigation), not by
  what the agent says in chat (the catch: a "done" that doesn't match the page **fails**);
- And the **transport is raw CDP** (WebSocket JSON-RPC + `/json/version` discovery + loopback
  proxy/host-header normalization) — Tonoman core pulls **no** browser library.
- _Arch: A14 (raw-CDP core)._

### `browser-bot-skill` — the generic browsing skill (snapshot + refs)
- Given the generic **`browser-bot`** skill (ships in the OSS repo; content-agnostic),
- When it drives the agent's browser,
- Then it works off an **accessibility-tree snapshot with stable element refs** and acts on refs
  (`click <ref>` / `type <ref>`) with auto-waiting — the LLM-reliable layer — using `playwright-core`
  (`connectOverCDP`, no browser download) **inside the `tonoman/chrome` path**, while Tonoman core
  stays raw-CDP/zero-dep;
- And it never works from pixel coordinates or guessed CSS selectors (the `computer-use` failure mode).
- _Arch: A14. (Skill is generic; an org may layer a richer one as seeded content.)_

### `browser-profile-persists` — per-agent login survives restart
- Given an agent logs into a site in its browser,
- When the sidecar is restarted (or the agent's turn ends and a later turn browses again),
- Then the login/cookies **persist** via that agent's own `--user-data-dir` profile volume — managed
  like the agent's config/credential volume (consistent credential handling);
- And **another agent's** browser has a **separate** profile — no cookie/login bleed.
- _Arch: A14, A11 (per-agent persistent volume)._

### `browser-open-on-host` — watch the agent browse, live (noVNC)
- Given an agent with a running sidecar (headful Chrome under Xvfb + x11vnc + noVNC),
- When the operator runs **`tonoman open browser -a <agent>`**,
- Then the **broker** (not the agent — the agent has no host network privilege, A2) forwards the
  sidecar's noVNC `:6080` to the host and returns/opens a **token-gated viewer URL**; the operator
  sees the agent's **actual Chrome live** — page loads, mouse, clicks, typing, tabs — in any browser,
  including a phone on the LAN;
- And **`tonoman close browser -a <agent>`** tears the forward down; the viewer is **revocable**, the
  token short-lived, password auto-generated.
- **Invariant:** the agent **cannot** open the viewer itself — exposure is brokered, audited,
  revocable (same posture as `devcontainerized-expose-url`).
- _Arch: A14, A8/A13 (brokered forward + ledger), A2 (sandbox-is-boundary)._

### `browser-interactive-login` — operator takes the wheel to log in, no restart
- Given an agent driving its browser hits a step it **can't or shouldn't** automate — an MFA
  prompt, a CAPTCHA, or a credential the operator won't hand the agent,
- When the agent **pauses and asks** the operator to log in, and the operator runs **`tonoman open
  browser -a <agent>`** (interactive by default),
- Then the **same live viewer is interactive** — the operator clicks/types directly in the agent's
  real Chrome to complete the login — with **no restart** of the agent, the gateway, or the browser
  (it's purely how this noVNC viewer session connects; the x11vnc server is interactive-capable, and
  `--view-only` is the opt-out for pure watching);
- And because the browser has a **persistent per-agent profile** (`browser-profile-persists`), the
  session **survives** — the operator logs in once, hands back, and the agent continues **already
  logged in**, this turn and later ones.
- **Coordination:** while the operator is at the wheel the agent waits (it asked); they share one
  Chrome, so the agent doesn't drive over the operator mid-login.
- _Arch: A14 (interactive viewer + persistent profile), A2 (operator is host-side; agent only
  requests the viewer)._

### `browser-isolation` — one agent's browser is invisible to another
- Given two agents each with their own sidecar,
- Then agent A **cannot see, drive, or watch** agent B's browser: separate sidecars, separate
  networks, separate profile volumes, ownership-scoped by `tonoman.agent=<guid>` — `get browsers` and
  every brokered browser op are scoped to the calling/named agent (A11);
- And `open browser -a A` exposes only A's session.
- _Arch: A14, A11 (per-agent ownership/isolation)._

### `browser-cli` — the command surface
- Given the grammar above (`create`/`get`/`open`/`close`/`delete browser [-a agent]` + in-sandbox
  `browser ensure`),
- Then it parses/validates/dispatches like the rest of the `kubectl`-style surface
  ([`cli`](cli.md)): unknown/missing args → usage exit 2; `-a/--agent` namespaces; the in-sandbox
  form self-scopes (no `-a`); operator and agent front doors resolve to **one** brokered op.
- _Arch: A14, `cli-grammar`/`cli-agent-scope` patterns._

---

## Security invariants (the enterprise story)
- **Agent can't open a port or a viewer** — `open browser` is brokered, policy-gated, ledgered,
  revocable; the agent can only *request* it.
- **Per-agent isolation** — own sidecar, own network, own profile; ownership label scopes every op.
- **Secrets** — a browser profile may hold real logins; the profile volume is treated like a
  credential store (never committed; `cfg-no-secrets`). noVNC is token+password gated, loopback-forwarded.
- **No new host reach** — exposing the viewer is an inbound-only forward of an already-bound port; it
  does not widen the agent→host boundary (same argument as `devcontainerized-expose-url`).

## Shipped vs. remaining
**Shipped:** the `tonoman/chrome` sidecar image (`images/browser/`), the per-agent
sidecar provisioning + CLI (`create/get/open/close/delete browser`, unit-tested), the
persistent per-agent profile volume, and the **host-Chrome backend** (live-proven).

**Remaining:** a brokered self-provision on first browse (`browser ensure` from the
in-sandbox shim, idempotent — today provisioning is the operator's `create browser`); a
`browser-smoke` real-podman test (spin → drive → outcome-verify); and raw-CDP helper
unit tests covering the generic drive path.
