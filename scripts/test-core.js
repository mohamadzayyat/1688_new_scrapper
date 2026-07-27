import assert from "node:assert/strict";
import { cacheKey } from "../cache.js";
import {
  extractJsObject,
  isUsableRawOffer,
} from "../offerContext.js";
import { offerUrlMatches } from "../scrape.js";
import { toTmapiItemDetail } from "../tmapiFormat.js";
import {
  convertImageUrl,
  toTmapiSearch,
} from "../tmapiExtra.js";

const parsed = extractJsObject(
  "prefix {result:{data:{title:'safe } value', trailing:true,},},} suffix",
  7
);
assert.equal(parsed.result.data.title, "safe } value");
assert.equal(parsed.result.data.trailing, true);

delete globalThis.__offerParserExecuted;
const malicious = extractJsObject(
  "{safe:1, run:(globalThis.__offerParserExecuted=true)}",
  0
);
assert.equal(malicious, null);
assert.equal(globalThis.__offerParserExecuted, undefined);

assert.notEqual(
  cacheKey(["image", "https://example.com/A.JPG"]),
  cacheKey(["image", "https://example.com/a.jpg"])
);

const rawOffer = {
  offerId: "874039857500",
  title: "Test product",
  images: ["https://cbu01.alicdn.com/img/test.jpg"],
  mainPrice: {
    unit: "piece",
    finalPriceModel: {
      tradeWithoutPromotion: {
        offerMinPrice: "10",
        offerMaxPrice: "12",
        offerBeginAmount: 2,
        canBookedAmountOriginal: 50,
      },
    },
  },
  skuModel: {
    skuProps: [
      {
        fid: 1,
        prop: "Color",
        value: [{ name: "Red", vid: 2 }],
      },
    ],
    skuInfoMap: {
      red: {
        skuId: 3,
        specId: "red",
        specAttrs: "Red",
        price: "10",
        canBookCount: 50,
      },
    },
  },
  tempModel: {
    offerId: "874039857500",
    postCategoryId: "122234002",
    sellerMemberId: "b2b-test",
  },
  mainServices: {
    guaranteeList: [{ serviceCode: "return", serviceName: "Returns" }],
  },
};

assert.equal(isUsableRawOffer(rawOffer), true);
assert.equal(
  offerUrlMatches("https://detail.1688.com/offer/874039857500.html?spm=test", "874039857500"),
  true
);
assert.equal(
  offerUrlMatches("https://detail.1688.com/offer/8740398575000.html", "874039857500"),
  false
);
assert.equal(
  offerUrlMatches("https://example.com/offer/874039857500.html", "874039857500"),
  false
);
assert.equal(
  isUsableRawOffer({
    title: "Sparse product",
    images: ["https://cbu01.alicdn.com/img/sparse.jpg"],
    mainPrice: {},
  }),
  false
);
const detail = toTmapiItemDetail(rawOffer);
assert.equal(detail.code, 200);
assert.equal(detail.data.item_id, 874039857500);
assert.equal(detail.data.price_info.price_min, "10");
assert.equal(detail.data.price_info.price_max, "12");
assert.equal(detail.data.quantity_begin, 2);
assert.equal(detail.data.stock, 50);
assert.equal(detail.data.skus[0].props_ids, "1:2");
assert.equal(detail.data.skus[0].props_names, "Color:Red");
assert.equal(detail.data.service_tags[0].code, "return");

const search = toTmapiSearch(
  {
    total: 25,
    results: [{ offerId: "1", title: "One", price: 1 }],
  },
  { keyword: "one", page: 1, page_size: 20 }
);
assert.equal(search.data.total, 25);
assert.equal(search.data.has_next_page, true);

assert.equal(
  convertImageUrl("https://example.com/image.jpg").code,
  422
);
const converted = convertImageUrl(
  "https://cbu01.alicdn.com/img/test_100x100.jpg?token=AbC",
  { width: 220, height: 220 }
);
assert.equal(converted.code, 200);
assert.match(converted.data.image_url, /test_220x220\.jpg\?token=AbC$/);

console.log("core tests: OK");
