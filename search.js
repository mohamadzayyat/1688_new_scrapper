import { assertAuthLooksValid, newAuthedContext } from "./auth.js";
import { launchBrowser, acquirePooledBrowser, releaseBrowser } from "./browser.js";
import { proxyStatus } from "./proxy.js";
import {
  fetchMobileSearchPage,
  mobileSearchWindow,
} from "./mobileSearch.js";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import {
  markIfTranslationIncomplete,
  normalizeLang,
  translateTexts,
} from "./translate.js";

const SEARCH_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.SEARCH_TIMEOUT_MS) || 34_000
);
const SEARCH_ATTEMPTS = Math.max(
  1,
  Math.min(2, Number(process.env.SEARCH_ATTEMPTS) || 1)
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remainingTimeout(deadline, ceiling) {
  const remaining = deadline - Date.now();
  if (remaining < 1_000) throw new Error("Search deadline exceeded");
  return Math.min(ceiling, remaining);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numericOfferValue(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  const number = match ? Number(match[0]) : null;
  return Number.isFinite(number) ? number : null;
}

function filterAndSortSearchItems(
  items,
  { sort = "default", priceStart = "", priceEnd = "" } = {}
) {
  const minPrice = priceStart !== "" ? Number(priceStart) : null;
  const maxPrice = priceEnd !== "" ? Number(priceEnd) : null;
  let output = [...items];
  if (Number.isFinite(minPrice)) {
    output = output.filter((item) => (numericOfferValue(item.price) ?? -1) >= minPrice);
  }
  if (Number.isFinite(maxPrice)) {
    output = output.filter((item) => {
      const price = numericOfferValue(item.price);
      return price != null && price <= maxPrice;
    });
  }
  const normalized = String(sort || "default").trim().toLowerCase().replace(/-/g, "_");
  if (["price_up", "priceup", "price_asc"].includes(normalized)) {
    output.sort((left, right) =>
      (numericOfferValue(left.price) ?? Number.POSITIVE_INFINITY) -
      (numericOfferValue(right.price) ?? Number.POSITIVE_INFINITY)
    );
  } else if (["price_down", "pricedown", "price_desc"].includes(normalized)) {
    output.sort((left, right) =>
      (numericOfferValue(right.price) ?? Number.NEGATIVE_INFINITY) -
      (numericOfferValue(left.price) ?? Number.NEGATIVE_INFINITY)
    );
  }
  return output;
}

async function tryHttpSearch(keyword, pageNo, pageSize, deadline, filters) {
  const window = mobileSearchWindow(pageNo, pageSize);
  const normalizedSort = String(filters.sort || "default")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const needsFullPriceUniverse =
    filters.priceStart !== "" ||
    filters.priceEnd !== "" ||
    ["price_up", "priceup", "price_asc", "price_down", "pricedown", "price_desc"].includes(
      normalizedSort
    );
  const pages = needsFullPriceUniverse
    ? [1, 2, 3]
    : Array.from(
        { length: window.upstreamPageCount },
        (_, index) => window.firstUpstreamPage + index
      );
  const batches = await Promise.all(
    pages.map((upstreamPage) =>
      fetchMobileSearchPage({
        keyword,
        upstreamPage,
        // Keep both price directions over one canonical upstream universe.
        sort: "default",
        priceStart: filters.priceStart,
        priceEnd: filters.priceEnd,
        deadline,
      })
    )
  );
  const seen = new Set();
  const combined = [];
  for (const batch of batches) {
    for (const item of batch.items) {
      if (seen.has(item.offerId)) continue;
      seen.add(item.offerId);
      combined.push(item);
    }
  }
  const upstreamTotal = batches.find((batch) => Number.isFinite(batch.total))?.total ?? null;
  if (needsFullPriceUniverse) {
    const filtered = filterAndSortSearchItems(combined, filters);
    const exhaustive = Number.isFinite(upstreamTotal)
      ? pages.length * 20 >= upstreamTotal
      : batches.some((batch) => batch.items.length < 20);
    return {
      source: "mobile-http",
      total: exhaustive ? filtered.length : upstreamTotal,
      items: filtered.slice(window.offset, window.end),
    };
  }
  return {
    source: "mobile-http",
    total: upstreamTotal,
    items: combined.slice(window.sliceStart, window.sliceStart + pageSize),
  };
}

function keywordToHexPath(keyword) {
  return Buffer.from(String(keyword), "utf8").toString("hex");
}

function normalizeSearchSort(sort) {
  const value = String(sort || "default").trim().toLowerCase().replace(/-/g, "_");
  return {
    sales: "booked",
    sales_desc: "booked",
    booked: "booked",
    price_up: "price-asc",
    priceup: "price-asc",
    price_asc: "price-asc",
    price_down: "price-desc",
    pricedown: "price-desc",
    price_desc: "price-desc",
    new: "newOffer",
    newest: "newOffer",
    new_offer: "newOffer",
  }[value];
}

function applySearchQuery(url, { sort, priceStart, priceEnd, pageSize } = {}) {
  const sortType = normalizeSearchSort(sort);
  if (sortType) url.searchParams.set("sortType", sortType);
  if (priceStart !== "") url.searchParams.set("priceStart", String(priceStart));
  if (priceEnd !== "") url.searchParams.set("priceEnd", String(priceEnd));
  if (pageSize) url.searchParams.set("pageSize", String(pageSize));
  return url;
}

function buildMobileSearchUrl(keyword, page, filters = {}) {
  const hex = keywordToHexPath(keyword);
  const url = new URL(`https://m.1688.com/offer_search/-${hex}.html`);
  url.searchParams.set("beginPage", String(page));
  return applySearchQuery(url, filters).toString();
}

function buildDesktopSearchUrl(keyword, page, filters = {}) {
  const url = new URL("https://s.1688.com/selloffer/offer_search.htm");
  url.searchParams.set("keywords", keyword);
  url.searchParams.set("beginPage", String(page));
  return applySearchQuery(url, filters).toString();
}

function normalizeDesktopOffer(item) {
  const offerId = String(item.offerId || "");
  const price =
    item.priceInfo?.price ||
    item.priceInfo?.priceShow ||
    item.price ||
    null;

  return {
    offerId,
    title: stripHtml(item.title) || null,
    price: price != null ? String(price) : null,
    sales: item.bookedCount != null ? String(item.bookedCount) : null,
    repurchaseRate: item.turnHead?.percent || null,
    company: item.companyName || item.loginId || null,
    location:
      item.shopAddition?.text ||
      [item.province, item.city].filter(Boolean).join("") ||
      null,
    image: item.offerPicUrl || item.odPicUrl || item.list?.cover?.pic || null,
    url: offerId ? `https://detail.1688.com/offer/${offerId}.html` : null,
    tags: (item.tags || []).map((t) => t.text).filter(Boolean),
    isAd: item.isBid === "true" || item.type === "bid" || Boolean(item.block),
  };
}

async function applySearchLanguage(items, lang) {
  if (lang !== "en" || !items.length) return items;
  const translated = await translateTexts(items.map((item) => item.title));
  const output = items.map((item, i) => ({
    ...item,
    titleOriginal: item.title,
    title: translated[i] || item.title,
  }));
  if (translated.__translationComplete === false) {
    Object.defineProperty(output, "__translationIncomplete", {
      value: true,
      enumerable: false,
    });
  }
  return output;
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

async function tryDesktopSearch(
  browser,
  keyword,
  pageNo,
  lang = "zh",
  deadline = Infinity,
  filters = {}
) {
  const context = await newAuthedContext(browser, {
    locale: lang === "en" ? "en-US" : "zh-CN",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language":
        lang === "en" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  try {
    await withLangCookies(context, lang);
    const page = await context.newPage();
    await page.goto(buildDesktopSearchUrl(keyword, pageNo, filters), {
      waitUntil: "domcontentloaded",
      timeout: remainingTimeout(deadline, 12_000),
    });

    const started = Date.now();
    while (Date.now() - started < 6_000 && Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const href = location.href;
        const text = document.body?.innerText || "";
        const login = /login\.taobao|login\.1688|密码登录|扫码登录/.test(href + text);
        const list = window.data?.offerV2Showed?.offerList;
        return {
          login,
          ready: Array.isArray(list) && list.length > 0,
        };
      });
      if (state.login) return null;
      if (state.ready) break;
      await sleep(400);
    }

    const result = await page.evaluate(() => {
      const data = window.data || {};
      const list = data.offerV2Showed?.offerList || [];
      if (!list.length) return null;
      const totalRaw =
        data.offerresultData?.data?.totalCount ||
        data.abResultData?.totalCount ||
        null;
      return {
        source: "desktop",
        total: totalRaw != null ? Number(totalRaw) : null,
        items: list,
      };
    });
    return result;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

function loginHelpMessage() {
  return (
    "1688 asked for login. Your saved session is missing or incomplete. " +
    "Run: npm run login  → finish login on 1688.com → press Enter in the terminal → retry search."
  );
}

async function scrapeMobileSearch(
  browser,
  keyword,
  pageNo,
  lang = "zh",
  deadline = Infinity,
  filters = {}
) {
  const context = await newAuthedContext(browser, {
    isMobile: true,
    hasTouch: true,
    locale: lang === "en" ? "en-US" : "zh-CN",
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      "Accept-Language":
        lang === "en" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  try {
    await withLangCookies(context, lang);
    const page = await context.newPage();
    await page.goto(buildMobileSearchUrl(keyword, pageNo, filters), {
      waitUntil: "commit",
      timeout: remainingTimeout(deadline, 15_000),
    });

    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 12_000 && Date.now() < deadline) {
      const count = await page.locator("a.item-link").count();
      if (count > 0) {
        ready = true;
        break;
      }

      const state = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const href = location.href;
        const loginWall =
          /login\.taobao|login\.1688|havanalogin/i.test(href) ||
          ((/密码登录|扫码登录|一键登录|换个登录方式/.test(text) ||
            /访问受限|punish/.test(text)) &&
            !/共\s*[\d,+]+\s*件/.test(text));
        return { loginWall };
      });

      if (state.loginWall) {
        throw new Error(loginHelpMessage());
      }
      await sleep(500);
    }

    if (!ready) {
      throw new Error("No search results found (timeout waiting for item cards).");
    }

    // Nudge lazy-loaded images into the DOM
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        window.scrollBy(0, Math.min(900, window.innerHeight));
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
    });
    await sleep(400);

    const result = await page.evaluate(() => {
      const seen = new Set();
      const items = [];

      for (const a of document.querySelectorAll("a.item-link")) {
        const offerId =
          a.getAttribute("offerid") ||
          a.getAttribute("data-offer-id") ||
          (String(a.getAttribute("href") || "").match(/offer\/(\d+)/) || [])[1] ||
          null;
        if (!offerId || seen.has(offerId)) continue;
        seen.add(offerId);

        const text = (a.innerText || "").trim();
        const lines = text
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const images = [...a.querySelectorAll("img")];
        const img =
          images.find((node) =>
            node.matches("img.image_src[data-src], img.image_src[src], img[data-src]")
          ) || images.find((node) => node.getAttribute("src"));
        let image = img?.getAttribute("data-src") || img?.getAttribute("src") || null;
        if (image && /offer_search|data:image|spacer|blank/i.test(image)) {
          image = null;
        }

        items.push({
          offerId,
          title:
            (a.querySelector(".item-info_title")?.textContent || "").trim() ||
            img?.alt ||
            lines[0] ||
            null,
          price:
            ((a.querySelector(".count_price")?.textContent || text).match(
              /[￥¥]\s*([\d.]+)/u
            ) || [])[1] || null,
          sales:
            (a.querySelector(".count_vol")?.textContent || "")
              .replace(/^\s*成交\s*/u, "")
              .trim() || null,
          repurchaseRate:
            (a.querySelector(".percent-re-purchase")?.textContent || "")
              .replace(/^\s*复购率\s*[:：]?\s*/u, "")
              .trim() || null,
          company: null,
          location:
            (a.querySelector(".count_position")?.textContent || "").trim() || null,
          image,
          url: `https://detail.1688.com/offer/${offerId}.html`,
          tags: [...a.querySelectorAll(".info-tag")]
            .map((node) => (node.textContent || "").trim())
            .filter(Boolean)
            .slice(0, 5),
          isAd: false,
        });
      }

      const totalRaw = (document.body.innerText.match(/共\s*([\d,，+]+)\s*件/u) || [])[1];
      const total = totalRaw ? Number(String(totalRaw).replace(/[,，+]/gu, "")) : null;

      return { source: "mobile", total, items };
    });
    return result;
  } finally {
    await context.close();
  }
}

/**
 * Search 1688 offers by keyword with pagination.
 * @param {string} keyword
 * @param {{ page?: number, pageSize?: number, headed?: boolean, lang?: string, sort?: string, priceStart?: string, priceEnd?: string }} [options]
 */
export async function searchOffers(
  keyword,
  {
    page = 1,
    pageSize = 20,
    headed = false,
    lang = "zh",
    sort = "default",
    priceStart = "",
    priceEnd = "",
  } = {}
) {
  const startedAt = Date.now();
  const deadline = startedAt + SEARCH_TIMEOUT_MS;
  const q = String(keyword || "").trim();
  const pageNo = Math.max(1, Number(page) || 1);
  const requestedPageSize = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const language = normalizeLang(lang);
  const filters = { sort, priceStart, priceEnd, pageSize: requestedPageSize };

  if (!q) throw new Error("Search keyword is required");

  const auth = await assertAuthLooksValid();
  const proxy = proxyStatus();
  if (!auth.ok && !proxy.enabled) {
    throw new Error(
      `No valid 1688 login session (${auth.reason}) and proxy is disabled. ` +
        "Either enable proxy.config.json, or run: npm run login"
    );
  }

  let browser = null;
  const ensureBrowser = async () => {
    if (browser) return browser;
    browser = headed
      ? await launchBrowser({ headed: true })
      : await acquirePooledBrowser();
    return browser;
  };

  try {
    let lastError;

    for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt++) {
      try {
        let raw = null;

        if (proxy.enabled && !headed) {
          try {
            raw = await tryHttpSearch(
              q,
              pageNo,
              requestedPageSize,
              deadline,
              filters
            );
          } catch (error) {
            const signal = currentJobSignal();
            if (signal?.aborted || error?.cancelled || error?.code === 499) {
              throw jobAbortError(signal);
            }
          }
        }

        // Desktop JSON is richest when session works.
        if (!raw && auth.ok) {
          const activeBrowser = await ensureBrowser();
          const desktop = await tryDesktopSearch(
            activeBrowser,
            q,
            pageNo,
            language,
            deadline,
            filters
          );
          if (desktop?.items?.length) {
            raw = {
              source: "desktop",
              total: desktop.total,
              items: desktop.items.map(normalizeDesktopOffer),
            };
          }
        }

        if (!raw) {
          const activeBrowser = await ensureBrowser();
          raw = await scrapeMobileSearch(
            activeBrowser,
            q,
            pageNo,
            language,
            deadline,
            filters
          );
        }

        if (!raw.items.length) throw new Error("Search returned zero offers");

        const results = await applySearchLanguage(
          raw.items.slice(0, requestedPageSize),
          language
        );

        const pageSize = requestedPageSize;
        const logicalOffset = (pageNo - 1) * requestedPageSize;
        const observedEnd = logicalOffset + results.length;
        const total = Number.isFinite(raw.total)
          ? Math.max(raw.total, observedEnd)
          : observedEnd + (results.length === requestedPageSize ? 1 : 0);
        const totalPages =
          total && pageSize ? Math.max(1, Math.ceil(total / pageSize)) : null;

        const durationMs = Date.now() - startedAt;
        const timing = {
          durationMs,
          durationSeconds: Number((durationMs / 1000).toFixed(2)),
          attempts: attempt,
        };
        console.error(
          `[timing] search "${q}" p${pageNo} (${language}) ${timing.durationSeconds}s`
        );

        return markIfTranslationIncomplete({
          keyword: q,
          language,
          page: pageNo,
          pageSize,
          total,
          totalPages,
          hasNextPage: totalPages != null ? pageNo < totalPages : true,
          source: raw.source,
          proxy: proxy.enabled
            ? { enabled: true, provider: proxy.provider, server: proxy.server }
            : { enabled: false },
          timing,
          scrapedAt: new Date().toISOString(),
          url:
            raw.source === "desktop"
              ? buildDesktopSearchUrl(q, pageNo, filters)
              : buildMobileSearchUrl(q, pageNo, filters),
          results,
        }, results);
      } catch (err) {
        lastError = err;
        if (attempt === SEARCH_ATTEMPTS || Date.now() >= deadline) break;
        await sleep(800);
      }
    }

    throw lastError;
  } finally {
    if (browser && headed) await browser.close().catch(() => {});
    else if (browser) releaseBrowser(browser);
  }
}
