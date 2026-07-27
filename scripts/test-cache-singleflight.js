import assert from "node:assert/strict";

process.env.DISK_CACHE = "0";
const { cached, cachedSwr, cacheClear, cacheSet } = await import("../cache.js");

cacheClear();

let resolveShared;
let sharedSignal;
let producerCalls = 0;
const producer = (signal) => {
  producerCalls += 1;
  sharedSignal = signal;
  return new Promise((resolve, reject) => {
    resolveShared = resolve;
    signal.addEventListener(
      "abort",
      () => {
        const error = new Error("producer aborted");
        error.code = 499;
        reject(error);
      },
      { once: true }
    );
  });
};

const firstController = new AbortController();
const secondController = new AbortController();
const first = cached("shared-key", 10_000, producer, {
  signal: firstController.signal,
});
const second = cached("shared-key", 10_000, producer, {
  signal: secondController.signal,
});
await new Promise((resolve) => setImmediate(resolve));

firstController.abort();
await assert.rejects(first, (error) => error?.code === 499);
assert.equal(sharedSignal.aborted, false, "one cancelled follower aborted shared work");
assert.equal(producerCalls, 1);

resolveShared({ code: 200, data: { item_id: 1 } });
assert.equal((await second).code, 200);

let soloAborted = false;
const soloController = new AbortController();
const solo = cached(
  "solo-key",
  10_000,
  (signal) =>
    new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          soloAborted = true;
          const error = new Error("solo producer aborted");
          error.code = 499;
          reject(error);
        },
        { once: true }
      );
    }),
  { signal: soloController.signal }
);
await new Promise((resolve) => setImmediate(resolve));
soloController.abort();
await assert.rejects(solo, (error) => error?.code === 499);
assert.equal(soloAborted, true, "last subscriber did not abort shared work");

const timeoutController = new AbortController();
const timeoutError = new Error("deadline reached");
timeoutError.code = 504;
const timed = cached(
  "timeout-key",
  10_000,
  (signal) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  { signal: timeoutController.signal }
);
await new Promise((resolve) => setImmediate(resolve));
timeoutController.abort(timeoutError);
await assert.rejects(
  timed,
  (error) => error === timeoutError && error.code === 504,
  "deadline reason was rewritten as a 499 cancellation"
);

let swallowedCalls = 0;
const swallowedController = new AbortController();
const swallowed = cached(
  "swallowed-abort-key",
  10_000,
  (signal) => {
    swallowedCalls += 1;
    return new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => resolve({ code: 200, data: { partial: true } }),
        { once: true }
      );
    });
  },
  { signal: swallowedController.signal }
);
await new Promise((resolve) => setImmediate(resolve));
swallowedController.abort();
await assert.rejects(swallowed, (error) => error?.code === 499);
await new Promise((resolve) => setImmediate(resolve));
const freshAfterAbort = await cached(
  "swallowed-abort-key",
  10_000,
  async () => {
    swallowedCalls += 1;
    return { code: 200, data: { partial: false } };
  }
);
assert.equal(swallowedCalls, 2, "aborted partial result was cached");
assert.equal(freshAfterAbort.data.partial, false);

let uncacheableCalls = 0;
for (let attempt = 0; attempt < 2; attempt += 1) {
  const uncacheable = await cached(
    "partial-translation-key",
    10_000,
    async () => {
      uncacheableCalls += 1;
      const response = { code: 200, data: { items: [{ item_id: "1" }] } };
      Object.defineProperty(response, "__scraperNoCache", {
        value: true,
        enumerable: false,
      });
      return response;
    }
  );
  assert.equal(uncacheable.code, 200);
}
assert.equal(uncacheableCalls, 2, "partial translation response was cached");

let rejectedCalls = 0;
await assert.rejects(
  cached("producer-retry-key", 10_000, async () => {
    rejectedCalls += 1;
    throw new Error("first producer failed");
  }),
  /first producer failed/
);
const recovered = await cached("producer-retry-key", 10_000, async () => {
  rejectedCalls += 1;
  return { code: 200, data: { recovered: true } };
});
assert.equal(rejectedCalls, 2, "rejected producer remained stuck in singleflight");
assert.equal(recovered.data.recovered, true);

const realNow = Date.now;
let fakeNow = realNow();
Date.now = () => fakeNow;
try {
  cacheSet("swr-refresh-key", { code: 200, data: { version: "old" } }, 100);
  fakeNow += 101;
  let resolveRefresh;
  let refreshCalls = 0;
  const stale = await cachedSwr(
    "swr-refresh-key",
    100,
    async () => {
      refreshCalls += 1;
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    }
  );
  assert.equal(stale.data.version, "old", "SWR did not return stale data immediately");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);
  resolveRefresh({ code: 200, data: { version: "new" } });
  await new Promise((resolve) => setImmediate(resolve));
  const refreshed = await cachedSwr("swr-refresh-key", 100, async () => {
    refreshCalls += 1;
    return { code: 200, data: { version: "unexpected" } };
  });
  assert.equal(refreshed.data.version, "new");
  assert.equal(refreshCalls, 1, "fresh SWR result started another producer");

  cacheSet("swr-failed-key", { code: 200, data: { version: "stale" } }, 100);
  fakeNow += 101;
  let failedRefreshCalls = 0;
  const failedProducer = async () => {
    failedRefreshCalls += 1;
    throw new Error("refresh failed");
  };
  assert.equal(
    (await cachedSwr("swr-failed-key", 100, failedProducer)).data.version,
    "stale"
  );
  await new Promise((resolve) => setImmediate(resolve));
  await cachedSwr("swr-failed-key", 100, failedProducer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failedRefreshCalls, 2, "failed SWR refresh blocked a later retry");

  cacheSet("swr-no-cache-key", { code: 200, data: { version: "stale" } }, 100);
  fakeNow += 101;
  let noCacheRefreshCalls = 0;
  const noCacheProducer = async () => {
    noCacheRefreshCalls += 1;
    const value = { code: 200, data: { version: "partial" } };
    Object.defineProperty(value, "__scraperNoCache", {
      value: true,
      enumerable: false,
    });
    return value;
  };
  await cachedSwr("swr-no-cache-key", 100, noCacheProducer);
  await new Promise((resolve) => setImmediate(resolve));
  await cachedSwr("swr-no-cache-key", 100, noCacheProducer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(noCacheRefreshCalls, 2, "uncacheable SWR refresh replaced stale data");
} finally {
  Date.now = realNow;
}

console.log("cache singleflight cancellation tests: OK");
