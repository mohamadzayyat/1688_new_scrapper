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
  const cards = [];
  for (const el of document.querySelectorAll(
    ".mojar-element-title, [class*='offer-list'] a, a[href*='offer']"
  )) {
    const href = el.href || el.closest("a")?.href || "";
    const id =
      (href.match(/offer\/(\d+)/) || [])[1] ||
      el.getAttribute("data-offer-id") ||
      null;
    const titleEl =
      el.matches(".mojar-element-title") || el.className?.includes?.("title")
        ? el
        : el.querySelector(".mojar-element-title, [class*='title']");
    const title = (titleEl?.innerText || el.innerText || "").trim();
    if (id && title.length > 15) {
      cards.push({
        id,
        title: title.split("\n")[0].slice(0, 160),
        cls: String(el.className).slice(0, 60),
      });
    }
  }
  // unique by id
  const seen = new Set();
  const uniq = [];
  for (const c of cards) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    uniq.push(c);
  }
  return {
    count: uniq.length,
    sample: uniq.slice(0, 6),
    titleNodes: document.querySelectorAll(".mojar-element-title").length,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
