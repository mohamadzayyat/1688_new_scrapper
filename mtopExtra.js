import { request } from "playwright";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import { scrapeOfferMtop, signMtopDetail } from "./mtopDetail.js";
import { getPlaywrightProxy } from "./proxy.js";
import {
  markIfTranslationIncomplete,
  normalizeLang,
  translateTexts,
} from "./translate.js";
import { tmapiError, tmapiOk, toTmapiSearch } from "./tmapiExtra.js";

const APP_KEY = "12574478";
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";
const REVIEW_LIST_API =
  "mtop.1688.trade.service.MtopRateService.queryItemRatedListV2";
const REVIEW_SUMMARY_API =
  "mtop.1688.trade.service.MtopRateService.queryDsrRateDataV2";
const FREIGHT_API = "mtop.1688.freightInfoService.getFreightInfoWithScene";
const IMAGE_SEARCH_API = "mtop.relationrecommend.WirelessRecommend.recommend";
const MAX_RESPONSE_BYTES = 4_000_000;
// Live list behavior uses 10-row batches at upstream indexes 1, 3, 5, ... .
// Even indexes expose only the overlapping tail of the preceding batch.
const REVIEW_BATCH_SIZE = 10;
const REVIEW_PAGE_STEP = 2;
const CACHE_TTL_MS = Math.max(
  30_000,
  Math.min(10 * 60_000, Number(process.env.MOBILE_EXTRA_META_TTL_MS) || 5 * 60_000)
);
const EXTRA_BUDGET_MS = Math.max(
  8_000,
  Math.min(30_000, Number(process.env.MOBILE_EXTRA_BUDGET_MS) || 30_000)
);
const FREIGHT_BREAKER_MS = Math.max(
  15_000,
  Math.min(
    5 * 60_000,
    Number(process.env.MOBILE_FREIGHT_BREAKER_MS) || 60_000
  )
);

const rawOfferCache = new Map();
const reviewBatchCache = new Map();
const reviewSummaryCache = new Map();
const imageRawPageCache = new Map();
let freightValidationBlockedUntil = 0;

const PROVINCES = [
  ["110000", "北京", "beijing|peking"],
  ["120000", "天津", "tianjin"],
  ["130000", "河北", "hebei"],
  ["140000", "山西", "shanxi"],
  ["150000", "内蒙古", "inner mongolia|neimenggu"],
  ["210000", "辽宁", "liaoning"],
  ["220000", "吉林", "jilin"],
  ["230000", "黑龙江", "heilongjiang"],
  ["310000", "上海", "shanghai"],
  ["320000", "江苏", "jiangsu"],
  ["330000", "浙江", "zhejiang"],
  ["340000", "安徽", "anhui"],
  ["350000", "福建", "fujian"],
  ["360000", "江西", "jiangxi"],
  ["370000", "山东", "shandong"],
  ["410000", "河南", "henan"],
  ["420000", "湖北", "hubei"],
  ["430000", "湖南", "hunan"],
  ["440000", "广东", "guangdong|canton"],
  ["450000", "广西", "guangxi"],
  ["460000", "海南", "hainan"],
  ["500000", "重庆", "chongqing"],
  ["510000", "四川", "sichuan|szechuan"],
  ["520000", "贵州", "guizhou"],
  ["530000", "云南", "yunnan"],
  ["540000", "西藏", "tibet|xizang"],
  ["610000", "陕西", "shaanxi"],
  ["620000", "甘肃", "gansu"],
  ["630000", "青海", "qinghai"],
  ["640000", "宁夏", "ningxia"],
  ["650000", "新疆", "xinjiang"],
  ["710000", "台湾", "taiwan"],
  ["810000", "香港", "hong kong|hongkong"],
  ["820000", "澳门", "macao|macau"],
].map(([code, name, aliases]) => ({
  code,
  name,
  aliases: [name, ...aliases.split("|")],
}));

function extraError(message, code = 502) {
  const error = new Error(message);
  error.name = "MtopExtraError";
  error.tmapiCode = code;
  error.safe = true;
  return error;
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function booleanValue(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeRegionText(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^送至[：:]?/, "")
    .replace(
      /special administrative region|autonomous region|municipality|province|省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区/g,
      ""
    )
    .replace(/[^a-z\u4e00-\u9fff\d]/g, "");
}

export function provinceIdentity(value) {
  const raw = cleanText(value);
  const codeMatch = raw.match(/(?:^|\D)(\d{6})(?:\D|$)/);
  if (codeMatch) {
    const byCode = PROVINCES.find((entry) => entry.code === codeMatch[1]);
    if (byCode) return { code: byCode.code, name: byCode.name };
  }
  const normalized = normalizeRegionText(raw);
  if (!normalized) return null;
  for (const entry of PROVINCES) {
    if (
      entry.aliases.some((alias) => {
        const normalizedAlias = normalizeRegionText(alias);
        return (
          normalized === normalizedAlias ||
          normalized.startsWith(normalizedAlias) ||
          normalized.endsWith(normalizedAlias)
        );
      })
    ) {
      return { code: entry.code, name: entry.name };
    }
  }
  return null;
}

function normalizePublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function requestTimeout(deadline, capMs = 12_000) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 250) throw extraError("1688 mobile service deadline exceeded", 504);
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

