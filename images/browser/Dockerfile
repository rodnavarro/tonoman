# Tonoman browser sidecar image — a per-agent headful Chrome the agent drives over CDP
# (docs/architecture.md § A14, docs/scenarios/browser.md). One sidecar per browsing agent,
# on the agent's own network; NOT baked into the claudecode agent image.
#
# Adapted from openclaw's Dockerfile.sandbox-browser (CDP-first reference). Ships:
#   - Chromium (headful under Xvfb) with CDP on :9222
#   - x11vnc + websockify + noVNC on :6080 so `tonoman open browser` streams the live
#     session to the host (no VNC client needed)
#
# Build (context = this dir):
#   podman build -t localhost/tonoman/chrome:latest images/browser/
FROM docker.io/library/debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    chromium \
    curl \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    novnc \
    python3 \
    socat \
    websockify \
    x11vnc \
    xvfb \
 && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 entrypoint.sh /usr/local/bin/tonoman-chrome

RUN useradd --create-home --shell /bin/bash chrome
USER chrome
WORKDIR /home/chrome

# CDP (agent connects by IP over the per-agent network) + noVNC (host viewer) + raw VNC.
EXPOSE 9222 6080 5900

CMD ["tonoman-chrome"]
