import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

const ITEM_ID = "874039857500";
const CATEGORY_ID = "122234002";
const MEMBER_ID = "b2b-221822542203833240";
const ALIBABA_IMAGE = "https://cbu01.alicdn.com/img/ibank/O1CN01.jpg";

const ALL_ENDPOINTS = [
  "category_info",
  "category_items",
  "category_top",
  "global_item_detail",
  "image_convert",
  "image_search",
  "item_detail",
  "ratings",
  "shipping",
  "shop_categories",
  "shop_info",
  "shop_items",
  "shop_url_items",
  "text_search",
].sort();

const BENCHMARK_ENV_KEYS = [
  "API_TOKEN",
  "OLD_BASE",
  "NEW_BASE",
  "OLD_API_TOKEN",
  "NEW_API_TOKEN",
  "OLD_AUTH_MODE",
  "NEW_AUTH_MODE",
  "OLD_TOKEN_HEADER",
  "NEW_TOKEN_HEADER",
  "OLD_TOKEN_QUERY",
  "NEW_TOKEN_QUERY",
  "OLD_SUCCESS_CODES",
  "NEW_SUCCESS_CODES",
  "AB_ENDPOINTS",
  "AB_SAMPLES",
  "AB_WARMUPS",
  "AB_TIMEOUT_MS",
  "AB_CONCURRENCY",
  "AB_CONCURRENCY_REQUESTS",
  "AB_CONCURRENCY_ROUNDS",
  "AB_REQUIRE_DISTINCT_LOAD",
  "AB_DISTINCT_DETAIL_COUNT",
  "AB_MIN_SUCCESS_RATE",
  "AB_MIN_EQUIV_RATE",
  "AB_MIN_LIST_OVERLAP",
  "AB_LIST_TOTAL_TOLERANCE",
  "AB_MAX_NEW_P95_RATIO",
  "AB_MAX_PAIRED_P50_RATIO",
  "AB_MIN_NEW_WIN_RATE",
  "AB_MAX_CONCURRENCY_RATIO",
  "AB_P95_SLACK_MS",
  "AB_CONCURRENCY_SLACK_MS",
  "IMAGE_URL",
  "IMAGE_SEARCH_URL",
];

function card(index) {
  return {
    item_id: `900000000${String(index).padStart(3, "0")}`,
    title: `mock item ${index}`,
    img: ALIBABA_IMAGE,
    price: "10.00",
  };
}

function requestKey(url) {
  if (url.pathname === "/1688/item_detail") return "item_detail";
  if (url.pathname === "/1688/global/item_detail") return "global_item_detail";
  if (url.pathname === "/1688/category/info") {
    return url.searchParams.has("cat_id") ? "category_info" : "category_top";
  }
  if (url.pathname === "/1688/category/items") return "category_items";
  if (url.pathname === "/1688/global/search/items") return "text_search";
  if (url.pathname === "/1688/shop/shop_info") return "shop_info";
  if (url.pathname === "/1688/shop/category") return "shop_categories";
  if (url.pathname === "/1688/shop/items") return "shop_items";
  if (url.pathname === "/1688/shop/items/v2") return "shop_url_items";
  if (url.pathname === "/1688/item/shipping") return "shipping";
  if (url.pathname === "/1688/item/rating") return "ratings";
  if (url.pathname === "/1688/tools/image/convert_url") return "image_convert";
  if (url.pathname === "/1688/search/image") return "image_search";
  return null;
}

