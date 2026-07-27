/**
 * Lightweight Chinese → English helper using Google's public gtx endpoint.
 * Used for search result titles when 1688 page translation is incomplete.
 */

import { currentJobSignal } from "./jobContext.js";

const TRANSLATE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.TRANSLATE_TIMEOUT_MS) || 5_000
);
const TRANSLATE_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.TRANSLATE_CONCURRENCY) || 3)
);
const TRANSLATE_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.TRANSLATE_CACHE_TTL_MS) || 24 * 60 * 60 * 1000
);
const TRANSLATE_CACHE_MAX = Math.max(
  100,
  Number(process.env.TRANSLATE_CACHE_MAX) || 5_000
);
const translationCache = new Map();
const HAN_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function translateChunk(text, { from = "zh-CN", to = "en" } = {}) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" +
    encodeURIComponent(from) +
    "&tl=" +
    encodeURIComponent(to) +
    "&dt=t&q=" +
    encodeURIComponent(text);

  const controller = new AbortController();
  const jobSignal = currentJobSignal();
  const abortFromJob = () => controller.abort(jobSignal?.reason);
  if (jobSignal?.aborted) abortFromJob();
  else jobSignal?.addEventListener("abort", abortFromJob, { once: true });
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  timer.unref?.();
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    jobSignal?.removeEventListener("abort", abortFromJob);
  }
  if (!res.ok) throw new Error(`Translate failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data?.[0]) || data[0].length === 0) {
    throw new Error("Translate returned a malformed payload");
  }
  const translated = data[0].map((part) => part?.[0] || "").join("").trim();
  if (!translated) throw new Error("Translate returned an empty result");
  return translated;
}

function hanCount(value) {
  return String(value || "").match(HAN_CHARACTER)?.length || 0;
}

function translationLooksComplete(original, translated) {
  const source = stripHtml(original);
  const result = stripHtml(translated);
  if (!result) return false;
  const sourceHan = hanCount(source);
  if (!sourceHan) return true;
  // A successful English translation should change Chinese source text and
  // materially reduce its Han characters. Otherwise serve the source as a
  // fallback, but never cache it as a completed translation.
  return result !== source && hanCount(result) < sourceHan;
}

export function markResponseUncacheable(response) {
  if (!response || typeof response !== "object") return response;
  Object.defineProperty(response, "__scraperNoCache", {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return response;
}

export function markIfTranslationIncomplete(response, translated) {
  return translated?.__translationComplete === false ||
    translated?.__translationIncomplete
    ? markResponseUncacheable(response)
    : response;
}

function translationCacheKey(text, from, to) {
  return `${from}|${to}|${text}`;
}

function getCachedTranslation(text, from, to) {
  const key = translationCacheKey(text, from, to);
  const entry = translationCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    translationCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedTranslation(text, translated, from, to) {
  if (translationCache.size >= TRANSLATE_CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    if (oldest) translationCache.delete(oldest);
  }
  translationCache.set(translationCacheKey(text, from, to), {
    value: translated,
    expires: Date.now() + TRANSLATE_CACHE_TTL_MS,
  });
}

/**
 * Translate an array of strings. Preserves order. Skips blanks.
 * @param {Array<string|null|undefined>} texts
 * @returns {Promise<string[]>}
 */
export async function translateTexts(texts, { from = "zh-CN", to = "en" } = {}) {
  const cleaned = texts.map((t) => stripHtml(t));
  const out = cleaned.slice();
  const indexesByText = new Map();

  for (let i = 0; i < cleaned.length; i++) {
    const text = cleaned[i];
    if (!text) continue;
    // Already mostly English — keep as-is
    if (/[A-Za-z]{4,}/.test(text) && !/[\u4e00-\u9fff]/.test(text)) continue;
    if (!/[\u4e00-\u9fff]/.test(text)) continue;
    const cached = getCachedTranslation(text, from, to);
    if (cached != null) {
      out[i] = cached;
      continue;
    }
    if (!indexesByText.has(text)) indexesByText.set(text, []);
    indexesByText.get(text).push(i);
  }

  // Translate unique strings in bounded parallel batches. Validate the output
  // cardinality so a changed newline cannot shift translations onto fields.
  const unique = [...indexesByText.keys()];
  let complete = true;
  const batches = [];
  for (let start = 0; start < unique.length; start += 8) {
    batches.push(unique.slice(start, start + 8));
  }
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (currentJobSignal()?.aborted) {
        complete = false;
        return;
      }
      const batchIndex = cursor++;
      if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex];
      try {
        const translated = await translateChunk(batch.join("\n"), { from, to });
        const parts = translated.split("\n");
        if (
          parts.length !== batch.length ||
          parts.some((part, index) => !translationLooksComplete(batch[index], part))
        ) {
          complete = false;
          continue;
        }
        batch.forEach((original, partIndex) => {
          const value = (parts[partIndex] || original).trim();
          setCachedTranslation(original, value, from, to);
          for (const outputIndex of indexesByText.get(original) || []) {
            out[outputIndex] = value;
          }
        });
      } catch {
        // Leave the original text on timeout/upstream failure.
        complete = false;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(TRANSLATE_CONCURRENCY, batches.length) },
      () => worker()
    )
  );

  Object.defineProperty(out, "__translationComplete", {
    value: complete,
    enumerable: false,
  });
  return out;
}

export function normalizeLang(lang) {
  const value = String(lang || "zh").trim().toLowerCase();
  if (value === "en" || value === "english") return "en";
  return "zh";
}

/**
 * Translate TMAPI item_detail `data` fields Chinese → English in-place.
 * Fast alternative to waiting for 1688's on-page translator.
 */
export async function translateItemDetailData(data) {
  if (!data || typeof data !== "object") return data;

  const texts = [];
  const apply = [];

  const add = (value, setter) => {
    if (value == null || value === "") return;
    const i = texts.length;
    texts.push(String(value));
    apply.push((translated) => setter(translated[i]));
  };

  add(data.title, (t) => {
    data.title = t;
  });
  add(data.shop_info?.shop_name, (t) => {
    if (data.shop_info) data.shop_info.shop_name = t;
  });

  const propPairs = [];
  for (const prop of data.product_props || []) {
    for (const [k, v] of Object.entries(prop || {})) {
      const idx = propPairs.length;
      propPairs.push({ k, v });
      add(k, (t) => {
        propPairs[idx].k = t;
      });
      add(v, (t) => {
        propPairs[idx].v = t;
      });
    }
  }

  for (const prop of data.sku_props || []) {
    add(prop.prop_name, (t) => {
      prop.prop_name = t;
    });
    for (const val of prop.values || []) {
      add(val.name, (t) => {
        val.name = t;
      });
    }
  }

  for (const sku of data.skus || []) {
    add(sku.props_names, (t) => {
      sku.props_names = String(t || "").replace(/\s*;\s*/g, ";");
    });
  }

  if (!texts.length) return data;
  const translated = await translateTexts(texts);
  if (translated.__translationComplete === false) {
    Object.defineProperty(data, "__translationIncomplete", {
      value: true,
      enumerable: false,
    });
  }
  for (const fn of apply) fn(translated);

  if (propPairs.length) {
    data.product_props = propPairs.map(({ k, v }) => ({ [k]: v }));
  }

  return data;
}
