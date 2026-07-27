/**
 * Extra 1688 scrapers for TMAPI-compatible endpoints.
 */
import { acquirePooledBrowser, releaseBrowser } from "./browser.js";
import { newAuthedContext, assertAuthLooksValid } from "./auth.js";
import { proxyStatus } from "./proxy.js";
import {
  markIfTranslationIncomplete,
  markResponseUncacheable,
  normalizeLang,
  translateTexts,
} from "./translate.js";
import {
  tmapiOk,
  tmapiError,
  toTmapiSearch,
  toTmapiShopItems,
} from "./tmapiExtra.js";
import { searchOffers } from "./search.js";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import { fetchMobileSearchPage } from "./mobileSearch.js";
import { fetchMtopSearchPage } from "./mtopSearch.js";
import {
  fetchShopCategoriesHttp,
  fetchShopInfoHttp,
  fetchShopItemsHttp,
} from "./shopHttp.js";
import {
  getItemFreightMtop,
  getItemReviewsMtop,
  searchByImageMtop,
} from "./mtopExtra.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assertNotLoginPage(page, operation) {
  if (/login\.(?:taobao|1688)\.com|member\/signin/i.test(page.url())) {
    throw new Error(
      `1688 login session expired while loading ${operation}; run npm run login`
    );
  }
}

const TOP_CATEGORIES = [
  ["130823000", "Adult Products"], ["1", "Agriculture"], ["54", "Apparel Accessories & Jewelry"],
  ["71", "Automobiles, Motorcycles & Accessories"], ["122916002", "Automotive Supplies"],
  ["97", "Beauty Skincare/Makeup"], ["201346017", "Building Materials"], ["69", "Business Services"],
  ["130822002", "Catering & Fresh Food"], ["8", "Chemicals"], ["311", "Children's Wear"],
  ["509", "Communication Product"], ["201547801", "Daily Use Kitchenware & Drinkware"],
  ["7", "Digital & Computer"], ["5", "Electrical & Electronic"], ["57", "Electronic Components"],
  ["10", "Energy"], ["64", "Environmental Protection"], ["2", "Food & Beverage"],
  ["59", "Hardware & Tools"], ["6", "Home Appliances"], ["13", "Home Improvement & Building Materials"],
  ["96", "Home Textiles & Decor"], ["15", "Household Daily Necessities"], ["10208", "Instruments & Meters"],
  ["123614001", "Iron & Steel"], ["58", "Lighting Fixtures"], ["1042954", "Luggage, Bags & Leather Goods"],
  ["65", "Machinery & Industrial Equipment"], ["1426", "Machine Tool"], ["53", "Media & Broadcasting"],
  ["10165", "Men's Wear"], ["9", "Minerals & Metallurgy"], ["202052814", "New Energy"],
  ["67", "Office & Culture"], ["68", "Packaging"], ["130822220", "Personal Care/Home Cleaning"],
  ["122916001", "Pets & Gardening"], ["66", "Pharmaceuticals & Healthcare"], ["72", "Printing"],
  ["2805", "Processing"], ["55", "Rubber & Plastics"], ["70", "Safety & Protection"],
  ["1038378", "Shoes"], ["18", "Sports & Outdoors"], ["201547901", "Storage & Cleaning Utensils"],
  ["4", "Textiles & Leather Products"], ["1813", "Toys"], ["12", "Transportation"],
  ["312", "Underwear"], ["2829", "Used Equipment Transfer"], ["10166", "Women's Clothing"],
].map(([id, name]) => ({ id, name, name_en: name, level: 0, children: [] }));

const KNOWN_CATEGORY_CHILDREN = {
  "130823000": [
    ["126144003", "Adult Toys & Novelties"],
    ["123862005", "Family Planning Products"],
    ["126178001", "Female Toys"],
    ["126150002", "Male Toys"],
  ],
};