async function awaitWithin(promise, deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 1) throw extraError("1688 mobile service deadline exceeded", 504);
  let timer;
  try {
    return await awaitJob(
      Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(extraError("1688 mobile service deadline exceeded", 504)),
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

function endpointFor(api, version) {
  if (!/^[a-z0-9.]+$/i.test(api) || !/^\d+(?:\.\d+)?$/.test(version)) {
    throw extraError("1688 mobile service configuration was invalid");
  }
  return `https://h5api.m.1688.com/h5/${api.toLowerCase()}/${version}/`;
}

function responseUrlMatches(value, api, version) {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "h5api.m.1688.com" &&
      url.pathname.replace(/\/+$/, "") ===
        `/h5/${api.toLowerCase()}/${version}`
    );
  } catch {
    return false;
  }
}

function signedParams(api, version, data, token) {
  const serialized = JSON.stringify(data);
  const timestamp = String(Date.now());
  return {
    appKey: APP_KEY,
    t: timestamp,
    sign: signMtopDetail(token, timestamp, serialized),
    api,
    v: version,
    type: "json",
    dataType: "json",
    isSec: "0",
    ecode: "0",
    timeout: "20000",
    data: serialized,
  };
}

async function readJson(response, api, version, deadline) {
  const status = response.status();
  if (status < 200 || status >= 300) {
    throw extraError("1688 mobile service returned an HTTP error", status === 429 ? 429 : 502);
  }
  if (!responseUrlMatches(response.url(), api, version)) {
    throw extraError("1688 mobile service redirected unexpectedly");
  }
  const declaredLength = Number(response.headers()["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw extraError("1688 mobile service response was too large");
  }

  let body;
  try {
    body = await awaitWithin(response.body(), deadline);
  } catch (error) {
    const signal = currentJobSignal();
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    if (error?.safe) throw error;
    // Playwright errors can contain the complete signed URL and cookies.
    throw extraError("1688 mobile service response could not be read");
  }
  if (body.length > MAX_RESPONSE_BYTES) {
    throw extraError("1688 mobile service response was too large");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw extraError("1688 mobile service returned malformed JSON");
  }
}

async function requestMtop(
  context,
  api,
  version,
  data,
  token,
  deadline,
  { method = "GET" } = {}
) {
  let response;
  try {
    const signed = signedParams(api, version, data, token);
    const { data: serializedData, ...signedQuery } = signed;
    const requestOptions = {
      params: method === "POST" ? signedQuery : signed,
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: requestTimeout(deadline),
      headers: {
        Origin: "https://m.1688.com",
        Referer: "https://m.1688.com/",
      },
      ...(method === "POST" ? { form: { data: serializedData } } : {}),
    };
    response = await awaitJob(
      method === "POST"
        ? context.post(endpointFor(api, version), requestOptions)
        : context.get(endpointFor(api, version), requestOptions)
    );
    return await readJson(response, api, version, deadline);
  } catch (error) {
    const signal = currentJobSignal();
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    if (error?.safe) throw error;
    throw extraError("1688 mobile service request failed");
  } finally {
    await response?.dispose().catch(() => {});
  }
}

async function mtopToken(context, api, version, data, deadline, method) {
  await requestMtop(context, api, version, data, "", deadline, { method });
  const readToken = async () => {
    let state;
    try {
      state = await awaitWithin(context.storageState(), deadline);
    } catch (error) {
      const signal = currentJobSignal();
      if (signal?.aborted || error?.cancelled || error?.code === 499) {
        throw jobAbortError(signal);
      }
      throw extraError("1688 mobile service token was unavailable");
    }
    const tokenCookie = asArray(state?.cookies).find((cookie) => {
      const domain = String(cookie?.domain || "")
        .replace(/^\./, "")
        .toLowerCase();
      return (
        cookie?.name === "_m_h5_tk" &&
        (domain === "1688.com" || domain.endsWith(".1688.com"))
      );
    });
    return String(tokenCookie?.value || "").split("_")[0];
  };

  let token = await readToken();
  if (!/^[a-z0-9]{16,128}$/i.test(token) && api !== IMAGE_SEARCH_API) {
    // A few MTop methods do not issue the H5 token on their own unsigned
    // request. Bootstrap it from the proven anonymous image-service host; the
    // token cookie is shared by the exact same 1688 MTop origin.
    await requestMtop(
      context,
      IMAGE_SEARCH_API,
      "2.0",
      { appId: "32517", params: "{}" },
      "",
      deadline
    );
    token = await readToken();
  }
  if (!/^[a-z0-9]{16,128}$/i.test(token)) {
    throw extraError("1688 mobile service token handshake failed");
  }
  return token;
}

function isMtopSuccess(payload) {
  return asArray(payload?.ret).some((value) =>
    /^SUCCESS(?:::|$)/i.test(String(value))
  );
}

async function withMtopSession(deadline, callback) {
  const signal = currentJobSignal();
  if (signal?.aborted) throw jobAbortError(signal);
  const proxy = getPlaywrightProxy();
  let context;
  let onAbort;
  try {
    context = await awaitWithin(
      request.newContext({
        ...(proxy ? { proxy } : {}),
        userAgent: MOBILE_USER_AGENT,
        extraHTTPHeaders: {
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      }),
      deadline
    );
    if (signal) {
      onAbort = () => void context.dispose().catch(() => {});
      signal.addEventListener("abort", onAbort, { once: true });
    }

    let tokenPromise = null;
    const call = async (api, version, data, { method = "GET" } = {}) => {
      tokenPromise ??= mtopToken(
        context,
        api,
        version,
        data,
        deadline,
        method
      );
      const token = await tokenPromise;
      const payload = await requestMtop(
        context,
        api,
        version,
        data,
        token,
        deadline,
        { method }
      );
      if (!isMtopSuccess(payload)) {
        const retCodes = asArray(payload?.ret).map((value) =>
          String(value).split("::")[0]
        );
        if (
          retCodes.some((code) =>
            /^(?:FAIL_SYS_USER_VALIDATE|RGV587(?:_ERROR)?)$/i.test(code)
          )
        ) {
          const error = extraError(
            "1688 mobile service requires upstream verification"
          );
          error.upstreamValidation = true;
          throw error;
        }
        throw extraError("1688 mobile service was temporarily unavailable");
      }
      return payload;
    };

    return await callback(call);
  } catch (error) {
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    if (error?.safe) throw error;
    throw extraError("1688 mobile service request failed");
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    await context?.dispose().catch(() => {});
  }
}

async function callMtop(api, version, data, { deadline, attempts = 1 } = {}) {
  const operationDeadline = Number.isFinite(deadline)
    ? deadline
    : Date.now() + EXTRA_BUDGET_MS;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withMtopSession(operationDeadline, (call) =>
        call(api, version, data)
      );
    } catch (error) {
      const signal = currentJobSignal();
      if (signal?.aborted || error?.cancelled || error?.code === 499) {
        throw jobAbortError(signal);
      }
      lastError = error?.safe
        ? error
        : extraError("1688 mobile service request failed");
      if (Date.now() >= operationDeadline) break;
    }
  }

  throw lastError || extraError("1688 mobile service request failed");
}

