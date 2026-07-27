import { request } from "playwright";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import { getPlaywrightProxy } from "./proxy.js";

export const MOBILE_SEARCH_PAGE_SIZE = 20;

const SEARCH_HTTP_TIMEOUT_MS = Math.max(
  3_000,
  Math.min(30_000, Number(process.env.SEARCH_HTTP_TIMEOUT_MS) || 12_000)
);
const SEARCH_HTTP_MAX_BYTES = Math.max(
  100_000,
  Math.min(4_000_000, Number(process.env.SEARCH_HTTP_MAX_BYTES) || 2_000_000)
);
const SEARCH_PAGE_CACHE_TTL_MS = Math.max(
  10_000,
  Number(process.env.SEARCH_PAGE_CACHE_TTL_MS) || 2 * 60_000
);
const SEARCH_PAGE_CACHE_MAX = Math.max(
  8,
  Math.min(1_000, Number(process.env.SEARCH_PAGE_CACHE_MAX) || 256)
);
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";
const pageCache = new Map();

function searchError(message, code = 502) {
  const error = new Error(message);
  error.name = "MobileSearchError";
  error.code = code;
  error.mobileSearchFallback = true;
  return error;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&yen;/gi, "￥")
    .replace(/&amp;/gi, "&")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, raw) => {
      const codePoint = raw[0].toLowerCase() === "x"
        ? Number.parseInt(raw.slice(1), 16)
        : Number.parseInt(raw, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    });
}

