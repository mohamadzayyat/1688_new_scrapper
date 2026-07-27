import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const port = 34_000 + Math.floor(Math.random() * 1_000);
const token = randomBytes(24).toString("hex");
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(port),
  SCRAPER_API_TOKEN: token,
  // Readiness accepts the configured proxy as the upstream access mechanism;
  // these compatibility probes never connect through this dummy endpoint.
  PROXY_URL: "http://127.0.0.1:9",
  BROWSER_POOL_SIZE: "1",
  BROWSER_WARM_SIZE: "1",
  DISK_CACHE: "0",
};
const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: "ignore",
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode != null) throw new Error("local server exited during startup");
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local compatibility server did not become ready");
}

async function assertProxyOnlyReadiness() {
  let readyResponse = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    readyResponse = await fetch(`${base}/ready`).catch(() => null);
    if (readyResponse?.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(readyResponse?.status, 200, "proxy-only server did not become ready");

  const healthResponse = await fetch(`${base}/health`, {
    headers: { "x-api-token": token },
  });
  const health = await healthResponse.json();
  assert.equal(health.ready, true);
  assert.equal(health.auth?.ok, false);
  assert.equal(health.upstream?.ready, true);
  assert.equal(health.upstream?.mode, "proxy");
  assert.equal(health.upstream?.proxy?.enabled, true);
  console.log("OK proxy-only readiness does not require a QR session");
}

try {
  await waitUntilReady();
  await assertProxyOnlyReadiness();
  const test = spawn(process.execPath, ["scripts/test-tmapi-compat.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...env, BASE: base, API_TOKEN: token },
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    test.once("error", reject);
    test.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode != null) return resolve();
    const force = setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 5_000);
    server.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}
