# Live: control-loop

The pilot live journey — proves what fakes can't: a real turn does real work, a `/btw`
aside answers off the live turn, and `/model` round-trips. Real container, real tokens.

> **Run:** `npm run test:live -- src/live/control-loop.live.test.ts`
> **Target:** `TONOMAN_LIVE_AGENT` (default `cody`). Skips if the agent isn't authenticated.

## `int-control-loop`

Operator gives the agent a real task and uses the control surface while it runs:

1. **turn** — "create `notes.md` in your workspace with 3 facts about containers, then say done."
   → turn finishes, reply non-empty, and **`notes.md` actually exists** on disk.
2. **btw** — fire `/btw "what are you doing?"` while a turn runs → a **separate** marked reply comes
   back, the main turn still finishes, the aside is **not** in the transcript, and **no sidecar
   container is left** behind.
3. **model** — switch the model → the next turn runs fine on it.

Asserts **structure, not model text** (exit ok, file present, reply non-empty, no leftover container).
Everything else (`/steer`, `/pop`, queue, validation, transport) is already covered free in
[`contracts/`](../contracts/README.md).
