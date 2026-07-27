import { performance } from "node:perf_hooks";

/**
 * Chibox 1688 provider release gate.
 *
 * This intentionally calls the exact aliases consumed by TmapiService.php.
 * It distinguishes contract/operational failures (HARD, non-zero exit) from
 * optional field-quality gaps (COMPLETENESS, reported but non-blocking).
 *
 * Configuration (all optional):
 *   BASE, API_TOKEN, TIMEOUT_MS, WARM_MAX_MS, WARM_REPEATS,
 *   ITEM_ID, REVIEW_ITEM_ID, CATEGORY_ID, MEMBER_ID, SHOP_URL,
 *   KEYWORD, IMAGE_URL, IMAGE_SEARCH_URL, LANGUAGE, PAGE_SIZE,
 *   PROVINCE, SHIPPING_QUANTITY, SHIPPING_WEIGHT,
 *   SEARCH_SORT, PRICE_START, PRICE_END, CAT_IDS,
 *   SHOP_SORT, SHOP_CATEGORY_ID, SHOP_PRICE_START, SHOP_PRICE_END,
 *   IMAGE_SORT, IMAGE_SUPPORT_DROPSHIPPING, IMAGE_IS_FACTORY,
 *   IMAGE_VERIFIED_SUPPLIER, IMAGE_FREE_SHIPPING, IMAGE_NEW_ARRIVAL,
 *   TEST_PAGINATION, PAGINATION_TARGETS, EXPECT_SECOND_PAGE,
 *   EXPECT_VARIANTS, EXPECT_REVIEWS, EXPECT_SHOP_CATEGORIES,
 *   WARM_TARGETS, COLD_WARN_MS, COLD_MAX_MS.
 */

const ENV = process.env;
const API_TOKEN = String(ENV.API_TOKEN || "").trim();

