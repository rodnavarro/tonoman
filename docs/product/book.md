# Tonoman and the book

Status: proposal for review (11/25). Branch `feat/book`.

The book *Think. Steer. Amplify.* (Rod Navarro, 2026) teaches small-business owners to use AI in 30 days, with 7
projects. Several projects need an agent that is always on and acts by itself. This doc says what the book tells
readers to use at launch, and the smallest Tonoman release that makes those projects work.

## Principles

1. **The agent acts under rules, not under approval.** The owner writes the rules once (prices as ranges, service
   area, voice, what never to promise, when to call the owner). The agent tests against them, then acts. The owner
   sees only the exceptions. A book that says "reply in 5 minutes" and then "approve every reply" misleads the reader.
2. **AI earns its place in conversations.** An instant first email is an autoresponder; that is old. The value is
   the back-and-forth at chat speed (text, Messenger, DMs) until a call or visit is booked.
3. **Local first.** The simplest home for an always-on agent is a computer that stays on at the reader's home or
   shop (an old laptop or a Mac mini). It has a home internet connection, it is the owner's own machine and
   accounts, and it costs nothing extra. Tonoman is open source, so a local install has no usage limits.
4. **Build locally, move to the cloud later.** The reader drives Claude Code or Codex to build the skills and
   scripts on their own computer. Later, one command moves the same agent to Tonoman Cloud, with its secrets. That
   move is v1.1, not launch.
5. **Glue in the cloud, browsers at home.** Tonoman Cloud is good at glue: the second brain, git, Google Drive,
   Slack. Browsing the web as the owner (Facebook, LinkedIn) at scale from a data center is not something we offer.
6. **Small scope.** Ship what the book's flows need. Name the alternatives (Zapier, Make, n8n) so the book is not
   a pitch.

## What the book says at launch (book v1.0, upload 11/28)

| Project | What runs it | Tonoman's part | Alternatives named |
|---|---|---|---|
| 1. Morning brief (Day 9) | Scheduled task in Claude or ChatGPT; or Tonoman on the home computer | Brief in Slack; routine replies under rules; drafts in Gmail | Zapier schedule + AI step |
| 2. Website (Day 15) | Coding agent; publish to a free host | none | Netlify, Cloudflare Pages, Lovable |
| 3. Google profile and reviews (Day 17) | Browser agent once; review requests under rules | Review-request skill (later) | Zapier, Make |
| 4. Facebook leads to a sheet (Day 19) | Meta's lead integration or Zapier/Make | none | n8n |
| 5. Receipts (Day 24) | Tonoman (built today: receipts sent as photos in Slack) | Receipts skill | QuickBooks capture, Dext |
| 6. Every lead answered in 5 minutes (Day 28) | Tonoman on the home computer, lead-responder skill | Section below | Zapier/Make/n8n + Twilio + AI step; GoHighLevel, Podium |
| 7. Crews and 90-day plan (Day 30) | Tonoman skills on a schedule, results in one Slack channel | Schedules | Zapier, n8n |

A short new section in the book, "Where your agents live", explains:

- **Your own computer, always on** (recommended). Install the agent with your coding agent. Keep the computer
  awake and plugged in. A Mac mini or an old laptop is enough.
- **The cloud** (coming in Tonoman Cloud v1.1): the same agent, moved with one command.
- **Agents that browse the web from the cloud** exist, but the sites they visit often block data-center traffic,
  and automating a personal Facebook or LinkedIn account can break those sites' terms and get the account closed.
  Use the official tools (Meta's lead forms and inbox automations) where they exist.

## Tonoman v1.0.1: the minimum for the book

Everything here runs on the reader's own computer with the open-source runtime. Size: S = a day, M = a few days.

1. **Install with your coding agent (M).** One page, `docs/install-with-your-agent.md`, written for Claude Code and
   Codex to follow on Windows and macOS: Node, podman, the agent image, Slack app, login, start on boot, keep awake.
   The reader's prompt in the book is one line: "Install Tonoman from github.com/rodnavarro/tonoman and connect it
   to my Slack."
2. **Lead-responder skill (M).** `examples/skills/lead-responder/`:
   - Polls the lead sheet every 60 seconds (`poll_seconds: 60`; no inbound webhook needed at home).
   - First text within a minute: name, answer, a price range from the rules page, one question, two free calendar
     slots.
   - Keeps the conversation going: replies come back by the Twilio number; state per lead in the sheet
     (new, engaged, qualified, booked, lost, handed off).
   - Follow-ups at +1 hour, next morning, day 3, day 7, then stop.
   - Guardrails in code, not in the prompt: quiet hours (8 a.m. to 8 p.m., lead's time zone), at most 6 messages per
     lead, STOP list, SMS consent column required, service-area check.
   - Escalates to the owner's Slack only for: emergency words, anger or "talk to a person", price push past the
     range, a job over the owner's limit, a question the rules do not cover.
   - Watch mode for the first days: every conversation mirrored to a Slack thread with "take over".
3. **Lead rules page template (S).** A page in the second brain: prices as ranges, service area, hours, voice,
   never-promise list, escalation list. The skill reads it on every turn; the owner edits it by chat ("raise water
   heaters to $1,800").
4. **Inspection before go-live (S).** `!skill lead-responder test` runs 10 sample leads against the rules page and
   posts pass/fail to Slack. It runs again after every rules change.
5. **Pause switch (S).** `/pause leads` and `/resume leads` in Slack stop and start the skill at once.
6. **Daily digest (S).** One Slack message at 6 p.m.: leads in, replied in under 5 minutes, booked, handed off.
7. **Morning-brief and review-request skills (M, after 6).** Same pattern: schedule, rules page, act, report
   exceptions.

Not in v1.0.1: inbound webhooks, Messenger or Instagram connectors, Gmail send, a desktop app, anything in the cloud.

## Tonoman Cloud v1.1: from your computer to the cloud

- `tonoman push <agent>`: moves an agent built locally (skills, rules page, schedule) to the reader's Tonoman
  Cloud tenant, and asks for each secret (Twilio, Google) once.
- Self-serve signup (start free, Google login), one-click "Add to Slack".
- Inbound webhooks per agent, so a form or Zapier can post a lead without polling.
- The book's second edition points the projects at this.

## Not doing

- Browsers in data centers that act as the owner on Facebook or LinkedIn, mobile-IP proxies, or anything meant to
  get past a site's bot checks.
- A Tonoman desktop app, for now. The install page plus a coding agent does the same job.

## Open questions

1. Licence: the runtime is Apache-2.0 on `main`; a branch moves it to the Sustainable Use License. The book can say
   "open source" only while it is Apache-2.0; under the new licence say "free to run on your own computer".
2. Twilio needs A2P 10DLC registration for US business texting (days to weeks). The book must tell readers to start
   it on Day 19, not Day 28.
3. Florida (the first readers) limits texting hours and counts; check the current rules before print.
