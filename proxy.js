import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CONFIG_PATH = resolve(ROOT, "proxy.config.json");

/**
 * @returns {{ enabled: boolean, provider?: string, proxyUrl?: string, server?: string, username?: string, password?: string }}
 */
export function loadProxyConfig() {
  if (process.env.PROXY_URL) {
    return { enabled: true, provider: "env", proxyUrl: process.env.PROXY_URL };
  }
  if (!existsSync(CONFIG_PATH)) {
    return { enabled: false };
  }
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      enabled: Boolean(cfg.enabled && (cfg.proxyUrl || cfg.server)),
      provider: cfg.provider || "custom",
      proxyUrl: cfg.proxyUrl,
      server: cfg.server,
      username: cfg.username,
      password: cfg.password,
    };
  } catch {
    return { enabled: false };
  }
}

/**
 * Playwright proxy option, or undefined when disabled.
 * @returns {{ server: string, username?: string, password?: string } | undefined}
 */
export function getPlaywrightProxy() {
  const cfg = loadProxyConfig();
  if (!cfg.enabled) return undefined;

  if (cfg.server) {
    return {
      server: cfg.server,
      ...(cfg.username ? { username: cfg.username } : {}),
      ...(cfg.password ? { password: cfg.password } : {}),
    };
  }

  if (!cfg.proxyUrl) return undefined;

  try {
    const u = new URL(cfg.proxyUrl);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
    const out = { server };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: cfg.proxyUrl };
  }
}

export function proxyStatus() {
  const cfg = loadProxyConfig();
  const pw = getPlaywrightProxy();
  return {
    enabled: Boolean(pw),
    provider: cfg.provider || null,
    server: pw?.server || null,
    hasAuth: Boolean(pw?.username),
  };
}
