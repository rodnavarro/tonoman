#!/usr/bin/env bash
# teams-quickstart.sh — stand up a tonoman agent on Microsoft Teams, locally, in ONE command.
#
# Collapses docs/product/teams-setup.md (a ~1hr manual slog) into a single run: it registers
# the Azure app + bot, opens a dev tunnel so Teams can reach your local gateway, provisions the
# agent (`tonoman create agent --channel teams …`), and generates the Teams app package to
# sideload. The only steps left for a human are the ones that REQUIRE one: approving tenant
# permissions (once) and clicking "Upload a custom app" in Teams.
#
#   scripts/teams-quickstart.sh --name cody --tenant <tenant.onmicrosoft.com> \
#       [--allowed-user <your-entra-object-id>] [--icon <url|path>] [--port 3979] \
#       [--rg rg-<name>] [--persona build/agent/cody/AGENTS.md] \
#       [-- <extra flags passed straight to `tonoman create agent`> ]
#
# Everything after a bare `--` is forwarded verbatim to `create agent`, so mounts/ssh/setup
# live at the call site (see the Cody example in scripts/README or the repo docs):
#   … -- --mount p=C:/Users/you/P --ssh-key C:/Users/you/.ssh/id_rsa --setup "…install aws…"
#
# Tool paths are overridable via env (Windows/Git-Bash: az is az.cmd, gh is gh.exe):
#   AZ, GH, CLOUDFLARED, NODE, PODMAN, TONOMAN_CLI  (defaults: az gh cloudflared node podman dist/cli.js)
#
# Secrets are NEVER echoed or written to the roster: the bot's client secret is written to a
# git-ignored .env.<name> file that you `source` before `tonoman up`.
set -euo pipefail

AZ="${AZ:-az}"; GH="${GH:-gh}"; CLOUDFLARED="${CLOUDFLARED:-cloudflared}"
NODE="${NODE:-node}"; PODMAN="${PODMAN:-podman}"; CLI="${TONOMAN_CLI:-dist/cli.js}"

NAME=""; TENANT=""; RG=""; PORT=3979; ICON=""; ALLOWED_USER=""; PERSONA=""; TUNNEL_URL=""
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --tenant) TENANT="$2"; shift 2;;
    --rg) RG="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --icon) ICON="$2"; shift 2;;
    --allowed-user) ALLOWED_USER="$2"; shift 2;;
    --persona) PERSONA="$2"; shift 2;;
    --tunnel-url) TUNNEL_URL="$2"; shift 2;;  # reuse an already-running public endpoint (https://…); skips cloudflared
    --bot-handle) BOT_HANDLE="$2"; shift 2;;  # globally-unique Azure bot handle (default: <name>-<appid8>)
    --) shift; EXTRA=("$@"); break;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$NAME" ] || { echo "error: --name is required" >&2; exit 2; }
[ -n "$TENANT" ] || { echo "error: --tenant is required" >&2; exit 2; }
RG="${RG:-rg-$NAME}"
LOC="${LOC:-eastus}"
PKGDIR="build/teams-app/$NAME"
ENVFILE=".env.$NAME"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

# --- 0. preflight -----------------------------------------------------------------
say "Preflight"
"$AZ" account show >/dev/null 2>&1 || { echo "not logged in: run 'az login --tenant $TENANT'"; exit 1; }
[ -f "$CLI" ] || { echo "tonoman CLI not built ($CLI) — run: npm install && npm run build"; exit 1; }
"$PODMAN" info >/dev/null 2>&1 || { echo "podman not reachable"; exit 1; }
# `az bot …` lives in the botservice extension — auto-install it without an interactive prompt.
"$AZ" config set extension.use_dynamic_install=yes_without_prompt -o none 2>/dev/null || true
TENANT_ID="$("$AZ" account show --query tenantId -o tsv | tr -d '\r')"
echo "tenant=$TENANT_ID  rg=$RG  port=$PORT"

# --- 1. Azure: app registration + secret + service principal ----------------------
say "Azure app registration"
"$AZ" group create --name "$RG" --location "$LOC" -o none
APP_ID="$("$AZ" ad app list --display-name "$NAME" --query "[0].appId" -o tsv | tr -d '\r')"
if [ -z "$APP_ID" ]; then
  APP_ID="$("$AZ" ad app create --display-name "$NAME" --sign-in-audience AzureADMultipleOrgs --query appId -o tsv | tr -d '\r')"
  echo "created app $APP_ID — waiting for directory propagation…"
  for i in 1 2 3 4 5 6; do "$AZ" ad app show --id "$APP_ID" >/dev/null 2>&1 && break; sleep 5; done
else
  echo "reusing existing app $APP_ID"
