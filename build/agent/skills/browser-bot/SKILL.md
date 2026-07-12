---
name: browser-bot
description: Drive a real Chrome browser over the DevTools Protocol (CDP) to research the live web, read pages that need rendering or a logged-in session, click through flows, and extract data. Use when WebSearch/WebFetch aren't enough — sites that render client-side, need a real session, or must be interacted with.
allowed-tools: Bash, Read, Write, Edit
---

# browser-bot — drive a real browser over CDP (A14)

You have your **own** headful Chrome in a sidecar container (the `tonoman/chrome` image),
reachable over **CDP**. You connect to it — you do **not** launch your own browser — so cookies
and logins persist across turns. A human can watch you live (`tonoman open browser`), so browse
like someone is looking over your shoulder.

## Step 0 — Ensure you have a browser, then find its CDP endpoint
**First, just ask for one** — this auto-provisions it if absent (no operator step needed):
```bash
tonoman browser ensure     # broker opens a real Chrome on the operator's host with CDP;
                           # writes your endpoint to ~/.tonoman/browser.json. Idempotent.
```
Then read the endpoint and resolve the host to an **IP** (Chrome's CDP rejects a hostname in the
`Host` header — you must connect by IP):
```bash
CDP_URL=$(cat ~/.tonoman/browser.json 2>/dev/null | sed -n 's/.*"cdp": *"\([^"]*\)".*/\1/p')   # http://host.containers.internal:<port>
PORT=$(printf '%s' "$CDP_URL" | sed -n 's/.*:\([0-9]\+\).*/\1/p')
HOST_IP=$(getent hosts host.containers.internal | head -1 | awk '{print $1}')
curl -s "http://$HOST_IP:$PORT/json/version"   # sanity check — should print Browser/…
export HOST_IP CDP_PORT="$PORT"
```
> If `~/.tonoman/browser.json` is missing, your browser isn't provisioned yet — tell the operator:
> `tonoman create browser -a <you>` (one time; the profile + sidecar then persist). Then re-read it.

## Drive it — raw CDP or playwright-core
**Preferred (ergonomic): `playwright-core` over CDP** — gives you an accessibility-tree snapshot
with stable element refs and auto-waiting, so you click the *right* element instead of guessing.
It attaches to the existing Chrome (no browser download). Install it **locally** in your tools dir
(a global `-g` install is NOT on the ESM resolution path), then run scripts from there:
```bash
mkdir -p ~/.tonoman/tools && cd ~/.tonoman/tools
[ -d node_modules/playwright-core ] || npm i playwright-core >/dev/null 2>&1   # one-time; persists in your git memory
cat > browse.mjs <<'JS'
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP(`http://${process.env.HOST_IP}:${process.env.CDP_PORT}`);
const ctx = b.contexts()[0] ?? await b.newContext();
const page = await ctx.newPage();   // your own tab; don't hijack an operator tab
await page.goto(process.argv[2], { waitUntil: 'load' });

// 1) WAIT FOR THE PAGE TO ACTUALLY RENDER before reading. Most sites are SPAs whose body is
//    EMPTY at load — reading now gives blank. Prefer waiting for a KNOWN element (a heading,
//    main, a nav); fall back to "body has real text". Bounded. NEVER use networkidle (live
//    sites with websockets never idle — it just times out).
await Promise.race([
  page.waitForSelector('h1, [role=heading], main, [role=main], article', { timeout: 20000 }),
  page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 50, { timeout: 20000 }),
]).catch(() => {});
await page.waitForTimeout(500);   // let late content settle

// 2) READ A STRUCTURED SNAPSHOT, not raw text — it's the rendered accessibility tree (roles +
//    names), far better for reasoning AND it names elements you can act on. Falls back to text.
const view = await page.locator('body').ariaSnapshot().catch(() => null);
console.log('TITLE:', await page.title());
console.log(view ?? (await page.innerText('body')).slice(0, 4000));

await page.close();
await b.close();   // detach (does NOT close the shared browser)
JS
HOST_IP=$HOST_IP CDP_PORT=$CDP_PORT node ~/.tonoman/tools/browse.mjs "https://example.com"
```

**Act on what the snapshot named** — use role/text locators (they AUTO-WAIT for the element to be
actionable; never pixel coordinates or brittle CSS):
```js
await page.getByRole('button',  { name: 'Sign in' }).click();
await page.getByRole('textbox', { name: 'Email'   }).fill('me@example.com');
```
**Wait for a KNOWN condition** before reading/asserting (mirrors how openclaw/Hermes drive — wait
for the *thing*, not a guess):
```js
await page.getByText('Dashboard').first().waitFor({ state: 'visible', timeout: 15000 });
await page.waitForSelector('#results', { state: 'visible' });
await page.waitForFunction('window.__ready === true');
```
Screenshot (you, or the watching operator, can also see it live): `await page.screenshot({ path: '/root/.tonoman/shot.png', fullPage: true })`.

**Raw CDP** (no library) is also available: open a WebSocket to the `webSocketDebuggerUrl` from
`/json/version` and send `Page.navigate`, `Runtime.evaluate`, etc. Use only when you don't want the
Playwright layer — but you then own the render-wait yourself.

## Logging in (you, or the operator)
- **Automatable login:** navigate to the login page and type credentials from a granted secret
  (under `secrets/`, never printed/committed). The session then persists in your profile.
- **Needs a human (MFA, CAPTCHA, or a credential you weren't given):** **pause and ask the operator
  to take the wheel** — tell them to run `tonoman open browser -a <you>` (interactive), complete the
  login in the live view, and say when done. You then **continue already logged in** — the
  persistent profile keeps the session across this turn and later ones. While they're at the wheel,
  **wait** (don't drive the same Chrome over them).

## Guardrails
- The profile is **yours** and may be **logged into real accounts** — don't take destructive or
  outward-facing actions (posting, purchasing, deleting, form submits) unless explicitly asked;
  confirm first.
- **Never print cookies, tokens, or passwords.** Any credential a task needs goes under `secrets/`
  (git-ignored), never committed.
- Read/extract first. Quote what you actually saw; don't invent page content.
- **A blank/empty body almost always means the SPA hasn't rendered yet — NOT that the page is
  empty.** Wait for content (the `waitForFunction` above, or `await page.waitForSelector('<a known
  element>')`) and re-read before concluding anything; never tell the operator "it's blank" off an
  unrendered read. If still empty after the wait, say you waited and what you tried.
- Connect by **IP**, not hostname (Chrome rejects hostname `Host` headers). Detach (`b.close()`),
  don't kill the shared browser.
