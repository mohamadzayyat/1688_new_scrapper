import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const keyword = process.argv[2] || "router";
const pageNo = Number(process.argv[3] || 1);
const hits = [];

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
});
const page = await context.newPage();

page.on("response", async (res) => {
  try {
    const url = res.url();
    if (!/search|offer|mtop|tpp|ajax/i.test(url)) return;
    if (!/json|javascript|text/i.test(res.headers()["content-type"] || "")) return;
    const text = await res.text();
    if (!/offerId/.test(text)) return;
    hits.push({
      status: res.status(),
      url: url.slice(0, 300),
      len: text.length,
      snip: text.slice(0, 400),
    });
  } catch {}
});

await page.goto(
  `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&beginPage=${pageNo}`,
  { waitUntil: "networkidle", timeout: 90_000 }
).catch(() => {});

await page.waitForTimeout(8000);

const pageState = await page.evaluate(() => {
  const d = window.data || {};
  return {
    title: document.title,
    bodyStart: (document.body?.innerText || "").slice(0, 200),
    hasData: Boolean(window.data),
    dataKeys: Object.keys(d),
    listLen: d.offerV2Showed?.offerList?.length || 0,
  };
});

await writeFile(
  "output/debug-search-network.json",
  JSON.stringify({ pageState, hits }, null, 2)
);
console.log(JSON.stringify({ pageState, hitCount: hits.length, hits: hits.slice(0, 8) }, null, 2));
await browser.close();
