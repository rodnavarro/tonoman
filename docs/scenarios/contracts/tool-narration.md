# Tool-call narration — don't leave the user blind during long tool work

A turn's long, silent tool phase (e.g. a 66s wiki clone) must show *what* the agent is doing, not
just a spinner. Channel-neutral: the harness emits tool events, the stream consumer decides how to
surface them, each connector renders in its own idiom. One producer, per-connector rendering.

## gw-tool-narration — the current tool is shown live

- **Given** a turn runs a tool (Bash, Read, Grep, …)
- **When** the claude-code stream reports it (the `assistant` message carries the `tool_use` block:
  name + input)
- **Then** the harness emits `{ kind: "tool", tool: <name>, text: <arg preview> }` — the preview is
  the primary arg (`command` for Bash, `file_path` for a file op, `pattern` for a search), whitespace-
  collapsed and bounded to 60 chars (never a full-payload dump — inputs can carry customer data).
- **And** the stream consumer surfaces it two ways, by channel capability:
  - **Inline** (Telegram / any editable, non-prefix channel): a `🔧 {tool}: {preview}` line rendered
    beneath the in-progress answer (existing behavior), superseded when the next text block resumes.
  - **Status cue** (Teams / prefix-stream): the consumer calls `reply.working("🔧 {tool}: {preview}")`.
    Interleaving the `🔧` line into the streamed text would break Teams' growing-prefix `streaminfo`
    rule (403 `ContentStreamNotAllowed`), so it rides the SEPARATE status trace instead — the same
    gray-italic message cue that otherwise shows "🤖 Cogitating…", now showing the real tool.

## The seam (why this is channel-neutral)

`Reply.working(status?: string)` is the single neutral hook: `status` is the current activity, opaque
to the router/consumer. A connector renders it however fits its surface; one that shows tools inline
may ignore the arg (its optionality means Telegram/noop need no change — TS assignability). No
consumer code knows about Teams `streaminfo` or Telegram typing; no connector knows about `tool_use`
blocks. Adding a connector inherits narration for free.

## Details

- **Immediacy**: a concrete tool status bypasses the Teams status-delay (`STATUS_DELAY_MS`) — real
  work is happening, so it shows now; the generic "working…" cue keeps its short delay so a quick
  reply never flashes one.
- **Carrier**: tool events cross the k8s split intact — `server.ts encodeEvent` already serializes
  `tool` + `text`; `httpRunner.decodeEvent` rehydrates them.
- **Emit point**: the `assistant` message (name + input), not `content_block_start` (which has the
  name but no args yet — they stream via deltas). Its redundant summary text is ignored.

## Coverage

- `claudecode.test.ts` — `parseLine` emits a tool event with preview from an assistant `tool_use`
  message; ignores text-only assistant messages; `toolPreview` picks the primary arg / bounds length.
- `stream.test.ts` — a tool event routes into `working()` (prefix + non-prefix); prefix-stream never
  interleaves the `🔧` line into the streamed text; non-prefix shows it inline AND pings `working()`.
- `teams.test.ts` — `working(status)` posts the tool label as the status trace immediately (no delay).
