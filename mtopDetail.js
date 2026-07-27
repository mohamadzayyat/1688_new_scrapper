import { createHash } from "node:crypto";
import { request } from "playwright";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import { parseMobileOfferInitFromHtml } from "./offerContext.js";
import { getPlaywrightProxy } from "./proxy.js";
import { mapMobileShipping } from "./mobileShipping.js";
import { toTmapiItemDetail } from "./tmapiFormat.js";

const MTOP_API = "mtop.1688.mmga.offerdetail.service";
const MTOP_VERSION = "1.0";
const MTOP_APP_KEY = "12574478";
const MTOP_ENDPOINT =
  "https://h5api.m.1688.com/h5/mtop.1688.mmga.offerdetail.service/1.0/";
const MTOP_QUERY_TIMEOUT_MS = 20_000;
const MAX_MTOP_BYTES = 1_000_000;
const MAX_MOBILE_HTML_BYTES = 2_000_000;
const DEFAULT_DETAIL_BUDGET_MS = Math.max(
  6_000,
  Math.min(20_000, Number(process.env.MTOP_DETAIL_BUDGET_MS) || 14_000)
);
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";

function fallbackError(message, code = 502) {
  const error = new Error(message);
  error.name = "MtopDetailError";
  error.code = code;
  error.mtopFallback = true;
  return error;
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
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
  return decodeHtml(value).replace(/\s+/g, " ").trim();
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

function normalizeHttpUrl(value) {
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

function officialDetailUrl(value, offerId) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  if (!(host === "1688.com" || host.endsWith(".1688.com"))) return null;
  const pathMatch = url.pathname.match(/\/offer\/(\d+)\.html\/?$/i)?.[1];
  const queryMatch = url.searchParams.get("offerId");
  if (pathMatch !== String(offerId) && queryMatch !== String(offerId)) return null;
  return normalized;
}

function stableNumericId(value, used) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let candidate = (hash || 1) >>> 0;
  while (used.has(String(candidate))) candidate = (candidate + 1) >>> 0 || 1;
  const id = String(candidate);
  used.add(id);
  return id;
}

function uniqueImages(values) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const url = normalizeHttpUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push(url);
  }
  return output;
}

function nestedArraysByKey(root, wantedKey, maxDepth = 7) {
  const found = [];
  const seen = new Set();
  let visited = 0;
  function visit(value, depth) {
    if (!value || typeof value !== "object" || depth > maxDepth) return;
    if (seen.has(value) || ++visited > 2_000) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === wantedKey && Array.isArray(child)) found.push(child);
      visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return found;
}

function collectMobileImages(init, mtopData) {
  const global = init.globalData;
  const values = [];
  for (const image of asArray(global.images)) {
    values.push(
      image?.fullPathImageURI,
      image?.imageUrl,
      image?.imageURI,
      typeof image === "string" ? image : null
    );
  }
  for (const list of nestedArraysByKey(init.componentData, "offerImgList")) {
    for (const image of list) {
      values.push(
        image?.fullPathImageURI,
        image?.imageUrl,
        image?.url,
        typeof image === "string" ? image : null
      );
    }
  }
  const mtopBase = mtopData.globalData.offerBaseInfo;
  values.push(
    global.tempModel?.defaultOfferImg,
    global.shareModel?.picUrl,
    mtopBase.picUrl
  );
  for (const prop of asArray(mtopData.globalData.skuModelOrigin?.skuProps)) {
    for (const value of asArray(prop?.value ?? prop?.values)) {
      values.push(value?.imageUrl);
    }
  }
  return uniqueImages(values);
}

