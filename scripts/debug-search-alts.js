import { chromium } from "playwright";

const keyword = process.argv[2] || "router";
const urls = [
  `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&beginPage=1`,
  `https://search.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&beginPage=1`,
  `https://m.1688.com/offer_search/-${Buffer.from(keyword, "utf8").toString("hex")}.html`,
  `https://m.1688.com/offer_search.html?keywords=${encodeURIComponent(keyword)}`,
];

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

for (const url of urls) {
  const context = await browser.newContext({
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(5000);
    const info = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const d = window.data || {};
      return {
        title: document.title,
        href: location.href,
        login: /密码登录|短信登录|扫码登录/.test(text),
        hasData: Boolean(window.data),
        listLen: d.offerV2Showed?.offerList?.length || 0,
        dataKeys: Object.keys(d).slice(0, 20),
        snippet: text.slice(0, 120).replace(/\s+/g, " "),
      };
    });
    console.log(JSON.stringify({ url, ...info }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ url, error: e.message }));
  }
  await context.close();
}

await browser.close();
