import { chromium } from "playwright";
import { getPlaywrightProxy, proxyStatus } from "./proxy.js";

/**
 * Launch Chromium with optional proxy from proxy.config.json / PROXY_URL.
 */
export async function launchBrowser({ headed = false } = {}) {
  const proxy = getPlaywrightProxy();
  const status = proxyStatus();
  if (status.enabled) {
    console.error(
      `[proxy] ${status.provider || "custom"} → ${status.server}` +
        (status.hasAuth ? " (auth)" : "")
    );
  }

  return chromium.launch({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
    ...(proxy ? { proxy } : {}),
  });
}
