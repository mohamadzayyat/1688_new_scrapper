/**
 * Parse 1688 offer `window.context` from raw HTML (IIFE form).
 * Avoids waiting for page JS / translators.
 */
import JSON5 from "json5";

const MAX_CONTEXT_BYTES = Math.max(
  1_000_000,
  Number(process.env.MAX_CONTEXT_BYTES) || 12_000_000
);

function skipJsTrivia(source, start) {
  let i = start;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return source.length;
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * JSON5 intentionally accepts JavaScript-style object literals, but its
 * property-name grammar does not accept the unquoted numeric SKU IDs that
 * 1688 emits (for example `{5710481973202: 0.25}`). Quote only digit-only
 * property keys, while leaving strings and comments byte-for-byte unchanged.
 */
function quoteNumericObjectKeys(source) {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      out += ch;
      i++;
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      out += ch;
      i++;
      if (ch === "*" && next === "/") {
        out += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (inString) {
      out += ch;
      i++;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      out += "//";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      out += "/*";
      i += 2;
      continue;
    }

    out += ch;
    i++;
    if (ch !== "{" && ch !== ",") continue;

    const keyStart = skipJsTrivia(source, i);
    let keyEnd = keyStart;
    while (keyEnd < source.length && /[0-9]/.test(source[keyEnd])) keyEnd++;
    if (keyEnd === keyStart) continue;

    const colon = skipJsTrivia(source, keyEnd);
    if (source[colon] !== ":") continue;

    out += source.slice(i, keyStart);
    out += `"${source.slice(keyStart, keyEnd)}"`;
    i = keyEnd;
  }

  return out;
}

/**
 * Extract a JS object literal starting at `startIdx` (first non-space should be `{`).
 * Handles quoted strings so braces inside strings don't break matching.
 */
export function extractJsObject(html, startIdx) {
  let i = startIdx;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== "{") return null;

  let depth = 0;
  let inStr = false;
  let strQ = "";
  let esc = false;
  let lineComment = false;
  let blockComment = false;

  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    const next = html[j + 1];
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        j++;
      }
      continue;
    }
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === strQ) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true;
      strQ = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      j++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      j++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const raw = html.slice(i, j + 1);
        if (raw.length > MAX_CONTEXT_BYTES) return null;
        try {
          // 1688 currently emits a JavaScript object literal rather than strict
          // JSON. JSON5 accepts its quoted/unquoted keys and trailing commas
          // without executing page-controlled source in the Node process.
          return JSON5.parse(quoteNumericObjectKeys(raw));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * @param {string} html
 * @returns {object|null} window.context payload
 */
export function parseOfferContextFromHtml(html) {
  if (!html || html.length < 1000) return null;
  const marker = "window.context=";
  const idx = html.indexOf(marker);
  if (idx < 0) return null;

  // Primary: window.context=(function(...){...})(window.contextPath,{...})
  const iife = html.indexOf("})(window.contextPath,", idx);
  if (iife > idx && iife - idx < 5000) {
    const objStart = iife + "})(window.contextPath,".length;
    const obj = extractJsObject(html, objStart);
    if (obj?.result?.data) return obj;
  }

  // Fallback: direct object assignment
  const eq = html.indexOf("=", idx);
  if (eq > 0) {
    const obj = extractJsObject(html, eq + 1);
    if (obj?.result?.data) return obj;
  }
  return null;
}

/**
 * Parse the server-rendered mobile offer bootstrap. Unlike `window.context`,
 * this payload is available on m.1688.com without an account session and
 * carries accurate order totals, images, seller metadata and page modules.
 */
export function parseMobileOfferInitFromHtml(html) {
  if (!html || html.length < 1_000) return null;
  const idx = html.search(/window\.__INIT_DATA\s*=/);
  if (idx < 0) return null;
  const assignment = html.indexOf("=", idx);
  if (assignment < 0 || assignment - idx > 64) return null;
  const init = extractJsObject(html, assignment + 1);
  if (!init?.globalData || !init?.data) return null;
  return init;
}

/**
 * Map window.context → raw shape expected by toTmapiItemDetail / extractRawOffer.
 */
export function contextToRawOffer(offerId, ctx) {
  const data = ctx?.result?.data || {};
  const fieldsOf = (key) => data[key]?.fields || null;
  const root = data.Root?.fields?.dataJson || {};
  const images = (root.images || [])
    .map((img) => img.fullPathImageURI)
    .filter(Boolean);

  return {
    offerId: String(offerId),
    documentTitle: null,
    title:
      fieldsOf("productTitle")?.title || root.tempModel?.offerTitle || null,
    saleNum: fieldsOf("productTitle")?.saleNum ?? null,
    shopInfo: fieldsOf("productTitle")?.shopInfo || null,
    mainPrice: fieldsOf("mainPrice"),
    productPackInfo: fieldsOf("productPackInfo"),
    gallery: fieldsOf("gallery"),
    galleryImgs: fieldsOf("gallery")?.offerImgList || null,
    mainServices: fieldsOf("mainServices"),
    seller: root.frontSellerMemberModel || null,
    images:
      images.length > 0 ? images : fieldsOf("gallery")?.offerImgList || [],
    skuModel: root.skuModel || null,
    mixModel: root.mixModel || null,
    tempModel: root.tempModel || null,
    orderParam: root.orderParamModel?.orderParam || null,
    videoId:
      fieldsOf("description")?.detailVideoId ||
      fieldsOf("gallery")?.video?.videoId ||
      null,
    detailUrl: fieldsOf("description")?.detailUrl || null,
    leafCategoryId: fieldsOf("description")?.leafCategoryId || null,
    categoryId: root.tempModel?.postCategoryId || null,
    attrText: "",
    productFeatureList:
      root.tempModel?.productFeatureList || root.productFeatureList || null,
    featureAttributes:
      root.tempModel?.featureAttributes || root.featureAttributes || null,
    deliveryInfo: null,
    shipping: fieldsOf("shippingServices"),
  };
}

export function isUsableRawOffer(raw) {
  const images = raw?.images || raw?.galleryImgs || [];
  const trade = raw?.mainPrice?.finalPriceModel?.tradeWithoutPromotion || {};
  const tierPrices = [
    ...(raw?.mainPrice?.originalPricesWithoutPromotion || []),
    ...(raw?.mainPrice?.priceModel?.currentPrices || []),
    ...(raw?.orderParam?.skuParam?.skuRangePrices || []),
  ];
  const skuRows = Object.values(
    raw?.skuModel?.skuInfoMap || raw?.skuModel?.skuInfoMapOriginal || {}
  );
  const hasPositivePrice = [
    trade.offerMinPrice,
    trade.offerMaxPrice,
    raw?.skuModel?.skuPriceScale,
    raw?.skuModel?.skuPriceScaleOriginal,
    ...tierPrices.map((row) => row?.price),
    ...skuRows.flatMap((row) => [row?.discountPrice, row?.price]),
  ].some((value) => {
    const match = String(value ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) > 0 : false;
  });
  return Boolean(
    raw?.title &&
      hasPositivePrice &&
      Array.isArray(images) &&
      images.length > 0
  );
}
