#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { request } from "playwright";
import { launchBrowser, acquirePooledBrowser, releaseBrowser, newFastContext } from "./browser.js";
import { getPlaywrightProxy } from "./proxy.js";
import { currentJobSignal, jobAbortError } from "./jobContext.js";
import { toTmapiItemDetail, tmapiError } from "./tmapiFormat.js";
import { scrapeOfferMtop } from "./mtopDetail.js";
import { AUTH_PATH, hasSavedAuth } from "./auth.js";
import {
  parseOfferContextFromHtml,
  contextToRawOffer,
  isUsableRawOffer,
} from "./offerContext.js";
import { translateItemDetailData } from "./translate.js";

const ITEM_SCRAPE_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.ITEM_SCRAPE_TIMEOUT_MS) || 34_000
);
const ITEM_HTTP_TIMEOUT_MS = Math.max(
  800,
  Math.min(10_000, Number(process.env.ITEM_HTTP_TIMEOUT_MS) || 3_500)
);

export function offerUrlMatches(url, offerId) {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();
    if (!(host === "1688.com" || host.endsWith(".1688.com"))) return false;
    const path = parsed.pathname.replace(/\/+$/, "");
    return path === `/offer/${String(offerId)}` || path === `/offer/${String(offerId)}.html`;
  } catch {
    return false;
  }
}

let offerHttpClient = null;
let offerHttpClientCreating = null;
const retiredOfferHttpClients = new Set();

async function offerHttpClientSnapshot() {
  const proxy = getPlaywrightProxy();
  let storageState;
  let authKey = "none";
  try {
    const [info, raw] = await Promise.all([
      stat(AUTH_PATH),
      readFile(AUTH_PATH, "utf8"),
    ]);
    storageState = JSON.parse(raw);
    authKey = `${info.mtimeMs}:${info.size}`;
  } catch {
    storageState = { cookies: [], origins: [] };
  }
  if (!Array.isArray(storageState.cookies)) storageState.cookies = [];
  if (!Array.isArray(storageState.origins)) storageState.origins = [];

  const languageCookieIndex = storageState.cookies.findIndex(
    (cookie) =>
      cookie?.name === "oversealanguage" &&
      String(cookie?.domain || "").endsWith("1688.com")
  );
  const languageCookie = {
    name: "oversealanguage",
    domain: ".1688.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
    ...(languageCookieIndex >= 0
      ? storageState.cookies[languageCookieIndex]
      : {}),
    value: "zh-CN",
  };
  if (languageCookieIndex >= 0) {
    storageState.cookies[languageCookieIndex] = languageCookie;
  } else {
    storageState.cookies.push(languageCookie);
  }

  return {
    key: `${authKey}:${JSON.stringify(proxy || null)}`,
    proxy,
    storageState,
  };
}

async function getOfferHttpClient() {
  const snapshot = await offerHttpClientSnapshot();
  if (offerHttpClient?.key === snapshot.key) return offerHttpClient.context;
  if (offerHttpClientCreating) {
    await offerHttpClientCreating.catch(() => {});
    return getOfferHttpClient();
  }

  offerHttpClientCreating = request.newContext({
    storageState: snapshot.storageState,
    ...(snapshot.proxy ? { proxy: snapshot.proxy } : {}),
    extraHTTPHeaders: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Upgrade-Insecure-Requests": "1",
    },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  });

  try {
    const context = await offerHttpClientCreating;
    const previous = offerHttpClient?.context;
    offerHttpClient = { key: snapshot.key, context };
    if (previous && previous !== context) {
      retiredOfferHttpClients.add(previous);
      const timer = setTimeout(() => {
        retiredOfferHttpClients.delete(previous);
        void previous.dispose().catch(() => {});
      }, 30_000);
      timer.unref?.();
    }
    return context;
  } finally {
    offerHttpClientCreating = null;
  }
}

