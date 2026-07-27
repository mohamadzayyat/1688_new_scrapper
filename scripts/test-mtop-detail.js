import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runWithJobSignal } from "../jobContext.js";
import {
  mapMobileMtopToRaw,
  scrapeOfferMtop,
  signMtopDetail,
} from "../mtopDetail.js";
import { detailHttpAttemptOrder } from "../scrape.js";
import { toTmapiItemDetail } from "../tmapiFormat.js";

const OFFER_ID = "874039857500";
const TOKEN = "0123456789abcdef0123456789abcdef";

function mobileFixture(offerId = OFFER_ID) {
  return {
    data: {},
    componentData: {},
    globalData: {
      tempModel: {
        offerId,
        offerTitle: "Test mobile product",
        price: "10",
        offerUnit: "piece",
        postCategoryId: "123",
        topCategoryId: "12",
        sellerUserId: "seller-user",
        sellerLoginId: "seller-login",
        sellerMemberId: "seller-member",
        companyName: "Test supplier",
      },
      offerBaseInfo: { offerId },
      detailModel: {
        offerId,
        detailUrl: `https://air.1688.com/detail?offerId=${offerId}`,
      },
      orderParamModel: {
        orderParam: {
          canBookedAmount: "17",
          beginNum: "2",
          saledCount: "9",
          skuParam: {
            skuPriceType: "skuPrice",
            skuRangePrices: [
              { beginAmount: "2", price: "10" },
              { beginAmount: "2", price: "12" },
            ],
          },
          mixParam: { supportMix: false },
        },
      },
      images: [
        { fullPathImageURI: "https://cbu01.alicdn.com/img/test-main.jpg" },
        { fullPathImageURI: "https://cbu01.alicdn.com/img/test-second.jpg" },
      ],
      blackPage: {
        property: { propsList: [{ name: "Material", value: "Cotton" }] },
        service: { serviceDesc: [{ type: "return", serviceName: "Returns" }] },
      },
      mixModel: { isSupportMix: false },
    },
  };
}

function mtopFixture(offerId = OFFER_ID) {
  return {
    api: "mtop.1688.mmga.offerdetail.service",
    ret: ["SUCCESS::调用成功"],
    data: {
      resultCode: "ok",
      data: {
        minPrice: "10",
        odUrl: `https://m.1688.com/offer/${offerId}.html`,
        componentData: { offerId },
        globalData: {
          offerBaseInfo: {
            offerId,
            title: "Test mobile product",
            offerUnit: "piece",
            picUrl: "https://cbu01.alicdn.com/img/test-main.jpg",
            sellerUserId: "seller-user",
            sellerLoginId: "seller-login",
            sellerMemberId: "seller-member",
          },
          skuModelOrigin: {
            skuPriceScale: "10-12",
            skuProps: [
              {
                prop: "Color",
                value: [{ name: "Red" }, { name: "Blue" }],
              },
              {
                prop: "Size",
                value: [{ name: "Large" }],
              },
            ],
            skuInfoMap: {
              "Red&gt;Large": {
                skuId: "101",
                specId: "red-large",
                specAttrs: "Red&gt;Large",
                price: "10",
                discountPrice: "0",
                canBookCount: 8,
              },
              "Blue&gt;Large": {
                skuId: "102",
                specId: "blue-large",
                specAttrs: "Blue&gt;Large",
                price: "12",
                discountPrice: "12",
                canBookCount: 9,
              },
            },
          },
        },
      },
    },
  };
}

function mobileHtml(init = mobileFixture()) {
  return `<html><body>${"x".repeat(1_100)}<script>window.__INIT_DATA=${JSON.stringify(init)};</script></body></html>`;
}

class FakeResponse {
  constructor({ body, url, status = 200, contentType, bodyError = null }) {
    this.value = Buffer.from(body);
    this.bodyError = bodyError;
    this.finalUrl = url;
    this.statusCode = status;
    this.headerMap = {
      "content-type": contentType,
      "content-length": String(this.value.length),
    };
    this.disposed = false;
  }

  status() {
    return this.statusCode;
  }

  url() {
    return this.finalUrl;
  }

  headers() {
    return this.headerMap;
  }

  async body() {
    if (this.bodyError) throw this.bodyError;
    return this.value;
  }

  async dispose() {
    this.disposed = true;
  }
}

class FakeContext {
  constructor({
    failSigned = false,
    failSignedBody = false,
    failStorage = false,
    hang = false,
    failFirstMobile = false,
  } = {}) {
    this.failSigned = failSigned;
    this.failSignedBody = failSignedBody;
    this.failStorage = failStorage;
    this.hang = hang;
    this.failFirstMobile = failFirstMobile;
    this.records = [];
    this.cookies = [];
    this.disposed = false;
    this.mtopCalls = 0;
    this.mobileCalls = 0;
  }

