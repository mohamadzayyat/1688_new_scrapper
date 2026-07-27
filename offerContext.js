/**
 * Parse 1688 offer `window.context` from raw HTML (IIFE form).
 * Avoids waiting for page JS / translators.
 */

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

  for (let j = i; j < html.length; j++) {
    const ch = html[j];
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
    if (ch === '"' || ch === "'") {
      inStr = true;
      strQ = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const raw = html.slice(i, j + 1);
        try {
          return Function(`"use strict"; return (${raw})`)();
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
  return Boolean(raw && (raw.title || raw.skuModel || raw.mainPrice));
}
