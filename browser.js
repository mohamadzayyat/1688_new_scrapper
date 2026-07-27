/**
 * Shared Chromium pool — reuse browsers instead of launch/close per request.
 * Biggest latency + RAM win under multi-user load.
 */
import { chromium } from "playwright";
import { getPlaywrightProxy, proxyStatus } from "./proxy.js";

const POOL_SIZE = Math.max(1, Number(process.env.BROWSER_POOL_SIZE) || 8);

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
  constructor(size) {
    this.size = size;
    this.browsers = []; // { browser, busy }
    this.waitQueue = [];
    this.started = false;
    this.creating = 0;
    this.stats = { created: 0, acquires: 0, releases: 0, waits: 0 };
  }

  async ensureWarm() {
    if (this.started) return;
    this.started = true;
    const status = proxyStatus();
    if (status.enabled) {
      console.error(
        `[proxy] ${status.provider || "custom"} → ${status.server}` +
          (status.hasAuth ? " (auth)" : "")
      );
    }
    console.error(`[pool] warming ${Math.min(2, this.size)}/${this.size} Chromium worker(s)…`);
    const warm = Math.min(2, this.size);
    await Promise.all(Array.from({ length: warm }, () => this._createBrowser()));
    console.error(`[pool] ready (${this.browsers.length}/${this.size})`);
  }

  async _createBrowser() {
    const browser = await createChromium({ headed: false });
    const entry = { browser, busy: false };
    this.browsers.push(entry);
    this.stats.created += 1;
    browser.on("disconnected", () => {
      const idx = this.browsers.indexOf(entry);
      if (idx >= 0) this.browsers.splice(idx, 1);
    });
    return entry;
  }

  async acquire() {
    await this.ensureWarm();
    this.stats.acquires += 1;

    for (;;) {
      const free = this.browsers.find((b) => !b.busy && b.browser.isConnected());
      if (free) {
        free.busy = true;
        return free.browser;
      }

      if (this.browsers.length + this.creating < this.size) {
        this.creating += 1;
        try {
          const entry = await this._createBrowser();
          entry.busy = true;
          return entry.browser;
        } finally {
          this.creating -= 1;
        }
      }

      this.stats.waits += 1;
      return new Promise((resolve) => {
        this.waitQueue.push({ resolve, at: Date.now() });
      });
    }
  }

  release(browser) {
    this.stats.releases += 1;
    const entry = this.browsers.find((b) => b.browser === browser);
    if (!entry) return;
    if (!browser.isConnected()) {
      const idx = this.browsers.indexOf(entry);
      if (idx >= 0) this.browsers.splice(idx, 1);
      if (this.waitQueue.length) {
        this._createBrowser()
          .then((e) => {
            e.busy = true;
            const next = this.waitQueue.shift();
            next?.resolve(e.browser);
          })
          .catch(() => {});
      }
      return;
    }
    if (this.waitQueue.length) {
      const next = this.waitQueue.shift();
      next.resolve(browser);
      return;
    }
    entry.busy = false;
  }

  snapshot() {
    return {
      size: this.size,
      live: this.browsers.length,
      busy: this.browsers.filter((b) => b.busy).length,
      waiting: this.waitQueue.length,
      ...this.stats,
    };
  }
}

const pool = new BrowserPool(POOL_SIZE);

/**
 * One-off browser (scripts / headed login). Caller MUST close().
 */
export async function launchBrowser({ headed = false } = {}) {
  const status = proxyStatus();
  if (status.enabled) {
    console.error(
      `[proxy] ${status.provider || "custom"} → ${status.server}` +
        (status.hasAuth ? " (auth)" : "")
    );
  }
  return createChromium({ headed });
}

/**
 * Checkout a pooled headless browser. MUST releaseBrowser() in finally.
 * Do NOT call browser.close() — that destroys the pool worker.
 */
export async function acquirePooledBrowser() {
  return pool.acquire();
}

export function releaseBrowser(browser) {
  pool.release(browser);
}

/**
 * Pooled headless browser. Never close — always released back to pool.
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
 * (item detail fast-path — data is embedded in window.context IIFE).
 */
export async function newFastContext(browser, options = {}) {
  const { blockAssets = true, documentOnly = false, ...rest } = options;
  const context = await browser.newContext(rest);

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
}

export function browserPoolStats() {
  return pool.snapshot();
}

export async function warmBrowserPool() {
  return pool.ensureWarm();
}

export { POOL_SIZE };
