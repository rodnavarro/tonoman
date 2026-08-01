# @tonoman/app — the Tonoman client

Sign in, see your fleet, chat with an agent, scan a document into it.

This is the **user-facing** client and it is deliberately **open source**, because it is the
on-ramp: anyone can run `tonoman up` and point the same app at their own gateway. Tenant
administration — whether a tenant managing itself or an operator managing tenants — is a
different application and is not here.

> **Not part of the engine's zero-dependency rule.** Tonoman itself (`src/`) ships as plain
> JavaScript with no runtime dependencies. This is a separate package with its own build and
> its own dependencies; nothing here is loaded by the gateway.

## Running it

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # → dist/
```

The app is served by whoever hosts it and asks that origin for `/api/config` to learn which
identity provider to use — so the same bundle works against Tonoman Cloud or a self-hosted
gateway with no rebuild.

## The two hops

The app talks to two different things, and the split is the point:

| Hop | To | For |
|---|---|---|
| 1 | The cloud (or whoever serves the app) | Who am I; what is my fleet; mint me a token for gateway *X* |
| 2 | **The gateway, directly** | Chat, and media upload |

Chat and documents never pass through the cloud. That keeps the control plane cheap and
means a scanned client document does not transit someone else's infrastructure.

## The scanner

Live viewfinder with an edge-detection overlay (OpenCV.js + jscanify, lazy-loaded on first
open so ~9MB of WASM is not on the critical path), per-page confirm, a filmstrip you can
delete from, and `pdf-lib` joining the pages client-side.

Two implementation notes that are easy to get wrong:

- **Detection runs on a 384px downscale at 10fps; the perspective warp runs on the
  full-resolution frame.** Edge detection is no better at 4K, and running it there at 60fps
  would flatten the phone's battery.
- **Degenerate quads are rejected** — over 98% of the frame usually means it locked onto the
  frame border, under 12% is noise. A wrong outline is worse than no outline, because the
  user trusts it.

### Open it in Safari, not from the Home Screen

`index.html` deliberately omits `apple-mobile-web-app-capable`. In iOS standalone-PWA mode
`getUserMedia` is unreliable — the camera permission is not persisted, Safari re-prompts
intermittently, and standalone can behave as though there is no camera at all. iOS 26 made
Home Screen sites default *into* that mode. The live viewfinder is the whole point, so the
app is meant to run as a normal Safari tab.

The native path (Capacitor + VisionKit on iOS, ML Kit on Android) removes this constraint
and gives a better scanner; `scan.ts` is structured so capture can be swapped for it without
touching the rest of the app.

## Sending a scan needs no agent change

The PDF is uploaded to the gateway's `POST /api/media` and sent as an ordinary turn with
`mediaPaths`. It lands on the same shared mount a Telegram photo would, so to the agent a
scan is indistinguishable from any other attachment.