function normalizeSkuModel(source, authoritativeTotalStock) {
  if (!isObject(source)) throw fallbackError("Mobile item detail omitted SKU data");
  const rawProps = asArray(source.skuProps);
  const rawMap = isObject(source.skuInfoMap)
    ? source.skuInfoMap
    : isObject(source.skuInfoMapOriginal)
      ? source.skuInfoMapOriginal
      : {};
  const rawRows = Object.entries(rawMap);
  if ((rawProps.length === 0) !== (rawRows.length === 0)) {
    throw fallbackError("Mobile item detail returned incomplete variants");
  }

  const propIds = new Set();
  const skuProps = rawProps.map((prop, propIndex) => {
    const name = cleanText(prop?.prop ?? prop?.prop_name);
    const rawValues = asArray(prop?.value ?? prop?.values);
    if (!name || rawValues.length === 0) {
      throw fallbackError("Mobile item detail returned incomplete variant properties");
    }
    let fid = cleanText(prop?.fid ?? prop?.pid);
    if (fid) {
      if (propIds.has(fid)) {
        throw fallbackError("Mobile item detail returned duplicate variant properties");
      }
      propIds.add(fid);
    } else {
      fid = stableNumericId(`property:${propIndex}:${name}`, propIds);
    }

    const valueIds = new Set();
    const names = new Set();
    const value = rawValues.map((entry, valueIndex) => {
      const valueName = cleanText(entry?.name ?? entry?.value);
      if (!valueName || names.has(valueName)) {
        throw fallbackError("Mobile item detail returned duplicate variant values");
      }
      names.add(valueName);
      let vid = cleanText(entry?.vid ?? entry?.valueId);
      if (vid) {
        if (valueIds.has(vid)) {
          throw fallbackError("Mobile item detail returned duplicate variant values");
        }
        valueIds.add(vid);
      } else {
        vid = stableNumericId(`value:${fid}:${valueIndex}:${valueName}`, valueIds);
      }
      const imageUrl = normalizeHttpUrl(entry?.imageUrl);
      return { name: valueName, vid, ...(imageUrl ? { imageUrl } : {}) };
    });
    return { fid, prop: name, value };
  });

  const allowedNames = skuProps.map(
    (prop) => new Set(prop.value.map((value) => value.name))
  );
  const skuIds = new Set();
  const skuInfoMap = Object.create(null);
  for (const [key, row] of rawRows) {
    if (!isObject(row)) throw fallbackError("Mobile item detail returned an invalid variant");
    const skuId = cleanText(row.skuId);
    const tokens = cleanText(row.specAttrs || key)
      .split(">")
      .map(cleanText)
      .filter(Boolean);
    if (!/^\d+$/.test(skuId) || skuIds.has(skuId)) {
      throw fallbackError("Mobile item detail returned invalid variant IDs");
    }
    if (
      tokens.length !== skuProps.length ||
      tokens.some((token, index) => !allowedNames[index]?.has(token))
    ) {
      throw fallbackError("Mobile item detail returned unresolved variant values");
    }
    const stock = finiteNumber(row.canBookCount);
    const discountPrice = positiveNumber(row.discountPrice);
    const regularPrice = positiveNumber(row.price);
    const salePrice = discountPrice ?? regularPrice;
    if (stock == null || stock < 0 || salePrice == null) {
      throw fallbackError("Mobile item detail returned incomplete variant inventory");
    }
    skuIds.add(skuId);
    const specAttrs = tokens.join(">");
    if (Object.hasOwn(skuInfoMap, specAttrs)) {
      throw fallbackError("Mobile item detail returned duplicate variant combinations");
    }
    // Light-offer responses commonly use 1,000,000,000 as an availability
    // sentinel. An individual variant cannot exceed the accurate total from
    // the mobile document, so cap it to that authoritative upper bound.
    const boundedStock = Math.min(stock, authoritativeTotalStock);
    skuInfoMap[specAttrs] = {
      skuId,
      specId: cleanText(row.specId),
      specAttrs,
      canBookCount: boundedStock,
      price: String(regularPrice ?? salePrice),
      discountPrice: String(salePrice),
      saleCount: Math.max(0, finiteNumber(row.saleCount) ?? 0),
    };
  }

  const prices = Object.values(skuInfoMap).map((row) => Number(row.discountPrice));
  const scale = cleanText(source.skuPriceScale || source.skuPriceScaleOriginal);
  return {
    skuModel: {
      skuProps,
      skuInfoMap,
      skuInfoMapOriginal: skuInfoMap,
      skuPriceScale: scale,
      skuPriceScaleOriginal: scale,
    },
    prices,
    hasVariants: skuProps.length > 0,
  };
}