fi
# Azure Bot *handles* are GLOBALLY unique across all of Azure (not just your tenant), so a
# plain name like "cody" is usually taken. Derive a unique handle from the app id; the Teams
# DISPLAY name stays $NAME (set in the manifest). Deterministic → re-runs are idempotent.
BOT_HANDLE="${BOT_HANDLE:-${NAME}-${APP_ID:0:8}}"
echo "bot handle: $BOT_HANDLE  (Teams display name stays: $NAME)"
# service principal (the #1 silent failure if skipped — see teams-setup troubleshooting)
"$AZ" ad sp show --id "$APP_ID" >/dev/null 2>&1 || "$AZ" ad sp create --id "$APP_ID" -o none
# fresh client secret (Azure shows it once — we capture straight into the env file, never echo)
say "Minting client secret → $ENVFILE (git-ignored, not printed)"
APP_PASSWORD="$("$AZ" ad app credential reset --id "$APP_ID" --append --query password -o tsv | tr -d '\r')"
umask 077; printf 'export TEAMS_APP_PASSWORD=%s\n' "$APP_PASSWORD" > "$ENVFILE"
# $ENVFILE (.env.<name>) holds a secret; the repo's .gitignore ignores `.env.*`. Warn loudly
# if that isn't in effect here, rather than silently risking a committed credential.
git check-ignore -q "$ENVFILE" 2>/dev/null || echo "WARNING: $ENVFILE is NOT git-ignored — add '.env.*' to .gitignore before committing (it holds the bot secret)."

# --- 2. Azure Bot + Teams channel -------------------------------------------------
say "Azure Bot (F0 free) + Teams channel"
# SingleTenant (MultiTenant bot creation is deprecated by Azure as of 2025). The connector
# mints its outbound token against the tenant-specific authority (login.microsoftonline.com/
# <tenantId>), so single-tenant is the right fit. --tenant-id ties the bot to this tenant.
"$AZ" bot show --resource-group "$RG" --name "$BOT_HANDLE" >/dev/null 2>&1 || \
  "$AZ" bot create --resource-group "$RG" --name "$BOT_HANDLE" --app-type SingleTenant \
        --appid "$APP_ID" --tenant-id "$TENANT_ID" --sku F0 --endpoint "https://example.com/api/messages" -o none
"$AZ" bot msteams create --resource-group "$RG" --name "$BOT_HANDLE" -o none 2>/dev/null || true

# --- 3. Public endpoint so Teams can reach the local gateway ----------------------
# Prefer a caller-supplied URL (a durable tunnel or real DNS ingress managed outside this
# script — the recommended path, since the endpoint must OUTLIVE provisioning and run
# alongside `tonoman up`). Otherwise spin an ephemeral cloudflared quick-tunnel.
TUN_PID=""
if [ -n "$TUNNEL_URL" ]; then
  say "Using provided endpoint: $TUNNEL_URL"
else
  say "Dev tunnel (cloudflared) → localhost:$PORT   [ephemeral — dies with this script]"
  TUNLOG="$(mktemp)"; "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" >"$TUNLOG" 2>&1 &
  TUN_PID=$!
  for i in $(seq 1 30); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNLOG" | head -1 || true)"
    [ -n "$TUNNEL_URL" ] && break; sleep 1
  done
  [ -n "$TUNNEL_URL" ] || { echo "tunnel URL not found; log:"; cat "$TUNLOG"; kill "$TUN_PID" 2>/dev/null || true; exit 1; }
  echo "tunnel: $TUNNEL_URL  (pid $TUN_PID) — will stop when this script exits; pass --tunnel-url next time"
fi
"$AZ" bot update --resource-group "$RG" --name "$BOT_HANDLE" --endpoint "$TUNNEL_URL/api/messages" -o none

# --- 4. Provision the agent -------------------------------------------------------
say "tonoman create agent $NAME --channel teams"
CREATE=("$NODE" "$CLI" create agent "$NAME" --channel teams
        --teams-app-id "$APP_ID" --teams-tenant "$TENANT_ID" --teams-port "$PORT")
[ -n "$ALLOWED_USER" ] && CREATE+=(--teams-allowed-user "$ALLOWED_USER")
[ -n "$PERSONA" ] && CREATE+=(--role "$(head -1 "$PERSONA" | sed 's/^#* *//')")
CREATE+=("${EXTRA[@]}")
# On Windows/Git-Bash, MSYS rewrites container-internal paths (e.g. an --env value like
# `/root/files/aws/credentials`) into `C:/Program Files/Git/root/…` when handing argv to the
# native node.exe. Disable that conversion for this one call so container paths pass through
# literally. Both vars are ignored on Linux, so the script stays cross-platform.
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "${CREATE[@]}"