function pruneCache(cache) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (!entry || entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > 128) cache.delete(cache.keys().next().value);
}

async function mobileRaw(offerId, deadline) {
  pruneCache(rawOfferCache);
  const cached = rawOfferCache.get(offerId);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const value = await scrapeOfferMtop(offerId, { deadline });
  rawOfferCache.set(offerId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function reviewTotal(summary) {
  const model = summary?.data?.model;
  if (!isObject(model)) return null;
  for (const tag of asArray(model.commonTagNodeList)) {
    if (String(tag?.name || "").split("#")[0] === "全部") {
      const count = finiteNumber(tag?.count);
      if (count != null && count >= 0) return count;
    }
  }
  return null;
}

function reviewImageUrls(row) {
  const candidates = [
    ...asArray(row?.images),
    ...asArray(row?.imageList),
    ...asArray(row?.pics),
    ...asArray(row?.attachments),
  ];
  return [...new Set(
    candidates
      .map((value) =>
        normalizePublicUrl(
          isObject(value)
            ? value.url || value.imageUrl || value.fullPathImageURI || value.src
            : value
        )
      )
      .filter(Boolean)
  )];
}

export function mapMtopReview(row, offerId) {
  const rating = Math.max(0, Math.min(5, finiteNumber(row?.starLevel) ?? 0));
  const user = cleanText(row?.raterUserNick || row?.userNick || row?.buyerName);
  const date = cleanText(row?.gmtPublished || row?.gmtCreate || row?.date);
  return {
    review_id: cleanText(row?.id),
    id: cleanText(row?.id),
    item_id: String(row?.itemId || offerId),
    content: cleanText(row?.content),
    images: reviewImageUrls(row),
    feedback_date: date,
    date,
    time: date,
    rate_star: rating,
    rating,
    user_nick: user,
    user_name: user,
    buyer_name: user,
    user_level: cleanText(row?.raterLevel) || null,
    quantity: finiteNumber(row?.quantity),
    unit: String(row?.unit) === "null" ? null : cleanText(row?.unit) || null,
    sku_info: cleanText(row?.specInfo)
      .replace(/#3B/gi, "=")
      .replace(/#3A/gi, "; "),
    location: cleanText(row?.feedBackAddress) || null,
    is_system_review: booleanValue(row?.isSystemRemark ?? row?.systemRemark),
  };
}

async function reviewPage(call, offerId, loginId, upstreamPage) {
  const payload = await call(
    REVIEW_LIST_API,
    "1.0",
    {
      orderFieldForMtop: null,
      page: upstreamPage,
      scene: "item",
      itemId: offerId,
      loginId,
      site: null,
    }
  );
  const model = payload?.data?.model;
  if (model == null) return [];
  if (!Array.isArray(model)) {
    throw extraError("1688 mobile review response was invalid");
  }
  return model;
}

async function cachedReviewSummary(call, offerId, loginId) {
  pruneCache(reviewSummaryCache);
  const cacheKey = `${offerId}:${loginId}`;
  const cached = reviewSummaryCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const payload = await call(
    REVIEW_SUMMARY_API,
    "1.0",
    { loginId, scene: "item", offerId, site: null }
  );
  const value = reviewTotal(payload);
  if (value != null) {
    reviewSummaryCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }
  return value;
}

async function cachedReviewBatch(
  offerId,
  loginId,
  upstreamPage,
  deadline,
  { includeSummary = false } = {}
) {
  pruneCache(reviewBatchCache);
  pruneCache(reviewSummaryCache);
  const batchKey = `${offerId}:${loginId}:${upstreamPage}`;
  const summaryKey = `${offerId}:${loginId}`;
  const cachedBatch = reviewBatchCache.get(batchKey);
  const cachedSummary = reviewSummaryCache.get(summaryKey);
  if (
    cachedBatch?.expiresAt > Date.now() &&
    (!includeSummary || cachedSummary?.expiresAt > Date.now())
  ) {
    return {
      rows: cachedBatch.value,
      total: includeSummary ? cachedSummary.value : null,
    };
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await withMtopSession(deadline, async (call) => {
        const rows =
          cachedBatch?.expiresAt > Date.now()
            ? cachedBatch.value
            : await reviewPage(call, offerId, loginId, upstreamPage);
        const total = includeSummary
          ? await cachedReviewSummary(call, offerId, loginId).catch(() => null)
          : cachedSummary?.expiresAt > Date.now()
            ? cachedSummary.value
            : null;
        // A successful MTop envelope can still contain an empty model during
        // transient upstream throttling. Never cache that as a real page while
        // the review total says rows should exist.
        if (!rows.length && total !== 0) {
          throw extraError("1688 mobile review batch was temporarily empty");
        }
        reviewBatchCache.set(batchKey, {
          value: rows,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return { rows, total: includeSummary ? total : null };
      });
    } catch (error) {
      const signal = currentJobSignal();
      if (signal?.aborted || error?.cancelled || error?.code === 499) {
        throw jobAbortError(signal);
      }
      lastError = error;
      if (attempt >= 2 || deadline - Date.now() < 1_500) break;
    }
  }
  throw lastError || extraError("1688 mobile review batch was unavailable");
}

export function reviewBatchPlan(page, pageSize) {
  const pageNo = Math.max(1, Number(page) || 1);
  const size = Math.min(20, Math.max(1, Number(pageSize) || 20));
  const offset = (pageNo - 1) * size;
  const firstBatchIndex = Math.floor(offset / REVIEW_BATCH_SIZE);
  const withinBatch = offset % REVIEW_BATCH_SIZE;
  const requiredBatches = Math.ceil(
    (withinBatch + size) / REVIEW_BATCH_SIZE
  );
  return {
    offset,
    withinBatch,
    upstreamIndexes: Array.from(
      { length: requiredBatches },
      (_, index) => 1 + (firstBatchIndex + index) * REVIEW_PAGE_STEP
    ),
  };
}

export async function getItemReviewsMtop(
  itemId,
  { page = 1, page_size = 20 } = {}
) {
  const offerId = String(itemId || "").trim();
  if (!/^\d+$/.test(offerId)) return tmapiError(422, "item_id must be a number");
  const pageNo = Math.max(1, Number(page) || 1);
  // Combine the upstream 10-row batches to preserve this endpoint's public
  // page_size contract (up to twenty).
  const size = Math.min(20, Math.max(1, Number(page_size) || 20));
  const deadline = Date.now() + EXTRA_BUDGET_MS;

  try {
    const raw = await mobileRaw(offerId, deadline);
    const loginId = cleanText(
      raw?.seller?.frontSellerLoginId || raw?.tempModel?.sellerLoginId
    );
    if (!loginId) throw extraError("1688 mobile offer omitted its seller identity");

    const { offset, withinBatch, upstreamIndexes } = reviewBatchPlan(
      pageNo,
      size
    );
    // Live testing showed that a second list request in the same token context
    // can return an empty model. Use isolated token contexts for list batches,
    // while piggybacking the summary on the first batch's context.
    const batches = [];
    // Isolated contexts are intentionally sequential. Parallel token
    // handshakes made the anonymous review service return RGV/SYSTEM_ERROR
    // under the same settled proxy even though each request works alone.
    for (const [index, upstreamPage] of upstreamIndexes.entries()) {
      batches.push(
        await cachedReviewBatch(offerId, loginId, upstreamPage, deadline, {
          includeSummary: index === 0,
        })
      );
    }
    const totalFromSummary = batches[0]?.total ?? null;
    const nativeRows = batches.flatMap((batch) => batch.rows);
    const selected = nativeRows.slice(withinBatch, withinBatch + size);
    const rows = selected.map((row) => mapMtopReview(row, offerId));
    const expectedRows =
      totalFromSummary == null
        ? size
        : Math.min(size, Math.max(0, totalFromSummary - offset));
    if (rows.length < expectedRows) {
      throw extraError("1688 mobile review pagination returned an incomplete page");
    }
    const lowerBound = offset + rows.length + (rows.length === size ? 1 : 0);
    const total = Math.max(totalFromSummary ?? 0, lowerBound);

    return tmapiOk({
      item_id: Number(offerId),
      page: pageNo,
      current_page: pageNo,
      page_size: size,
      total,
      total_count: total,
      has_next_page: offset + rows.length < total,
      items: rows,
      list: rows,
      reviews: rows,
    });
  } catch (error) {
    const signal = currentJobSignal();
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    return tmapiError(
      error?.tmapiCode || 502,
      error?.safe ? error.message : "1688 mobile reviews are temporarily unavailable"
    );
  }
}

function freightModel(payload) {
  const queue = [{ value: payload?.data, depth: 0 }];
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < 500) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (isObject(value)) {
      const explicitFee =
        finiteNumber(value.totalCost) ?? finiteNumber(value.postFeeValue);
      const explicitlyFree = booleanValue(
        value.freeDeliverFee ?? value.postFree ?? value.freePostageArea
      );
      if (explicitFee != null || explicitlyFree) {
        return {
          totalCost: explicitlyFree ? 0 : Math.max(0, explicitFee),
          postFree: explicitlyFree,
        };
      }
    }
    if (depth >= 6) continue;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return null;
}

async function destinationFreightQuote(
  call,
  offerId,
  raw,
  destination,
  quantity
) {
  const shipping = raw?.shipping;
  const sendAddressCode = cleanText(shipping?.sendAddressCode);
  const templateId = shipping?.templateId;
  const sellerUserId = finiteNumber(
    shipping?.sellerUserId ??
      raw?.seller?.frontSellerUserId ??
      raw?.tempModel?.sellerUserId
  );
  if (!sendAddressCode || templateId == null || sellerUserId == null) {
    throw extraError(
      "1688 mobile offer omitted fields required for a destination quote"
    );
  }
  const payload = await call(
    FREIGHT_API,
    "1.0",
    {
      offerId,
      sellerUserId,
      sendAddressCode,
      receiveAddressCode: destination.code,
      freeEndAmount: finiteNumber(shipping.freeEndAmount) ?? -1,
      pageScene: cleanText(shipping.pageScene) || "dsc",
      skuCalParams: JSON.stringify([]),
      extendMap: JSON.stringify({
        officialLogistics: booleanValue(shipping.officialLogistics),
        unitWeight: finiteNumber(shipping.unitWeight) ?? 0,
        templateId,
        amount: Math.max(1, quantity),
        skuWeight: JSON.stringify(
          isObject(shipping.skuWeight) ? shipping.skuWeight : {}
        ),
      }),
    },
    { method: "POST" }
  );
  const quote = freightModel(payload);
  if (!quote || !Number.isFinite(quote.totalCost)) {
    throw extraError("1688 did not return a numeric destination freight quote");
  }
  return quote;
}

function representativeWeight(shipping) {
  const direct = positiveNumber(shipping?.unitWeight);
  if (direct != null) return direct;
  const weights = Object.values(isObject(shipping?.skuWeight) ? shipping.skuWeight : {})
    .map(positiveNumber)
    .filter((value) => value != null);
  return weights.length ? Math.min(...weights) : 0;
}

export function mapMobileFreightResponse(
  offerId,
  raw,
  { province = "", total_quantity = 1, total_weight = 0 } = {}
) {
  const requestedProvince = cleanText(province);
  const requestedDestination = requestedProvince
    ? provinceIdentity(requestedProvince)
    : null;
  if (requestedProvince && !requestedDestination) {
    throw extraError("province must identify a supported Chinese province", 422);
  }
  const weightInput = finiteNumber(total_weight);
  if (total_weight !== "" && total_weight != null && weightInput == null) {
    throw extraError("total_weight must be a non-negative number", 422);
  }
  if ((weightInput ?? 0) < 0) {
    throw extraError("total_weight must be a non-negative number", 422);
  }
  if ((weightInput ?? 0) > 0) {
    throw extraError(
      "Custom-weight freight quotes are unavailable from the anonymous 1688 offer endpoint",
      422
    );
  }

  const shipping = raw?.shipping;
  if (!isObject(shipping)) {
    throw extraError("1688 mobile offer omitted shipping data");
  }
  const upstreamTargetText = cleanText(shipping.targetLocation);
  const upstreamDestination = provinceIdentity(upstreamTargetText);
  if (requestedDestination && !upstreamDestination) {
    throw extraError(
      "1688 did not expose a concrete destination for this freight quote"
    );
  }
  if (
    requestedDestination &&
    upstreamDestination?.code !== requestedDestination.code
  ) {
    throw extraError(
      "Requested province does not match the 1688 freight-quote destination",
      422
    );
  }
  const postFree = booleanValue(shipping.postFree);
  const fee = Math.max(
    0,
    finiteNumber(shipping.totalCost) ??
      finiteNumber(shipping.postFeeValue) ??
      finiteNumber(shipping.freightInfo?.totalCost) ??
      (postFree ? 0 : NaN)
  );
  if (!Number.isFinite(fee)) {
    throw extraError("1688 mobile offer omitted its shipping fee");
  }
  const quantity = Math.max(1, Math.floor(Number(total_quantity) || 1));
  const unitWeight = representativeWeight(shipping);
  const calculatedWeight = unitWeight > 0 ? unitWeight * quantity : null;
  const unit = cleanText(shipping.unit || raw?.tempModel?.offerUnit) || "件";
  const quotedQuantity =
    positiveNumber(shipping.quoteQuantity) ?? positiveNumber(shipping.amount);
  const shipTo = upstreamTargetText;
  const quoteScope = cleanText(shipping.quoteScope) || "offer_default";
  const quoteSource = cleanText(shipping.quoteSource) || "1688_mobile_offer";
  const destinationSpecific =
    shipping.destinationSpecific == null
      ? Boolean(upstreamDestination)
      : booleanValue(shipping.destinationSpecific);
  const quantitySpecific = booleanValue(shipping.quantitySpecific);
  if (
    !quantitySpecific &&
    quotedQuantity != null &&
    quotedQuantity !== quantity
  ) {
    throw extraError(
      "1688's anonymous freight quote does not match the requested quantity"
    );
  }

  return tmapiOk({
    item_id: Number(offerId),
    total_fee: fee,
    shipping_fee: fee,
    freight: fee,
    shipping_to: shipTo || null,
    ship_to: shipTo || null,
    total_quantity: quantity,
    total_weight: calculatedWeight,
    unit,
    first_unit: quotedQuantity,
    first_unit_fee: quotedQuantity != null ? fee : null,
    next_unit: null,
    next_unit_fee: null,
    freight_text: shipping.deliveryLimitText || shipping.logistics || null,
    logistics_text: shipping.deliveryLimitText || shipping.logistics || null,
    location_from: shipping.location || null,
    unit_weight: unitWeight,
    delivery_limit: shipping.deliveryLimit ?? null,
    buyer_protections: [],
    quote_scope: quoteScope,
    quote_source: quoteSource,
    quote_quantity: quotedQuantity,
    quote_matches_requested_quantity:
      quantitySpecific
        ? true
        : quotedQuantity == null
          ? null
          : quotedQuantity === quantity,
    quote_destination: shipTo || null,
    destination_specific: destinationSpecific,
    quantity_specific: quantitySpecific,
    fee_scaled_for_quantity: false,
    shipping_raw: {
      postFree,
      templateId: shipping.templateId ?? null,
      sendAddressCode: shipping.sendAddressCode ?? null,
      location: shipping.location || null,
      targetLocation: shipTo || null,
    },
  });
}

export async function getItemFreightMtop(itemId, options = {}) {
  const offerId = String(itemId || "").trim();
  if (!/^\d+$/.test(offerId)) return tmapiError(422, "item_id must be a number");
  const deadline = Date.now() + EXTRA_BUDGET_MS;
  try {
    const raw = await mobileRaw(offerId, deadline);
    const requestedProvince = cleanText(options.province);
    const requestedDestination = requestedProvince
      ? provinceIdentity(requestedProvince)
      : null;
    if (requestedProvince && !requestedDestination) {
      throw extraError("province must identify a supported Chinese province", 422);
    }
    const upstreamDestination = provinceIdentity(raw?.shipping?.targetLocation);
    let effectiveRaw = raw;
    if (requestedDestination && !upstreamDestination) {
      const quantity = Math.max(
        1,
        Math.floor(Number(options.total_quantity) || 1)
      );
      const quote = await withMtopSession(deadline, (call) =>
        destinationFreightQuote(
          call,
          offerId,
          raw,
          requestedDestination,
          quantity
        )
      );
      effectiveRaw = {
        ...raw,
        shipping: {
          ...raw.shipping,
          totalCost: quote.totalCost,
          postFeeValue: quote.totalCost,
          postFree: quote.postFree,
          targetLocation: requestedDestination.name,
          quoteScope: "destination_quantity",
          quoteSource: "1688_freight_service",
          quoteQuantity: quantity,
          destinationSpecific: true,
          quantitySpecific: true,
        },
      };
    }
    return mapMobileFreightResponse(offerId, effectiveRaw, options);
  } catch (error) {
    const signal = currentJobSignal();
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    return tmapiError(
      error?.tmapiCode || 502,
      error?.safe ? error.message : "1688 mobile shipping is temporarily unavailable"
    );
  }
}

export function imageSortParams(sortValue) {
  const sort = String(sortValue || "default")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (["sales", "sales_desc", "booked"].includes(sort)) {
    return { sortField: "total_sales_volume", sortType: "desc" };
  }
  if (["price_up", "priceup", "price_asc"].includes(sort)) {
    return { sortField: "price", sortType: "asc" };
  }
  if (["price_down", "pricedown", "price_desc"].includes(sort)) {
    return { sortField: "price", sortType: "desc" };
  }
  return { sortField: "", sortType: "" };
}

export function buildImageSearchData(imageUrl, page, pageSize, sort) {
  return {
    appId: "32517",
    params: JSON.stringify({
      categoryId: -1,
      imageAddress: imageUrl,
      interfaceName: "imageOfferSearchService",
      needYolocrop: false,
      pageIndex: String(page),
      pageSize: String(pageSize),
      searchScene: "image",
      snAppAb: true,
      appName: "ios",
      scene: "wap",
      ...imageSortParams(sort),
    }),
  };
}

function textArray(...values) {
  const out = [];
  for (const value of values.flat(Infinity)) {
    if (typeof value === "string") {
      for (const part of value.split(",")) {
        const text = cleanText(part);
        if (text) out.push(text);
      }
    } else if (isObject(value)) {
      const text = cleanText(value.text || value.name || value.label);
      if (text) out.push(text);
    }
  }
  return [...new Set(out)].slice(0, 12);
}

export function mapImageOffer(row) {
  const offerId = cleanText(row?.id || row?.offerId || row?.subOfferId);
  const price =
    positiveNumber(row?.priceInfo?.price) ??
    positiveNumber(row?.price) ??
    positiveNumber(row?.offerPrice) ??
    positiveNumber(row?.priceRmdarklh) ??
    positiveNumber(row?.skuPrice) ??
    positiveNumber(row?.priceConsign);
  const image = normalizePublicUrl(row?.odPicUrl || row?.offerPicUrl);
  const location = [cleanText(row?.province), cleanText(row?.city)]
    .filter((value, index, all) => value && all.indexOf(value) === index)
    .join(" ");
  const docType = cleanText(row?.docType || row?.type).toLowerCase();
  return {
    offerId,
    title: cleanText(row?.subject || row?.simpleSubject),
    price: price != null ? String(price) : null,
    image,
    company: cleanText(row?.companyName),
    sales: cleanText(
      row?.saleQuantityDescription ||
        row?.sales30Fuzzify ||
        row?.bookedCount ||
        row?.saleQuantity ||
        row?.sales90
    ) || null,
    location: location || null,
    member_id: cleanText(row?.memberId),
    login_id: cleanText(row?.loginId),
    userid: cleanText(row?.userid),
    repurchaseRate: row?.offerRepurchaseRate ?? row?.shopRepurchaseRate ?? null,
    goods_score: row?.goodsScore ?? null,
    quantity_begin: row?.quantityBegin ?? row?.complexQuantityBegin ?? null,
    quantity_prices: asArray(row?.quantityPrices),
    weight: row?.offerWeight ?? row?.logisticWeight ?? null,
    free_postage: booleanValue(row?.freePostage),
    tags: textArray(
      row?.buyerProtections,
      row?.pureServiceTags,
      row?.serviceTags,
      row?.purePromotionTags
    ),
    isAd:
      /(?:ad|p4p|bid)/i.test(docType) ||
      String(row?.chargeType || "") === "1" ||
      /_p_isad[=@]1/i.test(String(row?.trackInfoModel?.swExposeInfo || "")),
  };
}

function usableImageOffer(item) {
  return (
    /^\d+$/.test(item.offerId) &&
    Boolean(item.title) &&
    Boolean(item.image) &&
    positiveNumber(item.price) != null
  );
}

export function uniqueImageOffers(rawPages) {
  const seen = new Set();
  const items = [];
  for (const raw of asArray(rawPages).flatMap((page) => asArray(page))) {
    const item = mapImageOffer(raw);
    if (!usableImageOffer(item) || seen.has(item.offerId)) continue;
    seen.add(item.offerId);
    items.push(item);
  }
  return items;
}

async function cachedImageRawPage(
  imageUrl,
  upstreamPage,
  size,
  sort,
  deadline
) {
  pruneCache(imageRawPageCache);
  const sortKey = JSON.stringify(imageSortParams(sort));
  const cacheKey = `${imageUrl}|${size}|${sortKey}|${upstreamPage}`;
  const cached = imageRawPageCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const payload = await callMtop(
    IMAGE_SEARCH_API,
    "2.0",
    buildImageSearchData(imageUrl, upstreamPage, size, sort),
    { deadline, attempts: 2 }
  );
  const source = payload?.data?.offerList?.offers;
  if (!Array.isArray(source)) {
    throw extraError("1688 image-search response was invalid");
  }
  imageRawPageCache.set(cacheKey, {
    value: source,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return source;
}

function sortMappedOffers(items, sortValue) {
  const { sortField, sortType } = imageSortParams(sortValue);
  if (!sortField) return items;
  const copy = [...items];
  if (sortField === "price") {
    copy.sort((left, right) => {
      const a = positiveNumber(left.price) ?? Number.POSITIVE_INFINITY;
      const b = positiveNumber(right.price) ?? Number.POSITIVE_INFINITY;
      return sortType === "asc" ? a - b : b - a;
    });
  }
  return copy;
}

export async function searchByImageMtop({
  img_url,
  page = 1,
  page_size = 20,
  language = "zh",
  sort = "default",
} = {}) {
  const imageUrl = normalizePublicUrl(img_url);
  if (!imageUrl) return tmapiError(422, "img_url must be an absolute http(s) URL");
  const pageNo = Math.max(1, Math.floor(Number(page) || 1));
  if (pageNo > 10) return tmapiError(422, "page must be between 1 and 10");
  const size = Math.min(20, Math.max(1, Number(page_size) || 20));
  const lang = normalizeLang(language);
  const deadline = Date.now() + EXTRA_BUDGET_MS;

  try {
    const offset = (pageNo - 1) * size;
    const rawPages = await Promise.all(
      Array.from({ length: pageNo }, (_, index) =>
        cachedImageRawPage(imageUrl, index + 1, size, sort, deadline)
      )
    );
    let lastSource = rawPages.at(-1) || [];
    let terminal = lastSource.length < size;
    let unique = uniqueImageOffers(rawPages);
    let upstreamPage = pageNo;
    let refillPages = 0;
    // 1688 occasionally repeats an offer at a raw page boundary. Build a
    // globally unique stream and refill the requested public page, bounded by
    // three additional upstream pages and the shared deadline.
    while (
      unique.length < offset + size &&
      !terminal &&
      refillPages < 3
    ) {
      upstreamPage += 1;
      lastSource = await cachedImageRawPage(
        imageUrl,
        upstreamPage,
        size,
        sort,
        deadline
      );
      rawPages.push(lastSource);
      terminal = lastSource.length < size;
      unique = uniqueImageOffers(rawPages);
      refillPages += 1;
    }
    if (unique.length < offset + size && !terminal) {
      throw extraError("1688 image search could not fill a unique result page");
    }
    let items = unique.slice(offset, offset + size);
    items = sortMappedOffers(items, sort);
    if (!items.length) return tmapiError(502, "Image search returned no products");

    let translatedTitles = null;
    if (lang === "en") {
      translatedTitles = await translateTexts(items.map((item) => item.title));
      items = items.map((item, index) => ({
        ...item,
        title: translatedTitles[index] || item.title,
      }));
    }

    const exactTotal = terminal;
    const total = exactTotal ? unique.length : unique.length + size;
    const formatted = toTmapiSearch(
      { results: items, total },
      { keyword: "[image]", page: pageNo, page_size: size, sort }
    );
    formatted.data.has_next_page = exactTotal
      ? offset + items.length < unique.length
      : true;
    formatted.data.total_is_exact = exactTotal;
    if (!exactTotal) formatted.data.estimated_total = total;
    return markIfTranslationIncomplete(formatted, translatedTitles);
  } catch (error) {
    const signal = currentJobSignal();
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    return tmapiError(
      error?.tmapiCode || 502,
      error?.safe ? error.message : "1688 image search is temporarily unavailable"
    );
  }
}