function assertOfferIds(offerId, values, sourceName) {
  const present = values.filter((value) => value != null && value !== "");
  if (!present.length || present.some((value) => String(value) !== offerId)) {
    throw fallbackError(`${sourceName} returned a different offer`);
  }
}

function normalizeTierPrices(order) {
  return asArray(order?.skuParam?.skuRangePrices)
    .map((tier) => ({
      beginAmount: String(Math.max(1, finiteNumber(tier?.beginAmount) ?? 1)),
      price: positiveNumber(tier?.price),
    }))
    .filter((tier) => tier.price != null);
}

function firstProductProps(init) {
  const primary = init.globalData?.blackPage?.property?.propsList;
  const candidates = [primary, ...nestedArraysByKey(init.componentData, "propsList")];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    const normalized = list
      .map((entry) => ({
        name: cleanText(entry?.name ?? entry?.attrName),
        value: cleanText(entry?.value ?? entry?.attrValue),
      }))
      .filter((entry) => entry.name && entry.value);
    if (normalized.length) return normalized;
  }
  return [];
}

function validateStrictDetail(raw, offerId, hasVariants) {
  const result = toTmapiItemDetail(raw);
  const data = result?.data;
  const price = positiveNumber(data?.price_info?.price ?? data?.price);
  const stock = finiteNumber(data?.stock ?? data?.total_stock);
  if (
    result?.code !== 200 ||
    String(data?.item_id) !== offerId ||
    !cleanText(data?.title) ||
    !asArray(data?.main_imgs).some(normalizeHttpUrl) ||
    price == null ||
    positiveNumber(data?.quantity_begin ?? data?.moq) == null ||
    stock == null ||
    stock < 0
  ) {
    throw fallbackError("Mobile item detail did not satisfy the item contract");
  }

  const props = asArray(data.sku_props);
  const skus = asArray(data.skus);
  if ((props.length === 0) !== (skus.length === 0) || hasVariants !== Boolean(props.length)) {
    throw fallbackError("Mobile item detail did not satisfy the variant contract");
  }
  const allowed = new Map(
    props.map((prop) => [
      cleanText(prop.pid),
      new Set(asArray(prop.values).map((value) => cleanText(value.vid))),
    ])
  );
  if (allowed.size !== props.length || allowed.has("")) {
    throw fallbackError("Mobile item detail did not satisfy the variant contract");
  }
  for (const sku of skus) {
    const pairs = cleanText(sku.props_ids).split(";").filter(Boolean);
    if (
      !/^\d+$/.test(cleanText(sku.skuid)) ||
      positiveNumber(sku.sale_price) == null ||
      (finiteNumber(sku.stock) ?? -1) < 0 ||
      pairs.length !== props.length
    ) {
      throw fallbackError("Mobile item detail did not satisfy the variant contract");
    }
    for (const pair of pairs) {
      const separator = pair.indexOf(":");
      const pid = separator >= 0 ? pair.slice(0, separator) : "";
      const vid = separator >= 0 ? pair.slice(separator + 1) : "";
      if (!allowed.get(pid)?.has(vid)) {
        throw fallbackError("Mobile item detail did not satisfy the variant contract");
      }
    }
  }
}