# Rich persona: drop it into the agent's identity dir (create seeds only a stub, never overwrites).
# The identity dir sits beside the agent's config_volume (recorded in ~/.tonoman/agents.json).
if [ -n "$PERSONA" ] && [ -f "$PERSONA" ]; then
  IDDIR="$("$NODE" -e '
    const fs=require("fs"),os=require("os"),path=require("path");
    try {
      const rows=JSON.parse(fs.readFileSync(path.join(os.homedir(),".tonoman","agents.json"),"utf8"));
      const r=rows.find(x=>x.name&&x.name.toLowerCase()===process.argv[1].toLowerCase());
      if(r&&r.config_volume) process.stdout.write(path.join(path.dirname(r.config_volume),"identity"));
    } catch(_){}
  ' "$NAME" 2>/dev/null || true)"
  if [ -n "$IDDIR" ] && [ -d "$IDDIR" ]; then cp "$PERSONA" "$IDDIR/AGENTS.md"; echo "persona → $IDDIR/AGENTS.md"; fi
fi

# --- 5. Teams app package (manifest + icons + zip) --------------------------------
say "Teams app package → $PKGDIR"
mkdir -p "$PKGDIR"
cat > "$PKGDIR/manifest.json" <<JSON
{
  "\$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "$APP_ID",
  "developer": {
    "name": "$NAME (tonoman)",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "name": { "short": "$NAME", "full": "$NAME" },
  "description": { "short": "$NAME — tonoman agent", "full": "$NAME, a tonoman dev agent in Teams." },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#2A2A2A",
  "bots": [ { "botId": "$APP_ID", "scopes": ["personal", "team"], "supportsFiles": true, "isNotificationOnly": false } ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
JSON

# Icons: fetch the source, resize to Teams' required sizes (color 192², outline 32²).
# Resizer preference: host magick/convert → podman imagemagick → best-effort copy (swap later).
if [ -n "$ICON" ]; then
  SRC="$PKGDIR/_src.png"
  case "$ICON" in http*://*) curl -fsSL "$ICON" -o "$SRC";; *) cp "$ICON" "$SRC";; esac
  # NOTE: on Windows `convert` is System32\convert.exe (the NTFS tool), NOT ImageMagick —
  # so verify the binary really is ImageMagick before trusting it.
  if command -v magick >/dev/null 2>&1; then RS="magick";
  elif command -v convert >/dev/null 2>&1 && convert -version 2>/dev/null | grep -qi imagemagick; then RS="convert"; fi
  if [ -n "${RS:-}" ]; then
    "$RS" "$SRC" -resize 192x192 "$PKGDIR/color.png"
    "$RS" "$SRC" -resize 32x32 -alpha on "$PKGDIR/outline.png"
  else
    echo "note: no imagemagick on host — using source as-is for both icons; swap for exact 192²/32² if Teams warns."
    cp "$SRC" "$PKGDIR/color.png"; cp "$SRC" "$PKGDIR/outline.png"
  fi
  rm -f "$SRC"
else
  echo "note: no --icon given; add color.png (192²) + outline.png (32²) to $PKGDIR before zipping."
fi

# Zip the CONTENTS (not the folder) — the most common packaging mistake.
if command -v zip >/dev/null 2>&1 && [ -f "$PKGDIR/color.png" ]; then
  ( cd "$PKGDIR" && zip -q -r "../$NAME.zip" manifest.json color.png outline.png )
  echo "package: build/teams-app/$NAME.zip"
fi

# --- 6. What's left for a human ---------------------------------------------------
say "Done — final steps"
cat <<EOF
  1. Load the bot secret into the gateway env, then start the control plane:
       source $ENVFILE
       $NODE $CLI up
     Expect: "teams: webhook listening on :$PORT/api/messages" and "teams: bot token OK".
  2. Authenticate the agent's brain (one time). Two ways — pick by where you are:
       LOCAL (browser on this machine):   $NODE $CLI auth login $NAME
       HEADLESS/REMOTE/PHONE (recommended for a server): prints a URL to open on any device:
         $NODE $CLI auth login $NAME --headless
         $NODE $CLI auth code  $NAME <CODE>     # paste the code from that URL back
  3. Sideload the Teams app (the one click only you can do):
       Teams → Apps → Manage your apps → Upload a custom app → build/teams-app/$NAME.zip
  4. Message it in Teams.

  Notes:
   - The tunnel (pid $TUN_PID) must stay up; its URL changes on restart — re-run
     'az bot update … --endpoint <newurl>/api/messages' if you restart it.
   - app_id=$APP_ID  tenant=$TENANT_ID  secret→$ENVFILE (git-ignored)
EOF
