import { request } from "playwright";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import { getPlaywrightProxy } from "./proxy.js";

const SHOP_ORIGIN = "https://winport.m.1688.com";
const OFFER_LIST_PATH = "/page/offerlist.html";
const ASYNC_VIEW_PATH = "/winport/asyncView";
const MAX_HTML_BYTES = 2_000_000;
const MAX_ASYNC_BYTES = 1_000_000;
const DEFAULT_BUDGET_MS = Math.max(
  5_000,
  Math.min(25_000, Number(process.env.SHOP_HTTP_BUDGET_MS) || 14_000)
);
const DEFAULT_CATEGORY_BUDGET_MS = Math.max(
  5_000,
  Math.min(
    30_000,
    Number(process.env.SHOP_CATEGORY_HTTP_BUDGET_MS) || 20_000
  )
);
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 " +
  "Mobile/15E148 Safari/604.1";

function shopHttpError(message, code = 502) {
  const error = new Error(message);
  error.name = "ShopHttpError";
  error.code = code;
  error.shopHttpFallback = true;
  return error;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&yen;/gi, "¥")
    .replace(/&amp;/gi, "&")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, raw) => {
      const value = raw[0].toLowerCase() === "x"
        ? Number.parseInt(raw.slice(1), 16)
        : Number.parseInt(raw, 10);
      return Number.isSafeInteger(value) && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "";
    });
}

function cleanText(value) {
  return decodeHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag || "").match(
    new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i")
  );
  return match ? decodeHtml(match[2]).trim() : "";
}

function normalizeHttpUrl(value, base = SHOP_ORIGIN) {
  const raw = decodeHtml(value).trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeAlibabaImageUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  const hostname = new URL(normalized).hostname.toLowerCase();
  return hostname === "1688.com" || hostname.endsWith(".1688.com") ||
    hostname === "alicdn.com" || hostname.endsWith(".alicdn.com")
    ? normalized
    : "";
}

