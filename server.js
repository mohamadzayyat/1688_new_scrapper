import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getItemDetailById } from "./scrape.js";
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
} from "./extraScrape.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3456;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let activeJob = null;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
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

async function withJob(res, label, fn, { tmapi = true } = {}) {
  if (activeJob) {
    const body = tmapi
      ? tmapiError(439, "A scrape is already running. Wait for it to finish.")
      : { error: "A scrape is already running. Wait for it to finish." };
    if (tmapi) sendTmapi(res, body);
    else sendJson(res, 429, body);
    return;
  }
  activeJob = label;
  try {
    const data = await fn();
    if (tmapi) sendTmapi(res, data);
    else sendJson(res, 200, data);
  } catch (err) {
    if (tmapi) sendTmapi(res, tmapiError(500, err.message || "Request failed"));
    else sendJson(res, 502, { error: err.message || "Request failed" });
  } finally {
    activeJob = null;
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
  for await (const chunk of req) chunks.push(chunk);
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
  void url.searchParams.get("apiToken");

  if (!/^\d+$/.test(itemId)) {
    sendTmapi(res, tmapiError(422, "item_id is required and must be a number"));
    return;
  }

  await withJob(res, `item_detail:${itemId}:${language}`, () =>
    getItemDetailById(itemId, { language, optimize_title: optimizeTitle })
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
  await withJob(res, `item_detail_by_url:${itemId}:${language}`, () =>
    getItemDetailById(itemId, { language, optimize_title: optimizeTitle })
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
  await withJob(res, `item_desc:${itemId}`, () =>
    getItemDesc(itemId, { language })
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
  await withJob(res, `item_review:${itemId}`, () =>
    getItemReviews(itemId, { page, page_size, language })
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
  if (!/^\d+$/.test(itemId)) {
    sendTmapi(res, tmapiError(422, "item_id is required"));
    return;
  }
  await withJob(res, `item_freight:${itemId}`, () =>
    getItemFreight(itemId, { language })
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
  if (!keyword) {
    sendTmapi(res, tmapiError(422, "keyword is required"));
    return;
  }
  await withJob(res, `search:${keyword}:${page}`, () =>
    searchItemsTmapi({ keyword, page, page_size, sort, language })
  );
}

async function handleSearchImage(req, res) {
  if (req.method !== "POST") {
    sendTmapi(
      res,
      tmapiError(405, "Use POST /1688/search/img with JSON { img_url }")
    );
    return;
  }
  const body = await readJsonBody(req);
  if (body == null) {
    sendTmapi(res, tmapiError(422, "Invalid JSON body"));
    return;
  }
  const language = normalizeLanguage(body.language || "en");
  await withJob(res, `search_img`, () =>
    searchByImage({
      img_url: body.img_url || body.image_url || body.url,
      page: body.page || 1,
      language,
    })
  );
}

async function handleShopItems(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/shop/items/v2?..."));
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
      language: normalizeLanguage(url.searchParams.get("language") || "en"),
    })
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
    })
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
    })
  );
}

async function handleCategoryProducts(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/category/products?..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  await withJob(res, `category_products`, () =>
    getCategoryProducts({
      cat_id: url.searchParams.get("cat_id") || "",
      keyword: url.searchParams.get("keyword") || "",
      page: Number(url.searchParams.get("page") || 1),
      page_size: Number(url.searchParams.get("page_size") || 20),
      sort: url.searchParams.get("sort") || "default",
      language: normalizeLanguage(url.searchParams.get("language") || "en"),
    })
  );
}

async function handleImgConvert(req, res) {
  if (req.method !== "GET") {
    sendTmapi(res, tmapiError(405, "Use GET /1688/tools/img_convert?..."));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  sendTmapi(
    res,
    convertImageUrl(url.searchParams.get("img_url") || "", {
      width: url.searchParams.get("width"),
      height: url.searchParams.get("height"),
    })
  );
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
  ["/1688/v2/item_detail", handleItemDetail],
  ["/api/1688/v2/item_detail", handleItemDetail],
  ["/1688/v2/item_detail_by_url", handleItemDetailByUrl],
  ["/api/1688/v2/item_detail_by_url", handleItemDetailByUrl],
  ["/1688/item_desc", handleItemDesc],
  ["/1688/item_review", handleItemReview],
  ["/1688/item_reviews", handleItemReview],
  ["/1688/item_freight", handleItemFreight],
  ["/1688/search/items", handleSearchItems],
  ["/1688/v2/search/items", handleSearchItems],
  ["/1688/search/img", handleSearchImage],
  ["/1688/shop/items/v2", handleShopItems],
  ["/1688/shop/info", handleShopInfo],
  ["/1688/shop/cats", handleShopCats],
  ["/1688/shop/categories", handleShopCats],
  ["/1688/category/products", handleCategoryProducts],
  ["/1688/category/products/v2", handleCategoryProducts],
  ["/1688/tools/img_convert", handleImgConvert],
  ["/1688/img_convert", handleImgConvert],
  ["/tools/parse/url", handleParseUrl],
  ["/1688/tools/parse_url", handleParseUrl],
  ["/api/scrape", handleLegacyScrape],
  ["/api/search", handleLegacySearch],
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const hit = ROUTES.find(([path]) => url.pathname === path);
    if (hit) {
      await hit[1](req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`1688 scraper UI → http://localhost:${PORT}`);
  console.log(`TMAPI routes mounted under /1688/...`);
});
