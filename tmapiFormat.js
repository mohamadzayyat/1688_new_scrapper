/**
 * Format scraped 1688 offer data into TMAPI
 * GET /1688/v2/item_detail response shape exactly.
 * Docs: https://tmapi.top/docs/ali/item-detail/get-item-detail-by-id
 */

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stableVid(name) {
  // 1688 page data often omits official vids; generate a stable numeric-like id
  // so props_ids stay consistent for the same value name.
  let hash = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return String(hash % 100000000);
}

const ATTR_LABEL_RE =
  /^(材质|品牌|货号|颜色|尺寸|品名|用途|场景|填充物|加工定制|是否|适用|支撑|制作|上市|枕芯|产品|包装|型号|产地|风格|图案|工艺|规格|重量|形状|高度|面料|成分|功能|结构|容量|加印|套装|版权|贸易|主要|有可|质量|杯子|价格段|送礼|证书|检测|品名)/;

const SHOP_NOISE_RE =
  /品质达标|店铺回头|支揽率|入驻|关注|客服|主营|好评|复购|立即铺货|代发|官方仓|包装信息|商品详情|全部参数|^参数$|枕芯类/;

function isAttrLabel(key) {
  const k = String(key || "").trim();
  if (!k || k.length > 20) return false;
  if (SHOP_NOISE_RE.test(k)) return false;
  if (/^[¥￥\d.]/.test(k)) return false;
  // Strict: only catalog-style attribute labels (never SKU value names)
  return ATTR_LABEL_RE.test(k);
}

function isAttrValue(val, key) {
  const v = String(val || "").trim();
  if (!v || v.length > 200) return false;
  if (SHOP_NOISE_RE.test(v)) return false;
  if (/全部参数|^参数$|价格|登录|送至|预计|承诺/.test(v)) return false;
  if (ATTR_LABEL_RE.test(v) && v.length <= 12) return false;
  if (v === key) return false;
  return true;
}

/**
 * Parse 1688 product attribute text into TMAPI product_props:
 * [ { "品牌": "采觉" }, { "材质": "记忆棉" }, ... ]
 */
