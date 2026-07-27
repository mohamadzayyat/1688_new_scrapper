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
await page.waitForTimeout(20_000);

const info = await page.evaluate(() => {
  const list = window.data?.offerV2Showed?.offerList || [];
  const cards = Array.from(
    document.querySelectorAll(".mojar-element-title, .offer-title, [class*='title-text']")
  )
    .map((el) => (el.innerText || "").trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    running: window.__cgf_translator_running__,
    dataTitles: list.slice(0, 5).map((i) =>
      String(i.title || "").replace(/<[^>]+>/g, "")
    ),
    cards,
    snip: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 500),
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
