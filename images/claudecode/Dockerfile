# Tonoman agent runtime image — the DEFAULT, minimal, non-privileged sandbox for a
# turn-driven agent (docs/architecture.md § A11). It is the base image plus BOTH provider
# CLIs — Claude Code and Codex — and nothing more: a business-card agent and a dev agent
# run the SAME image and differ only in their per-agent identity + skills, which arrive as
# run-time bind-mounts (config volume → /root/.claude and /root/.codex, identity →
# /root/agent) — never baked in.
#
# BOTH CLIs, one image, because the provider is a CONFIG choice (`inferenceProvider` on the
# roster) and not a different kind of agent. One worker pod serves a whole tenant, and two of
# its agents can answer on two different subscriptions — so a per-provider image would mean a
# pod could serve only one of them, and switching an agent over would be a redeploy rather
# than a setting. The two credential stores are separate directories and never
# cross-contaminate; see claudecode.configHomeFor / codex.configHomeFor.
#
# Brain auth is NOT baked in (§ A2): it is provided at run time via the per-agent config
# volume's credential store (`tonoman auth login` / `tonoman create agent --from`) —
# `.credentials.json` under CLAUDE_CONFIG_DIR for Claude, `auth.json` under CODEX_HOME for
# Codex. ANTHROPIC_API_KEY and OPENAI_API_KEY are intentionally never set: an API key must
# never outrank the subscription the agent is meant to answer (and bill) on. Container ops
# are brokered to the host (§ A13 Profile 1) — this image needs no nested/privileged podman.
#
# Build (local, AFTER the base):
#   podman build -t localhost/tonoman/base:latest       -f images/base/Dockerfile .
#   podman build -t localhost/tonoman/claudecode:latest -f images/claudecode/Dockerfile .
FROM localhost/tonoman/base:latest

# One layer, both verified: an image that builds is an image where BOTH providers work.
# Installing them separately would let a broken Codex ship inside an image whose Claude half
# passed its version check — and the failure would first appear as a login that cannot start.
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && claude --version \
 && codex --version

CMD ["sleep", "infinity"]
