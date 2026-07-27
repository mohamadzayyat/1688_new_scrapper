/**
 * Shared Chromium pool - reuse browsers instead of launch/close per request.
 * Biggest latency + RAM win under multi-user load.
 */
import { chromium } from "playwright";
import { getPlaywrightProxy, proxyStatus } from "./proxy.js";
import {
  bindContextToJob,
  currentJobSignal,
  jobAbortError,
  throwIfJobAborted,
} from "./jobContext.js";

function envInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const POOL_SIZE = envInteger("BROWSER_POOL_SIZE", 8, { min: 1, max: 64 });
const WARM_SIZE = Math.min(
  POOL_SIZE,
  envInteger("BROWSER_WARM_SIZE", Math.min(2, POOL_SIZE), {
    min: 0,
    max: 64,
  })
);
const ACQUIRE_TIMEOUT_MS = envInteger("BROWSER_ACQUIRE_TIMEOUT_MS", 15_000, {
  min: 100,
  max: 300_000,
});

function launchArgs() {
  return [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
  ];
}

async function createChromium({ headed = false } = {}) {
  const proxy = getPlaywrightProxy();
  return chromium.launch({
    headless: !headed,
    args: launchArgs(),
    ...(proxy ? { proxy } : {}),
  });
}

class BrowserPool {
  constructor(
    size,
    {
      warmSize = Math.min(2, size),
      acquireTimeoutMs = 15_000,
      createBrowser = createChromium,
    } = {}
  ) {
    const parsedSize = Number(size);
    const parsedWarmSize = Number(warmSize);
    const parsedAcquireTimeout = Number(acquireTimeoutMs);
    this.size = Number.isFinite(parsedSize)
      ? Math.max(1, Math.trunc(parsedSize))
      : 1;
    this.warmSize = Math.min(
      this.size,
      Number.isFinite(parsedWarmSize)
        ? Math.max(0, Math.trunc(parsedWarmSize))
        : Math.min(2, this.size)
    );
    this.acquireTimeoutMs = Number.isFinite(parsedAcquireTimeout)
      ? Math.max(100, Math.trunc(parsedAcquireTimeout))
      : 15_000;
    this.createBrowser = createBrowser;
    this.browsers = []; // { browser, busy }
    this.waitQueue = [];
    this.creating = 0;
    this.creationDone = new Set();
    this.warmPromise = null;
    this.closePromise = null;
    this.closing = false;
    this.closed = false;
    this.stats = {
      created: 0,
      createFailures: 0,
      acquires: 0,
      acquireTimeouts: 0,
      releases: 0,
      waits: 0,
      disconnects: 0,
    };
  }

  _poolClosedError() {
    const err = new Error("Chromium pool is shutting down");
    err.code = 503;
    err.poolClosed = true;
    return err;
  }

  _acquireTimeoutError() {
    const err = new Error(
      `Timed out waiting ${this.acquireTimeoutMs}ms for a Chromium worker`
    );
    err.code = 439;
    err.browserAcquireTimeout = true;
    return err;
  }

  async _waitUntil(promise, deadline, signal = null) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw this._acquireTimeoutError();
    if (signal?.aborted) throw jobAbortError(signal);

