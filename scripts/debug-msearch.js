import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";

const keyword = process.argv[2] || "router";
const pageNo = Number(process.argv[3] || 1);
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

const apiHits = [];
page.on("response", async (res) => {
  try {
    const u = res.url();
    const ct = res.headers()["content-type"] || "";
    if (!/json|javascript|text/i.test(ct) && !/mtop|search|offer/i.test(u)) return;
    const text = await res.text();
    if (!/offerId|offer_id|totalCount|data/.test(text)) return;
    if (text.length < 200) return;
    apiHits.push({
      url: u.slice(0, 250),
      status: res.status(),
      len: text.length,
      snip: text.slice(0, 300),
    });
  } catch {}
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const out = {
    title: document.title,
    href: location.href,
    body: (document.body?.innerText || "").slice(0, 1500),
    globals: Object.keys(window).filter((k) =>
      /data|offer|search|INIT|config|__|RESULT|list/i.test(k)
    ),
    offerArrays: [],
  };

  function walk(obj, path = "", depth = 0) {
    if (!obj || depth > 7) return;
    if (Array.isArray(obj)) {
      if (
        obj.length &&
        typeof obj[0] === "object" &&
        obj[0] &&
        (obj[0].offerId || obj[0].id || obj[0].subject || obj[0].title)
      ) {
        out.offerArrays.push({
          path,
          length: obj.length,
          sampleKeys: Object.keys(obj[0]).slice(0, 40),
          sample: obj[0],
        });
      }
      return;
    }
    if (typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  }

  for (const key of ["__INITIAL_STATE__", "__INIT_DATA", "data", "g_config", "context", "__STORE__"]) {
    try {
      if (window[key]) walk(window[key], key);
    } catch {}
  }

  // DOM cards
  const cards = Array.from(
    document.querySelectorAll('a[href*="offer"], [class*="offer"], [class*="Offer"]')
  ).slice(0, 5);
  out.domSamples = cards.map((el) => ({
    tag: el.tagName,
    href: el.href || null,
    text: (el.innerText || "").slice(0, 120),
    className: String(el.className).slice(0, 80),
  }));

  // total from text
  const m = (document.body?.innerText || "").match(/共\s*([\d,+]+)\s*件/);
  out.totalFromText = m?.[1] || null;

  return out;
});

await writeFile(
  "output/debug-msearch.json",
  JSON.stringify({ url, info, apiHits: apiHits.slice(0, 15) }, null, 2)
);

console.log(
  JSON.stringify(
    {
      url,
      title: info.title,
      totalFromText: info.totalFromText,
      globals: info.globals,
      offerArrays: info.offerArrays.map((a) => ({
        path: a.path,
        length: a.length,
        sampleKeys: a.sampleKeys,
      })),
      apiHits: apiHits.slice(0, 10),
      domSamples: info.domSamples,
    },
    null,
    2
  )
);

if (info.offerArrays[0]) {
  console.log("\nSAMPLE\n", JSON.stringify(info.offerArrays[0].sample, null, 2).slice(0, 2500));
}

await browser.close();