function boolEnv(name, fallback) {
  const raw = ENV[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function intEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(ENV[name] || "", 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

function optionalEnv(name) {
  const value = String(ENV[name] || "").trim();
  return value === "" ? undefined : value;
}

function setEnv(name, fallback) {
  return new Set(
    String(ENV[name] || fallback)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

let BASE;
try {
  BASE = new URL(String(ENV.BASE || "http://localhost:3456").trim());
} catch {
  console.error("Release gate configuration error: BASE must be a valid HTTP(S) URL.");
  process.exit(2);
}
if (!["http:", "https:"].includes(BASE.protocol)) {
  console.error("Release gate configuration error: BASE must use HTTP or HTTPS.");
  process.exit(2);
}
BASE.search = "";
BASE.hash = "";

const TIMEOUT_MS = intEnv("TIMEOUT_MS", 42_000, 1_000, 44_000);
const WARM_MAX_MS = intEnv("WARM_MAX_MS", 1_500, 50, 44_000);
const WARM_REPEATS = intEnv("WARM_REPEATS", 1, 1, 5);
const COLD_WARN_MS = intEnv("COLD_WARN_MS", 12_000, 100, 43_000);
const COLD_MAX_MS = intEnv(
  "COLD_MAX_MS",
  Math.min(40_000, TIMEOUT_MS - 500),
  500,
  Math.max(500, TIMEOUT_MS - 1)
);
const PAGE_SIZE = intEnv("PAGE_SIZE", 5, 1, 20);
const CATEGORY_PAGE_SIZE = intEnv("CATEGORY_PAGE_SIZE", 50, 1, 50);
const REQUIRE_DETAIL_HTTP = boolEnv("REQUIRE_DETAIL_HTTP", true);
const REQUIRE_COLD_CACHE_MISS = boolEnv("REQUIRE_COLD_CACHE_MISS", true);

const FIXTURE = {
  itemId: String(ENV.ITEM_ID || "874039857500").trim(),
  reviewItemId: String(ENV.REVIEW_ITEM_ID || ENV.ITEM_ID || "874039857500").trim(),
  categoryId: String(ENV.CATEGORY_ID || "130823000").trim(),
  memberId: String(ENV.MEMBER_ID || "b2b-221822542203833240").trim(),
  keyword: String(ENV.KEYWORD || "armrest pad").trim(),
  imageUrl: String(ENV.IMAGE_URL || "https://placehold.co/600x600.jpg").trim(),
  imageSearchUrl: optionalEnv("IMAGE_SEARCH_URL"),
  language: String(ENV.LANGUAGE || "en").trim(),
  province: String(ENV.PROVINCE || "Guangdong").trim(),
  shippingQuantity: intEnv("SHIPPING_QUANTITY", 2, 1, 100_000),
  shippingWeight: optionalEnv("SHIPPING_WEIGHT"),
};
FIXTURE.shopUrl = String(
  ENV.SHOP_URL ||
    `https://winport.m.1688.com/page/index.html?memberId=${encodeURIComponent(FIXTURE.memberId)}`
).trim();
const SEARCH_SORT = String(ENV.SEARCH_SORT || "price_up");
const PRICE_START = String(ENV.PRICE_START || "1");
const PRICE_END = String(ENV.PRICE_END || "500");
const MULTI_CATEGORY_IDS = String(
  ENV.CAT_IDS || `${FIXTURE.categoryId},71`
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const TEST_PAGINATION = boolEnv("TEST_PAGINATION", true);
const EXPECT_SECOND_PAGE = boolEnv("EXPECT_SECOND_PAGE", true);
const EXPECT_VARIANTS = boolEnv("EXPECT_VARIANTS", true);
const EXPECT_REVIEWS = boolEnv("EXPECT_REVIEWS", true);
const EXPECT_SHOP_CATEGORIES = boolEnv("EXPECT_SHOP_CATEGORIES", true);
const PAGINATION_TARGETS = setEnv(
  "PAGINATION_TARGETS",
  "category,text,shop,shop_url,image"
);
const WARM_TARGETS = setEnv(
  "WARM_TARGETS",
  "item_detail,category_items,text_search,shop_items,image_search,shipping"
);

const hardFailures = [];
const completenessFailures = [];
const requests = [];
const warmCases = new Map();

function redact(value) {
  let text = String(value ?? "");
  if (API_TOKEN) text = text.split(API_TOKEN).join("[REDACTED]");
  return text
    .replace(/([?&]apiToken=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("?apiToken"?\s*[:=]\s*["']?)[^"'&\s}]+/gi, "$1[REDACTED]");
}

function hard(test, message) {
  hardFailures.push({ test, message: redact(message) });
}

function completeness(test, message) {
  completenessFailures.push({ test, message: redact(message) });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).replace(/,/g, "").trim();
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function sameId(left, right) {
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function itemId(item) {
  if (!isObject(item)) return "";
  for (const key of [
    "item_id",
    "itemId",
    "offer_id",
    "offerId",
    "offerid",
    "source_product_id",
    "product_id",
    "id",
  ]) {
    if (nonBlank(item[key])) return String(item[key]).trim();
  }
  return "";
}

function itemTitle(item) {
  if (!isObject(item)) return "";
  return String(item.title || item.subject || item.product_name || "").trim();
}

function looksEnglish(value) {
  const text = String(value || "").trim();
  if (!/[A-Za-z]/.test(text)) return false;
  const compact = text.replace(/\s+/g, "");
  const han = compact.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length || 0;
  return han / Math.max(1, compact.length) <= 0.1;
}

function itemImage(item) {
  if (!isObject(item)) return "";
  const direct = item.img || item.image || item.image_url || item.img_url || item.pic_url;
  if (nonBlank(direct)) return String(direct).trim();
  const images = item.main_imgs || item.images || item.image_list;
  return Array.isArray(images) && nonBlank(images[0]) ? String(images[0]).trim() : "";
}

function itemPrice(item) {
  if (!isObject(item)) return null;
  const priceInfo = isObject(item.price_info) ? item.price_info : {};
  for (const value of [
    priceInfo.sale_price,
    priceInfo.price,
    priceInfo.origin_price,
    priceInfo.wholesale_price,
    priceInfo.min_price,
    item.price,
    item.sale_price,
    item.origin_price,
  ]) {
    const price = positiveNumber(value);
    if (price !== null) return price;
  }
  return null;
}

function validHttpImage(value) {
  if (!nonBlank(value)) return false;
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return String(value).startsWith("//");
  }
}

function isUsableCard(item) {
  return (
    /^\d+$/.test(itemId(item)) &&
    itemTitle(item).length > 0 &&
    validHttpImage(itemImage(item)) &&
    itemPrice(item) !== null
  );
}

function rowsFrom(data, keys = ["items", "list", "reviews", "ratings"]) {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return null;
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }
  return null;
}

function idsFrom(data, keys) {
  const rows = rowsFrom(data, keys) || [];
  return [...new Set(rows.map(itemId).filter(Boolean))];
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function requestUrl(path, query = {}) {
  const url = new URL(path.replace(/^\//, ""), `${BASE.toString().replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function requestJson(label, spec, phase = "cold") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const init = {
      method: spec.method || "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    };
    if (API_TOKEN) init.headers["X-API-Token"] = API_TOKEN;
    if (spec.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(spec.body);
    }

    const response = await fetch(requestUrl(spec.path, spec.query), init);
    const text = await response.text();
    let body = null;
    let parseError = null;
    try {
      body = JSON.parse(text);
    } catch (error) {
      parseError = error;
    }
    const result = {
      label,
      phase,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      scraperCache: response.headers.get("x-scraper-cache") || "",
      scraperPath: response.headers.get("x-scraper-path") || "",
      bytes: Buffer.byteLength(text),
      ms: performance.now() - started,
      body,
      parseError,
    };
    requests.push(result);
    return result;
  } catch (error) {
    const result = {
      label,
      phase,
      status: null,
      contentType: "",
      bytes: 0,
      ms: performance.now() - started,
      body: null,
      error,
      timedOut: error?.name === "AbortError",
    };
    requests.push(result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function validateEnvelope(test, result) {
  if (!result || result.error) {
    hard(
      test,
      result?.timedOut
        ? `request timed out after ${Math.round(result.ms)}ms (limit ${TIMEOUT_MS}ms)`
        : `request failed: ${result?.error?.message || "unknown transport error"}`
    );
    return false;
  }
  if (result.status < 200 || result.status >= 300) {
    hard(test, `HTTP ${result.status}`);
    return false;
  }
  if (!result.contentType.toLowerCase().includes("json")) {
    hard(test, `response content-type is not JSON (${result.contentType || "missing"})`);
    return false;
  }
  if (result.parseError || !isObject(result.body)) {
    hard(test, "response body is not a JSON object");
    return false;
  }
  if (Number(result.body.code) !== 200) {
    hard(test, `API code ${result.body.code ?? "missing"}: ${result.body.msg || result.body.message || "request failed"}`);
    return false;
  }
  if (!("data" in result.body)) {
    hard(test, "code 200 response has no data field");
    return false;
  }
  return true;
}

function printRequestStatus(test, result, hardBefore, completenessBefore) {
  const newHard = hardFailures.length - hardBefore;
  const newCompleteness = completenessFailures.length - completenessBefore;
  const status = newHard > 0 ? "HARD" : newCompleteness > 0 ? "WARN" : "PASS";
  const timing = result ? `${Math.round(result.ms)}ms` : "no timing";
  const apiCode = result?.body?.code ?? "-";
  console.log(
    `${status.padEnd(4)} ${test.padEnd(31)} http=${result?.status ?? "-"} code=${apiCode} ${timing}`
  );
}

async function execute(test, spec, validator, warm) {
  const hardBefore = hardFailures.length;
  const completenessBefore = completenessFailures.length;
  const result = await requestJson(test, spec, "cold");
  const envelopeOk = validateEnvelope(test, result);
  if (envelopeOk && validator) validator(result.body.data, result.body, result);

  if (result && !result.error) {
    if (result.ms > COLD_MAX_MS) {
      hard(test, `cold latency ${Math.round(result.ms)}ms exceeds ${COLD_MAX_MS}ms`);
    } else if (result.ms > COLD_WARN_MS) {
      completeness(test, `cold latency ${Math.round(result.ms)}ms exceeds warning threshold ${COLD_WARN_MS}ms`);
    }
  }

  if (envelopeOk && warm) {
    warmCases.set(warm.key, {
      label: test,
      spec,
      quickValidate: warm.quickValidate,
      signature: warm.signature,
      initialSignature: warm.signature ? warm.signature(result.body.data) : null,
    });
  }
  printRequestStatus(test, result, hardBefore, completenessBefore);
  return envelopeOk ? result : null;
}

function validateCards(test, data, options = {}) {
  const rows = rowsFrom(data, options.keys || ["items"]);
  if (!Array.isArray(rows)) {
    hard(test, `data.${(options.keys || ["items"])[0]} is not an array`);
    return [];
  }
  if (rows.length === 0) {
    hard(test, "valid fixture returned zero items");
    return rows;
  }
  const usable = rows.filter(isUsableCard);
  if (usable.length === 0) {
    hard(test, "no item has a numeric ID, title, HTTP image, and positive price");
  } else if (usable.length / rows.length < 0.6) {
    hard(test, `only ${usable.length}/${rows.length} result cards are usable`);
  } else if (usable.length < rows.length) {
    completeness(test, `${rows.length - usable.length}/${rows.length} result cards are incomplete`);
  }
  if (String(FIXTURE.language).toLowerCase() === "en" && rows.length) {
    const english = rows.filter((row) => looksEnglish(itemTitle(row)));
    if (english.length / rows.length < 0.8) {
      hard(test, `only ${english.length}/${rows.length} titles are observably English`);
    } else if (english.length < rows.length) {
      completeness(test, `${rows.length - english.length}/${rows.length} titles retain Chinese text`);
    }
  }
  return rows;
}

function requirePage(test, data, page, expectedPageSize) {
  if (!isObject(data)) {
    hard(test, "data is not an object");
    return;
  }
  if (finiteNumber(data.page) !== page) hard(test, `data.page does not equal requested page ${page}`);
  const actualPageSize = finiteNumber(data.page_size);
  if (actualPageSize === null) hard(test, "data.page_size is missing or non-numeric");
  else if (expectedPageSize !== undefined && actualPageSize !== expectedPageSize) {
    hard(test, `data.page_size=${actualPageSize}, expected ${expectedPageSize}`);
  }
}

function requireTotal(test, data, acceptedKeys) {
  for (const key of acceptedKeys) {
    const total = finiteNumber(data?.[key]);
    if (total !== null && total >= 0) return total;
  }
  hard(test, `missing numeric ${acceptedKeys.join(" or ")}`);
  return null;
}

function validateSortAndPrices(test, rows, sort, minPrice, maxPrice) {
  const prices = rows.map(itemPrice).filter((value) => value !== null);
  if (minPrice !== undefined) {
    const floor = finiteNumber(minPrice);
    if (floor !== null && prices.some((price) => price < floor)) {
      hard(test, "price_start filter was not honored");
    }
  }
  if (maxPrice !== undefined) {
    const ceiling = finiteNumber(maxPrice);
    if (ceiling !== null && prices.some((price) => price > ceiling)) {
      hard(test, "price_end filter was not honored");
    }
  }
  if (prices.length >= 3 && ["price_up", "price_down"].includes(sort)) {
    const ascending = sort === "price_up";
    const violations = prices.slice(1).filter((price, index) =>
      ascending ? price < prices[index] : price > prices[index]
    ).length;
    if (violations > Math.floor(prices.length * 0.15)) {
      hard(test, `${sort} ordering is not monotonic (${violations} violations)`);
    }
  }
}

function paginationExpected(data, firstPageCount) {
  if (data?.has_next_page === true) return true;
  const total = finiteNumber(data?.total ?? data?.total_count);
  if (total !== null && total > firstPageCount) return true;
  return EXPECT_SECOND_PAGE;
}

function assessPageOverlap(test, firstData, secondData, keys = ["items"]) {
  const first = idsFrom(firstData, keys);
  const second = idsFrom(secondData, keys);
  if (paginationExpected(firstData, first.length) && second.length === 0) {
    hard(test, "page 2 is empty although the fixture is expected to have another page");
    return;
  }
  if (first.length === 0 || second.length === 0) return;
  const secondSet = new Set(second);
  const overlap = first.filter((id) => secondSet.has(id));
  const ratio = overlap.length / Math.min(first.length, second.length);
  if (overlap.length > 0) {
    hard(test, `page 1/page 2 overlap is ${Math.round(ratio * 100)}%`);
  }
}

function assessCrossPageSearch(test, firstData, secondData, sort) {
  const firstTotal = finiteNumber(firstData?.total_count ?? firstData?.total);
  const secondTotal = finiteNumber(secondData?.total_count ?? secondData?.total);
  if (firstTotal !== null && secondTotal !== null && firstTotal !== secondTotal) {
    hard(test, `page totals differ (${firstTotal} vs ${secondTotal})`);
  }
  if (!["price_up", "price_down"].includes(sort)) return;
  const firstPrices = rowsFrom(firstData, ["items"])
    ?.map(itemPrice)
    .filter((value) => value !== null) || [];
  const secondPrices = rowsFrom(secondData, ["items"])
    ?.map(itemPrice)
    .filter((value) => value !== null) || [];
  if (!firstPrices.length || !secondPrices.length) return;
  const boundaryOk =
    sort === "price_up"
      ? firstPrices[firstPrices.length - 1] <= secondPrices[0]
      : firstPrices[firstPrices.length - 1] >= secondPrices[0];
  if (!boundaryOk) hard(test, `${sort} ordering breaks across page 1/page 2`);
}

async function runInvalidCategoryControl(referenceData) {
  const test = "category negative control";
  const hardBefore = hardFailures.length;
  const result = await requestJson(
    test,
    {
      path: "/1688/category/items",
      query: { cat_id: "999999999999", page: 1, page_size: 5 },
    },
    "negative"
  );
  if (result.error || result.status < 200 || result.status >= 300 || !isObject(result.body)) {
    hard(test, result.error?.message || `invalid transport/HTTP ${result.status ?? "-"}`);
  } else if (Number(result.body.code) === 200) {
    const rows = rowsFrom(result.body.data, ["items"]) || [];
    if (rows.length > 0) {
      const referenceIds = new Set(idsFrom(referenceData));
      const overlap = idsFrom(result.body.data).filter((id) => referenceIds.has(id));
      hard(
        test,
        `nonexistent category returned ${rows.length} items (${overlap.length} overlap the valid category)`
      );
    }
  }
  console.log(
    `${hardFailures.length === hardBefore ? "PASS" : "HARD"} ${test.padEnd(31)} http=${result.status ?? "-"} code=${result.body?.code ?? "-"} ${Math.round(result.ms)}ms`
  );
}

function validateCategoryTop(test, data) {
  if (!Array.isArray(data)) {
    hard(test, "top-category data is not an array");
    return;
  }
  if (data.length < 20) hard(test, `only ${data.length} top categories returned`);
  else if (data.length < 50) completeness(test, `only ${data.length} top categories returned`);
  const usable = data.filter((category) =>
    isObject(category) && nonBlank(category.id ?? category.cat_id) && nonBlank(category.name ?? category.name_en)
  );
  if (usable.length / Math.max(1, data.length) < 0.9) {
    hard(test, `only ${usable.length}/${data.length} categories have ID and name`);
  }
}

function validateCategoryInfo(test, data) {
  if (!isObject(data)) {
    hard(test, "category info data is not an object");
    return;
  }
  const id = data.id ?? data.cat_id;
  if (!sameId(id, FIXTURE.categoryId)) hard(test, "returned category ID does not match fixture");
  if (!nonBlank(data.name ?? data.name_en)) hard(test, "category name is missing");
  if (!Array.isArray(data.children)) hard(test, "category children is not an array");
  if (!Array.isArray(data.path)) completeness(test, "category path is missing");
  if (!nonBlank(data.name_en)) completeness(test, "English category name is missing");
  if (data.has_children === true && Array.isArray(data.children) && data.children.length === 0) {
    hard(test, "has_children=true but children is empty");
  }
}

function validateCategoryItems(test, data, page) {
  requirePage(test, data, page, CATEGORY_PAGE_SIZE);
  const rows = validateCards(test, data);
  const total = requireTotal(test, data, ["total"]);
  if (total !== null && total < rows.length) hard(test, "total is smaller than returned item count");
  if (total !== null) {
    const expectedCount = Math.min(
      CATEGORY_PAGE_SIZE,
      Math.max(0, total - (page - 1) * CATEGORY_PAGE_SIZE)
    );
    if (rows.length !== expectedCount) {
      hard(
        test,
        `returned ${rows.length} category items, expected ${expectedCount} for page_size=${CATEGORY_PAGE_SIZE}`
      );
    }
  }
  if (typeof data?.has_next_page !== "boolean") {
    hard(test, "has_next_page must be a boolean for TmapiService::getCategoryItems");
  }
  const withPath = rows.filter((item) => Array.isArray(item.category_path) && item.category_path.length);
  if (withPath.length === 0) {
    completeness(test, "no category item exposes category_path, so category membership cannot be verified");
  } else {
    const categoryNodeId = (node) =>
      isObject(node)
        ? node.id ?? node.cat_id ?? node.category_id ?? node.cid
        : node;
    const matches = withPath.filter((item) =>
      item.category_path.some((node) => sameId(categoryNodeId(node), FIXTURE.categoryId))
    );
    if (matches.length === 0) hard(test, "none of the category results belongs to the requested category path");
    else if (matches.length / withPath.length < 0.8) {
      completeness(test, `only ${matches.length}/${withPath.length} category paths include the requested category`);
    }
  }
}

function detailTopPrice(data) {
  const priceInfo = isObject(data?.price_info) ? data.price_info : null;
  if (!priceInfo) return null;
  for (const key of ["price", "price_min", "sale_price", "discount_price", "origin_price_min"]) {
    const value = positiveNumber(priceInfo[key]);
    if (value !== null) return value;
  }
  return null;
}

function detailMoq(data) {
  const tiered = isObject(data?.tiered_price_info) ? data.tiered_price_info : {};
  return positiveNumber(data?.quantity_begin ?? data?.moq ?? tiered.begin_num);
}

function validateSkuIntegrity(test, data) {
  const props = Array.isArray(data.sku_props) ? data.sku_props : [];
  const skus = Array.isArray(data.skus) ? data.skus : [];
  if (EXPECT_VARIANTS && (props.length === 0 || skus.length === 0)) {
    hard(test, "variant fixture has no sku_props or skus");
    return;
  }
  if (props.length === 0 && skus.length === 0) return;

  const allowed = new Map();
  for (const prop of props) {
    const pid = String(prop?.pid ?? prop?.prop_id ?? "").trim();
    if (!pid) continue;
    allowed.set(pid, new Set((prop.values || []).map((value) => String(value?.vid ?? "").trim()).filter(Boolean)));
  }
  if (allowed.size !== props.length) hard(test, "one or more SKU properties has no pid");

  let priced = 0;
  let stocked = 0;
  let invalidReferences = 0;
  let labeledNames = 0;
  let packaged = 0;
  for (const sku of skus) {
    if (positiveNumber(sku?.sale_price ?? sku?.price) !== null) priced += 1;
    if (finiteNumber(sku?.stock) !== null) stocked += 1;
    if (String(sku?.props_names || "").includes(":")) labeledNames += 1;
    if (isObject(sku?.package_info)) packaged += 1;
    const pairs = String(sku?.props_ids || "").split(";").filter(Boolean);
    if (pairs.length === 0) invalidReferences += 1;
    for (const pair of pairs) {
      const separator = pair.indexOf(":");
      const pid = separator >= 0 ? pair.slice(0, separator).trim() : "";
      const vid = separator >= 0 ? pair.slice(separator + 1).trim() : "";
      if (!allowed.has(pid) || !allowed.get(pid).has(vid)) invalidReferences += 1;
    }
  }
  if (priced / Math.max(1, skus.length) < 0.9) hard(test, `only ${priced}/${skus.length} SKUs have a positive price`);
  if (stocked / Math.max(1, skus.length) < 0.9) hard(test, `only ${stocked}/${skus.length} SKUs have numeric stock`);
  if (invalidReferences > 0) hard(test, `${invalidReferences} SKU property references cannot be resolved`);
  if (labeledNames < skus.length) completeness(test, "some SKU props_names omit property labels");
  if (packaged < skus.length) completeness(test, "some SKUs omit package_info (weight/dimensions)");
}

function validateItemDetail(test, data, { full = true } = {}) {
  if (!isObject(data)) {
    hard(test, "item detail data is not an object");
    return;
  }
  if (!sameId(data.item_id, FIXTURE.itemId)) hard(test, "returned item_id does not match fixture");
  if (!nonBlank(data.title)) hard(test, "title is missing");
  if (
    String(FIXTURE.language).toLowerCase() === "en" &&
    nonBlank(data.title) &&
    !looksEnglish(data.title)
  ) {
    hard(test, "English item-detail title is still predominantly Chinese");
  }
  if (!Array.isArray(data.main_imgs) || !data.main_imgs.some(validHttpImage)) {
    hard(test, "main_imgs has no usable HTTP image");
  }
  if (detailTopPrice(data) === null) {
    hard(test, "top-level price_info has no positive Chibox-usable price");
  }
  if (detailMoq(data) === null) hard(test, "quantity_begin/moq/tiered_price_info.begin_num is missing");
  if (finiteNumber(data.stock ?? data.total_stock) === null) hard(test, "top-level stock/total_stock is missing");
  validateSkuIntegrity(test, data);
  if (!full) return;

  if (!nonBlank(data.product_url)) completeness(test, "product_url is missing");
  if (!Array.isArray(data.product_props) || data.product_props.length === 0) {
    completeness(test, "product_props is empty");
  }
  if (!isObject(data.delivery_info)) completeness(test, "delivery_info is missing");
  if (!Array.isArray(data.service_tags)) completeness(test, "service_tags is missing");
  if (!isObject(data.sale_info)) completeness(test, "sale_info is missing");
  if (!isObject(data.tiered_price_info)) completeness(test, "tiered_price_info is missing");
  if (!isObject(data.mixed_batch)) completeness(test, "mixed_batch is missing");
  if (!Array.isArray(data.promotions)) completeness(test, "promotions is missing");
  if (typeof data.is_sold_out !== "boolean") completeness(test, "is_sold_out is missing");
}

function validateRatings(test, data, page) {
  if (!isObject(data)) {
    hard(test, "ratings data is not an object");
    return;
  }
  const rows = rowsFrom(data, ["list", "items", "reviews"]);
  if (!Array.isArray(rows)) {
    hard(test, "ratings list/items/reviews is not an array");
    return;
  }
  if (finiteNumber(data.page) !== page) hard(test, `ratings page does not equal ${page}`);
  if (EXPECT_REVIEWS && rows.length === 0) hard(test, "review fixture returned zero reviews");
  if (rows.length === 0) return;
  const withText = rows.filter((row) => nonBlank(row?.feedback ?? row?.content ?? row?.review ?? row?.comment));
  if (withText.length === 0) hard(test, "no review contains feedback/content");
  const metadata = rows.filter((row) =>
    nonBlank(row?.id ?? row?.feedback_id ?? row?.review_id) &&
    nonBlank(row?.feedback_date ?? row?.date ?? row?.time) &&
    finiteNumber(row?.rate_star ?? row?.rating) !== null &&
    nonBlank(row?.user_nick ?? row?.user_name ?? row?.buyer_name)
  );
  if (metadata.length < rows.length) {
    completeness(test, `${rows.length - metadata.length}/${rows.length} reviews lack ID/date/rating/user metadata`);
  }
  if (finiteNumber(data.total_count) === null) completeness(test, "review total_count is missing");
}

function validateShipping(test, data) {
  if (!isObject(data)) {
    hard(test, "shipping data is not an object");
    return;
  }
  const fee = finiteNumber(data.total_fee);
  if (fee === null || fee < 0) hard(test, "numeric data.total_fee is required by ChinaLocalShippingService");
  if (finiteNumber(data.total_quantity) !== FIXTURE.shippingQuantity) {
    hard(test, "shipping response does not echo the requested total_quantity");
  }
  for (const key of ["shipping_to", "unit", "first_unit", "first_unit_fee", "next_unit", "next_unit_fee"]) {
    if (!nonBlank(data[key])) completeness(test, `shipping ${key} is missing`);
  }
}

function validateShopInfo(test, data) {
  if (!isObject(data)) {
    hard(test, "shop info data is not an object");
    return;
  }
  const member = data.member_id ?? data.seller_member_id;
  if (!nonBlank(member)) hard(test, "shop member_id is missing");
  if (nonBlank(member) && !sameId(member, FIXTURE.memberId)) completeness(test, "shop member_id differs from fixture");
  if (!nonBlank(data.shop_name ?? data.company_name ?? data.name)) hard(test, "shop/company name is missing");
  if (!nonBlank(data.shop_url)) hard(test, "shop_url is missing");
  const optional = [
    "seller_user_id",
    "shop_logo",
    "address",
    "rating",
    "repurchase_rate",
  ].filter((key) => !nonBlank(data[key]));
  if (optional.length) completeness(test, `shop fields missing: ${optional.join(", ")}`);
}

function shopCategories(data) {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return null;
  for (const key of ["list", "categories", "items", "shop_categories", "data"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return null;
}

function validateShopCategories(test, data) {
  const rows = shopCategories(data);
  if (!Array.isArray(rows)) {
    hard(test, "shop category list/categories is not an array");
    return;
  }
  const usable = rows.filter((row) =>
    isObject(row) &&
    nonBlank(row.shop_cat_id ?? row.cat_id ?? row.category_id ?? row.id ?? row.cid) &&
    nonBlank(row.name ?? row.cat_name ?? row.category_name ?? row.title)
  );
  if (EXPECT_SHOP_CATEGORIES && usable.length === 0) {
    hard(test, "no shop category has both an accepted ID and name");
  } else if (usable.length < rows.length) {
    completeness(test, `${rows.length - usable.length}/${rows.length} shop categories have no consumer-usable ID/name`);
  }
}

function validateShopItems(test, data, page) {
  requirePage(test, data, page);
  const rows = validateCards(test, data);
  const total = requireTotal(test, data, ["total_count", "total"]);
  if (total !== null && total < rows.length) hard(test, "shop total is smaller than returned item count");
  validateSortAndPrices(
    test,
    rows,
    String(ENV.SHOP_SORT || "default"),
    optionalEnv("SHOP_PRICE_START"),
    optionalEnv("SHOP_PRICE_END")
  );
}

function validateSearchPage(
  test,
  data,
  page,
  expectedPageSize,
  sort,
  minPrice,
  maxPrice
) {
  requirePage(test, data, page, expectedPageSize);
  const rows = validateCards(test, data);
  const total = requireTotal(test, data, ["total_count"]);
  if (total !== null && total < rows.length) hard(test, "search total_count is smaller than returned item count");
  if (total !== null) {
    const expectedCount = Math.min(
      expectedPageSize,
      Math.max(0, total - (page - 1) * expectedPageSize)
    );
    if (rows.length !== expectedCount) {
      hard(
        test,
        `returned ${rows.length} search items, expected ${expectedCount} for page_size=${expectedPageSize}`
      );
    }
  }
  validateSortAndPrices(
    test,
    rows,
    sort,
    minPrice,
    maxPrice
  );
  return rows;
}

function validateTextSearch(test, data, page, expectedPageSize = PAGE_SIZE) {
  const rows = validateSearchPage(
    test,
    data,
    page,
    expectedPageSize,
    SEARCH_SORT,
    PRICE_START,
    PRICE_END
  );
  const tokens = FIXTURE.keyword.toLowerCase().split(/\s+/).filter((token) => token.length >= 3);
  if (tokens.length) {
    const relevant = rows.filter((row) => tokens.some((token) => itemTitle(row).toLowerCase().includes(token)));
    if (relevant.length / Math.max(1, rows.length) < 0.2) {
      completeness(test, `only ${relevant.length}/${rows.length} titles contain a keyword token`);
    }
  }
}

function isAlibabaImage(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return /(^|\.)(alicdn\.com|1688\.com|taobao\.com|tmall\.com)$/.test(host);
  } catch {
    return String(value).startsWith("/search/imgextra/");
  }
}

function convertedImage(data) {
  if (!isObject(data)) return "";
  return String(data.image_url || data.converted_url || data.url || data.converted || "").trim();
}

function validateConvertedImage(test, data) {
  const output = convertedImage(data);
  if (!output) {
    hard(test, "converted image URL/path is missing");
    return;
  }
  if (!isAlibabaImage(FIXTURE.imageUrl) && output === FIXTURE.imageUrl) {
    hard(test, "non-Alibaba input was returned unchanged (conversion is a false success)");
  }
  if (!isAlibabaImage(FIXTURE.imageUrl) && !isAlibabaImage(output)) {
    completeness(test, "converted output is not an Alibaba URL or /search/imgextra path");
  }
}

function validateImageSearch(test, data, page) {
  requirePage(test, data, page);
  const rows = validateCards(test, data);
  const total = requireTotal(test, data, ["total", "total_count"]);
  if (total !== null && total < rows.length) hard(test, "image-search total is smaller than returned item count");
  if (typeof data?.has_next_page !== "boolean") {
    hard(test, "has_next_page must be a boolean for TmapiService::searchByImage");
  }
  validateSortAndPrices(test, rows, String(ENV.IMAGE_SORT || "default"));
}

function queryWithOptionals(base, values) {
  const result = { ...base };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function listSignature(data, keys = ["items"]) {
  return idsFrom(data, keys).join(",");
}

function quickCards(data, keys = ["items"]) {
  const rows = rowsFrom(data, keys);
  return Array.isArray(rows) && rows.length > 0 && rows.some(isUsableCard);
}

async function runWarmGate() {
  const selected = WARM_TARGETS.has("all")
    ? [...warmCases.keys()]
    : [...WARM_TARGETS];
  console.log("\nWarm-repeat latency:");
  for (const key of selected) {
    const entry = warmCases.get(key);
    if (!entry) {
      completeness("warm repeat", `${key} was not measurable because its cold request failed`);
      console.log(`SKIP ${key.padEnd(27)} cold request unavailable`);
      continue;
    }
    const times = [];
    for (let repeat = 1; repeat <= WARM_REPEATS; repeat += 1) {
      const label = `${entry.label} warm ${repeat}`;
      const result = await requestJson(label, entry.spec, "warm");
      if (!validateEnvelope(label, result)) continue;
      if (entry.quickValidate && !entry.quickValidate(result.body.data)) {
        hard(label, "warm response lost its consumer-usable shape");
      }
      if (key === "item_detail") {
        if (result.scraperCache !== "memory") {
          hard(
            label,
            `warm detail cache marker is ${result.scraperCache || "missing"}, expected memory`
          );
        }
        if (REQUIRE_DETAIL_HTTP && result.scraperPath !== "http") {
          hard(
            label,
            `warm detail path is ${result.scraperPath || "missing"}, expected http`
          );
        }
      }
      if (entry.signature) {
        const signature = entry.signature(result.body.data);
        if (entry.initialSignature && signature && signature !== entry.initialSignature) {
          completeness(label, "warm response signature differs from the cold response");
        }
      }
      times.push(result.ms);
    }
    const p95 = percentile(times, 95);
    if (p95 === null) {
      console.log(`HARD ${key.padEnd(27)} no successful warm sample`);
      continue;
    }
    if (p95 > WARM_MAX_MS) {
      hard("warm latency", `${key} p95 ${Math.round(p95)}ms exceeds ${WARM_MAX_MS}ms`);
    }
    console.log(
      `${p95 <= WARM_MAX_MS ? "PASS" : "HARD"} ${key.padEnd(27)} p95=${Math.round(p95)}ms samples=${times.length}`
    );
  }
}

function validateFixtureConfig() {
  const invalid = [];
  if (!/^\d+$/.test(FIXTURE.itemId)) invalid.push("ITEM_ID must be numeric");
  if (!/^\d+$/.test(FIXTURE.reviewItemId)) invalid.push("REVIEW_ITEM_ID must be numeric");
  if (!FIXTURE.categoryId) invalid.push("CATEGORY_ID is required");
  if (!FIXTURE.memberId) invalid.push("MEMBER_ID is required");
  if (!FIXTURE.shopUrl) invalid.push("SHOP_URL is required");
  if (!FIXTURE.keyword) invalid.push("KEYWORD is required");
  if (!FIXTURE.imageUrl) invalid.push("IMAGE_URL is required");
  if (invalid.length) throw new Error(invalid.join("; "));
}

async function main() {
  validateFixtureConfig();
  console.log(`Chibox 1688 release gate -> ${BASE.origin}`);
  console.log(
    `timeout=${TIMEOUT_MS}ms coldWarn=${COLD_WARN_MS}ms coldMax=${COLD_MAX_MS}ms warmMax=${WARM_MAX_MS}ms token=${API_TOKEN ? "configured" : "not configured"}`
  );
  console.log("\nExact Chibox endpoint contracts:");

  await execute(
    "category top",
    { path: "/1688/category/info" },
    (data) => validateCategoryTop("category top", data)
  );

  await execute(
    "category info",
    { path: "/1688/category/info", query: { cat_id: FIXTURE.categoryId } },
    (data) => validateCategoryInfo("category info", data)
  );

  const categorySpec = (page) => ({
    path: "/1688/category/items",
    query: { cat_id: FIXTURE.categoryId, page, page_size: CATEGORY_PAGE_SIZE },
  });
  const categoryPage1 = await execute(
    "category items p1",
    categorySpec(1),
    (data) => validateCategoryItems("category items p1", data, 1),
    {
      key: "category_items",
      quickValidate: (data) => quickCards(data) && typeof data?.has_next_page === "boolean",
      signature: listSignature,
    }
  );
  if (TEST_PAGINATION && PAGINATION_TARGETS.has("category")) {
    const categoryPage2 = await execute(
      "category items p2",
      categorySpec(2),
      (data) => validateCategoryItems("category items p2", data, 2)
    );
    if (categoryPage1 && categoryPage2) {
      assessPageOverlap("category pagination", categoryPage1.body.data, categoryPage2.body.data);
    }
  }
  if (categoryPage1) await runInvalidCategoryControl(categoryPage1.body.data);

  const detailSpec = {
    path: "/1688/item_detail",
    query: {
      item_id: FIXTURE.itemId,
      language: FIXTURE.language,
    },
  };
  await execute(
    "item detail",
    detailSpec,
    (data, _body, result) => {
      validateItemDetail("item detail", data);
      if (REQUIRE_COLD_CACHE_MISS && result.scraperCache !== "miss") {
        hard(
          "item detail",
          `cold detail cache marker is ${result.scraperCache || "missing"}, expected miss`
        );
      }
      if (REQUIRE_DETAIL_HTTP && result.scraperPath !== "http") {
        hard(
          "item detail",
          `detail path is ${result.scraperPath || "missing"}, expected http`
        );
      }
    },
    {
      key: "item_detail",
      quickValidate: (data) =>
        isObject(data) && sameId(data.item_id, FIXTURE.itemId) && detailTopPrice(data) !== null,
      signature: (data) => `${data?.item_id || ""}|${data?.title || ""}|${data?.skus?.length || 0}`,
    }
  );
  await execute(
    "global item detail",
    {
      path: "/1688/global/item_detail",
      query: {
        item_id: FIXTURE.itemId,
        language: FIXTURE.language,
      },
    },
    (data) => validateItemDetail("global item detail", data, { full: false })
  );

  const ratingSpec = (page) => ({
    path: "/1688/item/rating",
    query: {
      item_id: FIXTURE.reviewItemId,
      page,
      sort_type: String(ENV.REVIEW_SORT || "default"),
    },
  });
  const ratingPage1 = await execute(
    "item ratings p1",
    ratingSpec(1),
    (data) => validateRatings("item ratings p1", data, 1),
    {
      key: "ratings",
      quickValidate: (data) => Array.isArray(rowsFrom(data, ["list", "items", "reviews"])),
      signature: (data) => listSignature(data, ["list", "items", "reviews"]),
    }
  );
  if (TEST_PAGINATION && PAGINATION_TARGETS.has("ratings")) {
    const ratingPage2 = await execute(
      "item ratings p2",
      ratingSpec(2),
      (data) => validateRatings("item ratings p2", data, 2)
    );
    if (ratingPage1 && ratingPage2) {
      assessPageOverlap(
        "ratings pagination",
        ratingPage1.body.data,
        ratingPage2.body.data,
        ["list", "items", "reviews"]
      );
    }
  }

  const shippingQuery = queryWithOptionals(
    {
      item_id: FIXTURE.itemId,
      province: FIXTURE.province,
      total_quantity: FIXTURE.shippingQuantity,
    },
    { total_weight: FIXTURE.shippingWeight }
  );
  await execute(
    "item shipping",
    { path: "/1688/item/shipping", query: shippingQuery },
    (data) => validateShipping("item shipping", data),
    {
      key: "shipping",
      quickValidate: (data) => finiteNumber(data?.total_fee) !== null,
      signature: (data) => `${data?.total_fee ?? ""}|${data?.total_quantity ?? ""}`,
    }
  );

  await execute(
    "shop info",
    {
      path: "/1688/shop/shop_info",
      query: { member_id: FIXTURE.memberId, shop_url: FIXTURE.shopUrl },
    },
    (data) => validateShopInfo("shop info", data),
    {
      key: "shop_info",
      quickValidate: (data) => isObject(data) && nonBlank(data.shop_name ?? data.company_name ?? data.name),
      signature: (data) => `${data?.member_id || data?.seller_member_id || ""}|${data?.shop_name || data?.company_name || ""}`,
    }
  );

  await execute(
    "shop categories",
    {
      path: "/1688/shop/category",
      query: { member_id: FIXTURE.memberId, shop_url: FIXTURE.shopUrl },
    },
    (data) => validateShopCategories("shop categories", data),
    {
      key: "shop_categories",
      quickValidate: (data) => Array.isArray(shopCategories(data)),
      signature: (data) => (shopCategories(data) || []).map(itemId).filter(Boolean).join(","),
    }
  );

  const shopQuery = (page, byUrl) =>
    queryWithOptionals(
      {
        ...(byUrl ? { shop_url: FIXTURE.shopUrl } : { member_id: FIXTURE.memberId }),
        page,
        page_size: PAGE_SIZE,
        sort: String(ENV.SHOP_SORT || "default"),
      },
      byUrl
        ? { cat_id: optionalEnv("SHOP_CATEGORY_ID") }
        : {
            shop_cat_id: optionalEnv("SHOP_CATEGORY_ID"),
            price_start: optionalEnv("SHOP_PRICE_START"),
            price_end: optionalEnv("SHOP_PRICE_END"),
          }
    );
  const shopSpec = (page, byUrl) => ({
    path: byUrl ? "/1688/shop/items/v2" : "/1688/shop/items",
    query: shopQuery(page, byUrl),
  });

  const shopPage1 = await execute(
    "shop items p1",
    shopSpec(1, false),
    (data) => validateShopItems("shop items p1", data, 1),
    {
      key: "shop_items",
      quickValidate: quickCards,
      signature: listSignature,
    }
  );
  if (TEST_PAGINATION && PAGINATION_TARGETS.has("shop")) {
    const shopPage2 = await execute(
      "shop items p2",
      shopSpec(2, false),
      (data) => validateShopItems("shop items p2", data, 2)
    );
    if (shopPage1 && shopPage2) assessPageOverlap("shop pagination", shopPage1.body.data, shopPage2.body.data);
  }

  const shopUrlPage1 = await execute(
    "shop URL items p1",
    shopSpec(1, true),
    (data) => validateShopItems("shop URL items p1", data, 1),
    {
      key: "shop_url_items",
      quickValidate: quickCards,
      signature: listSignature,
    }
  );
  if (TEST_PAGINATION && PAGINATION_TARGETS.has("shop_url")) {
    const shopUrlPage2 = await execute(
      "shop URL items p2",
      shopSpec(2, true),
      (data) => validateShopItems("shop URL items p2", data, 2)
    );
    if (shopUrlPage1 && shopUrlPage2) {
      assessPageOverlap("shop URL pagination", shopUrlPage1.body.data, shopUrlPage2.body.data);
    }
  }

  const searchQuery = (page) =>
    queryWithOptionals(
      {
        keyword: FIXTURE.keyword,
        page,
        page_size: PAGE_SIZE,
        language: FIXTURE.language,
        sort: SEARCH_SORT,
      },
      {
        price_start: PRICE_START,
        price_end: PRICE_END,
      }
    );
  const searchSpec = (page) => ({ path: "/1688/global/search/items", query: searchQuery(page) });
  const searchPage1 = await execute(
    "global text search p1",
    searchSpec(1),
    (data) => validateTextSearch("global text search p1", data, 1),
    {
      key: "text_search",
      quickValidate: quickCards,
      signature: listSignature,
    }
  );
  if (TEST_PAGINATION && PAGINATION_TARGETS.has("text")) {
    const searchPage2 = await execute(
      "global text search p2",
      searchSpec(2),
      (data) => validateTextSearch("global text search p2", data, 2)
    );
    if (searchPage1 && searchPage2) {
      assessPageOverlap("text-search pagination", searchPage1.body.data, searchPage2.body.data);
      assessCrossPageSearch(
        "text-search pagination",
        searchPage1.body.data,
        searchPage2.body.data,
        SEARCH_SORT
      );

      const widePageSize = Math.min(20, PAGE_SIZE * 2);
      if (widePageSize === PAGE_SIZE * 2) {
        const wideQuery = { ...searchQuery(1), page_size: widePageSize };
        const wide = await execute(
          "text-search continuity",
          { path: "/1688/global/search/items", query: wideQuery },
          (data) =>
            validateTextSearch(
              "text-search continuity",
              data,
              1,
              widePageSize
            )
        );
        if (wide) {
          const splitIds = [
            ...idsFrom(searchPage1.body.data),
            ...idsFrom(searchPage2.body.data),
          ];
          const wideIds = idsFrom(wide.body.data);
          if (wideIds.join(",") !== splitIds.join(",")) {
            hard(
              "text-search continuity",
              `page1(size=${widePageSize}) does not equal page1+page2(size=${PAGE_SIZE})`
            );
          }
        }
      }
    }
  }

  const filterControlSize = Math.min(20, Math.max(10, PAGE_SIZE * 2));
  const unfilteredControl = await execute(
    "search filter baseline",
    {
      path: "/1688/global/search/items",
      query: {
        keyword: FIXTURE.keyword,
        page: 1,
        page_size: filterControlSize,
        language: FIXTURE.language,
        sort: "price_up",
      },
    },
    (data) =>
      validateSearchPage(
        "search filter baseline",
        data,
        1,
        filterControlSize,
        "price_up"
      )
  );
  if (unfilteredControl) {
    const baselineRows = rowsFrom(unfilteredControl.body.data, ["items"]) || [];
    const distinctPrices = [...new Set(baselineRows.map(itemPrice).filter((p) => p !== null))]
      .sort((left, right) => left - right);
    const dynamicFloor = distinctPrices[Math.floor(distinctPrices.length / 2)];
    if (distinctPrices.length < 2 || dynamicFloor <= distinctPrices[0]) {
      hard(
        "search price filters",
        "fixture does not expose at least two distinct prices, so filter enforcement cannot be proven"
      );
    } else {
      const filteredQuery = {
        keyword: FIXTURE.keyword,
        page: 1,
        page_size: filterControlSize,
        language: FIXTURE.language,
        price_start: String(dynamicFloor),
      };
      const filteredAscending = await execute(
        "search price filter",
        {
          path: "/1688/global/search/items",
          query: { ...filteredQuery, sort: "price_up" },
        },
        (data) =>
          validateSearchPage(
            "search price filter",
            data,
            1,
            filterControlSize,
            "price_up",
            String(dynamicFloor)
          )
      );
      await execute(
        "search price descending",
        {
          path: "/1688/global/search/items",
          query: { ...filteredQuery, sort: "price_down" },
        },
        (data) =>
          validateSearchPage(
            "search price descending",
            data,
            1,
            filterControlSize,
            "price_down",
            String(dynamicFloor)
          )
      );
      if (filteredAscending) {
        const baselineTotal = finiteNumber(
          unfilteredControl.body.data?.total_count ?? unfilteredControl.body.data?.total
        );
        const filteredTotal = finiteNumber(
          filteredAscending.body.data?.total_count ?? filteredAscending.body.data?.total
        );
        const baselineIds = new Set(idsFrom(unfilteredControl.body.data));
        const pulledFromLaterPages = idsFrom(filteredAscending.body.data).some(
          (id) => !baselineIds.has(id)
        );
        if (
          !(baselineTotal !== null && filteredTotal !== null && filteredTotal < baselineTotal) &&
          !pulledFromLaterPages
        ) {
          hard(
            "search price filters",
            "price_start neither reduced the upstream total nor replenished results from later pages"
          );
        }
      }
    }
  }

  if (MULTI_CATEGORY_IDS.length < 2) {
    hard("multi-category search", "CAT_IDS must contain at least two category IDs");
  } else {
    const multiQuery = (catIds, page = 1) => ({
      keyword: FIXTURE.keyword,
      page,
      page_size: PAGE_SIZE,
      language: FIXTURE.language,
      sort: "default",
      cat_ids: catIds.join(","),
    });
    const multiForward = await execute(
      "multi-category search",
      { path: "/1688/global/search/items", query: multiQuery(MULTI_CATEGORY_IDS) },
      (data) =>
        validateSearchPage(
          "multi-category search",
          data,
          1,
          PAGE_SIZE,
          "default"
        )
    );
    const multiReverse = await execute(
      "multi-category reverse",
      {
        path: "/1688/global/search/items",
        query: multiQuery([...MULTI_CATEGORY_IDS].reverse()),
      },
      (data) =>
        validateSearchPage(
          "multi-category reverse",
          data,
          1,
          PAGE_SIZE,
          "default"
        )
    );
    if (multiForward && multiReverse) {
      const forwardIds = idsFrom(multiForward.body.data);
      const reverseIds = idsFrom(multiReverse.body.data);
      if (forwardIds.join(",") !== reverseIds.join(",")) {
        hard(
          "multi-category search",
          "category order changed the ordered result set"
        );
      }
      if (multiReverse.scraperCache !== "memory") {
        hard(
          "multi-category reverse",
          `canonical reverse lookup was ${multiReverse.scraperCache || "unmarked"}, expected memory cache`
        );
      }
      const represented = new Set();
      for (const item of rowsFrom(multiForward.body.data, ["items"]) || []) {
        for (const node of item?.category_path || []) {
          const id = String(
            isObject(node)
              ? node.id ?? node.cat_id ?? node.category_id ?? node.cid ?? ""
              : node
          );
          if (id) represented.add(id);
        }
      }
      const missingCategories = MULTI_CATEGORY_IDS.filter(
        (categoryId) => !represented.has(String(categoryId))
      );
      if (missingCategories.length) {
        hard(
          "multi-category search",
          `${missingCategories.length} requested category stream(s) contributed no result`
        );
      }
      const forwardTotal = finiteNumber(
        multiForward.body.data?.total_count ?? multiForward.body.data?.total
      );
      const reverseTotal = finiteNumber(
        multiReverse.body.data?.total_count ?? multiReverse.body.data?.total
      );
      if (
        forwardTotal !== null &&
        reverseTotal !== null &&
        forwardTotal !== reverseTotal
      ) {
        hard(
          "multi-category search",
          `category order changed total (${forwardTotal} vs ${reverseTotal})`
        );
      }

      if (paginationExpected(multiForward.body.data, forwardIds.length)) {
        const multiPage2 = await execute(
          "multi-category page 2",
          {
            path: "/1688/global/search/items",
            query: multiQuery(MULTI_CATEGORY_IDS, 2),
          },
          (data) =>
            validateSearchPage(
              "multi-category page 2",
              data,
              2,
              PAGE_SIZE,
              "default"
            )
        );
        if (multiPage2) {
          assessPageOverlap(
            "multi-category pagination",
            multiForward.body.data,
            multiPage2.body.data
          );
        }
      }
    }
  }

  const conversionResult = await execute(
    "image URL conversion",
    {
      path: "/1688/tools/image/convert_url",
      method: "POST",
      body: { url: FIXTURE.imageUrl },
    },
    (data) => validateConvertedImage("image URL conversion", data),
    {
      key: "image_conversion",
      quickValidate: (data) => nonBlank(convertedImage(data)),
      signature: convertedImage,
    }
  );
  const converted = conversionResult ? convertedImage(conversionResult.body.data) : "";
  const imageForSearch = FIXTURE.imageSearchUrl || converted;
  if (!imageForSearch) {
    hard("image search", "cannot run because conversion returned no image and IMAGE_SEARCH_URL is unset");
  } else {
    const imageQuery = (page) =>
      queryWithOptionals(
        {
          img_url: imageForSearch,
          page,
          page_size: PAGE_SIZE,
          language: FIXTURE.language,
          sort: String(ENV.IMAGE_SORT || "default"),
        },
        {
          support_dropshipping: optionalEnv("IMAGE_SUPPORT_DROPSHIPPING"),
          is_factory: optionalEnv("IMAGE_IS_FACTORY"),
          verified_supplier: optionalEnv("IMAGE_VERIFIED_SUPPLIER"),
          free_shipping: optionalEnv("IMAGE_FREE_SHIPPING"),
          new_arrival: optionalEnv("IMAGE_NEW_ARRIVAL"),
        }
      );
    const imageSpec = (page) => ({ path: "/1688/search/image", query: imageQuery(page) });
    const imagePage1 = await execute(
      "image search p1",
      imageSpec(1),
      (data) => validateImageSearch("image search p1", data, 1),
      {
        key: "image_search",
        quickValidate: (data) => quickCards(data) && typeof data?.has_next_page === "boolean",
        signature: listSignature,
      }
    );
    if (TEST_PAGINATION && PAGINATION_TARGETS.has("image")) {
      const imagePage2 = await execute(
        "image search p2",
        imageSpec(2),
        (data) => validateImageSearch("image search p2", data, 2)
      );
      if (imagePage1 && imagePage2) {
        assessPageOverlap("image-search pagination", imagePage1.body.data, imagePage2.body.data);
      }
    }
  }

  await runWarmGate();

  const coldTimes = requests.filter((row) => row.phase === "cold" && !row.error).map((row) => row.ms);
  const warmTimes = requests.filter((row) => row.phase === "warm" && !row.error).map((row) => row.ms);
  console.log("\nRelease-gate summary:");
  console.log(`requests=${requests.length} hard=${hardFailures.length} completeness=${completenessFailures.length}`);
  console.log(
    `cold p50=${Math.round(percentile(coldTimes, 50) || 0)}ms p95=${Math.round(percentile(coldTimes, 95) || 0)}ms; ` +
      `warm p50=${Math.round(percentile(warmTimes, 50) || 0)}ms p95=${Math.round(percentile(warmTimes, 95) || 0)}ms`
  );

  if (hardFailures.length) {
    console.log("\nHard failures (release blocked):");
    hardFailures.forEach((failure, index) =>
      console.log(`${String(index + 1).padStart(2)}. ${failure.test}: ${failure.message}`)
    );
  }
  if (completenessFailures.length) {
    console.log("\nCompleteness/performance warnings:");
    completenessFailures.forEach((failure, index) =>
      console.log(`${String(index + 1).padStart(2)}. ${failure.test}: ${failure.message}`)
    );
  }

  if (hardFailures.length) {
    console.log("\nRESULT: FAIL - do not switch providers.");
    process.exitCode = 1;
  } else {
    console.log(
      `\nRESULT: PASS${completenessFailures.length ? " with completeness warnings" : ""}.`
    );
  }
}

main().catch((error) => {
  console.error(`Release gate crashed: ${redact(error?.message || error)}`);
  process.exitCode = 2;
});
