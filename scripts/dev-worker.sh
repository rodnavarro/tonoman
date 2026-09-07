#!/usr/bin/env bash
# Run the tenant worker ON THIS MACHINE, joined to the real Temporal cluster.
#
# WHY: edit → build → push → Argo → rollout is five to ten minutes, and nearly all of it is spent
# moving an image around to test a change to one file. Run the worker here and that loop becomes a
# restart.
#
# It works because of a property that is easy to miss: **Slack Socket Mode dials OUT**. The worker
# opens a WebSocket to Slack rather than receiving webhooks, so a process on a laptop behind NAT
# gets real Slack events with no ingress, no tunnel and no second Slack app. Everything else is a
# port-forward.
#
#   ┌─ this machine ─────────────┐        ┌─ linode-26 ──────────────────┐
#   │  worker (the code you are  │──7233─▶│  prod-temporal / temporal    │
#   │  actually changing)        │──8080─▶│  tonomancloud-api            │
#   │            │               │        │  murphy worker → scaled to 0 │
#   └────────────┼───────────────┘        └──────────────────────────────┘
#                └── dials out ──▶ Slack
#
# It polls `tonoman-cloud-turns`, the SAME task queue as the cluster worker, so it is a peer rather
# than a separate system — the schedules, the workflows and the activities are all the real ones.
#
# THE ONE RULE: two workers must never serve the same agent. Slack delivers a Socket Mode event to
# exactly ONE of the connections holding an app token, so two processes sharing an agent answer
# alternately and unpredictably — a flaky bug rather than an obvious conflict. Hence the scale-down
# below; `TONOMAN_AGENTS` is the alternative if you would rather split them than take both.
#
#   ./scripts/dev-worker.sh                      # take every agent (cluster worker stops)
#   TONOMAN_AGENTS=axiplex-sapien ./scripts/dev-worker.sh --keep-cluster
#     …and set TONOMAN_AGENTS=murphy-nelly on the cluster worker, so neither steals the other's.
#
# IF THIS MACHINE DIES, THE AGENTS STOP. The trap restores the cluster worker on a normal exit or a
# Ctrl-C, but not on a power cut, so the restore command is printed at the top where it can be found
# without reading this file.
set -euo pipefail

NS=prod-tonoman-cloud
DEPLOY=murphy-business-sales-temporal-worker
KUBECONFIG="${KUBECONFIG:-$HOME/.kube/clusters/linode-rn26}"
export KUBECONFIG

API_PORT=18080
TEMPORAL_PORT=17233
KEEP_CLUSTER=0
[ "${1:-}" = "--keep-cluster" ] && KEEP_CLUSTER=1

RESTORE="kubectl -n $NS scale deploy/$DEPLOY --replicas=1"
PF_PIDS=()
SCALED=0

cleanup() {
  echo
  for pid in "${PF_PIDS[@]:-}"; do
    [ -n "$pid" ] && { taskkill //F //T //PID "$pid" >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true; }
  done
  if [ "$SCALED" = 1 ]; then
    echo "dev-worker: handing the agents back to the cluster"
    kubectl -n "$NS" scale deploy/"$DEPLOY" --replicas=1 >/dev/null 2>&1 \
      || echo "dev-worker: COULD NOT RESTORE — run: $RESTORE"
  fi
}
trap cleanup EXIT INT TERM

if [ "$KEEP_CLUSTER" = 0 ]; then
  echo "┌──────────────────────────────────────────────────────────────────────────┐"
  echo "│  The cluster worker is being STOPPED. If this machine goes away before    │"
  echo "│  this script exits cleanly, the agents stay down until you run:           │"
  echo "│    $RESTORE"
  echo "└──────────────────────────────────────────────────────────────────────────┘"
  kubectl -n "$NS" scale deploy/"$DEPLOY" --replicas=0 >/dev/null
  SCALED=1
  # Wait for it to actually let go of Slack. Starting locally while the old pod still holds the
  # socket is the split-brain this whole rule exists to avoid, and it lasts only seconds — which is
  # exactly long enough to produce one confusing missing reply.
  for i in $(seq 1 60); do
    n=$(kubectl -n "$NS" get pods -l app="$DEPLOY" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    [ "$n" = 0 ] && break
    sleep 1
  done
  echo "dev-worker: cluster worker stopped"
fi

echo "dev-worker: port-forwarding registry :$API_PORT and Temporal :$TEMPORAL_PORT"
kubectl -n "$NS" port-forward svc/tonomancloud-api "$API_PORT":8080 >/tmp/pf-api.log 2>&1 &
PF_PIDS+=($!)
kubectl -n prod-temporal port-forward svc/temporal "$TEMPORAL_PORT":7233 >/tmp/pf-temporal.log 2>&1 &
PF_PIDS+=($!)

# Waited for, not slept on: a port-forward mid-handshake refuses connections in a way that looks
# exactly like a misconfiguration.
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1 && break
  [ "$i" = 40 ] && { echo "dev-worker: registry never answered — see /tmp/pf-api.log"; exit 1; }
  sleep 0.5
done

# Read FROM THE CLUSTER rather than kept on disk here: one less copy of a credential, and always
# the one actually in force.
SEC=tonomancloud-api-secrets
TOKEN=$(kubectl -n "$NS" get secret "$SEC" -o jsonpath='{.data.SYSTEM_TOKEN}' | base64 -d)
WSEC=$(kubectl -n "$NS" get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="GROQ_API_KEY")].valueFrom.secretKeyRef.name}' 2>/dev/null || true)
if [ -n "${WSEC:-}" ]; then
  GROQ=$(kubectl -n "$NS" get secret "$WSEC" -o jsonpath='{.data.GROQ_API_KEY}' 2>/dev/null | base64 -d || true)
fi

export TONOMANCLOUD_API_URL="http://127.0.0.1:$API_PORT"
export TONOMANCLOUD_API_TOKEN="$TOKEN"
export TEMPORAL_ADDRESS="127.0.0.1:$TEMPORAL_PORT"
export TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE:-default}"
export TEMPORAL_TASK_QUEUE="${TEMPORAL_TASK_QUEUE:-tonoman-cloud-turns}"
export GROQ_API_KEY="${GROQ_API_KEY:-${GROQ:-}}"
# Its own state root, so a local run neither touches nor inherits the pod's checkouts. The
# second-brain repos are cloned fresh here on first use.
export TONOMAN_STATE_ROOT="${TONOMAN_STATE_ROOT:-$HOME/.tonoman-dev}"

echo "dev-worker: queue $TEMPORAL_TASK_QUEUE  state $TONOMAN_STATE_ROOT"
echo "dev-worker: agents ${TONOMAN_AGENTS:-<all>}"
echo "dev-worker: Slack arrives over Socket Mode — outbound, so no tunnel is needed"
echo

# tsx, not a build: the whole point is that a change is a restart rather than an image.
exec npx tsx src/cli.ts runtime
