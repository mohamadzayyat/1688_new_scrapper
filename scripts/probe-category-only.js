import { launchBrowser } from "../browser.js";
import { newAuthedContext } from "../auth.js";

const CAT = "122234002";
const t0 = Date.now();
const MOBILE = {
  isMobile: true, hasTouch: true,
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
};
const DESKTOP = {
  viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const urls = [
  { mode: "desktop", url: `https://s.1688.com/selloffer/offer_search.htm?keywords=%20&categoryId=${CAT}&beginPage=1` },
  { mode: "desktop", url: `https://s.1688.com/selloffer/offer_search.htm?keywords=*&filt=y&n=y&categoryId=${CAT}&beginPage=1` },
  { mode: "mobile", url: `https://m.1688.com/offer_search/-${CAT}.html?beginPage=1` },
  { mode: "mobile", url: `https://m.1688.com/offer_search.html?categoryId=${CAT}&beginPage=1` },
  { mode: "desktop", url: `https://s.1688.com/selloffer/offer_search.htm?keywords=扶手&categoryId=${CAT}&beginPage=1` },
];

function collectIds(text, set) {
  for (const m of String(text).matchAll(/offerId["']?\s*[:=]\s*["']?(\d{8,})/gi)) set.add(m[1]);
  for (const m of String(text).matchAll(/offer\/(\d{8,})/gi)) set.add(m[1]);
}

const browser = await launchBrowser({ headed: false });
try {
  const ctx = { mobile: await newAuthedContext(browser, MOBILE), desktop: await newAuthedContext(browser, DESKTOP) };
  const pages = { mobile: await ctx.mobile.newPage(), desktop: await ctx.desktop.newPage() };
  for (const item of urls) {
    if (Date.now() - t0 > 45_000) { console.log("SKIP", item.url); continue; }
    const page = pages[item.mode];
    const netIds = new Set();
    const onResp = async (res) => {
      try {
        const u = res.url();
        if (!/offer|search|mtop|1688/i.test(u)) return;
        const t = await res.text();
        if (t.length > 100 && t.length < 1_500_000) collectIds(t, netIds);
      } catch {}
    };
    page.on("response", onResp);
    try {
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 28_000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const captcha = /滑块|验证码|punish|_____tmd_____|login\.(taobao|1688)|havanalogin/i.test(text + location.href + document.title);
        const data = window.data || null;
        const ids = [];
        const list = data?.offerV2Showed?.offerList || [];
        for (const it of list) if (it.offerId) ids.push(String(it.offerId));
        return {
          title: document.title,
          finalHref: location.href,
          captcha,
          listLen: list.length,
          dataKeys: data ? Object.keys(data).slice(0, 25) : [],
          sampleIds: ids.slice(0, 8),
          snippet: text.replace(/\s+/g, " ").slice(0, 150),
        };
      });
      const offerCount = Math.max(info.listLen, netIds.size);
      console.log(JSON.stringify({
        flag: info.captcha ? "CAPTCHA" : offerCount > 0 ? "OK+OFFERS" : "OK",
        offers: offerCount,
        net: netIds.size,
        listLen: info.listLen,
        captcha: info.captcha,
        dataKeys: info.dataKeys,
        sample: info.sampleIds.length ? info.sampleIds : [...netIds].slice(0, 8),
        title: info.title,
        final: info.finalHref,
        url: item.url,
        snippet: info.snippet,
      }));
    } catch (e) {
      console.log(JSON.stringify({ flag: "FAIL", url: item.url, error: e.message }));
    } finally {
      page.off("response", onResp);
    }
  }
} finally {
  await browser.close();
}
console.log("elapsed_ms=" + (Date.now() - t0));
