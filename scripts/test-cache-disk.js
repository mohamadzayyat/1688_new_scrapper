import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cacheDir = await mkdtemp(join(tmpdir(), "1688-cache-test-"));
process.env.CACHE_DIR = cacheDir;
process.env.DISK_CACHE = "1";
process.env.CACHE_VERSION = `test-${process.pid}`;
process.env.CACHE_MAX_ENTRIES = "100";
process.env.DISK_CACHE_MAX_FILES = "100";
process.env.DISK_CACHE_MAX_BYTES = String(10 * 1024 * 1024);
process.env.DISK_CACHE_TEMP_MAX_AGE_MS = "60000";

try {
  const {
    cacheClear,
    cacheKey,
    cacheSet,
    cached,
    cacheStats,
    flushDiskCacheWrites,
    pruneDiskCache,
  } = await import("../cache.js");
  const key = cacheKey(["detail", "1"]);
  const value = { code: 200, data: { item_id: 1 } };
  Object.defineProperty(value, "__scraperPath", {
    value: "http",
    enumerable: false,
  });
  cacheSet(key, value, 10_000);
  await flushDiskCacheWrites();
  cacheClear();

  const restored = await cached(key, 10_000, async () => {
    throw new Error("disk cache miss");
  });
  assert.equal(restored.__scraperPath, "http");
  assert.equal(restored.__scraperCache, "disk");
  assert.equal(JSON.stringify(restored).includes("__scraperPath"), false);

  for (let index = 0; index < 105; index += 1) {
    cacheSet(
      cacheKey(["bounded", index]),
      { code: 200, data: { item_id: index } },
      10_000
    );
  }
  await flushDiskCacheWrites();
  assert.ok(cacheStats().size <= 100, "memory cache exceeded CACHE_MAX_ENTRIES");
  const beforePrune = (await readdir(cacheDir)).filter((name) => name.endsWith(".json"));
  assert.ok(beforePrune.length > 100, "disk fixture did not exceed the file limit");
  const oldest = join(cacheDir, beforePrune[0]);
  const oldestTime = new Date(Date.now() - 60_000);
  await utimes(oldest, oldestTime, oldestTime);
  const orphan = join(cacheDir, "interrupted-write.tmp");
  await writeFile(orphan, "partial", "utf8");
  const staleTemporaryTime = new Date(Date.now() - 120_000);
  await utimes(orphan, staleTemporaryTime, staleTemporaryTime);
  const pruned = await pruneDiskCache();
  assert.ok(pruned.files <= 100, "disk cache exceeded DISK_CACHE_MAX_FILES");
  const afterFilePrune = (await readdir(cacheDir)).filter((name) => name.endsWith(".json"));
  assert.ok(afterFilePrune.length <= 100, "actual disk file count exceeded the limit");
  await assert.rejects(access(oldest), (error) => error?.code === "ENOENT");
  await assert.rejects(
    access(orphan),
    (error) => error?.code === "ENOENT",
    "stale interrupted cache write was not pruned"
  );

  for (let index = 0; index < 12; index += 1) {
    cacheSet(
      cacheKey(["large", index]),
      { code: 200, data: { blob: "x".repeat(1024 * 1024) } },
      10_000
    );
  }
  await flushDiskCacheWrites();
  const bytePrune = await pruneDiskCache();
  const finalNames = (await readdir(cacheDir)).filter((name) => name.endsWith(".json"));
  const actualBytes = (
    await Promise.all(finalNames.map((name) => stat(join(cacheDir, name))))
  ).reduce((sum, info) => sum + info.size, 0);
  assert.ok(bytePrune.bytes <= 10 * 1024 * 1024, "reported disk bytes exceeded the limit");
  assert.ok(actualBytes <= 10 * 1024 * 1024, "actual disk bytes exceeded the limit");
  console.log("disk cache metadata tests: OK");
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