export function mapMobileMtopToRaw(offerIdValue, mobileInit, mtopPayload) {
  const offerId = String(offerIdValue || "").trim();
  if (!/^\d+$/.test(offerId) || !isObject(mobileInit?.globalData)) {
    throw fallbackError("Mobile item detail was invalid");
  }
  const ret = asArray(mtopPayload?.ret);
  const envelope = mtopPayload?.data;
  const mtopData = envelope?.data;
  if (
    !ret.some((value) => /^SUCCESS(?:::|$)/i.test(String(value))) ||
    String(envelope?.resultCode || "").toLowerCase() !== "ok" ||
    !isObject(mtopData?.globalData)
  ) {
    throw fallbackError("Mobile item-detail service was unsuccessful");
  }

  const global = mobileInit.globalData;
  const temp = global.tempModel;
  const mtopBase = mtopData.globalData.offerBaseInfo;
  const order = global.orderParamModel?.orderParam;
  if (!isObject(temp) || !isObject(mtopBase) || !isObject(order)) {
    throw fallbackError("Mobile item detail omitted required offer data");
  }
  assertOfferIds(
    offerId,
    [temp.offerId, global.offerBaseInfo?.offerId, global.detailModel?.offerId],
    "Mobile offer page"
  );
  assertOfferIds(
    offerId,
    [mtopBase.offerId, mtopData.componentData?.offerId],
    "Mobile item-detail service"
  );

  const title = cleanText(temp.offerTitle || mtopBase.title);
  const images = collectMobileImages(mobileInit, mtopData);
  const stock = finiteNumber(order.canBookedAmount);
  const beginNum = positiveNumber(order.beginNum);
  if (!title || images.length === 0 || stock == null || stock < 0 || beginNum == null) {
    throw fallbackError("Mobile offer page returned incomplete product data");
  }

  const normalizedSku = normalizeSkuModel(
    mtopData.globalData.skuModelOrigin,
    stock
  );
  const tierPrices = normalizeTierPrices(order);
  const candidates = [
    positiveNumber(temp.price),
    positiveNumber(mtopData.minPrice),
    ...normalizedSku.prices,
    ...tierPrices.map((tier) => tier.price),
  ].filter((value) => value != null);
  if (!candidates.length) throw fallbackError("Mobile item detail omitted pricing");
  const minPrice = Math.min(...candidates);
  const maxPrice = Math.max(...candidates);
  const services = asArray(global.blackPage?.service?.serviceDesc)
    .map((service) => ({
      serviceCode: cleanText(service?.type),
      serviceName: cleanText(service?.serviceName),
      description: cleanText(service?.description),
    }))
    .filter((service) => service.serviceCode || service.serviceName);
  const detailUrl =
    officialDetailUrl(global.detailModel?.detailUrl, offerId) ||
    officialDetailUrl(mtopData.odUrl, offerId) ||
    `https://detail.1688.com/offer/${offerId}.html`;
  const sellerUserId = cleanText(temp.sellerUserId || mtopBase.sellerUserId);
  const sellerLoginId = cleanText(temp.sellerLoginId || mtopBase.sellerLoginId);
  const sellerMemberId = cleanText(temp.sellerMemberId || mtopBase.sellerMemberId);
  const offerUnit = cleanText(temp.offerUnit || mtopBase.offerUnit) || "个";
  const productFeatureList = firstProductProps(mobileInit);

  const raw = {
    offerId,
    title,
    documentTitle: title,
    saleNum: order.saledCount ?? temp.saledCount ?? null,
    images,
    galleryImgs: images,
    gallery: { offerImgList: images },
    mainPrice: {
      unit: offerUnit,
      originalPricesWithoutPromotion: tierPrices,
      finalPriceModel: {
        tradeWithoutPromotion: {
          offerMinPrice: String(minPrice),
          offerMaxPrice: String(maxPrice),
          offerPriceDisplay: `${minPrice}-${maxPrice}`,
          offerBeginAmount: beginNum,
          canBookedAmountOriginal: stock,
          skuMapOriginal: Object.values(normalizedSku.skuModel.skuInfoMap),
        },
      },
    },
    skuModel: normalizedSku.skuModel,
    mixModel: isObject(global.mixModel) ? global.mixModel : null,
    orderParam: {
      ...order,
      canBookedAmount: stock,
      beginNum,
      skuParam: {
        ...(isObject(order.skuParam) ? order.skuParam : {}),
        skuRangePrices: tierPrices,
      },
    },
    tempModel: {
      ...temp,
      offerId,
      offerTitle: title,
      offerUnit,
      sellerUserId,
      sellerLoginId,
      sellerMemberId,
    },
    seller: {
      frontSellerUserId: sellerUserId,
      frontSellerLoginId: sellerLoginId,
      frontSellerMemberId: sellerMemberId,
    },
    shopInfo: {
      companyName: cleanText(temp.companyName),
      authCompanyName: cleanText(temp.companyName),
    },
    mainServices: { guaranteeList: services },
    detailUrl,
    leafCategoryId: temp.postCategoryId ?? null,
    categoryId: temp.postCategoryId ?? null,
    productFeatureList,
    featureAttributes: productFeatureList,
    attrText: "",
    productPackInfo: null,
    videoId: null,
    deliveryInfo: null,
    shipping: mapMobileShipping(mobileInit, offerId),
  };
  validateStrictDetail(raw, offerId, normalizedSku.hasVariants);
  return raw;
}