    let timer;
    let onAbort;
    try {
      const waits = [
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(this._acquireTimeoutError()),
            remaining
          );
        }),
      ];
      if (signal) {
        waits.push(
          new Promise((_, reject) => {
            onAbort = () => reject(jobAbortError(signal));
            signal.addEventListener("abort", onAbort, { once: true });
          })
        );
      }
      return await Promise.race(waits);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  ensureWarm() {
    if (this.closing || this.closed) {
      return Promise.reject(this._poolClosedError());
    }
    if (this.warmPromise) return this.warmPromise;

    const attempt = this._warm();
    const shared = attempt.catch((err) => {
      if (this.warmPromise === shared && !this.closing) {
        // Let a later acquisition retry a failed warm-up.
        this.warmPromise = null;
      }
      throw err;
    });
    this.warmPromise = shared;
    return shared;
  }

  async _warm() {
    const status = proxyStatus();
    if (status.enabled) {
      console.error(
        `[proxy] ${status.provider || "custom"} -> ${status.server}` +
          (status.hasAuth ? " (auth)" : "")
      );
    }
    console.error(
      `[pool] warming ${this.warmSize}/${this.size} Chromium worker(s)...`
    );
    const missing = Math.max(
      0,
      this.warmSize - this.browsers.length - this.creating
    );
    const results = await Promise.allSettled(
      Array.from({ length: missing }, () => this._createBrowser())
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    console.error(`[pool] ready (${this.browsers.length}/${this.size})`);
  }

  async _createBrowser() {
    if (this.closing || this.closed) throw this._poolClosedError();
    if (this.browsers.length + this.creating >= this.size) return null;

    // This increment happens before the first await, making the capacity check
    // safe across concurrent warm-up, acquisition, and replacement calls.
    this.creating += 1;
    let markDone;
    const done = new Promise((resolve) => {
      markDone = resolve;
    });
    this.creationDone.add(done);

    try {
      const browser = await this.createBrowser({ headed: false });
      if (this.closing || this.closed) {
        await browser.close().catch(() => {});
        throw this._poolClosedError();
      }
      if (!browser.isConnected()) {
        await browser.close().catch(() => {});
        throw new Error("Chromium disconnected during launch");
      }

      const entry = { browser, busy: false };
      this.browsers.push(entry);
      this.stats.created += 1;
      browser.on("disconnected", () => this._handleDisconnected(entry));
      return entry;
    } catch (err) {
      if (!err?.poolClosed) this.stats.createFailures += 1;
      throw err;
    } finally {
      this.creating -= 1;
      this.creationDone.delete(done);
      markDone();
    }
  }

  _handleDisconnected(entry) {
    const idx = this.browsers.indexOf(entry);
    if (idx < 0) return;
    this.browsers.splice(idx, 1);
    this.stats.disconnects += 1;
    if (!this.closing && !this.closed) {
      this.warmPromise = null;
      this._dispatchWaiters();
      if (this.browsers.length + this.creating < this.warmSize) {
        void this.ensureWarm().catch((error) => {
          console.error(`[pool] replacement warm failed: ${error?.message || error}`);
        });
      }
    }
  }

  _nextWaiter() {
    while (this.waitQueue.length) {
      const waiter = this.waitQueue.shift();
      if (!waiter.settled) return waiter;
    }
    return null;
  }

  _settleWaiter(waiter, { browser, error } = {}) {
    if (!waiter || waiter.settled) return false;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = null;
    }
    if (error) waiter.reject(error);
    else waiter.resolve(browser);
    return true;
  }

  _dispatchWaiters() {
    if (this.closing || this.closed) return;

    // Reuse live idle workers before launching replacements.
    for (;;) {
      const free = this.browsers.find(
        (entry) => !entry.busy && entry.browser.isConnected()
      );
      if (!free) break;
      const waiter = this._nextWaiter();
      if (!waiter) break;
      free.busy = true;
      this._settleWaiter(waiter, { browser: free.browser });
    }

    // Fill only enough vacant slots to serve current waiters. _createBrowser
    // reserves capacity synchronously, so repeated dispatches cannot overshoot.
    while (
      this.waitQueue.some((waiter) => !waiter.settled) &&
      this.browsers.length + this.creating < this.size
    ) {
      void this._createBrowser()
        .then((entry) => {
          if (!entry || this.closing || this.closed) return;
          const waiter = this._nextWaiter();
          if (waiter) {
            entry.busy = true;
            this._settleWaiter(waiter, { browser: entry.browser });
          }
        })
        .catch((err) => {
          if (this.closing || this.closed) return;
          const waiter = this._nextWaiter();
          if (waiter) this._settleWaiter(waiter, { error: err });
        })
        .finally(() => this._dispatchWaiters());
    }
  }

  async acquire({ signal = null } = {}) {
    this.stats.acquires += 1;
    if (this.closing || this.closed) throw this._poolClosedError();
    if (signal?.aborted) throw jobAbortError(signal);

    const deadline = Date.now() + this.acquireTimeoutMs;
    try {
      await this._waitUntil(this.ensureWarm(), deadline, signal);
    } catch (err) {
      if (err?.browserAcquireTimeout) this.stats.acquireTimeouts += 1;
      throw err;
    }

    const free = this.browsers.find(
      (entry) => !entry.busy && entry.browser.isConnected()
    );
    if (free) {
      if (signal?.aborted) throw jobAbortError(signal);
      free.busy = true;
      return free.browser;
    }

    this.stats.waits += 1;
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        settled: false,
        at: Date.now(),
        timer: null,
        signal,
        onAbort: null,
      };
      const remaining = Math.max(0, deadline - Date.now());
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        const idx = this.waitQueue.indexOf(waiter);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        this.stats.acquireTimeouts += 1;
        this._settleWaiter(waiter, { error: this._acquireTimeoutError() });
        this._dispatchWaiters();
      }, remaining);
      this.waitQueue.push(waiter);
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.waitQueue.indexOf(waiter);
          if (idx >= 0) this.waitQueue.splice(idx, 1);
          this._settleWaiter(waiter, { error: jobAbortError(signal) });
          this._dispatchWaiters();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) waiter.onAbort();
      }
      this._dispatchWaiters();
    });
  }

  release(browser) {
    this.stats.releases += 1;
    const entry = this.browsers.find((item) => item.browser === browser);
    if (!entry) {
      if (!this.closing && !this.closed) this._dispatchWaiters();
      return;
    }
    if (!browser.isConnected()) {
      this._handleDisconnected(entry);
      return;
    }
    entry.busy = false;
    this._dispatchWaiters();
  }

  close() {
    if (this.closePromise) return this.closePromise;

    this.closing = true;
    const closedError = this._poolClosedError();
    for (const waiter of this.waitQueue.splice(0)) {
      this._settleWaiter(waiter, { error: closedError });
    }

    this.closePromise = (async () => {
      // Launches already in progress close themselves when they observe the
      // shutdown flag. Wait for them before taking the final live snapshot.
      await Promise.allSettled([...this.creationDone]);
      const entries = this.browsers.splice(0);
      await Promise.allSettled(
        entries.map(({ browser }) => browser.close().catch(() => {}))
      );
      this.closed = true;
      this.closing = false;
    })();
    return this.closePromise;
  }

  snapshot() {
    return {
      size: this.size,
      live: this.browsers.length,
      busy: this.browsers.filter((entry) => entry.busy).length,
      waiting: this.waitQueue.length,
      creating: this.creating,
      warmSize: this.warmSize,
      acquireTimeoutMs: this.acquireTimeoutMs,
      closing: this.closing,
      closed: this.closed,
      ...this.stats,
    };
  }
}

