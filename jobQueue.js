/**
 * Concurrent job runner with queue - replaces single global scrape lock.
 * Tuned for interactive users sharing a browser pool.
 *
 * Env:
 *   BROWSER_POOL_SIZE shared Chromium workers (default 8)
 *   MAX_CONCURRENT   parallel scrapes (default BROWSER_POOL_SIZE)
 *   MAX_QUEUE        waiting requests before 439 (default 64)
 *   QUEUE_TIMEOUT_MS max wait in queue (default 15000)
 */
function envInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const DEFAULT_BROWSER_POOL_SIZE = envInteger("BROWSER_POOL_SIZE", 8, {
  min: 1,
  max: 64,
});
const MAX_CONCURRENT = envInteger(
  "MAX_CONCURRENT",
  DEFAULT_BROWSER_POOL_SIZE,
  { min: 1, max: 64 }
);
const MAX_QUEUE = envInteger("MAX_QUEUE", 64, { min: 0, max: 10_000 });
const QUEUE_TIMEOUT_MS = envInteger("QUEUE_TIMEOUT_MS", 15_000, {
  min: 1_000,
  max: 600_000,
});

let active = 0;
const queue = []; // { label, run, resolve, reject, enqueuedAt }
let accepted = 0;
let completed = 0;
let rejected = 0;
let timedOut = 0;

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active += 1;
    accepted += 1;
    Promise.resolve()
      .then(job.run)
      .then((result) => {
        completed += 1;
        job.resolve(result);
      })
      .catch((err) => {
        rejected += 1;
        job.reject(err);
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/**
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export function enqueueJob(label, run) {
  if (active < MAX_CONCURRENT && queue.length === 0) {
    active += 1;
    accepted += 1;
    return Promise.resolve()
      .then(run)
      .then((result) => {
        completed += 1;
        return result;
      })
      .catch((err) => {
        rejected += 1;
        throw err;
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }

  if (queue.length >= MAX_QUEUE) {
    const err = new Error(
      `Scrape queue full (${MAX_QUEUE}). Retry shortly - too many concurrent users.`
    );
    err.code = 439;
    err.queueFull = true;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const job = {
      label,
      run,
      resolve,
      reject,
      enqueuedAt: Date.now(),
    };
    const timer = setTimeout(() => {
      const idx = queue.indexOf(job);
      if (idx >= 0) {
        queue.splice(idx, 1);
        timedOut += 1;
        const err = new Error(
          `Queued scrape timed out after ${QUEUE_TIMEOUT_MS}ms. Server is busy - retry.`
        );
        err.code = 439;
        reject(err);
      }
    }, QUEUE_TIMEOUT_MS);

    const origResolve = resolve;
    const origReject = reject;
    job.resolve = (value) => {
      clearTimeout(timer);
      origResolve(value);
    };
    job.reject = (err) => {
      clearTimeout(timer);
      origReject(err);
    };

    queue.push(job);
    pump();
  });
}

export function jobQueueStats() {
  return {
    active,
    queued: queue.length,
    maxConcurrent: MAX_CONCURRENT,
    maxQueue: MAX_QUEUE,
    accepted,
    completed,
    rejected,
    timedOut,
  };
}

export function recommendedHardware() {
  // Rough guidance for approximately 90 interactive users.
  return {
    targetUsers: 90,
    maxConcurrent: MAX_CONCURRENT,
    maxQueue: MAX_QUEUE,
    suggest: {
      vcpu: "8-16",
      ramGb: "16-32",
      note:
        "Each scrape exclusively leases one Chromium worker. Keep MAX_CONCURRENT equal to BROWSER_POOL_SIZE unless the pool model changes. Prefer SSD plus residential proxy bandwidth.",
    },
  };
}
