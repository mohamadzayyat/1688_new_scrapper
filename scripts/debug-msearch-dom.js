import { chromium } from "playwright";

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
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(5000);

// scroll to load more
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await page.waitForTimeout(800);
}

const info = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll("a.item-link")).map((a) => {
    const text = (a.innerText || "").trim();
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const img = a.querySelector("img");
    const href = a.href || "";
    const idMatch = href.match(/offer\/(\d+)/);
    return {
      offerId: idMatch?.[1] || null,
      href,
      title: lines[0] || null,
      lines,
      price: (text.match(/￥\s*([\d.]+)/) || [])[1] || null,
      sales: (text.match(/成交\s*([^\n]+)/) || [])[1] || null,
      repurchase: (text.match(/复购率[:：]\s*([^\n]+)/) || [])[1] || null,
      image: img?.src || img?.getAttribute("data-src") || null,
      html: a.outerHTML.slice(0, 500),
    };
  });

  // find pagination / page indicators
  const pageText = document.body.innerText;
  const total = (pageText.match(/共\s*([\d,+]+)\s*件/) || [])[1] || null;

  // look for script json with offer list
  let embedded = null;
  for (const s of document.scripts) {
    const t = s.textContent || "";
    if (t.includes("offerId") && t.length > 1000) {
      embedded = t.slice(0, 800);
      break;
    }
  }

  return {
    count: items.length,
    total,
    first: items[0],
    last: items[items.length - 1],
    items: items.slice(0, 3),
    embedded,
    pageButtons: Array.from(document.querySelectorAll("a,button"))
      .map((el) => (el.innerText || "").trim())
      .filter((t) => /下一页|上一页|页|page/i.test(t))
      .slice(0, 20),
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
