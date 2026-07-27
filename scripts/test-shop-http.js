import assert from "node:assert/strict";
import {
  fetchShopCategoriesHttp,
  fetchShopItemsHttp,
  parseShopCategoriesHtml,
  parseShopInfoHtml,
  parseShopItemsHtml,
  shopOfferListHttpUrl,
} from "../shopHttp.js";

const MEMBER = "b2b-221822542203833240";

function card(id, title, price, sales = 10) {
  return `
    <div class="item item-table">
      <a href="https://detail.m.1688.com/page/index.html?offerId=${id}">
        <div class="item-image"><img data-src="//cbu01.alicdn.com/${id}.jpg"></div>
        <div class="item-title"><div class="title"><p class="table">${title}</p></div></div>
        <span class="price">${price}</span>
        <span class="count table">成交${sales}笔</span>
      </a>
    </div>`;
}

function offerPage(cards) {
  return `<!doctype html><html><head>
    <title>义乌市云枕家居用品有限公司 - 阿里巴巴</title>
    <meta name="keywords" content="义乌市云枕家居用品有限公司">
    <meta name="description" content="专业枕头制造商">
    </head><body data-member="${MEMBER}">
    <input value='{&quot;ctoken&quot;:&quot;test-token-pineneedle&quot;}'>
    ${cards.join("\n")}</body></html>`;
}

const cards = [
  card("100000001", "记忆棉&amp;枕头", "12.50", "1,234"),
  card("100000002", "护颈枕", "15", 50),
  card("100000003", "腰靠", "20", 40),
  card("100000004", "坐垫", "25", 30),
  card("100000005", "旅行枕", "30", 20),
];

const parsedItems = parseShopItemsHtml(offerPage(cards));
assert.equal(parsedItems.length, 5);
assert.equal(parsedItems[0].item_id, "100000001");
assert.equal(parsedItems[0].title, "记忆棉&枕头");
assert.equal(parsedItems[0].img, "https://cbu01.alicdn.com/100000001.jpg");
assert.equal(parsedItems[0].price, "12.5");
assert.equal(parsedItems[0].sale_quantity, 1234);
assert.equal(
  parseShopItemsHtml(
    card("100000099", "unsafe image", "10").replace(
      "//cbu01.alicdn.com/100000099.jpg",
      "https://example.com/untrusted.jpg"
    )
  ).length,
  0
);

const info = parseShopInfoHtml(offerPage(cards.slice(0, 1)), MEMBER);
assert.equal(info.member_id, MEMBER);
assert.equal(info.shop_name, "义乌市云枕家居用品有限公司");
assert.equal(info.description, "专业枕头制造商");
assert.match(info.shop_url, /memberId=b2b-221822542203833240/);

const categoryHtml = `
  <div data-member="${MEMBER}">
    <a href="//m.1688.com/page/offerlist.html?catId=209861188&amp;catPid=&amp;title=%E8%AE%B0%E5%BF%86%E6%9E%95&amp;memberId=${MEMBER}">
      <div class="name">记忆枕</div>
    </a>
    <a href="//m.1688.com/page/offerlist.html?catId=-2&amp;catPid=&amp;title=%E6%9C%AA%E5%88%86%E7%B1%BB&amp;memberId=${MEMBER}">
      <div class="name">未分类</div>
    </a>
  </div>`;
const parsedCategories = parseShopCategoriesHtml(categoryHtml, MEMBER);
assert.equal(parsedCategories.categories.length, 2);
assert.equal(parsedCategories.categories[0].shop_cat_id, "209861188");
assert.equal(parsedCategories.categories[0].name, "记忆枕");

const listUrl = new URL(
  shopOfferListHttpUrl({
    memberId: MEMBER,
    pageIndex: 2,
    pageSize: 5,
    categoryId: "209861188",
    sort: "sales",
    keyword: "pillow",
    priceStart: "10",
    priceEnd: "30",
  })
);
assert.equal(listUrl.searchParams.get("pageIndex"), "2");
assert.equal(listUrl.searchParams.get("pageSize"), "5");
assert.equal(listUrl.searchParams.get("catId"), "209861188");
assert.equal(listUrl.searchParams.get("isUserDefined"), "true");
assert.equal(listUrl.searchParams.get("sortType"), "tradenumdown");
assert.equal(listUrl.searchParams.get("keywords"), "pillow");

function response(text, url, contentType = "text/html; charset=utf-8") {
  return {
    status: () => 200,
    url: () => url,
    headers: () => ({ "content-type": contentType }),
    body: async () => Buffer.from(text),
    dispose: async () => {},
  };
}

let requestedOfferUrl = null;
const directItems = await fetchShopItemsHttp(
  { memberId: MEMBER, page: 2, pageSize: 2 },
  {
    contextFactory: async () => ({
      get: async (url) => {
        requestedOfferUrl = new URL(url);
        return response(offerPage(cards), url);
      },
      dispose: async () => {},
    }),
  }
);
assert.equal(requestedOfferUrl.searchParams.get("pageIndex"), "1");
assert.equal(requestedOfferUrl.searchParams.get("pageSize"), "5");
assert.deepEqual(directItems.items.map((item) => item.item_id), ["100000003", "100000004"]);
assert.equal(directItems.totalCount, 5);
assert.equal(directItems.hasNext, true);

const categoryRequests = [];
const directCategories = await fetchShopCategoriesHttp(
  { memberId: MEMBER },
  {
    contextFactory: async () => ({
      get: async (url) => {
        categoryRequests.push(new URL(url));
        if (categoryRequests.length === 1) return response(offerPage(cards.slice(0, 1)), url);
        return response(
          JSON.stringify({ success: true, content: categoryHtml }),
          url,
          "application/json; charset=utf-8"
        );
      },
      dispose: async () => {},
    }),
  }
);
assert.equal(categoryRequests.length, 2);
assert.equal(categoryRequests[1].searchParams.get("_async_id"), "category:view");
assert.equal(categoryRequests[1].searchParams.get("ctoken"), "test-token-pineneedle");
assert.equal(directCategories.categories.length, 2);

await assert.rejects(
  fetchShopCategoriesHttp(
    { memberId: MEMBER },
    {
      contextFactory: async () => {
        let count = 0;
        return {
          get: async (url) => {
            count++;
            if (count === 1) return response(offerPage(cards.slice(0, 1)), url);
            return response(
              JSON.stringify({ success: true, content: categoryHtml }),
              "https://example.com/redirected",
              "application/json"
            );
          },
          dispose: async () => {},
        };
      },
    }
  ),
  /redirected unexpectedly/
);

console.log("shop proxy HTTP tests: OK");
