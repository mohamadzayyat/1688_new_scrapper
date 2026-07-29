/**
 * Concurrent job runner with queue - replaces single global scrape lock.
 * Tuned for interactive users sharing a browser pool.
 *
 * Env:
 *   BROWSER_POOL_SIZE shared Chromium workers (default 8)
 *   MAX_CONCURRENT   parallel scrapes (default BROWSER_POOL_SIZE)
 *   MAX_QUEUE        waiting requests before 439 (default 64)
 *   MAX_SERIAL_WAITERS bounded category-stream waiters (default MAX_QUEUE)
 *   MAX_SERIAL_WAITERS_PER_KEY per-query waiters (default 16)
 *   QUEUE_TIMEOUT_MS max wait in queue (default 15000)
 */
import { jobAbortError } from "./jobContext.js";

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
const MAX_SERIAL_WAITERS = envInteger("MAX_SERIAL_WAITERS", MAX_QUEUE, {
  min: 0,
  max: 10_000,
});
const MAX_SERIAL_WAITERS_PER_KEY = envInteger(
  "MAX_SERIAL_WAITERS_PER_KEY",
  Math.min(16, Math.max(1, MAX_SERIAL_WAITERS)),
  { min: 0, max: 10_000 }
);
const QUEUE_TIMEOUT_MS = envInteger("QUEUE_TIMEOUT_MS", 15_000, {
  min: 1_000,
  max: 600_000,
});

let active = 0;
const queue = []; // { label, run, resolve, reject, enqueuedAt, priority, sequence }
let sequence = 0;
let accepted = 0;
let completed = 0;
let rejected = 0;
let timedOut = 0;
let cancelled = 0;

// Some paginated sources build a shared merge state and must execute in order.
// Keep those waiters in an explicit removable queue: promise-tail chaining keeps
// cancelled nodes alive and can bypass the main queue's admission bound.
const serialStates = new Map(); // key -> { waiters: Array<waiter> }
let serialWaiting = 0;
let serialRejected = 0;
let serialCancelled = 0;

function serialQueueError(message) {
  const error = new Error(message);
  error.code = 439;
  error.queueFull = true;
  return error;
}

function releaseSerialTurn(key, state) {
  const next = state.waiters.shift();
  if (next) {
    serialWaiting -= 1;
    if (next.onAbort) {
      next.signal?.removeEventListener("abort", next.onAbort);
      next.onAbort = null;
    }
    next.resolve(makeSerialRelease(key, state));
    return;
  }
  if (serialStates.get(key) === state) serialStates.delete(key);
}

function makeSerialRelease(key, state) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSerialTurn(key, state);
  };
}

function acquireSerialTurn(key, signal) {
  if (signal?.aborted) return Promise.reject(jobAbortError(signal));
  let state = serialStates.get(key);
  if (!state) {
    state = { waiters: [] };
    serialStates.set(key, state);
    return Promise.resolve(makeSerialRelease(key, state));
  }

  if (
    serialWaiting >= MAX_SERIAL_WAITERS ||
    state.waiters.length >= MAX_SERIAL_WAITERS_PER_KEY
  ) {
    serialRejected += 1;
    return Promise.reject(
      serialQueueError(
        `Serialized scrape queue full (${MAX_SERIAL_WAITERS} global, ` +
          `${MAX_SERIAL_WAITERS_PER_KEY} per query). Retry shortly.`
      )
    );
  }

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    state.waiters.push(waiter);
    serialWaiting += 1;
    if (!signal) return;
    waiter.onAbort = () => {
      const index = state.waiters.indexOf(waiter);
      if (index < 0) return;
      state.waiters.splice(index, 1);
      serialWaiting -= 1;
      serialCancelled += 1;
      signal.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = null;
      reject(jobAbortError(signal));
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal.aborted) waiter.onAbort();
  });
}

/**
 * Serialize work sharing a mutable upstream stream without bypassing queue
 * admission limits. Cancelled waiters are removed immediately.
 */
export async function runSerializedJob(key, run, { signal } = {}) {
  if (!key) return run();
  const release = await acquireSerialTurn(String(key), signal);
  try {
    if (signal?.aborted) throw jobAbortError(signal);
    return await run();
  } finally {
    release();
  }
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.onAbort) {
      job.signal?.removeEventListener("abort", job.onAbort);
      job.onAbort = null;
    }
    active += 1;
    accepted += 1;
    job.onStart?.(Math.max(0, Date.now() - job.enqueuedAt));
    Promise.resolve()
      .then(() => {
        if (job.signal?.aborted) {
          cancelled += 1;
          throw jobAbortError(job.signal);
        }
        return job.run();
      })
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
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export function enqueueJob(label, run, { signal, priority = 0, onStart } = {}) {
  if (signal?.aborted) return Promise.reject(jobAbortError(signal));
  if (active < MAX_CONCURRENT && queue.length === 0) {
    active += 1;
    accepted += 1;
    onStart?.(0);
    return Promise.resolve()
      .then(() => {
        if (signal?.aborted) {
          cancelled += 1;
          throw jobAbortError(signal);
        }
        return run();
      })
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
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      sequence: sequence++,
      onStart,
      signal,
      onAbort: null,
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
        job.reject(err);
        pump();
      }
    }, QUEUE_TIMEOUT_MS);

    const origResolve = resolve;
    const origReject = reject;
    const cleanup = () => {
      clearTimeout(timer);
      if (job.onAbort) signal?.removeEventListener("abort", job.onAbort);
    };
    job.resolve = (value) => {
      cleanup();
      origResolve(value);
    };
    job.reject = (err) => {
      cleanup();
      origReject(err);
    };

    // Interactive product detail requests may jump ahead of bulk search/shop
    // work, while FIFO ordering remains stable within the same priority.
    const insertAt = queue.findIndex(
      (waiting) => waiting.priority < job.priority
    );
    if (insertAt < 0) queue.push(job);
    else queue.splice(insertAt, 0, job);
    if (signal) {
      job.onAbort = () => {
        const idx = queue.indexOf(job);
        if (idx < 0) return;
        queue.splice(idx, 1);
        cancelled += 1;
        job.reject(jobAbortError(signal));
        pump();
      };
      signal.addEventListener("abort", job.onAbort, { once: true });
      if (signal.aborted) job.onAbort();
    }
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
    cancelled,
    serialized: {
      activeKeys: serialStates.size,
      waiting: serialWaiting,
      maxWaiting: MAX_SERIAL_WAITERS,
      maxWaitingPerKey: MAX_SERIAL_WAITERS_PER_KEY,
      rejected: serialRejected,
      cancelled: serialCancelled,
    },
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
