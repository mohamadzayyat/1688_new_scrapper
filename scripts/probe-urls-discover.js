import { launchBrowser } from "../browser.js";
import { newAuthedContext } from "../auth.js";

const MEMBER = "b2b-221822542203833240";
const KW = "扶手垫";
const CAT = "122234002";
const KW_HEX = Buffer.from(KW, "utf8").toString("hex");
const t0 = Date.now();

const MOBILE = {
  isMobile: true,
  hasTouch: true,
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
};
const DESKTOP = {
  viewport: { width: 1280, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const TARGETS = [
  { group: "shop", mode: "mobile", url: `https://winport.m.1688.com/page/offerlist.html?memberId=${MEMBER}`, wait: 5000, scroll: true },
  { group: "shop", mode: "mobile", url: `https://m.1688.com/winport/b2b-${MEMBER.replace(/^b2b-/, "")}.html`, wait: 4000 },
  { group: "company", mode: "desktop", url: `https://s.1688.com/company/company_search.htm?keywords=${encodeURIComponent(KW)}`, wait: 4500 },
  { group: "company", mode: "desktop", url: `https://s.1688.com/selloffer/company_search.htm?keywords=${encodeURIComponent(KW)}&beginPage=1`, wait: 4500 },
  { group: "company", mode: "mobile", url: `https://m.1688.com/offer_search/-${KW_HEX}.html?beginPage=1`, wait: 4500 },
  { group: "category", mode: "desktop", url: `https://s.1688.com/selloffer/offer_search.htm?categoryId=${CAT}&beginPage=1`, wait: 4500 },
  { group: "category", mode: "desktop", url: `https://s.1688.com/selloffer/offer_search.htm?keywords=&featurePair=122234002:&beginPage=1`, wait: 4000 },
  { group: "category", mode: "mobile", url: `https://m.1688.com/offer_search/-${CAT}.html?beginPage=1`, wait: 4000 },
];

function collectIdsFromText(text, set) {
  if (!text) return;
  for (const m of String(text).matchAll(/["']?(?:offerId|offer_id|offerid)["']?\s*[:=]\s*["']?(\d{8,})/gi)) {
    set.add(m[1]);
  }
  for (const m of String(text).matchAll(/detail\.1688\.com\/offer\/(\d{8,})\.html/gi)) {
    set.add(m[1]);
  }
  for (const m of String(text).matchAll(/\/offer\/(\d{8,})(?:\.html|\/|"|'|\?)/gi)) {
    set.add(m[1]);
  }
}

async function probe(page, item) {
  const netIds = new Set();
  const netHits = [];
  const onResp = async (res) => {
    try {
      const u = res.url();
      if (!/1688|mtop|offer|winport|search|company/i.test(u)) return;
      const ct = res.headers()["content-type"] || "";
      if (!/json|javascript|text|html/i.test(ct) && res.status() !== 200) return;
      let text = "";
      try {
        text = await res.text();
      } catch {
        return;
      }
      if (text.length < 80 || text.length > 2_000_000) return;
      const before = netIds.size;
      collectIdsFromText(text, netIds);
      if (netIds.size > before || /offerList|companyList|offerId/i.test(text.slice(0, 2000))) {
        netHits.push({
          url: u.slice(0, 180),
          status: res.status(),
          len: text.length,
          newIds: netIds.size - before,
        });
      }
    } catch {}
  };
  page.on("response", onResp);

  try {
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(item.wait || 4000);
    if (item.scroll) {
      await page.evaluate(async () => {
        for (let i = 0; i < 4; i++) {
          window.scrollBy(0, 600);
          await new Promise((r) => setTimeout(r, 400));
        }
      });
      await page.waitForTimeout(1500);
    }
    // settle redirects
    await page.waitForTimeout(500);

    const info = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const captcha =
        /滑块|验证码|punish|captcha|_____tmd_____|sec\.taobao/i.test(
          text + location.href + document.title
        ) || /login\.(taobao|1688)|havanalogin/i.test(location.href);

      const ids = new Set();
      const push = (id) => {
        const s = String(id || "").replace(/\D/g, "");
        if (s.length >= 8) ids.add(s);
      };
      for (const a of document.querySelectorAll("a[href], [offerid], [data-offer-id], [data-id]")) {
        const href = a.href || a.getAttribute("href") || "";
        const m = href.match(/offer[\/_](\d{8,})/i);
        if (m) push(m[1]);
        push(a.getAttribute("offerid"));
        push(a.getAttribute("data-offer-id"));
        const did = a.getAttribute("data-id");
        if (did && /^\d{8,}$/.test(did)) push(did);
      }
      // script JSON blobs
      for (const s of document.querySelectorAll("script")) {
        const t = s.textContent || "";
        if (t.length > 50 && /offerId|offer_id|offerList/i.test(t)) {
          for (const m of t.matchAll(/offerId["']?\s*[:=]\s*["']?(\d{8,})/gi)) push(m[1]);
        }
      }
      // attrs dump
      for (const el of document.querySelectorAll("[class*='offer'], [class*='Offer'], [class*='item']")) {
        for (const attr of el.attributes || []) {
          if (/offer|id/i.test(attr.name) && /\d{8,}/.test(attr.value)) {
            const m = attr.value.match(/(\d{8,})/);
            if (m) push(m[1]);
          }
        }
      }

      const data = window.data || null;
      const dataKeys = data && typeof data === "object" ? Object.keys(data) : [];
      const globalKeys = Object.keys(window).filter((k) =>
        /data|INIT|offer|config|STORE|RESULT|__NEXT|__NUXT/i.test(k)
      ).slice(0, 30);

      const offerPaths = [];
      function walk(obj, path, depth) {
        if (!obj || depth > 6) return;
        if (Array.isArray(obj)) {
          if (obj.length && typeof obj[0] === "object" && obj[0]) {
            const o = obj[0];
            if (o.offerId || o.offer_id || o.id || o.memberId || o.companyName || o.loginId) {
              offerPaths.push({
                path,
                length: obj.length,
                sampleKeys: Object.keys(o).slice(0, 18),
              });
              for (const it of obj) push(it.offerId || it.offer_id || (typeof it.id === "number" ? it.id : null));
            }
          }
          return;
        }
        if (typeof obj !== "object") return;
        for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
      if (data) walk(data, "data", 0);
      for (const gk of globalKeys) {
        try {
          if (window[gk] && typeof window[gk] === "object") walk(window[gk], gk, 0);
        } catch {}
      }

      const memberIds = new Set();
      for (const m of (document.body?.innerHTML || "").matchAll(/b2b-\d{10,}/g)) memberIds.add(m[0]);
      for (const m of text.matchAll(/memberId[=:][\s"']*(b2b-[\w-]+)/gi)) memberIds.add(m[1]);

      return {
        title: document.title,
        finalHref: location.href,
        captcha,
        domOfferCount: ids.size,
        domOfferSample: [...ids].slice(0, 10),
        dataKeys,
        globalKeys,
        offerPaths: offerPaths.slice(0, 10),
        memberSample: [...memberIds].slice(0, 8),
        companyish: document.querySelectorAll(
          'a[href*="company"], a[href*="winport"], [class*="company"], [class*="factory"]'
        ).length,
        snippet: text.replace(/\s+/g, " ").slice(0, 180),
      };
    });

    const allIds = new Set([...info.domOfferSample]);
    for (const id of netIds) allIds.add(id);
    // re-count properly
    const merged = new Set(info.domOfferSample);
    for (const id of netIds) merged.add(id);

    return {
      ok: true,
      ...info,
      netOfferCount: netIds.size,
      netOfferSample: [...netIds].slice(0, 10),
      totalOffers: new Set([...[...netIds], ...info.domOfferSample]).size,
      // fix: use full dom set - re-evaluate count from net+ we only have sample from evaluate
      // Better: trust netIds + re-get from evaluate's count
      offerCount: Math.max(info.domOfferCount, netIds.size, new Set([...netIds, ...info.domOfferSample]).size),
      netHits: netHits.slice(0, 8),
      noCaptcha: !info.captcha,
    };
  } catch (e) {
    return { ok: false, error: e.message, offerCount: 0, captcha: false, noCaptcha: false };
  } finally {
    page.off("response", onResp);
  }
}

const browser = await launchBrowser({ headed: false });
const results = [];
try {
  const ctx = {
    mobile: await newAuthedContext(browser, MOBILE),
    desktop: await newAuthedContext(browser, DESKTOP),
  };
  const pages = {
    mobile: await ctx.mobile.newPage(),
    desktop: await ctx.desktop.newPage(),
  };

  for (const item of TARGETS) {
    if (Date.now() - t0 > 80_000) {
      console.log("SKIP budget", item.url);
      results.push({ ...item, skipped: true });
      continue;
    }
    console.log(`\n=== ${item.group} ${item.mode} ===`);
    const r = await probe(pages[item.mode], item);
    results.push({ group: item.group, url: item.url, ...r });
    console.log(
      JSON.stringify({
        flag: !r.ok ? "FAIL" : r.captcha ? "CAPTCHA" : r.offerCount > 0 ? "OK+OFFERS" : "OK",
        offers: r.offerCount,
        dom: r.domOfferCount,
        net: r.netOfferCount,
        captcha: r.captcha,
        dataKeys: r.dataKeys,
        paths: r.offerPaths,
        globals: r.globalKeys,
        members: r.memberSample,
        companyish: r.companyish,
        netHits: r.netHits,
        title: r.title,
        final: r.finalHref,
        url: item.url,
        snippet: r.snippet,
        error: r.error,
        offerSample: r.netOfferSample?.length ? r.netOfferSample : r.domOfferSample,
      })
    );
  }
} finally {
  await browser.close();
}

console.log("\n=== SUMMARY ===");
const by = {};
for (const r of results) {
  (by[r.group] ||= []).push({
    url: r.url,
    noCaptcha: Boolean(r.ok && r.noCaptcha),
    offers: r.offerCount || 0,
    dataKeys: r.dataKeys || [],
    paths: (r.offerPaths || []).map((p) => `${p.path}(${p.length})`),
    netApis: (r.netHits || []).map((h) => h.url),
    flag: r.skipped ? "skip" : !r.ok ? "fail" : r.captcha ? "captcha" : (r.offerCount || 0) > 0 ? "offers" : "ok",
  });
}
console.log(JSON.stringify(by, null, 2));
console.log("elapsed_ms=" + (Date.now() - t0));