function responseData(key, url, options) {
  if (key === "item_detail" || key === "global_item_detail") {
    const detail = {
      item_id: ITEM_ID,
      title: "mock item detail",
      price: "10.00",
      quantity_begin: 1,
      stock: 50,
      main_imgs: [ALIBABA_IMAGE],
      sku_props: [{ pid: "1", values: [{ vid: "11", name: "black" }] }],
      skus: [{ sku_id: "sku-1", price: "10.00", stock: 50, props_ids: "1:11" }],
    };
    if (options.legacyOld) delete detail.quantity_begin;
    return detail;
  }
  if (key === "category_top") {
    return { items: [{ cat_id: CATEGORY_ID, name: "mock category" }] };
  }
  if (key === "category_info") {
    return { cat_id: CATEGORY_ID, name: "mock category" };
  }
  if (key === "shop_info") {
    return { member_id: MEMBER_ID, shop_name: "mock shop" };
  }
  if (key === "shop_categories") {
    return { categories: [{ shop_cat_id: "100", name: "mock shop category" }] };
  }
  if (key === "shipping") {
    return {
      item_id: ITEM_ID,
      total_fee: 5,
      total_quantity: Number(url.searchParams.get("total_quantity") || 1),
    };
  }
  if (key === "ratings") {
    return {
      item_id: ITEM_ID,
      list: [
        { id: "review-1", content: "good" },
        { id: "review-2", content: "fast" },
      ],
    };
  }
  if (key === "image_convert") {
    return { converted_url: ALIBABA_IMAGE };
  }

  const page = Number(url.searchParams.get("page") || 1);
  const pageSize = Number(url.searchParams.get("page_size") || 20);
  const total =
    key === "text_search" && options.textSearchTotal != null
      ? options.textSearchTotal
      : pageSize;
  const count =
    options.legacyOld && key === "text_search"
      ? Math.max(1, Math.min(pageSize, total) - 1)
      : Math.min(pageSize, total);
  return {
    items: Array.from({ length: count }, (_, index) => card(index + 1)),
    page,
    page_size: pageSize,
    total_count: total,
    has_next_page: page * pageSize < total,
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startMock({ token, delayMs, textSearchTotal, legacyOld = false }) {
  const seen = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const key = requestKey(url);
    setTimeout(() => {
      if (url.searchParams.get("apiToken") !== token) {
        sendJson(response, 401, { code: 401, message: "unauthorized" });
        return;
      }
      if (!key) {
        sendJson(response, 404, { code: 404, message: "route not found" });
        return;
      }
      const expectedMethod = key === "image_convert" ? "POST" : "GET";
      if (request.method !== expectedMethod) {
        sendJson(response, 405, { code: 405, message: "method not allowed" });
        return;
      }
      seen.add(key);
      sendJson(response, 200, {
        code: 200,
        data: responseData(key, url, { textSearchTotal, legacyOld }),
      });
    }, delayMs);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    seen,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}

function cleanBenchmarkEnv(overrides) {
  const env = { ...process.env };
  for (const name of BENCHMARK_ENV_KEYS) delete env[name];
  return { ...env, ...overrides };
}

async function runBenchmark(env) {
  const child = spawn(process.execPath, ["scripts/benchmark-ab.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("benchmark child exceeded the 60 second test timeout"));
    }, 60_000);
    timer.unref?.();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

function assertTokensRedacted(label, result, tokens) {
  for (const token of tokens) {
    assert.equal(
      result.output.includes(token),
      false,
      `${label}: benchmark output leaked a configured token`
    );
  }
}

async function runScenario(label, options) {
  const oldToken = `old_mock_secret_${label.replace(/\W+/g, "_")}`;
  const newToken = `new_mock_secret_${label.replace(/\W+/g, "_")}`;
  const [oldMock, newMock] = await Promise.all([
    startMock({
      token: oldToken,
      delayMs: options.oldDelayMs,
      textSearchTotal: options.oldTextSearchTotal,
      legacyOld: Boolean(options.legacyOld),
    }),
    startMock({
      token: newToken,
      delayMs: options.newDelayMs,
      textSearchTotal: options.newTextSearchTotal,
    }),
  ]);

  try {
    const overrides = {
      OLD_BASE: oldMock.base,
      NEW_BASE: newMock.base,
      OLD_API_TOKEN: oldToken,
      NEW_API_TOKEN: newToken,
      OLD_AUTH_MODE: "query",
      NEW_AUTH_MODE: "query",
      AB_ALLOW_LOCAL_HTTP: "1",
      AB_REQUIRE_DISTINCT_LOAD: "0",
      AB_SAMPLES: "10",
      AB_WARMUPS: "0",
      AB_TIMEOUT_MS: "5000",
      AB_CONCURRENCY: "2",
      AB_CONCURRENCY_REQUESTS: "4",
      AB_CONCURRENCY_ROUNDS: "1",
      IMAGE_URL: ALIBABA_IMAGE,
      IMAGE_SEARCH_URL: ALIBABA_IMAGE,
    };
    if (options.endpoints) overrides.AB_ENDPOINTS = options.endpoints;
    const result = await runBenchmark(cleanBenchmarkEnv(overrides));
    assertTokensRedacted(label, result, [oldToken, newToken]);
    return { result, oldMock, newMock };
  } catch (error) {
    await Promise.allSettled([oldMock.close(), newMock.close()]);
    throw error;
  }
}

async function closeScenario(scenario) {
  await Promise.all([scenario.oldMock.close(), scenario.newMock.close()]);
}

let scenario;
try {
  scenario = await runScenario("all endpoints faster", {
    oldDelayMs: 40,
    newDelayMs: 2,
    legacyOld: true,
  });
  assert.equal(
    scenario.result.code,
    0,
    `faster equivalent NEW should pass\n${scenario.result.output}`
  );
  assert.equal(
    (scenario.result.stdout.match(/^Measuring /gm) || []).length,
    14,
    "default endpoint selection did not measure all 14 endpoints"
  );
  assert.deepEqual([...scenario.oldMock.seen].sort(), ALL_ENDPOINTS);
  assert.deepEqual([...scenario.newMock.seen].sort(), ALL_ENDPOINTS);
  assert.match(scenario.result.stdout, /A\/B checks passed/);
  console.log("OK benchmark accepts a materially faster equivalent NEW across all 14 endpoints");
} finally {
  if (scenario) await closeScenario(scenario);
}

scenario = null;
try {
  scenario = await runScenario("pagination mismatch", {
    endpoints: "text_search",
    oldDelayMs: 30,
    newDelayMs: 2,
    oldTextSearchTotal: 100,
    newTextSearchTotal: 20,
  });
  assert.notEqual(scenario.result.code, 0, "pagination total/has_next mismatch should fail");
  assert.match(scenario.result.stdout, /text_search paired equivalence .* below/);
  console.log("OK benchmark rejects pagination total/has_next equivalence regressions");
} finally {
  if (scenario) await closeScenario(scenario);
}

scenario = null;
try {
  scenario = await runScenario("slower new", {
    endpoints: "text_search",
    oldDelayMs: 2,
    newDelayMs: 35,
    oldTextSearchTotal: 20,
    newTextSearchTotal: 20,
  });
  assert.notEqual(scenario.result.code, 0, "slower NEW should fail the latency gates");
  assert.match(
    scenario.result.stdout,
    /NEW p95 .* exceeds|NEW\/OLD paired median .* exceeds|NEW paired latency win rate .* below/
  );
  console.log("OK benchmark rejects a materially slower NEW");
} finally {
  if (scenario) await closeScenario(scenario);
}

console.log("A/B benchmark mock regression tests: OK");
