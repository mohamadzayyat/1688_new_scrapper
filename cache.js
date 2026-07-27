/**
 * In-process + optional disk TTL cache.
 * Supports stale-while-revalidate so hot paths stay under 1s.
 */
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const DEFAULT_TTL_MS = Math.max(5_000, Number(process.env.CACHE_TTL_MS) || 90_000);
const MAX_ENTRIES = Math.max(100, Number(process.env.CACHE_MAX_ENTRIES) || 2000);
const DISK_TTL_MS = Math.max(
  DEFAULT_TTL_MS,
  Number(process.env.DISK_CACHE_TTL_MS) || 6 * 60 * 60 * 1000 // 6h
);
const DISK_DIR =
  process.env.CACHE_DIR ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".cache");
const DISK_ENABLED = String(process.env.DISK_CACHE || "1") !== "0";

const store = new Map(); // key -> { expires, staleUntil, value }
const inflight = new Map(); // key -> Promise (singleflight)
let hits = 0;
let misses = 0;
let staleHits = 0;
let diskHits = 0;

function now() {
  return Date.now();
}

function evictIfNeeded() {
  if (store.size <= MAX_ENTRIES) return;
  const entries = [...store.entries()].sort(
    (a, b) => a[1].expires - b[1].expires
  );
  const drop = Math.ceil(store.size - MAX_ENTRIES * 0.8);
  for (let i = 0; i < drop; i++) store.delete(entries[i][0]);
}

function diskPath(key) {
  const hash = createHash("sha1").update(key).digest("hex");
  return join(DISK_DIR, `${hash}.json`);
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

/**
 * Return fresh or stale memory entry.
 * @returns {{ value: any, fresh: boolean } | null}
 */
export function cacheGetFreshOrStale(key) {
  const row = store.get(key);
  if (!row) return null;
  const t = now();
  if (row.staleUntil && row.staleUntil <= t) {
    store.delete(key);
    return null;
  }
  if (row.expires > t) {
    hits += 1;
    return { value: row.value, fresh: true };
  }
  staleHits += 1;
  return { value: row.value, fresh: false };
}

export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  const freshFor = ttlMs;
  const keepStaleFor = Math.max(freshFor * 4, DISK_TTL_MS);
  store.set(key, {
    value,
    expires: now() + freshFor,
    staleUntil: now() + keepStaleFor,
  });
  evictIfNeeded();
  if (DISK_ENABLED) {
    void persistDisk(key, value, keepStaleFor);
  }
}

async function persistDisk(key, value, ttlMs) {
  try {
    await mkdir(DISK_DIR, { recursive: true });
    const payload = {
      key,
      expires: now() + ttlMs,
      value,
    };
    await writeFile(diskPath(key), JSON.stringify(payload), "utf8");
  } catch {
    // disk cache is best-effort
  }
}

async function readDisk(key) {
  if (!DISK_ENABLED) return null;
  try {
    const raw = await readFile(diskPath(key), "utf8");
    const payload = JSON.parse(raw);
    if (!payload || payload.expires <= now()) {
      void unlink(diskPath(key)).catch(() => {});
      return null;
    }
    diskHits += 1;
    // hydrate memory as stale-capable
    store.set(key, {
      value: payload.value,
      expires: Math.min(payload.expires, now() + DEFAULT_TTL_MS),
      staleUntil: payload.expires,
    });
    return payload.value;
  } catch {
    return null;
  }
}

/**
 * Classic cache-aside (fresh only).
 */
export async function cached(key, ttlMs, producer) {
  const hit = cacheGet(key);
  if (hit != null) return hit;

  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const disk = await readDisk(key);
    if (disk != null) {
      hits += 1;
      return disk;
    }
    misses += 1;
    const value = await producer();
    if (value && value.code === 200) {
      cacheSet(key, value, ttlMs);
    }
    return value;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/**
 * Stale-while-revalidate: return cached (even expired) immediately,
 * refresh in background. First-ever miss still waits on producer.
 *
 * Guarantees <1s for any previously seen key.
 */
export async function cachedSwr(key, ttlMs, producer) {
  const mem = cacheGetFreshOrStale(key);
  if (mem?.fresh) return mem.value;

  if (mem && !mem.fresh) {
    // serve stale, refresh off-request
    if (!inflight.has(key)) {
      const refresh = (async () => {
        const value = await producer();
        if (value && value.code === 200) cacheSet(key, value, ttlMs);
        return value;
      })().finally(() => inflight.delete(key));
      inflight.set(key, refresh);
    }
    return mem.value;
  }

  // try disk before cold scrape
  const disk = await readDisk(key);
  if (disk != null) {
    if (!inflight.has(key)) {
      const refresh = (async () => {
        const value = await producer();
        if (value && value.code === 200) cacheSet(key, value, ttlMs);
        return value;
      })().finally(() => inflight.delete(key));
      inflight.set(key, refresh);
    }
    return disk;
  }

  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const value = await producer();
    if (value && value.code === 200) cacheSet(key, value, ttlMs);
    return value;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

export function cacheStats() {
  return {
    size: store.size,
    hits,
    misses,
    staleHits,
    diskHits,
    hitRate:
      hits + misses === 0 ? 0 : Number((hits / (hits + misses)).toFixed(3)),
    ttlMs: DEFAULT_TTL_MS,
    diskTtlMs: DISK_TTL_MS,
    maxEntries: MAX_ENTRIES,
    diskEnabled: DISK_ENABLED,
  };
}

export function cacheClear() {
  store.clear();
}
