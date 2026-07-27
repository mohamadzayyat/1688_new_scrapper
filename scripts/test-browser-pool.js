import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserPool } from "../browser.js";

class FakeBrowser extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.connected = true;
  }

  isConnected() {
    return this.connected;
  }

  async close() {
    if (!this.connected) return;
    this.connected = false;
    this.emit("disconnected");
  }
}

function fakeFactory({ launchDelayMs = 5 } = {}) {
  let created = 0;
  let launching = 0;
  let maxLaunching = 0;
  return {
    async create() {
      launching += 1;
      maxLaunching = Math.max(maxLaunching, launching);
      await delay(launchDelayMs);
      launching -= 1;
      created += 1;
      return new FakeBrowser(created);
    },
    stats() {
      return { created, maxLaunching };
    },
  };
}

async function testSharedWarmPromise() {
  const factory = fakeFactory({ launchDelayMs: 15 });
  const pool = new BrowserPool(3, {
    warmSize: 3,
    acquireTimeoutMs: 500,
    createBrowser: () => factory.create(),
  });

  const warms = Array.from({ length: 20 }, () => pool.ensureWarm());
  assert.ok(warms.every((promise) => promise === warms[0]));
  await Promise.all(warms);
  assert.equal(pool.snapshot().live, 3);
  assert.equal(factory.stats().created, 3);
  assert.ok(factory.stats().maxLaunching <= 3);
  await pool.close();
}

async function testWarmFailureCanRetry() {
  let attempts = 0;
  const pool = new BrowserPool(2, {
    warmSize: 2,
    acquireTimeoutMs: 500,
    createBrowser: async () => {
      attempts += 1;
      const attempt = attempts;
      await delay(attempt === 1 ? 5 : 20);
      if (attempt === 1) throw new Error("simulated launch failure");
      return new FakeBrowser(attempt);
    },
  });

  await assert.rejects(pool.ensureWarm(), /simulated launch failure/);
  assert.equal(pool.snapshot().creating, 0);
  await pool.ensureWarm();
  assert.equal(pool.snapshot().live, 2);
  assert.equal(pool.snapshot().createFailures, 1);
  await pool.close();
}

async function testAcquireTimeout() {
  const factory = fakeFactory();
  const pool = new BrowserPool(1, {
    warmSize: 1,
    acquireTimeoutMs: 100,
    createBrowser: () => factory.create(),
  });

  const leased = await pool.acquire();
  await assert.rejects(pool.acquire(), (err) => {
    assert.equal(err.code, 439);
    assert.equal(err.browserAcquireTimeout, true);
    return true;
  });
  assert.equal(pool.snapshot().acquireTimeouts, 1);
  pool.release(leased);
  await pool.close();
}

async function testDisconnectReplacesForWaiter() {
  const factory = fakeFactory();
  const pool = new BrowserPool(1, {
    warmSize: 1,
    acquireTimeoutMs: 500,
    createBrowser: () => factory.create(),
  });

  const first = await pool.acquire();
  const waiting = pool.acquire();
  await delay(10);
  await first.close();
  const replacement = await waiting;

  assert.notEqual(replacement, first);
  assert.equal(replacement.isConnected(), true);
  assert.equal(pool.snapshot().live, 1);
  assert.equal(pool.snapshot().disconnects, 1);
  assert.equal(factory.stats().created, 2);
  pool.release(replacement);
  await pool.close();
}

async function testCapacityNeverExceeded() {
  const factory = fakeFactory({ launchDelayMs: 10 });
  const pool = new BrowserPool(2, {
    warmSize: 0,
    acquireTimeoutMs: 1_000,
    createBrowser: () => factory.create(),
  });
  let active = 0;
  let maxActive = 0;

  await Promise.all(
    Array.from({ length: 12 }, async () => {
      const browser = await pool.acquire();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active -= 1;
      pool.release(browser);
    })
  );

  assert.equal(factory.stats().created, 2);
  assert.ok(factory.stats().maxLaunching <= 2);
  assert.ok(maxActive <= 2);
  assert.equal(pool.snapshot().live, 2);
  await pool.close();
}

async function testCloseRejectsWaitersAndIsIdempotent() {
  const factory = fakeFactory();
  const pool = new BrowserPool(1, {
    warmSize: 1,
    acquireTimeoutMs: 500,
    createBrowser: () => factory.create(),
  });

  await pool.acquire();
  const waiting = pool.acquire();
  await delay(10);
  const firstClose = pool.close();
  const secondClose = pool.close();
  assert.equal(firstClose, secondClose);
  await assert.rejects(waiting, (err) => err.code === 503 && err.poolClosed);
  await firstClose;
  assert.equal(pool.snapshot().closed, true);
  assert.equal(pool.snapshot().live, 0);
  await assert.rejects(pool.acquire(), (err) => err.code === 503);
}

const tests = [
  testSharedWarmPromise,
  testWarmFailureCanRetry,
  testAcquireTimeout,
  testDisconnectReplacesForWaiter,
  testCapacityNeverExceeded,
  testCloseRejectsWaitersAndIsIdempotent,
];

for (const test of tests) {
  await test();
  console.log(`OK ${test.name}`);
}

console.log(`${tests.length}/${tests.length} browser pool tests passed`);
