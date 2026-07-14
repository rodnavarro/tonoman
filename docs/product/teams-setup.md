# Put an agent in Microsoft Teams

A tonoman agent can live in Teams: your team chats with it like a colleague, in DMs or a channel.
This walks through the whole setup, start to finish.

**Time:** about an hour. **You need:** an Azure subscription, and a Microsoft 365 tenant where
someone can approve two things (see Part 1). Nothing here is tonoman-specific magic — you're
registering a normal Teams bot, then pointing it at your gateway.

**How the pieces fit:** Teams sends every message to one HTTPS endpoint you control. Your tonoman
gateway answers on `/api/messages`, hands the message to the agent, and streams the reply back.
Teams never talks to the agent directly, and the agent never knows it's Teams — which is why the
same agent works on other channels unchanged.

```
Teams  →  Azure Bot  →  https://<your-host>/api/messages  →  tonoman gateway  →  agent
```

---

## Part 1 — Permissions you'll need

If you administer the tenant yourself, grant these and move on. If you don't, you'll need someone
who does — and this section is written so you can hand the request over without a meeting.

Two things must be true before anything else works:

**1. You can register an application in Entra ID.**
This creates the bot's identity. It needs **no Graph API permissions** — no mail, no files, no
directory access. The bot only receives messages that are explicitly sent to it, and replies to
them. It cannot read channels it hasn't been added to, and it cannot see anything else in the
tenant. Many tenants already let any user register apps; if yours doesn't, you need it enabled for
your account.

**2. You can upload a custom app to Teams** (*sideloading*).
This is how the bot appears in the Teams client, and most tenants block it by default. It's granted
**per person**, not org-wide:

> **Teams admin center → Teams apps → Setup policies → Global (or a new policy)**
> Set **"Upload custom apps"** to **On**, and assign that policy to the people who need it.

Before you ask, know the two traps:

- **Guest accounts can never sideload**, no matter the policy. If your account is a guest in the
  tenant, no permission fixes it — you need a real member account.
- Policy changes take **up to 24 hours** to reach the Teams client. If "Upload a custom app" is
  still missing after it's been granted, that's usually why. Wait; don't redo the setup.

Once the agent is proven you can skip sideloading entirely by publishing it to the **org app
catalog**, so people install it like any other Teams app. Sideloading is the fast path to getting
one person talking to it today; the catalog is how you roll it out.

### Asking your admin

Copy this. It says what you need and — the part that usually unsticks the conversation — what you
don't.

> I'm setting up a chat assistant that lives in Teams. I need two things:
>
> 1. **Permission to register an application in Entra ID.** This is the bot's identity. It requires
>    **no Graph API permissions** — no access to mail, files, or the directory. The bot can only see
>    messages people explicitly send to it, and reply to them. It can't read channels it hasn't been
>    added to, and it can't see anything else in the tenant.
>
> 2. **Permission to upload a custom app to Teams**, so the bot appears in my Teams client. In the
>    Teams admin center that's **Teams apps → Setup policies**, setting **"Upload custom apps"** to
>    **On** for my account. It doesn't need to be enabled for anyone else.
>
> Both are scoped to me and to this one bot. Nothing else in the tenant is affected, and either can
> be revoked at any time.

---

## Part 2 — Register the bot

Two Azure resources: an **app registration** (the identity) and an **Azure Bot** (the connector to
Teams).

```sh
az login

# Names are yours to pick; the resource group is just a container.
RG=rg-my-agent
BOT=my-agent
az group create --name $RG --location eastus
```

**Create the app registration and its secret.**

```sh
# The app ID Teams will know the bot by.
APP_ID=$(az ad app create --display-name "$BOT" --sign-in-audience AzureADMultipleOrgs \
           --query appId -o tsv)

# The bot authenticates to Teams with this. Copy it now — Azure will not show it again.
az ad app credential reset --id "$APP_ID" --append --query password -o tsv

# REQUIRED: give the app a service principal in this tenant.
az ad sp create --id "$APP_ID"
```

