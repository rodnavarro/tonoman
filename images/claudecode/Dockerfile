# Tonoman claude-code runtime image — the DEFAULT, minimal, non-privileged sandbox for
# the `claude-code` harness (docs/architecture.md § A11). It is the base image + the
# Claude Code CLI, nothing more: a business-card agent and a dev agent run the SAME
# image and differ only in their per-agent identity + skills, which arrive as run-time
# bind-mounts (config volume → /root/.claude, identity → /root/agent) — never baked in.
#
# Brain auth is NOT baked in (§ A2): it is provided at run time via the per-agent config
# volume's credential store (`tonoman auth login` / `tonoman create agent --from`).
# ANTHROPIC_API_KEY is intentionally never set. Container ops are brokered to the host
# (§ A13 Profile 1) — this image needs no nested/privileged podman.
#
# Build (local, AFTER the base):
#   podman build -t localhost/tonoman/base:latest       -f images/base/Dockerfile .
#   podman build -t localhost/tonoman/claudecode:latest -f images/claudecode/Dockerfile .
FROM localhost/tonoman/base:latest

RUN npm install -g @anthropic-ai/claude-code \
 && claude --version

CMD ["sleep", "infinity"]