function finiteNumber(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function isPunishPage(html) {
  return /_____tmd_____|Captcha Interception|sec\.taobao\.com|x5secdata=|\/punish\?/i.test(
    String(html || "")
  );
}

function pageIdentityIsValid(html, memberId) {
  return (
    !isPunishPage(html) &&
    String(html || "").includes(String(memberId)) &&
    /<html\b|<div\b/i.test(String(html || ""))
  );
}

function productIdFromHref(href) {
  return (
    String(href || "").match(/[?&]offerId=(\d{8,})/i)?.[1] ||
    String(href || "").match(/\/offer\/(\d{8,})/i)?.[1] ||
    ""
  );
}

/** Parse server-rendered offer-list cards without executing page JavaScript. */
export function parseShopItemsHtml(html) {
  const source = String(html || "");
  const items = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']*(?:offerId=|\/offer\/)\d{8,}[^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(source))) {
    const href = decodeHtml(match[2]);
    const itemId = productIdFromHref(href);
    if (!itemId || seen.has(itemId)) continue;
    const card = match[3];
    const titleMatch =
      card.match(/<div\b[^>]*class=["'][^"']*item-title[^"']*["'][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i) ||
      card.match(/<p\b[^>]*class=["'][^"']*table[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const imageTags = [...card.matchAll(/<img\b[^>]*>/gi)].map((entry) => entry[0]);
    const imageTag = imageTags.find((tag) =>
      /\b(?:data-src|src)\s*=\s*["'][^"']*(?:alicdn|1688)/i.test(tag)
    ) || imageTags[0] || "";
    const priceMatch = card.match(
      /<span\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );
    const countMatch = card.match(
      /<span\b[^>]*class=["'][^"']*\bcount\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
    );
    const title = cleanText(titleMatch?.[1]);
    const img = normalizeAlibabaImageUrl(
      attribute(imageTag, "data-src") || attribute(imageTag, "src")
    );
    const price = finiteNumber(cleanText(priceMatch?.[1]));
    const sales = finiteNumber(cleanText(countMatch?.[1])) ?? 0;
    if (!title || !img || price == null || price <= 0) continue;
    seen.add(itemId);
    items.push({
      item_id: itemId,
      title,
      img,
      image: img,
      price: String(price),
      sale_quantity: sales,
      sales,
      item_url: `https://detail.1688.com/offer/${itemId}.html`,
      url: `https://detail.1688.com/offer/${itemId}.html`,
    });
  }
  return items;
}

function metaContent(html, name) {
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (attribute(tag, "name").toLowerCase() === String(name).toLowerCase()) {
      return cleanText(attribute(tag, "content"));
    }
  }
  return "";
}

export function parseShopInfoHtml(html, memberId) {
  const title = cleanText(
    String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  );
  const keywords = metaContent(html, "keywords");
  const company = (keywords || title)
    .replace(/\s*[-_|]\s*\u963f\u91cc\u5df4\u5df4.*$/i, "")
    .trim();
  if (
    !company ||
    /^\u963f\u91cc\u5df4\u5df4$/i.test(company) ||
    /captcha/i.test(company)
  ) {
    throw shopHttpError("Shop information was incomplete");
  }
  const shopUrl = `${SHOP_ORIGIN}/page/index.html?memberId=${encodeURIComponent(memberId)}`;
  return {
    member_id: String(memberId),
    seller_member_id: String(memberId),
    shop_name: company,
    company_name: company,
    shop_url: shopUrl,
    description: metaContent(html, "description"),
    login_id: "",
    identity_tags: [],
    service_tags: [],
  };
}

export function parseShopCategoriesHtml(html, memberId) {
  const source = String(html || "");
  const categories = [];
  const seen = new Set();
  const anchorPattern =
    /<a\b[^>]*\bhref\s*=\s*(["'])([^"']*[?&](?:amp;)?catId=[^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(source))) {
    const href = normalizeHttpUrl(match[2]);
    if (!href) continue;
    const url = new URL(href);
    const id = String(url.searchParams.get("catId") || "").trim();
    if (!id || seen.has(id)) continue;
    const name =
      cleanText(
        match[3].match(
          /<div\b[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
        )?.[1]
      ) || cleanText(url.searchParams.get("title"));
    if (!name) continue;
    seen.add(id);
    const parentId = String(url.searchParams.get("catPid") || "").trim();
    categories.push({
      shop_cat_id: id,
      cat_id: id,
      category_id: id,
      id,
      name,
      cat_name: name,
      category_name: name,
      parent_id: parentId || null,
      url: href,
    });
  }
  if (!categories.length) throw shopHttpError("Shop categories were incomplete");
  return {
    member_id: String(memberId),
    shop_url: `${SHOP_ORIGIN}/page/index.html?memberId=${encodeURIComponent(memberId)}`,
    categories,
    list: categories,
  };
}

function normalizedSort(sort) {
  const value = String(sort || "default").trim().toLowerCase().replace(/-/g, "_");
  if (["sales", "sales_desc", "booked"].includes(value)) return "tradenumdown";
  if (["price_up", "priceup", "price_asc"].includes(value)) return "priceup";
  if (["price_down", "pricedown", "price_desc"].includes(value)) return "pricedown";
  if (["new", "newest", "new_offer"].includes(value)) return "timedown";
  return "";
}

export function shopOfferListHttpUrl({
  memberId,
  pageIndex = 1,
  pageSize = 20,
  categoryId = "",
  sort = "default",
  priceStart = "",
  priceEnd = "",
  keyword = "",
} = {}) {
  const url = new URL(OFFER_LIST_PATH, SHOP_ORIGIN);
  url.searchParams.set("memberId", String(memberId));
  url.searchParams.set("pageIndex", String(pageIndex));
  url.searchParams.set("pageSize", String(pageSize));
  if (categoryId) {
    url.searchParams.set("catId", String(categoryId));
    url.searchParams.set("catPid", "");
    url.searchParams.set("isUserDefined", "true");
  }
  if (keyword) {
    url.searchParams.set("keyword", String(keyword));
    url.searchParams.set("keywords", String(keyword));
  }
  if (priceStart !== "") url.searchParams.set("priceStart", String(priceStart));
  if (priceEnd !== "") url.searchParams.set("priceEnd", String(priceEnd));
  const sortType = normalizedSort(sort);
  if (sortType) url.searchParams.set("sortType", sortType);
  return url.href;
}

function requestTimeout(deadline, capMs = 12_000) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 100) throw shopHttpError("Shop request deadline exceeded", 504);
  return Math.max(1, Math.min(capMs, remaining));
}

async function awaitJob(promise) {
  const signal = currentJobSignal();
  if (!signal) return promise;
  if (signal.aborted) throw jobAbortError(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(jobAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function awaitWithin(promise, deadline, label) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) throw shopHttpError(`${label} deadline exceeded`, 504);
  let timer;
  try {
    return await awaitJob(
      Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(shopHttpError(`${label} deadline exceeded`, 504)),
            remaining
          );
          timer.unref?.();
        }),
      ])
    );
  } finally {
    clearTimeout(timer);
  }
}

function validOfferListUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === "winport.m.1688.com" &&
      url.pathname === OFFER_LIST_PATH;
  } catch {
    return false;
  }
}

function validAsyncViewUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === "winport.m.1688.com" &&
      url.pathname === ASYNC_VIEW_PATH;
  } catch {
    return false;
  }
}

async function boundedText(response, maxBytes, deadline, label) {
  const contentLength = Number(response.headers()["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw shopHttpError(`${label} response was too large`);
  }
  const body = await awaitWithin(response.body(), deadline, `${label} response`);
  if (body.length > maxBytes) throw shopHttpError(`${label} response was too large`);
  return body.toString("utf8");
}

async function safeGet(context, url, deadline, label, maxBytes, headers = {}) {
  let response;
  const signal = currentJobSignal();
  try {
    response = await awaitJob(
      context.get(url, {
        headers,
        failOnStatusCode: false,
        timeout: requestTimeout(deadline),
      })
    );
    if (response.status() < 200 || response.status() >= 300) {
      throw shopHttpError(`${label} returned HTTP ${response.status()}`);
    }
    const text = await boundedText(response, maxBytes, deadline, label);
    return { text, url: response.url(), contentType: response.headers()["content-type"] || "" };
  } catch (error) {
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    if (error?.shopHttpFallback) throw error;
    throw shopHttpError(`${label} request failed`);
  } finally {
    await response?.dispose().catch(() => {});
  }
}

async function withShopClient(
  task,
  { deadline, contextFactory, budgetMs: requestedBudgetValue } = {}
) {
  const requestedBudget = Number(requestedBudgetValue);
  const budgetMs = Number.isFinite(requestedBudget)
    ? Math.max(1_000, requestedBudget)
    : DEFAULT_BUDGET_MS;
  const operationDeadline = Math.min(
    Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY,
    Date.now() + budgetMs
  );
  const signal = currentJobSignal();
  if (signal?.aborted) throw jobAbortError(signal);
  const factory = contextFactory || ((options) => request.newContext(options));
  const proxy = getPlaywrightProxy();
  const contextPromise = Promise.resolve().then(() =>
    factory({
      ...(proxy ? { proxy } : {}),
      userAgent: MOBILE_USER_AGENT,
      extraHTTPHeaders: {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    })
  );
  let context;
  try {
    context = await awaitWithin(
      contextPromise,
      operationDeadline,
      "Shop HTTP client"
    );
    return await task(context, operationDeadline);
  } finally {
    if (context) await context.dispose().catch(() => {});
    else {
      void contextPromise
        .then((late) => late?.dispose().catch(() => {}))
        .catch(() => {});
    }
  }
}

async function fetchOfferListPage(context, options, deadline) {
  const url = shopOfferListHttpUrl(options);
  const response = await safeGet(
    context,
    url,
    deadline,
    "Shop offer list",
    MAX_HTML_BYTES,
    { Referer: `${SHOP_ORIGIN}/` }
  );
  if (!validOfferListUrl(response.url) || !/html|xhtml/i.test(response.contentType)) {
    throw shopHttpError("Shop offer list redirected unexpectedly");
  }
  if (!pageIdentityIsValid(response.text, options.memberId)) {
    throw shopHttpError("Shop offer list was blocked or incomplete");
  }
  return response.text;
}

export async function fetchShopItemsHttp(
  {
    memberId,
    page = 1,
    pageSize = 20,
    categoryId = "",
    sort = "default",
    priceStart = "",
    priceEnd = "",
    keyword = "",
  } = {},
  options = {}
) {
  const currentPage = Math.max(1, Number(page) || 1);
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20));
  return withShopClient(async (context, deadline) => {
    // Ask 1688 for the requested upstream page directly. Large page-one
    // windows are not reliable in production: the service may silently cap
    // them, which made later logical pages empty or repeat page one.
    const requestedSize = Math.min(50, size + 1);
    const html = await fetchOfferListPage(
      context,
      {
        memberId,
        pageIndex: currentPage,
        pageSize: requestedSize,
        categoryId,
        sort,
        priceStart,
        priceEnd,
        keyword,
      },
      deadline
    );
    const parsed = parseShopItemsHtml(html);
    if (!parsed.length) {
      throw shopHttpError("Shop offer list contained no usable products");
    }
    const items = parsed.slice(0, size);
    const hasNext = parsed.length > size;
    const totalCount = (currentPage - 1) * size + items.length + (hasNext ? 1 : 0);
    return { items, totalCount, hasNext };
  }, options);
}

