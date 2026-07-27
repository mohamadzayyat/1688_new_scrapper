#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser, acquirePooledBrowser, releaseBrowser, newFastContext } from "./browser.js";
import { toTmapiItemDetail, tmapiError } from "./tmapiFormat.js";
import { AUTH_PATH, hasSavedAuth } from "./auth.js";

function usage(exitCode = 1) {
  console.error(`Usage:
  node scrape.js <offerId> [--out path.json] [--headed]

Examples:
  node scrape.js 874039857500
  node scrape.js 874039857500 --out output/874039857500.json
  npm run scrape -- 874039857500 --out product.json`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { offerId: null, out: null, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--headed") args.headed = true;
    else if (a === "--out" || a === "-o") {
      args.out = argv[++i];
      if (!args.out) usage();
    } else if (!a.startsWith("-") && !args.offerId) {
      args.offerId = a.replace(/\.html$/i, "").replace(/^.*\//, "");
    } else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  if (!args.offerId || !/^\d+$/.test(args.offerId)) {
    console.error("Error: offer ID must be a number (e.g. 874039857500)");
    usage();
  }
  return args;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function pickSkuMap(mainPrice) {
  return (
    mainPrice?.finalPriceModel?.tradeWithoutPromotion?.skuMapOriginal ||
    mainPrice?.finalPriceModel?.tradeModel?.skuMapOriginal ||
    mainPrice?.skuMapOriginal ||
    []
  );
}

function normalizeLang(lang) {
  const value = String(lang || "zh").trim().toLowerCase();
  if (value === "en" || value === "english") return "en";
  return "zh";
}

function normalizeProduct(offerId, pageUrl, extracted, lang = "zh") {
  const title = extracted.productTitle || {};
  const mainPrice = extracted.mainPrice || {};
  const pack = extracted.productPackInfo || {};
  const gallery = extracted.gallery || {};
  const services = extracted.mainServices || {};
  const seller = extracted.seller || {};
  const shopInfo = title.shopInfo || {};

  const skuRaw = pickSkuMap(mainPrice);
  const weightInfo = pack.pieceWeightScale?.pieceWeightScaleInfo || [];
  const weightBySkuId = new Map(weightInfo.map((row) => [String(row.skuId), row]));

  const skus = skuRaw.map((sku) => {
    const attrs = decodeHtml(sku.specAttrs || "");
    const [color, size] = attrs.split(">").map((s) => s.trim());
    const dims = weightBySkuId.get(String(sku.skuId));
    return {
      skuId: sku.skuId,
      color: color || null,
      size: size || null,
      specAttrs: attrs || null,
      price: sku.discountPrice || sku.price || null,
      stock: sku.canBookCount ?? null,
      saleCount: sku.saleCount ?? 0,
      packing: dims
        ? {
            lengthCm: dims.length,
            widthCm: dims.width,
            heightCm: dims.height,
            volumeCm3: dims.volume,
            weightG: dims.weight,
          }
        : null,
    };
  });

  const prices = skus.map((s) => Number(s.price)).filter((n) => !Number.isNaN(n));
  const stocks = skus.map((s) => Number(s.stock)).filter((n) => !Number.isNaN(n));

  return {
    offerId: String(offerId),
    language: lang,
    url: pageUrl,
    scrapedAt: new Date().toISOString(),
    title: title.title || gallery.subject || extracted.documentTitle || null,
    titleCn: extracted.titleCn || null,
    price: {
      min: mainPrice?.finalPriceModel?.tradeWithoutPromotion?.offerMinPrice ||
        (prices.length ? String(Math.min(...prices)) : null),
      max: mainPrice?.finalPriceModel?.tradeWithoutPromotion?.offerMaxPrice ||
        (prices.length ? String(Math.max(...prices)) : null),
      display:
        mainPrice?.finalPriceModel?.tradeWithoutPromotion?.offerPriceDisplay ||
        null,
      unit: mainPrice?.unit || title.unit || null,
      currency: "CNY",
    },
    moq: mainPrice?.finalPriceModel?.tradeWithoutPromotion?.offerBeginAmount ?? 1,
    sales: {
      amount: title.saleNum || null,
      period: title.saleCountDate || null,
      label: title.newSaleCount || null,
    },
    stockTotal:
      mainPrice?.finalPriceModel?.tradeWithoutPromotion?.canBookedAmountOriginal ??
      (stocks.length ? stocks.reduce((a, b) => a + b, 0) : null),
    skus,
    packing: weightInfo.length
      ? {
          unitWeightG: pack.unitWeight || null,
          rows: weightInfo.map((row) => ({
            skuId: row.skuId,
            color: row.sku1 || null,
            size: row.sku2 || null,
            lengthCm: row.length,
            widthCm: row.width,
            heightCm: row.height,
            volumeCm3: row.volume,
            weightG: row.weight,
          })),
        }
      : null,
    seller: {
      companyName: shopInfo.authCompanyName || shopInfo.companyName || null,
      shopName: seller.frontSellerLoginId || null,
      memberId: seller.frontSellerMemberId || null,
      userId: seller.frontSellerUserId || null,
      serviceScore: shopInfo.sellerSlrServiceScore || null,
      repeatBuyRate: shopInfo.byrRepeatRate3m || null,
      cardType: shopInfo.cardType || null,
    },
    guarantees: (services.guaranteeList || []).map((g) => ({
      code: g.serviceCode || null,
      name: g.serviceName || null,
      description: g.description || null,
    })),
    images: extracted.images || gallery.offerImgList || [],
    categoryId: extracted.categoryId || null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOfferData(page, timeoutMs = 90_000) {
  const started = Date.now();
  let lastHint = "waiting for product data";

  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const data = window.context?.result?.data;
      const ready = Boolean(
        data?.mainPrice?.fields || data?.productTitle?.fields || data?.Root?.fields
      );
      const blocked =
        /验证| captcha|滑动|异常|访问受限|punish|security/i.test(text) &&
        !data?.mainPrice;

      return {
        ready,
        blocked,
        title: document.title || "",
        hasContext: Boolean(window.context),
      };
    });

    if (state.ready) return;
    if (state.blocked) {
      throw new Error(
        "1688 showed a verification/block page. Retry with --headed or try again later."
      );
    }

    lastHint = state.hasContext
      ? "page loaded, waiting for offer modules"
      : `loading (${state.title || "no title yet"})`;
    await sleep(500);
  }

  throw new Error(`Timed out after ${timeoutMs}ms: ${lastHint}`);
}

async function extractRawOffer(page, offerId) {
  return page.evaluate((oid) => {
    const data = window.context?.result?.data || {};
    const root = data.Root?.fields?.dataJson || {};
    const fieldsOf = (key) => data[key]?.fields || null;
    const bodyText = document.body?.innerText || "";

    // Prefer a dedicated attributes section if the DOM exposes one
    let attrText = "";
    const section = Array.from(document.querySelectorAll("*")).find((el) => {
      const t = el.innerText || "";
      return (
        /全部参数|商品参数|Product Attributes/.test(t) &&
        /材质|品牌|货号|产品类别/.test(t) &&
        el.children.length > 0 &&
        el.children.length < 120 &&
        t.length < 4000
      );
    });
    if (section) attrText = section.innerText || "";

    if (!attrText) {
      const markers = ["全部参数", "商品参数", "Product Attributes"];
      for (const marker of markers) {
        const idx = bodyText.indexOf(marker);
        if (idx >= 0) {
          attrText = bodyText.slice(Math.max(0, idx - 1200), idx);
          break;
        }
      }
    }
    if (!attrText) {
      const m = bodyText.match(
        /(?:材质|品牌|枕芯面料|货号|产品类别)[\s\S]{0,1200}?(?=全部参数|价格|登录查看|$)/
      );
      attrText = m?.[0] || "";
    }
    const matIdx = attrText.search(/材质|品牌|货号|枕芯|产品类别|品名/);
    if (matIdx > 0) attrText = attrText.slice(matIdx);

    const images = (root.images || [])
      .map((img) => img.fullPathImageURI)
      .filter(Boolean);

    return {
      offerId: oid,
      documentTitle: document.title || null,
      title: fieldsOf("productTitle")?.title || root.tempModel?.offerTitle || null,
      saleNum: fieldsOf("productTitle")?.saleNum ?? null,
      shopInfo: fieldsOf("productTitle")?.shopInfo || null,
      mainPrice: fieldsOf("mainPrice"),
      productPackInfo: fieldsOf("productPackInfo"),
      gallery: fieldsOf("gallery"),
      galleryImgs: fieldsOf("gallery")?.offerImgList || null,
      mainServices: fieldsOf("mainServices"),
      seller: root.frontSellerMemberModel || null,
      images:
        images.length > 0
          ? images
          : fieldsOf("gallery")?.offerImgList || [],
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
      attrText,
      productFeatureList:
        root.tempModel?.productFeatureList || root.productFeatureList || null,
      featureAttributes:
        root.tempModel?.featureAttributes || root.featureAttributes || null,
      deliveryInfo: null,
      shipping: fieldsOf("shippingServices"),
    };
  }, String(offerId));
}

async function waitForEnglishTranslation(page, timeoutMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const title =
        window.context?.result?.data?.productTitle?.fields?.title ||
        document.title ||
        "";
      const sku =
        window.context?.result?.data?.Root?.fields?.dataJson?.skuModel
          ?.skuProps?.[0]?.value?.[0]?.name || "";
      const looksEnglish =
        /[A-Za-z]{3,}/.test(title) && !/[\u4e00-\u9fff]{4,}/.test(title);
      const skuEnglish = /[A-Za-z]{3,}/.test(sku);
      return {
        looksEnglish: looksEnglish || skuEnglish,
        running: Boolean(window.__cgf_translator_running__),
        title,
      };
    });
    if (state.looksEnglish) return;
    await sleep(500);
  }
}