async function scrapeOfferHttp(offerId, url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 800) throw new Error("Item scrape deadline exceeded");
  const client = await getOfferHttpClient();
  let response;
  let removeAbortListener = () => {};
  const jobSignal = currentJobSignal();
  try {
    if (jobSignal?.aborted) throw jobAbortError(jobSignal);
    const responsePromise = client.get(url, {
      timeout: Math.min(ITEM_HTTP_TIMEOUT_MS, remaining),
      failOnStatusCode: false,
      headers: { Referer: "https://www.1688.com/" },
    });
    if (jobSignal) {
      if (jobSignal.aborted) {
        await responsePromise.then((late) => late.dispose()).catch(() => {});
        throw jobAbortError(jobSignal);
      }
      const aborted = new Promise((_, reject) => {
        const onAbort = () => reject(jobAbortError(jobSignal));
        jobSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => jobSignal.removeEventListener("abort", onAbort);
      });
      try {
        response = await Promise.race([responsePromise, aborted]);
      } catch (error) {
        if (error?.cancelled || error?.name === "AbortError") {
          // Playwright APIRequestContext cannot cancel an individual request.
          // Keep this queued job active until its short request timeout settles,
          // otherwise disconnect storms could create unbounded orphan requests.
          await responsePromise.then((late) => late.dispose()).catch(() => {});
        }
        throw error;
      }
    } else {
      response = await responsePromise;
    }
    const finalUrl = response.url();
    const status = response.status();
    const contentType = response.headers()["content-type"] || "";
    const html = await response.text();
    if (jobSignal?.aborted) throw jobAbortError(jobSignal);

    if (
      /login\.(?:1688|taobao)\.com|member\/signin/i.test(finalUrl) ||
      (!html.includes("window.context=") &&
        /login\.1688\.com\/member\/signin|login\.taobao\.com/i.test(html))
    ) {
      const error = new Error(
        "1688 login session is missing or expired; run npm run login:headless"
      );
      error.fastFail = true;
      throw error;
    }
    if (status === 429 || /punish|captcha|访问受限/i.test(finalUrl + html.slice(0, 50_000))) {
      const error = new Error("1688 blocked the direct product request");
      error.directBlocked = true;
      throw error;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Direct product request returned HTTP ${status}`);
    }
    if (contentType && !/html|xhtml/i.test(contentType)) {
      throw new Error(`Direct product request returned ${contentType}`);
    }
    if (!offerUrlMatches(finalUrl, offerId)) {
      throw new Error("Direct product request redirected away from the offer");
    }

    const parsed = parseOfferContextFromHtml(html);
    if (!parsed) throw new Error("Direct product HTML did not include offer context");
    const embeddedId = offerContextId(parsed);
    if (embeddedId != null && String(embeddedId) !== offerId) {
      throw new Error(
        `Direct product HTML contained offer ${embeddedId}, expected ${offerId}`
      );
    }
    const raw = contextToRawOffer(offerId, parsed);
    if (!isUsableRawOffer(raw)) {
      throw new Error("Direct product HTML contained incomplete offer data");
    }
    return raw;
  } finally {
    removeAbortListener();
    await response?.dispose().catch(() => {});
  }
}

function offerContextId(context) {
  return (
    context?.result?.data?.Root?.fields?.dataJson?.tempModel?.offerId ??
    context?.result?.data?.Root?.fields?.dataJson?.offerId ??
    context?.result?.data?.productTitle?.fields?.offerId ??
    null
  );
}

function rawMatchesOfferId(raw, offerId) {
  const embeddedId = raw?.tempModel?.offerId ?? raw?.tempModel?.id ?? null;
  return embeddedId == null || String(embeddedId) === String(offerId);
}

export async function closeOfferHttpClient() {
  await offerHttpClientCreating?.catch(() => {});
  const contexts = [
    offerHttpClient?.context,
    ...retiredOfferHttpClients,
  ].filter(Boolean);
  offerHttpClient = null;
  retiredOfferHttpClients.clear();
  await Promise.allSettled(contexts.map((context) => context.dispose()));
}

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

export function detailHttpAttemptOrder(hasSavedSession) {
  return hasSavedSession
    ? ["desktop-http", "mobile-mtop"]
    : ["mobile-mtop", "desktop-http"];
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
 *
 * Fast path: parse `window.context` from the HTML document as soon as it
 * arrives (no DOM waits / on-page translator). Falls back to full page scrape.
 */
export async function getItemDetailById(
  itemId,
  { headed = false, language = "zh", optimize_title = false } = {}
) {
  const startedAt = Date.now();
  const deadline = startedAt + ITEM_SCRAPE_TIMEOUT_MS;
  const lang = normalizeLang(language);
  const offerId = String(itemId || "").trim();
  if (!/^\d+$/.test(offerId)) {
    return tmapiError(422, "item_id must be a number");
  }

  const url = `https://detail.1688.com/offer/${offerId}.html`;
  const finish = async (raw, path, timingPath = path) => {
    if (optimize_title && raw.title) {
      raw.title = String(raw.title)
        .replace(/\s+/g, " ")
        .replace(/(批发|厂家|直销|包邮)/g, "")
        .trim();
    }

    const result = toTmapiItemDetail(raw);
    if (result.code === 200 && lang === "en" && result.data) {
      await translateItemDetailData(result.data);
      if (result.data.__translationIncomplete) {
        Object.defineProperty(result, "__scraperNoCache", {
          value: true,
          enumerable: false,
        });
      }
    }
    if (currentJobSignal()?.aborted) {
      throw jobAbortError(currentJobSignal());
    }
    if (Date.now() > deadline) {
      const error = new Error("Item scrape deadline exceeded");
      error.code = 504;
      throw error;
    }
    Object.defineProperty(result, "__scraperPath", {
      value: path,
      enumerable: false,
    });

    const durationSeconds = Number(
      ((Date.now() - startedAt) / 1000).toFixed(2)
    );
    console.error(
      `[timing] item_detail ${offerId} (${lang}) ${durationSeconds}s path=${timingPath}`
    );
    return result;
  };

  let lastError;
  let savedAuth = false;
  if (!headed) {
    savedAuth = await hasSavedAuth();
    for (const path of detailHttpAttemptOrder(savedAuth)) {
      if (Date.now() >= deadline) break;
      try {
        if (path === "desktop-http") {
          const raw = await scrapeOfferHttp(offerId, url, deadline);
          return await finish(raw, "http");
        }

        // The anonymous mobile page has accurate order totals/images while
        // the signed MTop response supplies the complete SKU matrix.
        const raw = await scrapeOfferMtop(offerId, { deadline });
        // Keep the public compatibility header as `http`; timing logs retain
        // the precise source so operators can compare paths independently.
        return await finish(raw, "http", "mobile-mtop");
      } catch (err) {
        if (currentJobSignal()?.aborted || err?.cancelled || err?.code === 499) {
          throw jobAbortError(currentJobSignal());
        }
        lastError = err;
      }
    }
  }

  if (Date.now() >= deadline) {
    return tmapiError(500, lastError?.message || "Item scrape deadline exceeded");
  }
  const browser = headed
    ? await launchBrowser({ headed: true })
    : await acquirePooledBrowser();

  const buildContextOpts = () => ({
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (Date.now() >= deadline) break;
      const contextOpts = buildContextOpts();
      if (!headed && savedAuth) {
        contextOpts.storageState = AUTH_PATH;
      }

      // Attempt 1: document-only (fastest). Attempt 2: allow page JS hydrate.
      const documentOnly = !headed && attempt === 1;
      const context = headed
        ? await browser.newContext(contextOpts)
        : await newFastContext(browser, {
            ...contextOpts,
            blockAssets: true,
            documentOnly,
          });

      try {
        await context.addCookies([
          {
            name: "oversealanguage",
            value: "zh-CN",
            domain: ".1688.com",
            path: "/",
          },
        ]);

        const page = await context.newPage();
        const raw = await scrapeOfferFast(page, offerId, url, {
          allowHydrate: !documentOnly,
          deadline,
        });
        if (!isUsableRawOffer(raw) || !rawMatchesOfferId(raw, offerId)) {
          throw new Error("Could not find product data on the page");
        }
        return await finish(raw, "browser");
      } catch (err) {
        if (currentJobSignal()?.aborted || err?.cancelled || err?.code === 499) {
          throw jobAbortError(currentJobSignal());
        }
        lastError = err;
        if (/login session|required login|login wall/i.test(err?.message || "")) {
          break;
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
    return tmapiError(500, lastError?.message || "Scrape failed");
  } finally {
    if (headed) await browser.close().catch(() => {});
    else releaseBrowser(browser);
  }
}

/**
 * Prefer HTML-embedded context (fast). Optionally wait for window.context hydrate.
 */
async function scrapeOfferFast(
  page,
  offerId,
  url,
  { allowHydrate = false, deadline = Infinity } = {}
) {
  /** @type {any} */
  let fromHtml = null;
  let htmlBytes = 0;
  let loginWall = false;

  const onResponse = async (res) => {
    try {
      if (res.request().resourceType() !== "document") return;
      if (/login\.(?:1688|taobao)\.com|member\/signin/i.test(res.url())) {
        loginWall = true;
        return;
      }
      if (!offerUrlMatches(res.url(), offerId)) return;
      const html = await res.text();
      htmlBytes = html.length;
      if (
        !html.includes("window.context=") &&
        /login\.1688\.com\/member\/signin|login\.taobao\.com/i.test(html)
      ) {
        loginWall = true;
        return;
      }
      const ctx = parseOfferContextFromHtml(html);
      if (ctx && (offerContextId(ctx) == null || String(offerContextId(ctx)) === offerId)) {
        const raw = contextToRawOffer(offerId, ctx);
        if (isUsableRawOffer(raw)) fromHtml = raw;
      }
    } catch {
      // ignore — fall back below
    }
  };

  page.on("response", onResponse);
  try {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw new Error("Item scrape deadline exceeded");
    await page.goto(url, {
      waitUntil: allowHydrate ? "domcontentloaded" : "commit",
      timeout: Math.min(allowHydrate ? 18_000 : 12_000, remaining),
    });

    if (!offerUrlMatches(page.url(), offerId)) {
      throw new Error("Product page redirected away from the requested offer");
    }

    if (
      loginWall ||
      /login\.(?:1688|taobao)\.com|member\/signin/i.test(page.url())
    ) {
      throw new Error(
        "1688 login session is missing or expired; run npm run login:headless"
      );
    }

    const dataDeadline = Math.min(
      deadline,
      Date.now() + (allowHydrate ? 8_000 : 5_000)
    );
    while (!fromHtml && !loginWall && Date.now() < dataDeadline) {
      await sleep(30);
      if (allowHydrate && !fromHtml) {
        const ready = await page
          .evaluate(() => {
            const d = window.context?.result?.data;
            return Boolean(
              d?.mainPrice?.fields || d?.productTitle?.fields || d?.Root?.fields
            );
          })
          .catch(() => false);
        if (ready) break;
      }
    }
    if (loginWall) {
      throw new Error(
        "1688 login session is missing or expired; run npm run login:headless"
      );
    }
    if (fromHtml) return fromHtml;

    if (allowHydrate) {
      const hydrateRemaining = deadline - Date.now();
      if (hydrateRemaining < 1_000) {
        throw new Error("Item scrape deadline exceeded");
      }
      await waitForOfferData(page, Math.min(8_000, hydrateRemaining));
      const raw = await extractRawOffer(page, offerId);
      if (isUsableRawOffer(raw)) return raw;
    }

    throw new Error(`Could not find product data (htmlBytes=${htmlBytes})`);
  } finally {
    page.off("response", onResponse);
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
  main()
    .catch((err) => {
      console.error(`Scrape failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => closeOfferHttpClient());
}
