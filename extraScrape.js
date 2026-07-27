/**
 * Extra 1688 scrapers for TMAPI-compatible endpoints.
 */
import { launchBrowser } from "./browser.js";
import { newAuthedContext, assertAuthLooksValid } from "./auth.js";
import { proxyStatus } from "./proxy.js";
import { normalizeLang, translateTexts } from "./translate.js";
import {
  tmapiOk,
  tmapiError,
  toTmapiSearch,
  toTmapiShopItems,
} from "./tmapiExtra.js";
import { searchOffers } from "./search.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withLangCookies(context, lang) {
  await context.addCookies([
    {
      name: "oversealanguage",
      value: lang === "en" ? "en" : "zh-CN",
      domain: ".1688.com",
      path: "/",
    },
  ]);
}

async function openOfferPage(browser, itemId, lang = "zh") {
  const context = await newAuthedContext(browser, {
    locale: lang === "en" ? "en-US" : "zh-CN",
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  await withLangCookies(context, lang);
  const page = await context.newPage();
  await page.goto(`https://detail.1688.com/offer/${itemId}.html`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page
    .waitForFunction(() => Boolean(window.context?.result?.data), null, {
      timeout: 45_000,
    })
    .catch(() => {});
  await sleep(800);
  return { context, page };
}

/** GET /1688/item_desc — description pictures */
export async function getItemDesc(itemId, { language = "zh" } = {}) {
  const id = String(itemId || "").trim();
  if (!/^\d+$/.test(id)) return tmapiError(422, "item_id must be a number");
  const lang = normalizeLang(language);
  const browser = await launchBrowser({ headed: false });
  try {
    const { context, page } = await openOfferPage(browser, id, lang);
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
      await sleep(1000);

      const extracted = await page.evaluate(async () => {
        const data = window.context?.result?.data || {};
        const detailUrl =
          data.description?.fields?.detailUrl ||
          data.description?.fields?.offerDetailUrl ||
          null;
        const gallery = data.gallery?.fields?.offerImgList || [];
        const imgs = new Set(gallery.filter(Boolean));

        // Visible detail images
        for (const img of document.querySelectorAll(
          "img[src*='alicdn'], img[data-src*='alicdn'], img[src*='cbu01']"
        )) {
          const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
          if (/alicdn|cbu01/i.test(src) && !/avatar|logo|icon|tps-/i.test(src)) {
            imgs.add(src.replace(/^\/\//, "https://"));
          }
        }

        let descImgs = [];
        if (detailUrl) {
          try {
            const res = await fetch(detailUrl, { credentials: "include" });
            const html = await res.text();
            const re =
              /https?:\/\/[^"'\\\s>]+\.(?:jpg|jpeg|png|webp)|\/\/cbu01\.alicdn\.com\/[^"'\\\s>]+\.(?:jpg|jpeg|png|webp)/gi;
            const found = html.match(re) || [];
            descImgs = found.map((u) =>
              u.startsWith("//") ? `https:${u}` : u
            );
          } catch {
            /* ignore */
          }
        }

        for (const u of descImgs) imgs.add(u);

        return {
          detailUrl,
          images: [...imgs].filter(
            (u) =>
              /\.(jpg|jpeg|png|webp)/i.test(u) &&
              !/_50x50|_60x60|_80x80|_100x100/i.test(u)
          ),
        };
      });

      return tmapiOk({
        item_id: Number(id),
        detail_url: extracted.detailUrl,
        images: extracted.images,
      });
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "item_desc failed");
  } finally {
    await browser.close();
  }
}

/** GET /1688/item_review — review list (best-effort from detail page) */
export async function getItemReviews(
  itemId,
  { page = 1, page_size = 20, language = "zh" } = {}
) {
  const id = String(itemId || "").trim();
  if (!/^\d+$/.test(id)) return tmapiError(422, "item_id must be a number");
  const lang = normalizeLang(language);
  const browser = await launchBrowser({ headed: false });
  try {
    const { context, page: p } = await openOfferPage(browser, id, lang);
    try {
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1500);
      // try open reviews tab
      await p.evaluate(() => {
        const el = [...document.querySelectorAll("a,button,span,div")].find((n) =>
          /评价|Reviews|好评/.test((n.textContent || "").trim())
        );
        el?.click();
      });
      await sleep(1200);

      const reviews = await p.evaluate(() => {
        const out = [];
        const cards = document.querySelectorAll(
          "[class*='review'], [class*='comment'], [class*='rate']"
        );
        for (const card of cards) {
          const text = (card.innerText || "").trim();
          if (text.length < 8 || text.length > 800) continue;
          if (/全部|筛选|好评率|有图/.test(text) && text.length < 40) continue;
          out.push({
            content: text.slice(0, 500),
            images: [...card.querySelectorAll("img")]
              .map((i) => i.src)
              .filter((s) => /alicdn|cbu01/i.test(s)),
          });
          if (out.length >= 40) break;
        }
        return out;
      });

      const pageNo = Math.max(1, Number(page) || 1);
      const size = Math.min(50, Math.max(1, Number(page_size) || 20));
      const start = (pageNo - 1) * size;
      const slice = reviews.slice(start, start + size);

      return tmapiOk({
        item_id: Number(id),
        page: pageNo,
        page_size: size,
        total_count: reviews.length,
        items: slice,
      });
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "item_review failed");
  } finally {
    await browser.close();
  }
}

/** GET /1688/item_freight — shipping fee / delivery info from offer page */
export async function getItemFreight(itemId, { language = "zh" } = {}) {
  const id = String(itemId || "").trim();
  if (!/^\d+$/.test(id)) return tmapiError(422, "item_id must be a number");
  const lang = normalizeLang(language);
  const browser = await launchBrowser({ headed: false });
  try {
    const { context, page } = await openOfferPage(browser, id, lang);
    try {
      const info = await page.evaluate(() => {
        const data = window.context?.result?.data || {};
        const shipping = data.shippingServices?.fields || null;
        const freightInfo = shipping?.freightInfo || null;
        const body = document.body?.innerText || "";
        const freightMatch = body.match(/运费[^\n]{0,60}/);
        const locationMatch = body.match(/送至\s*([^\n]+)/);
        const fromMatch =
          body.match(/([\u4e00-\u9fff]{2,8}(?:省|市)[^\n]{0,12})\s*\n?\s*送至/) ||
          body.match(/发货地[：:\s]*([^\n]+)/);

        return {
          shipping,
          freight_text:
            freightMatch?.[0] ||
            freightInfo?.logisticsText ||
            (freightInfo?.locationDivisionCode
              ? `division ${freightInfo.locationDivisionCode}`
              : null),
          ship_to: locationMatch?.[1]?.trim() || null,
          location_from: fromMatch?.[1]?.trim() || null,
          unit_weight: shipping?.unitWeight ?? freightInfo?.unitWeight ?? null,
          delivery_limit: freightInfo?.deliveryLimit ?? null,
          logistics_text: freightInfo?.logisticsText || null,
          protections: (shipping?.buyerProtectionModel || []).map(
            (p) => p.serviceName || p.packageBuyerDesc
          ),
        };
      });

      return tmapiOk({
        item_id: Number(id),
        freight_text: info.freight_text,
        logistics_text: info.logistics_text,
        location_from: info.location_from,
        ship_to: info.ship_to,
        unit_weight: info.unit_weight,
        delivery_limit: info.delivery_limit,
        buyer_protections: info.protections,
        shipping_raw: info.shipping
          ? {
              unitWeight: info.shipping.unitWeight,
              freightInfo: info.shipping.freightInfo || null,
            }
          : null,
      });
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "item_freight failed");
  } finally {
    await browser.close();
  }
}

function normalizeShopUrl(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.includes("memberId=")) {
    return `https://winport.m.1688.com/page/index.html?${s.includes("?") ? s.split("?")[1] : `memberId=${s}`}`;
  }
  if (/^b2b-/i.test(s) || /^[a-z0-9_-]+$/i.test(s)) {
    if (s.includes(".")) return `https://${s.replace(/^https?:\/\//, "")}`;
    return `https://winport.m.1688.com/page/index.html?memberId=${s}`;
  }
  return `https://${s}`;
}

/** GET /1688/shop/items/v2 */
export async function getShopItems({
  shop_url,
  member_id,
  page = 1,
  page_size = 20,
  sort = "default",
  keyword = "",
  language = "zh",
} = {}) {
  const url =
    normalizeShopUrl(shop_url) ||
    (member_id
      ? `https://winport.m.1688.com/page/index.html?memberId=${member_id}`
      : null);
  if (!url) return tmapiError(422, "shop_url or member_id is required");

  const lang = normalizeLang(language);
  const pageNo = Math.max(1, Number(page) || 1);
  const size = Math.min(50, Math.max(1, Number(page_size) || 20));
  const browser = await launchBrowser({ headed: false });

  try {
    const context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    await withLangCookies(context, lang);
    const p = await context.newPage();
    try {
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(2500);
      // Try open "all products" / 商品 tab
      await p.evaluate(() => {
        const btn = [...document.querySelectorAll("a,button,span,div")].find((el) =>
          /全部商品|所有产品|商品|Products/i.test((el.textContent || "").trim())
        );
        btn?.click();
      });
      await sleep(2000);
      for (let i = 0; i < 4; i++) {
        await p.evaluate(() => window.scrollBy(0, 900));
        await sleep(400);
      }

      const scraped = await p.evaluate(({ pageNo, size, keyword }) => {
        const items = [];
        const seen = new Set();
        const anchors = document.querySelectorAll(
          "a[href*='detail.1688.com/offer'], a[href*='/offer/'], a[offerid], a[data-offer-id]"
        );
        for (const a of anchors) {
          const href = a.href || "";
          const m =
            href.match(/offer\/(\d+)/) ||
            [null, a.getAttribute("offerid") || a.getAttribute("data-offer-id")];
          if (!m?.[1]) continue;
          const id = String(m[1]);
          if (!/^\d{8,}$/.test(id) || seen.has(id)) continue;
          seen.add(id);
          const card = a.closest("li,div,article,section") || a;
          const text = (card.innerText || "").trim();
          const title =
            a.getAttribute("title") ||
            a.querySelector("img")?.alt ||
            text.split("\n").find((l) => l.length > 6) ||
            "";
          if (keyword && !`${title}\n${text}`.includes(keyword)) continue;
          const img =
            a.querySelector("img")?.src ||
            card.querySelector("img")?.src ||
            "";
          const priceMatch = text.match(/¥\s*([\d.]+)|([\d.]+)\s*元/);
          const salesMatch = text.match(
            /成交[^\d]*([\d.]+[万+]?)|([\d.]+)\s*人付款|([\d.]+)\s*sold/i
          );
          items.push({
            item_id: id,
            title: title.slice(0, 200),
            img,
            price: priceMatch?.[1] || priceMatch?.[2] || null,
            sale_quantity: salesMatch?.[1] || salesMatch?.[2] || salesMatch?.[3] || 0,
          });
        }

        const company =
          document.querySelector("title")?.textContent?.replace(/[-_].*$/, "").trim() ||
          "";

        const start = (pageNo - 1) * size;
        return {
          company,
          total_count: items.length,
          items: items.slice(start, start + size),
        };
      }, { pageNo, size, keyword });

      if (lang === "en" && scraped.items.length) {
        const titles = await translateTexts(scraped.items.map((i) => i.title));
        scraped.items = scraped.items.map((it, i) => ({
          ...it,
          title: titles[i] || it.title,
        }));
      }

      return toTmapiShopItems(scraped, {
        page: pageNo,
        page_size: size,
        sort,
        keyword,
        cat: "",
      });
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop items failed");
  } finally {
    await browser.close();
  }
}

/** GET /1688/shop/info */
export async function getShopInfo({ shop_url, member_id, language = "zh" } = {}) {
  const url =
    normalizeShopUrl(shop_url) ||
    (member_id
      ? `https://winport.m.1688.com/page/index.html?memberId=${member_id}`
      : null);
  if (!url) return tmapiError(422, "shop_url or member_id is required");
  const lang = normalizeLang(language);
  const browser = await launchBrowser({ headed: false });
  try {
    const context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1280, height: 900 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(2500);
      const info = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const title = document.title || "";
        const memberMatch = location.href.match(/memberId=([^&]+)/);
        const company =
          [...document.querySelectorAll("h1,h2,.company-name,[class*='company']")]
            .map((el) => (el.textContent || "").trim())
            .find((t) => t && t.length > 2 && t.length < 80) ||
          title.replace(/[-_|].*$/, "").trim() ||
          null;
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        return {
          shop_name: company,
          shop_url: location.href,
          member_id: memberMatch ? decodeURIComponent(memberMatch[1]) : null,
          snippet: lines.slice(0, 30),
        };
      });
      return tmapiOk(info);
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop info failed");
  } finally {
    await browser.close();
  }
}

/** GET /1688/shop/cats — shop categories (best-effort from shop page links) */
export async function getShopCategories({ shop_url, member_id, language = "zh" } = {}) {
  const url =
    normalizeShopUrl(shop_url) ||
    (member_id
      ? `https://winport.m.1688.com/page/index.html?memberId=${member_id}`
      : null);
  if (!url) return tmapiError(422, "shop_url or member_id is required");
  const lang = normalizeLang(language);
  const browser = await launchBrowser({ headed: false });
  try {
    const context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1280, height: 900 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(2500);
      const cats = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll("a")) {
          const name = (a.textContent || "").trim();
          const href = a.href || "";
          if (!name || name.length > 40) continue;
          if (!/分类|category|cat|产品|全部商品|枕|棉|垫/i.test(name + href)) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({ name, url: href });
          if (out.length >= 50) break;
        }
        return out;
      });
      return tmapiOk({ shop_url: url, categories: cats });
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop categories failed");
  } finally {
    await browser.close();
  }
}

