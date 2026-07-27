import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchBrowser } from "./browser.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
export const AUTH_PATH = resolve(ROOT, ".auth", "1688.json");

export async function hasSavedAuth() {
  try {
    await access(AUTH_PATH);
    return true;
  } catch {
    return false;
  }
}

function isLoggedInCookies(cookies) {
  const byName = new Map(
    cookies
      .filter((c) => String(c.domain || "").includes("1688.com"))
      .map((c) => [c.name, c.value])
  );

  // Real 1688 login sets this to "true"
  if (byName.get("__cn_logon__") === "true") return true;

  // Fallback markers sometimes present after full SSO
  const hasLid = cookies.some(
    (c) => c.name === "lid" && String(c.domain || "").includes("1688.com") && c.value
  );
  const hasCookie2 = cookies.some(
    (c) => c.name === "cookie2" && String(c.domain || "").includes("1688.com") && c.value
  );
  return hasLid && hasCookie2 && byName.get("__cn_logon__") !== "false";
}

async function verifySearchAccess(context) {
  const page = await context.newPage();
  try {
    await page.goto(
      "https://s.1688.com/selloffer/offer_search.htm?keywords=router&beginPage=1",
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    );
    await page.waitForTimeout(4000);

    return page.evaluate(() => {
      const href = location.href;
      const login = /login\.(taobao|1688)|havanalogin/i.test(href);
      const listLen = window.data?.offerV2Showed?.offerList?.length || 0;
      const hasCards = document.querySelectorAll('a[href*="detail.1688.com/offer"]').length > 0;
      return {
        ok: !login && (listLen > 0 || hasCards || /offer_search|selloffer/i.test(href)),
        login,
        href,
        listLen,
        title: document.title,
      };
    });
  } finally {
    await page.close();
  }
}

export async function login1688({ timeoutMs = 10 * 60_000 } = {}) {
  await mkdir(dirname(AUTH_PATH), { recursive: true });

  const browser = await launchBrowser({ headed: true });

  const rl = readline.createInterface({ input, output });

  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    console.error("");
    console.error("1) A browser window will open to 1688 login.");
    console.error("2) Complete login fully (QR / password) until you land on 1688.com.");
    console.error("3) Come back here and press Enter to save the session.");
    console.error("");

    await page.goto("https://login.1688.com/member/signin.htm", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Also open homepage after a bit so SSO can settle if user already logged in elsewhere
    const waitEnter = rl.question("Press Enter after you are fully logged into 1688… ");
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Login timed out.")), timeoutMs)
    );
    await Promise.race([waitEnter, timeout]);

    // Warm session on main site
    await page.goto("https://www.1688.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    }).catch(() => {});
    await page.waitForTimeout(2000);

    const cookies = await context.cookies();
    if (!isLoggedInCookies(cookies)) {
      const logon = cookies.find((c) => c.name === "__cn_logon__");
      throw new Error(
        `Still not logged into 1688 (__cn_logon__=${logon?.value ?? "missing"}). ` +
          "Make sure the browser shows your 1688 account (not just the Taobao login page), then run npm run login again."
      );
    }

    const check = await verifySearchAccess(context);
    if (!check.ok) {
      throw new Error(
        "Login cookies were saved-ish, but search still redirects to login. " +
          "Finish any extra verification in the browser, then run npm run login again."
      );
    }

    await context.storageState({ path: AUTH_PATH });
    console.error(`Saved verified session → ${AUTH_PATH}`);
    console.error(`Search check OK (offers on page: ${check.listLen})`);
    return AUTH_PATH;
  } finally {
    rl.close();
    await browser.close();
  }
}

export async function newAuthedContext(browser, options = {}) {
  const base = {
    locale: "zh-CN",
    extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    ...options,
  };

  if (await hasSavedAuth()) {
    return browser.newContext({ ...base, storageState: AUTH_PATH });
  }
  return browser.newContext(base);
}

export async function assertAuthLooksValid() {
  if (!(await hasSavedAuth())) return { ok: false, reason: "no auth file" };
  const { readFileSync } = await import("node:fs");
  const state = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  const ok = isLoggedInCookies(state.cookies || []);
  const logon = (state.cookies || []).find((c) => c.name === "__cn_logon__");
  return {
    ok,
    reason: ok ? "ok" : `__cn_logon__=${logon?.value ?? "missing"}`,
  };
}
