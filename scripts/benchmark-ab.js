#!/usr/bin/env node

/**
 * Paired A/B benchmark for the exact 1688 aliases used by Chibox.
 *
 * Required:
 *   OLD_BASE, NEW_BASE
 *   IMAGE_SEARCH_URL when AB_ENDPOINTS=all (the default)
 *
 * Authentication (tokens are never printed):
 *   OLD_API_TOKEN, OLD_AUTH_MODE=query|header|bearer|none
 *   NEW_API_TOKEN, NEW_AUTH_MODE=query|header|bearer|none
 *   API_TOKEN may be used as a shared fallback token.
 *
 * Useful controls:
 *   AB_SAMPLES=20                  (minimum 10)
 *   AB_ENDPOINTS=all|core|name,...
 *   AB_TIMEOUT_MS=45000
 *   AB_WARMUPS=1
 *   AB_CONCURRENCY=4               (maximum 16)
 *   AB_CONCURRENCY_REQUESTS=12
 *   AB_CONCURRENCY_ROUNDS=2
 *   AB_DISTINCT_DETAIL_COUNT=8
 *   AB_REQUIRE_DISTINCT_LOAD=1
 *   AB_MIN_OLD_SUCCESS_RATE=0.8
 *   AB_MIN_NEW_SUCCESS_RATE=1.0
 *   AB_MIN_EQUIV_RATE=1.0
 *   AB_MIN_LIST_OVERLAP=0.5
 *   AB_LIST_TOTAL_TOLERANCE=0.05
 *   AB_PRICE_TOLERANCE=0.10
 *   AB_SHIPPING_TOLERANCE=0.05
 *   AB_MAX_NEW_P95_RATIO=0.95|off
 *   AB_MAX_PAIRED_P50_RATIO=0.95|off
 *   AB_MIN_NEW_WIN_RATE=0.60
 *   AB_MAX_CONCURRENCY_RATIO=0.95|off
 *
 * This script deliberately does not call any result "cold". Remote process,
 * disk, CDN, browser, and upstream caches cannot be controlled from here.
 */

import { performance } from "node:perf_hooks";

const ENV = process.env;

function safeErrorMessage(error) {
  let message = String(error?.message || "unknown error");
  const secrets = [ENV.API_TOKEN, ENV.OLD_API_TOKEN, ENV.NEW_API_TOKEN]
    .map((value) => String(value || ""))
    .filter(Boolean);
  for (const secret of secrets) {
    message = message.replaceAll(secret, "[TOKEN redacted]");
    try {
      message = message.replaceAll(encodeURIComponent(secret), "[TOKEN redacted]");
    } catch {
      // Keep redaction best-effort for malformed input.
    }
  }
  return message.replace(/https?:\/\/\S+/gi, "[URL redacted]");
}

process.once("uncaughtException", (error) => {
  const prefix = error?.config ? "A/B configuration error" : "A/B benchmark failed";
  console.error(`${prefix}: ${safeErrorMessage(error)}`);
  process.exit(error?.config ? 2 : 1);
});

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Chibox 1688 paired A/B benchmark

Required environment:
  OLD_BASE, NEW_BASE
  IMAGE_SEARCH_URL (required by the default all-endpoint run)
  OLD_API_TOKEN (defaults to query auth)
  NEW_API_TOKEN (defaults to query auth, matching Chibox)

Common controls:
  AB_ENDPOINTS=all|core|item_detail,text_search,... (default: all)
  AB_SAMPLES=20  AB_WARMUPS=1  AB_TIMEOUT_MS=45000
  AB_CONCURRENCY=4  AB_CONCURRENCY_REQUESTS=12  AB_CONCURRENCY_ROUNDS=2
  AB_DISTINCT_DETAIL_COUNT=8  AB_REQUIRE_DISTINCT_LOAD=1
  AB_MIN_OLD_SUCCESS_RATE=0.80  AB_MIN_NEW_SUCCESS_RATE=1.00
  OLD_AUTH_MODE=query|header|bearer|none
  NEW_AUTH_MODE=query|header|bearer|none
  AB_MAX_NEW_P95_RATIO=0.95  AB_MAX_PAIRED_P50_RATIO=0.95
  AB_MIN_NEW_WIN_RATE=0.60  AB_MAX_CONCURRENCY_RATIO=0.95

Run with: npm run test:ab
No token values or token-bearing request URLs are printed.`);
  process.exit(0);
}

function configError(message) {
  const error = new Error(message);
  error.config = true;
  return error;
}

function integerEnv(name, fallback, min, max) {
  const raw = ENV[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function ratioEnv(name, fallback) {
  const raw = ENV[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw configError(`${name} must be a number from 0 to 1`);
  }
  return value;
}

function booleanEnv(name, fallback) {
  const raw = ENV[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw configError(`${name} must be true/false or 1/0`);
}

function optionalPositiveEnv(name, fallback = null) {
  const raw = String(ENV[name] || "").trim();
  if (!raw) return fallback;
  if (["off", "none", "false"].includes(raw.toLowerCase())) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 10) {
    throw configError(`${name} must be a positive number no greater than 10`);
  }
  return value;
}

function normalizeBase(name) {
  const raw = String(ENV[name] || "").trim();
  if (!raw) throw configError(`${name} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw configError(`${name} must be a valid HTTP(S) URL`);
  }
  const localHttpAllowed = String(ENV.AB_ALLOW_LOCAL_HTTP || "") === "1";
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHttpAllowed && loopback)) {
    throw configError(
      `${name} must use HTTPS (set AB_ALLOW_LOCAL_HTTP=1 only for a loopback test server)`
    );
  }
  if (url.username || url.password) {
    throw configError(`${name} must not contain credentials`);
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function authMode(name, fallback) {
  const mode = String(ENV[name] || fallback).trim().toLowerCase();
  if (!["query", "header", "bearer", "none"].includes(mode)) {
    throw configError(`${name} must be query, header, bearer, or none`);
  }
  return mode;
}

function headerName(name) {
  const value = String(ENV[name] || "X-API-Token").trim();
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw configError(`${name} is not a valid HTTP header name`);
  }
  return value;
}

function queryName(name) {
  const value = String(ENV[name] || "apiToken").trim();
  if (!/^[A-Za-z0-9_.~-]+$/.test(value)) {
    throw configError(`${name} is not a valid query parameter name`);
  }
  return value;
}

function successCodes(name, fallback) {
  const raw = String(ENV[name] || fallback);
  const codes = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value));
  if (!codes.length) throw configError(`${name} must contain at least one integer API code`);
  return new Set(codes);
}

const OLD_BASE = normalizeBase("OLD_BASE");
const NEW_BASE = normalizeBase("NEW_BASE");
if (OLD_BASE.toString() === NEW_BASE.toString()) {
  throw configError("OLD_BASE and NEW_BASE must be different");
}

const SHARED_TOKEN = String(ENV.API_TOKEN || "").trim();
const PROVIDERS = {
  old: {
    key: "old",
    label: "OLD",
    base: OLD_BASE,
    token: String(ENV.OLD_API_TOKEN || SHARED_TOKEN).trim(),
    mode: authMode("OLD_AUTH_MODE", "query"),
    header: headerName("OLD_TOKEN_HEADER"),
    queryName: queryName("OLD_TOKEN_QUERY"),
    successCodes: successCodes("OLD_SUCCESS_CODES", "0,200"),
  },
  new: {
    key: "new",
    label: "NEW",
    base: NEW_BASE,
    token: String(ENV.NEW_API_TOKEN || SHARED_TOKEN).trim(),
    mode: authMode("NEW_AUTH_MODE", "query"),
    header: headerName("NEW_TOKEN_HEADER"),
    queryName: queryName("NEW_TOKEN_QUERY"),
    successCodes: successCodes("NEW_SUCCESS_CODES", "200"),
  },
};
for (const provider of Object.values(PROVIDERS)) {
  if (provider.mode !== "none" && !provider.token) {
    throw configError(`${provider.label}_API_TOKEN is required for ${provider.mode} auth`);
  }
}

