# How this 1688 scraper works

This document explains the approach used in this project: what tools we rely on, how data is extracted, and what makes the flow relatively fast and reliable.

## Stack

| Piece | Choice | Why |
|---|---|---|
| Runtime | **Node.js (ESM)** | Simple CLI + local HTTP UI in one language |
| Browser automation | **Playwright + Chromium** | 1688 pages are JS-rendered; plain HTTP/`fetch` is not enough |
| Local UI | Native `node:http` + static files in `public/` | No Express needed for a small tool |
| Proxy | **DataImpulse** via `proxy.config.json` | Avoids IP blocks / forced login on search |
| Auth (optional) | Playwright `storageState` in `.auth/1688.json` | Reuses a real 1688 login when needed |
| English (offers) | 1688 cookie `oversealanguage=en` | Triggers 1688’s built-in overseas translator |
| English (search titles) | Google `translate_a/single` (gtx) | Search cards don’t always translate cleanly in-page |

Main entrypoints:

- `server.js` — local UI + API (`/api/scrape`, `/api/search`)
- `cli.js` — command-line interface
- `scrape.js` — offer detail scraper
- `search.js` — keyword search + pagination
- `browser.js` / `proxy.js` — Chromium launch with optional proxy
- `auth.js` — login session save/load
- `translate.js` — batch title translation for search

---

## Core idea: don’t scrape the HTML like a human

The fast path is **reading the page’s own JS data models**, not parsing big HTML trees.

### Offer detail (`scrape.js`)

1. Open `https://detail.1688.com/offer/{id}.html` in headless Chromium.
2. Wait until `window.context.result.data` is populated.
3. Pull structured fields from known modules:
   - `productTitle`
   - `mainPrice` (SKU map, stock, MOQ)
   - `productPackInfo` (weight / dimensions)
   - `gallery` (images)
   - `mainServices` (guarantees)
   - `Root.fields.dataJson` (seller / images / category)
4. Normalize into clean JSON.

That is much faster and more stable than scraping random CSS classes for price/title/SKU.

### Search (`search.js`)

Two sources, in order of preference:

1. **Desktop search** (`s.1688.com`) when a valid login session exists  
   → read `window.data.offerV2Showed.offerList` (rich JSON, ~60 items/page).
2. **Mobile search** (`m.1688.com/offer_search/-{hex}.html`)  
   → parse `a.item-link` cards (works better anonymously / with proxy).

Pagination uses `beginPage=N`.

Keyword path encoding for mobile:

```text
router  →  hex utf-8  →  726f75746572
URL     →  https://m.1688.com/offer_search/-726f75746572.html?beginPage=1
```

---

## What makes it “fast”

“Fast” here means **seconds per request**, not milliseconds. A full scrape still launches Chromium and loads 1688. The speed wins come from avoiding slow/fragile work:

### 1. Structured data first
Reading `window.context` / `window.data` avoids:
- brittle CSS selectors
- waiting for every image/widget
- reconstructing SKUs from visible text

### 2. Targeted waits (not fixed long sleeps)
We poll until data appears (offer modules / item cards), then continue.  
Wrong Playwright pattern to avoid:

```js
// BAD: options object is treated as the pageFunction argument
await page.waitForFunction(fn, { timeout: 45000 });

// GOOD: poll yourself, or pass args correctly
await page.waitForFunction(fn, undefined, { timeout: 45000 });
```

This project mostly uses an explicit poll loop so timeouts and error messages stay clear.

### 3. Proxy instead of fighting captchas
Anonymous search often redirects to login after a few hits.  
A residential proxy (`proxy.config.json`) usually restores search without manual login.

### 4. Mobile search fallback
Mobile listing pages are lighter and less aggressive than desktop search for guests.

### 5. English without re-scraping twice
- **Offers:** set cookie `oversealanguage=en` before navigation so 1688’s own translator fills English titles/SKUs into the same data model.
- **Search:** scrape Chinese results once, then batch-translate titles (`title` + `titleOriginal`).

