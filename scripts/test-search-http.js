import assert from "node:assert/strict";
import {
  mobileSearchWindow,
  parseMobileSearchHtml,
} from "../mobileSearch.js";
import {
  mapMtopSearchPayload,
  signMtopSearch,
} from "../mtopSearch.js";

const mobileFixture = `<!doctype html><html><body>
  <div>共 42 件</div>
  <a class="item-link promoted" href="https://dj.1688.com/click" offerid="874039857500">
    <div class="item-image">
      <img src="">
      <img class="image_src error" data-src="//cbu01.alicdn.com/img/ibank/example.jpg" alt="fallback title">
    </div>
    <div class="item-info_title"><span>记忆棉 <font>armrest pad</font></span></div>
    <span class="percent-re-purchase">复购率: 23%</span>
    <div class="info-tag"><span>深度验厂</span></div>
    <span class="count_price"><i>&yen;</i>10.45</span>
    <span class="count_vol">成交 200+笔</span>
    <span class="count_position">南通市</span>
  </a>
  <a class="item-link" offerid="874039857500">
    <div class="item-info_title">duplicate</div>
  </a>
</body></html>`;

const parsed = parseMobileSearchHtml(mobileFixture);
assert.equal(parsed.source, "mobile-http");
assert.equal(parsed.total, 42);
assert.equal(parsed.items.length, 1);
assert.deepEqual(parsed.items[0], {
  offerId: "874039857500",
  title: "记忆棉 armrest pad",
  price: "10.45",
  sales: "200+笔",
  repurchaseRate: "23%",
  company: null,
  location: "南通市",
  image: "https://cbu01.alicdn.com/img/ibank/example.jpg",
  url: "https://detail.1688.com/offer/874039857500.html",
  tags: ["深度验厂"],
  isAd: false,
});

assert.deepEqual(parseMobileSearchHtml("<html><body>共 0 件</body></html>"), {
  source: "mobile-http",
  total: 0,
  items: [],
});
assert.throws(
  () => parseMobileSearchHtml("<html>_____tmd_____ punish</html>"),
  /blocked by upstream verification/
);
assert.deepEqual(mobileSearchWindow(2, 5), {
  pageNo: 2,
  size: 5,
  offset: 5,
  end: 10,
  firstUpstreamPage: 1,
  sliceStart: 5,
  upstreamPageCount: 1,
});
assert.deepEqual(mobileSearchWindow(3, 15), {
  pageNo: 3,
  size: 15,
  offset: 30,
  end: 45,
  firstUpstreamPage: 2,
  sliceStart: 10,
  upstreamPageCount: 2,
});

assert.equal(
  signMtopSearch(
    "0123456789abcdef0123456789abcdef",
    "1700000000000",
    '{"appId":32517}'
  ),
  "c744ff482557a2b462f43bda221cae52"
);

const mtop = mapMtopSearchPayload({
  ret: ["SUCCESS::调用成功"],
  data: {
    data: {
      OFFER: {
        found: "60",
        hasMore: "true",
        items: [
          {
            data: {
              offerId: "1026909927879",
              title: "<font>Validated</font> offer",
              offerPicUrl: "https://cbu01.alicdn.com/img/ibank/valid.jpg",
              priceInfo: { price: "1.19" },
              bookedCount: "30",
              memberId: "b2b-member",
              loginId: "seller",
              province: "浙江",
              city: "诸暨市",
              shopAddition: { text: "Factory" },
              tags: [{ text: "7天无理由" }],
              isBid: "false",
            },
          },
          {
            data: {
              offerId: "not-numeric",
              title: "invalid",
              offerPicUrl: "javascript:alert(1)",
              priceInfo: { price: "0" },
            },
          },
        ],
      },
    },
  },
});
assert.equal(mtop.source, "mtop-search");
assert.equal(mtop.total, 60);
assert.equal(mtop.reportedPageSize, 60);
assert.equal(mtop.items.length, 1);
assert.equal(mtop.items[0].offerId, "1026909927879");
assert.equal(mtop.items[0].price, "1.19");
assert.equal(mtop.items[0].image, "https://cbu01.alicdn.com/img/ibank/valid.jpg");
assert.throws(
  () => mapMtopSearchPayload({ ret: ["FAIL_SYS_USER_VALIDATE"], data: {} }),
  /unsuccessful/
);

console.log("mobile HTTP + MTop search tests: OK");