const SAMPLES = integerEnv("AB_SAMPLES", 20, 10, 100);
const WARMUPS = integerEnv("AB_WARMUPS", 1, 0, 3);
const TIMEOUT_MS = integerEnv("AB_TIMEOUT_MS", 45_000, 1_000, 120_000);
const CONCURRENCY = integerEnv("AB_CONCURRENCY", 4, 1, 16);
const CONCURRENCY_REQUESTS = integerEnv(
  "AB_CONCURRENCY_REQUESTS",
  Math.max(12, CONCURRENCY * 2),
  CONCURRENCY,
  200
);
const CONCURRENCY_ROUNDS = integerEnv("AB_CONCURRENCY_ROUNDS", 2, 1, 4);
const DISTINCT_DETAIL_COUNT = integerEnv("AB_DISTINCT_DETAIL_COUNT", 8, 4, 20);
const REQUIRE_DISTINCT_LOAD = booleanEnv("AB_REQUIRE_DISTINCT_LOAD", true);
const COMMON_MIN_SUCCESS_RATE = ratioEnv("AB_MIN_SUCCESS_RATE", 1);
const MIN_OLD_SUCCESS_RATE = ratioEnv(
  "AB_MIN_OLD_SUCCESS_RATE",
  ENV.AB_MIN_SUCCESS_RATE === undefined ? 0.8 : COMMON_MIN_SUCCESS_RATE
);
const MIN_NEW_SUCCESS_RATE = ratioEnv(
  "AB_MIN_NEW_SUCCESS_RATE",
  COMMON_MIN_SUCCESS_RATE
);
const MIN_EQUIV_RATE = ratioEnv("AB_MIN_EQUIV_RATE", 1);
const MIN_LIST_OVERLAP = ratioEnv("AB_MIN_LIST_OVERLAP", 0.5);
const LIST_TOTAL_TOLERANCE = ratioEnv("AB_LIST_TOTAL_TOLERANCE", 0.05);
const PRICE_TOLERANCE = ratioEnv("AB_PRICE_TOLERANCE", 0.1);
const SHIPPING_TOLERANCE = ratioEnv("AB_SHIPPING_TOLERANCE", 0.05);
const STOCK_TOLERANCE = ratioEnv("AB_STOCK_TOLERANCE", 0.1);
const MAX_NEW_P95_RATIO = optionalPositiveEnv("AB_MAX_NEW_P95_RATIO", 0.95);
const MAX_PAIRED_P50_RATIO = optionalPositiveEnv("AB_MAX_PAIRED_P50_RATIO", 0.95);
const MIN_NEW_WIN_RATE = ratioEnv("AB_MIN_NEW_WIN_RATE", 0.6);
const MAX_CONCURRENCY_RATIO = optionalPositiveEnv("AB_MAX_CONCURRENCY_RATIO", 0.95);
const P95_SLACK_MS = integerEnv("AB_P95_SLACK_MS", 0, 0, 10_000);
const CONCURRENCY_SLACK_MS = integerEnv(
  "AB_CONCURRENCY_SLACK_MS",
  0,
  0,
  10_000
);

const CATEGORY_PAGE_SIZE = integerEnv("AB_CATEGORY_PAGE_SIZE", 50, 1, 50);
const SEARCH_PAGE_SIZE = integerEnv("AB_SEARCH_PAGE_SIZE", 20, 1, 50);
const SHOP_PAGE_SIZE = integerEnv("AB_SHOP_PAGE_SIZE", 20, 1, 50);
const IMAGE_PAGE_SIZE = integerEnv("AB_IMAGE_PAGE_SIZE", 20, 1, 50);
const FIXTURE = {
  itemId: String(ENV.ITEM_ID || "874039857500").trim(),
  categoryId: String(ENV.CATEGORY_ID || "130823000").trim(),
  memberId: String(ENV.MEMBER_ID || "b2b-221822542203833240").trim(),
  keyword: String(ENV.KEYWORD || "armrest pad").trim(),
  language: String(ENV.LANGUAGE || "en").trim(),
  province: String(ENV.PROVINCE || "Guangdong").trim(),
  imageUrl: String(ENV.IMAGE_URL || "https://cbu01.alicdn.com/img/ibank/O1CN01.jpg").trim(),
  imageSearchUrl: String(ENV.IMAGE_SEARCH_URL || "").trim(),
  shippingQuantity: integerEnv("SHIPPING_QUANTITY", 2, 1, 100_000),
};
FIXTURE.shopUrl = String(
  ENV.SHOP_URL ||
    `https://winport.m.1688.com/page/index.html?memberId=${encodeURIComponent(FIXTURE.memberId)}`
).trim();

if (!/^\d+$/.test(FIXTURE.itemId)) throw configError("ITEM_ID must be numeric");
if (!/^\d+$/.test(FIXTURE.categoryId)) throw configError("CATEGORY_ID must be numeric");
if (!FIXTURE.memberId) throw configError("MEMBER_ID is required");
if (!FIXTURE.keyword) throw configError("KEYWORD is required");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameId(left, right) {
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function itemId(item) {
  return String(
    item?.item_id ??
      item?.offer_id ??
      item?.offerId ??
      item?.cat_id ??
      item?.shop_cat_id ??
      item?.category_id ??
      item?.cid ??
      item?.id ??
      ""
  ).trim();
}

function itemTitle(item) {
  return String(item?.title ?? item?.subject ?? item?.name ?? "").trim();
}

function looksEnglish(value) {
  const text = String(value || "").trim();
  if (!/[A-Za-z]/.test(text)) return false;
  const compact = text.replace(/\s+/g, "");
  const han = compact.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length || 0;
  return han / Math.max(1, compact.length) <= 0.1;
}

function itemImage(item) {
  const value =
    item?.img ??
    item?.image ??
    item?.image_url ??
    item?.img_url ??
    item?.pic_url ??
    item?.main_img ??
    item?.main_image ??
    item?.main_imgs ??
    item?.images;
  if (Array.isArray(value)) return value[0] || "";
  return String(value || "").trim();
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return String(value || "").startsWith("//");
  }
}

function isAlibabaImage(value) {
  try {
    const hostname = new URL(String(value || "")).hostname.toLowerCase();
    return /(^|\.)(alicdn\.com|1688\.com|taobao\.com|tmall\.com)$/.test(hostname);
  } catch {
    return String(value || "").startsWith("/search/imgextra/");
  }
}

function normalizedImageIdentity(value) {
  try {
    const normalized = String(value || "").startsWith("//")
      ? `https:${value}`
      : String(value || "");
    const url = new URL(normalized);
    return `${url.hostname.toLowerCase()}${url.pathname}`;
  } catch {
    return String(value || "").trim();
  }
}

function itemPrice(item) {
  const priceInfo = isObject(item?.price_info) ? item.price_info : {};
  for (const value of [
    priceInfo.sale_price,
    priceInfo.price,
    priceInfo.price_min,
    priceInfo.min_price,
    priceInfo.origin_price,
    item?.price,
    item?.sale_price,
  ]) {
    const price = finiteNumber(value);
    if (price !== null && price > 0) return price;
  }
  return null;
}