/**
 * TMAPI-compatible: Get 1688 product details by ID.
 * Returns exactly { code, msg, data } like
 * https://tmapi.top/docs/ali/item-detail/get-item-detail-by-id
 */
export async function getItemDetailById(
  itemId,
  { headed = false, language = "zh", optimize_title = false } = {}
) {
  const startedAt = Date.now();
  const lang = normalizeLang(language);
  const offerId = String(itemId || "").trim();
  if (!/^\d+$/.test(offerId)) {
    return tmapiError(422, "item_id must be a number");
  }

  const url = `https://detail.1688.com/offer/${offerId}.html`;
  const browser = headed
    ? await launchBrowser({ headed: true })
    : await acquirePooledBrowser();

  try {
    const contextOpts = {
      locale: lang === "en" ? "en-US" : "zh-CN",
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language":
          lang === "en"
            ? "en-US,en;q=0.9,zh-CN;q=0.5"
            : "zh-CN,zh;q=0.9,en;q=0.8",
      },
    };
    if (!headed && (await hasSavedAuth())) {
      contextOpts.storageState = AUTH_PATH;
    }

    const context = headed
      ? await browser.newContext(contextOpts)
      : await newFastContext(browser, { ...contextOpts, blockAssets: true });

    await context.addCookies([
      {
        name: "oversealanguage",
        value: lang === "en" ? "en" : "zh-CN",
        domain: ".1688.com",
        path: "/",
      },
    ]);

    const page = await context.newPage();
    let lastError;

    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await waitForOfferData(page, 35_000);
          if (lang === "en") {
            await waitForEnglishTranslation(page, 12_000);
          }
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight * 0.4)
          );
          await page
            .waitForFunction(
              () =>
                /全部参数|商品参数|Product Attributes|材质|品牌/.test(
                  document.body?.innerText || ""
                ),
              null,
              { timeout: 6_000 }
            )
            .catch(() => {});
          await page
            .evaluate(() => {
              const nodes = Array.from(
                document.querySelectorAll("a,button,span,div")
              );
              const btn = nodes.find((el) =>
                /全部参数|查看全部参数|Product Attributes/.test(
                  (el.textContent || "").trim()
                )
              );
              if (btn) btn.click();
            })
            .catch(() => {});
          await sleep(350);

          const raw = await extractRawOffer(page, offerId);
          if (!raw.title && !raw.skuModel && !raw.mainPrice) {
            throw new Error("Could not find product data on the page");
          }

          if (optimize_title && lang === "zh" && raw.title) {
            raw.title = String(raw.title)
              .replace(/\s+/g, " ")
              .replace(/(批发|厂家|直销|包邮)/g, "")
              .trim();
          }

          const result = toTmapiItemDetail(raw);
          const durationSeconds = Number(
            ((Date.now() - startedAt) / 1000).toFixed(2)
          );
          console.error(
            `[timing] item_detail ${offerId} (${lang}) ${durationSeconds}s`
          );
          return result;
        } catch (err) {
          lastError = err;
          if (attempt === 2) break;
          await sleep(600);
        }
      }
      return tmapiError(500, lastError?.message || "Scrape failed");
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    if (headed) await browser.close().catch(() => {});
    else releaseBrowser(browser);
  }
}

/** @deprecated use getItemDetailById — kept for older scripts */
export async function scrapeOffer(offerId, { headed = false, lang = "zh" } = {}) {
  return getItemDetailById(offerId, { headed, language: lang });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const product = await scrapeOffer(args.offerId, { headed: args.headed });
  const json = JSON.stringify(product, null, 2);

  if (args.out) {
    const outPath = resolve(args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json + "\n", "utf8");
    console.error(`Wrote ${outPath}`);
  }

  process.stdout.write(json + "\n");
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(`Scrape failed: ${err.message}`);
    process.exit(1);
  });
}
