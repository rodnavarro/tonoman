# Building a Talent — the Tonoman Talent SDK

A **Talent** is a capability you give an agent: it takes one item of work (a recording, a document,
an event), does something useful with it, and reports an outcome. The Plaud meeting-recap — transcribe
a recording, summarise it against the tenant's mission, file it in the second brain — is the first
Talent, and this guide is written so a developer *or a coding agent* can build the next one quickly.

The one idea to hold onto: **a Talent is a self-contained CLI.** It has its own entrypoint and
dependencies, it talks to Tonoman through a small, fixed contract (environment + stdin/stdout + a few
HTTP capabilities), and it imports the SDK and nothing else from the runtime. That boundary is what
lets the same Talent run on your laptop and inside Tonoman unchanged, and what lets it live in its own
git repo.

> **Status (2026-09-12).** The **contract** on this page is locked in code (`src/talent-sdk`). The
> **runtime** that runs a Talent against it — the `runCli` bootstrap, the capability plane, and the
> local dev harness — is landing increment by increment; sections below are marked _(available)_ or
> _(landing)_ so you know what you can run today. The shape will not change under you.

---

## 1. Anatomy of a Talent

A Talent is a folder. First-party Talents live in this repo under `src/talents/<group>/<name>/`; a
third-party Talent is the same shape in its own repo.

```
src/talents/voice/plaud-and-calendar-meetings/
  manifest.ts   # what the Talent is, needs, and can be configured with
  run.ts        # the work: one item in, one outcome out
  index.ts      # wires the SDK bootstrap to your run() — the CLI entrypoint
```

Written in **TypeScript or JavaScript** (it runs on Node). TypeScript is the default and what the
examples use; plain JS works the same way.

---

## 2. The manifest — what your Talent declares

The manifest is data. It is how Tonoman knows what your Talent needs before it runs it, and it is
what the Hub renders a configuration form from. Changing it is a code change and a new `version`.

```ts
import type { TalentManifest } from '../../../talent-sdk';

export const manifest: TalentManifest = {
  name: 'meeting-recap',          // the canonical id — stable; the DB, roster and run records key on it
  version: 1,                     // bump when requires/capabilities/configSchema change
  description: 'Transcribe a recording, summarise it against the mission, and file it.',

  // RAW third-party credentials your Talent holds and uses DIRECTLY.
  requires: [
    { kind: 'plaud' },                      // cannot run without it
    { kind: 'calendar', optional: true },   // works without it — just does less
  ],

  // MEDIATED capabilities you call through Tonoman (see §4). You never hold the provider keys for
  // these — Tonoman routes, meters and bills them.
  capabilities: ['transcribe', 'infer', 'publish'],

  // Typed fields the installing agent fills; delivered back to you in ctx.input.config.
  configSchema: [
    { key: 'output_channel', type: 'channel', label: 'Where recaps are announced' },
  ],
};
```

**`requires` vs `capabilities` is the whole design.** A *credential* is a third-party account your
Talent talks to itself (Plaud, a calendar feed) — Tonoman hands you the login. A *capability* is a
service Tonoman performs on your behalf (transcription, inference, filing to the second brain) so
that provider choice, cost and the tenant's data stay Tonoman's, never baked into your Talent. If you
find yourself wanting a provider API key in `requires`, it probably belongs behind a capability.

`configSchema` field types: `channel`, `channel_list`, `text`, `toggle`.

---

## 3. `run()` — the work

Your Talent exports a `run(ctx)` that takes the context Tonoman builds and returns an outcome. It is
pure orchestration over `ctx`: **no `process`, `env`, or direct stdout** — the SDK owns that boundary.

```ts
import type { TalentRun } from '../../../talent-sdk';

export const run: TalentRun = async (ctx) => {
  const { item, config } = ctx.input;

  // A raw credential — use it directly. For a refreshable login, ask for a fresh one:
  const plaud = await ctx.credential('plaud');

  ctx.progress('transcribing');
  const audioUrl = await fetchRecordingUrl(plaud, item);      // your code, your dependency
  const { text } = await ctx.cap.transcribe({ audio: { url: audioUrl }, vocab: 'Acme, Tonoman' });

  if (!text.trim()) return { status: 'skipped', reason: 'no speech' };

  ctx.progress('summarising');
  // You own the prompt and the parse; the runtime runs it on the agent's own provider.
  const { text: json } = await ctx.cap.infer({
    system: 'Summarise this meeting as STRICT JSON: {"title","body","route"}.',
    user: `Transcript:\n${text}`,
  });
  const recap = JSON.parse(json) as { title: string; body: string; route: string };

  ctx.progress('filing');
  const filed = await ctx.cap.publish({ route: recap.route, title: recap.title, body: recap.body });

  return {
    status: 'done',
    summary: `Filed “${recap.title}” under ${recap.route}.`,   // announced verbatim by Tonoman
    steer: `A recap for ${item} is in the second brain.`,      // a hint the agent may act on
  };
};
```

### Report, don't speak

A Talent **does not talk to the channel.** It returns a `TalentOutcome`:

- `status`: `'done' | 'skipped' | 'failed'` — what the run record closes as.
- `summary?`: a human line Tonoman announces verbatim through the agent's existing say path.
- `steer?`: a hint the *agent* consumes to decide any follow-up to bubble to the user.
- `reason?`: why it was skipped or failed — recorded, not announced.