function rowsFrom(data, keys = ["items", "list"]) {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return null;
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return null;
}

function inspectPagedCards(expectedPageSize) {
  return (data, provider) => {
    const issues = [];
    if (!isObject(data)) {
      return { issues: ["data is not an object"], profile: null };
    }
    const rows = rowsFrom(data, ["items"]);
    if (!Array.isArray(rows)) issues.push("data.items is not an array");
    else if (rows.length === 0) issues.push("data.items is empty");

    const page = finiteNumber(data.page ?? data.current_page);
    const pageSize = finiteNumber(data.page_size);
    if (page !== 1) issues.push("page is not 1");
    if (pageSize !== expectedPageSize) issues.push("page_size differs from request");
    const total = finiteNumber(data.total_count ?? data.total);
    if ((total === null || total < 0) && provider?.key === "new") {
      issues.push("total is missing or invalid");
    }
    if (typeof data.has_next_page !== "boolean") issues.push("has_next_page is not boolean");

    const safeRows = rows || [];
    const ids = [...new Set(safeRows.map(itemId).filter((id) => /^\d+$/.test(id)))];
    if (safeRows.length && ids.length !== safeRows.length) {
      issues.push("result IDs are missing or duplicated");
    }
    const usable = safeRows.filter(
      (item) =>
        /^\d+$/.test(itemId(item)) &&
        itemTitle(item) &&
        isHttpUrl(itemImage(item)) &&
        itemPrice(item) !== null
    );
    if (safeRows.length && usable.length / safeRows.length < 0.5) {
      issues.push("fewer than half of result cards are consumer-usable");
    }
    if (String(FIXTURE.language).toLowerCase() === "en" && safeRows.length) {
      const english = safeRows.filter((item) => looksEnglish(itemTitle(item)));
      if (english.length / safeRows.length < 0.8) {
        issues.push("fewer than 80% of result titles are observably English");
      }
    }
    if (total !== null && total >= 0) {
      const expectedCount = Math.min(expectedPageSize, total);
      if (provider?.key === "new" && safeRows.length !== expectedCount) {
        issues.push("result count is inconsistent with page_size and total");
      } else if (provider?.key === "old" && safeRows.length > expectedPageSize) {
        issues.push("result count exceeds requested page_size");
      }
      const expectedNext = expectedPageSize < total;
      if (typeof data.has_next_page === "boolean" && data.has_next_page !== expectedNext) {
        issues.push("has_next_page is inconsistent with total");
      }
    }
    return {
      issues,
      profile: {
        kind: "list",
        ids,
        count: safeRows.length,
        page,
        pageSize,
        total,
        hasNext: data.has_next_page,
      },
    };
  };
}

function inspectDetail(
  data,
  expectedItemId = FIXTURE.itemId,
  { requireMoq = true } = {}
) {
  const issues = [];
  if (!isObject(data)) return { issues: ["data is not an object"], profile: null };
  const id = itemId(data);
  if (!sameId(id, expectedItemId)) issues.push("item identity differs from fixture");
  if (!itemTitle(data)) issues.push("title is missing");
  if (
    String(FIXTURE.language).toLowerCase() === "en" &&
    itemTitle(data) &&
    !looksEnglish(itemTitle(data))
  ) {
    issues.push("English detail title is still predominantly Chinese");
  }
  const price = itemPrice(data);
  if (price === null) issues.push("positive price is missing");
  const moq = finiteNumber(
    data.quantity_begin ?? data.moq ?? data.tiered_price_info?.begin_num
  );
  if (requireMoq && (moq === null || moq <= 0)) issues.push("MOQ is missing or invalid");
  const stock = finiteNumber(data.stock ?? data.total_stock);
  if (stock === null || stock < 0) issues.push("stock is missing or invalid");
  const images = [
    ...(Array.isArray(data.main_imgs) ? data.main_imgs : []),
    ...(Array.isArray(data.images) ? data.images : []),
    data.main_img,
    data.img,
  ].filter(isHttpUrl);
  if (!images.length) issues.push("HTTP product image is missing");

  const props = Array.isArray(data.sku_props) ? data.sku_props : [];
  const skus = Array.isArray(data.skus) ? data.skus : [];
  if ((props.length === 0) !== (skus.length === 0)) {
    issues.push("sku_props and skus are incomplete");
  } else if (props.length && skus.length) {
    const allowed = new Map();
    for (const prop of props) {
      const pid = String(prop?.pid ?? prop?.prop_id ?? "").trim();
      const values = new Set(
        (Array.isArray(prop?.values) ? prop.values : [])
          .map((value) => String(value?.vid ?? value?.value_id ?? "").trim())
          .filter(Boolean)
      );
      if (pid && values.size) allowed.set(pid, values);
    }
    if (allowed.size !== props.length) issues.push("SKU property definitions are incomplete");
    let invalidSkus = 0;
    for (const sku of skus) {
      if (itemPrice(sku) === null || finiteNumber(sku?.stock) === null) invalidSkus += 1;
      const pairs = String(sku?.props_ids ?? sku?.prop_path ?? "")
        .split(";")
        .filter(Boolean);
      if (!pairs.length) invalidSkus += 1;
      for (const pair of pairs) {
        const [pid, vid] = pair.split(":").map((value) => String(value || "").trim());
        if (!allowed.has(pid) || !allowed.get(pid).has(vid)) invalidSkus += 1;
      }
    }
    if (invalidSkus) issues.push("one or more SKUs has invalid price, stock, or property references");
  }
  return {
    issues,
    profile: { kind: "detail", identity: id, price, moq, stock, skuCount: skus.length },
  };
}

function inspectCategoryTop(data) {
  const issues = [];
  const rows = rowsFrom(data, ["items", "list"]);
  if (!Array.isArray(rows) || rows.length === 0) issues.push("category list is empty or missing");
  const ids = [...new Set((rows || []).map(itemId).filter(Boolean))];
  if (!ids.length) issues.push("category IDs are missing");
  return { issues, profile: { kind: "unpaged-list", ids, count: rows?.length || 0 } };
}

function inspectCategoryInfo(data) {
  const issues = [];
  if (!isObject(data)) return { issues: ["data is not an object"], profile: null };
  const id = itemId(data);
  if (!sameId(id, FIXTURE.categoryId)) issues.push("category identity differs from fixture");
  if (!nonBlank(data.name ?? data.category_name ?? data.title)) issues.push("category name is missing");
  return { issues, profile: { kind: "identity", identity: id } };
}

function inspectShopInfo(data) {
  const issues = [];
  if (!isObject(data)) return { issues: ["data is not an object"], profile: null };
  const id = String(data.member_id ?? data.seller_member_id ?? "").trim();
  if (!sameId(id, FIXTURE.memberId)) issues.push("shop member identity differs from fixture");
  if (!nonBlank(data.shop_name ?? data.company_name ?? data.name)) issues.push("shop name is missing");
  return { issues, profile: { kind: "identity", identity: id } };
}

function inspectShopCategories(data) {
  const issues = [];
  const rows = rowsFrom(data, ["categories", "shop_categories", "list", "items", "data"]);
  if (!Array.isArray(rows) || rows.length === 0) issues.push("shop category list is empty or missing");
  const ids = [...new Set((rows || []).map(itemId).filter(Boolean))];
  if (!ids.length) issues.push("shop category IDs are missing");
  return { issues, profile: { kind: "unpaged-list", ids, count: rows?.length || 0 } };
}