/** GET /1688/search/items — TMAPI keyword search */
export async function searchItemsTmapi({
  keyword,
  page = 1,
  page_size = 20,
  sort = "default",
  language = "zh",
} = {}) {
  const q = String(keyword || "").trim();
  if (!q) return tmapiError(422, "keyword is required");
  try {
    // Ensure proxy/auth available
    const auth = await assertAuthLooksValid();
    const proxy = proxyStatus();
    if (!auth.ok && !proxy.enabled) {
      return tmapiError(
        500,
        `No valid 1688 login (${auth.reason}) and proxy disabled. Run npm run login or enable proxy.`
      );
    }

    const raw = await searchOffers(q, {
      page: Math.max(1, Number(page) || 1),
      lang: normalizeLang(language),
    });
    const formatted = toTmapiSearch(raw, {
      keyword: q,
      page: raw.page,
      page_size: Math.min(20, Math.max(1, Number(page_size) || raw.pageSize || 20)),
      sort,
    });
    // Trim to page_size
    if (formatted.data.items.length > formatted.data.page_size) {
      formatted.data.items = formatted.data.items.slice(0, formatted.data.page_size);
    }
    return formatted;
  } catch (err) {
    return tmapiError(500, err.message || "search failed");
  }
}

/**
 * POST /1688/search/img — image search (best-effort via 1688 similar search page)
 * Body: { img_url, page?, language? }
 */
