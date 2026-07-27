import { launchBrowser } from "../browser.js";
import { writeFile } from "node:fs/promises";

const offerId = process.argv[2] || "874039857500";
const browser = await launchBrowser({ headed: false });
const context = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 1440, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
});
await context.addCookies([
  { name: "oversealanguage", value: "zh-CN", domain: ".1688.com", path: "/" },
]);
const page = await context.newPage();
await page.goto(`https://detail.1688.com/offer/${offerId}.html`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await page.waitForTimeout(8000);

const raw = await page.evaluate(() => {
  const data = window.context?.result?.data || {};
  const root = data.Root?.fields?.dataJson || {};
  const fieldsOf = (k) => data[k]?.fields || null;

  function summarize(obj, depth = 0) {
    if (obj == null || depth > 3) return typeof obj;
    if (Array.isArray(obj)) {
      return {
        type: "array",
        length: obj.length,
        sample: obj.slice(0, 1).map((x) => summarize(x, depth + 1)),
      };
    }
    if (typeof obj !== "object") return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "object" && v) {
        out[k] = Array.isArray(v)
          ? { type: "array", length: v.length }
          : { type: "object", keys: Object.keys(v).slice(0, 40) };
      } else out[k] = v;
    }
    return out;
  }

  // Walk for skuProps / featureAttributes / video
  const finds = {};
  function walk(obj, path = "", depth = 0) {
    if (!obj || depth > 7) return;
    if (Array.isArray(obj)) {
      if (path.match(/skuProp|skuProps|propsList|featureAttributes|productFeature/i) && obj.length) {
        finds[path] = { length: obj.length, sample: obj[0], keys: Object.keys(obj[0] || {}) };
      }
      return;
    }
    if (typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (/skuProp|featureAttr|video|mixAmount|priceRange|postCategory|rootCategory/i.test(k)) {
        finds[path ? `${path}.${k}` : k] = summarize(v);
      }
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  }
  walk(data);

  return {
    dataKeys: Object.keys(data),
    productTitle: summarize(fieldsOf("productTitle")),
    mainPrice: summarize(fieldsOf("mainPrice")),
    productAttributes: summarize(fieldsOf("productAttributes")),
    skuSelection: summarize(fieldsOf("skuSelection")),
    gallery: summarize(fieldsOf("gallery")),
    shopNavigation: summarize(fieldsOf("shopNavigation")),
    shippingServices: summarize(fieldsOf("shippingServices")),
    rootKeys: Object.keys(root),
    finds,
  };
});

await writeFile("output/tmapi-probe.json", JSON.stringify(raw, null, 2));
console.log(JSON.stringify({ dataKeys: raw.dataKeys, findsKeys: Object.keys(raw.finds), productAttributes: raw.productAttributes, skuSelection: raw.skuSelection }, null, 2));
console.log("\nFINDS SAMPLE:");
for (const [k, v] of Object.entries(raw.finds).slice(0, 20)) {
  console.log(k, JSON.stringify(v).slice(0, 300));
}
await browser.close();
