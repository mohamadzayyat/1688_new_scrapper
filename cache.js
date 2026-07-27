/**
 * In-process + optional disk TTL cache.
 * Supports stale-while-revalidate so hot paths stay under 1s.
 */
import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
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
const CACHE_VERSION = process.env.CACHE_VERSION || "v3";

const store = new Map(); // key -> { expires, staleUntil, value }
const inflight = new Map(); // key -> Promise (singleflight)
let hits = 0;
let misses = 0;
let staleHits = 0;
let diskHits = 0;
let refreshFailures = 0;

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
  // Values such as signed image URLs can be case-sensitive. Callers should
  // canonicalize genuinely case-insensitive arguments before building a key.
  return [CACHE_VERSION, ...parts].map((p) => String(p ?? "").trim()).join("|");
}

function isCacheableValue(value) {
  if (!value || Number(value.code) !== 200 || value.data == null) return false;
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    return true;
  }
  const collectionKeys = [
    "items",
    "list",
    "categories",
    "children",
    "reviews",
    "ratings",
    "images",
    "detail_imgs",
    "main_imgs",
  ];
  const present = collectionKeys.filter((key) => Array.isArray(value.data[key]));
  return present.length === 0 || present.some((key) => value.data[key].length > 0);
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
    void persistDisk(key, value, freshFor, keepStaleFor);
  }
}

async function persistDisk(key, value, freshFor, keepStaleFor) {
  try {
    await mkdir(DISK_DIR, { recursive: true });
    const writtenAt = now();
    const payload = {
      key,
      freshUntil: writtenAt + freshFor,
      staleUntil: writtenAt + keepStaleFor,
      value,
    };
    const target = diskPath(key);
    const temporary = `${target}.${process.pid}.${writtenAt}.tmp`;
    await writeFile(temporary, JSON.stringify(payload), "utf8");
    await rename(temporary, target);
  } catch {
    // disk cache is best-effort
  }
}

async function readDisk(key, { allowStale = false } = {}) {
  if (!DISK_ENABLED) return null;
  try {
    const raw = await readFile(diskPath(key), "utf8");
    const payload = JSON.parse(raw);
    // Legacy entries only had one stale expiry. Never treat those as fresh.
    const freshUntil = Number(payload?.freshUntil || 0);
    const staleUntil = Number(payload?.staleUntil || payload?.expires || 0);
    const t = now();
    if (!payload || staleUntil <= t) {
      void unlink(diskPath(key)).catch(() => {});
      return null;
    }
    const fresh = freshUntil > t;
    if (!fresh && !allowStale) return null;
    diskHits += 1;
    store.set(key, {
      value: payload.value,
      expires: freshUntil,
      staleUntil,
    });
    return { value: payload.value, fresh };
  } catch {
    return null;
  }
}

function refreshInBackground(key, ttlMs, producer) {
  if (inflight.has(key)) return;
  const refresh = Promise.resolve()
    .then(producer)
    .then((value) => {
      if (isCacheableValue(value)) cacheSet(key, value, ttlMs);
      return value;
    })
    .catch((err) => {
      refreshFailures += 1;
      console.error(`[cache] background refresh failed: ${err?.message || err}`);
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, refresh);
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
    if (disk?.fresh) {
      hits += 1;
      return disk.value;
    }
    const value = await producer();
    if (isCacheableValue(value)) {
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
    refreshInBackground(key, ttlMs, producer);
    return mem.value;
  }

  // try disk before cold scrape
  const disk = await readDisk(key, { allowStale: true });
  if (disk) {
    hits += 1;
    if (!disk.fresh) refreshInBackground(key, ttlMs, producer);
    return disk.value;
  }

  if (inflight.has(key)) return inflight.get(key);
  misses += 1;

  const job = (async () => {
    const value = await producer();
    if (isCacheableValue(value)) cacheSet(key, value, ttlMs);
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
    refreshFailures,
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
