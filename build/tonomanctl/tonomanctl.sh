#!/usr/bin/env bash
# tonomanctl — run a Tonoman agent on your own computer, managed from Tonoman Cloud.
#
# One pod, two containers, the same image the Cloud runs: the worker (answers, on your logins) and the
# auth sidecar (holds the logins). Everything about the agent is managed in the Hub; this only brings
# the runtime up, keeps it up, and takes it down.
#
#   tonomanctl enrol <token> [--api URL] [--temporal ADDR] [--release TAG] [--no-up]
#   tonomanctl up | down | status | logs | update [TAG] | uninstall
#
# Checks first, changes nothing on a machine that cannot run the agent (POOL-INSTALLER-CHECKS-FIRST).
# Never updates on its own (POOL-SURVIVES-REBOOT). The pool's credential lives in ~/.tonoman/pool.env,
# readable by you alone.
set -euo pipefail

TONOMAN_HOME="${TONOMAN_HOME:-$HOME/.tonoman}"
POOL_ENV="$TONOMAN_HOME/pool.env"
POD="tonoman"
IMAGE_REPO="${TONOMAN_IMAGE_REPO:-ghcr.io/rodnavarro/tonoman}"
PODMAN="${PODMAN:-podman}"

say() { printf '%s\n' "$*"; }
die() { printf 'tonomanctl: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$2"
}

# --- checks -------------------------------------------------------------------------------------------
check() {
  need "$PODMAN" "podman is not installed. Get it from https://podman.io/docs/installation, then run this again."
  need curl "curl is not installed."
  if ! "$PODMAN" info >/dev/null 2>&1; then
    die "podman is installed but not running. On macOS or Windows: 'podman machine init' then 'podman machine start', then run this again."
  fi
}

# --- enrol --------------------------------------------------------------------------------------------
enrol() {
  local token="${1:-}"; shift || true
  [ -n "$token" ] || die "usage: tonomanctl enrol <token> [--api URL] [--temporal ADDR] [--release TAG] [--no-up]"
  local api="${TONOMAN_API_URL:-https://api.tonoman.com}" temporal="" release="${TONOMAN_RELEASE:-latest}" up=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --api) api="$2"; shift 2 ;;
      --temporal) temporal="$2"; shift 2 ;;
      --release) release="$2"; shift 2 ;;
      --no-up) up=0; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  check
  [ -f "$POOL_ENV" ] && die "this computer is already enrolled ($POOL_ENV). 'tonomanctl uninstall' first to enrol again."

  say "Enrolling with $api …"
  local body http
  body="$(curl -fsS -w '\n%{http_code}' -X POST "$api/v1/pool/enrol" -H 'content-type: application/json' \
    -d "{\"token\":\"$token\",\"version\":\"$release\"}" 2>/dev/null || true)"
  http="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  case "$http" in
    201) ;;
    404) die "that enrolment is not open: it was used, it expired, or it never existed. Mint a new command in the Hub." ;;
    *) die "the platform did not answer (http ${http:-none}). Is $api reachable from this computer?" ;;
  esac

  local credential queue namespace tempo
  credential="$(printf '%s' "$body" | json_get credential)"
  queue="$(printf '%s' "$body" | json_get pool.taskQueue)"
  namespace="$(printf '%s' "$body" | json_get pool.temporalNamespace)"
  tempo="$(printf '%s' "$body" | json_get temporal.address)"
  [ -n "$credential" ] || die "the platform answered without a credential; nothing was saved."
  [ -n "$temporal" ] || temporal="$tempo"
  [ -n "$temporal" ] || die "no Temporal address: pass --temporal HOST:PORT."

  mkdir -p "$TONOMAN_HOME"
  ( umask 077
    cat > "$POOL_ENV" <<EOF
# Written by tonomanctl enrol. This is your computer's credential to Tonoman Cloud: keep it to yourself.
TONOMANCLOUD_API_URL=$api
TONOMANCLOUD_API_TOKEN=$credential
TEMPORAL_ADDRESS=$temporal
TEMPORAL_NAMESPACE=$namespace
TEMPORAL_TASK_QUEUE=$queue
AGENT_RUNTIME_TOKEN=$(random_token)
TONOMAN_WAKE_TOKEN=$(random_token)
TONOMAN_RELEASE=$release
EOF
  )
  say "Enrolled. Credential saved to $POOL_ENV (only you can read it)."
  if [ "$up" = 1 ]; then up; fi
}

