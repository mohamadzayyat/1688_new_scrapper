import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeOfferHttpClient, getItemDetailById } from "./scrape.js";
import { searchOffers } from "./search.js";
import { tmapiError } from "./tmapiFormat.js";
import { convertImageUrl, parseOfferUrl } from "./tmapiExtra.js";
import {
  getItemDesc,
  getItemReviews,
  getItemFreight,
  getShopItems,
  getShopInfo,
  getShopCategories,
  searchItemsTmapi,
  searchByImage,
  getCategoryProducts,
  getCategoryInfo,
  searchFactories,
  searchItemsCrossBorder,
  searchByImageCrossBorder,
} from "./extraScrape.js";
import {
  enqueueJob,
  runSerializedJob,
  jobQueueStats,
  recommendedHardware,
} from "./jobQueue.js";
import { runWithJobSignal } from "./jobContext.js";
import { cacheKey, cached, cachedSwr, cacheStats } from "./cache.js";
import {
  warmBrowserPool,
  browserPoolStats,
  closeBrowserPool,
} from "./browser.js";
import { assertAuthLooksValid } from "./auth.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.REQUEST_TIMEOUT_MS) || 40_000
);
const MAX_BODY_BYTES = Math.max(
  1_024,
  Number(process.env.MAX_BODY_BYTES) || 64 * 1024
);
const SCRAPER_API_TOKEN = String(process.env.SCRAPER_API_TOKEN || "").trim();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Fresh TTL — longer + disk SWR so repeat item_detail stays << 1s
const ITEM_CACHE_TTL = Math.max(
  30_000,
  Number(process.env.ITEM_CACHE_TTL_MS) || 30 * 60 * 1000
);
const SEARCH_CACHE_TTL = Math.max(5_000, Number(process.env.SEARCH_CACHE_TTL_MS) || 60_000);
const LIST_CACHE_TTL = Math.max(
  30_000,
  Number(process.env.LIST_CACHE_TTL_MS) || 10 * 60 * 1000
);
const META_CACHE_TTL = Math.max(
  60_000,
  Number(process.env.META_CACHE_TTL_MS) || 6 * 60 * 60 * 1000
);

function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (body?.__scraperCache) headers["X-Scraper-Cache"] = body.__scraperCache;
  if (body?.__scraperPath) headers["X-Scraper-Path"] = body.__scraperPath;
  res.writeHead(status, headers);
  res.end(payload);
}

