import { chromium } from "playwright";

const keyword = process.argv[2] || "router";
const pageNo = Number(process.argv[3] || 2);
const hex = Buffer.from(keyword, "utf8").toString("hex");
const url = `https://m.1688.com/offer_search/-${hex}.html?beginPage=${pageNo}`;

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  locale: "zh-CN",
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const text = document.body?.innerText || "";
  return {
    href: location.href,
    title: document.title,
    itemLinks: document.querySelectorAll("a.item-link").length,
    hasTotal: /共\s*[\d,+]+\s*件/.test(text),
    hasPasswordLogin: /密码登录/.test(text),
    hasScanLogin: /扫码登录/.test(text),
    hasCaptcha: /验证码/.test(text),
    hasPunish: /访问受限|punish/.test(text),
    snippet: text.slice(0, 600).replace(/\s+/g, " "),
  };
});

console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "output/debug-block.png" });
await browser.close();