function cleanText(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attributeValue(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeHtml(
    tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"))?.[2] || ""
  ).trim();
}

function classBlock(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(
    new RegExp(
      `<(?:div|span)\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:div|span)>`,
      "i"
    )
  )?.[1] || "";
}

function normalizeImage(value) {
  const raw = decodeHtml(value).trim();
  if (!raw || /^(?:data:|javascript:)/i.test(raw)) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.toLowerCase();
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      !(host === "1688.com" || host.endsWith(".1688.com") || host === "alicdn.com" || host.endsWith(".alicdn.com"))
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function firstCardImage(card) {
  const tags = [...card.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const preferred = tags.filter((tag) => /\bclass=["'][^"']*\bimage_src\b/i.test(tag));
  for (const tag of [...preferred, ...tags]) {
    for (const attribute of ["data-src", "data-lazy-src", "src"]) {
      const image = normalizeImage(attributeValue(tag, attribute));
      if (image) return image;
    }
  }
  return null;
}

function firstCardTitle(card) {
  const title = cleanText(classBlock(card, "item-info_title"));
  if (title) return title;
  for (const match of card.matchAll(/<img\b[^>]*>/gi)) {
    const alt = cleanText(attributeValue(match[0], "alt"));
    if (alt) return alt;
  }
  return "";
}

function priceFromCard(card) {
  const priceText = cleanText(classBlock(card, "count_price"));
  const matched = priceText.match(/[￥¥]\s*([0-9]+(?:[.,][0-9]+)?)/u)?.[1];
  if (!matched) return null;
  const price = Number(matched.replace(",", "."));
  return Number.isFinite(price) && price > 0 ? String(price) : null;
}

function offerIdFromCard(openingTag) {
  const attribute = attributeValue(openingTag, "offerid") ||
    attributeValue(openingTag, "data-offer-id");
  if (/^\d{8,}$/.test(attribute)) return attribute;
  const href = attributeValue(openingTag, "href");
  return href.match(/\/offer\/(\d{8,})(?:\.html)?(?:[/?#]|$)/i)?.[1] || "";
}

function totalFromHtml(html) {
  const text = cleanText(html);
  const raw = text.match(/共\s*([\d,，+]+)\s*件/u)?.[1];
  if (!raw) return null;
  const total = Number(raw.replace(/[,，+]/gu, ""));
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export function parseMobileSearchHtml(htmlValue) {
  const html = String(htmlValue || "");
  if (!html || html.length > SEARCH_HTTP_MAX_BYTES) {
    throw searchError("Mobile search response had an invalid size");
  }
  if (/_____tmd_____|sec\.taobao\.com|login\.(?:taobao|1688)\.com|havanalogin/i.test(html)) {
    throw searchError("Mobile search was blocked by upstream verification", 503);
  }

  const items = [];
  const seen = new Set();
  for (const match of html.matchAll(
    /(<a\b[^>]*\bclass=["'][^"']*\bitem-link\b[^"']*["'][^>]*>)([\s\S]*?)<\/a>/gi
  )) {
    const openingTag = match[1];
    const card = `${openingTag}${match[2]}</a>`;
    const offerId = offerIdFromCard(openingTag);
    if (!offerId || seen.has(offerId)) continue;
    const title = firstCardTitle(card);
    const image = firstCardImage(card);
    const price = priceFromCard(card);
    if (!title || !image || price == null) continue;
    seen.add(offerId);
    const sales = cleanText(classBlock(card, "count_vol"))
      .replace(/^成交\s*/u, "") || null;
    const repurchaseRate = cleanText(classBlock(card, "percent-re-purchase"))
      .replace(/^复购率\s*[:：]?\s*/u, "") || null;
    const location = cleanText(classBlock(card, "count_position")) || null;
    const tags = [...card.matchAll(
      /<(?:div|span)\b[^>]*class=["'][^"']*\binfo-tag\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/gi
    )]
      .map((entry) => cleanText(entry[1]))
      .filter(Boolean)
      .slice(0, 5);
    items.push({
      offerId,
      title,
      price,
      sales,
      repurchaseRate,
      company: null,
      location,
      image,
      url: `https://detail.1688.com/offer/${offerId}.html`,
      tags,
      isAd: /\b(?:detailp4p|P4P|isBid)\b/i.test(card),
    });
  }

  const total = totalFromHtml(html);
  if (!items.length && total !== 0) {
    throw searchError("Mobile search response omitted valid offer cards");
  }
  return { source: "mobile-http", total, items };
}

export function mobileSearchWindow(page, pageSize) {
  const pageNo = Number(page);
  const size = Number(pageSize);
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) {
    throw searchError("page must be a positive integer", 422);
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > 50) {
    throw searchError("page_size must be an integer between 1 and 50", 422);
  }
  const offset = (pageNo - 1) * size;
  if (!Number.isSafeInteger(offset)) throw searchError("page is too large", 422);
  const firstUpstreamPage = Math.floor(offset / MOBILE_SEARCH_PAGE_SIZE) + 1;
  const sliceStart = offset % MOBILE_SEARCH_PAGE_SIZE;
  const upstreamPageCount = Math.ceil((sliceStart + size) / MOBILE_SEARCH_PAGE_SIZE);
  return { pageNo, size, offset, end: offset + size, firstUpstreamPage, sliceStart, upstreamPageCount };
}

function normalizeSort(sort) {
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
  }[value] || "";
}

function buildSearchUrl({ keyword, categoryId, upstreamPage, sort, priceStart, priceEnd }) {
  const hex = Buffer.from(String(keyword), "utf8").toString("hex");
  const url = new URL(`https://m.1688.com/offer_search/-${hex}.html`);
  url.searchParams.set("beginPage", String(upstreamPage));
  if (categoryId) url.searchParams.set("catId", String(categoryId));
  const sortType = normalizeSort(sort);
  if (sortType) url.searchParams.set("sortType", sortType);
  if (priceStart !== "" && priceStart != null) {
    url.searchParams.set("priceStart", String(priceStart));
  }
  if (priceEnd !== "" && priceEnd != null) {
    url.searchParams.set("priceEnd", String(priceEnd));
  }
  return url;
}

function cacheKey(options) {
  return JSON.stringify([
    String(options.keyword),
    String(options.categoryId || ""),
    Number(options.upstreamPage),
    String(options.sort || "default"),
    String(options.priceStart ?? ""),
    String(options.priceEnd ?? ""),
  ]);
}

function cachedPage(key) {
  const entry = pageCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pageCache.delete(key);
    return null;
  }
  pageCache.delete(key);
  pageCache.set(key, entry);
  return structuredClone(entry.value);
}

function storePage(key, value) {
  pageCache.set(key, {
    expiresAt: Date.now() + SEARCH_PAGE_CACHE_TTL_MS,
    value: structuredClone(value),
  });
  while (pageCache.size > SEARCH_PAGE_CACHE_MAX) {
    pageCache.delete(pageCache.keys().next().value);
  }
}

async function awaitJob(promise) {
  const signal = currentJobSignal();
  if (!signal) return promise;
  if (signal.aborted) throw jobAbortError(signal);
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(jobAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function remainingTimeout(deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 250) throw searchError("Mobile search deadline exceeded", 504);
  return Math.max(1, Math.min(SEARCH_HTTP_TIMEOUT_MS, remaining));
}

export async function fetchMobileSearchPage(options = {}) {
  const keyword = String(options.keyword || "").trim();
  const categoryId = String(options.categoryId || "").trim();
  const upstreamPage = Number(options.upstreamPage || 1);
  if (!keyword) throw searchError("Mobile search keyword is required", 422);
  if (!Number.isSafeInteger(upstreamPage) || upstreamPage < 1) {
    throw searchError("Mobile search page is invalid", 422);
  }
  if (categoryId && !/^\d+$/.test(categoryId)) {
    throw searchError("Mobile search category is invalid", 422);
  }
  const normalized = {
    keyword,
    categoryId,
    upstreamPage,
    sort: options.sort || "default",
    priceStart: options.priceStart ?? "",
    priceEnd: options.priceEnd ?? "",
  };
  const key = cacheKey(normalized);
  const cached = cachedPage(key);
  if (cached) return cached;

  const deadline = Number.isFinite(options.deadline)
    ? options.deadline
    : Date.now() + SEARCH_HTTP_TIMEOUT_MS;
  const proxy = getPlaywrightProxy();
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let context;
    let response;
    try {
      context = await awaitJob(request.newContext({
        ...(proxy ? { proxy } : {}),
        userAgent: MOBILE_USER_AGENT,
        extraHTTPHeaders: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      }));
      const target = buildSearchUrl(normalized);
      response = await awaitJob(context.get(target.toString(), {
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: remainingTimeout(deadline),
        headers: { Referer: "https://m.1688.com/" },
      }));
      const status = response.status();
      if (status < 200 || status >= 300) {
        throw searchError(`Mobile search returned HTTP ${status}`, status === 429 ? 429 : 502);
      }
      const finalUrl = new URL(response.url());
      if (
        finalUrl.protocol !== "https:" ||
        finalUrl.hostname.toLowerCase() !== "m.1688.com" ||
        !finalUrl.pathname.startsWith("/offer_search/")
      ) {
        throw searchError("Mobile search redirected unexpectedly");
      }
      const contentType = response.headers()["content-type"] || "";
      if (contentType && !/html|xhtml/i.test(contentType)) {
        throw searchError("Mobile search returned an invalid response type");
      }
      const declaredLength = Number(response.headers()["content-length"] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > SEARCH_HTTP_MAX_BYTES) {
        throw searchError("Mobile search response was too large");
      }
      const body = await awaitJob(response.body());
      if (body.length > SEARCH_HTTP_MAX_BYTES) {
        throw searchError("Mobile search response was too large");
      }
      const parsed = parseMobileSearchHtml(body.toString("utf8"));
      const value = { ...parsed, upstreamPage };
      storePage(key, value);
      return structuredClone(value);
    } catch (error) {
      const signal = currentJobSignal();
      if (signal?.aborted || error?.cancelled || error?.code === 499) {
        throw jobAbortError(signal);
      }
      lastError = error?.mobileSearchFallback
        ? error
        : searchError("Mobile search request failed");
      if (lastError.code === 422 || lastError.code === 429) break;
      if (attempt < 2 && deadline - Date.now() < 500) break;
    } finally {
      await response?.dispose().catch(() => {});
      await context?.dispose().catch(() => {});
    }
  }
  throw lastError || searchError("Mobile search request failed");
}

export function __clearMobileSearchPageCache() {
  pageCache.clear();
}