function parseProductProps(attrText) {
  if (!attrText) return [];
  const props = [];
  const seen = new Set();

  let text = String(attrText).replace(/\r/g, "");
  const start = text.search(
    /(?:^|\n)(材质|品牌|货号|枕芯面料|产品类别|品名|颜色|尺寸规格)\b/
  );
  if (start >= 0) text = text.slice(start).replace(/^\n/, "");

  const endIdx = text.search(/\n全部参数|\n参数\n|\n价格\n|\n登录查看/);
  if (endIdx > 0) text = text.slice(0, endIdx);

  const lines = text
    .split("\n")
    .map((l) => l.replace(/\t+/g, " ").trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    const key = lines[i];
    const val = lines[i + 1];
    if (!isAttrLabel(key) || !isAttrValue(val, key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    props.push({ [key]: val });
    i++;
  }

  for (const line of String(attrText).split("\n")) {
    if (!line.includes("\t")) continue;
    const parts = line.split("\t").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [k, ...rest] = parts;
    const v = rest.join(" ");
    if (!isAttrLabel(k) || !isAttrValue(v, k) || seen.has(k)) continue;
    seen.add(k);
    props.push({ [k]: v });
  }

  return props;
}

function buildProductProps(raw) {
  const fromList = [];
  const list =
    raw.productFeatureList ||
    raw.tempModel?.productFeatureList ||
    raw.featureAttributes ||
    raw.tempModel?.featureAttributes ||
    [];

  if (Array.isArray(list)) {
    for (const item of list) {
      const name = item?.name || item?.attrName || item?.propertyName;
      let value = item?.value ?? item?.attrValue;
      if (value == null && Array.isArray(item?.values)) {
        value = item.values.join("、");
      }
      if (!name || value == null || value === "") continue;
      if (SHOP_NOISE_RE.test(String(name))) continue;
      fromList.push({ [String(name)]: String(value) });
    }
  }

  if (fromList.length) return fromList;
  return parseProductProps(raw.attrText);
}

function buildSkuProps(skuProps) {
  return (skuProps || []).map((prop) => {
    const pid = String(prop.fid ?? prop.pid ?? "");
    const values = (prop.value || prop.values || []).map((v) => {
      const item = {
        name: v.name || "",
        vid: v.vid != null ? String(v.vid) : stableVid(v.name),
      };
      if (v.imageUrl) item.imageUrl = v.imageUrl;
      return item;
    });
    return {
      prop_name: prop.prop || prop.prop_name || "",
      pid,
      values,
    };
  });
}

function buildPropsLookup(skuPropsFormatted) {
  // Map prop_name + value name → {pid, vid}
  const byPropValue = new Map();
  for (const prop of skuPropsFormatted) {
    for (const val of prop.values) {
      byPropValue.set(`${prop.prop_name}::${val.name}`, {
        pid: prop.pid,
        vid: val.vid,
      });
    }
  }
  return byPropValue;
}

function buildSkus(skuInfoMap, skuPropsFormatted) {
  const lookup = buildPropsLookup(skuPropsFormatted);
  const propOrder = skuPropsFormatted.map((p) => p.prop_name);

  return Object.values(skuInfoMap || {}).map((sku) => {
    const attrs = decodeHtml(sku.specAttrs || "");
    const names = attrs.split(">").map((s) => s.trim()).filter(Boolean);
    const idParts = [];
    const nameParts = [];

    names.forEach((name, idx) => {
      const propName = propOrder[idx] || "";
      const hit =
        lookup.get(`${propName}::${name}`) ||
        [...lookup.entries()].find(([k]) => k.endsWith(`::${name}`))?.[1];
      if (hit) {
        idParts.push(`${hit.pid}:${hit.vid}`);
      }
      nameParts.push(name);
    });

    const price = sku.discountPrice || sku.price || "0";
    return {
      skuid: String(sku.skuId ?? ""),
      specid: String(sku.specId ?? ""),
      sale_price: String(price),
      origin_price: String(sku.price || price),
      stock: Number(sku.canBookCount ?? 0),
      sale_count: Number(sku.saleCount ?? 0),
      props_ids: idParts.join(";"),
      props_names: nameParts.join(";"),
    };
  });
}

function buildPriceRange(raw) {
  const order = raw.orderParam || {};
  const mainPrice = raw.mainPrice || {};
  const trade = mainPrice.finalPriceModel?.tradeWithoutPromotion || {};
  const skuParam = order.skuParam?.skuRangePrices ||
    mainPrice.originalPricesWithoutPromotion ||
    mainPrice.priceModel?.currentPrices ||
    [];

  const mix = order.mixParam || raw.mixModel || {};
  const beginNum =
    order.beginNum != null
      ? String(order.beginNum)
      : trade.offerBeginAmount != null
        ? String(trade.offerBeginAmount)
        : "1";

  return {
    begin_num: beginNum,
    stock: Number(
      order.canBookedAmount ?? trade.canBookedAmountOriginal ?? 0
    ),
    sell_unit: raw.tempModel?.offerUnit || mainPrice.unit || "个",
    sku_param: (skuParam || []).map((p) => ({
      beginAmount: String(p.beginAmount ?? "1"),
      price: Number(p.price),
    })),
    mix_param: {
      mixAmount: String(mix.mixAmount ?? "0"),
      mixBegin: String(mix.mixBegin ?? "0"),
      mixNum: String(mix.mixNum ?? mix.mixNumber ?? "0"),
      shopMixNum: String(mix.shopMixNum ?? "2147483647"),
      supportMix: String(mix.supportMix ?? mix.isSupportMix ?? false),
    },
  };
}

function buildVideoUrl(videoId, sellerUserId) {
  if (!videoId || videoId === 0 || videoId === "0") return null;
  if (!sellerUserId) {
    return `https://cloud.video.taobao.com/play/u/0/p/2/e/6/t/1/${videoId}.mp4`;
  }
  return `https://cloud.video.taobao.com/play/u/${sellerUserId}/p/2/e/6/t/1/${videoId}.mp4`;
}

/**
 * @param {object} raw - output of extractRawOffer()
 * @returns {{ code: number, msg: string, data: object }}
 */
export function toTmapiItemDetail(raw) {
  const temp = raw.tempModel || {};
  const skuModel = raw.skuModel || {};
  const title =
    raw.title ||
    temp.offerTitle ||
    raw.documentTitle?.replace(/\s*-\s*阿里巴巴.*$/, "") ||
    "";

  const skuProps = buildSkuProps(skuModel.skuProps);
  const skus = buildSkus(
    skuModel.skuInfoMap || skuModel.skuInfoMapOriginal,
    skuProps
  );

  const min = raw.mainPrice?.finalPriceModel?.tradeWithoutPromotion?.offerMinPrice;
  const max = raw.mainPrice?.finalPriceModel?.tradeWithoutPromotion?.offerMaxPrice;
  const scale =
    skuModel.skuPriceScale ||
    (min && max ? `${min}-${max}` : min || "");
  const scaleOriginal =
    skuModel.skuPriceScaleOriginal ||
    scale;

  const sellerUserId =
    temp.sellerUserId || raw.seller?.frontSellerUserId || "";
  const memberId =
    temp.sellerMemberId || raw.seller?.frontSellerMemberId || "";
  const shopName =
    temp.companyName ||
    raw.shopInfo?.authCompanyName ||
    raw.shopInfo?.companyName ||
    temp.sellerLoginId ||
    "";

  const mainImgs =
    (raw.images && raw.images.length ? raw.images : null) ||
    raw.galleryImgs ||
    [];

  const saleCount =
    raw.saleNum != null
      ? String(raw.saleNum)
      : temp.saledCount != null
        ? String(temp.saledCount)
        : "0";

  const data = {
    item_id: Number(temp.offerId || raw.offerId),
    title,
    category_id: Number(
      raw.leafCategoryId || temp.postCategoryId || raw.categoryId || 0
    ),
    root_category_id: String(temp.topCategoryId ?? ""),
    currency: "CNY",
    offer_unit: temp.offerUnit || raw.mainPrice?.unit || "个",
    product_props: buildProductProps(raw),
    main_imgs: mainImgs,
    video_url: buildVideoUrl(raw.videoId, sellerUserId),
    detail_url:
      raw.detailUrl ||
      `https://detail.1688.com/offer/${temp.offerId || raw.offerId}.html`,
    sale_count: saleCount,
    shop_info: {
      shop_name: shopName,
      shop_url:
        temp.winportUrl ||
        (memberId
          ? `https://winport.m.1688.com/page/index.html?memberId=${memberId}`
          : ""),
      seller_login_id: temp.sellerLoginId || raw.seller?.frontSellerLoginId || "",
      seller_user_id: String(sellerUserId || ""),
      seller_member_id: String(memberId || ""),
    },
    delivery_info: raw.deliveryInfo ?? null,
    sku_price_scale: scale ? (String(scale).startsWith("￥") ? scale : `￥${String(scale).replace(/-/g, "-￥")}`) : "",
    sku_price_scale_original: scaleOriginal
      ? String(scaleOriginal).startsWith("￥")
        ? scaleOriginal
        : `￥${String(scaleOriginal).replace(/-/g, "-￥")}`
      : "",
    sku_price_range: buildPriceRange(raw),
    sku_props: skuProps,
    skus,
  };

  // Fix price scale formatting: "12.00-15.00" → "￥12.00-￥15.00"
  if (data.sku_price_scale && !/^￥.*￥/.test(data.sku_price_scale)) {
    const parts = String(scale).split("-");
    if (parts.length === 2) {
      data.sku_price_scale = `￥${parts[0]}-￥${parts[1]}`;
    } else {
      data.sku_price_scale = `￥${scale}`;
    }
  }
  if (
    data.sku_price_scale_original &&
    !/^￥.*￥/.test(data.sku_price_scale_original)
  ) {
    const parts = String(scaleOriginal).split("-");
    if (parts.length === 2) {
      data.sku_price_scale_original = `￥${parts[0]}-￥${parts[1]}`;
    } else {
      data.sku_price_scale_original = `￥${scaleOriginal}`;
    }
  }

  return {
    code: 200,
    msg: "success",
    data,
  };
}

export function tmapiError(code, msg) {
  return { code, msg };
}
