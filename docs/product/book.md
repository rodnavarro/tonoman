# Tonoman and the book

Status: living list, branch `feat/book` (Rod, 11/25). This branch holds what Tonoman must do so each project in
the book can run on Tonoman.

The book *Think. Steer. Amplify.* (Rod Navarro, 2026) teaches small-business owners to use AI in 30 days, with 7
projects. **The first edition uses routes that work today** (Claude, ChatGPT, Zapier, Make, n8n, and the owner's
own always-on computer). Days 23 and 24 use Tonoman Cloud (second brain, receipts); elsewhere Tonoman appears as an option for running agents on your own computer. When a gap below is
closed, a later edition can move that project to Tonoman, or add a chapter on how to use Tonoman.

## Principles

1. **The agent acts under rules, not under approval.** The owner writes the rules once (prices as ranges, service
   area, voice, what never to promise, when to call the owner). The agent tests against them, then acts. The owner
   sees only the exceptions.
2. **AI earns its place in conversations.** An instant first email is an autoresponder. The value is the
   back-and-forth at chat speed (text, Messenger, DMs) until a call or visit is booked.
3. **Local first.** The simplest home for an always-on agent is a computer that stays on at the owner's home or
   shop. It uses the owner's own internet and accounts and costs nothing extra. Tonoman is free to run there, with
   no usage limits.
4. **Build locally, move to the cloud later.** The owner drives Claude Code or Codex to build the skills on their
   own computer. Later, one command moves the same agent to Tonoman Cloud with its secrets.
5. **Glue in the cloud, browsers at home.** Tonoman Cloud is for glue: the second brain, git, Google Drive, Slack.
   We do not offer browsers in data centers that act as the owner on Facebook or LinkedIn, and we do not help get
   past a site's bot checks.
6. **Small scope.** Build what the book's flows need, in the order below.

## Gaps, per project

| Book project | What the first edition uses | What Tonoman needs |
|---|---|---|
| Day 9, morning brief | Scheduled task in Claude or ChatGPT | Schedules the owner sets by chat; Gmail read and drafts in the right thread; delivery to the phone (Slack today; text or WhatsApp later); a brief that runs without the meeting-recap skill |
| Day 15, website | Coding agent; free static host | Publish to a live address with a phone preview; a form that writes to the lead sheet |
| Day 17, reviews | Browser agent once; review requests by an automation service | Trigger on a job marked "done" in the sheet; send a review request by text or email; reply to good reviews under rules |
| Day 19, leads to a sheet | Meta's lead integration, Zapier or Make | Inbound webhook per agent; Sheets read and write; duplicate check |
| Day 23, second brain | **Tonoman Cloud**: Start free, Slack, and the Claude connector; a Drive folder for ChatGPT users | **Live since 11/25:** Start free (Google or an email link) makes a free tenant with one agent and room for three people, and opens a Setup screen; the Claude connector answers at `api.tonoman.com/mcp`. The brain is a private repository in the owner's own free GitHub organization. Then: one-click "Add to Slack" (today: one token from Slack's app page, then one button); sign in to the AI plan from the Hub (today: `!connect claude` in Slack); fill the brain from existing emails, site and reviews in one sitting |
| Day 24, receipts | **Tonoman Cloud**: receipt photos in Slack (built; the owner adds the Receipts skill and picks their brain); emailed receipts through Claude with the connector | Receipts from Gmail; ledger in a Google Sheet; images in Drive; monthly match against a bank CSV; export for the accountant |
| Day 27, inspection | The owner runs a punch list | A test runner: run the punch list against the rules after every change, post pass/fail |
| **Day 28, every lead answered in 5 minutes** | An automation service with texting and an AI step, or a ready-made service (see the book) | **Lead responder, below** |
| Day 29–30, crews | Scheduled tasks; results posted to one place | Schedules; posting results to one Slack channel; exceptions only |

## The lead responder (first to build)

Runs on the owner's own computer first (open-source runtime), then in Tonoman Cloud.

- Checks the lead sheet every 60 seconds (a skill with `poll_seconds: 60`; no inbound webhook needed at home).
- First text within a minute: the lead's name, an answer, a price range from the rules page, one question, two
  free calendar slots.
- Keeps the conversation going: replies come back to the business number; the state of each lead is kept in the
  sheet (new, engaged, qualified, booked, lost, handed off).
- Follows up if the lead goes quiet, then stops.
- Guardrails in code, not in the prompt: texting hours, a cap on messages per lead, STOP list, SMS consent column
  required, service-area check.
- Asks the owner in Slack only for exceptions: emergency words, anger or "talk to a person", price push past the
  range, a job over the owner's limit, a question the rules do not cover.
- Watch mode for the first days: every conversation mirrored to a Slack thread with "take over".
- `/pause leads` and `/resume leads`; one summary a day.

Needs: Twilio (two-way texting, with US A2P 10DLC registration), Google Sheets and Calendar (free/busy, create
event), conversations with people who are not members of the tenant, delayed sends.

## Also needed

- **Install with your coding agent.** One page, `docs/install-with-your-agent.md`, for Claude Code and Codex to
  follow on Windows and macOS: Node, podman, the agent image, Slack, login, start on boot, keep awake. Test it on a
  clean computer before the book points to it.
- **`tonoman push <agent>`**: move an agent built locally (skills, rules page, schedule) to Tonoman Cloud and ask
  for each secret once.

## Open questions

1. Licence: the runtime is Apache-2.0 on `main`; a branch moves it to the Sustainable Use License. The book can say
   "open source" only while it is Apache-2.0; otherwise "free to run on your own computer".
2. The public README describes Telegram and Teams. The book names Slack only. Add Slack to the README's getting
   started before the book points to it.
