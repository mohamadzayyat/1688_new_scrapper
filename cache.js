/**
 * In-process + optional disk TTL cache.
 * Supports stale-while-revalidate so hot paths stay under 1s.
 */
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  rename,
  readdir,
  stat,
} from "node:fs/promises";
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
const CACHE_VERSION = process.env.CACHE_VERSION || "v5";
const DISK_MAX_FILES = Math.max(
  100,
  Number(process.env.DISK_CACHE_MAX_FILES) || 5_000
);
const DISK_MAX_BYTES = Math.max(
  10 * 1024 * 1024,
  Number(process.env.DISK_CACHE_MAX_BYTES) || 512 * 1024 * 1024
);
const DISK_MAX_AGE_MS = Math.max(
  DISK_TTL_MS,
  Number(process.env.DISK_CACHE_MAX_AGE_MS) || 24 * 60 * 60 * 1000
);
const DISK_PRUNE_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.DISK_CACHE_PRUNE_INTERVAL_MS) || 60_000
);
const DISK_TEMP_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.DISK_CACHE_TEMP_MAX_AGE_MS) || 10 * 60 * 1000
);

const store = new Map(); // key -> { expires, staleUntil, value }
const inflight = new Map(); // key -> { promise, controller, subscribers, ... }
let hits = 0;
let misses = 0;
let staleHits = 0;
let diskHits = 0;
let refreshFailures = 0;
let diskPrunedFiles = 0;
let lastDiskPrune = 0;
let diskPrunePromise = null;
const pendingDiskWrites = new Set();

function markCacheResult(value, status) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  try {
    Object.defineProperty(value, "__scraperCache", {
      value: status,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Cache metadata is diagnostic only.
  }
  return value;
}

function cacheMetadata(value) {
  return value?.__scraperPath
    ? { scraperPath: String(value.__scraperPath) }
    : undefined;
}

function restoreCacheMetadata(value, metadata) {
  if (!value || typeof value !== "object" || !metadata?.scraperPath) return value;
  try {
    Object.defineProperty(value, "__scraperPath", {
      value: String(metadata.scraperPath),
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Diagnostic metadata must never break a usable cache entry.
  }
  return value;
}

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
  if (value?.__scraperNoCache) return false;
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
  return markCacheResult(row.value, "memory");
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
    return { value: markCacheResult(row.value, "memory"), fresh: true };
  }
  staleHits += 1;
  return { value: markCacheResult(row.value, "stale"), fresh: false };
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
    const write = persistDisk(key, value, freshFor, keepStaleFor);
    pendingDiskWrites.add(write);
    void write.then(
      () => pendingDiskWrites.delete(write),
      () => pendingDiskWrites.delete(write)
    );
  }
}

export async function flushDiskCacheWrites() {
  while (pendingDiskWrites.size) {
    await Promise.allSettled([...pendingDiskWrites]);
  }
}

async function persistDisk(key, value, freshFor, keepStaleFor) {
  let temporary = null;
  try {
    await mkdir(DISK_DIR, { recursive: true });
    // Free expired entries before a write so a full cache directory can recover.
    await scheduleDiskPrune();
    const writtenAt = now();
    const payload = {
      key,
      freshUntil: writtenAt + freshFor,
      staleUntil: writtenAt + keepStaleFor,
      value,
      metadata: cacheMetadata(value),
    };
    const target = diskPath(key);
    temporary = `${target}.${process.pid}.${writtenAt}.tmp`;
    await writeFile(temporary, JSON.stringify(payload), "utf8");
    await rename(temporary, target);
    temporary = null;
  } catch (error) {
    // disk cache is best-effort
    if (temporary) await unlink(temporary).catch(() => {});
    if (["ENOSPC", "EDQUOT"].includes(error?.code)) {
      // If the filesystem itself is full, configured cache limits may not yet
      // be exceeded. Drop the oldest cache slice so the next write can recover.
      await pruneDiskCache({ emergency: true }).catch(() => {});
    } else {
      await scheduleDiskPrune({ force: true });
    }
  } finally {
    void scheduleDiskPrune();
  }
}