function inspectShipping(data) {
  const issues = [];
  if (!isObject(data)) return { issues: ["data is not an object"], profile: null };
  const id = itemId(data);
  if (!sameId(id, FIXTURE.itemId)) issues.push("shipping item identity differs from fixture");
  const fee = finiteNumber(data.total_fee ?? data.shipping_fee ?? data.freight);
  if (fee === null || fee < 0) issues.push("shipping fee is missing or invalid");
  const quantity = finiteNumber(data.total_quantity ?? data.quantity);
  if (quantity !== FIXTURE.shippingQuantity) issues.push("shipping quantity differs from request");
  return { issues, profile: { kind: "numeric", identity: id, value: fee } };
}

function inspectRatings(data) {
  const issues = [];
  if (!isObject(data)) return { issues: ["data is not an object"], profile: null };
  const rows = rowsFrom(data, ["list", "items", "reviews", "ratings"]);
  if (!Array.isArray(rows)) issues.push("rating list is missing");
  const id = String(data.item_id ?? FIXTURE.itemId).trim();
  if (!sameId(id, FIXTURE.itemId)) issues.push("rating item identity differs from fixture");
  const ids = [...new Set((rows || []).map(itemId).filter(Boolean))];
  return {
    issues,
    profile: { kind: "rows", identity: id, ids, count: rows?.length || 0 },
  };
}

function inspectConvertedImage(data) {
  const issues = [];
  if (!isObject(data)) return { issues: ["data is not an object"], profile: null };
  const url = data.converted_url ?? data.image_url ?? data.converted ?? data.url;
  if (!isAlibabaImage(url)) issues.push("converted image is not an Alibaba URL/path");
  if (!isAlibabaImage(FIXTURE.imageUrl) && String(url) === FIXTURE.imageUrl) {
    issues.push("external image was returned unchanged");
  }
  if (
    isAlibabaImage(FIXTURE.imageUrl) &&
    normalizedImageIdentity(url) !== normalizedImageIdentity(FIXTURE.imageUrl)
  ) {
    issues.push("converted Alibaba image identity differs from input");
  }
  return {
    issues,
    profile: { kind: "url", identity: normalizedImageIdentity(url) },
  };
}

const ENDPOINTS = new Map([
  [
    "item_detail",
    {
      label: "item detail",
      method: "GET",
      path: "/1688/item_detail",
      query: { item_id: FIXTURE.itemId, language: FIXTURE.language },
      inspect: (data, provider) =>
        inspectDetail(data, FIXTURE.itemId, { requireMoq: provider?.key === "new" }),
    },
  ],
  [
    "global_item_detail",
    {
      label: "global item detail",
      method: "GET",
      path: "/1688/global/item_detail",
      query: { item_id: FIXTURE.itemId, language: FIXTURE.language },
      inspect: (data, provider) =>
        inspectDetail(data, FIXTURE.itemId, { requireMoq: provider?.key === "new" }),
    },
  ],
  [
    "category_top",
    {
      label: "category top",
      method: "GET",
      path: "/1688/category/info",
      query: {},
      inspect: inspectCategoryTop,
    },
  ],
  [
    "category_info",
    {
      label: "category info",
      method: "GET",
      path: "/1688/category/info",
      query: { cat_id: FIXTURE.categoryId },
      inspect: inspectCategoryInfo,
    },
  ],
  [
    "category_items",
    {
      label: "category items",
      method: "GET",
      path: "/1688/category/items",
      query: { cat_id: FIXTURE.categoryId, page: 1, page_size: CATEGORY_PAGE_SIZE },
      inspect: inspectPagedCards(CATEGORY_PAGE_SIZE),
    },
  ],
  [
    "text_search",
    {
      label: "global text search",
      method: "GET",
      path: "/1688/global/search/items",
      query: {
        keyword: FIXTURE.keyword,
        page: 1,
        page_size: SEARCH_PAGE_SIZE,
        language: FIXTURE.language,
        sort: "default",
      },
      inspect: inspectPagedCards(SEARCH_PAGE_SIZE),
    },
  ],
  [
    "shop_info",
    {
      label: "shop info",
      method: "GET",
      path: "/1688/shop/shop_info",
      query: { member_id: FIXTURE.memberId, shop_url: FIXTURE.shopUrl },
      inspect: inspectShopInfo,
    },
  ],
  [
    "shop_categories",
    {
      label: "shop categories",
      method: "GET",
      path: "/1688/shop/category",
      query: { member_id: FIXTURE.memberId, shop_url: FIXTURE.shopUrl },
      inspect: inspectShopCategories,
    },
  ],
  [
    "shop_items",
    {
      label: "shop items",
      method: "GET",
      path: "/1688/shop/items",
      query: { member_id: FIXTURE.memberId, page: 1, page_size: SHOP_PAGE_SIZE, sort: "default" },
      inspect: inspectPagedCards(SHOP_PAGE_SIZE),
    },
  ],
  [
    "shop_url_items",
    {
      label: "shop URL items",
      method: "GET",
      path: "/1688/shop/items/v2",
      query: { shop_url: FIXTURE.shopUrl, page: 1, page_size: SHOP_PAGE_SIZE, sort: "default" },
      inspect: inspectPagedCards(SHOP_PAGE_SIZE),
    },
  ],
  [
    "shipping",
    {
      label: "item shipping",
      method: "GET",
      path: "/1688/item/shipping",
      query: {
        item_id: FIXTURE.itemId,
        province: FIXTURE.province,
        total_quantity: FIXTURE.shippingQuantity,
      },
      inspect: inspectShipping,
    },
  ],
  [
    "ratings",
    {
      label: "item ratings",
      method: "GET",
      path: "/1688/item/rating",
      query: { item_id: FIXTURE.itemId, page: 1, sort_type: "default" },
      inspect: inspectRatings,
    },
  ],
  [
    "image_convert",
    {
      label: "image URL conversion",
      method: "POST",
      path: "/1688/tools/image/convert_url",
      query: {},
      body: { url: FIXTURE.imageUrl },
      inspect: inspectConvertedImage,
    },
  ],
  [
    "image_search",
    {
      label: "image search",
      method: "GET",
      path: "/1688/search/image",
      query: {
        img_url: FIXTURE.imageSearchUrl,
        page: 1,
        page_size: IMAGE_PAGE_SIZE,
        language: FIXTURE.language,
        sort: "default",
      },
      inspect: inspectPagedCards(IMAGE_PAGE_SIZE),
      available: () => Boolean(FIXTURE.imageSearchUrl),
      unavailableReason: "IMAGE_SEARCH_URL is required for identical A/B image-search input",
    },
  ],
]);

const CORE_ENDPOINTS = [
  "item_detail",
  "text_search",
  "category_items",
  "shop_info",
  "shop_items",
  "shipping",
];

function selectedEndpoints() {
  const raw = String(ENV.AB_ENDPOINTS || "all").trim().toLowerCase();
  const names =
    raw === "core"
      ? CORE_ENDPOINTS
      : raw === "all"
        ? [...ENDPOINTS.keys()]
        : raw.split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) throw configError("AB_ENDPOINTS selected no endpoints");
  const unique = [...new Set(names)];
  return unique.map((name) => {
    const endpoint = ENDPOINTS.get(name);
    if (!endpoint) {
      throw configError(`Unknown AB endpoint '${name}'. Available: ${[...ENDPOINTS.keys()].join(",")}`);
    }
    if (endpoint.available && !endpoint.available()) {
      throw configError(endpoint.unavailableReason);
    }
    return { key: name, ...endpoint };
  });
}

