import { launchBrowser } from "../browser.js";
import { writeFile } from "node:fs/promises";

const offerId = process.argv[2] || "874039857500";
const lang = process.argv[3] || "zh";
const browser = await launchBrowser({ headed: false });
const context = await browser.newContext({
  locale: lang === "en" ? "en-US" : "zh-CN",
  viewport: { width: 1440, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
});
await context.addCookies([
  {
    name: "oversealanguage",
    value: lang === "en" ? "en" : "zh-CN",
    domain: ".1688.com",
    path: "/",
  },
]);
const page = await context.newPage();
await page.goto(`https://detail.1688.com/offer/${offerId}.html`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await page.waitForTimeout(lang === "en" ? 12000 : 7000);

const dump = await page.evaluate(() => {
  const data = window.context?.result?.data || {};
  const root = data.Root?.fields?.dataJson || {};
  const bodyText = document.body?.innerText || "";

  // Attributes from DOM table (productAttributes module is lazy)
  const props = [];
  const rows = document.querySelectorAll(
    ".ant-descriptions-item, .od-product-attributes li, [class*='attribute'] tr, .offer-attr-list li"
  );
  // Also parse common param pairs from visible text blocks
  const attrSection = Array.from(document.querySelectorAll("*")).find((el) =>
    /商品参数|Product Attributes|全部参数/.test(el.innerText || "") &&
    el.children.length > 0 &&
    el.children.length < 80
  );

  return {
    title: data.productTitle?.fields?.title,
    saleNum: data.productTitle?.fields?.saleNum,
    unit: data.productTitle?.fields?.unit,
    shopInfo: data.productTitle?.fields?.shopInfo,
    seller: root.frontSellerMemberModel,
    images: (root.images || []).map((i) => i.fullPathImageURI),
    galleryImgs: data.gallery?.fields?.offerImgList,
    videoId: data.description?.fields?.detailVideoId || data.gallery?.fields?.video?.videoId,
    mainPrice: data.mainPrice?.fields,
    skuModel: root.skuModel,
    mixModel: root.mixModel,
    tempModel: root.tempModel,
    orderParam: root.orderParamModel?.orderParam,
    shipping: data.shippingServices?.fields,
    productPack: data.productPackInfo?.fields,
    // feature list if any
    featureAttributes: root.featureAttributes || root.productFeatureList || null,
    bodyAttrSnippet: (bodyText.match(/材质[\s\S]{0,800}/) || [])[0]?.slice(0, 800) || null,
    attrSectionText: attrSection?.innerText?.slice(0, 1500) || null,
    descriptionDetailUrl: data.description?.fields?.detailUrl || data.description?.fields?.offerDetailUrl,
  };
});

await writeFile(`output/raw-offer-${offerId}-${lang}.json`, JSON.stringify(dump, null, 2));
console.log(
  JSON.stringify(
    {
      title: dump.title,
      saleNum: dump.saleNum,
      skuProps: dump.skuModel?.skuProps,
      skuInfoMapKeys: Object.keys(dump.skuModel?.skuInfoMap || {}).slice(0, 3),
      skuInfoSample: Object.values(dump.skuModel?.skuInfoMap || {})[0],
      mixModel: dump.mixModel,
      tempModel: dump.tempModel,
      orderParamKeys: dump.orderParam ? Object.keys(dump.orderParam) : null,
      mixParam: dump.orderParam?.mixParam,
      priceRange: dump.mainPrice?.priceModel || dump.mainPrice?.originalPricesWithoutPromotion,
      seller: dump.seller,
      shopInfo: dump.shopInfo,
      videoId: dump.videoId,
      attrSnippet: dump.attrSectionText?.slice(0, 400),
      bodyAttr: dump.bodyAttrSnippet?.slice(0, 400),
    },
    null,
    2
  )
);
await browser.close();
