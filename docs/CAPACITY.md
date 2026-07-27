# Capacity & speed (≈90 concurrent users)

Copy these into your host env (Coolify / Docker / systemd):

```bash
# Parallel scrapes (in-flight Playwright jobs)
MAX_CONCURRENT=24

# Waiting room size before HTTP 439
MAX_QUEUE=200
QUEUE_TIMEOUT_MS=120000

# Shared Chromium workers (RAM heavy — ~150–300MB each)
BROWSER_POOL_SIZE=8

# Response cache (duplicate requests skip scraping)
CACHE_TTL_MS=90000
ITEM_CACHE_TTL_MS=120000
SEARCH_CACHE_TTL_MS=60000
CACHE_MAX_ENTRIES=2000

PORT=3456
```

## Recommended VPS for ~90 live users

| Resource | Minimum | Comfortable |
|----------|---------|-------------|
| vCPU | 8 | 12–16 |
| RAM | 16 GB | 24–32 GB |
| Disk | 40 GB SSD | 80 GB SSD |
| Network | 100 Mbps + residential proxy | same |

Formula of thumb:
- `BROWSER_POOL_SIZE ≈ 6–12`
- `MAX_CONCURRENT ≈ BROWSER_POOL_SIZE × 2–3`
- Keep `MAX_QUEUE` high so users wait instead of hard-fail

Health check: `GET /health` — shows queue, browser pool, cache hit rate.