export function signMtopDetail(token, timestamp, data) {
  return createHash("md5")
    .update(`${token}&${timestamp}&${MTOP_APP_KEY}&${data}`)
    .digest("hex");
}

function requestTimeout(deadline, capMs) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < 250) throw fallbackError("Mobile item-detail deadline exceeded", 504);
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
  if (remaining < 1) throw fallbackError(`${label} deadline exceeded`, 504);
  let timer;
  try {
    return await awaitJob(
      Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(fallbackError(`${label} deadline exceeded`, 504)),
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

async function safeGet(context, url, options, deadline, label, timeoutCap = 8_000) {
  const signal = currentJobSignal();
  try {
    return await awaitJob(
      context.get(url, {
        ...options,
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: requestTimeout(deadline, timeoutCap),
      })
    );
  } catch (error) {
    if (signal?.aborted || error?.cancelled || error?.code === 499) throw jobAbortError(signal);
    if (error?.mtopFallback) throw error;
    throw fallbackError(`${label} request failed`);
  }
}

async function boundedBody(response, maxBytes, label, deadline) {
  const length = Number(response.headers()["content-length"] || 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw fallbackError(`${label} response was too large`);
  }
  let body;
  const signal = currentJobSignal();
  try {
    body = await awaitWithin(response.body(), deadline, `${label} response`);
  } catch (error) {
    if (signal?.aborted || error?.cancelled || error?.code === 499) {
      throw jobAbortError(signal);
    }
    if (error?.mtopFallback) throw error;
    // Playwright request errors may contain the signed request URL. Never let
    // those implementation details reach logs or API responses.
    throw fallbackError(`${label} response could not be read`);
  }
  if (body.length > maxBytes) throw fallbackError(`${label} response was too large`);
  return body;
}

function assertHttpSuccess(response, label) {
  const status = response.status();
  if (status < 200 || status >= 300) {
    throw fallbackError(`${label} returned HTTP ${status}`, status === 429 ? 429 : 502);
  }
}

function mtopParams(offerId, token) {
  const data = JSON.stringify({
    mmgaRequest: { serviceName: "wirelessLightOfferService", offerId },
  });
  const t = String(Date.now());
  return {
    appKey: MTOP_APP_KEY,
    t,
    sign: signMtopDetail(token, t, data),
    api: MTOP_API,
    v: MTOP_VERSION,
    type: "json",
    dataType: "json",
    isSec: "0",
    timeout: String(MTOP_QUERY_TIMEOUT_MS),
    data,
  };
}

function mtopUrlMatches(value) {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "h5api.m.1688.com" &&
      url.pathname.replace(/\/+$/, "") ===
        "/h5/mtop.1688.mmga.offerdetail.service/1.0"
    );
  } catch {
    return false;
  }
}

