import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const keyword = process.argv[2] || "router";
const pageNo = Number(process.argv[3] || 1);

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await browser.newPage({
  locale: "zh-CN",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
});

const url =
  "https://s.1688.com/selloffer/offer_search.htm?keywords=" +
  encodeURIComponent(keyword) +
  "&beginPage=" +
  pageNo;

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(7000);

const info = await page.evaluate(() => {
  function summarize(obj, depth = 0) {
    if (obj == null || depth > 4) return typeof obj;
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
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  const data = window.data || {};
  const keys = Object.keys(data);

  // Find arrays that look like offer lists
  const offerArrays = [];
  function walk(obj, path = "", depth = 0) {
    if (!obj || depth > 6) return;
    if (Array.isArray(obj)) {
      if (
        obj.length &&
        obj[0] &&
        typeof obj[0] === "object" &&
        (obj[0].offerId || obj[0].id || obj[0].information || obj[0].title)
      ) {
        offerArrays.push({
          path,
          length: obj.length,
          sampleKeys: Object.keys(obj[0]).slice(0, 50),
          sample: obj[0],
        });
      }
      return;
    }
    if (typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      walk(v, path ? path + "." + k : k, depth + 1);
    }
  }
  walk(data);

  return {
    topKeys: keys,
    summary: summarize(data),
    offerArrays: offerArrays.map((a) => ({
      path: a.path,
      length: a.length,
      sampleKeys: a.sampleKeys,
      sample: a.sample,
    })),
  };
});

await writeFile("output/debug-search-data.json", JSON.stringify(info, null, 2));
console.log(
  JSON.stringify(
    {
      topKeys: info.topKeys,
      offerArrays: info.offerArrays.map((a) => ({
        path: a.path,
        length: a.length,
        sampleKeys: a.sampleKeys,
      })),
    },
    null,
    2
  )
);

// print first offer sample truncated
if (info.offerArrays[0]) {
  console.log("\n--- SAMPLE OFFER ---");
  console.log(JSON.stringify(info.offerArrays[0].sample, null, 2).slice(0, 3000));
}

await browser.close();
