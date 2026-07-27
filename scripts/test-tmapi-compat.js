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

console.log(`\n${checks.length + 1 - failed}/${checks.length + 1} compatibility checks passed`);
process.exit(failed === 0 ? 0 : 1);
