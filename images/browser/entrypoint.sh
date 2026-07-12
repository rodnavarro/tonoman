#!/usr/bin/env bash
# Tonoman browser sidecar entrypoint (A14). Adapted from openclaw's sandbox-browser
# entrypoint. Brings up: Xvfb → headful Chromium (CDP on a loopback port) → a socat relay
# publishing CDP on :9222 for the agent (reached by IP over the per-agent network) →
# x11vnc + websockify + noVNC on :6080 for the host viewer (`tonoman open browser`).
set -Eeuo pipefail

export DBUS_SESSION_BUS_ADDRESS=/dev/null
export DISPLAY=:1
export HOME=/home/chrome
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${TONOMAN_CHROME_CDP_PORT:-9222}"          # external CDP port (agent connects here by IP)
CDP_SOURCE_RANGE="${TONOMAN_CHROME_CDP_SOURCE_RANGE:-}" # optional CIDR; private per-agent net is the isolation
VNC_PORT="${TONOMAN_CHROME_VNC_PORT:-5900}"
NOVNC_PORT="${TONOMAN_CHROME_NOVNC_PORT:-6080}"
ENABLE_NOVNC="${TONOMAN_CHROME_ENABLE_NOVNC:-1}"
HEADLESS="${TONOMAN_CHROME_HEADLESS:-0}"
NO_SANDBOX="${TONOMAN_CHROME_NO_SANDBOX:-1}"          # default ON: the container IS the boundary (A2)
NOVNC_PASSWORD="${TONOMAN_CHROME_NOVNC_PASSWORD:-}"
RENDERER_PROCESS_LIMIT="${TONOMAN_CHROME_RENDERER_PROCESS_LIMIT:-2}"
AUTO_START_TIMEOUT_MS="${TONOMAN_CHROME_AUTO_START_TIMEOUT_MS:-15000}"

cleanup() {
  local code="${1:-1}"
  trap - EXIT INT TERM
  local pids=() pid
  for pid in "${WEBSOCKIFY_PID:-}" "${X11VNC_PID:-}" "${SOCAT_PID:-}" "${CHROME_PID:-}" "${XVFB_PID:-}"; do
    [[ -n "${pid:-}" ]] && pids+=("$pid")
  done
  if ((${#pids[@]} > 0)); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    for _ in {1..10}; do
      local alive=0
      for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && { alive=1; break; }; done
      [[ "$alive" == "0" ]] && break
      sleep 0.2
    done
    kill -KILL "${pids[@]}" 2>/dev/null || true
    wait 2>/dev/null || true
  fi
  exit "$code"
}
trap 'cleanup "$?"' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

mkdir -p "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

# Persistent profile: clear Chrome's singleton locks left by a previous unclean shutdown,
# or Chromium refuses to start on the reused --user-data-dir (breaks profile reuse).
rm -f "${HOME}/.chrome/Singleton"* 2>/dev/null || true
# Mark the last session as clean so we don't get a "restore pages?" bubble stealing focus.
if [[ -f "${HOME}/.chrome/Default/Preferences" ]]; then
  sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "${HOME}/.chrome/Default/Preferences" 2>/dev/null || true
fi

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &
XVFB_PID=$!
echo "[tonoman-chrome] Xvfb started (PID ${XVFB_PID})"

# Chrome's CDP rejects hostname Host headers (DNS-rebinding guard) and we keep it on
# loopback; socat republishes it on the network port so the agent reaches it by IP.
if [[ "${CDP_PORT}" -ge 65535 ]]; then CHROME_CDP_PORT="$((CDP_PORT - 1))"; else CHROME_CDP_PORT="$((CDP_PORT + 1))"; fi

CHROME_ARGS=(
  "--remote-debugging-address=127.0.0.1"
  "--remote-debugging-port=${CHROME_CDP_PORT}"
  "--user-data-dir=${HOME}/.chrome"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-background-networking"
  "--disable-breakpad"
  "--disable-crash-reporter"
  "--no-zygote"
  "--metrics-recording-only"
  "--password-store=basic"
  "--use-mock-keychain"
  "--disable-gpu"
  "--disable-software-rasterizer"
)
[[ "${HEADLESS}" == "1" ]] && CHROME_ARGS+=("--headless=new")
[[ "${NO_SANDBOX}" == "1" ]] && CHROME_ARGS+=("--no-sandbox" "--disable-setuid-sandbox")
[[ "${RENDERER_PROCESS_LIMIT}" =~ ^[0-9]+$ && "${RENDERER_PROCESS_LIMIT}" -gt 0 ]] && CHROME_ARGS+=("--renderer-process-limit=${RENDERER_PROCESS_LIMIT}")

echo "[tonoman-chrome] starting Chromium (CDP loopback :${CHROME_CDP_PORT})..."
chromium "${CHROME_ARGS[@]}" about:blank &
CHROME_PID=$!

start_ms=$(date +%s%3N); deadline_ms=$(( start_ms + AUTO_START_TIMEOUT_MS )); CDP_READY=0
probe_url="http://127.0.0.1:${CHROME_CDP_PORT}/json/version"
echo "[tonoman-chrome] waiting up to ${AUTO_START_TIMEOUT_MS}ms for CDP..."
while (( $(date +%s%3N) < deadline_ms )); do
  kill -0 "${CHROME_PID}" 2>/dev/null || { echo "[tonoman-chrome] ERROR: Chromium exited before CDP ready"; exit 1; }
  curl -fsS --max-time 0.5 "${probe_url}" >/dev/null && { CDP_READY=1; break; }
  sleep 0.2
done
[[ "${CDP_READY}" == "1" ]] || { echo "[tonoman-chrome] ERROR: CDP not ready within ${AUTO_START_TIMEOUT_MS}ms"; exit 1; }
echo "[tonoman-chrome] CDP ready on loopback :${CHROME_CDP_PORT}"

# Publish CDP on the network port. The per-agent private network is the isolation boundary;
# an optional source CIDR narrows it further.
SOCAT_LISTEN="TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=0.0.0.0"
[[ -n "${CDP_SOURCE_RANGE}" ]] && SOCAT_LISTEN="${SOCAT_LISTEN},range=${CDP_SOURCE_RANGE}"
socat "${SOCAT_LISTEN}" "TCP:127.0.0.1:${CHROME_CDP_PORT}" &
SOCAT_PID=$!
echo "[tonoman-chrome] CDP published on :${CDP_PORT} (PID ${SOCAT_PID})"

if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
  if [[ -z "${NOVNC_PASSWORD}" ]]; then
    NOVNC_PASSWORD="$(< /proc/sys/kernel/random/uuid)"; NOVNC_PASSWORD="${NOVNC_PASSWORD//-/}"; NOVNC_PASSWORD="${NOVNC_PASSWORD:0:8}"
  fi
  mkdir -p "${HOME}/.vnc"
  x11vnc -storepasswd "${NOVNC_PASSWORD}" "${HOME}/.vnc/passwd" >/dev/null
  chmod 600 "${HOME}/.vnc/passwd"
  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -rfbauth "${HOME}/.vnc/passwd" -localhost &
  X11VNC_PID=$!
  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
  WEBSOCKIFY_PID=$!
  echo "[tonoman-chrome] noVNC on :${NOVNC_PORT} (vnc password: ${NOVNC_PASSWORD})"
fi

echo "[tonoman-chrome] up. monitoring sub-processes..."
wait -n
