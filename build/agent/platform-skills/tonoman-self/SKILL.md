---
name: tonoman-self
description: How you (a tonoman agent) operate yourself in the tonoman environment — persist a learning durably with `tonoman learn`. Use when the user teaches you a lasting rule or wants a skill improved ("from now on…", "always…", "remember this permanently", "update your finance skill to…").
allowed-tools: Bash
---

# Operating yourself in tonoman

`tonoman` is on your PATH in every agent image. Beyond running your work, it lets you **persist what
you learn so it survives `/new` and restarts** — because ordinary conversation memory does not. When
the user teaches you a durable rule, don't just remember it for this chat: **record it with
`tonoman learn`**, which routes it to the right git for you.

## Decide the scope first

- **personal** — a fact or preference that's *yours* (how you label a vendor, a per-user habit). Goes
  to your OWN brain and takes effect on your next session. No approval needed.
- **shared** — a change to a **shared skill** you were assigned (e.g. `finance-intake`). This is a
  *proposal*: it opens a **pull request** for a human to review and merge. Your live behavior does not
  change until it merges.

If unsure which, ask the user: "should this be just for me, or a change to the shared skill everyone uses?"

## Persist it

**A personal rule:**
```bash
tonoman learn --scope personal --reason "<one-line why>" --content "<the rule, one or more lines>"
```

**A shared-skill change** has two steps — iterate locally, then propose upstream:

1. **Edit the skill file directly to try it live.** Your skill files under `~/.claude/skills/<name>/`
   are a **writable working copy** — just edit `SKILL.md` with your normal file tools. The change is
   live for your next turn (test it). This is local iteration; nothing is shared yet.
2. **When it's right, propose it upstream** so it becomes canonical and everyone gets it:
   ```bash
   tonoman learn --scope shared --skill <skill-name> --reason "<one-line why>" --content-file ~/.claude/skills/<skill-name>/SKILL.md
   ```
   This opens a **pull request**. Your live copy already has the change; the PR makes it permanent + shared.

## Pull merged changes: `tonoman sync`

To refresh your skills to the latest **canonical** upstream (e.g. after a PR merged), run:
```bash
tonoman sync
```
This discards local scratch edits and takes canonical `main`. (Un-proposed local edits you want to keep
should be `tonoman learn`'d first.)

## Do NOT hand-roll git for memory or skills

You have `git` and `gh` for ordinary development work. But to persist **your memory or a skill**, use the
`tonoman` verbs above — **never raw `git`/`gh`** for those. The verbs write to the *right* repo, as the
*right* author, with the *right* gate (your brain has none; a shared skill needs a PR). Raw git for these
will end up in the wrong place or skip the review.

## Report the receipt

`tonoman learn` prints a JSON receipt. **Always tell the user what happened**, using its `summary`:
- personal → "Saved to my brain — <reason>."
- shared → "Proposed a change to the shared <skill> skill — pending your review: <PR url>." Give them the link.

Never claim you'll "remember" a durable rule without actually running `tonoman learn` — that's the only
thing that makes it stick.
