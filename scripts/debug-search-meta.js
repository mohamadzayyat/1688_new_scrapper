import { chromium } from "playwright";

const keyword = process.argv[2] || "router";
const pageNo = Number(process.argv[3] || 1);

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

await page.goto(
  `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&beginPage=${pageNo}`,
  { waitUntil: "domcontentloaded", timeout: 60_000 }
);

// poll until offer list appears
let meta = null;
for (let i = 0; i < 40; i++) {
  meta = await page.evaluate(() => {
    const d = window.data || {};
    const list =
      d.offerV2Showed?.offerList ||
      d.offerresultData?.data?.offerList ||
      d.offerV2?.response?.data?.offerList ||
      [];
    return {
      ready: Array.isArray(list) && list.length > 0,
      count: Array.isArray(list) ? list.length : 0,
      offerresultData: d.offerresultData || null,
      pageConfigData: d.pageConfigData || null,
      requestData: d.requestData || null,
      ab: d.abResultData
        ? {
            keywords: d.abResultData.keywords,
            totalCount: d.abResultData.totalCount,
            totalPage: d.abResultData.totalPage,
            pageSize: d.abResultData.pageSize,
            beginPage: d.abResultData.beginPage,
            keys: Object.keys(d.abResultData).slice(0, 40),
          }
        : null,
      offerV2ShowedMeta: d.offerV2Showed
        ? Object.fromEntries(
            Object.entries(d.offerV2Showed).filter(([k, v]) => typeof v !== "object" || v == null)
          )
        : null,
      offerV2ShowedKeys: d.offerV2Showed ? Object.keys(d.offerV2Showed) : [],
    };
  });
  if (meta.ready) break;
  await page.waitForTimeout(500);
}

console.log(JSON.stringify(meta, null, 2).slice(0, 10000));
await browser.close();
