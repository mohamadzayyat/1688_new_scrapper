# Capacity and speed

Copy these into your host env (Coolify / Docker / systemd):

```bash
# One scrape exclusively leases one Chromium worker. Keep these equal.
BROWSER_POOL_SIZE=8
BROWSER_WARM_SIZE=8
MAX_CONCURRENT=8

# Waiting room size before HTTP 439
MAX_QUEUE=64
QUEUE_TIMEOUT_MS=15000
BROWSER_ACQUIRE_TIMEOUT_MS=10000
REQUEST_TIMEOUT_MS=40000

# Response cache (duplicate requests skip scraping)
CACHE_TTL_MS=90000
ITEM_CACHE_TTL_MS=1800000
SEARCH_CACHE_TTL_MS=60000
CACHE_MAX_ENTRIES=2000
DISK_CACHE=1
DISK_CACHE_TTL_MS=21600000

PORT=3456
HOST=127.0.0.1
```

## Recommended VPS for ~90 live users

| Resource | Minimum | Comfortable |
|----------|---------|-------------|
| vCPU | 8 | 12–16 |
| RAM | 16 GB | 24–32 GB |
| Disk | 40 GB SSD | 80 GB SSD |
| Network | 100 Mbps + residential proxy | same |

Starting profiles:

| VPS | Pool / concurrency | Warm workers | Queue |
|-----|--------------------|--------------|-------|
| 4 vCPU / 8 GB | 3 / 3 | 2 | 15 |
| 8 vCPU / 16 GB | 6 / 6 | 4 | 30 |
| 16+ vCPU / 32+ GB | 8–10 / 8–10 | 6–8 | 50–64 |

Do not multiply `MAX_CONCURRENT` above `BROWSER_POOL_SIZE`: jobs would consume
queue slots while waiting invisibly for a browser. Keep one PM2 fork; cluster
mode multiplies browsers, queues, and memory caches per process.

Liveness: `GET /health`. Readiness: `GET /ready` (requires a usable saved 1688
session). Both expose queue/browser/cache state without exposing the API token.
