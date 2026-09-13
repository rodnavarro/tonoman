# Substrate-owned, git-backed memory

The agent's memory is **Tonoman's**, not the harness's: a git-backed JSONL transcript per
conversation, in the same mounted workspace as the agent's work product. Tonoman owns the format
(one event per line: role, text, timestamp, a compact tool summary), reads the recent window into
each prompt, and commits after each turn. Nothing depends on `claude`'s private session files.

This is the feature-level view of architecture.md **§A3**. It's read and written by the turn loop
([`gateway-turn-loop.md`](gateway-turn-loop.md)) and lives behind the `MemoryStore` contract.

---

## The contract and its implementation

`MemoryStore` (`src/core/contracts.ts`) is small: `readWindow` · `append` · `commit` · `newSession`,
plus the optional `harnessSession` / `markHarnessSession` used only for cache reuse. The concrete
store is **`GitStore`** (`src/memory/gitstore.ts`). A `Message` is `{ role, text, ts, tools? }`.

## One turn's memory interaction

```mermaid
sequenceDiagram
    autonumber
    participant R as Router
    participant Mem as GitStore
    participant Run as Runner (claude -p)

    alt default (substrate-owned window)
        R->>Mem: readWindow(conv, windowSize)
        Mem-->>R: last N messages (parsed from the active JSONL)
        R->>R: buildPrompt(identity + window + new message)
        R->>Run: run(req)  %% no --resume; the window is IN the prompt
    else session_persist (harness holds history)
        R->>Mem: harnessSession(conv) → { id, isNew }
        Mem-->>R: a harness UUID (minted on first turn)
        Note over R,Run: window read only when isNew; else just the new message rides in
        R->>Run: run(req + sessionId)  %% --session-id (create) then --resume (reuse cache)
        R->>Mem: markHarnessSession(conv)  %% first turn only
    end
    Run-->>R: final assistant text
    Note over R: skip the write on a hard cut (interrupt / reset)
    R->>Mem: append(conv, {user…}, {assistant…})  %% one JSON object per line
    R->>Mem: commit("turn: <conv> (<agent>)")
    Note over Mem: git add -A → commit → push only if remote + token;<br/>BEST-EFFORT — any failure is logged, never thrown, so a bad<br/>workspace file cannot kill the turn. "nothing to commit" = success.
```

The push authenticates with an `http.extraheader` bearer built from an env token — **never written to
git config**. Secret safety: `ensureRepo` installs a once-only, never-clobbered `.gitignore`
(`secrets/`, `*.secret`), so a credential in the workspace can't be committed by accident.

## Harness sessions & cache reuse

For prompt-cache reuse, the store maps the conversation's **current substrate session** to a **harness
UUID** (a `<session>.cc.json` sidecar). The first turn creates it (`--session-id`); later turns
`--resume` it, so the window is *not* re-sent and the cache is reused. `/new` rotates the substrate
session id (`newSession` writes a fresh id into a `CURRENT` pointer); because the UUID sidecar is keyed
by that id, `/new` yields a **fresh harness session automatically** while the prior transcript stays on
disk — amnesia, not data loss. A stale `--resume` miss (wiped volume) self-heals: rotate and retry once.

---

## Corrections folded in from the code (this doc supersedes the older prose)

- **The on-disk layout is a per-conversation *directory*, not a flat file.** §A3 shows
  `sessions/<conversation>.jsonl`; that flat path is now the **legacy fallback only** (read so an
  upgrade never drops old memory). The live layout is `sessions/<conv>/<sessionId>.jsonl` selected by a
  `CURRENT` pointer, plus `<sessionId>.cc.json` harness-UUID sidecars.
- **"No `--resume`, window every turn" is the default, not an absolute.** The opt-in `session_persist`
  path resumes the harness session and sends only the new message (see the diagram). The
  substrate-owned default is still exactly as §A3 describes.
- **The harness-UUID mapping isn't in §A3's prose at all** — it's a genuine gap the diagram above fills.

_Compaction (summarising an old window behind the same JSONL contract) remains deferred, off the v0.1
path — consistent with the code, which has no compaction call._
