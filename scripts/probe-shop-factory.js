import { launchBrowser } from "../browser.js";
import { newAuthedContext } from "../auth.js";

const MEMBER = "b2b-221822542203833240";
const browser = await launchBrowser({ headed: false });
const ctx = await newAuthedContext(browser, {
  isMobile: true,
  hasTouch: true,
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
});
const page = await ctx.newPage();

const urls = [
  `https://winport.m.1688.com/page/offerlist.html?memberId=${MEMBER}`,
  `https://winport.m.1688.com/page/index.html?memberId=${MEMBER}`,
];

for (const u of urls) {
  try {
    await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => {
      const ids = [];
      const seen = new Set();
      for (const a of document.querySelectorAll("a")) {
        const href = a.href || "";
        const m = href.match(/offer\/(\d+)/);
        const id = m?.[1] || a.getAttribute("offerid");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      return {
        title: document.title,
        href: location.href,
        text: (document.body?.innerText || "").slice(0, 400),
        offerCount: ids.length,
        offers: ids.slice(0, 12),
      };
    });
    console.log("URL", u);
    console.log(JSON.stringify(info, null, 2));
  } catch (e) {
    console.log("FAIL", u, e.message);
  }
}

// factory via product search companies
await page.goto(
  "https://m.1688.com/offer_search/-e689bfe6898b.html?beginPage=1",
  { waitUntil: "domcontentloaded", timeout: 45_000 }
);
await page.waitForTimeout(4000);
const searchInfo = await page.evaluate(() => ({
  title: document.title,
  items: document.querySelectorAll("a.item-link").length,
  text: (document.body?.innerText || "").slice(0, 250),
}));
console.log("SEARCH", searchInfo);

await browser.close();