async function fetchMtopPayload(context, offerId, deadline) {
  let first;
  let second;
  try {
    first = await safeGet(
      context,
      MTOP_ENDPOINT,
      {
        params: mtopParams(offerId, ""),
        headers: {
          Origin: "https://m.1688.com",
          Referer: `https://m.1688.com/offer/${offerId}.html`,
        },
      },
      deadline,
      "Mobile item-detail token"
    );
    assertHttpSuccess(first, "Mobile item-detail token");
    if (!mtopUrlMatches(first.url())) {
      throw fallbackError("Mobile item-detail token redirected unexpectedly");
    }
    await boundedBody(first, MAX_MTOP_BYTES, "Mobile item-detail token", deadline);

    let state;
    try {
      state = await awaitWithin(
        context.storageState(),
        deadline,
        "Mobile item-detail token state"
      );
    } catch (error) {
      const signal = currentJobSignal();
      if (signal?.aborted || error?.cancelled || error?.code === 499) {
        throw jobAbortError(signal);
      }
      if (error?.mtopFallback) throw error;
      throw fallbackError("Mobile item-detail token state was unavailable");
    }
    const tokenCookie = asArray(state?.cookies).find((cookie) => {
      const domain = String(cookie?.domain || "").replace(/^\./, "").toLowerCase();
      return (
        cookie?.name === "_m_h5_tk" &&
        (domain === "1688.com" || domain.endsWith(".1688.com"))
      );
    });
    const token = String(tokenCookie?.value || "").split("_")[0];
    if (!/^[a-z0-9]{16,128}$/i.test(token)) {
      throw fallbackError("Mobile item-detail token handshake failed");
    }

    second = await safeGet(
      context,
      MTOP_ENDPOINT,
      {
        params: mtopParams(offerId, token),
        headers: {
          Origin: "https://m.1688.com",
          Referer: `https://m.1688.com/offer/${offerId}.html`,
        },
      },
      deadline,
      "Mobile item detail"
    );
    assertHttpSuccess(second, "Mobile item detail");
    if (!mtopUrlMatches(second.url())) {
      throw fallbackError("Mobile item detail redirected unexpectedly");
    }
    const contentType = second.headers()["content-type"] || "";
    if (contentType && !/json|javascript|text\/plain/i.test(contentType)) {
      throw fallbackError("Mobile item detail returned an invalid response type");
    }
    const body = await boundedBody(
      second,
      MAX_MTOP_BYTES,
      "Mobile item detail",
      deadline
    );
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw fallbackError("Mobile item detail returned malformed JSON");
    }
  } finally {
    await first?.dispose().catch(() => {});
    await second?.dispose().catch(() => {});
  }
}

function mobileUrlMatches(urlValue, offerId) {
  try {
    const url = new URL(String(urlValue));
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "m.1688.com" &&
      url.pathname.replace(/\/+$/, "") === `/offer/${offerId}.html`
    );
  } catch {
    return false;
  }
}

async function fetchMobileInit(context, offerId, deadline, timeoutCap = 6_500) {
  let response;
  try {
    response = await safeGet(
      context,
      `https://m.1688.com/offer/${offerId}.html`,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://m.1688.com/",
          "Upgrade-Insecure-Requests": "1",
        },
      },
      deadline,
      "Mobile offer page",
      timeoutCap
    );
    assertHttpSuccess(response, "Mobile offer page");
    const contentType = response.headers()["content-type"] || "";
    if (contentType && !/html|xhtml/i.test(contentType)) {
      throw fallbackError("Mobile offer page returned an invalid response type");
    }
    if (!mobileUrlMatches(response.url(), offerId)) {
      throw fallbackError("Mobile offer page redirected away from the offer");
    }
    const body = await boundedBody(
      response,
      MAX_MOBILE_HTML_BYTES,
      "Mobile offer page",
      deadline
    );
    const init = parseMobileOfferInitFromHtml(body.toString("utf8"));
    if (!init) throw fallbackError("Mobile offer page omitted product data");
    return init;
  } finally {
    await response?.dispose().catch(() => {});
  }
}

