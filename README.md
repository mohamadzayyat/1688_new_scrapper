# 1688 Scraper

Scrape a 1688 product by offer ID, or search keywords with pagination. Use the local UI or CLI — both return JSON.

For a deep dive on architecture, speed tactics, proxy/auth/language, see **[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)**.

## Setup

```bash
npm install
```

## Local UI

```bash
npm start
```

Open [http://localhost:3456](http://localhost:3456)

- **Offer ID** — scrape one product
- **Search** — keyword + page number, with Prev/Next

## CLI

```bash
# Product detail (Chinese default, or English)
node cli.js 874039857500
node cli.js 874039857500 --lang en
node cli.js 874039857500 --out output/product.json

# Search
node cli.js --search router
node cli.js --search router --lang en
node cli.js --search router --page 2 --out output/router-p2.json
```

## API

```bash
GET /api/scrape?id=874039857500
GET /api/scrape?id=874039857500&lang=en
GET /api/search?q=router&page=1
GET /api/search?q=router&page=1&lang=en
```

Search JSON shape:

```json
{
  "keyword": "router",
  "page": 1,
  "pageSize": 20,
  "total": 2000,
  "totalPages": 100,
  "hasNextPage": true,
  "results": [
    {
      "offerId": "...",
      "title": "...",
      "price": "47",
      "sales": "2.2万+件",
      "url": "https://detail.1688.com/offer/....html"
    }
  ]
}
```

## Proxy (recommended for search)

Create `proxy.config.json` (gitignored):

```json
{
  "enabled": true,
  "provider": "dataimpulse",
  "proxyUrl": "http://USER:PASS@gw.dataimpulse.com:823"
}
```

Or set `PROXY_URL`. A residential proxy often avoids 1688’s anonymous search login wall.

## Login (for search)

1688 blocks anonymous search. Save a **verified** session once:

```bash
npm run login
```

1. Browser opens the 1688 login page  
2. Log in fully until you land on **1688.com** (not stuck on Taobao login)  
3. Return to the terminal and **press Enter**  
4. It verifies search works, then saves `.auth/1688.json`

If `__cn_logon__` is still `false`, login was incomplete — run `npm run login` again.

## Notes

- Detail pages usually work without login.
- Search uses mobile results by default (with saved session when available).
- UI Search tab supports page number + Prev/Next.
