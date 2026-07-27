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
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const out = {
    title: document.title,
    url: location.href,
    body: (document.body?.innerText || "").slice(0, 1000),
    globals: {},
    offerLinkCount: document.querySelectorAll('a[href*="detail.1688.com/offer"]').length,
    links: Array.from(document.querySelectorAll('a[href*="detail.1688.com/offer"]'))
      .slice(0, 8)
      .map((a) => ({ href: a.href, text: (a.innerText || "").slice(0, 100) })),
  };

  for (const k of Object.keys(window)) {
    if (/data|offer|search|INIT|config|RESULT|list/i.test(k)) {
      try {
        const v = window[k];
        out.globals[k] = typeof v;
      } catch {}
    }
  }

  // Find large JSON blobs in scripts
  const blobs = [];
  for (const s of document.scripts) {
    const t = s.textContent || "";
    if (t.length > 500 && /offerId|offerList|data\.offer|items/.test(t)) {
      blobs.push(t.slice(0, 400));
    }
  }
  out.scriptBlobs = blobs.slice(0, 5);

  // common 1688 search data paths
  const candidates = [
    "window.__INIT_DATA",
    "window.offerResultData",
    "window.data",
    "window.context",
    "window.g_config",
    "window.__STORE",
  ];
  out.candidateSnips = {};
  for (const path of candidates) {
    try {
      const val = eval(path);
      if (val != null) {
        out.candidateSnips[path] = JSON.stringify(val).slice(0, 500);
      }
    } catch {}
  }

  return out;
});

await writeFile("output/debug-search.json", JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "output/debug-search.png" });
await browser.close();
