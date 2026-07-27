import { launchBrowser } from "../browser.js";
import { newAuthedContext } from "../auth.js";

const browser = await launchBrowser({ headed: false });
const context = await newAuthedContext(browser, {
  locale: "en-US",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
});
await context.addCookies([
  { name: "oversealanguage", value: "en", domain: ".1688.com", path: "/" },
]);
const page = await context.newPage();
await page.goto(
  "https://s.1688.com/selloffer/offer_search.htm?keywords=router&beginPage=1",
  { waitUntil: "domcontentloaded", timeout: 60_000 }
);
await page.waitForTimeout(18_000);

const info = await page.evaluate(() => {
  const list = window.data?.offerV2Showed?.offerList || [];
  // Find elements containing first offer title text (translated)
  const firstCn = String(list[0]?.title || "").replace(/<[^>]+>/g, "").slice(0, 20);
  const firstId = String(list[0]?.offerId || "");

  const hits = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.children.length > 4) continue;
    const t = (el.innerText || "").trim();
    if (!t || t.length < 20 || t.length > 220) continue;
    if (/portable|router|wifi|amplifier|factory/i.test(t) && /[A-Za-z]{4,}/.test(t)) {
      hits.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 80),
        text: t.split("\n")[0].slice(0, 120),
      });
      if (hits.length >= 8) break;
    }
  }

  // find node containing offer id in attributes near titles
  const byAttr = Array.from(document.querySelectorAll(`[data-offer-id], [offerid], [data-id]`))
    .slice(0, 5)
    .map((el) => ({
      tag: el.tagName,
      cls: String(el.className).slice(0, 60),
      attrs: {
        offerid: el.getAttribute("offerid"),
        dataOfferId: el.getAttribute("data-offer-id"),
        dataId: el.getAttribute("data-id"),
      },
      text: (el.innerText || "").trim().slice(0, 80),
    }));

  return {
    firstId,
    firstCn,
    listCount: list.length,
    hits,
    byAttr,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
