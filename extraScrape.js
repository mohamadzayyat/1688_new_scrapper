/**
 * Extra 1688 scrapers for TMAPI-compatible endpoints.
 */
import { acquirePooledBrowser, releaseBrowser } from "./browser.js";
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
  const browser = await acquirePooledBrowser();
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
    releaseBrowser(browser);
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
  const browser = await acquirePooledBrowser();
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
    releaseBrowser(browser);
  }
}

/** GET /1688/item_freight — shipping fee / delivery info from offer page */
export async function getItemFreight(itemId, { language = "zh" } = {}) {
  const id = String(itemId || "").trim();
  if (!/^\d+$/.test(id)) return tmapiError(422, "item_id must be a number");
  const lang = normalizeLang(language);
  const browser = await acquirePooledBrowser();
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
    releaseBrowser(browser);
  }
}

function extractMemberId(shop_url, member_id) {
  if (member_id) return String(member_id).trim();
  const s = String(shop_url || "");
  const m =
    s.match(/memberId=([^&]+)/i) ||
    s.match(/winport\/(b2b-[^/.]+)/i) ||
    s.match(/\/\/(b2b-[^/.]+)\.1688\.com/i);
  return m ? decodeURIComponent(m[1]) : "";
}

function collectOfferIdsFromText(text, set) {
  if (!text) return;
  for (const m of String(text).matchAll(
    /["']?(?:offerId|offer_id|offerid)["']?\s*[:=]\s*["']?(\d{8,})/gi
  )) {
    set.add(m[1]);
  }
  for (const m of String(text).matchAll(
    /detail\.1688\.com\/offer\/(\d{8,})/gi
  )) {
    set.add(m[1]);
  }
  for (const m of String(text).matchAll(/\/offer\/(\d{8,})/gi)) {
    set.add(m[1]);
  }
}

/**
 * GET /1688/shop/items (by member_id)
 * GET /1688/shop/items/v2 (by shop_url)
 */