export async function searchByImage({
  img_url,
  page = 1,
  language = "zh",
} = {}) {
  const img = String(img_url || "").trim();
  if (!img) return tmapiError(422, "img_url is required");
  const lang = normalizeLang(language);
  const pageNo = Math.max(1, Number(page) || 1);
  const browser = await launchBrowser({ headed: false });

  try {
    const context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    await withLangCookies(context, lang);
    const p = await context.newPage();
    try {
      // 1688 image/similar search entry
      const searchUrl =
        "https://s.1688.com/selloffer/offer_search.htm?keywords=&imageAddress=" +
        encodeURIComponent(img) +
        `&beginPage=${pageNo}`;
      await p.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(3000);

      // Fallback: keyword-less page may not work — try youyuan
      let items = await p.evaluate(() => {
        const list = window.data?.offerV2Showed?.offerList;
        if (Array.isArray(list) && list.length) {
          return list.map((it) => ({
            offerId: String(it.offerId || ""),
            title: (it.title || "").replace(/<[^>]+>/g, ""),
            price: it.priceInfo?.price || it.price || null,
            image: it.offerPicUrl || null,
            company: it.companyName || null,
            sales: it.bookedCount != null ? String(it.bookedCount) : null,
            location: [it.province, it.city].filter(Boolean).join("") || null,
            isAd: false,
          }));
        }
        return [];
      });

      if (!items.length) {
        // DOM fallback
        items = await p.evaluate(() => {
          const out = [];
          for (const a of document.querySelectorAll("a[href*='offer/']")) {
            const m = (a.href || "").match(/offer\/(\d+)/);
            if (!m) continue;
            const imgEl = a.querySelector("img");
            out.push({
              offerId: m[1],
              title: a.getAttribute("title") || imgEl?.alt || "",
              price: null,
              image: imgEl?.src || null,
              company: null,
              sales: null,
              location: null,
              isAd: false,
            });
            if (out.length >= 20) break;
          }
          return out;
        });
      }

      if (lang === "en" && items.length) {
        const titles = await translateTexts(items.map((i) => i.title));
        items = items.map((it, i) => ({ ...it, title: titles[i] || it.title }));
      }

      return toTmapiSearch(
        { results: items, total: items.length },
        { keyword: "[image]", page: pageNo, page_size: items.length || 20, sort: "default" }
      );
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "image search failed");
  } finally {
    await browser.close();
  }
}

/** GET /1688/category/products — use keyword search with category hint */
export async function getCategoryProducts({
  cat_id,
  keyword = "",
  page = 1,
  page_size = 20,
  language = "zh",
  sort = "default",
} = {}) {
  const cat = String(cat_id || "").trim();
  if (!cat && !keyword) {
    return tmapiError(422, "cat_id or keyword is required");
  }
  // 1688 category browsing is inconsistent anonymously; use keyword = cat name/id fallback
  const q = keyword || cat;
  return searchItemsTmapi({
    keyword: q,
    page,
    page_size,
    sort,
    language,
  });
}
