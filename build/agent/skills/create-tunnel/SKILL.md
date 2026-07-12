---
name: create-tunnel
description: Expose a locally running app/server to a temporary public URL so the operator can open it from their phone (works off-network). Use when asked to "make it accessible/public/shareable", "give me a link", or to preview a running dev server. Pass the port the app listens on.
allowed-tools: Bash
argument-hint: "<port the app is serving on, e.g. 3000>"
---

# Create a public tunnel (via the Tonoman substrate)

The **Tonoman substrate owns public exposure.** Ask it for a URL through the
control channel — do NOT run cloudflared yourself.

```bash
PORT="${1:-3000}"
DIR="${TONOMAN_CONTROL_DIR:-$HOME/.tonoman/control}"
mkdir -p "$DIR/requests" "$DIR/responses"
rm -f "$DIR/responses/$PORT.url"
: > "$DIR/requests/$PORT.req"          # ask the substrate to expose this port
for i in $(seq 1 90); do               # wait for the substrate to answer
  if [ -f "$DIR/responses/$PORT.url" ]; then cat "$DIR/responses/$PORT.url"; exit 0; fi
  sleep 1
done
echo "tunnel request timed out"; exit 1
```

The substrate writes back either a URL (`https://<name>.trycloudflare.com`) or a
line starting with `ERROR:`. Reply to the operator with the URL — it works from
anywhere, no auth. Each port is its own tunnel (expose a frontend and an API
separately if needed).

Requirements:
- The app must already be **running and listening on that port**, bound to
  `0.0.0.0` (e.g. `next dev -H 0.0.0.0 -p 3000`).
- If the result starts with `ERROR:` or times out, tell the operator public
  exposure isn't available right now.