export async function getShopItems({
  shop_url,
  member_id,
  page = 1,
  page_size = 20,
  sort = "default",
  keyword = "",
  shop_cat_id = "",
  language = "zh",
} = {}) {
  const mid = extractMemberId(shop_url, member_id);
  if (!mid) return tmapiError(422, "member_id or shop_url is required");

  const lang = normalizeLang(language);
  const pageNo = Math.max(1, Number(page) || 1);
  const size = Math.min(50, Math.max(1, Number(page_size) || 20));
  const offerListUrl = `https://winport.m.1688.com/page/offerlist.html?memberId=${encodeURIComponent(mid)}&pageNum=${pageNo}`;
  const browser = await acquirePooledBrowser();

  try {
    const context = await newAuthedContext(browser, {
      isMobile: true,
      hasTouch: true,
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 390, height: 844 },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    });
    await withLangCookies(context, lang);
    const p = await context.newPage();
    const netIds = new Set();
    const onResp = async (res) => {
      try {
        const u = res.url();
        if (!/winport|offer|asyncView|mtop/i.test(u)) return;
        const text = await res.text();
        if (text && text.length < 2_000_000) collectOfferIdsFromText(text, netIds);
      } catch {
        /* ignore */
      }
    };
    p.on("response", onResp);

    try {
      await p.goto(offerListUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(3500);
      for (let i = 0; i < 5; i++) {
        await p.evaluate(() => window.scrollBy(0, 700));
        await sleep(400);
      }

      const scraped = await p.evaluate(() => {
        const items = [];
        const seen = new Set();
        const push = (id, title, img, price, sales) => {
          const sid = String(id || "").replace(/\D/g, "");
          if (sid.length < 8 || seen.has(sid)) return;
          seen.add(sid);
          items.push({
            item_id: sid,
            title: (title || "").slice(0, 200),
            img: img || "",
            price: price != null ? String(price) : null,
            sale_quantity: sales ?? 0,
          });
        };

        for (const a of document.querySelectorAll(
          "a[href], [offerid], [data-offer-id], [data-id]"
        )) {
          const href = a.href || a.getAttribute("href") || "";
          const m = href.match(/offer\/(\d{8,})/i);
          const id =
            m?.[1] ||
            a.getAttribute("offerid") ||
            a.getAttribute("data-offer-id") ||
            a.getAttribute("data-id");
          if (!id) continue;
          const card = a.closest("li,div,article,section") || a;
          const text = (card.innerText || "").trim();
          const title =
            a.getAttribute("title") ||
            a.querySelector("img")?.alt ||
            text.split("\n").find((l) => l.length > 6) ||
            "";
          const img =
            a.querySelector("img")?.src || card.querySelector("img")?.src || "";
          const priceMatch = text.match(/¥\s*([\d.]+)|([\d.]+)\s*元/);
          push(
            id,
            title,
            img,
            priceMatch?.[1] || priceMatch?.[2] || null,
            0
          );
        }

        // HTML/script blobs
        const html = document.documentElement?.innerHTML || "";
        for (const m of html.matchAll(/offerId["']?\s*[:=]\s*["']?(\d{8,})/gi)) {
          push(m[1], "", "", null, 0);
        }

        const company =
          document.querySelector("title")?.textContent?.replace(/[-_].*$/, "").trim() ||
          "";
        return { company, items, member_id: null };
      });

      // merge network-captured ids
      for (const id of netIds) {
        if (!scraped.items.some((it) => it.item_id === id)) {
          scraped.items.push({
            item_id: id,
            title: "",
            img: "",
            price: null,
            sale_quantity: 0,
          });
        }
      }

      let items = scraped.items;
      if (keyword) {
        items = items.filter((it) =>
          `${it.title}`.toLowerCase().includes(String(keyword).toLowerCase())
        );
      }
      void shop_cat_id;
      void sort;

      const start = (pageNo - 1) * size;
      const pageItems = items.slice(start, start + size);

      if (lang === "en" && pageItems.length) {
        const titles = await translateTexts(pageItems.map((i) => i.title || i.item_id));
        for (let i = 0; i < pageItems.length; i++) {
          if (pageItems[i].title) pageItems[i].title = titles[i] || pageItems[i].title;
        }
      }

      return toTmapiShopItems(
        { total_count: items.length, items: pageItems },
        {
          page: pageNo,
          page_size: size,
          sort,
          keyword,
          cat: shop_cat_id || "",
        }
      );
    } finally {
      p.off("response", onResp);
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop items failed");
  } finally {
    releaseBrowser(browser);
  }
}

/** GET /1688/shop/info */
export async function getShopInfo({ shop_url, member_id, language = "zh" } = {}) {
  const mid = extractMemberId(shop_url, member_id);
  if (!mid) return tmapiError(422, "member_id or shop_url is required");
  const lang = normalizeLang(language);
  const url = `https://winport.m.1688.com/page/index.html?memberId=${encodeURIComponent(mid)}`;
  const browser = await acquirePooledBrowser();
  try {
    const context = await newAuthedContext(browser, {
      isMobile: true,
      hasTouch: true,
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 390, height: 844 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(3000);
      const info = await page.evaluate((memberId) => {
        const text = document.body?.innerText || "";
        const title = document.title || "";
        const company =
          [...document.querySelectorAll("h1,h2,[class*='company'],[class*='shop-name']")]
            .map((el) => (el.textContent || "").trim())
            .find((t) => t && t.length > 2 && t.length < 80) ||
          title.replace(/[-_|].*$/, "").trim() ||
          null;
        return {
          member_id: memberId,
          shop_name: company,
          company_name: company,
          shop_url: location.href,
          login_id: "",
          identity_tags: [],
          service_tags: [],
          snippet: text
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 40),
        };
      }, mid);
      return tmapiOk(info);
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop info failed");
  } finally {
    releaseBrowser(browser);
  }
}

/** GET /1688/shop/cats */
export async function getShopCategories({
  shop_url,
  member_id,
  language = "zh",
} = {}) {
  const mid = extractMemberId(shop_url, member_id);
  if (!mid) return tmapiError(422, "member_id or shop_url is required");
  const lang = normalizeLang(language);
  const url = `https://winport.m.1688.com/page/offerlist.html?memberId=${encodeURIComponent(mid)}`;
  const browser = await acquirePooledBrowser();
  try {
    const context = await newAuthedContext(browser, {
      isMobile: true,
      hasTouch: true,
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 390, height: 844 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(3000);
      const cats = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        for (const a of document.querySelectorAll("a,button,span,li")) {
          const name = (a.textContent || "").trim();
          if (!name || name.length > 30 || name.length < 2) continue;
          if (!/分类|全部|类目|category|cat/i.test(name) && name.length > 12) continue;
          if (/登录|客服|关注|分享|首页/.test(name)) continue;
          const href = a.href || "";
          const catId =
            (href.match(/cat(?:egory)?Id?=(\d+)/i) ||
              href.match(/shop_cat[^=]*=(\d+)/i) ||
              [])[1] || "";
          const key = `${name}|${catId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (/分类|全部商品|类目|产品/.test(name) || catId) {
            out.push({
              cat_id: catId || null,
              name,
              url: href || null,
            });
          }
          if (out.length >= 40) break;
        }
        return out;
      });
      return tmapiOk({
        member_id: mid,
        shop_url: url,
        categories: cats,
      });
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop categories failed");
  } finally {
    releaseBrowser(browser);
  }
}

/** GET /1688/search/items — TMAPI keyword search */
export async function searchItemsTmapi({
  keyword,
  page = 1,
  page_size = 20,
  sort = "default",
  language = "zh",
  cat_id = "",
} = {}) {
  const q = String(keyword || "").trim();
  if (!q && !cat_id) return tmapiError(422, "keyword or cat_id is required");
  try {
    const auth = await assertAuthLooksValid();
    const proxy = proxyStatus();
    if (!auth.ok && !proxy.enabled) {
      return tmapiError(
        500,
        `No valid 1688 login (${auth.reason}) and proxy disabled. Run npm run login or enable proxy.`
      );
    }

    if (cat_id && !q) {
      return getCategoryProducts({
        cat_id,
        page,
        page_size,
        language,
        sort,
      });
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
    if (formatted.data.items.length > formatted.data.page_size) {
      formatted.data.items = formatted.data.items.slice(0, formatted.data.page_size);
    }
    return formatted;
  } catch (err) {
    return tmapiError(500, err.message || "search failed");
  }
}

/**
 * GET/POST /1688/search/image
 * GET/POST /1688/global/search/image[/v2]
 */
export async function searchByImage({
  img_url,
  page = 1,
  page_size = 20,
  language = "zh",
  sort = "default",
} = {}) {
  const img = String(img_url || "").trim();
  if (!img) return tmapiError(422, "img_url is required");
  const lang = normalizeLang(language);
  const pageNo = Math.max(1, Number(page) || 1);
  const size = Math.min(20, Math.max(1, Number(page_size) || 20));
  const browser = await acquirePooledBrowser();

  try {
    const context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    await withLangCookies(context, lang);
    const p = await context.newPage();
    try {
      const searchUrl =
        "https://s.1688.com/selloffer/offer_search.htm?keywords=&imageAddress=" +
        encodeURIComponent(img) +
        `&beginPage=${pageNo}`;
      await p.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(4000);

      let items = await p.evaluate(() => {
        const list = window.data?.offerV2Showed?.offerList;
        if (Array.isArray(list) && list.length) {
          return list.map((it) => ({
            offerId: String(it.offerId || ""),
            title: String(it.title || "").replace(/<[^>]+>/g, ""),
            price: it.priceInfo?.price || it.price || null,
            image: it.offerPicUrl || null,
            company: it.companyName || null,
            sales: it.bookedCount != null ? String(it.bookedCount) : null,
            location: [it.province, it.city].filter(Boolean).join("") || null,
            member_id: it.sellerMemberId || it.memberId || "",
            login_id: it.loginId || "",
            isAd: false,
          }));
        }
        return [];
      });

      if (!items.length) {
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
            if (out.length >= 40) break;
          }
          return out;
        });
      }

      if (lang === "en" && items.length) {
        const titles = await translateTexts(items.map((i) => i.title));
        items = items.map((it, i) => ({ ...it, title: titles[i] || it.title }));
      }

      const sliced = items.slice(0, size);
      return toTmapiSearch(
        { results: sliced, total: items.length },
        {
          keyword: "[image]",
          page: pageNo,
          page_size: size,
          sort,
        }
      );
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "image search failed");
  } finally {
    releaseBrowser(browser);
  }
}

/**
 * GET /1688/search/factory
 * Company search is captcha-heavy; derive unique factories from product search.
 */
export async function searchFactories({
  keywords,
  keyword,
  page = 1,
  page_size = 20,
  sort = "default",
  language = "zh",
} = {}) {
  const q = String(keywords || keyword || "").trim();
  if (!q) return tmapiError(422, "keywords is required");
  const lang = normalizeLang(language);
  const pageNo = Math.max(1, Number(page) || 1);
  const size = Math.min(20, Math.max(1, Number(page_size) || 20));

  try {
    const raw = await searchOffers(q, { page: pageNo, lang });
    const byKey = new Map();
    for (const it of raw.results || []) {
      const key = it.company || it.login_id || it.offerId;
      if (!key || byKey.has(key)) continue;
      byKey.set(key, {
        member_id: it.member_id || "",
        company_name: it.company || "",
        login_id: it.login_id || "",
        shop_url: it.member_id
          ? `https://winport.m.1688.com/page/index.html?memberId=${it.member_id}`
          : "",
        location: it.location || "",
        shop_repurchase_rate: it.repurchaseRate || null,
        sample_item_id: it.offerId || "",
        sample_title: it.title || "",
        identity_tags: it.tags || [],
      });
    }
    const all = [...byKey.values()];
    // enrich from desktop offer objects if present via another scrape pass is too heavy;
    // titles already translated when lang=en by searchOffers
    void sort;
    return tmapiOk({
      page: pageNo,
      page_size: size,
      total_count: String(all.length),
      keywords: q,
      sort,
      items: all.slice(0, size),
    });
  } catch (err) {
    return tmapiError(500, err.message || "factory search failed");
  }
}

/** GET /1688/category/info */
export async function getCategoryInfo({ cat_id = "", language = "zh" } = {}) {
  const cat = String(cat_id || "").trim();
  const lang = normalizeLang(language);
  const browser = await acquirePooledBrowser();
  try {
    const context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      const url = cat
        ? `https://s.1688.com/selloffer/offer_search.htm?keywords=*&filt=y&n=y&categoryId=${encodeURIComponent(cat)}&beginPage=1`
        : `https://s.1688.com/selloffer/offer_search.htm?keywords=*&beginPage=1`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(4000);

      const info = await page.evaluate((categoryId) => {
        const data = window.data || {};
        const filters =
          data.filterData ||
          data.offerresultData?.data?.filterList ||
          data.abResultData?.filterList ||
          [];
        const children = [];
        const walk = (nodes) => {
          if (!Array.isArray(nodes)) return;
          for (const n of nodes) {
            const id = String(n.id || n.catId || n.categoryId || "");
            const name = n.name || n.text || n.title || "";
            if (id && name) children.push({ cat_id: id, name });
            if (n.children) walk(n.children);
            if (n.subList) walk(n.subList);
          }
        };
        walk(filters);

        // also parse visible category chips
        for (const a of document.querySelectorAll("a")) {
          const href = a.href || "";
          const m = href.match(/categoryId=(\d+)/i);
          const name = (a.textContent || "").trim();
          if (m && name && name.length < 40) {
            children.push({ cat_id: m[1], name });
          }
        }

        const uniq = [];
        const seen = new Set();
        for (const c of children) {
          if (seen.has(c.cat_id)) continue;
          seen.add(c.cat_id);
          uniq.push(c);
        }

        return {
          cat_id: categoryId || null,
          name: categoryId
            ? document.title?.split("-")[0]?.trim() || String(categoryId)
            : "root",
          path: categoryId ? [String(categoryId)] : [],
          children: uniq.slice(0, 100),
        };
      }, cat);

      if (lang === "en" && info.children?.length) {
        const names = await translateTexts(info.children.map((c) => c.name));
        info.children = info.children.map((c, i) => ({
          ...c,
          name: names[i] || c.name,
        }));
      }

      return tmapiOk(info);
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "category info failed");
  } finally {
    releaseBrowser(browser);
  }
}

/** GET /1688/category/products[+ /v2] */
export async function getCategoryProducts({
  cat_id,
  keyword = "*",
  page = 1,
  page_size = 20,
  language = "zh",
  sort = "default",
} = {}) {
  const cat = String(cat_id || "").trim();
  if (!cat && !keyword) {
    return tmapiError(422, "cat_id or keyword is required");
  }
  const lang = normalizeLang(language);
  const pageNo = Math.max(1, Number(page) || 1);
  const size = Math.min(20, Math.max(1, Number(page_size) || 20));

  if (!cat) {
    return searchItemsTmapi({ keyword, page, page_size, sort, language });
  }

  const browser = await acquirePooledBrowser();
  try {
    const context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      const kw = keyword && keyword !== "*" ? keyword : "*";
      const url =
        `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(kw)}` +
        `&filt=y&n=y&categoryId=${encodeURIComponent(cat)}&beginPage=${pageNo}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(4500);

      let items = await page.evaluate(() => {
        const list = window.data?.offerV2Showed?.offerList || [];
        return list.map((it) => ({
          offerId: String(it.offerId || ""),
          title: String(it.title || "").replace(/<[^>]+>/g, ""),
          price: it.priceInfo?.price || it.price || null,
          image: it.offerPicUrl || null,
          company: it.companyName || null,
          sales: it.bookedCount != null ? String(it.bookedCount) : null,
          location: [it.province, it.city].filter(Boolean).join("") || null,
          member_id: it.sellerMemberId || "",
          login_id: it.loginId || "",
          isAd: it.isBid === "true",
        }));
      });

      const total =
        (await page.evaluate(
          () =>
            Number(
              window.data?.offerresultData?.data?.totalCount ||
                window.data?.abResultData?.totalCount ||
                0
            ) || null
        )) || items.length;

      if (lang === "en" && items.length) {
        const titles = await translateTexts(items.map((i) => i.title));
        items = items.map((it, i) => ({ ...it, title: titles[i] || it.title }));
      }

      return toTmapiSearch(
        { results: items.slice(0, size), total },
        {
          keyword: kw === "*" ? `[cat:${cat}]` : kw,
          page: pageNo,
          page_size: size,
          sort,
        }
      );
    } finally {
      await context.close();
    }
  } catch (err) {
    return tmapiError(500, err.message || "category products failed");
  } finally {
    releaseBrowser(browser);
  }
}

/** Cross-border multilingual keyword search → same shape as search/items */
export async function searchItemsCrossBorder(opts = {}) {
  return searchItemsTmapi({
    ...opts,
    language: opts.language || "en",
  });
}

/** Cross-border image search → same as search/image with language default en */
export async function searchByImageCrossBorder(opts = {}) {
  return searchByImage({
    ...opts,
    language: opts.language || "en",
  });
}