const pool = new BrowserPool(POOL_SIZE, {
  warmSize: WARM_SIZE,
  acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
});

/**
 * One-off browser (scripts / headed login). Caller MUST close().
 */
export async function launchBrowser({ headed = false } = {}) {
  const status = proxyStatus();
  if (status.enabled) {
    console.error(
      `[proxy] ${status.provider || "custom"} -> ${status.server}` +
        (status.hasAuth ? " (auth)" : "")
    );
  }
  return createChromium({ headed });
}

/**
 * Checkout a pooled headless browser. MUST releaseBrowser() in finally.
 * Do NOT call browser.close() - that destroys the pool worker.
 */
export async function acquirePooledBrowser() {
  throwIfJobAborted();
  const signal = currentJobSignal();
  const browser = await pool.acquire({ signal });
  if (currentJobSignal()?.aborted) {
    pool.release(browser);
    throw jobAbortError(currentJobSignal());
  }
  return browser;
}

export function releaseBrowser(browser) {
  pool.release(browser);
}

/**
 * Pooled headless browser. Never close - always released back to pool.
 */
export async function withBrowser(fn) {
  const browser = await pool.acquire();
  try {
    return await fn(browser);
  } finally {
    pool.release(browser);
  }
}

/**
 * Lean context: block images/fonts/media + trackers for speed.
 * Set blockAssets:false when images are required.
 * Set documentOnly:true to abort everything except the main HTML document
 * (item detail fast-path - data is embedded in window.context IIFE).
 */
export async function newFastContext(browser, options = {}) {
  const { blockAssets = true, documentOnly = false, ...rest } = options;
  const context = await browser.newContext({
    serviceWorkers: "block",
    ...rest,
  });

  try {
    await bindContextToJob(context);
    if (documentOnly) {
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "document") return route.continue();
        return route.abort();
      });
      return context;
    }

    if (blockAssets) {
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") {
          return route.abort();
        }
        const url = route.request().url();
        if (
          /google-analytics|googletagmanager|doubleclick|facebook\.net|hm\.baidu/i.test(
            url
          )
        ) {
          return route.abort();
        }
        return route.continue();
      });
    }

    return context;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export function browserPoolStats() {
  return pool.snapshot();
}

export async function warmBrowserPool() {
  return pool.ensureWarm();
}

/** Stop accepting acquisitions and close every pooled Chromium process. */
export async function closeBrowserPool() {
  return pool.close();
}

export { ACQUIRE_TIMEOUT_MS, BrowserPool, POOL_SIZE, WARM_SIZE };
