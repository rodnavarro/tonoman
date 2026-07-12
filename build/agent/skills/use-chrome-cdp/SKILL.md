---
name: use-chrome-cdp
description: Drive the shared Chrome (the chrome-sidecar container) over the DevTools Protocol (CDP). Use to open a URL, read a page's title/visible text, click, type, screenshot, or extract data from a live browser session. The browser keeps a persistent, possibly logged-in profile, so use it for sites that need a real session rather than fetching raw HTML.
---

# What this is
A shared headful Chrome runs in the **`chrome-sidecar`** container with a persistent
profile and CDP exposed on **port 9222**. I connect to that browser over CDP — I do
**not** launch my own — so cookies/logins persist across turns and across my restarts.

# Connect
- The sidecar is on the `agents-net` network, but Chrome's CDP **rejects a hostname
  in the Host header** — I must connect by **IP**, not by `chrome-sidecar`. Resolve it:
  ```sh
  CDP_IP=$(getent hosts chrome-sidecar | head -1 | awk '{print $1}')
  curl -s "http://$CDP_IP:9222/json/version"   # sanity check
  ```
- Drive it with Playwright over CDP. If `playwright-core` isn't present, install it
  once (no browser download needed — we attach to the existing Chrome):
  `npm i -g playwright-core`.

# Example — open a page, get its title + visible text
```sh
export CDP_IP=$(getent hosts chrome-sidecar | head -1 | awk '{print $1}')
cat > /tmp/cdp.mjs <<'JS'
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP(`http://${process.env.CDP_IP}:9222`);
const ctx = b.contexts()[0] ?? await b.newContext();
const page = await ctx.newPage();
await page.goto(process.argv[2] ?? 'https://example.com', { waitUntil: 'domcontentloaded' });
console.log('TITLE:', await page.title());
console.log((await page.innerText('body')).slice(0, 1500));
await page.close();
await b.close();
JS
node /tmp/cdp.mjs "<url>"
```
For screenshots: `await page.screenshot({ path: '/root/.tonoman/shot.png', fullPage: true })`.

# Guardrails
- The profile is shared and may be logged into real accounts — don't take
  destructive or outward-facing actions unless explicitly asked.
- Never print cookies/secrets.
- Prefer reading/extraction; confirm before form submissions, purchases, or posting.
