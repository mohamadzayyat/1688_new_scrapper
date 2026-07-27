/**
 * TMAPI response helpers beyond item_detail.
 * Docs: https://tmapi.top/docs/ali/
 */

import { tmapiError } from "./tmapiFormat.js";

export { tmapiError };

export function tmapiOk(data) {
  return { code: 200, msg: "success", data };
}

function priceInfo(price) {
  const p = price != null && price !== "" ? String(price) : null;
  return {
    consignPrice: p,
    price: p,
    priceDescription: "",
    priceType: "NORMAL",
    priceUnderLine: p,
  };
}

export function toTmapiSearchItem(item) {
  const price = item.price != null ? String(item.price) : null;
  const sales = item.sales != null ? String(item.sales) : null;
  const location = item.location ? String(item.location) : "";
  return {
    item_id: String(item.offerId || item.item_id || ""),
    title: item.title || "",
    img: item.image || item.img || "",
    category_path: item.category_path || [],
    price: price,
    price_info: priceInfo(price),
    quantity_begin: item.quantity_begin != null ? String(item.quantity_begin) : null,
    quantity_prices: item.quantity_prices || [],
    sale_info: {
      gmv_30days: item.gmv_30days ?? null,
      sale_quantity: sales,
      agent_booked_count: "0",
      booked_count: sales,
    },
    type: item.isAd ? "ad" : "normal",
    unit: item.unit || "件",
    delivery_info: {
      area_from: location ? [location] : [],
      weight: item.weight ?? null,
      suttle_weight: item.suttle_weight ?? null,
      free_postage: Boolean(item.free_postage),
    },
    item_repurchase_rate: item.repurchaseRate ?? null,
    goods_score: item.goods_score ?? null,
    image_dsm_score: "0.0",
    primary_rank_score: "0",
    buyer_protections: item.tags || [],
    super_new_product: "false",
    byr_inquiry_uv: "0",
    shop_info: {
      biz_type: "",
      company_name: item.company || "",
      identity_tags: [],
      service_tags: [],
      login_id: item.login_id || "",
      member_id: item.member_id || "",
      userid: item.userid || "",
      tp_member: "",
      tp_year: "",
      factory_inspection: false,
      shop_repurchase_rate: item.repurchaseRate ?? null,
      sore_info: {
        composite_new_score: "0.0",
        composite_score: "0.0",
        consultation_score: "0.0",
        dispute_score: "0.0",
        logistics_score: "0.0",
        return_score: "0.0",
      },
    },
  };
}

export function toTmapiSearch(raw, { keyword, page, page_size, sort = "default" }) {
  const items = (raw.results || []).map(toTmapiSearchItem);
  const currentPage = Number(page) || 1;
  const currentPageSize = Number(page_size) || items.length || 20;
  const total = Number.isFinite(Number(raw.total))
    ? Number(raw.total)
    : items.length;
  return tmapiOk({
    page: currentPage,
    current_page: currentPage,
    page_size: currentPageSize,
    total,
    total_count: String(total),
    has_next_page: currentPage * currentPageSize < total,
    keyword: keyword || raw.keyword || "",
    sort,
    items,
  });
}

export function toTmapiShopItems(raw, meta) {
  const currentPage = Number(meta.page) || 1;
  const currentPageSize = Number(meta.page_size) || raw.items?.length || 20;
  const total = Number(raw.total_count ?? raw.items?.length ?? 0);
  return tmapiOk({
    page: currentPage,
    current_page: currentPage,
    page_size: currentPageSize,
    total,
    total_count: total,
    has_next_page: currentPage * currentPageSize < total,
    cat: meta.cat || "",
    keyword: meta.keyword || "",
    sort: meta.sort || "default",
    items: (raw.items || []).map((it) => ({
      item_id: String(it.item_id || it.offerId || ""),
      title: it.title || "",
      img: it.img || it.image || "",
      category_path: it.category_path || [],
      category_name: it.category_name || "",
      price: it.price != null ? String(it.price) : null,
      quantity: it.quantity ?? null,
      sale_info: {
        sale_quantity: it.sale_quantity ?? it.sales ?? 0,
        sale_amount: it.sale_amount ?? 0,
        agent_booked_count: null,
        booked_count: it.sale_quantity ?? it.sales ?? 0,
      },
    })),
  });
}

/** 1688 CDN image size conversion helper */
export function convertImageUrl(imgUrl, { width, height } = {}) {
  const url = String(imgUrl || "").trim();
  if (!url) return tmapiError(422, "img_url is required");

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return tmapiError(422, "img_url must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return tmapiError(422, "img_url must use http or https");
  }
  if (!/(?:^|\.)(?:alicdn\.com|1688\.com)$/i.test(parsed.hostname)) {
    return tmapiError(
      422,
      "External image upload conversion is not available on this provider"
    );
  }

  // Strip existing size suffixes like _220x220.jpg / .jpg_sum.jpg
  parsed.pathname = parsed.pathname
    .replace(/_\d+x\d+\.(jpg|png|webp|jpeg)/i, ".$1")
    .replace(/\.(jpg|png|jpeg|webp)_.+$/i, ".$1");

  const w = width != null && width !== "" ? Number(width) : null;
  const h = height != null && height !== "" ? Number(height) : null;
  if (
    (w != null && (!Number.isInteger(w) || w < 1 || w > 4096)) ||
    (h != null && (!Number.isInteger(h) || h < 1 || h > 4096))
  ) {
    return tmapiError(422, "width and height must be integers from 1 to 4096");
  }
  if ((w == null) !== (h == null)) {
    return tmapiError(422, "width and height must be provided together");
  }
  if (w && h && /\.(jpg|jpeg|png|webp)$/i.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(
      /\.(jpg|jpeg|png|webp)$/i,
      `_${w}x${h}.$1`
    );
  }
  const out = parsed.toString();

  return tmapiOk({
    original: url,
    converted: out,
    // Keep the native field and expose the names used by TMAPI clients.
    url: out,
    converted_url: out,
    image_url: out,
    width: w,
    height: h,
  });
}

export function parseOfferUrl(input) {
  const text = String(input || "").trim();
  if (!text) return tmapiError(422, "url is required");
  if (/^\d+$/.test(text)) {
    return tmapiOk({ item_id: text, url: `https://detail.1688.com/offer/${text}.html` });
  }
  const m =
    text.match(/offer[/:](\d+)/i) ||
    text.match(/[?&](?:offerId|offer_id|item_id)=(\d+)/i) ||
    text.match(/(\d{10,})/);
  if (!m?.[1]) return tmapiError(422, "Could not parse offer id from url");
  return tmapiOk({
    item_id: m[1],
    url: `https://detail.1688.com/offer/${m[1]}.html`,
  });
}