  async get(url, options) {
    this.records.push({ url, options });
    if (this.hang) return new Promise(() => {});
    if (url.startsWith("https://m.1688.com/offer/")) {
      this.mobileCalls += 1;
      return new FakeResponse({
        body:
          this.failFirstMobile && this.mobileCalls === 1
            ? `<html>${"x".repeat(1_100)}</html>`
            : mobileHtml(),
        url: `https://m.1688.com/offer/${OFFER_ID}.html`,
        contentType: "text/html;charset=utf-8",
      });
    }
    this.mtopCalls += 1;
    if (this.mtopCalls === 1) {
      this.cookies = [
        {
          name: "_m_h5_tk",
          value: `${TOKEN}_9999999999999`,
          domain: ".1688.com",
        },
      ];
      return new FakeResponse({
        body: JSON.stringify({ ret: ["FAIL_SYS_TOKEN_EXOIRED::令牌过期"] }),
        url,
        contentType: "application/json",
      });
    }
    if (this.failSigned) {
      throw new Error(`secret upstream URL ${url}?sign=do-not-leak token=${TOKEN}`);
    }
    return new FakeResponse({
      body: JSON.stringify(mtopFixture()),
      url,
      contentType: "application/json;charset=utf-8",
      bodyError: this.failSignedBody
        ? new Error(`secret body URL ${url}?sign=do-not-leak token=${TOKEN}`)
        : null,
    });
  }

  async storageState() {
    if (this.failStorage) {
      throw new Error(`secret storage sign=do-not-leak token=${TOKEN}`);
    }
    return { cookies: this.cookies, origins: [] };
  }

  async dispose() {
    this.disposed = true;
  }
}

function pairFactory(mtopContext, mobileContext) {
  const contexts = [mtopContext, mobileContext];
  let index = 0;
  return async () => {
    const context = contexts[index++];
    if (!context) throw new Error("unexpected extra context");
    return context;
  };
}

const raw = mapMobileMtopToRaw(OFFER_ID, mobileFixture(), mtopFixture());
const detail = toTmapiItemDetail(raw);
assert.equal(detail.code, 200);
assert.equal(String(detail.data.item_id), OFFER_ID);
assert.equal(detail.data.title, "Test mobile product");
assert.equal(detail.data.price, "10");
assert.equal(detail.data.moq, 2);
assert.equal(detail.data.stock, 17);
assert.equal(detail.data.main_imgs.length, 2);
assert.equal(detail.data.category_id, 123);
assert.equal(detail.data.product_props[0].Material, "Cotton");
assert.equal(detail.data.skus.length, 2);
assert.equal(detail.data.skus[0].sale_price, "10");
assert.equal(detail.data.sku_props.length, 2);
assert.ok(detail.data.sku_props.every((prop) => /^\d+$/.test(prop.pid)));
assert.ok(
  detail.data.skus.every((sku) =>
    sku.props_ids.split(";").every((pair) => /^\d+:\d+$/.test(pair))
  )
);

assert.throws(
  () => mapMobileMtopToRaw(OFFER_ID, mobileFixture("999"), mtopFixture()),
  /different offer/
);
const incomplete = mtopFixture();
incomplete.data.data.globalData.skuModelOrigin.skuInfoMap = {};
assert.throws(
  () => mapMobileMtopToRaw(OFFER_ID, mobileFixture(), incomplete),
  /incomplete variants/
);
const duplicateCombination = mtopFixture();
duplicateCombination.data.data.globalData.skuModelOrigin.skuInfoMap["duplicate"] = {
  ...duplicateCombination.data.data.globalData.skuModelOrigin.skuInfoMap[
    "Red&gt;Large"
  ],
  skuId: "103",
};
assert.throws(
  () => mapMobileMtopToRaw(OFFER_ID, mobileFixture(), duplicateCombination),
  /duplicate variant combinations/
);

const signatureData = '{"test":true}';
assert.equal(
  signMtopDetail(TOKEN, "1234", signatureData),
  createHash("md5")
    .update(`${TOKEN}&1234&12574478&${signatureData}`)
    .digest("hex")
);
assert.deepEqual(detailHttpAttemptOrder(false), ["mobile-mtop", "desktop-http"]);
assert.deepEqual(detailHttpAttemptOrder(true), ["desktop-http", "mobile-mtop"]);

