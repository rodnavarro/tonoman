[[_TOC_]]

# Track: identity-roster — email-verified sender identity, from a mounted roster

Today the gateway tells the agent *who is speaking* using the Teams **display name**
(`activity.from.name`), matched against names written into the agent's `AGENTS.md`
(`teams-identity-aware` / D15, `router.ts` `# Current user`). That is **brittle and
spoofable**: anyone in the tenant who sets their display name to "Priya Raman" is treated
as the billing **approver** — and this agent *sends real invoices* on her approval.

This track ties identity to the sender's **email** instead, resolved from Teams and matched
against a **people roster** that is **mounted as a ConfigMap** (not baked into the image), so
adding an address to someone's profile is a chart edit + pod restart — **no image rebuild**.

> **Channel ⊥ identity.** Email resolution lives in the Teams connector (it owns the Bot
> Framework surface); the roster + recognition live in the harness-neutral router, so any
> future connector that can surface a sender email reuses the same roster.

> **Run:** `npm test` → connector member-email resolution (fetch faked) + router recognition
> + roster load/match (pure). FREE — no container, no tokens. Live proof rides `live/`.

---

## The roster file (ConfigMap-mounted) — SPEC (review gate)

A single JSON document, mounted read-only into the **gateway** pod at a configured path
(`people_file`, or `TONOMAN_PEOPLE_FILE`). One entry per person; **one or more emails** each.

```json
{
  "people": [
    { "name": "Dana Whitfield",  "role": "Owner / CPA — the principal",
      "emails": ["dana@northgate.example", "d.whitfield@northgate.example"] },
    { "name": "Priya Raman", "role": "Office Manager & billing reviewer — the approver",
      "emails": ["priya@northgate.example"] },
    { "name": "Dede Smith",    "role": "General Manager", "emails": [] },
    { "name": "Rod",           "role": "Operator (runs & maintains the assistant)",
      "emails": ["rod@example.com"] },
    { "name": "Rod2",          "role": "Operator (second test identity)",
      "emails": ["rod2@example.com"] }
  ]
}
```

(Dede's address is pending — an entry with no emails simply never matches until one is added.
Rod and Rod2 are two DISTINCT roster people on two different emails, used to prove the agent
recognizes them as separate users — see `identity-roster-distinct`.)

Matching is **case-insensitive** and by **exact email**. A person matches if *any* of their
emails matches the sender. Editing this file (add an email, add a person) + restarting the
gateway changes identities live; the image is untouched.

---

## Scenarios

### `identity-email-resolve` — the sender's email is resolved from Teams
- Given an inbound Teams message from a user with AAD/member id `<fromId>`,
- When the connector normalizes it,
- Then it resolves the sender's **email** via the Teams members roster API
  (`GET {serviceUrl}v3/conversations/{conversationId}/members/{fromId}`) using the **existing
  bot token** (no Graph, no extra consent) and puts it on the envelope as `email`
  (falling back to `userPrincipalName` when `email` is absent).

### `identity-email-cached` — resolution is not re-fetched every turn
- Given the same sender messages repeatedly within a short TTL,
- Then the members API is called **once** and the cached email is reused (one network call
  per sender per TTL, not per turn).

### `identity-email-nonfatal` — resolution failure degrades, never breaks the turn
- Given the members API errors or returns no email,
- Then the turn still runs; the envelope carries **no verified email**, and recognition falls
  back to the display name **explicitly marked unverified** (see `identity-roster-unknown`).
  A billing agent that can't verify identity must not silently *look* verified.

### `identity-roster-load` — the roster loads from the mounted file
- Given a `people_file` path pointing at the mounted ConfigMap,
- When the gateway starts,
- Then it loads the people roster; a malformed/missing file logs loudly and yields an **empty
  roster** (everyone is "unknown") rather than crashing the gateway.

### `identity-roster-match` — a known email is named + role-tagged, email-verified
- Given the roster above and a sender whose resolved email is `priya@northgate.example`,
- Then the `# Current user` block names **Priya Raman**, states her **role** (the approver),
  and marks the identity **verified by email** — so the agent greets and applies role by a
  fact it cannot be talked out of, not by a claimed name.

### `identity-roster-multi-email` — any of a person's emails resolves them
- Given Dana has both `dana@northgate.example` and `d.whitfield@northgate.example`,
- Then a message from **either** address is recognized as **Dana Whitfield** with his role.

### `identity-roster-distinct` — different emails resolve to different people
- Given Rod (`rod@example.com`) and Rod2 (`rod2@example.com`) are two separate
  roster entries,
- When one message arrives from each address,
- Then each is recognized as its **own** person — **Rod** vs **Rod2** — because identity is
  keyed on the email, not the human or the display name. (Proves per-email distinctness.)

### `identity-roster-unknown` — an unrecognized email is surfaced as unverified
- Given a sender whose email (or display-name fallback) is **not** in the roster,
- Then the `# Current user` block says the speaker is **unverified / not a known member** and
  carries **no role** — the agent must not treat them as an approver (its `AGENTS.md`
  "when unsure who may approve, ask" rule then governs).

### `identity-roster-restrict` — roster-only gate with a deterministic refusal
- Given `restrict_to_roster: true` (the Atlas default),
- When a sender whose email is not in the roster messages the bot,
- Then the connector does **not** run a turn (no LLM, no cost) and replies with a **fixed,
  deterministic** notice naming the address, e.g. `Sorry — the email 'x@y.com' is not
  authorized to use this assistant.` — refused, but never silent.
- And when the sender's email **cannot be resolved/verified** at all under restrict, the same
  deterministic refusal applies (fail-closed: an unverifiable sender is not authorized).

### `identity-roster-configmap-reload` — add an address without a rebuild
- Given the roster is a mounted ConfigMap,
- When an operator adds an email to a person and restarts the gateway,
- Then subsequent turns from that address are recognized — **no image build, no code change**.
