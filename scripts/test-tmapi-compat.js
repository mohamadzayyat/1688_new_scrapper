const BASE = process.env.BASE || "http://localhost:3456";

const checks = [
  ["item_detail", "/1688/item_detail"],
  ["global_item_detail", "/1688/global/item_detail"],
  ["category_items", "/1688/category/items"],
  ["item_rating", "/1688/item/rating"],
  ["item_shipping", "/1688/item/shipping"],
  ["shop_category", "/1688/shop/category"],
  ["global_search", "/1688/global/search/items"],
];

let failed = 0;
for (const [name, path] of checks) {
  // POST is intentionally unsupported by these GET aliases. A TMAPI JSON 405
  // proves the route is mounted without starting a live browser scrape.
  const response = await fetch(`${BASE}${path}`, { method: "POST" });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  const routed = response.status === 200 && body && Number(body.code) === 405;
  console.log(`${routed ? "OK" : "FAIL"} ${name} status=${response.status} code=${body?.code ?? "non-json"}`);
  if (!routed) failed += 1;
}

const convertResponse = await fetch(`${BASE}/1688/tools/image/convert_url`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: "https://cbu01.alicdn.com/img/ibank/example.jpg",
  }),
});
const convertBody = await convertResponse.json();
const converted =
  convertResponse.status === 200 &&
  Number(convertBody.code) === 200 &&
  Boolean(convertBody.data?.image_url);
console.log(
  `${converted ? "OK" : "FAIL"} image_convert status=${convertResponse.status} code=${convertBody.code}`
);
if (!converted) failed += 1;

const topCategoriesResponse = await fetch(`${BASE}/1688/category/info`);
const topCategoriesBody = await topCategoriesResponse.json();
const topCategoriesOk =
  Number(topCategoriesBody.code) === 200 &&
  Array.isArray(topCategoriesBody.data) &&
  topCategoriesBody.data.length >= 50;
console.log(
  `${topCategoriesOk ? "OK" : "FAIL"} top_categories count=${topCategoriesBody.data?.length ?? 0}`
);
if (!topCategoriesOk) failed += 1;

const categoryInfoResponse = await fetch(
  `${BASE}/1688/category/info?cat_id=130823000`
);
const categoryInfoBody = await categoryInfoResponse.json();
const categoryInfoOk =
  Number(categoryInfoBody.code) === 200 &&
  Array.isArray(categoryInfoBody.data?.children) &&
  categoryInfoBody.data.children.length === 4;
console.log(
  `${categoryInfoOk ? "OK" : "FAIL"} category_info children=${categoryInfoBody.data?.children?.length ?? 0}`
);
if (!categoryInfoOk) failed += 1;

const total = checks.length + 3;
console.log(`\n${total - failed}/${total} compatibility checks passed`);
process.exit(failed === 0 ? 0 : 1);