function knownCategory(categoryId) {
  return TOP_CATEGORIES.find((category) => category.id === String(categoryId || ""));
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
  let context = null;
  try {
    context = await newAuthedContext(browser, {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    await page.goto(`https://detail.1688.com/offer/${itemId}.html`, {
      waitUntil: "domcontentloaded",
      timeout: 40_000,
    });
    assertNotLoginPage(page, "item detail");
    await page
      .waitForFunction(() => Boolean(window.context?.result?.data), null, {
        timeout: 12_000,
      })
      .catch(() => {});
    return { context, page };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    throw err;
  }
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
        detail_imgs: extracted.images,
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
  void language;
  return getItemReviewsMtop(itemId, { page, page_size });
}

/** GET /1688/item_freight — shipping fee / delivery info from offer page */
export async function getItemFreight(
  itemId,
  {
    language = "zh",
    province = "",
    total_quantity = 1,
    total_weight = 0,
  } = {}
) {
  void language;
  return getItemFreightMtop(itemId, {
    province,
    total_quantity,
    total_weight,
  });
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

function normalizeSort(sort) {
  const value = String(sort || "default")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (["sales", "sales_desc", "booked"].includes(value)) return "sales";
  if (["price_up", "priceup", "price_asc"].includes(value)) return "price_up";
  if (["price_down", "pricedown", "price_desc"].includes(value)) {
    return "price_down";
  }
  if (["new", "newest", "new_offer"].includes(value)) return "newest";
  return "default";
}

function numericOfferValue(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  let number = Number(match[0]);
  if (/万/.test(text)) number *= 10_000;
  return Number.isFinite(number) ? number : null;
}

function normalizePriceRange(priceStart, priceEnd) {
  const startText = String(priceStart ?? "").trim();
  const endText = String(priceEnd ?? "").trim();
  const start = startText === "" ? null : Number(startText);
  const end = endText === "" ? null : Number(endText);
  if (start != null && (!Number.isFinite(start) || start < 0)) {
    return { error: "price_start must be a non-negative number" };
  }
  if (end != null && (!Number.isFinite(end) || end < 0)) {
    return { error: "price_end must be a non-negative number" };
  }
  if (start != null && end != null && start > end) {
    return { error: "price_start must not be greater than price_end" };
  }
  return {
    priceStart: start == null ? "" : String(start),
    priceEnd: end == null ? "" : String(end),
  };
}

function filterAndSortOffers(
  items,
  { price_start = "", price_end = "", sort = "default" } = {}
) {
  let output = [...(items || [])];
  const minPrice = price_start !== "" ? Number(price_start) : null;
  const maxPrice = price_end !== "" ? Number(price_end) : null;
  if (Number.isFinite(minPrice)) {
    output = output.filter((item) => {
      const price = numericOfferValue(item.price);
      return price != null && price >= minPrice;
    });
  }
  if (Number.isFinite(maxPrice)) {
    output = output.filter((item) => {
      const price = numericOfferValue(item.price);
      return price != null && price <= maxPrice;
    });
  }
  const normalized = normalizeSort(sort);
  if (normalized === "price_up" || normalized === "price_down") {
    const direction = normalized === "price_up" ? 1 : -1;
    output.sort((left, right) => {
      const leftPrice = numericOfferValue(left.price);
      const rightPrice = numericOfferValue(right.price);
      // Incomplete network-captured cards must stay behind priced products for
      // both ascending and descending order.
      if (leftPrice == null) return rightPrice == null ? 0 : 1;
      if (rightPrice == null) return -1;
      return direction * (leftPrice - rightPrice);
    });
  } else if (normalized === "sales") {
    output.sort(
      (left, right) =>
        (numericOfferValue(right.sales ?? right.sale_quantity) ?? 0) -
        (numericOfferValue(left.sales ?? left.sale_quantity) ?? 0)
    );
  }
  return output;
}

function applySearchSort(params, sort) {
  const normalized = normalizeSort(sort);
  const sortType = {
    sales: "booked",
    price_up: "price-asc",
    price_down: "price-desc",
    newest: "newOffer",
  }[normalized];
  if (sortType) params.set("sortType", sortType);
}

function applyShopSort(params, sort) {
  const normalized = normalizeSort(sort);
  const sortType = {
    sales: "volume_desc",
    price_up: "price_asc",
    price_down: "price_desc",
    newest: "create_desc",
  }[normalized];
  if (sortType) params.set("sortType", sortType);
}

function shopOfferListUrl(
  shopUrl,
  memberId,
  pageNo,
  { pageSize, categoryId, sort, priceStart, priceEnd, keyword } = {}
) {
  let target;
  if (memberId) {
    target = new URL("https://winport.m.1688.com/page/offerlist.html");
    target.searchParams.set("memberId", memberId);
  } else {
    const raw = String(shopUrl || "").trim();
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.toLowerCase();
      if (
        parsed.protocol !== "https:" ||
        !(hostname === "1688.com" || hostname.endsWith(".1688.com"))
      ) {
        return "";
      }
      target = new URL("/page/offerlist.html", parsed.origin);
    } catch {
      return "";
    }
  }

  target.searchParams.set("pageNum", String(pageNo));
  if (pageSize) target.searchParams.set("pageSize", String(pageSize));
  if (categoryId) target.searchParams.set("categoryId", String(categoryId));
  if (keyword) {
    target.searchParams.set("keyword", String(keyword));
    target.searchParams.set("keywords", String(keyword));
  }
  if (priceStart !== "") target.searchParams.set("priceStart", String(priceStart));
  if (priceEnd !== "") target.searchParams.set("priceEnd", String(priceEnd));
  applyShopSort(target.searchParams, sort);
  return target.toString();
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
  cat_id = "",
  price_start = "",
  price_end = "",
  language = "zh",
} = {}) {
  let mid = extractMemberId(shop_url, member_id);
  const priceRange = normalizePriceRange(price_start, price_end);
  if (priceRange.error) return tmapiError(422, priceRange.error);
  price_start = priceRange.priceStart;
  price_end = priceRange.priceEnd;
  const lang = normalizeLang(language);
  const pageNo = Math.max(1, Number(page) || 1);
  const size = Math.min(50, Math.max(1, Number(page_size) || 20));
  const selectedCategoryId = String(shop_cat_id || cat_id || "").trim();
  const listOptions = {
    pageSize: size,
    categoryId: selectedCategoryId,
    sort,
    priceStart: price_start,
    priceEnd: price_end,
    keyword: String(keyword || "").trim(),
  };
  let offerListUrl = shopOfferListUrl(shop_url, mid, pageNo, listOptions);
  if (!offerListUrl) {
    return tmapiError(422, "member_id or a valid 1688 shop_url is required");
  }

  if (proxyStatus().enabled && mid) {
    try {
      const direct = await fetchShopItemsHttp({
        memberId: mid,
        page: pageNo,
        pageSize: size,
        categoryId: selectedCategoryId,
        sort,
        priceStart: price_start,
        priceEnd: price_end,
        keyword: String(keyword || "").trim(),
      });
      let pageItems = filterAndSortOffers(direct.items, {
        price_start,
        price_end,
        sort,
      });
      if (keyword) {
        const needle = String(keyword).toLowerCase();
        pageItems = pageItems.filter((item) =>
          String(item.title || "").toLowerCase().includes(needle)
        );
      }
      let translatedTitles = null;
      if (lang === "en" && pageItems.length) {
        translatedTitles = await translateTexts(pageItems.map((item) => item.title));
        pageItems.forEach((item, index) => {
          item.title = translatedTitles[index] || item.title;
        });
      }
      const response = toTmapiShopItems(
        { total_count: direct.totalCount, items: pageItems },
        {
          page: pageNo,
          page_size: size,
          sort,
          keyword,
          cat: selectedCategoryId,
        }
      );
      response.data.has_next_page = direct.hasNext;
      return markIfTranslationIncomplete(response, translatedTitles);
    } catch (err) {
      const signal = currentJobSignal();
      if (signal?.aborted || err?.cancelled || err?.code === 499) {
        throw jobAbortError(signal);
      }
      // Preserve the authenticated Chromium path for unusual shop URLs and
      // transient proxy/1688 failures.
    }
  }
  const browser = await acquirePooledBrowser();
  let context = null;

  try {
    context = await newAuthedContext(browser, {
      isMobile: true,
      hasTouch: true,
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 390, height: 844 },
    });
    await withLangCookies(context, lang);
    const p = await context.newPage();
    const netIds = new Set();
    let networkTotal = null;
    let onResp = null;

    try {
      if (!mid && shop_url) {
        await p.goto(String(shop_url), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        assertNotLoginPage(p, "shop");
        const source = await p.content();
        const match =
          source.match(/(?:memberId|member_id|sellerMemberId)["'\s:=\\]+(b2b-[a-z0-9_-]+)/i) ||
          p.url().match(/[?&]memberId=(b2b-[^&]+)/i);
        if (match?.[1]) {
          mid = decodeURIComponent(match[1]);
          offerListUrl = shopOfferListUrl("", mid, pageNo, listOptions);
        }
      }
      let signalNetworkReady;
      const networkReady = new Promise((resolveReady) => {
        signalNetworkReady = resolveReady;
      });
      onResp = async (res) => {
        try {
          const responseUrl = res.url();
          if (!/winport\.m\.1688\.com|asyncView|mtop/i.test(responseUrl)) return;
          if (res.status() < 200 || res.status() >= 300) return;
          if (!["document", "xhr", "fetch"].includes(res.request().resourceType())) return;
          const headers = res.headers();
          const contentLength = Number(headers["content-length"] || 0);
          if (contentLength > 2_000_000) return;
          const contentType = headers["content-type"] || "";
          if (contentType && !/json|javascript|text|html/i.test(contentType)) return;
          const text = await res.text();
          if (text && text.length < 2_000_000) {
            collectOfferIdsFromText(text, netIds);
            for (const match of text.matchAll(
              /["'](?:totalCount|total_count|total)["']\s*:\s*["']?(\d+)/gi
            )) {
              const value = Number(match[1]);
              if (Number.isFinite(value)) {
                networkTotal = Math.max(networkTotal ?? 0, value);
              }
            }
          }
          if (netIds.size > 0) signalNetworkReady();
        } catch {
          /* ignore */
        }
      };
      p.on("response", onResp);
      await p.goto(offerListUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assertNotLoginPage(p, "shop items");
      const domReady = p
        .waitForFunction(
          () =>
            /login\.(?:taobao|1688)\.com|member\/signin/i.test(location.href) ||
            document.querySelectorAll(
              "a[href*='offer/'], [offerid], [data-offer-id]"
            ).length > 0,
          null,
          { timeout: 6_000 }
        )
        .catch(() => null);
      await Promise.race([networkReady, domReady, p.waitForTimeout(6_000)]);
      assertNotLoginPage(p, "shop items");
      for (let i = 0; i < 2; i++) {
        await p.evaluate(() => window.scrollBy(0, 700));
        await sleep(200);
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
        const pageData = window.data || window.__INITIAL_STATE__ || {};
        const totalCandidate =
          pageData.totalCount ??
          pageData.total ??
          pageData.offerList?.totalCount ??
          pageData.offerList?.total ??
          pageData.offerListData?.totalCount ??
          null;
        const textTotal = (
          (document.body?.innerText || "").match(/(?:å…±|共)\s*([\d,ï¼Œ]+)\s*(?:ä»¶|件)/) ||
          []
        )[1];
        const parsedTextTotal = textTotal
          ? Number(String(textTotal).replace(/[,ï¼Œ]/g, ""))
          : null;
        return {
          company,
          items,
          member_id: null,
          total:
            totalCandidate != null && Number.isFinite(Number(totalCandidate))
              ? Number(totalCandidate)
              : Number.isFinite(parsedTextTotal)
                ? parsedTextTotal
                : null,
        };
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
      items = filterAndSortOffers(items, { price_start, price_end, sort });

      // The upstream URL already selects pageNo. Only cap that page to page_size;
      // applying the page offset again made every page after page 1 go empty.
      const pageItems = items.slice(0, size);

      const knownTotal = networkTotal ?? scraped.total;
      if (!pageItems.length && knownTotal !== 0) {
        return tmapiError(502, "No shop products were extracted from 1688");
      }

      let translatedTitles = null;
      if (lang === "en" && pageItems.length) {
        translatedTitles = await translateTexts(
          pageItems.map((i) => i.title || i.item_id)
        );
        for (let i = 0; i < pageItems.length; i++) {
          if (pageItems[i].title) {
            pageItems[i].title = translatedTitles[i] || pageItems[i].title;
          }
        }
      }

      return markIfTranslationIncomplete(toTmapiShopItems(
        {
          total_count:
            knownTotal ??
            (pageNo - 1) * size + pageItems.length +
              (pageItems.length >= size ? 1 : 0),
          items: pageItems,
        },
        {
          page: pageNo,
          page_size: size,
          sort,
          keyword,
          cat: selectedCategoryId,
        }
      ), translatedTitles);
    } finally {
      if (onResp) p.off("response", onResp);
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop items failed");
  } finally {
    if (context) await context.close().catch(() => {});
    releaseBrowser(browser);
  }
}

/** GET /1688/shop/info */
export async function getShopInfo({ shop_url, member_id, language = "zh" } = {}) {
  const mid = extractMemberId(shop_url, member_id);
  if (!mid) return tmapiError(422, "member_id or shop_url is required");
  const lang = normalizeLang(language);
  const url = `https://winport.m.1688.com/page/index.html?memberId=${encodeURIComponent(mid)}`;

  if (proxyStatus().enabled) {
    try {
      const info = await fetchShopInfoHttp({ memberId: mid });
      let translated = null;
      if (lang === "en") {
        translated = await translateTexts([info.shop_name, info.description]);
        info.shop_name = translated[0] || info.shop_name;
        info.company_name = info.shop_name;
        info.description = translated[1] || info.description;
      }
      return markIfTranslationIncomplete(tmapiOk(info), translated);
    } catch (err) {
      const signal = currentJobSignal();
      if (signal?.aborted || err?.cancelled || err?.code === 499) {
        throw jobAbortError(signal);
      }
    }
  }
  const browser = await acquirePooledBrowser();
  let context = null;
  try {
    context = await newAuthedContext(browser, {
      isMobile: true,
      hasTouch: true,
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 390, height: 844 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assertNotLoginPage(page, "shop info");
      await page
        .waitForFunction(
          () =>
            /login\.(?:taobao|1688)\.com|member\/signin/i.test(location.href) ||
            Boolean(
              document.querySelector(
                "h1,h2,[class*='company'],[class*='shop-name']"
              )?.textContent?.trim()
            ),
          null,
          { timeout: 5_000 }
        )
        .catch(() => {});
      assertNotLoginPage(page, "shop info");
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
      await page.close().catch(() => {});
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop info failed");
  } finally {
    if (context) await context.close().catch(() => {});
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

  if (proxyStatus().enabled) {
    try {
      const result = await fetchShopCategoriesHttp({ memberId: mid });
      let translated = null;
      if (lang === "en") {
        translated = await translateTexts(result.categories.map((category) => category.name));
        result.categories.forEach((category, index) => {
          const name = translated[index] || category.name;
          category.name = name;
          category.cat_name = name;
          category.category_name = name;
        });
      }
      return markIfTranslationIncomplete(tmapiOk(result), translated);
    } catch (err) {
      const signal = currentJobSignal();
      if (signal?.aborted || err?.cancelled || err?.code === 499) {
        throw jobAbortError(signal);
      }
    }
  }
  const browser = await acquirePooledBrowser();
  let context = null;
  try {
    context = await newAuthedContext(browser, {
      isMobile: true,
      hasTouch: true,
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 390, height: 844 },
    });
    await withLangCookies(context, lang);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assertNotLoginPage(page, "shop categories");
      await page
        .waitForFunction(
          () =>
            /login\.(?:taobao|1688)\.com|member\/signin/i.test(location.href) ||
            document.querySelectorAll(
              "a[href*='cat'], a[href*='category'], [class*='category']"
            ).length > 0,
          null,
          { timeout: 5_000 }
        )
        .catch(() => {});
      assertNotLoginPage(page, "shop categories");
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
      if (!cats.length) {
        return tmapiError(502, "No shop categories were extracted from 1688");
      }
      return tmapiOk({
        member_id: mid,
        shop_url: url,
        categories: cats,
        list: cats,
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    return tmapiError(500, err.message || "shop categories failed");
  } finally {
    if (context) await context.close().catch(() => {});
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
  price_start = "",
  price_end = "",
} = {}) {
  const q = String(keyword || "").trim();
  if (!q && !cat_id) return tmapiError(422, "keyword or cat_id is required");
  const priceRange = normalizePriceRange(price_start, price_end);
  if (priceRange.error) return tmapiError(422, priceRange.error);
  price_start = priceRange.priceStart;
  price_end = priceRange.priceEnd;
  try {
    const auth = await assertAuthLooksValid();
    const proxy = proxyStatus();
    if (!auth.ok && !proxy.enabled) {
      return tmapiError(
        500,
        `No valid 1688 login (${auth.reason}) and proxy disabled. Run npm run login or enable proxy.`
      );
    }

    if (cat_id) {
      return getCategoryProducts({
        cat_id,
        keyword: q || "*",
        page,
        page_size,
        language,
        sort,
        price_start,
        price_end,
      });
    }

    const raw = await searchOffers(q, {
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(50, Math.max(1, Number(page_size) || 20)),
      lang: normalizeLang(language),
      sort,
      priceStart: price_start,
      priceEnd: price_end,
    });
    const filteredResults = filterAndSortOffers(raw.results, {
      price_start,
      price_end,
      sort,
    });
    const filtered = {
      ...raw,
      results: filteredResults,
      total: raw.total,
    };
    const formatted = toTmapiSearch(filtered, {
      keyword: q,
      page: raw.page,
      page_size: Math.min(50, Math.max(1, Number(page_size) || raw.pageSize || 20)),
      sort,
    });
    if (formatted.data.items.length > formatted.data.page_size) {
      formatted.data.items = formatted.data.items.slice(0, formatted.data.page_size);
    }
    return raw.__scraperNoCache || raw.__translationIncomplete
      ? markResponseUncacheable(formatted)
      : formatted;
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
  return searchByImageMtop({ img_url, page, page_size, language, sort });
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
    const raw = await searchOffers(q, { page: pageNo, lang, sort });
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
    const response = tmapiOk({
      page: pageNo,
      page_size: size,
      total_count: String(all.length),
      keywords: q,
      sort,
      items: all.slice(0, size),
    });
    return raw.__scraperNoCache || raw.__translationIncomplete
      ? markResponseUncacheable(response)
      : response;
  } catch (err) {
    return tmapiError(500, err.message || "factory search failed");
  }
}

/** GET /1688/category/info */
export async function getCategoryInfo({ cat_id = "", language = "zh" } = {}) {
  const cat = String(cat_id || "").trim();
  const lang = normalizeLang(language);
  if (!cat) return tmapiOk(TOP_CATEGORIES);

  const known = knownCategory(cat);
  if (known) {
    const children = (KNOWN_CATEGORY_CHILDREN[cat] || []).map(([id, name]) => ({
      id,
      name,
      name_en: name,
      level: 1,
      has_children: true,
    }));
    return tmapiOk({
      ...known,
      children,
      path: [{ id: known.id, name: known.name, name_en: known.name_en }],
      has_children: children.length > 0,
    });
  }
  const browser = await acquirePooledBrowser();
  let context = null;
  try {
    context = await newAuthedContext(browser, {
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
      await page
        .waitForFunction(
          () =>
            /login\.(?:taobao|1688)\.com|member\/signin/i.test(location.href) ||
            Boolean(window.data) ||
            document.querySelectorAll("a[href*='categoryId=']").length > 0,
          null,
          { timeout: 8_000 }
        )
        .catch(() => {});
      assertNotLoginPage(page, "category info");

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

      let translatedNames = null;
      if (lang === "en" && info.children?.length) {
        translatedNames = await translateTexts(info.children.map((c) => c.name));
        info.children = info.children.map((c, i) => ({
          ...c,
          name: translatedNames[i] || c.name,
        }));
      }

      return markIfTranslationIncomplete(tmapiOk(info), translatedNames);
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    return tmapiError(500, err.message || "category info failed");
  } finally {
    if (context) await context.close().catch(() => {});
    releaseBrowser(browser);
  }
}

const CATEGORY_MERGE_TTL_MS = Math.max(
  30_000,
  Number(process.env.CATEGORY_MERGE_TTL_MS) || 2 * 60 * 1000
);
const CATEGORY_MERGE_MAX_STATES = Math.max(
  4,
  Math.min(100, Number(process.env.CATEGORY_MERGE_MAX_STATES) || 24)
);
const CATEGORY_MERGE_MAX_RESULTS = Math.max(
  100,
  Math.min(5_000, Number(process.env.CATEGORY_MERGE_MAX_RESULTS) || 1_000)
);
const CATEGORY_PAGE_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.CATEGORY_PAGE_CONCURRENCY) || 3)
);
const CATEGORY_MAX_UPSTREAM_PAGES = Math.max(
  3,
  Math.min(100, Number(process.env.CATEGORY_MAX_UPSTREAM_PAGES) || 30)
);
const categoryMergeStates = new Map();

function categoryPaging(page, pageSize) {
  const pageNo = Number(page);
  const size = Number(pageSize);
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) {
    return { error: "page must be a positive integer" };
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > 50) {
    return { error: "page_size must be an integer between 1 and 50" };
  }
  const offset = (pageNo - 1) * size;
  if (!Number.isSafeInteger(offset)) return { error: "page is too large" };
  return { pageNo, size, offset, end: offset + size };
}

function pruneCategoryMergeStates() {
  const cutoff = Date.now() - CATEGORY_MERGE_TTL_MS;
  for (const [key, state] of categoryMergeStates) {
    if (state.lastUsed < cutoff) categoryMergeStates.delete(key);
  }
  while (categoryMergeStates.size >= CATEGORY_MERGE_MAX_STATES) {
    const oldest = [...categoryMergeStates.entries()].sort(
      (left, right) => left[1].lastUsed - right[1].lastUsed
    )[0];
    if (!oldest) break;
    categoryMergeStates.delete(oldest[0]);
  }
}

function categoryMergeState(key, categories) {
  pruneCategoryMergeStates();
  let state = categoryMergeStates.get(key);
  if (!state) {
    state = {
      lastUsed: Date.now(),
      lock: Promise.resolve(),
      streams: categories.map((categoryId) => ({
        categoryId,
        nextPage: 1,
        loadedPages: 0,
        total: null,
        items: [],
        cursor: 0,
        exhausted: false,
        rawIds: new Set(),
        sourceIds: new Set(),
      })),
      nextStream: 0,
      seen: new Map(),
      merged: [],
      rejected: 0,
      duplicates: 0,
      exhausted: false,
    };
    categoryMergeStates.set(key, state);
  }
  state.lastUsed = Date.now();
  return state;
}

async function withCategoryStateLock(state, task) {
  const previous = state.lock;
  let unlock;
  state.lock = new Promise((resolve) => {
    unlock = resolve;
  });
  const predecessor = previous.catch(() => {});
  const signal = currentJobSignal();
  let onAbort;
  try {
    if (signal?.aborted) throw jobAbortError(signal);
    if (signal) {
      await Promise.race([
        predecessor,
        new Promise((_, reject) => {
          onAbort = () => reject(jobAbortError(signal));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } else {
      await predecessor;
    }
  } catch (error) {
    // Preserve the lock chain for later callers without keeping this cancelled
    // request inside the scarce scrape queue.
    void predecessor.finally(unlock);
    throw error;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
  try {
    return await task();
  } finally {
    unlock();
  }
}

async function mapWithLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker())
  );
  return output;
}

export async function __extendCategoryMergeState(state, target, loadNeeded) {
  while (state.merged.length < target && !state.exhausted) {
    const needingData = state.streams.filter(
      (stream) => !stream.exhausted && stream.cursor >= stream.items.length
    );
    if (needingData.length) await loadNeeded(needingData);

    let progressed = false;
    for (let checked = 0; checked < state.streams.length; checked += 1) {
      const index = state.nextStream;
      state.nextStream = (state.nextStream + 1) % state.streams.length;
      const stream = state.streams[index];
      if (stream.cursor >= stream.items.length) continue;
      progressed = true;
      const item = stream.items[stream.cursor++];
      const offerId = String(item.offerId || item.item_id || "");
      if (!offerId) continue;
      const existing = state.seen.get(offerId);
      if (existing) {
        state.duplicates += 1;
        const knownPaths = new Set(
          (existing.category_path || []).map((node) => String(node.cat_id || node.id))
        );
        for (const node of item.category_path || []) {
          const nodeId = String(node.cat_id || node.id);
          if (!knownPaths.has(nodeId)) {
            existing.category_path.push(node);
            knownPaths.add(nodeId);
          }
        }
        continue;
      }
      state.seen.set(offerId, item);
      state.merged.push(item);
      if (state.merged.length >= target) break;
    }

    state.exhausted = state.streams.every(
      (stream) => stream.exhausted && stream.cursor >= stream.items.length
    );
    if (!progressed && !state.exhausted) {
      const canLoad = state.streams.some((stream) => !stream.exhausted);
      if (!canLoad) state.exhausted = true;
    }
    if (!progressed && state.exhausted) break;
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
  price_start = "",
  price_end = "",
} = {}) {
  const categories = [...new Set(
    String(cat_id || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (categories.some((value) => !/^\d{1,10}$/.test(value))) {
    return tmapiError(
      422,
      "cat_id/cat_ids must contain numeric category ids of at most 10 digits"
    );
  }
  if (categories.length > 5) {
    return tmapiError(422, "At most 5 category ids can be searched together");
  }
  const cat = categories.join(",");
  if (!categories.length && !keyword) {
    return tmapiError(422, "cat_id or keyword is required");
  }
  if (categories.length > 1 && normalizeSort(sort) !== "default") {
    return tmapiError(
      422,
      "Multi-category search currently supports sort=default; use the fallback provider for global sorted unions"
    );
  }
  const lang = normalizeLang(language);
  const paging = categoryPaging(page, page_size);
  if (paging.error) return tmapiError(422, paging.error);
  const { pageNo, size, offset: globalOffset, end: globalEnd } = paging;
  const needsUniqueLookahead = categories.length > 1;
  if (globalEnd + (needsUniqueLookahead ? 1 : 0) > CATEGORY_MERGE_MAX_RESULTS) {
    return tmapiError(
      422,
      `Category pagination is limited to the first ${CATEGORY_MERGE_MAX_RESULTS} unique results; use the fallback provider for deeper pages`
    );
  }
  const priceRange = normalizePriceRange(price_start, price_end);
  if (priceRange.error) return tmapiError(422, priceRange.error);
  price_start = priceRange.priceStart;
  price_end = priceRange.priceEnd;

  if (!categories.length) {
    return searchItemsTmapi({
      keyword,
      page,
      page_size,
      sort,
      language,
      price_start,
      price_end,
    });
  }
  const kw = keyword && keyword !== "*" ? String(keyword).trim() : "*";
  const normalizedSort = normalizeSort(sort);
  const stateKey = JSON.stringify([
    categories,
    kw,
    normalizedSort,
    price_start,
    price_end,
    lang,
  ]);
  const state = categoryMergeState(stateKey, categories);

  try {
    await withCategoryStateLock(state, async () => {
      const target = globalEnd + (needsUniqueLookahead ? 1 : 0);
      if (state.merged.length >= target || state.exhausted) return;

      let browser = null;
      let context = null;
      let contextPromise = null;
      const ensureBrowserContext = async () => {
        if (!contextPromise) {
          contextPromise = (async () => {
            browser = await acquirePooledBrowser();
            context = await newAuthedContext(browser, {
              locale: lang === "en" ? "en-US" : "zh-CN",
              viewport: { width: 1440, height: 900 },
            });
            await withLangCookies(context, lang);
            return context;
          })();
        }
        return contextPromise;
      };

      const processCategoryBatch = (stream, batch, upstreamPage) => {
        stream.nextPage = Math.max(stream.nextPage, upstreamPage + 1);
        stream.loadedPages += 1;
        if (batch.total != null) {
          stream.total = Math.max(Number(stream.total || 0), Number(batch.total));
        }
        const rawItems = batch.items.filter((item) => /^\d{8,}$/.test(item.offerId));
        const accepted = filterAndSortOffers(rawItems, {
          price_start,
          price_end,
          sort: "default",
        });
        const acceptedIds = new Set(accepted.map((item) => item.offerId));
        state.rejected += rawItems.filter(
          (item) => !acceptedIds.has(item.offerId)
        ).length;

        let sourceNew = 0;
        for (const item of rawItems) {
          if (stream.sourceIds.has(item.offerId)) continue;
          stream.sourceIds.add(item.offerId);
          sourceNew += 1;
        }
        const categoryName = knownCategory(stream.categoryId)?.name || "";
        for (const item of accepted) {
          if (stream.rawIds.has(item.offerId)) continue;
          stream.rawIds.add(item.offerId);
          stream.items.push({
            ...item,
            category_path: [
              {
                id: stream.categoryId,
                cat_id: stream.categoryId,
                name: categoryName,
              },
              ...(item.source_category_id &&
              item.source_category_id !== stream.categoryId
                ? [
                    {
                      id: item.source_category_id,
                      cat_id: item.source_category_id,
                      name: "",
                    },
                  ]
                : []),
            ],
          });
        }

        const rawCount = rawItems.length;
        const stride = batch.reportedPageSize || (upstreamPage === 1 ? rawCount : 0);
        if (
          rawCount === 0 ||
          sourceNew === 0 ||
          (stream.total != null && stream.sourceIds.size >= stream.total) ||
          (stride > 0 && rawCount < stride)
        ) {
          stream.exhausted = true;
        }
      };

      const scrapeCategoryPage = async (stream) => {
        if (stream.loadedPages >= CATEGORY_MAX_UPSTREAM_PAGES) {
          const error = new Error(
            "Category merge exceeded its bounded upstream-page budget"
          );
          error.tmapiCode = 422;
          throw error;
        }
        const upstreamPage = stream.nextPage;
        const activeStreams = Math.max(
          1,
          state.streams.filter((candidate) => !candidate.exhausted).length
        );
        const fairNeed = Math.max(
          1,
          Math.ceil((target - state.merged.length) / activeStreams)
        );
        const pageCount = Math.min(
          3,
          CATEGORY_MAX_UPSTREAM_PAGES - stream.loadedPages,
          Math.max(1, Math.ceil(fairNeed / 20))
        );
        const mobileKeyword =
          kw === "*"
            // The mobile route requires a path keyword even for category-only
            // queries. A neutral term keeps `catId` as the actual selector;
            // unknown IDs retain their numeric term so they cannot degrade to
            // an unfiltered product search.
            ? knownCategory(stream.categoryId)
              ? "product"
              : stream.categoryId
            : kw;
        let batches = null;
        if (kw === "*" || fairNeed > 20) {
          try {
            const result = await fetchMtopSearchPage({
              keyword: kw,
              categoryId: stream.categoryId,
              upstreamPage,
              sort: normalizedSort,
              priceStart: price_start,
              priceEnd: price_end,
            });
            batches = [{
              upstreamPage,
              batch: {
                total: result.total,
                reportedPageSize: result.reportedPageSize,
                items: result.items,
              },
            }];
          } catch (error) {
            const signal = currentJobSignal();
            if (signal?.aborted || error?.cancelled || error?.code === 499) {
              throw jobAbortError(signal);
            }
          }
        }
        if (!batches) {
          try {
            batches = await Promise.all(
              Array.from({ length: pageCount }, (_, index) => {
                const pageNumber = upstreamPage + index;
                return fetchMobileSearchPage({
                  keyword: mobileKeyword,
                  categoryId: stream.categoryId,
                  upstreamPage: pageNumber,
                  sort: normalizedSort,
                  priceStart: price_start,
                  priceEnd: price_end,
                }).then((result) => ({
                  upstreamPage: pageNumber,
                  batch: {
                    total: result.total,
                    reportedPageSize: null,
                    items: result.items,
                  },
                }));
              })
            );
          } catch (error) {
            const signal = currentJobSignal();
            if (signal?.aborted || error?.cancelled || error?.code === 499) {
              throw jobAbortError(signal);
            }
            batches = null;
          }
        }

        if (!batches) {
          const activeContext = await ensureBrowserContext();
          const categoryPage = await activeContext.newPage();
          try {
            const params = new URLSearchParams({
              keywords: kw,
              filt: "y",
              n: "y",
              categoryId: stream.categoryId,
              beginPage: String(upstreamPage),
              pageSize: "50",
            });
            if (price_start !== "") params.set("priceStart", price_start);
            if (price_end !== "") params.set("priceEnd", price_end);
            applySearchSort(params, normalizedSort);
            await categoryPage.goto(
              `https://s.1688.com/selloffer/offer_search.htm?${params}`,
              { waitUntil: "commit", timeout: 30_000 }
            );
            assertNotLoginPage(categoryPage, "category products");
            const searchReady = await categoryPage
              .waitForFunction(
                () =>
                  /login\.(?:taobao|1688)\.com|member\/signin/i.test(location.href) ||
                  Boolean(window.data?.offerV2Showed) ||
                  Boolean(window.data?.offerresultData),
                null,
                { timeout: 8_000 }
              )
              .then(() => true)
              .catch(() => false);
            assertNotLoginPage(categoryPage, "category products");
            if (!searchReady) {
              throw new Error(
                "1688 category search did not expose a ready result payload"
              );
            }
            const batch = await categoryPage.evaluate(() => {
              const data = window.data || {};
              const list = data.offerV2Showed?.offerList || [];
              const totalValue =
                data.offerresultData?.data?.totalCount ??
                data.abResultData?.totalCount ??
                null;
              const pageSizeValue =
                data.offerresultData?.data?.pageSize ??
                data.abResultData?.pageSize ??
                null;
              return {
                total:
                  totalValue != null && Number.isFinite(Number(totalValue))
                    ? Number(totalValue)
                    : null,
                reportedPageSize:
                  pageSizeValue != null && Number.isFinite(Number(pageSizeValue))
                    ? Number(pageSizeValue)
                    : null,
                items: list.map((it) => ({
                  offerId: String(it.offerId || ""),
                  title: String(it.title || "").replace(/<[^>]+>/g, ""),
                  price: it.priceInfo?.price || it.price || null,
                  image: it.offerPicUrl || null,
                  company: it.companyName || null,
                  sales: it.bookedCount != null ? String(it.bookedCount) : null,
                  location: [it.province, it.city].filter(Boolean).join("") || null,
                  member_id: it.sellerMemberId || "",
                  login_id: it.loginId || "",
                  source_category_id: String(
                    it.categoryId || it.leafCategoryId || it.postCategoryId || ""
                  ),
                  isAd: it.isBid === "true",
                })),
              };
            });
            batches = [{ upstreamPage, batch }];
          } finally {
            await categoryPage.close().catch(() => {});
          }
        }

        for (const entry of batches) {
          processCategoryBatch(stream, entry.batch, entry.upstreamPage);
        }
      };

      try {
        await __extendCategoryMergeState(state, target, (streams) =>
          mapWithLimit(streams, CATEGORY_PAGE_CONCURRENCY, scrapeCategoryPage)
        );
      } finally {
        if (context) await context.close().catch(() => {});
        if (browser) releaseBrowser(browser);
      }
    });

    let items = state.merged
      .slice(globalOffset, globalEnd)
      .map((item) => ({ ...item, category_path: [...(item.category_path || [])] }));
    let translatedTitles = null;
    if (lang === "en" && items.length) {
      translatedTitles = await translateTexts(items.map((item) => item.title));
      items = items.map((item, index) => ({
        ...item,
        title: translatedTitles[index] || item.title,
      }));
    }

    const estimatedTotal = state.streams.reduce(
      (sum, stream) => sum + Math.max(0, Number(stream.total || 0)),
      0
    );
    const totalIsExact = state.exhausted;
    const reportedTotal = totalIsExact
      ? state.merged.length
      : Math.max(estimatedTotal, state.merged.length);
    const formatted = toTmapiSearch(
      { results: items, total: reportedTotal },
      {
        keyword: kw === "*" ? `[cat:${cat}]` : kw,
        page: pageNo,
        page_size: size,
        sort: normalizedSort,
      }
    );
    const onlyStream = state.streams.length === 1 ? state.streams[0] : null;
    formatted.data.has_next_page = onlyStream
      ? onlyStream.total != null
        ? globalEnd < onlyStream.total
        : state.merged.length > globalEnd || !state.exhausted
      : state.merged.length > globalEnd;
    formatted.data.total_is_exact = totalIsExact;
    if (!totalIsExact) formatted.data.estimated_total = reportedTotal;
    return markIfTranslationIncomplete(formatted, translatedTitles);
  } catch (err) {
    return tmapiError(err?.tmapiCode || 500, err.message || "category products failed");
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
