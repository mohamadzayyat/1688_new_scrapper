import { launchBrowser } from "../browser.js";

const offerId = process.argv[2] || "874039857500";
const browser = await launchBrowser({ headed: false });
const page = await (await browser.newContext({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
})).newPage();
await page.goto(`https://detail.1688.com/offer/${offerId}.html`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await page.waitForTimeout(7000);

const info = await page.evaluate(() => {
  const root = window.context?.result?.data?.Root?.fields?.dataJson || {};
  const skuModel = root.skuModel || {};

  // deep find objects with vid
  const withVid = [];
  function walk(obj, path = "", depth = 0) {
    if (!obj || depth > 8) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 5); i++) walk(obj[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof obj !== "object") return;
    if (obj.vid != null || obj.valueId != null || obj.propertyValueId != null) {
      withVid.push({ path, obj });
    }
    for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k, depth + 1);
  }
  walk(window.context?.result?.data);

  return {
    skuPriceScale: skuModel.skuPriceScale,
    skuPriceScaleOriginal: skuModel.skuPriceScaleOriginal,
    withVidCount: withVid.length,
    withVidSample: withVid.slice(0, 8),
    descriptionFields: window.context?.result?.data?.description?.fields
      ? Object.keys(window.context.result.data.description.fields)
      : null,
  };
});

console.log(JSON.stringify(info, null, 2).slice(0, 5000));
await browser.close();