function sendTmapi(res, body) {
  sendJson(res, 200, body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const filePath = resolve(PUBLIC_DIR, "." + pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

/**
 * Concurrent job runner (queue) — up to MAX_CONCURRENT scrapes in parallel.
 * Instant tools (parse/convert) should NOT use this.
 */
function categorySerialKey({ categories, keyword, sort, priceStart, priceEnd, language }) {
  if (!categories) return null;
  return JSON.stringify([
    "category-stream",
    categories,
    String(keyword || "*").trim() || "*",
    String(sort || "default").trim().toLowerCase(),
    String(priceStart || "").trim(),
    String(priceEnd || "").trim(),
    String(language || "en").trim().toLowerCase(),
  ]);
}

async function withJob(res, label, fn, { tmapi = true, cacheTtl = 0, cacheParts = null, swr = false, serialKey = null } = {}) {
  const controller = new AbortController();
  let rejectClientClosed;
  const clientClosed = new Promise((_, reject) => {
    rejectClientClosed = reject;
  });
  const abortOnClose = () => {
    if (!res.writableFinished) {
      const error = new Error("Client disconnected before the scrape completed");
      error.code = 499;
      error.cancelled = true;
      rejectClientClosed(error);
      controller.abort(error);
    }
  };
  res.once("close", abortOnClose);
  if (res.destroyed || res.closed) abortOnClose();
  let timer;
  try {
    // Cache and singleflight are outside the scrape queue so memory/disk hits
    // never wait behind Chromium work. Every miss and SWR refresh still enters
    // the same bounded queue through `produce`.
    const produce = (sourceSignal = controller.signal) => {
      const workController = new AbortController();
      const forwardAbort = () => workController.abort(sourceSignal?.reason);
      if (sourceSignal?.aborted) forwardAbort();
      else sourceSignal?.addEventListener("abort", forwardAbort, { once: true });
      let workTimer;
      const workDeadline = new Promise((_, reject) => {
        workTimer = setTimeout(() => {
          const error = new Error(`Scrape work exceeded ${REQUEST_TIMEOUT_MS}ms`);
          error.code = 504;
          reject(error);
          workController.abort(error);
        }, REQUEST_TIMEOUT_MS);
      });
      workTimer.unref?.();
      // Defer the call because enqueueJob can reject synchronously when the
      // queue is full. The shared finally must always clear timer/listener state.
      const queuedWork = Promise.resolve().then(() =>
        runSerializedJob(
          serialKey,
          () =>
            enqueueJob(
              label,
              () => runWithJobSignal(workController.signal, fn),
              { signal: workController.signal }
            ),
          { signal: workController.signal }
        )
      );
      return Promise.race([queuedWork, workDeadline]).finally(() => {
        clearTimeout(workTimer);
        sourceSignal?.removeEventListener("abort", forwardAbort);
      });
    };
    let work;
    if (cacheTtl > 0 && cacheParts) {
      const key = cacheKey(cacheParts);
      work = swr
        ? cachedSwr(key, cacheTtl, produce, { signal: controller.signal })
        : cached(key, cacheTtl, produce, { signal: controller.signal });
    } else {
      work = produce(controller.signal);
    }

    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Request exceeded ${REQUEST_TIMEOUT_MS}ms`);
        err.code = 504;
        reject(err);
        controller.abort(err);
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });
    const data = await Promise.race([work, deadline, clientClosed]);
    if (tmapi) sendTmapi(res, data);
    else sendJson(res, 200, data);
  } catch (err) {
    const code =
      err?.code === 439 || err?.queueFull
        ? 439
        : err?.code === 499 || err?.cancelled
          ? 499
          : err?.code === 504
            ? 504
            : 500;
    const msg = err.message || "Request failed";
    if (tmapi) sendTmapi(res, tmapiError(code, msg));
    else sendJson(
      res,
      code === 439 ? 429 : code === 499 ? 499 : code === 504 ? 504 : 502,
      { error: msg }
    );
  } finally {
    clearTimeout(timer);
    res.off("close", abortOnClose);
  }
}

function normalizeLanguage(lang) {
  const value = String(lang || "en").trim().toLowerCase();
  if (["en", "english"].includes(value)) return "en";
  if (["zh", "chinese", "zh-cn"].includes(value)) return "zh";
  return value || "en";
}

function extractOfferIdFromUrl(input) {
  const parsed = parseOfferUrl(input);
  return parsed.code === 200 ? parsed.data.item_id : null;
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    const err = new Error(`JSON body exceeds ${MAX_BODY_BYTES} bytes`);
    err.httpStatus = 413;
    throw err;
  }
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const err = new Error(`JSON body exceeds ${MAX_BODY_BYTES} bytes`);
      err.httpStatus = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function boolParam(v) {
  return String(v || "false").toLowerCase() === "true";
}

async function handleItemDetail(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/v2/item_detail?item_id=..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const itemId = (url.searchParams.get("item_id") || "").trim();
  const language = normalizeLanguage(url.searchParams.get("language") || "en");
  const optimizeTitle = boolParam(url.searchParams.get("optimize_title"));
  void url.searchParams.get("scene");

  if (!/^\d+$/.test(itemId)) {
    sendTmapi(res, tmapiError(422, "item_id is required and must be a number"));
    return;
  }

  await withJob(
    res,
    `item_detail:${itemId}:${language}`,
    () =>
      getItemDetailById(itemId, {
        language,
        optimize_title: optimizeTitle,
      }),
    {
      tmapi: true,
      cacheTtl: ITEM_CACHE_TTL,
      cacheParts: ["item_detail", itemId, language, optimizeTitle],
      swr: true,
    }
  );
}

async function handleItemDetailByUrl(req, res) {
  if (req.method !== "POST") {
    sendTmapi(
      res,
      tmapiError(405, "Use POST /1688/v2/item_detail_by_url with JSON { url }")
    );
    return;
  }
  const body = await readJsonBody(req);
  if (body == null) {
    sendTmapi(res, tmapiError(422, "Invalid JSON body"));
    return;
  }
  const itemId = extractOfferIdFromUrl(body.url || body.item_url || "");
  const language = normalizeLanguage(body.language || "en");
  const optimizeTitle = Boolean(body.optimize_title);
  if (!itemId) {
    sendTmapi(
      res,
      tmapiError(422, "url is required and must contain a 1688 offer id")
    );
    return;
  }
  await withJob(
    res,
    `item_detail_by_url:${itemId}:${language}`,
    () =>
      getItemDetailById(itemId, {
        language,
        optimize_title: optimizeTitle,
      }),
    {
      tmapi: true,
      cacheTtl: ITEM_CACHE_TTL,
      cacheParts: ["item_detail", itemId, language, optimizeTitle],
      swr: true,
    }
  );
}

async function handleItemDesc(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/item_desc?item_id=..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const itemId = (url.searchParams.get("item_id") || "").trim();
  const language = normalizeLanguage(url.searchParams.get("language") || "en");
  if (!/^\d+$/.test(itemId)) {
    sendTmapi(res, tmapiError(422, "item_id is required"));
    return;
  }
  await withJob(
    res,
    `item_desc:${itemId}:${language}`,
    () => getItemDesc(itemId, { language }),
    {
      cacheTtl: ITEM_CACHE_TTL,
      cacheParts: ["item_desc", itemId, language],
      swr: true,
    }
  );
}

async function handleItemReview(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/item_review?item_id=..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const itemId = (url.searchParams.get("item_id") || "").trim();
  const language = normalizeLanguage(url.searchParams.get("language") || "en");
  const page = Number(url.searchParams.get("page") || 1);
  const page_size = Number(url.searchParams.get("page_size") || 20);
  if (!/^\d+$/.test(itemId)) {
    sendTmapi(res, tmapiError(422, "item_id is required"));
    return;
  }
  await withJob(
    res,
    `item_review:${itemId}`,
    () => getItemReviews(itemId, { page, page_size, language }),
    {
      cacheTtl: LIST_CACHE_TTL,
      cacheParts: ["item_review", itemId, page, page_size, language],
      swr: true,
    }
  );
}

async function handleItemFreight(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/item_freight?item_id=..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const itemId = (url.searchParams.get("item_id") || "").trim();
  const language = normalizeLanguage(url.searchParams.get("language") || "en");
  const province = (url.searchParams.get("province") || "").trim();
  const totalQuantity = Math.max(
    1,
    Number(url.searchParams.get("total_quantity") || 1)
  );
  const totalWeight = Math.max(
    0,
    Number(url.searchParams.get("total_weight") || 0)
  );
  if (!/^\d+$/.test(itemId)) {
    sendTmapi(res, tmapiError(422, "item_id is required"));
    return;
  }
  await withJob(
    res,
    `item_freight:${itemId}`,
    () =>
      getItemFreight(itemId, {
        language,
        province,
        total_quantity: totalQuantity,
        total_weight: totalWeight,
      }),
    {
      cacheTtl: LIST_CACHE_TTL,
      cacheParts: [
        "item_freight",
        itemId,
        language,
        province,
        totalQuantity,
        totalWeight,
      ],
      swr: true,
    }
  );
}

async function handleSearchItems(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/search/items?keyword=..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const keyword = (url.searchParams.get("keyword") || "").trim();
  const page = Number(url.searchParams.get("page") || 1);
  const page_size = Number(url.searchParams.get("page_size") || 20);
  const sort = url.searchParams.get("sort") || "default";
  const language = normalizeLanguage(url.searchParams.get("language") || "en");
  const cat_id = [...new Set(
    String(
      url.searchParams.get("cat_ids") || url.searchParams.get("cat_id") || ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .join(",");
  const priceStart = url.searchParams.get("price_start") || "";
  const priceEnd = url.searchParams.get("price_end") || "";
  if (!keyword && !cat_id) {
    sendTmapi(res, tmapiError(422, "keyword is required"));
    return;
  }
  await withJob(res, `search:${keyword || cat_id}:${page}`, () =>
    searchItemsTmapi({
      keyword,
      page,
      page_size,
      sort,
      language,
      cat_id,
      price_start: priceStart,
      price_end: priceEnd,
    }),
    {
      tmapi: true,
      cacheTtl: SEARCH_CACHE_TTL,
      cacheParts: [
        "search",
        keyword,
        cat_id,
        priceStart,
        priceEnd,
        page,
        page_size,
        sort,
        language,
      ],
      serialKey: categorySerialKey({
        categories: cat_id,
        keyword,
        sort,
        priceStart,
        priceEnd,
        language,
      }),
    }
  );
}

async function handleSearchImage(req, res) {
  let img_url = "";
  let page = 1;
  let page_size = 20;
  let language = "en";
  let sort = "default";

  if (req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    img_url = url.searchParams.get("img_url") || url.searchParams.get("url") || "";
    page = Number(url.searchParams.get("page") || 1);
    page_size = Number(url.searchParams.get("page_size") || 20);
    language = normalizeLanguage(url.searchParams.get("language") || "en");
    sort = url.searchParams.get("sort") || "default";
  } else if (req.method === "POST") {
    const body = await readJsonBody(req);
    if (body == null) {
      sendTmapi(res, tmapiError(422, "Invalid JSON body"));
      return;
    }
    img_url = body.img_url || body.image_url || body.url || "";
    page = Number(body.page || 1);
    page_size = Number(body.page_size || 20);
    language = normalizeLanguage(body.language || "en");
    sort = body.sort || "default";
  } else {
    sendTmapi(
      res,
      tmapiError(405, "Use GET/POST /1688/search/image with img_url")
    );
    return;
  }

  await withJob(
    res,
    "search_img",
    () => searchByImage({ img_url, page, page_size, language, sort }),
    {
      cacheTtl: LIST_CACHE_TTL,
      cacheParts: ["search_image", img_url, page, page_size, language, sort],
      swr: true,
    }
  );
}

async function handleSearchFactory(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/search/factory?keywords=..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  await withJob(res, `search_factory`, () =>
    searchFactories({
      keywords:
        url.searchParams.get("keywords") || url.searchParams.get("keyword") || "",
      page: Number(url.searchParams.get("page") || 1),
      page_size: Number(url.searchParams.get("page_size") || 20),
      sort: url.searchParams.get("sort") || "default",
      language: normalizeLanguage(url.searchParams.get("language") || "en"),
    }),
    {
      cacheTtl: LIST_CACHE_TTL,
      cacheParts: [
        "search_factory",
        url.searchParams.get("keywords") || url.searchParams.get("keyword"),
        url.searchParams.get("page"),
        url.searchParams.get("page_size"),
        url.searchParams.get("sort"),
        url.searchParams.get("language"),
      ],
      swr: true,
    }
  );
}

function tokenMatches(candidate) {
  if (!SCRAPER_API_TOKEN || !candidate) return false;
  const expected = Buffer.from(SCRAPER_API_TOKEN);
  const actual = Buffer.from(String(candidate));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function requestIsAuthorized(req, url) {
  if (!SCRAPER_API_TOKEN) return true;
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return tokenMatches(
    req.headers["x-api-token"] ||
      bearer ||
      url.searchParams.get("apiToken") ||
      url.searchParams.get("api_token")
  );
}

async function handleShopItems(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/shop/items or /1688/shop/items/v2"));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  await withJob(res, `shop_items`, () =>
    getShopItems({
      shop_url: url.searchParams.get("shop_url") || "",
      member_id: url.searchParams.get("member_id") || "",
      page: Number(url.searchParams.get("page") || 1),
      page_size: Number(url.searchParams.get("page_size") || 20),
      sort: url.searchParams.get("sort") || "default",
      keyword: url.searchParams.get("keyword") || "",
      shop_cat_id:
        url.searchParams.get("shop_cat_id") ||
        url.searchParams.get("cat_id") ||
        url.searchParams.get("cat") ||
        "",
      price_start: url.searchParams.get("price_start") || "",
      price_end: url.searchParams.get("price_end") || "",
      language: normalizeLanguage(url.searchParams.get("language") || "en"),
    }),
    {
      cacheTtl: LIST_CACHE_TTL,
      cacheParts: [
        "shop_items",
        url.searchParams.get("shop_url"),
        url.searchParams.get("member_id"),
        url.searchParams.get("page"),
        url.searchParams.get("page_size"),
        url.searchParams.get("sort"),
        url.searchParams.get("keyword"),
        url.searchParams.get("shop_cat_id") ||
          url.searchParams.get("cat_id") ||
          url.searchParams.get("cat"),
        url.searchParams.get("price_start"),
        url.searchParams.get("price_end"),
        url.searchParams.get("language"),
      ],
      swr: true,
    }
  );
}

async function handleShopInfo(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/shop/info?..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  await withJob(res, `shop_info`, () =>
    getShopInfo({
      shop_url: url.searchParams.get("shop_url") || "",
      member_id: url.searchParams.get("member_id") || "",
      language: normalizeLanguage(url.searchParams.get("language") || "en"),
    }),
    {
      cacheTtl: META_CACHE_TTL,
      cacheParts: [
        "shop_info",
        url.searchParams.get("shop_url"),
        url.searchParams.get("member_id"),
        url.searchParams.get("language"),
      ],
      swr: true,
    }
  );
}

async function handleShopCats(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/shop/cats?..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  await withJob(res, `shop_cats`, () =>
    getShopCategories({
      shop_url: url.searchParams.get("shop_url") || "",
      member_id: url.searchParams.get("member_id") || "",
      language: normalizeLanguage(url.searchParams.get("language") || "en"),
    }),
    {
      cacheTtl: META_CACHE_TTL,
      cacheParts: [
        "shop_categories",
        url.searchParams.get("shop_url"),
        url.searchParams.get("member_id"),
        url.searchParams.get("language"),
      ],
      swr: true,
    }
  );
}

async function handleCategoryInfo(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/category/info?cat_id=..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  await withJob(res, `category_info`, () =>
    getCategoryInfo({
      cat_id: url.searchParams.get("cat_id") || "",
      language: normalizeLanguage(url.searchParams.get("language") || "en"),
    }),
    {
      cacheTtl: META_CACHE_TTL,
      cacheParts: [
        "category_info",
        url.searchParams.get("cat_id"),
        url.searchParams.get("language"),
      ],
      swr: true,
    }
  );
}

async function handleCategoryProducts(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/category/products?..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const categoryId = url.searchParams.get("cat_id") || "";
  const keyword = url.searchParams.get("keyword") || "*";
  const sort = url.searchParams.get("sort") || "default";
  const language = normalizeLanguage(url.searchParams.get("language") || "en");
  const priceStart = url.searchParams.get("price_start") || "";
  const priceEnd = url.searchParams.get("price_end") || "";
  await withJob(res, `category_products`, () =>
    getCategoryProducts({
      cat_id: categoryId,
      keyword,
      page: Number(url.searchParams.get("page") || 1),
      page_size: Number(url.searchParams.get("page_size") || 20),
      sort,
      language,
      price_start: priceStart,
      price_end: priceEnd,
    }),
    {
      cacheTtl: LIST_CACHE_TTL,
      cacheParts: [
        "category_products",
        url.searchParams.get("cat_id"),
        url.searchParams.get("keyword"),
        url.searchParams.get("page"),
        url.searchParams.get("page_size"),
        url.searchParams.get("sort"),
        url.searchParams.get("price_start"),
        url.searchParams.get("price_end"),
        url.searchParams.get("language"),
      ],
      swr: true,
      serialKey: categorySerialKey({
        categories: categoryId,
        keyword,
        sort,
        priceStart,
        priceEnd,
        language,
      }),
    }
  );
}

async function handleCrossSearchItems(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/search/items/v2?..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const keyword = url.searchParams.get("keyword") || "";
  const catId = [...new Set(
    String(
      url.searchParams.get("cat_ids") || url.searchParams.get("cat_id") || ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .join(",");
  const page = Number(url.searchParams.get("page") || 1);
  const pageSize = Number(url.searchParams.get("page_size") || 20);
  const sort = url.searchParams.get("sort") || "default";
  const language = normalizeLanguage(url.searchParams.get("language") || "en");
  const priceStart = url.searchParams.get("price_start") || "";
  const priceEnd = url.searchParams.get("price_end") || "";
  await withJob(
    res,
    `cross_search_items:${keyword || catId}:${page}`,
    () =>
      searchItemsCrossBorder({
        keyword,
        cat_id: catId,
        page,
        page_size: pageSize,
        sort,
        language,
        price_start: priceStart,
        price_end: priceEnd,
      }),
    {
      cacheTtl: SEARCH_CACHE_TTL,
      cacheParts: [
        "cross_search",
        keyword,
        catId,
        priceStart,
        priceEnd,
        page,
        pageSize,
        sort,
        language,
      ],
      swr: true,
      serialKey: categorySerialKey({
        categories: catId,
        keyword,
        sort,
        priceStart,
        priceEnd,
        language,
      }),
    }
  );
}

async function handleCrossSearchImage(req, res) {
  let img_url = "";
  let page = 1;
  let page_size = 20;
  let language = "en";
  let sort = "default";

  if (req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    img_url = url.searchParams.get("img_url") || "";
    page = Number(url.searchParams.get("page") || 1);
    page_size = Number(url.searchParams.get("page_size") || 20);
    language = normalizeLanguage(url.searchParams.get("language") || "en");
    sort = url.searchParams.get("sort") || "default";
  } else if (req.method === "POST") {
    const body = await readJsonBody(req);
    if (body == null) {
      sendTmapi(res, tmapiError(422, "Invalid JSON body"));
      return;
    }
    img_url = body.img_url || body.url || "";
    page = Number(body.page || 1);
    page_size = Number(body.page_size || 20);
    language = normalizeLanguage(body.language || "en");
    sort = body.sort || "default";
  } else {
    sendTmapi(res, tmapiError(405, "Use GET/POST global search image"));
    return;
  }

  await withJob(
    res,
    `cross_search_img:${page}`,
    () => searchByImageCrossBorder({ img_url, page, page_size, language, sort }),
    {
      cacheTtl: LIST_CACHE_TTL,
      cacheParts: ["cross_search_image", img_url, page, page_size, language, sort],
      swr: true,
    }
  );
}

async function handleImgConvert(req, res) {
  if (req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    sendTmapi(
      res,
      convertImageUrl(url.searchParams.get("img_url") || url.searchParams.get("url") || "", {
        width: url.searchParams.get("width"),
        height: url.searchParams.get("height"),
      })
    );
    return;
  }
  if (req.method === "POST") {
    const body = await readJsonBody(req);
    if (body == null) {
      sendTmapi(res, tmapiError(422, "Invalid JSON body"));
      return;
    }
    sendTmapi(
      res,
      convertImageUrl(body.url || body.img_url || "", {
        width: body.width,
        height: body.height,
      })
    );
    return;
  }
  sendTmapi(res, tmapiError(405, "Use GET/POST image convert"));
}

async function handleParseUrl(req, res) {
  if (req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    sendTmapi(res, parseOfferUrl(url.searchParams.get("url") || ""));
    return;
  }
  if (req.method === "POST") {
    const body = await readJsonBody(req);
    if (body == null) {
      sendTmapi(res, tmapiError(422, "Invalid JSON body"));
      return;
    }
    sendTmapi(res, parseOfferUrl(body.url || ""));
    return;
  }
  sendTmapi(res, tmapiError(405, "Use GET/POST parse url"));
}

async function handleLegacyScrape(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /api/scrape?id=<offerId>"));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = (
    url.searchParams.get("id") ||
    url.searchParams.get("item_id") ||
    ""
  ).trim();
  const language = normalizeLanguage(
    url.searchParams.get("language") || url.searchParams.get("lang") || "en"
  );
  if (!/^\d+$/.test(id)) {
    sendTmapi(res, tmapiError(422, "id/item_id must be a number"));
    return;
  }
  await withJob(res, `offer:${id}:${language}`, () =>
    getItemDetailById(id, { language })
  );
}

async function handleLegacySearch(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Use GET /api/search?q=..." });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = (url.searchParams.get("q") || url.searchParams.get("keyword") || "").trim();
  const page = Number(url.searchParams.get("page") || 1);
  const lang = normalizeLanguage(
    url.searchParams.get("lang") || url.searchParams.get("language") || "en"
  );
  if (!q) {
    sendJson(res, 400, { error: "Missing search query" });
    return;
  }
  await withJob(
    res,
    `legacy_search:${q}:${page}`,
    () => searchOffers(q, { page, lang }),
    { tmapi: false }
  );
}

const ROUTES = [
  // Item APIs
  ["/1688/v2/item_detail", handleItemDetail],
  // TMAPI-compatible aliases used by the Chibox backend.
  ["/1688/item_detail", handleItemDetail],
  ["/1688/global/item_detail", handleItemDetail],
  ["/api/1688/v2/item_detail", handleItemDetail],
  ["/1688/v2/item_detail_by_url", handleItemDetailByUrl],
  ["/1688/item_detail_by_url", handleItemDetailByUrl],
  ["/api/1688/v2/item_detail_by_url", handleItemDetailByUrl],
  ["/1688/item_desc", handleItemDesc],
  ["/1688/item_review", handleItemReview],
  ["/1688/item/rating", handleItemReview],
  ["/1688/item_reviews", handleItemReview],
  ["/1688/v2/item_review", handleItemReview],
  ["/1688/item_freight", handleItemFreight],
  ["/1688/item/shipping", handleItemFreight],
  ["/1688/v2/item_freight", handleItemFreight],

  // Search APIs
  ["/1688/search/items", handleSearchItems],
  ["/1688/global/search/items", handleSearchItems],
  ["/1688/search/items/v2", handleCrossSearchItems],
  ["/1688/v2/search/items", handleSearchItems],
  ["/1688/search/image", handleSearchImage],
  ["/1688/search/img", handleSearchImage],
  ["/1688/search/factory", handleSearchFactory],
  ["/1688/search/factories", handleSearchFactory],

  // Cross-border APIs
  ["/1688/global/search/image", handleCrossSearchImage],
  ["/1688/global/search/image/v2", handleCrossSearchImage],
  ["/1688/cross/search/items", handleCrossSearchItems],
  ["/1688/cross/search/image", handleCrossSearchImage],
  ["/1688/cross/search/image/v2", handleCrossSearchImage],

  // Shop APIs
  ["/1688/shop/items", handleShopItems],
  ["/1688/shop/items/v2", handleShopItems],
  ["/1688/shop/info", handleShopInfo],
  ["/1688/shop/shop_info", handleShopInfo],
  ["/1688/shop/cats", handleShopCats],
  ["/1688/shop/category", handleShopCats],
  ["/1688/shop/categories", handleShopCats],

  // Category APIs
  ["/1688/category/info", handleCategoryInfo],
  ["/1688/v2/category/info", handleCategoryInfo],
  ["/1688/category/products", handleCategoryProducts],
  ["/1688/category/items", handleCategoryProducts],
  ["/1688/category/products/v2", handleCategoryProducts],
  ["/1688/category/items/v2", handleCategoryProducts],
  ["/1688/category/get_category_items", handleCategoryProducts],

  // Tools
  ["/1688/img/convert", handleImgConvert],
  ["/1688/tools/image/convert_url", handleImgConvert],
  ["/1688/tools/img_convert", handleImgConvert],
  ["/1688/img_convert", handleImgConvert],
  ["/tools/parse/url", handleParseUrl],
  ["/1688/tools/parse_url", handleParseUrl],

  // Legacy
  ["/api/scrape", handleLegacyScrape],
  ["/api/search", handleLegacySearch],
];

async function handleHealth(req, res) {
  const auth = await assertAuthLooksValid();
  const browsers = browserPoolStats();
  const requiredBrowsers = 1;
  if (browsers.live < requiredBrowsers && !browsers.closing && !browsers.closed) {
    void warmBrowserPool().catch(() => {});
  }
  const ready =
    auth.ok &&
    !browsers.closing &&
    !browsers.closed &&
    browsers.live >= requiredBrowsers;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const summary = {
    ok: true,
    status: "ok",
    ready,
  };
  if (!requestIsAuthorized(req, url)) {
    sendJson(res, 200, summary);
    return;
  }
  sendJson(res, 200, {
    ...summary,
    auth,
    security: { apiTokenRequired: Boolean(SCRAPER_API_TOKEN) },
    uptimeSec: Math.round(process.uptime()),
    queue: jobQueueStats(),
    browsers,
    cache: cacheStats(),
    hardware: recommendedHardware(),
  });
}

async function handleReady(_req, res) {
  const auth = await assertAuthLooksValid();
  const browsers = browserPoolStats();
  const requiredBrowsers = 1;
  if (browsers.live < requiredBrowsers && !browsers.closing && !browsers.closed) {
    void warmBrowserPool().catch(() => {});
  }
  const ready =
    auth.ok &&
    !browsers.closing &&
    !browsers.closed &&
    browsers.live >= requiredBrowsers;
  sendJson(res, ready ? 200 : 503, { ready });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      await handleHealth(req, res);
      return;
    }
    if (url.pathname === "/ready" || url.pathname === "/api/ready") {
      await handleReady(req, res);
      return;
    }
    const hit = ROUTES.find(([path]) => url.pathname === path);
    if (hit) {
      if (!requestIsAuthorized(req, url)) {
        sendTmapi(res, tmapiError(401, "Invalid or missing API token"));
        return;
      }
      await hit[1](req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (err) {
    const status = Number(err?.httpStatus) || 500;
    if (String(req.url || "").startsWith("/1688/")) {
      sendTmapi(res, tmapiError(status, err.message || "Server error"));
    } else {
      sendJson(res, status, { error: err.message || "Server error" });
    }
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS + 5_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, async () => {
  console.log(`1688 scraper UI → http://localhost:${PORT}`);
  console.log(`Health → http://localhost:${PORT}/health`);
  console.log(`TMAPI routes mounted under /1688/...`);
  console.log(`[security] API token ${SCRAPER_API_TOKEN ? "required" : "disabled"}`);
  const hw = recommendedHardware();
  console.log(
    `[capacity] maxConcurrent=${hw.maxConcurrent} maxQueue=${hw.maxQueue} (target ~${hw.targetUsers} users)`
  );
  console.log(`[hardware] recommend ${hw.suggest.vcpu} vCPU, ${hw.suggest.ramGb} GB RAM`);
  warmBrowserPool().catch((err) =>
    console.error(`[pool] warm failed: ${err.message}`)
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  const stopped = new Promise((resolveClose) => server.close(resolveClose));
  const forceTimer = setTimeout(() => {
    server.closeAllConnections?.();
  }, 10_000);
  forceTimer.unref?.();
  await stopped.catch(() => {});
  clearTimeout(forceTimer);
  await Promise.allSettled([closeOfferHttpClient(), closeBrowserPool()]);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