export async function scrapeOfferMtop(
  offerIdValue,
  { deadline, contextFactory = (options) => request.newContext(options), budgetMs } = {}
) {
  const offerId = String(offerIdValue || "").trim();
  if (!/^\d+$/.test(offerId)) throw fallbackError("Mobile item detail ID was invalid", 422);
  const now = Date.now();
  const callerDeadline = Number.isFinite(deadline)
    ? deadline
    : now + DEFAULT_DETAIL_BUDGET_MS;
  const operationDeadline = Math.min(
    callerDeadline,
    now + Math.max(1_000, Number(budgetMs) || DEFAULT_DETAIL_BUDGET_MS)
  );
  const signal = currentJobSignal();
  if (signal?.aborted) throw jobAbortError(signal);

  const proxy = getPlaywrightProxy();
  const contextOptions = {
    ...(proxy ? { proxy } : {}),
    userAgent: MOBILE_USER_AGENT,
    extraHTTPHeaders: {
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  };
  let contextPromises = [];
  let contexts = [];
  try {
    try {
      // Keep the speculative mobile document isolated from the signed MTop
      // cookie jar. Both still use the exact configured proxy, while the token
      // bootstrap and signed retry remain pinned to one MTop context.
      contextPromises = [
        Promise.resolve().then(() => contextFactory(contextOptions)),
        Promise.resolve().then(() => contextFactory(contextOptions)),
      ];
      contexts = await awaitWithin(
        Promise.all(contextPromises),
        operationDeadline,
        "Mobile item-detail clients"
      );
    } catch (error) {
      if (signal?.aborted || error?.cancelled || error?.code === 499) {
        throw jobAbortError(signal);
      }
      if (error?.mtopFallback) throw error;
      throw fallbackError("Mobile item-detail clients could not start");
    }
    if (signal?.aborted) throw jobAbortError(signal);
    const [mtopContext, mobileContext] = contexts;

    // Start both sources speculatively. A small 1688/TMD shell can appear
    // intermittently; after the MTop handshake has established cookies, retry
    // that document once in the pinned MTop context and deadline.
    const firstMobileAttempt = fetchMobileInit(
      mobileContext,
      offerId,
      operationDeadline
    ).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    const mtopPayload = await fetchMtopPayload(
      mtopContext,
      offerId,
      operationDeadline
    );
    const firstMobile = await firstMobileAttempt;
    if (
      firstMobile.error &&
      (signal?.aborted || firstMobile.error?.cancelled || firstMobile.error?.code === 499)
    ) {
      throw jobAbortError(signal);
    }
    const mobileInit = firstMobile.error
      ? await fetchMobileInit(mtopContext, offerId, operationDeadline, 8_000)
      : firstMobile.value;
    if (signal?.aborted) throw jobAbortError(signal);
    return mapMobileMtopToRaw(offerId, mobileInit, mtopPayload);
  } finally {
    if (contexts.length) {
      await Promise.allSettled(
        [...new Set(contexts)].map((context) => context.dispose())
      );
    } else {
      // If cancellation/deadline wins context creation, dispose any context
      // that resolves afterward instead of orphaning its connection pool.
      for (const contextPromise of contextPromises) {
        void contextPromise
          .then((lateContext) => lateContext?.dispose().catch(() => {}))
          .catch(() => {});
      }
    }
  }
}