That last command is easy to skip and the failure it causes is opaque — see
[Troubleshooting](#troubleshooting).

**Create the bot and turn on the Teams channel.**

```sh
az bot create --resource-group $RG --name $BOT --app-type MultiTenant \
  --appid "$APP_ID" --sku F0 --endpoint "https://example.com/api/messages"
az bot msteams create --resource-group $RG --name $BOT
```

`F0` is the free tier. The endpoint is a placeholder for now — you'll set the real one in Part 3.

Write down three values; you'll need all of them:

| value | where it came from |
|---|---|
| **app ID** | `$APP_ID` above |
| **app password** | the `credential reset` output — the one Azure won't show twice |
| **tenant ID** | `az account show --query tenantId -o tsv` |

---

## Part 3 — Give it a public HTTPS endpoint

Teams will only call a **public HTTPS URL with a valid certificate**. A self-signed cert fails
silently — the bot just never answers.

**In production:** point a DNS record at your gateway's ingress and let your cert issuer handle
TLS. Then:

```sh
az bot update --resource-group $RG --name $BOT \
  --endpoint "https://agent.example.com/api/messages"
```

**While developing,** run the gateway locally and expose it with a tunnel (`cloudflared tunnel
--url http://localhost:3979`, or the equivalent). Point the bot at the tunnel URL the same way.
Moving to production later is just re-running the command above with the real host — nothing else
changes.

---

## Part 4 — Configure the agent

Add the agent to your gateway config. The `teams` block is the only channel-specific part:

```json
{
  "agents": [
    {
      "name": "my-agent",
      "role": "what this agent is for",
      "harness": "claude-code",
      "channel": "teams",
      "teams": {
        "app_id": "<the app ID from Part 2>",
        "tenant_id": "<your tenant ID>",
        "port": 3979,
        "people_file": "/etc/tonoman/people.json",
        "restrict_to_roster": true
      }
    }
  ]
}
```

The app **password** does not go in the config — it's a secret, and it goes in the environment:

```sh
TEAMS_APP_PASSWORD=<the password from Part 2>
```

**`people_file`** is a roster mapping email addresses to names and roles, so the agent knows who
it's talking to and can address them properly:

```json
{
  "people": [
    { "name": "Dana Whitfield", "role": "Owner — the principal",
      "emails": ["dana@example.com"] },
    { "name": "Priya Raman",   "role": "Office manager — approves the work",
      "emails": ["priya@example.com"] }
  ]
}
```

Identity is resolved from the sender's **verified email**, never their display name — anyone in a
tenant can rename themselves, so trusting the display name would let one person impersonate another.

**`restrict_to_roster: true`** means only people in that file can talk to the agent. Leave it `true`
for anything that touches real data or money. Set it `false` only if you genuinely want the agent
open to everyone in the tenant.

Start the gateway. It should log that the Teams webhook is listening and the bot token is valid:

```
teams: webhook listening on :3979/api/messages
teams: bot token OK — outbound auth ready
```

If the token line is missing or errors, the password is wrong — fix that before continuing, because
nothing downstream will work.

---

## Part 5 — Install the app in Teams

Teams needs a small app package: a manifest plus two icons, zipped.

```
my-agent-app/
  manifest.json
  color.png      192×192
  outline.png    32×32, transparent, single colour
```

A minimal `manifest.json` — replace **every** `<app-id>` with the app ID from Part 2 (it appears in
three places, and missing one is the most common packaging mistake):

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "<app-id>",
  "developer": {
    "name": "Your Company",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "name": { "short": "My Agent", "full": "My Agent" },
  "description": {
    "short": "What this agent does",
    "full": "A longer description of what this agent does."
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#2A2A2A",
  "bots": [
    {
      "botId": "<app-id>",
      "scopes": ["personal", "team"],
      "supportsFiles": true,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

Zip the **contents** — not the folder:

```sh
cd my-agent-app && zip -r ../my-agent-app.zip manifest.json color.png outline.png
```

> Zipping the folder itself is the other common mistake: Teams rejects the package with a vague
> error because `manifest.json` isn't at the root of the archive.

Then in Teams: **Apps → Manage your apps → Upload an app → Upload a custom app**, and pick the zip.

If "Upload a custom app" isn't there, Part 1 hasn't taken effect — the policy is missing, hasn't
propagated yet, or the account is a guest.

Send it a message.

---

## Part 6 — Verify

**The endpoint is reachable and authenticating:**

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://agent.example.com/api/messages -H 'Content-Type: application/json' -d '{}'
```

**`401` is the correct answer.** It means the gateway is up, TLS is valid, and it's rejecting an
unsigned request — exactly what it should do. A `200` here would mean your bot accepts anything the
internet sends it. A timeout or `502` means Teams can't reach you either.

**The round trip:** message the agent in Teams. You should see it typing, then a reply. The gateway
logs one line per turn.

---

## Troubleshooting

**The bot never replies, and nothing appears in your logs.**
Teams can't reach your endpoint. Check the messaging endpoint is the current public URL (a dev
tunnel URL changes every restart), that it ends in `/api/messages`, and that the certificate is
real. Silent failure is the norm here — Teams will not tell you it couldn't connect.

**`AADSTS7000229`, or "Application with identifier … was not found in the directory".**
The app registration exists but has **no service principal in the tenant**. Run:

```sh
az ad sp create --id "$APP_ID"
```

This is the single most common setup failure, and the error message never says the word
"service principal".

**"Upload a custom app" is missing or greyed out in Teams.**
In order of likelihood: the app setup policy isn't assigned to that user; the policy was assigned
but hasn't propagated (**allow up to 24 hours**); or the account is a **guest**, which can never
sideload regardless of policy.

**The bot replies in a DM but is silent in a channel.**
In a channel it only sees messages that **@mention** it — that's Teams' behaviour, not a bug.
Make sure `"scopes"` in the manifest includes `"team"`.

**Replies arrive as one block instead of streaming in.**
The bot token is valid (or you'd see nothing), but the streaming path fell back. Check the gateway
log for a streaming error on the first turn of a conversation.

---

## What you end up with

An agent in Teams that knows who it's talking to, replies as it thinks, and can be given real work.
The channel is just a transport — the same agent runs on a different channel by changing one
config block, with no change to the agent itself.
