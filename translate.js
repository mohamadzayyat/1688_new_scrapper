/**
 * Lightweight Chinese → English helper using Google's public gtx endpoint.
 * Used for search result titles when 1688 page translation is incomplete.
 */

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

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Translate failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data?.[0])) return text;
  return data[0].map((part) => part?.[0] || "").join("");
}

/**
 * Translate an array of strings. Preserves order. Skips blanks.
 * @param {Array<string|null|undefined>} texts
 * @returns {Promise<string[]>}
 */
export async function translateTexts(texts, { from = "zh-CN", to = "en" } = {}) {
  const cleaned = texts.map((t) => stripHtml(t));
  const out = cleaned.slice();
  const pending = [];

  for (let i = 0; i < cleaned.length; i++) {
    const text = cleaned[i];
    if (!text) continue;
    // Already mostly English — keep as-is
    if (/[A-Za-z]{4,}/.test(text) && !/[\u4e00-\u9fff]/.test(text)) continue;
    if (!/[\u4e00-\u9fff]/.test(text)) continue;
    pending.push(i);
  }

  // Batch a few at a time to avoid huge URLs
  const batchSize = 8;
  for (let start = 0; start < pending.length; start += batchSize) {
    const batchIdx = pending.slice(start, start + batchSize);
    const joined = batchIdx.map((i) => cleaned[i]).join("\n");
    try {
      const translated = await translateChunk(joined, { from, to });
      const parts = translated.split("\n");
      batchIdx.forEach((idx, j) => {
        out[idx] = (parts[j] || cleaned[idx]).trim();
      });
    } catch {
      // leave originals on failure
    }
  }

  return out;
}

export function normalizeLang(lang) {
  const value = String(lang || "zh").trim().toLowerCase();
  if (value === "en" || value === "english") return "en";
  return "zh";
}