export async function pruneDiskCache({ emergency = false } = {}) {
  if (!DISK_ENABLED) return { removed: 0, files: 0, bytes: 0 };
  await mkdir(DISK_DIR, { recursive: true });
  const names = (await readdir(DISK_DIR)).filter(
    (name) => name.endsWith(".json") || name.endsWith(".tmp")
  );
  const files = (
    await Promise.all(
      names.map(async (name) => {
        try {
          const info = await stat(join(DISK_DIR, name));
          return {
            name,
            path: join(DISK_DIR, name),
            size: info.size,
            mtimeMs: info.mtimeMs,
            temporary: name.endsWith(".tmp"),
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);

  const cutoff = now() - DISK_MAX_AGE_MS;
  const temporaryCutoff = now() - DISK_TEMP_MAX_AGE_MS;
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  let remaining = files.length;
  let removed = 0;
  let emergencyRemaining = emergency
    ? Math.max(1, Math.ceil(files.filter((file) => !file.temporary).length * 0.1))
    : 0;
  for (const file of files) {
    const overLimit = remaining > DISK_MAX_FILES || bytes > DISK_MAX_BYTES;
    const expired = file.temporary
      ? file.mtimeMs < temporaryCutoff
      : file.mtimeMs < cutoff;
    // Never unlink a fresh temporary file that another write may still own.
    const emergencyDelete = !file.temporary && emergencyRemaining > 0;
    if (!expired && !emergencyDelete && (file.temporary || !overLimit)) continue;
    try {
      await unlink(file.path);
      removed += 1;
      remaining -= 1;
      bytes -= file.size;
      if (emergencyDelete) emergencyRemaining -= 1;
    } catch {
      // Another cache operation may already have removed the entry.
    }
  }
  diskPrunedFiles += removed;
  return { removed, files: remaining, bytes: Math.max(0, bytes) };
}

function scheduleDiskPrune({ force = false } = {}) {
  if (!DISK_ENABLED) return Promise.resolve(null);
  if (diskPrunePromise) return diskPrunePromise;
  if (!force && now() - lastDiskPrune < DISK_PRUNE_INTERVAL_MS) {
    return Promise.resolve(null);
  }
  lastDiskPrune = now();
  diskPrunePromise = pruneDiskCache()
    .catch(() => null)
    .finally(() => {
      diskPrunePromise = null;
    });
  return diskPrunePromise;
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
    restoreCacheMetadata(payload.value, payload.metadata);
    store.set(key, {
      value: payload.value,
      expires: freshUntil,
      staleUntil,
    });
    evictIfNeeded();
    scheduleDiskPrune();
    return {
      value: markCacheResult(payload.value, fresh ? "disk" : "stale-disk"),
      fresh,
    };
  } catch {
    return null;
  }
}

function cacheAbortError(signal = null) {
  const reason = signal?.reason;
  if (
    reason instanceof Error &&
    !(reason.name === "AbortError" && reason.constructor?.name === "DOMException")
  ) {
    return reason;
  }
  const error = new Error("Cache subscriber cancelled");
  error.name = "AbortError";
  error.code = 499;
  error.cancelled = true;
  return error;
}

function startInflight(key, task, { background = false } = {}) {
  const controller = new AbortController();
  const entry = {
    controller,
    subscribers: 0,
    background,
    settled: false,
    promise: null,
  };
  entry.promise = Promise.resolve()
    .then(() => task(controller.signal))
    .finally(() => {
      entry.settled = true;
      if (inflight.get(key) === entry) inflight.delete(key);
    });
  inflight.set(key, entry);
  return entry;
}

function subscribeInflight(entry, signal) {
  if (signal?.aborted) {
    if (entry.subscribers === 0 && !entry.background && !entry.settled) {
      entry.controller.abort(signal.reason);
    }
    return Promise.reject(cacheAbortError(signal));
  }
  entry.subscribers += 1;
  return new Promise((resolve, reject) => {
    let detached = false;
    const detach = (cancelled = false) => {
      if (detached) return;
      detached = true;
      signal?.removeEventListener("abort", onAbort);
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (
        cancelled &&
        entry.subscribers === 0 &&
        !entry.background &&
        !entry.settled
      ) {
        entry.controller.abort(signal?.reason);
      }
    };
    const onAbort = () => {
      detach(true);
      reject(cacheAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error) => {
        detach();
        reject(error);
      }
    );
  });
}

function liveInflight(key) {
  const entry = inflight.get(key);
  return entry && !entry.controller.signal.aborted ? entry : null;
}

function refreshInBackground(key, ttlMs, producer) {
  if (inflight.has(key)) return;
  const entry = startInflight(
    key,
    async (signal) => {
      try {
        const value = await producer(signal);
        if (signal.aborted) throw cacheAbortError(signal);
        if (isCacheableValue(value)) cacheSet(key, value, ttlMs);
        return value;
      } catch (err) {
        refreshFailures += 1;
        console.error(`[cache] background refresh failed: ${err?.message || err}`);
        return null;
      }
    },
    { background: true }
  );
  // Background refreshes deliberately have no HTTP subscriber.
  void entry.promise;
}

/**
 * Classic cache-aside (fresh only).
 */
export async function cached(key, ttlMs, producer, { signal } = {}) {
  const hit = cacheGet(key);
  if (hit != null) return hit;

  const existing = liveInflight(key);
  if (existing) return subscribeInflight(existing, signal);
  if (signal?.aborted) throw cacheAbortError(signal);

  const entry = startInflight(key, async (workSignal) => {
    const disk = await readDisk(key);
    if (disk?.fresh) {
      hits += 1;
      return disk.value;
    }
    if (workSignal.aborted) throw cacheAbortError(workSignal);
    const produced = await producer(workSignal);
    if (workSignal.aborted) throw cacheAbortError(workSignal);
    const value = markCacheResult(produced, "miss");
    if (isCacheableValue(value)) cacheSet(key, value, ttlMs);
    return value;
  });
  return subscribeInflight(entry, signal);
}

/**
 * Stale-while-revalidate: return cached (even expired) immediately,
 * refresh in background. First-ever miss still waits on producer.
 *
 * Guarantees <1s for any previously seen key.
 */
export async function cachedSwr(key, ttlMs, producer, { signal } = {}) {
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

  const existing = liveInflight(key);
  if (existing) return subscribeInflight(existing, signal);
  if (signal?.aborted) throw cacheAbortError(signal);
  misses += 1;

  const entry = startInflight(key, async (workSignal) => {
    if (workSignal.aborted) throw cacheAbortError(workSignal);
    const produced = await producer(workSignal);
    if (workSignal.aborted) throw cacheAbortError(workSignal);
    const value = markCacheResult(produced, "miss");
    if (isCacheableValue(value)) cacheSet(key, value, ttlMs);
    return value;
  });
  return subscribeInflight(entry, signal);
}

export function cacheStats() {
  return {
    size: store.size,
    hits,
    misses,
    staleHits,
    diskHits,
    diskPrunedFiles,
    refreshFailures,
    hitRate:
      hits + misses === 0 ? 0 : Number((hits / (hits + misses)).toFixed(3)),
    ttlMs: DEFAULT_TTL_MS,
    diskTtlMs: DISK_TTL_MS,
    maxEntries: MAX_ENTRIES,
    diskEnabled: DISK_ENABLED,
    diskMaxFiles: DISK_MAX_FILES,
    diskMaxBytes: DISK_MAX_BYTES,
  };
}

export function cacheClear() {
  store.clear();
}

// Clean crash leftovers and expired entries even before the first cache hit.
if (DISK_ENABLED) void scheduleDiskPrune({ force: true });
