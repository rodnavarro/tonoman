# Tonoman per-runtime image for the Hermes SERVICE backend (backend-hermes).
#
# Built FROM the Hermes agent image, which already carries the hermes runtime (its venv +
# the bootstrap entrypoint that sets up /opt/data and runs `hermes <cmd>`) AND the node/npm/
# git toolchain the boot-time `setup` list uses to install the agent's CLIs (cfg-agent-tools).
#
# Service mode: Tonoman boots `gateway` (set via the harness spec's serviceCommand) and the
# image's own ENTRYPOINT wraps it. The CLIs (e.g. a domain CLI / billing) are NOT baked here —
# they are installed at boot from the roster `setup` list, so the image stays content-agnostic.
#
# Build:  podman build -t localhost/tonoman/hermes:latest -f images/hermes/Dockerfile .
FROM localhost/hermes-agent:dev

LABEL org.tonoman.harness="hermes" \
      org.tonoman.mode="service"

# Bake the runtime SDKs the base image lacks into the hermes venv (Hermes uses `uv`, not pip).
# These are otherwise lazy-installed on first use, which survives only in a long-lived container's
# layer — a fresh recreate (or k8s pod) loses them. Baking makes the image reproducible:
#  - microsoft-teams-apps: the Teams PLUGIN ships, but not the SDK it imports (else the gateway
#    can't enable the Teams platform).
#  - anthropic: Hermes routes Claude-on-Bedrock through anthropic's AnthropicBedrock client (SigV4
#    over IAM access keys). Pinned to the version proven against the billing agent's Bedrock IAM.
#  - boto3/botocore: AnthropicBedrock's SigV4 signing + the boto3 Converse path import them (else
#    model calls fail with ModuleNotFoundError: No module named 'botocore').
RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache \
      microsoft-teams-apps "anthropic==0.86.0" boto3

# Toolchain (node/npm/git) + the hermes entrypoint/venv are inherited from the base image.
# ENTRYPOINT/CMD are intentionally left unchanged: ENTRYPOINT bootstraps /opt/data then
# `exec hermes "$@"`, so Tonoman's serviceCommand (`gateway`) lands as the hermes subcommand.
