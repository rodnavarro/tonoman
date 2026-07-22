# Tonoman base sandbox image — the shared, NON-PRIVILEGED foundation every Tonoman
# agent runtime builds on (per-runtime images under images/<runtime>/ do `FROM` this).
#
# It carries only what is COMMON across runtimes: git, an SSH client (so any agent can
# use git over SSH — cfg-ssh-key), CA certs, and the Tonoman
# in-sandbox SHIMS (`podman`, `tonoman`) that forward container/platform ops to the
# HOST broker over the file control channel (docs/architecture.md § A13 Profile 1).
# Because container ops are brokered, an agent runs containers WITHOUT its own
# nested/privileged podman — the sandbox stays the security boundary (§ A2). The
# privileged podman-in-podman base (build/agent/Containerfile.dev) is the opt-in
# A13 Profile-2 fallback, never the default.
#
# Build (local; context = repo root so build/agent/shim is reachable):
#   podman build -t localhost/tonoman/base:latest -f images/base/Dockerfile .
FROM docker.io/library/node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Container-root git must trust bind-mounted workspaces (avoids "dubious ownership"
# blocking a skill's commits).
RUN git config --system --add safe.directory '*'

# Tonoman in-sandbox shims (A13): `podman` forwards container commands to the host
# broker over the file control channel; `tonoman` forwards the platform verbs
# (url/expose/unexpose). Baked in so they survive a container rebuild. They are
# self-contained Node scripts (only Node built-ins), so node:22-slim runs them as-is.
COPY build/agent/shim/podman build/agent/shim/tonoman /usr/local/bin/
# Normalize line endings before making them executable. A Windows (CRLF) checkout otherwise
# bakes the shebang as `#!/usr/bin/env node\r`, so `env` looks for `node\r`, the shim fails to
# exec, and the agent→host broker round-trip reports UNREACHABLE. Strip CR to be checkout-safe.
RUN sed -i 's/\r$//' /usr/local/bin/podman /usr/local/bin/tonoman \
 && chmod +x /usr/local/bin/podman /usr/local/bin/tonoman

# Long-lived container; the gateway drives turns via `podman exec` (A2).
WORKDIR /work
CMD ["sleep", "infinity"]
