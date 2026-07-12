---
name: register-business-card
description: Read a business-card photo, extract the contact, append it to a simple CSV list in the agent's files, and ask the operator what to do with the data. Use whenever a business-card image arrives, even with no caption — including casual prompts like "what's in this image?" when it's clearly a card.
allowed-tools: Bash, Read, Write, Edit
argument-hint: "<path to the business card image>"
---

# Register a business card (generic)

The simplest end-to-end flow: **a card image arrives → the contact is extracted →
it is appended to a CSV the operator can open in Excel → the agent asks what to do
next.** Deliberately generic — no org-specific classification. (A roster can layer a
richer skill on top by registering its own; this one is the baseline.)

## Where things live (inside the sandbox)
- **Card store:** `${CARDS_DIR:-~/files/cards}` — a folder granted to the agent
  (`tonoman create mount cards <host> -a <agent>`). Images go in `images/`, the running
  list is `contacts.csv` at its root. If no `cards` mount is granted, fall back to the
  agent's memory workspace (`~/.tonoman/cards/`), which is git-versioned + auto-committed.
- **Secrets:** if a later step needs an API key/token, it goes under `secrets/` (or a
  `*.secret` file) — that path is git-ignored by default and is NEVER committed.

## Step 0 — Ensure the store exists
```bash
CARDS_DIR="${CARDS_DIR:-$HOME/files/cards}"
[ -d "$HOME/files/cards" ] || CARDS_DIR="$HOME/.tonoman/cards"   # fall back to git memory
mkdir -p "$CARDS_DIR/images"
[ -f "$CARDS_DIR/contacts.csv" ] || printf 'captured,name,title,company,phone,email,website,notes,image\n' > "$CARDS_DIR/contacts.csv"
```

## Step 1 — Store the raw image (evidence first)
Keep the original bytes; don't rely only on extracted text.
```bash
SRC="<the image path you were given>"
EXT="${SRC##*.}"; [ "$EXT" = "$SRC" ] && EXT=jpg
SLUG="$(date +%Y-%m-%d)-<company-kebab>-<lastname>"   # fill after you read it
cp "$SRC" "$CARDS_DIR/images/$SLUG.$EXT"
```

## Step 2 — Read the card, extract the contact
Read the stored image and pull what you can see: **name, title, company, phone,
email, website, address, tagline/notes**. Record what's actually there; leave unknowns
blank. Fix `$SLUG` (re-`mv` the image) so the filename matches the contact.

## Step 3 — Append one CSV row
Append a single row to `contacts.csv` (quote any field containing a comma). The CSV
opens cleanly in Excel/Sheets — that's the point.
```
2026-06-04,Jane Doe,Owner,Acme Roofing,555-1212,jane@acme.example,acme.example,,images/2026-06-04-acme-roofing-doe.jpg
```

## Step 4 — Ask what to do with the data
Reply tight with the captured contact, then **ask the operator where they want this to
go** — the default is "kept in your `contacts.csv` (open it in Excel anytime)". Offer,
without doing it unless asked:
- **Google Sheets** or **an API/CRM** — if they pick one, you can *build a small sender
  tool* for it, store that script in your memory (`~/.tonoman/tools/`, git-versioned),
  and reuse it next time. Any credential the tool needs goes under `secrets/` (never
  committed). Confirm the destination + creds before sending anything.
- Keep it local (the default) — nothing leaves the agent's files.

Example reply:
> Captured **Jane Doe — Acme Roofing** → added to `contacts.csv` (open in Excel).
> Want me to also send these to Google Sheets or a CRM? I can wire that up; otherwise
> I'll keep building the list locally.

## Guardrails
- If the user asks "what's in this image?" and it's clearly a business/contact card,
  treat it as a registration request: register first, then answer with the summary.
- Phone contact-card screenshots count. Capture the screenshot; record visible rows; if
  rows are cut off, mark them unreadable rather than guessing.
- If you genuinely can't read the image, store it anyway with a `needs-review` note in
  `contacts.csv` rather than dropping it.
- **Never** commit or print a secret. Credentials live under `secrets/` / `*.secret`
  (git-ignored). The card data itself is non-secret and belongs in the versioned store.