const SELECTED_ENDPOINTS = selectedEndpoints();
if (
  REQUIRE_DISTINCT_LOAD &&
  !SELECTED_ENDPOINTS.some((endpoint) => endpoint.key === "text_search")
) {
  throw configError(
    "AB_REQUIRE_DISTINCT_LOAD=1 requires text_search so common live item IDs can be discovered"
  );
}

function buildRequest(provider, endpoint) {
  const url = new URL(endpoint.path.replace(/^\//, ""), provider.base);
  for (const [key, value] of Object.entries(endpoint.query || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": "chibox-1688-ab-benchmark/1.0",
  });
  if (provider.token && provider.mode === "query") {
    url.searchParams.set(provider.queryName, provider.token);
  } else if (provider.token && provider.mode === "header") {
    headers.set(provider.header, provider.token);
  } else if (provider.token && provider.mode === "bearer") {
    headers.set("Authorization", `Bearer ${provider.token}`);
  }

  const init = {
    method: endpoint.method || "GET",
    headers,
    // Never forward token-bearing requests to a redirect target.
    redirect: "manual",
  };
  if (endpoint.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(endpoint.body);
  }
  return { url, init };
}

function evaluateResponse(raw, endpoint, provider) {
  const issues = [];
  if (raw.errorCode) issues.push(`request failed (${raw.errorCode})`);
  if (raw.status === null || raw.status < 200 || raw.status >= 300) {
    issues.push(`HTTP status is ${raw.status ?? "unavailable"}`);
  }
  if (!String(raw.contentType || "").toLowerCase().includes("json")) {
    issues.push("content-type is not JSON");
  }
  if (raw.parseError || !isObject(raw.body)) issues.push("body is not a JSON object");
  if (isObject(raw.body) && !provider.successCodes.has(Number(raw.body.code))) {
    const code = finiteNumber(raw.body.code);
    issues.push(`API code is ${code === null ? "missing/non-numeric" : code}`);
  }
  if (isObject(raw.body) && !("data" in raw.body)) issues.push("data field is missing");

  let profile = null;
  if (!issues.length) {
    const inspected = endpoint.inspect(raw.body.data, provider);
    issues.push(...inspected.issues);
    profile = inspected.profile;
  }
  return { ok: issues.length === 0, issues, profile };
}

async function requestEndpoint(provider, endpoint) {
  const { url, init } = buildRequest(provider, endpoint);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  timer.unref?.();
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    let parseError = false;
    try {
      body = JSON.parse(text);
    } catch {
      parseError = true;
    }
    const raw = {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      cache: response.headers.get("x-scraper-cache") || "unreported",
      bytes: Buffer.byteLength(text),
      ms: performance.now() - started,
      body,
      parseError,
      errorCode: null,
    };
    return { ...raw, validation: evaluateResponse(raw, endpoint, provider) };
  } catch (error) {
    const raw = {
      status: null,
      contentType: "",
      cache: "unreported",
      bytes: 0,
      ms: performance.now() - started,
      body: null,
      parseError: false,
      errorCode: timedOut
        ? "timeout"
        : /^[A-Za-z0-9_-]{1,40}$/.test(
              String(error?.cause?.code || error?.code || error?.name || "")
            )
          ? String(error?.cause?.code || error?.code || error?.name)
          : "request_error",
    };
    return { ...raw, validation: evaluateResponse(raw, endpoint, provider) };
  } finally {
    clearTimeout(timer);
  }
}

function relativeDifference(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  if (left === right) return 0;
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), 1);
}

