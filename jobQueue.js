/**
 * Concurrent job runner with queue — replaces single global scrape lock.
 * Tuned for ~90 interactive users sharing a browser pool.
 *
 * Env:
 *   MAX_CONCURRENT   parallel scrapes (default 24)
 *   MAX_QUEUE        waiting requests before 439 (default 200)
 *   QUEUE_TIMEOUT_MS max wait in queue (default 120000)
 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT) || 24);
const MAX_QUEUE = Math.max(0, Number(process.env.MAX_QUEUE) || 200);
const QUEUE_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.QUEUE_TIMEOUT_MS) || 120_000
);

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
      `Scrape queue full (${MAX_QUEUE}). Retry shortly — too many concurrent users.`
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
          `Queued scrape timed out after ${QUEUE_TIMEOUT_MS}ms. Server is busy — retry.`
        );
        err.code = 439;
        reject(err);
      }
    }, QUEUE_TIMEOUT_MS);

    const origResolve = resolve;
    const origReject = reject;
    job.resolve = (v) => {
      clearTimeout(timer);
      origResolve(v);
    };
    job.reject = (e) => {
      clearTimeout(timer);
      origReject(e);
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
  // Rough guidance for ~90 interactive users
  return {
    targetUsers: 90,
    maxConcurrent: MAX_CONCURRENT,
    maxQueue: MAX_QUEUE,
    suggest: {
      vcpu: "8–16",
      ramGb: "16–32",
      note:
        "Each Chromium worker uses ~150–300MB. Size BROWSER_POOL_SIZE ≈ MAX_CONCURRENT/2–3. Prefer SSD + residential proxy bandwidth.",
    },
  };
}
