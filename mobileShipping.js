function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shippingScore(candidate, offerId) {
  if (!isObject(candidate)) return -1;
  const candidateId =
    candidate.offerId ?? candidate.offerID ?? candidate.itemId ?? candidate.item_id;
  // Shipping components are dynamically numbered in __INIT_DATA. The offer
  // identity is the stable authority boundary; a logistics-looking sibling
  // from another embedded offer must never supply this offer's fee.
  if (String(candidateId || "") !== String(offerId)) return -1;

  const keys = [
    "location",
    "logistics",
    "deliveryLimitTxt",
    "deliveryLimitText",
    "deliveryLimit",
    "sendAddressCode",
    "targetLocation",
    "amount",
    "templateId",
    "unitWeight",
    "postFeeValue",
    "postFree",
    "skuWeight",
  ];
  let score = keys.reduce(
    (total, key) => total + (candidate[key] !== undefined ? 1 : 0),
    0
  );
  score += 4;
  if (candidate.sendAddressCode != null) score += 2;
  if (candidate.templateId != null) score += 2;
  if (finiteNumber(candidate.postFeeValue) != null || candidate.postFree === true) {
    score += 2;
  }
  return score;
}

/**
 * Locate the dynamically-numbered logistics component in 1688 mobile
 * `window.__INIT_DATA`. Component IDs change between offers, so identify the
 * payload by its offer identity and shipping contract instead of a numeric ID.
 */
export function findMobileShippingData(root, offerIdValue) {
  const offerId = String(offerIdValue || "").trim();
  if (!/^\d+$/.test(offerId) || !isObject(root)) return null;

  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  let best = null;
  let bestScore = -1;
  let visited = 0;

  while (queue.length && visited < 20_000) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    visited += 1;

    if (isObject(value)) {
      const score = shippingScore(value, offerId);
      if (score > bestScore) {
        best = value;
        bestScore = score;
      }
    }

    if (depth >= 14) continue;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }

  // Requiring the identity plus the main logistics fields prevents an
  // unrelated component from being treated as an authoritative fee source.
  return bestScore >= 10 ? best : null;
}

export function mapMobileShipping(root, offerIdValue) {
  const source = findMobileShippingData(root, offerIdValue);
  if (!source) return null;

  const globalFreight = isObject(root?.globalData?.skuModel?.extraInfo?.freightInfo)
    ? root.globalData.skuModel.extraInfo.freightInfo
    : {};
  const sourceUnitWeight = finiteNumber(
    source.unitWeight ?? globalFreight.unitWeight
  );
  const unitWeight =
    sourceUnitWeight == null ? null : Math.max(0, sourceUnitWeight);
  const postFree = source.postFree === true || String(source.postFree) === "true";
  const explicitFee =
    finiteNumber(source.postFeeValue) ??
    finiteNumber(source.totalCost) ??
    finiteNumber(source.freightInfo?.totalCost);
  // Zero is authoritative only when 1688 explicitly says free/zero. Missing
  // fee data must remain unavailable instead of becoming a false free quote.
  if (!postFree && explicitFee == null) return null;
  const postFee = postFree ? 0 : Math.max(0, explicitFee);
  const logisticsText = String(
    source.logistics ||
      source.deliveryLimitTxt ||
      source.deliveryLimitText ||
      source.freightInfo?.logisticsText ||
      ""
  ).trim();
  const location = String(source.location || source.freightInfo?.location || "").trim();
  const skuWeight = isObject(source.skuWeight)
    ? source.skuWeight
    : isObject(globalFreight.skuWeight)
      ? globalFreight.skuWeight
    : isObject(source.freightInfo?.skuWeight)
      ? source.freightInfo.skuWeight
      : {};
  const templateId =
    source.templateId ??
    globalFreight.templateId ??
    source.freightInfo?.subTemplateId ??
    null;
  const sendAddressCode =
    source.sendAddressCode ?? globalFreight.sendAddressCode ?? null;

  return {
    unitWeight,
    postFeeValue: postFee,
    postFree,
    freeDeliverFee: postFree,
    templateId,
    sendAddressCode,
    sellerUserId: globalFreight.sellerUserId ?? source.sellerUserId ?? null,
    freeEndAmount:
      finiteNumber(globalFreight.freeEndAmount ?? source.freeEndAmount) ?? -1,
    officialLogistics:
      globalFreight.officialLogistics === true ||
      String(globalFreight.officialLogistics).toLowerCase() === "true",
    pageScene: String(root?.globalData?.channelType || "").trim() || "dsc",
    targetLocation: String(source.targetLocation || "").trim() || null,
    deliveryLimitText: logisticsText || null,
    deliveryLimit: source.deliveryLimit ?? null,
    logistics: logisticsText,
    location,
    unit: String(source.unit || "").trim() || null,
    amount: finiteNumber(source.amount),
    skuWeight,
    totalCost: postFee,
    freightInfo: {
      unitWeight,
      deliveryLimit: source.deliveryLimit ?? null,
      location,
      locationCode: sendAddressCode,
      subTemplateId: templateId,
      logisticsText: logisticsText || null,
      freeDeliverFee: postFree,
      totalCost: postFee,
      skuWeight,
    },
  };
}