function compareProfiles(oldResult, newResult) {
  if (!oldResult.validation.ok || !newResult.validation.ok) {
    return { comparable: false, ok: false, overlap: null, reason: "invalid response" };
  }
  const oldProfile = oldResult.validation.profile;
  const newProfile = newResult.validation.profile;
  if (!oldProfile || !newProfile || oldProfile.kind !== newProfile.kind) {
    return { comparable: true, ok: false, overlap: null, reason: "profile shape differs" };
  }

  if (oldProfile.kind === "list" || oldProfile.kind === "unpaged-list") {
    const oldIds = new Set(oldProfile.ids || []);
    const newIds = new Set(newProfile.ids || []);
    const denominator = Math.min(oldIds.size, newIds.size);
    const matches = [...oldIds].filter((id) => newIds.has(id)).length;
    const overlap = denominator ? matches / denominator : oldIds.size === newIds.size ? 1 : 0;
    const countRatio =
      Math.max(oldProfile.count, newProfile.count) > 0
        ? Math.min(oldProfile.count, newProfile.count) /
          Math.max(oldProfile.count, newProfile.count)
        : 1;
    const metadataMatches =
      oldProfile.kind === "unpaged-list" ||
      (oldProfile.page === newProfile.page &&
        oldProfile.pageSize === newProfile.pageSize &&
        oldProfile.hasNext === newProfile.hasNext &&
        (oldProfile.total === null || oldProfile.total === undefined
          ? Number.isFinite(newProfile.total)
          : relativeDifference(oldProfile.total, newProfile.total) <=
            LIST_TOTAL_TOLERANCE));
    return {
      comparable: true,
      ok: metadataMatches && countRatio >= 0.8 && overlap >= MIN_LIST_OVERLAP,
      overlap,
      reason: metadataMatches && countRatio >= 0.8 ? "list overlap" : "list size/metadata differs",
    };
  }

  if (oldProfile.kind === "rows") {
    const identityMatches = sameId(oldProfile.identity, newProfile.identity);
    const oldIds = new Set(oldProfile.ids || []);
    const newIds = new Set(newProfile.ids || []);
    let overlap = null;
    const maxCount = Math.max(oldProfile.count, newProfile.count);
    const countRatio = maxCount
      ? Math.min(oldProfile.count, newProfile.count) / maxCount
      : 1;
    let contentMatches = countRatio >= 0.8;
    if (oldIds.size && newIds.size) {
      const matches = [...oldIds].filter((id) => newIds.has(id)).length;
      overlap = matches / Math.min(oldIds.size, newIds.size);
      contentMatches = contentMatches && overlap >= MIN_LIST_OVERLAP;
    } else if (oldIds.size !== newIds.size) {
      contentMatches = false;
    }
    return {
      comparable: true,
      ok: identityMatches && contentMatches,
      overlap,
      reason: "row identity",
    };
  }

  if (oldProfile.kind === "detail") {
    const identityMatches = sameId(oldProfile.identity, newProfile.identity);
    const moqMatches =
      oldProfile.moq === null || oldProfile.moq === undefined
        ? newProfile.moq !== null && newProfile.moq !== undefined
        : oldProfile.moq === newProfile.moq;
    const valueMatches =
      relativeDifference(oldProfile.price, newProfile.price) <= PRICE_TOLERANCE &&
      moqMatches &&
      relativeDifference(oldProfile.stock, newProfile.stock) <= STOCK_TOLERANCE &&
      oldProfile.skuCount === newProfile.skuCount;
    return {
      comparable: true,
      ok: identityMatches && valueMatches,
      overlap: null,
      reason: identityMatches ? "detail price" : "detail identity differs",
    };
  }

  if (oldProfile.kind === "numeric") {
    const identityMatches = sameId(oldProfile.identity, newProfile.identity);
    const valueMatches =
      relativeDifference(oldProfile.value, newProfile.value) <= SHIPPING_TOLERANCE;
    return {
      comparable: true,
      ok: identityMatches && valueMatches,
      overlap: null,
      reason: identityMatches ? "numeric value" : "identity differs",
    };
  }

  if (oldProfile.kind === "identity") {
    return {
      comparable: true,
      ok: sameId(oldProfile.identity, newProfile.identity),
      overlap: null,
      reason: "identity",
    };
  }

  if (oldProfile.kind === "url") {
    return {
      comparable: true,
      ok: oldProfile.identity === newProfile.identity,
      overlap: null,
      reason: "converted image identity",
    };
  }

  return { comparable: true, ok: true, overlap: null, reason: "structural contract" };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rounded(value) {
  return value === null || !Number.isFinite(value) ? "-" : Math.round(value);
}

function summarizeCache(results) {
  const counts = new Map();
  for (const result of results) {
    const raw = String(result.cache || "unreported").toLowerCase();
    const key = ["memory", "miss", "disk", "stale", "stale-disk", "unreported"].includes(raw)
      ? raw
      : "other";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => `${key}:${count}`)
    .join(" ");
}

function providerStats(results) {
  const valid = results.filter((result) => result.validation.ok);
  const times = valid.map((result) => result.ms);
  return {
    attempts: results.length,
    valid: valid.length,
    successRate: results.length ? valid.length / results.length : 0,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    average: mean(times),
    bytesP50: percentile(valid.map((result) => result.bytes), 50),
    cache: summarizeCache(results),
  };
}

function ratioDisplay(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return "-";
  return `${(numerator / denominator).toFixed(2)}x`;
}

function issueSummary(results) {
  const counts = new Map();
  for (const result of results) {
    for (const issue of result.validation.issues) {
      counts.set(issue, (counts.get(issue) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

async function measurePaired() {
  const output = new Map();
  for (let endpointIndex = 0; endpointIndex < SELECTED_ENDPOINTS.length; endpointIndex += 1) {
    const endpoint = SELECTED_ENDPOINTS[endpointIndex];
    console.log(`Measuring ${endpoint.label} (${endpoint.method} ${endpoint.path})...`);

    for (let warmup = 0; warmup < WARMUPS; warmup += 1) {
      const order = (warmup + endpointIndex) % 2 === 0 ? [PROVIDERS.old, PROVIDERS.new] : [PROVIDERS.new, PROVIDERS.old];
      for (const provider of order) await requestEndpoint(provider, endpoint);
    }

    const oldResults = [];
    const newResults = [];
    const pairs = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const order = (sample + endpointIndex) % 2 === 0 ? [PROVIDERS.old, PROVIDERS.new] : [PROVIDERS.new, PROVIDERS.old];
      const pair = {};
      for (const provider of order) {
        const result = await requestEndpoint(provider, endpoint);
        pair[provider.key] = result;
        (provider.key === "old" ? oldResults : newResults).push(result);
      }
      pairs.push({
        ...compareProfiles(pair.old, pair.new),
        oldMs: pair.old.ms,
        newMs: pair.new.ms,
        latencyRatio: pair.old.ms > 0 ? pair.new.ms / pair.old.ms : null,
        latencyDelta: pair.new.ms - pair.old.ms,
      });
    }
    output.set(endpoint.key, { endpoint, oldResults, newResults, pairs });
  }
  return output;
}

async function runBounded(tasks, limit, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await worker(tasks[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function measureConcurrency() {
  const tasks = Array.from(
    { length: CONCURRENCY_REQUESTS },
    (_, index) => SELECTED_ENDPOINTS[index % SELECTED_ENDPOINTS.length]
  );
  const aggregate = { old: [], new: [], oldPhases: [], newPhases: [] };

  console.log(
    `\nPost-measurement cache/API concurrency phase: ${CONCURRENCY_REQUESTS} requests/provider/round, ` +
      `concurrency=${CONCURRENCY}, rounds=${CONCURRENCY_ROUNDS}`
  );
  for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
    const order = round % 2 === 0 ? [PROVIDERS.old, PROVIDERS.new] : [PROVIDERS.new, PROVIDERS.old];
    for (const provider of order) {
      const started = performance.now();
      const results = await runBounded(tasks, CONCURRENCY, (endpoint) =>
        requestEndpoint(provider, endpoint)
      );
      const elapsed = performance.now() - started;
      aggregate[provider.key].push(...results);
      aggregate[`${provider.key}Phases`].push(elapsed);
      const valid = results.filter((result) => result.validation.ok).length;
      console.log(
        `  round ${round + 1} ${provider.label}: valid=${valid}/${results.length} ` +
          `batch=${Math.round(elapsed)}ms`
      );
    }
  }
  return aggregate;
}

function resultItemIds(result) {
  if (!result?.validation?.ok) return [];
  return (rowsFrom(result.body?.data, ["items"]) || [])
    .map(itemId)
    .filter((id) => /^\d+$/.test(id));
}

function commonDistinctItemIds(pairedResults) {
  const textResults = pairedResults.get("text_search");
  if (!textResults) return [];
  const oldIds = new Set(textResults.oldResults.flatMap(resultItemIds));
  const newIds = new Set(textResults.newResults.flatMap(resultItemIds));
  return [...oldIds]
    .filter((id) => id !== FIXTURE.itemId && newIds.has(id))
    .slice(0, DISTINCT_DETAIL_COUNT);
}

async function measureDistinctDetails(pairedResults) {
  if (!REQUIRE_DISTINCT_LOAD) return null;
  const ids = commonDistinctItemIds(pairedResults);
  if (ids.length < DISTINCT_DETAIL_COUNT) {
    throw configError(
      `Distinct load needs ${DISTINCT_DETAIL_COUNT} common text-search item IDs; found ${ids.length}. ` +
        "Choose a broader KEYWORD or lower AB_DISTINCT_DETAIL_COUNT (minimum 4)."
    );
  }

  console.log(
    `\nDistinct item-detail workload: ${ids.length} IDs not otherwise detailed by this benchmark, ` +
      `concurrency=${CONCURRENCY}`
  );
  console.log("Server/process/upstream cache state is not controllable; IDs are distinct within this run.");

  const endpoints = ids.map((id, index) => ({
    key: `distinct_detail_${index + 1}`,
    label: "distinct item detail",
    method: "GET",
    path: "/1688/item_detail",
    query: { item_id: id, language: FIXTURE.language },
    inspect: (data, provider) =>
      inspectDetail(data, id, { requireMoq: provider?.key === "new" }),
    itemId: id,
  }));
  const rounds = [
    endpoints.filter((_, index) => index % 2 === 0),
    endpoints.filter((_, index) => index % 2 === 1),
  ].filter((round) => round.length);
  const aggregate = { old: [], new: [], oldPhases: [], newPhases: [], pairs: [] };
  const byProviderAndId = { old: new Map(), new: new Map() };

  for (let round = 0; round < rounds.length; round += 1) {
    const order = round % 2 === 0
      ? [PROVIDERS.old, PROVIDERS.new]
      : [PROVIDERS.new, PROVIDERS.old];
    for (const provider of order) {
      const started = performance.now();
      const measured = await runBounded(rounds[round], CONCURRENCY, async (endpoint) => ({
        endpoint,
        result: await requestEndpoint(provider, endpoint),
      }));
      const elapsed = performance.now() - started;
      aggregate[`${provider.key}Phases`].push(elapsed);
      for (const { endpoint, result } of measured) {
        aggregate[provider.key].push(result);
        byProviderAndId[provider.key].set(endpoint.itemId, result);
      }
      const valid = measured.filter(({ result }) => result.validation.ok).length;
      console.log(
        `  round ${round + 1} ${provider.label}: valid=${valid}/${measured.length} ` +
          `batch=${Math.round(elapsed)}ms`
      );
    }
  }

  for (const id of ids) {
    const oldResult = byProviderAndId.old.get(id);
    const newResult = byProviderAndId.new.get(id);
    aggregate.pairs.push({
      ...compareProfiles(oldResult, newResult),
      oldMs: oldResult.ms,
      newMs: newResult.ms,
      latencyRatio: oldResult.ms > 0 ? newResult.ms / oldResult.ms : null,
    });
  }
  return aggregate;
}

function displayBase(url) {
  return url.origin;
}

function describeProvider(provider) {
  const tokenState = provider.mode === "none" ? "not used" : provider.token ? "configured" : "missing";
  return `${displayBase(provider.base)} auth=${provider.mode} token=${tokenState}`;
}

function printPairedReport(results) {
  console.log("\nPer-endpoint valid-response latency (excluded warmups are not included):");
  const rows = [];
  const comparisons = [];
  for (const { endpoint, oldResults, newResults, pairs } of results.values()) {
    const oldStats = providerStats(oldResults);
    const newStats = providerStats(newResults);
    for (const [provider, stats] of [
      ["OLD", oldStats],
      ["NEW", newStats],
    ]) {
      rows.push({
        endpoint: endpoint.key,
        provider,
        valid: `${stats.valid}/${stats.attempts}`,
        p50_ms: rounded(stats.p50),
        p95_ms: rounded(stats.p95),
        mean_ms: rounded(stats.average),
        bytes_p50: rounded(stats.bytesP50),
        cache_headers: stats.cache,
      });
    }

    const comparable = pairs.filter((pair) => pair.comparable);
    const equivalent = comparable.filter((pair) => pair.ok);
    const overlaps = comparable
      .map((pair) => pair.overlap)
      .filter((value) => Number.isFinite(value));
    const validLatencyPairs = pairs.filter((pair) => pair.comparable);
    const latencyRatios = validLatencyPairs
      .filter((pair) => Number.isFinite(pair.latencyRatio))
      .map((pair) => pair.latencyRatio);
    const latencyDeltas = validLatencyPairs
      .filter((pair) => Number.isFinite(pair.latencyDelta))
      .map((pair) => pair.latencyDelta);
    const newWins = validLatencyPairs.filter((pair) => pair.newMs < pair.oldMs).length;
    comparisons.push({
      endpoint: endpoint.key,
      comparable: `${comparable.length}/${pairs.length}`,
      equivalent: `${equivalent.length}/${comparable.length || 0}`,
      overlap_p50: overlaps.length ? `${Math.round(percentile(overlaps, 50) * 100)}%` : "-",
      new_old_p50: ratioDisplay(newStats.p50, oldStats.p50),
      new_old_p95: ratioDisplay(newStats.p95, oldStats.p95),
      paired_ratio_p50: latencyRatios.length ? `${percentile(latencyRatios, 50).toFixed(2)}x` : "-",
      paired_delta_p50_ms: rounded(percentile(latencyDeltas, 50)),
      new_wins: `${newWins}/${validLatencyPairs.length}`,
    });
  }
  console.table(rows);
  console.log("Paired response equivalence and observed latency ratios:");
  console.table(comparisons);
}

function printConcurrencyReport(aggregate) {
  const rows = [];
  for (const key of ["old", "new"]) {
    const stats = providerStats(aggregate[key]);
    const phaseMs = aggregate[`${key}Phases`].reduce((sum, value) => sum + value, 0);
    rows.push({
      provider: key.toUpperCase(),
      valid: `${stats.valid}/${stats.attempts}`,
      p50_ms: rounded(stats.p50),
      p95_ms: rounded(stats.p95),
      valid_rps: phaseMs > 0 ? (stats.valid / (phaseMs / 1000)).toFixed(2) : "-",
      batch_p50_ms: rounded(percentile(aggregate[`${key}Phases`], 50)),
      cache_headers: stats.cache,
    });
  }
  console.log("\nPost-measurement cache/API concurrency results (not distinct-work scraper capacity):");
  console.table(rows);
}

function printDistinctDetailReport(aggregate) {
  if (!aggregate) return;
  const rows = ["old", "new"].map((key) => {
    const stats = providerStats(aggregate[key]);
    return {
      provider: key.toUpperCase(),
      valid: `${stats.valid}/${stats.attempts}`,
      p50_ms: rounded(stats.p50),
      p95_ms: rounded(stats.p95),
      total_batch_ms: rounded(
        aggregate[`${key}Phases`].reduce((sum, value) => sum + value, 0)
      ),
      cache_headers: stats.cache,
    };
  });
  console.log("\nDistinct item-detail workload results:");
  console.table(rows);
}

function assessDistinctDetails(aggregate) {
  if (!aggregate) return [];
  const failures = [];
  const oldStats = providerStats(aggregate.old);
  const newStats = providerStats(aggregate.new);
  for (const [key, stats, minimum] of [
    ["OLD", oldStats, MIN_OLD_SUCCESS_RATE],
    ["NEW", newStats, MIN_NEW_SUCCESS_RATE],
  ]) {
    if (stats.successRate < minimum) {
      failures.push(
        `distinct details ${key} valid success ${(stats.successRate * 100).toFixed(0)}% is below ` +
          `${(minimum * 100).toFixed(0)}%`
      );
    }
  }
  const comparable = aggregate.pairs.filter((pair) => pair.comparable);
  const equivalent = comparable.filter((pair) => pair.ok);
  const equivalenceRate = comparable.length ? equivalent.length / comparable.length : 0;
  if (!comparable.length || equivalenceRate < MIN_EQUIV_RATE) {
    failures.push(
      `distinct detail equivalence ${(equivalenceRate * 100).toFixed(0)}% is below ` +
        `${(MIN_EQUIV_RATE * 100).toFixed(0)}%`
    );
  }

  const ratios = comparable
    .map((pair) => pair.latencyRatio)
    .filter((value) => Number.isFinite(value));
  const pairedP50 = percentile(ratios, 50);
  if (
    MAX_PAIRED_P50_RATIO !== null &&
    pairedP50 !== null &&
    pairedP50 > MAX_PAIRED_P50_RATIO
  ) {
    failures.push(
      `distinct details NEW/OLD paired median ${pairedP50.toFixed(2)}x exceeds configured limit`
    );
  }
  if (
    MAX_NEW_P95_RATIO !== null &&
    oldStats.p95 !== null &&
    newStats.p95 !== null &&
    newStats.p95 > oldStats.p95 * MAX_NEW_P95_RATIO + P95_SLACK_MS
  ) {
    failures.push("distinct details NEW p95 exceeds configured OLD-relative limit");
  }
  const wins = comparable.filter((pair) => pair.newMs < pair.oldMs).length;
  const winRate = comparable.length ? wins / comparable.length : 0;
  if (winRate < MIN_NEW_WIN_RATE) {
    failures.push(
      `distinct details NEW win rate ${(winRate * 100).toFixed(0)}% is below ` +
        `${(MIN_NEW_WIN_RATE * 100).toFixed(0)}%`
    );
  }
  const oldBatch = aggregate.oldPhases.reduce((sum, value) => sum + value, 0);
  const newBatch = aggregate.newPhases.reduce((sum, value) => sum + value, 0);
  if (
    MAX_CONCURRENCY_RATIO !== null &&
    newBatch > oldBatch * MAX_CONCURRENCY_RATIO + CONCURRENCY_SLACK_MS
  ) {
    failures.push("distinct details NEW total batch latency exceeds configured OLD-relative limit");
  }
  return failures;
}

function assess(results, concurrencyResults) {
  const failures = [];
  let newP95Wins = 0;
  let measuredP95 = 0;
  const allValidPairs = [];

  for (const { endpoint, oldResults, newResults, pairs } of results.values()) {
    const oldStats = providerStats(oldResults);
    const newStats = providerStats(newResults);
    for (const [provider, stats, providerResults, minimum] of [
      ["OLD", oldStats, oldResults, MIN_OLD_SUCCESS_RATE],
      ["NEW", newStats, newResults, MIN_NEW_SUCCESS_RATE],
    ]) {
      if (stats.successRate < minimum) {
        failures.push(
          `${endpoint.key} ${provider} valid success ${(stats.successRate * 100).toFixed(0)}% is below ${(minimum * 100).toFixed(0)}%`
        );
        for (const [issue, count] of issueSummary(providerResults).slice(0, 3)) {
          if (count > 0) failures.push(`${endpoint.key} ${provider}: ${issue} (${count}/${SAMPLES})`);
        }
      }
    }

    const comparable = pairs.filter((pair) => pair.comparable);
    allValidPairs.push(...comparable);
    const equivalent = comparable.filter((pair) => pair.ok);
    const equivalenceRate = comparable.length ? equivalent.length / comparable.length : 0;
    if (!comparable.length || equivalenceRate < MIN_EQUIV_RATE) {
      failures.push(
        `${endpoint.key} paired equivalence ${(equivalenceRate * 100).toFixed(0)}% is below ${(MIN_EQUIV_RATE * 100).toFixed(0)}%`
      );
    }

    if (oldStats.p95 !== null && newStats.p95 !== null) {
      measuredP95 += 1;
      if (newStats.p95 < oldStats.p95) newP95Wins += 1;
      if (
        MAX_NEW_P95_RATIO !== null &&
        newStats.p95 > oldStats.p95 * MAX_NEW_P95_RATIO + P95_SLACK_MS
      ) {
        failures.push(
          `${endpoint.key} NEW p95 ${Math.round(newStats.p95)}ms exceeds configured OLD-relative limit`
        );
      }
    }

    const pairedRatios = comparable
      .map((pair) => pair.latencyRatio)
      .filter((value) => Number.isFinite(value));
    const pairedP50 = percentile(pairedRatios, 50);
    if (
      MAX_PAIRED_P50_RATIO !== null &&
      pairedP50 !== null &&
      pairedP50 > MAX_PAIRED_P50_RATIO
    ) {
      failures.push(
        `${endpoint.key} NEW/OLD paired median ${pairedP50.toFixed(2)}x exceeds configured limit`
      );
    }
  }

  const concurrencyStats = {};
  for (const key of ["old", "new"]) {
    const stats = providerStats(concurrencyResults[key]);
    concurrencyStats[key] = stats;
    const minimum = key === "old" ? MIN_OLD_SUCCESS_RATE : MIN_NEW_SUCCESS_RATE;
    if (stats.successRate < minimum) {
      failures.push(
        `${key.toUpperCase()} concurrency valid success ${(stats.successRate * 100).toFixed(0)}% is below ${(minimum * 100).toFixed(0)}%`
      );
    }
  }

  const oldBatchP50 = percentile(concurrencyResults.oldPhases, 50);
  const newBatchP50 = percentile(concurrencyResults.newPhases, 50);
  if (
    MAX_CONCURRENCY_RATIO !== null &&
    concurrencyStats.old.p95 !== null &&
    concurrencyStats.new.p95 !== null &&
    concurrencyStats.new.p95 >
      concurrencyStats.old.p95 * MAX_CONCURRENCY_RATIO + CONCURRENCY_SLACK_MS
  ) {
    failures.push("NEW cache/API concurrency p95 exceeds configured OLD-relative limit");
  }
  if (
    MAX_CONCURRENCY_RATIO !== null &&
    oldBatchP50 !== null &&
    newBatchP50 !== null &&
    newBatchP50 > oldBatchP50 * MAX_CONCURRENCY_RATIO + CONCURRENCY_SLACK_MS
  ) {
    failures.push("NEW cache/API concurrency batch latency exceeds configured OLD-relative limit");
  }

  const validLatencyPairs = allValidPairs.filter(
    (pair) => Number.isFinite(pair.oldMs) && Number.isFinite(pair.newMs)
  );
  const overallWins = validLatencyPairs.filter((pair) => pair.newMs < pair.oldMs).length;
  const overallWinRate = validLatencyPairs.length
    ? overallWins / validLatencyPairs.length
    : 0;
  if (!validLatencyPairs.length || overallWinRate < MIN_NEW_WIN_RATE) {
    failures.push(
      `NEW paired latency win rate ${(overallWinRate * 100).toFixed(0)}% is below ` +
        `${(MIN_NEW_WIN_RATE * 100).toFixed(0)}%`
    );
  }

  console.log(
    `\nObserved NEW p95 was lower on ${newP95Wins}/${measuredP95} comparable endpoints. ` +
      "This describes this run only; it is not a controlled cold-cache claim."
  );
  console.log(
    `Observed NEW won ${overallWins}/${validLatencyPairs.length} valid paired requests ` +
      `(${(overallWinRate * 100).toFixed(0)}%).`
  );
  return failures;
}

async function main() {
  console.log("Chibox 1688 paired A/B benchmark");
  console.log(`OLD ${describeProvider(PROVIDERS.old)}`);
  console.log(`NEW ${describeProvider(PROVIDERS.new)}`);
  console.log(
    `samples=${SAMPLES} excluded_warmups=${WARMUPS} timeout=${TIMEOUT_MS}ms ` +
      `endpoints=${SELECTED_ENDPOINTS.map((endpoint) => endpoint.key).join(",")}`
  );
  console.log(
    `observed_p95_gate=${
      MAX_NEW_P95_RATIO === null
        ? "off"
        : `NEW <= OLD * ${MAX_NEW_P95_RATIO.toFixed(2)} + ${P95_SLACK_MS}ms per endpoint`
    }`
  );
  console.log(
    "Cache note: process, disk, CDN, browser, and upstream cache state is not controlled. " +
      "Latency is reported as observed post-warmup/mixed-cache behavior."
  );
  console.log("Provider request order alternates for every paired sample and every concurrency round.\n");

  const results = await measurePaired();
  const distinctDetails = await measureDistinctDetails(results);
  const concurrencyResults = await measureConcurrency();
  printPairedReport(results);
  printDistinctDetailReport(distinctDetails);
  printConcurrencyReport(concurrencyResults);

  const failures = [
    ...assess(results, concurrencyResults),
    ...assessDistinctDetails(distinctDetails),
  ];
  if (failures.length) {
    console.log("\nA/B checks failed:");
    failures.forEach((failure, index) => console.log(`${index + 1}. ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(
      "\nA/B checks passed for response contracts, equivalence, configured success rates, " +
        (MAX_NEW_P95_RATIO === null
          ? "and reported latency observations."
          : "and the observed-latency regression gate.")
    );
    if (MAX_NEW_P95_RATIO === null) {
      console.log("No performance threshold was enforced; set AB_MAX_NEW_P95_RATIO to add one.");
    }
  }
}

main().catch((error) => {
  const prefix = error?.config ? "A/B configuration error" : "A/B benchmark failed";
  console.error(`${prefix}: ${safeErrorMessage(error)}`);
  process.exitCode = error?.config ? 2 : 1;
});
