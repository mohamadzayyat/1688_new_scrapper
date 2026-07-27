import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { launchBrowser } from "../browser.js";
import { AUTH_PATH, isLoggedInCookies } from "../auth.js";

const timeoutMs = Math.max(
  60_000,
  Number(process.env.LOGIN_TIMEOUT_MS) || 10 * 60_000
);
const screenshotPath = resolve(
  process.env.LOGIN_SCREENSHOT || "/tmp/1688-login.png"
);

await mkdir(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
await mkdir(dirname(screenshotPath), { recursive: true });

const browser = await launchBrowser({ headed: false });
try {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  await page.goto("https://login.1688.com/member/signin.htm", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const deadline = Date.now() + timeoutMs;
  console.log(`LOGIN_SCREENSHOT=${screenshotPath}`);
  console.log("Waiting for the 1688 QR login to complete...");

  for (;;) {
    const cookies = await context.cookies();
    if (isLoggedInCookies(cookies)) {
      await page
        .goto("https://www.1688.com/", {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        })
        .catch(() => {});
      await context.storageState({ path: AUTH_PATH });
      await chmod(AUTH_PATH, 0o600).catch(() => {});
      await unlink(screenshotPath).catch(() => {});
      console.log(`LOGIN_SAVED=${AUTH_PATH}`);
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Login timed out after ${timeoutMs}ms`);
    }
    const refreshed = await page
      .evaluate(() => {
        const bodyText = document.body?.innerText || "";
        if (!/二维码已失效|QR code.*expired/i.test(bodyText)) return false;
        const control = [...document.querySelectorAll("button,a,div,span")].find(
          (element) => /刷新二维码|refresh.*QR/i.test(element.textContent || "")
        );
        control?.click();
        return Boolean(control);
      })
      .catch(() => false);
    if (refreshed) await page.waitForTimeout(1_000);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.waitForTimeout(5_000);
  }
} finally {
  await browser.close().catch(() => {});
}
