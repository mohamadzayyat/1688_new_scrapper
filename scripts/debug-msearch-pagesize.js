import { chromium } from "playwright";

async function scrapePage(keyword, pageNo) {
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
  await page.waitForSelector("a.item-link", { timeout: 30_000 });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("a.item-link"))
      .map((a) => {
        const offerId =
          a.getAttribute("offerid") ||
          a.getAttribute("data-offer-id") ||
          (a.href.match(/offer\/(\d+)/) || [])[1] ||
          null;
        if (!offerId) return null;
        const text = (a.innerText || "").trim();
        const img = a.querySelector("img.image_src, img[data-src], img");
        const companyEl = a.querySelector(".company, .shop-name, [class*='company']");
        return {
          offerId,
          title: text.split("\n").map((s) => s.trim()).filter(Boolean)[0] || null,
          price: (text.match(/￥\s*([\d.]+)/) || [])[1] || null,
          sales: (text.match(/成交\s*([^\n]+)/) || [])[1] || null,
          repurchaseRate: (text.match(/复购率[:：]\s*([^\n%]+%?)/) || [])[1] || null,
          image:
            img?.getAttribute("data-src") ||
            (img?.src && !img.src.includes("offer_search") ? img.src : null),
          company: companyEl?.innerText?.trim() || null,
          url: `https://detail.1688.com/offer/${offerId}.html`,
        };
      })
      .filter(Boolean);

    const totalRaw = (document.body.innerText.match(/共\s*([\d,+]+)\s*件/) || [])[1];
    const total = totalRaw ? Number(String(totalRaw).replace(/,/g, "")) : null;
    return { count: items.length, total, ids: items.map((i) => i.offerId).slice(0, 5), items };
  });

  await browser.close();
  return data;
}

const p1 = await scrapePage("router", 1);
const p2 = await scrapePage("router", 2);
console.log(
  JSON.stringify(
    {
      page1: { count: p1.count, total: p1.total, ids: p1.ids },
      page2: { count: p2.count, total: p2.total, ids: p2.ids },
      overlap: p1.ids.filter((id) => p2.ids.includes(id)),
      sample: p1.items[0],
    },
    null,
    2
  )
);
