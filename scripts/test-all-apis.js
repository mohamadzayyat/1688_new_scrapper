const BASE = process.env.BASE || "http://localhost:3456";
const ITEM = "874039857500";
const URL = `https://detail.1688.com/offer/${ITEM}.html`;
const MEMBER = "b2b-221822542203833240";
const SHOP = `https://winport.m.1688.com/page/index.html?memberId=${MEMBER}`;
const IMG =
  "https://cbu01.alicdn.com/img/ibank/O1CN01AN5iRY1QvSD0m86OZ_!!2218225422038-0-cib.jpg";
const KW = "armrest pad";
const CAT = "122234002";

const tests = [
  { name: "parse_url", run: () => fetch(`${BASE}/tools/parse/url?url=${encodeURIComponent(URL)}`) },
  { name: "img_convert", run: () => fetch(`${BASE}/1688/img/convert?url=${encodeURIComponent(IMG)}&width=220&height=220`) },
  { name: "item_detail", run: () => fetch(`${BASE}/1688/v2/item_detail?item_id=${ITEM}&language=en`) },
  { name: "item_detail_by_url", run: () => fetch(`${BASE}/1688/v2/item_detail_by_url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: URL, language: "en" }) }) },
  { name: "item_desc", run: () => fetch(`${BASE}/1688/item_desc?item_id=${ITEM}&language=en`) },
  { name: "item_freight", run: () => fetch(`${BASE}/1688/item_freight?item_id=${ITEM}&language=en`) },
  { name: "item_review", run: () => fetch(`${BASE}/1688/item_review?item_id=${ITEM}&page=1&page_size=5&language=en`) },
  { name: "search_items", run: () => fetch(`${BASE}/1688/search/items?keyword=${encodeURIComponent(KW)}&page=1&page_size=5&language=en`) },
  { name: "search_items_v2", run: () => fetch(`${BASE}/1688/search/items/v2?keyword=${encodeURIComponent(KW)}&page=1&page_size=5&language=en`) },
  { name: "search_factory", run: () => fetch(`${BASE}/1688/search/factory?keywords=${encodeURIComponent(KW)}&page=1&page_size=5&language=en`) },
  { name: "search_image", run: () => fetch(`${BASE}/1688/search/image?img_url=${encodeURIComponent(IMG)}&page=1&language=en`) },
  { name: "global_image", run: () => fetch(`${BASE}/1688/global/search/image?img_url=${encodeURIComponent(IMG)}&page=1&language=en`) },
  { name: "global_image_v2", run: () => fetch(`${BASE}/1688/global/search/image/v2?img_url=${encodeURIComponent(IMG)}&page=1&language=en`) },
  { name: "shop_items", run: () => fetch(`${BASE}/1688/shop/items?member_id=${encodeURIComponent(MEMBER)}&page=1&page_size=5&language=en`) },
  { name: "shop_items_v2", run: () => fetch(`${BASE}/1688/shop/items/v2?shop_url=${encodeURIComponent(SHOP)}&page=1&page_size=5&language=en`) },
  { name: "shop_info", run: () => fetch(`${BASE}/1688/shop/info?member_id=${encodeURIComponent(MEMBER)}&language=en`) },
  { name: "shop_cats", run: () => fetch(`${BASE}/1688/shop/cats?member_id=${encodeURIComponent(MEMBER)}&language=en`) },
  { name: "category_info", run: () => fetch(`${BASE}/1688/category/info?cat_id=${CAT}&language=en`) },
  { name: "category_products", run: () => fetch(`${BASE}/1688/category/products?cat_id=${CAT}&page=1&page_size=5&language=en`) },
  { name: "category_products_v2", run: () => fetch(`${BASE}/1688/category/products/v2?cat_id=${CAT}&page=1&page_size=5&language=en`) },
];

const results = [];
for (const t of tests) {
  const started = Date.now();
  try {
    const res = await t.run();
    const body = await res.json();
    const ok = body.code === 200;
    let hint = "";
    if (body.data?.items) hint = `items=${body.data.items.length}`;
    else if (body.data?.images) hint = `images=${body.data.images.length}`;
    else if (body.data?.converted) hint = "converted";
    else if (body.data?.children) hint = `children=${body.data.children.length}`;
    else if (body.data?.categories) hint = `cats=${body.data.categories.length}`;
    else if (body.data?.shop_name || body.data?.company_name) hint = body.data.shop_name || body.data.company_name;
    else if (body.data?.logistics_text || body.data?.freight_text) hint = body.data.logistics_text || body.data.freight_text;
    else if (body.data?.item_id != null && body.data?.title) hint = `item=${body.data.item_id}`;
    else if (body.data?.item_id != null) hint = `item_id=${body.data.item_id}`;

    results.push({ name: t.name, ok, code: body.code, msg: body.msg, hint, ms: Date.now() - started });
    console.log(`${ok ? "OK" : "FAIL"}  ${t.name.padEnd(22)} code=${body.code} ${hint} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name: t.name, ok: false, error: err.message });
    console.log(`FAIL  ${t.name.padEnd(22)} ${err.message}`);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