const context = new FakeContext();
const mobileContext = new FakeContext();
const fetched = await scrapeOfferMtop(OFFER_ID, {
  deadline: Date.now() + 5_000,
  contextFactory: pairFactory(context, mobileContext),
});
assert.equal(fetched.orderParam.canBookedAmount, 17);
assert.equal(context.disposed, true);
assert.equal(mobileContext.disposed, true);
const mtopRequests = context.records.filter((entry) => entry.url.includes("h5api.m.1688.com"));
assert.equal(mtopRequests.length, 2);
assert.equal(context.mobileCalls, 0);
assert.equal(mobileContext.mtopCalls, 0);
assert.equal(mobileContext.mobileCalls, 1);
assert.ok(context.records.every((entry) => entry.options.maxRedirects === 0));
assert.ok(mobileContext.records.every((entry) => entry.options.maxRedirects === 0));
assert.equal(mtopRequests[0].options.params.isSec, "0");
assert.equal(mtopRequests[0].options.params.timeout, "20000");
assert.equal(mtopRequests[0].options.params.api, "mtop.1688.mmga.offerdetail.service");
assert.equal(mtopRequests[0].options.params.sign, signMtopDetail(
  "",
  mtopRequests[0].options.params.t,
  mtopRequests[0].options.params.data
));
assert.equal(mtopRequests[1].options.params.sign, signMtopDetail(
  TOKEN,
  mtopRequests[1].options.params.t,
  mtopRequests[1].options.params.data
));
assert.deepEqual(JSON.parse(mtopRequests[1].options.params.data), {
  mmgaRequest: { serviceName: "wirelessLightOfferService", offerId: OFFER_ID },
});

const sentinelPayload = mtopFixture();
for (const row of Object.values(
  sentinelPayload.data.data.globalData.skuModelOrigin.skuInfoMap
)) {
  row.canBookCount = 1_000_000_000;
}
const sentinelDetail = toTmapiItemDetail(
  mapMobileMtopToRaw(OFFER_ID, mobileFixture(), sentinelPayload)
);
assert.equal(sentinelDetail.data.stock, 17);
assert.deepEqual(
  [...new Set(sentinelDetail.data.skus.map((sku) => sku.stock))],
  [17]
);

const retryContext = new FakeContext();
const retryMobileContext = new FakeContext({ failFirstMobile: true });
const retried = await scrapeOfferMtop(OFFER_ID, {
  deadline: Date.now() + 5_000,
  contextFactory: pairFactory(retryContext, retryMobileContext),
});
assert.equal(retried.orderParam.canBookedAmount, 17);
assert.equal(retryMobileContext.mobileCalls, 1);
assert.equal(retryContext.mobileCalls, 1);
assert.equal(retryContext.disposed, true);
assert.equal(retryMobileContext.disposed, true);

const failedContext = new FakeContext({ failSigned: true });
const failedMobileContext = new FakeContext();
await assert.rejects(
  scrapeOfferMtop(OFFER_ID, {
    deadline: Date.now() + 5_000,
    contextFactory: pairFactory(failedContext, failedMobileContext),
  }),
  (error) => {
    assert.equal(error.message, "Mobile item detail request failed");
    assert.doesNotMatch(error.message, /https?:|do-not-leak|012345abcdef/i);
    return true;
  }
);
assert.equal(failedContext.disposed, true);
assert.equal(failedMobileContext.disposed, true);

for (const [kind, unsafeContext, expectedMessage] of [
  [
    "body",
    new FakeContext({ failSignedBody: true }),
    "Mobile item detail response could not be read",
  ],
  [
    "storage",
    new FakeContext({ failStorage: true }),
    "Mobile item-detail token state was unavailable",
  ],
]) {
  const safeMobileContext = new FakeContext();
  await assert.rejects(
    scrapeOfferMtop(OFFER_ID, {
      deadline: Date.now() + 5_000,
      contextFactory: pairFactory(unsafeContext, safeMobileContext),
    }),
    (error) => {
      assert.equal(error.message, expectedMessage, kind);
      assert.doesNotMatch(error.message, /https?:|do-not-leak|012345abcdef/i);
      return true;
    }
  );
  assert.equal(unsafeContext.disposed, true);
  assert.equal(safeMobileContext.disposed, true);
}

const hangingContext = new FakeContext({ hang: true });
const hangingMobileContext = new FakeContext({ hang: true });
const controller = new AbortController();
const cancelled = runWithJobSignal(controller.signal, () =>
  scrapeOfferMtop(OFFER_ID, {
    deadline: Date.now() + 5_000,
    contextFactory: pairFactory(hangingContext, hangingMobileContext),
  })
);
queueMicrotask(() => controller.abort());
await assert.rejects(cancelled, (error) => error?.code === 499 && error?.cancelled);
assert.equal(hangingContext.disposed, true);
assert.equal(hangingMobileContext.disposed, true);

const delayedContexts = [new FakeContext(), new FakeContext()];
let delayedIndex = 0;
const delayedController = new AbortController();
const delayed = runWithJobSignal(delayedController.signal, () =>
  scrapeOfferMtop(OFFER_ID, {
    deadline: Date.now() + 5_000,
    contextFactory: () =>
      new Promise((resolve) => {
        const context = delayedContexts[delayedIndex++];
        setTimeout(() => resolve(context), 40);
      }),
  })
);
queueMicrotask(() => delayedController.abort());
await assert.rejects(delayed, (error) => error?.code === 499 && error?.cancelled);
await new Promise((resolve) => setTimeout(resolve, 80));
assert.ok(delayedContexts.every((lateContext) => lateContext.disposed));

console.log("MTop mobile item-detail tests passed");
