/**
 * In-process TTL cache for identical scrape requests.
 * Under multi-user load, duplicate item/search hits are free.
 */
const DEFAULT_TTL_MS = Math.max(5_000, Number(process.env.CACHE_TTL_MS) || 90_000);
const MAX_ENTRIES = Math.max(100, Number(process.env.CACHE_MAX_ENTRIES) || 2000);

const store = new Map(); // key -> { expires, value }
let hits = 0;
let misses = 0;

function now() {
  return Date.now();
}

function evictIfNeeded() {
  if (store.size <= MAX_ENTRIES) return;
  const entries = [...store.entries()].sort((a, b) => a[1].expires - b[1].expires);
  const drop = Math.ceil(store.size - MAX_ENTRIES * 0.8);
  for (let i = 0; i < drop; i++) store.delete(entries[i][0]);
}

export function cacheKey(parts) {
  return parts.map((p) => String(p ?? "").trim().toLowerCase()).join("|");
}

export function cacheGet(key) {
  const row = store.get(key);
  if (!row) {
    misses += 1;
    return null;
  }
  if (row.expires <= now()) {
    store.delete(key);
    misses += 1;
    return null;
  }
  hits += 1;
  return row.value;
}

export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { value, expires: now() + ttlMs });
  evictIfNeeded();
}

export async function cached(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit != null) return hit;
  const value = await producer();
  // Only cache successful TMAPI envelopes
  if (value && value.code === 200) {
    cacheSet(key, value, ttlMs);
  }
  return value;
}

export function cacheStats() {
  return {
    size: store.size,
    hits,
    misses,
    hitRate:
      hits + misses === 0 ? 0 : Number((hits / (hits + misses)).toFixed(3)),
    ttlMs: DEFAULT_TTL_MS,
    maxEntries: MAX_ENTRIES,
  };
}

export function cacheClear() {
  store.clear();
}
