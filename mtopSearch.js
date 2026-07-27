import { createHash, randomBytes } from "node:crypto";
import { request } from "playwright";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import { getPlaywrightProxy } from "./proxy.js";

const APP_KEY = "12574478";
const API = "mtop.relationrecommend.WirelessRecommend.recommend";
const VERSION = "2.0";
const ENDPOINT =
  "https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/";
const MAX_SHELL_BYTES = 500_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const SEARCH_MTOP_REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Math.min(20_000, Number(process.env.SEARCH_MTOP_REQUEST_TIMEOUT_MS) || 12_000)
);
const SEARCH_MTOP_BUDGET_MS = Math.max(
  10_000,
  Math.min(40_000, Number(process.env.SEARCH_MTOP_BUDGET_MS) || 30_000)
);
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function searchError(message, code = 502) {
  const error = new Error(message);
  error.name = "MtopSearchError";
  error.code = code;
  error.mtopSearchFallback = true;
  return error;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImage(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.toLowerCase();
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      !(host === "alicdn.com" || host.endsWith(".alicdn.com"))
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function positivePrice(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  const number = match ? Number(match[0]) : null;
  return Number.isFinite(number) && number > 0 ? String(number) : null;
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

export function signMtopSearch(token, timestamp, data) {
  return createHash("md5")
    .update(`${token}&${timestamp}&${APP_KEY}&${data}`)
    .digest("hex");
}

function signedParams(data, token = "") {
  const timestamp = String(Date.now());
  return {
    jsv: "2.7.4",
    appKey: APP_KEY,
    t: timestamp,
    sign: signMtopSearch(token, timestamp, data),
    api: API,
    v: VERSION,
    type: "json",
    dataType: "json",
    isSec: "0",
    timeout: "20000",
    data,
  };
}

function buildSearchRequest(options, pageId) {
  const inner = {
    beginPage: String(options.upstreamPage),
    pageSize: 60,
    method: "getOfferList",
    pageId,
    verticalProductFlag: "pcmarket",
    searchScene: "pcOfferSearch",
    charset: "GBK",
    filt: "y",
    n: "y",
    categoryId: options.categoryId,
    keywords: options.keyword,
  };
  const sortType = normalizeSort(options.sort);
  if (sortType) inner.sortType = sortType;
  if (options.priceStart !== "") inner.priceStart = String(options.priceStart);
  if (options.priceEnd !== "") inner.priceEnd = String(options.priceEnd);
  return JSON.stringify({ appId: 32517, params: JSON.stringify(inner) });
}

function buildShellUrl(options) {
  const url = new URL("https://s.1688.com/selloffer/offer_search.htm");
  url.searchParams.set("keywords", options.keyword);
  url.searchParams.set("beginPage", String(options.upstreamPage));
  url.searchParams.set("filt", "y");
  url.searchParams.set("n", "y");
  url.searchParams.set("categoryId", options.categoryId);
  const sortType = normalizeSort(options.sort);
  if (sortType) url.searchParams.set("sortType", sortType);
  if (options.priceStart !== "") url.searchParams.set("priceStart", String(options.priceStart));
  if (options.priceEnd !== "") url.searchParams.set("priceEnd", String(options.priceEnd));
  return url;
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
  if (remaining < 250) throw searchError("Category search deadline exceeded", 504);
  return Math.max(1, Math.min(SEARCH_MTOP_REQUEST_TIMEOUT_MS, remaining));
}

async function bodyWithin(response, maximum, deadline, label) {
  const declared = Number(response.headers()["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maximum) {
    throw searchError(`${label} response was too large`);
  }
  const body = await awaitJob(response.body());
  if (Date.now() > deadline) throw searchError(`${label} deadline exceeded`, 504);
  if (body.length > maximum) throw searchError(`${label} response was too large`);
  return body;
}

function assertResponse(response, expectedHost, expectedPath, label) {
  const status = response.status();
  if (status < 200 || status >= 300) {
    throw searchError(`${label} returned HTTP ${status}`, status === 429 ? 429 : 502);
  }
  const url = new URL(response.url());
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== expectedHost ||
    url.pathname.replace(/\/+$/, "") !== expectedPath
  ) {
    throw searchError(`${label} redirected unexpectedly`);
  }
}

export function mapMtopSearchPayload(payload) {
  const ret = Array.isArray(payload?.ret) ? payload.ret : [];
  const offer = payload?.data?.data?.OFFER;
  if (!ret.some((entry) => /^SUCCESS(?:::|$)/i.test(String(entry))) || !offer) {
    throw searchError("Category search service was unsuccessful");
  }
  const seen = new Set();
  const items = [];
  for (const cell of Array.isArray(offer.items) ? offer.items : []) {
    const item = cell?.data;
    const offerId = String(item?.offerId || "").trim();
    const title = cleanText(item?.title);
    const image = normalizeImage(
      item?.offerPicUrl || item?.odPicUrl || item?.list?.cover?.pic
    );
    const price = positivePrice(item?.priceInfo?.price || item?.price);
    if (!/^\d{8,}$/.test(offerId) || seen.has(offerId) || !title || !image || !price) {
      continue;
    }
    seen.add(offerId);
    items.push({
      offerId,
      title,
      price,
      image,
      sales: item.bookedCount != null ? String(item.bookedCount) : null,
      repurchaseRate: cleanText(
        item.offerRepurchaseRate || item.turnHead?.percent || item.afterTags?.text
      ) || null,
      company: cleanText(item.shopAddition?.text || item.shop?.text) || null,
      location: [item.province, item.city].filter(Boolean).join("") || null,
      member_id: String(item.memberId || ""),
      login_id: cleanText(item.loginId),
      tags: (Array.isArray(item.tags) ? item.tags : [])
        .map((tag) => cleanText(tag?.text))
        .filter(Boolean)
        .slice(0, 5),
      isAd: item.isBid === "true" || item.type === "bid" || item.block === "P4P",
    });
  }
  const totalValue = Number(offer.found);
  const total = Number.isFinite(totalValue) && totalValue >= 0
    ? Math.max(totalValue, items.length)
    : items.length + (String(offer.hasMore) === "true" ? 1 : 0);
  if (!items.length && total !== 0) {
    throw searchError("Category search service omitted valid offer cards");
  }
  return { source: "mtop-search", total, items, reportedPageSize: 60 };
}

async function fetchMtopSearchAttempt(options = {}) {
  const normalized = {
    keyword: String(options.keyword || "").trim(),
    categoryId: String(options.categoryId || "").trim(),
    upstreamPage: Number(options.upstreamPage || 1),
    sort: options.sort || "default",
    priceStart: options.priceStart ?? "",
    priceEnd: options.priceEnd ?? "",
  };
  if (!normalized.keyword || !/^\d+$/.test(normalized.categoryId)) {
    throw searchError("Category search parameters were invalid", 422);
  }
  if (!Number.isSafeInteger(normalized.upstreamPage) || normalized.upstreamPage < 1) {
    throw searchError("Category search page was invalid", 422);
  }
  const deadline = Number.isFinite(options.deadline)
    ? options.deadline
    : Date.now() + SEARCH_MTOP_BUDGET_MS;
  const proxy = getPlaywrightProxy();
  let context;
  const responses = [];
  try {
    context = await awaitJob(request.newContext({
      ...(proxy ? { proxy } : {}),
      userAgent: DESKTOP_USER_AGENT,
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    }));
    const shellUrl = buildShellUrl(normalized);
    const shellResponse = await awaitJob(context.get(shellUrl.toString(), {
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: remainingTimeout(deadline),
    }));
    responses.push(shellResponse);
    assertResponse(
      shellResponse,
      "s.1688.com",
      "/selloffer/offer_search.htm",
      "Category search bootstrap"
    );
    const shell = (await bodyWithin(
      shellResponse,
      MAX_SHELL_BYTES,
      deadline,
      "Category search bootstrap"
    )).toString("utf8");
    const pageId =
      shell.match(/["']pageId["']\s*:\s*["']([^"']{10,200})["']/)?.[1] ||
      randomBytes(24).toString("base64url");
    const data = buildSearchRequest(normalized, pageId);
    const headers = { Origin: "https://s.1688.com", Referer: shellUrl.toString() };

    const tokenResponse = await awaitJob(context.get(ENDPOINT, {
      params: signedParams(data),
      headers,
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: remainingTimeout(deadline),
    }));
    responses.push(tokenResponse);
    assertResponse(
      tokenResponse,
      "h5api.m.1688.com",
      "/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0",
      "Category search token"
    );
    await bodyWithin(tokenResponse, MAX_RESPONSE_BYTES, deadline, "Category search token");
    const state = await awaitJob(context.storageState());
    const tokenCookie = (state.cookies || []).find((cookie) =>
      cookie.name === "_m_h5_tk" && /(?:^|\.)1688\.com$/i.test(cookie.domain || "")
    );
    const token = String(tokenCookie?.value || "").split("_")[0];
    if (!/^[a-z0-9]{16,128}$/i.test(token)) {
      throw searchError("Category search token handshake failed");
    }

    const resultResponse = await awaitJob(context.get(ENDPOINT, {
      params: signedParams(data, token),
      headers,
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: remainingTimeout(deadline),
    }));
    responses.push(resultResponse);
    assertResponse(
      resultResponse,
      "h5api.m.1688.com",
      "/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0",
      "Category search"
    );
    const raw = await bodyWithin(
      resultResponse,
      MAX_RESPONSE_BYTES,
      deadline,
      "Category search"
    );
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw searchError("Category search returned malformed JSON");
    }
    return mapMtopSearchPayload(payload);
  } catch (error) {
    const signal = currentJobSignal();
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    if (error?.mtopSearchFallback) throw error;
    // Do not propagate Playwright errors: signed URLs contain token material.
    throw searchError("Category search request failed");
  } finally {
    await Promise.allSettled(responses.map((response) => response.dispose()));
    await context?.dispose().catch(() => {});
  }
}

export async function fetchMtopSearchPage(options = {}) {
  const deadline = Number.isFinite(options.deadline)
    ? options.deadline
    : Date.now() + SEARCH_MTOP_BUDGET_MS;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetchMtopSearchAttempt({ ...options, deadline });
    } catch (error) {
      const signal = currentJobSignal();
      if (signal?.aborted || error?.cancelled || error?.code === 499) {
        throw jobAbortError(signal);
      }
      lastError = error;
      if (error?.code === 422 || error?.code === 429 || deadline - Date.now() < 500) {
        break;
      }
    }
  }
  throw lastError || searchError("Category search request failed");
}