export async function fetchShopInfoHttp({ memberId } = {}, options = {}) {
  return withShopClient(async (context, deadline) => {
    const html = await fetchOfferListPage(
      context,
      { memberId, pageIndex: 1, pageSize: 1 },
      deadline
    );
    return parseShopInfoHtml(html, memberId);
  }, options);
}

function extractCtoken(html) {
  return (
    String(html || "").match(/&quot;ctoken&quot;:&quot;([^&"']+)&quot;/i)?.[1] ||
    String(html || "").match(/["']ctoken["']\s*:\s*["']([^"']+)["']/i)?.[1] ||
    ""
  );
}

export async function fetchShopCategoriesHttp({ memberId } = {}, options = {}) {
  return withShopClient(async (context, deadline) => {
    const boot = await fetchOfferListPage(
      context,
      { memberId, pageIndex: 1, pageSize: 1 },
      deadline
    );
    const ctoken = extractCtoken(boot);
    if (!ctoken) throw shopHttpError("Shop category token was unavailable");
    const url = new URL(ASYNC_VIEW_PATH, SHOP_ORIGIN);
    for (const [key, value] of Object.entries({
      ctoken,
      memberId: String(memberId),
      _lark_module_type: "page",
      _lark_source: "mwp",
      _lark_need_auth: "true",
      _async_id: "category:view",
    })) {
      url.searchParams.set(key, value);
    }
    const response = await safeGet(
      context,
      url.href,
      deadline,
      "Shop categories",
      MAX_ASYNC_BYTES,
      { Referer: shopOfferListHttpUrl({ memberId, pageIndex: 1, pageSize: 1 }) }
    );
    if (!validAsyncViewUrl(response.url) || !/json|javascript/i.test(response.contentType)) {
      throw shopHttpError("Shop categories redirected unexpectedly");
    }
    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw shopHttpError("Shop categories returned malformed JSON");
    }
    if (payload?.success !== true || typeof payload.content !== "string") {
      throw shopHttpError("Shop categories were unavailable");
    }
    if (isPunishPage(payload.content) || !String(payload.content).includes(String(memberId))) {
      throw shopHttpError("Shop categories were blocked or incomplete");
    }
    return parseShopCategoriesHtml(payload.content, memberId);
  }, {
    ...options,
    budgetMs: Number.isFinite(Number(options.budgetMs))
      ? Number(options.budgetMs)
      : DEFAULT_CATEGORY_BUDGET_MS,
  });
}