# --- up / down ------------------------------------------------------------------------------------------
up() {
  check
  [ -f "$POOL_ENV" ] || die "not enrolled: run the command from the Hub first."
  # shellcheck disable=SC1090
  . "$POOL_ENV"
  local image="$IMAGE_REPO:${TONOMAN_RELEASE:-latest}"
  say "Pulling $image …"
  "$PODMAN" pull -q "$image" >/dev/null
  if "$PODMAN" pod exists "$POD" 2>/dev/null; then
    say "Stopping the previous pod …"
    "$PODMAN" pod rm -f "$POD" >/dev/null
  fi
  for v in tonoman-claude tonoman-codex tonoman-homes tonoman-state; do "$PODMAN" volume exists "$v" 2>/dev/null || "$PODMAN" volume create "$v" >/dev/null; done
  "$PODMAN" pod create --name "$POD" >/dev/null
  # The auth sidecar: holds the logins, answers the worker over the pod's loopback.
  "$PODMAN" run -d --pod "$POD" --name tonoman-auth --init --restart=always \
    -e AGENT_RUNTIME_TOKEN="$AGENT_RUNTIME_TOKEN" -e CLAUDE_CONFIG_ROOT=/root/.claude -e CODEX_HOME=/root/.codex -e TONOMAN_TURN_USERS=on \
    -v tonoman-claude:/root/.claude -v tonoman-codex:/root/.codex -v tonoman-homes:/srv/tonoman/homes \
    "$image" node /opt/tonoman/dist/cli.js runtime >/dev/null
  # The worker: on the pool's credential, its own queue and namespace; no inference capability here.
  "$PODMAN" run -d --pod "$POD" --name tonoman-worker --init --restart=always \
    --env-file "$POOL_ENV" \
    -e AGENT_RUNTIME_URL=http://127.0.0.1:8080 -e TONOMAN_STATE_ROOT=/root/.tonoman -e TONOMAN_TURN_USERS=on \
    -e CLAUDE_CONFIG_ROOT=/root/.claude -e CODEX_HOME=/root/.codex -e TONOMAN_WAKE_PORT=3980 \
    -e TONOMAN_VERSION="${TONOMAN_RELEASE:-latest}" \
    -v tonoman-claude:/root/.claude -v tonoman-codex:/root/.codex -v tonoman-homes:/srv/tonoman/homes -v tonoman-state:/root/.tonoman \
    "$image" node /opt/tonoman/dist/cli.js worker >/dev/null
  say "Up. Your agent will show as online in the Hub within a minute. 'tonomanctl logs' follows it."
}

down() {
  check
  if "$PODMAN" pod exists "$POD" 2>/dev/null; then "$PODMAN" pod rm -f "$POD" >/dev/null; say "Down."; else say "Not running."; fi
}

status() {
  check
  if ! "$PODMAN" pod exists "$POD" 2>/dev/null; then say "Not running. 'tonomanctl up' starts it."; return; fi
  "$PODMAN" ps --pod --filter "pod=$POD" --format '{{.Names}}\t{{.Status}}'
  "$PODMAN" logs --tail 5 tonoman-worker 2>&1 | grep -E 'worker: (tonoman|serving|heartbeat|this release)' || true
}

logs() { check; "$PODMAN" logs -f --tail 100 tonoman-worker; }

update() {
  [ -f "$POOL_ENV" ] || die "not enrolled."
  local release="${1:-}"
  [ -n "$release" ] || die "usage: tonomanctl update <release> — the Hub names the release to move to; nothing updates on its own."
  sed -i.bak "s/^TONOMAN_RELEASE=.*/TONOMAN_RELEASE=$release/" "$POOL_ENV" && rm -f "$POOL_ENV.bak"
  up
}

uninstall() {
  check
  down
  for v in tonoman-claude tonoman-codex tonoman-homes tonoman-state; do "$PODMAN" volume rm -f "$v" >/dev/null 2>&1 || true; done
  rm -f "$POOL_ENV"
  say "Uninstalled: the logins and this computer's credential are gone from this machine. Revoke it in the Hub too, so the platform knows."
}

# --- helpers --------------------------------------------------------------------------------------------
json_get() {
  # $1 = the key to read; JSON on stdin. The platform answers flat string values under unique keys,
  # so a narrow sed is enough and nothing else (python, node) is assumed to be on the machine.
  local key="${1##*.}"
  sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p" | head -n1
}
random_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24; else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  enrol|enroll) enrol "$@" ;;
  up) up ;;
  down) down ;;
  status) status ;;
  logs) logs ;;
  update) update "$@" ;;
  uninstall) uninstall ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