### 6. One active job at a time
The server rejects overlapping scrapes (`429`) so Chromium sessions don’t pile up and thrash the machine/proxy.

### 7. Shared browser launcher
`launchBrowser()` centralizes proxy + Chromium flags (`--disable-blink-features=AutomationControlled`).

---

## Language handling

| Mode | Offer scrape | Search |
|---|---|---|
| `lang=zh` | Normal Chinese page/data | Chinese titles as returned |
| `lang=en` | Cookie `oversealanguage=en` → 1688 translator | Titles translated; original kept in `titleOriginal` |

API examples:

```bash
GET /api/scrape?id=874039857500&lang=en
GET /api/search?q=router&page=1&lang=en
```

CLI:

```bash
node cli.js 874039857500 --lang en
node cli.js --search router --lang en --page 2
```

---

## Proxy setup

File: `proxy.config.json` (gitignored)

```json
{
  "enabled": true,
  "provider": "dataimpulse",
  "proxyUrl": "http://USER:PASS@gw.dataimpulse.com:823"
}
```

Or env:

```bash
set PROXY_URL=http://USER:PASS@gw.dataimpulse.com:823
```

Playwright receives:

```js
{
  server: "http://gw.dataimpulse.com:823",
  username: "USER",
  password: "PASS"
}
```

---

## Login session (optional)

If search still forces login:

```bash
npm run login
```

1. Browser opens 1688 login.
2. Finish login until you are on **1688.com**.
3. Press Enter in the terminal.
4. Session is verified against search, then saved to `.auth/1688.json`.

Important: an incomplete save shows `__cn_logon__=false` and will still redirect to login. The login flow checks for a real logged-in cookie before saving.

---

## End-to-end flow

```text
UI / CLI / API
    │
    ▼
server.js  or  cli.js
    │
    ├─ scrapeOffer(id, { lang })
    │     launch Chromium (+ proxy)
    │     set oversealanguage cookie
    │     open detail page
    │     wait for window.context
    │     normalize JSON
    │
    └─ searchOffers(q, { page, lang })
          launch Chromium (+ proxy)
          try desktop window.data (if logged in)
          else mobile item-link cards
          if lang=en → translate titles
          return paginated JSON
```

Typical timings on this setup (proxy on):

- Offer scrape (zh): ~8–12s
- Offer scrape (en): ~10–15s (extra wait for 1688 translator)
- Search page (zh): ~8–15s
- Search page (en): ~9–16s (includes title translation)

Every JSON response now includes:

```json
"timing": {
  "durationMs": 10490,
  "durationSeconds": 10.49,
  "attempts": 1
}
```

The UI summary card **Took** shows `durationSeconds`. CLI/server also log `[timing] ...`.

---

## Reliability lessons learned

1. **Playwright `waitForFunction` signature matters** — mis-passing options silently keeps the 30s default.
2. **Never `return page.evaluate(...)` inside `try/finally` that closes the context** — `finally` can close the page before evaluate finishes. Always `await` first.
3. **Desktop search login walls are common** — proxy + mobile fallback is the practical path.
4. **Login cookies ≠ logged in** — require `__cn_logon__=true` (or verified search access).
5. **English offer mode is cookie-based** — `oversealanguage=en` is the switch for 1688’s translator.

---

## Files map

```text
1688-scraper/
├── cli.js                 # CLI
├── server.js              # Local UI + API
├── scrape.js              # Offer detail extraction
├── search.js              # Search + pagination
├── translate.js           # Search title translation
├── browser.js             # Chromium launcher
├── proxy.js               # Proxy config loader
├── auth.js                # Login storageState
├── proxy.config.json      # Local secrets (gitignored)
├── .auth/1688.json        # Saved session (gitignored)
└── public/                # UI (index.html, app.js, styles.css)
```

---

## Quick start

```bash
npm ci
npm run install:browsers
npm start
# open http://localhost:3456
```

```bash
node cli.js 874039857500 --lang en
node cli.js --search router --lang en --page 1
```