This keeps a Talent from holding a Slack channel, and keeps "what to say" a judgment the agent makes,
not something hard-coded in every Talent.

---

## 4. Capabilities — what Tonoman does for you

You call these through `ctx.cap`. Tonoman performs them with the tenant's configured providers; you
supply only what the work needs.

### `ctx.cap.transcribe({ audio, vocab?, onProgress? })`
Turns audio you fetched into text. `audio` is `{ url }` Tonoman can fetch, or `{ bytes, contentType }`.
The engine (groq, a Cloud-hosted local GPU) and its fallback order are the **tenant's** provider
chain, resolved below you — you get `{ text, seconds, by }`. Call `onProgress(done, total)` for long,
chunked audio so the run's heartbeat stays alive.

### `ctx.cap.infer({ system, user })`
Runs an inference **on the agent's own inference provider** — the Claude Code harness (its
subscription), the same brain that answers the agent's messages — not a side model with its own key.
A recap is the agent *thinking* about the meeting, so it runs on the agent's plan. You own the prompt
(`system` + `user`) and parse the returned `text`; the runtime owns which provider, the budget and
the billing. The provider is `claude-code` today; `codex` and an OpenAI subscription plug in at one
dispatch point later, and your Talent never changes — it just calls `ctx.cap.infer`.

### `ctx.cap.publish({ route, title, body, meta? })`
Files an artifact in the tenant's git-backed second brain and returns `{ published, path, url? }`. The
repo, credentials and routing are Tonoman's; you supply content and a route hint.

> Announcing is deliberately **not** a capability — see §3. Transcription is a capability, **not** a
> credential: that is why it is absent from `requires`.

---

## 5. The context your Talent receives

```ts
interface TalentContext {
  input: { item: string; config: Record<string, unknown>; user?: string };
  creds: Record<string, unknown>;              // raw credentials by kind
  credential(kind: string): Promise<unknown>;  // exchange a ref for a FRESH, refreshable credential
  cap: { transcribe; infer; publish };         // §4
  progress(note: string): void;                // keeps Temporal's heartbeat alive; side channel
  log(msg: string): void;                       // stderr; never stdout
}
```

`ctx.creds` carries short-lived credentials directly. For a **long-lived login** (Plaud's OAuth,
which must refresh across a 62-minute transcription), call `ctx.credential(kind)` when you need a
token — Tonoman returns a fresh one, so your Talent never manages refresh itself.

---

## 6. How a Talent runs — the contract under the SDK

You rarely touch this directly (the SDK's `runCli` does), but it is why a Talent is portable:

- **Environment** carries resolved credentials, `TONOMAN_CAPABILITY_URL` + a scoped token, and config.
- **stdin** carries the item to work and its config (one JSON object).
- **stdout** carries exactly one thing: the `TalentOutcome` JSON. Nothing else may be written there.
- **stderr / a progress stream** carries `ctx.progress` and `ctx.log` — kept separate so a large
  outcome can never starve the heartbeat.

Tonoman's worker spawns your CLI as a subprocess under Temporal, so you get retries, heartbeats and
exactly-once-per-item semantics **for free** — and because the work is a subprocess, not workflow
code, you are under no determinism constraints. Write ordinary imperative code.

`index.ts` wires it up _(landing)_:

```ts
import { runCli } from '../../../talent-sdk';
import { manifest } from './manifest';
import { run } from './run';

runCli(manifest, run);   // reads env + stdin, builds ctx, calls run(), writes the outcome
```

---

## 7. How a Talent is triggered

A Talent runs on a **schedule**, **on demand**, or both — the install decides:

- **Scheduled.** A cadence config (`poll_seconds`) wakes the Talent every N seconds to look for new
  items. Set it to **0** to turn the schedule **off** entirely — the Talent then runs on demand only.
- **On demand, like a tool.** `!talent <name> <item>` (in the agent's channel) runs the Talent on one
  item immediately, out of band from any schedule. Scheduled and on-demand runs share one per-item
  workflow id, so the same item is never processed twice.

## 8. Running it

**In Tonoman**: the agent is granted the Talent in the Hub; the worker spawns your CLI (scheduled or
on demand) with the environment above. You do nothing per-run. The agent's Claude CLI is already
authenticated there — which is exactly why `ctx.cap.infer` can run on its subscription.

**Locally** _(dev harness, landing)_: your Talent runs against the capability endpoints with your
*own* keys — and crucially, **your `claude` CLI must already be logged in**, because `infer` is a
cross-call to that same CLI (the agent's inference provider). That is the one setup step; it mirrors
the authenticated-harness state Tonoman's `runTalent` assumes. "Works on my laptop" then means "works
in Tonoman."

---

## 9. Checklist for a new Talent

1. Create `src/talents/<group>/<name>/` with `manifest.ts`, `run.ts`, `index.ts`.
2. Declare `requires` (raw credentials), `capabilities` (mediated), and `configSchema`.
3. Write `run(ctx)`: fetch with your credential, call capabilities, return an outcome — report, don't speak.
4. Keep stdout for the outcome only; use `ctx.progress`/`ctx.log` for everything else.
5. Prove it locally with the dev harness on a real item before it runs in Tonoman.

See `docs/architecture.md` §A15 for the runtime/Cloud boundary behind all of this.
