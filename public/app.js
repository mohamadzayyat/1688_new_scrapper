const DEFAULT_ITEM = "874039857500";
const DEFAULT_URL = "https://detail.1688.com/offer/874039857500.html";
const DEFAULT_MEMBER = "b2b-221822542203833240";
const DEFAULT_SHOP =
  "https://winport.m.1688.com/page/index.html?memberId=b2b-221822542203833240";
const DEFAULT_IMG =
  "https://cbu01.alicdn.com/img/ibank/O1CN01AN5iRY1QvSD0m86OZ_!!2218225422038-0-cib.jpg";
const DEFAULT_KEYWORD = "armrest pad";
const DEFAULT_CAT = "122234002";
const TOKEN_STORAGE_KEY = "1688-tester-api-token";

const LANG = {
  name: "language",
  label: "language",
  type: "select",
  options: ["en", "zh"],
  default: "en",
};

/** Exact TMAPI-style paths + defaults for the tester UI */
const APIS = [
  {
    id: "item_detail",
    label: "Get product details (By ID)",
    method: "GET",
    path: "/1688/v2/item_detail",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      LANG,
      { name: "optimize_title", label: "optimize_title", type: "checkbox", default: false },
    ],
  },
  {
    id: "item_detail_by_url",
    label: "Get product details (By URL)",
    method: "POST",
    path: "/1688/v2/item_detail_by_url",
    fields: [
      { name: "url", label: "url", default: DEFAULT_URL, required: true, wide: true },
      LANG,
      { name: "optimize_title", label: "optimize_title", type: "checkbox", default: false },
    ],
  },
  {
    id: "item_desc",
    label: "Get product description pictures",
    method: "GET",
    path: "/1688/item_desc",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      LANG,
    ],
  },
  {
    id: "item_review",
    label: "Get product review list",
    method: "GET",
    path: "/1688/item_review",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "20" },
      LANG,
    ],
  },
  {
    id: "item_freight",
    label: "Get product shipping fee",
    method: "GET",
    path: "/1688/item_freight",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      LANG,
    ],
  },
  {
    id: "search_items",
    label: "Search products by keywords",
    method: "GET",
    path: "/1688/search/items",
    fields: [
      { name: "keyword", label: "keyword", default: DEFAULT_KEYWORD, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      {
        name: "sort",
        label: "sort",
        type: "select",
        options: ["default", "sales", "price_up", "price_down"],
        default: "default",
      },
      LANG,
    ],
  },
  {
    id: "search_image",
    label: "Search products by image",
    method: "GET",
    path: "/1688/search/image",
    fields: [
      { name: "img_url", label: "img_url", default: DEFAULT_IMG, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      LANG,
    ],
  },
  {
    id: "search_factory",
    label: "Search factories by keywords",
    method: "GET",
    path: "/1688/search/factory",
    fields: [
      { name: "keywords", label: "keywords", default: DEFAULT_KEYWORD, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      LANG,
    ],
  },
  {
    id: "shop_items",
    label: "Get shop products (By ID)",
    method: "GET",
    path: "/1688/shop/items",
    fields: [
      { name: "member_id", label: "member_id", default: DEFAULT_MEMBER, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      LANG,
    ],
  },
  {
    id: "shop_items_v2",
    label: "Get shop products (By URL)",
    method: "GET",
    path: "/1688/shop/items/v2",
    fields: [
      { name: "shop_url", label: "shop_url", default: DEFAULT_SHOP, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      LANG,
    ],
  },
  {
    id: "shop_info",
    label: "Get shop information",
    method: "GET",
    path: "/1688/shop/info",
    fields: [
      { name: "member_id", label: "member_id", default: DEFAULT_MEMBER, wide: true },
      { name: "shop_url", label: "shop_url", default: DEFAULT_SHOP, wide: true },
      LANG,
    ],
  },
  {
    id: "shop_cats",
    label: "Get shop categories",
    method: "GET",
    path: "/1688/shop/cats",
    fields: [
      { name: "member_id", label: "member_id", default: DEFAULT_MEMBER, wide: true },
      LANG,
    ],
  },
  {
    id: "category_info",
    label: "Get category info",
    method: "GET",
    path: "/1688/category/info",
    fields: [
      { name: "cat_id", label: "cat_id", default: DEFAULT_CAT },
      LANG,
    ],
  },
  {
    id: "category_products",
    label: "Get category products",
    method: "GET",
    path: "/1688/category/products",
    fields: [
      { name: "cat_id", label: "cat_id", default: DEFAULT_CAT, required: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      LANG,
    ],
  },
  {
    id: "category_products_v2",
    label: "Get category products V2",
    method: "GET",
    path: "/1688/category/products/v2",
    fields: [
      { name: "cat_id", label: "cat_id", default: DEFAULT_CAT, required: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      LANG,
    ],
  },
  {
    id: "cross_search_items",
    label: "Cross-border search by keywords",
    method: "GET",
    path: "/1688/search/items/v2",
    fields: [
      { name: "keyword", label: "keyword", default: DEFAULT_KEYWORD, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      LANG,
    ],
  },
  {
    id: "cross_search_image",
    label: "Cross-border search by image",
    method: "GET",
    path: "/1688/global/search/image",
    fields: [
      { name: "img_url", label: "img_url", default: DEFAULT_IMG, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      LANG,
    ],
  },
  {
    id: "cross_search_image_v2",
    label: "Cross-border search by image V2",
    method: "GET",
    path: "/1688/global/search/image/v2",
    fields: [
      { name: "img_url", label: "img_url", default: DEFAULT_IMG, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      LANG,
    ],
  },
  {
    id: "img_convert",
    label: "Image URL conversion",
    method: "GET",
    path: "/1688/img/convert",
    fields: [
      { name: "url", label: "url", default: DEFAULT_IMG, required: true, wide: true },
      { name: "width", label: "width", default: "220" },
      { name: "height", label: "height", default: "220" },
    ],
  },
  {
    id: "parse_url",
    label: "Parse URL → ID",
    method: "GET",
    path: "/tools/parse/url",
    fields: [
      { name: "url", label: "url", default: DEFAULT_URL, required: true, wide: true },
    ],
  },
];

const nav = document.getElementById("api-nav");
const form = document.getElementById("api-form");
const endpointHint = document.getElementById("endpoint-hint");
const statusEl = document.getElementById("status");
const panel = document.getElementById("result-panel");
const jsonView = document.getElementById("json-view");
const summary = document.getElementById("summary");
const resultTitle = document.getElementById("result-title");
const resultSub = document.getElementById("result-sub");
const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");
const tokenInput = document.getElementById("api-token");
const tokenToggle = document.getElementById("token-toggle");
const tokenClear = document.getElementById("token-clear");
const requestMetrics = document.getElementById("request-metrics");
const metricDuration = document.getElementById("metric-duration");
const metricHttp = document.getElementById("metric-http");
const metricCache = document.getElementById("metric-cache");
const metricPath = document.getElementById("metric-path");

let current = APIS[0];
let latestJson = "";
let latestName = "result";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function syntaxHighlight(json) {
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "number";
      if (/^"/.test(match)) cls = /:$/.test(match) ? "key" : "string";
      else if (/true|false/.test(match)) cls = "boolean";
      else if (/null/.test(match)) cls = "null";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("is-error", isError);
}

function setLoading(loading) {
  document.body.classList.toggle("is-loading", loading);
  const btn = form.querySelector(".submit-btn");
  if (btn) btn.disabled = loading;
  for (const el of form.querySelectorAll("input,select")) el.disabled = loading;
}

function loadStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

function requestHeaders(additional = {}) {
  return {
    ...additional,
    "X-API-Token": tokenInput.value.trim(),
  };
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return "—";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
}

function showRequestMetrics({ durationMs, httpStatus, cache, path }) {
  metricDuration.textContent = formatDuration(durationMs);
  metricHttp.textContent = httpStatus == null ? "Network error" : String(httpStatus);
  metricCache.textContent = cache || "Not reported";
  metricPath.textContent = path || "Not reported";
  requestMetrics.hidden = false;
}

function renderNav() {
  nav.innerHTML = APIS.map(
    (api) =>
      `<button type="button" class="api-link${api.id === current.id ? " is-active" : ""}" data-id="${api.id}">
        <span>${escapeHtml(api.label)}</span>
        <code>${escapeHtml(api.method)}</code>
      </button>`
  ).join("");

  nav.querySelectorAll(".api-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const api = APIS.find((a) => a.id === btn.dataset.id);
      if (api) selectApi(api);
    });
  });
}

function fieldHtml(field) {
  if (field.type === "checkbox") {
    return `<label class="check-field">
      <input type="checkbox" name="${field.name}" ${field.default ? "checked" : ""} />
      <span>${escapeHtml(field.label)}</span>
    </label>`;
  }
  if (field.type === "select") {
    const opts = (field.options || [])
      .map(
        (o) =>
          `<option value="${escapeHtml(o)}" ${o === field.default ? "selected" : ""}>${escapeHtml(o)}</option>`
      )
      .join("");
    return `<label class="field ${field.wide ? "grow" : ""}">
      <span>${escapeHtml(field.label)}</span>
      <select name="${field.name}">${opts}</select>
    </label>`;
  }
  return `<label class="field ${field.wide ? "grow" : ""}">
    <span>${escapeHtml(field.label)}</span>
    <input name="${field.name}" value="${escapeHtml(field.default ?? "")}" ${field.required ? "required" : ""} />
  </label>`;
}

function selectApi(api) {
  current = api;
  renderNav();
  endpointHint.textContent = `${api.method} ${api.path}`;
  form.innerHTML =
    api.fields.map(fieldHtml).join("") +
    `<button type="submit" class="submit-btn">
      <span class="btn-label">Run</span>
      <span class="btn-spinner" aria-hidden="true"></span>
    </button>`;
}

function collectValues() {
  const data = {};
  for (const field of current.fields) {
    if (field.type === "checkbox") {
      const el = form.querySelector(`[name="${field.name}"]`);
      data[field.name] = Boolean(el?.checked);
    } else {
      const el = form.querySelector(`[name="${field.name}"]`);
      data[field.name] = el?.value?.trim() ?? "";
    }
  }
  return data;
}

function renderSummary(data) {
  if (!data || (data.code != null && data.code !== 200)) {
    summary.hidden = true;
    summary.innerHTML = "";
    return;
  }
  const d = data.data || data;
  const cards = [];
  if (d.item_id != null && d.skus) {
    cards.push(
      ["Item ID", d.item_id],
      ["Price", d.sku_price_scale || "—"],
      ["SKUs", d.skus?.length ?? "—"],
      ["Props", d.product_props?.length ?? "—"]
    );
  } else if (Array.isArray(d.items)) {
    cards.push(
      ["Page", d.page ?? "—"],
      ["Items", d.items.length],
      ["Total", d.total_count ?? "—"],
      ["Keyword", d.keyword || d.keywords || "—"]
    );
  } else if (Array.isArray(d.images)) {
    cards.push(["Item ID", d.item_id ?? "—"], ["Images", d.images.length]);
  } else if (d.converted) {
    cards.push(["Width", d.width ?? "—"], ["Height", d.height ?? "—"]);
  } else if (Array.isArray(d.children)) {
    cards.push(["Cat", d.cat_id || "root"], ["Children", d.children.length]);
  } else if (Array.isArray(d.categories)) {
    cards.push(["Categories", d.categories.length]);
  } else if (d.shop_name || d.company_name) {
    cards.push(["Shop", d.shop_name || d.company_name], ["Member", d.member_id || "—"]);
  } else if (d.freight_text || d.logistics_text) {
    cards.push(["Freight", d.freight_text || d.logistics_text || "—"]);
  } else if (d.item_id) {
    cards.push(["Item ID", d.item_id]);
  }

  if (!cards.length) {
    summary.hidden = true;
    return;
  }
  summary.hidden = false;
  summary.innerHTML = cards
    .map(
      ([label, value]) =>
        `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(
          value
        )}</strong></article>`
    )
    .join("");
}

function showResult(data) {
  latestJson = JSON.stringify(data, null, 2);
  latestName =
    data?.data?.item_id ||
    data?.data?.keyword ||
    data?.data?.keywords ||
    current.id ||
    "result";
  panel.hidden = false;
  jsonView.innerHTML = syntaxHighlight(latestJson);

  if (data.code != null && data.code !== 200) {
    resultTitle.textContent = "Request failed";
    resultSub.textContent = data.msg || `code ${data.code}`;
  } else {
    resultTitle.textContent = current.label;
    resultSub.textContent = `${current.method} ${current.path} · code ${data.code ?? 200}`;
  }
  renderSummary(data);
}

async function runCurrent(event) {
  event.preventDefault();
  const values = collectValues();
  const startedAt = performance.now();
  setLoading(true);
  setStatus(`Running ${current.label}…`);
  panel.hidden = true;
  requestMetrics.hidden = true;

  try {
    let res;
    if (current.method === "POST") {
      res = await fetch(current.path, {
        method: "POST",
        headers: requestHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(values),
      });
    } else {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === "boolean") params.set(k, v ? "true" : "false");
        else if (v !== "") params.set(k, v);
      }
      res = await fetch(`${current.path}?${params}`, {
        headers: requestHeaders(),
      });
    }
    const data = await res.json();
    const durationMs = performance.now() - startedAt;
    showRequestMetrics({
      durationMs,
      httpStatus: res.status,
      cache: res.headers.get("X-Scraper-Cache"),
      path: res.headers.get("X-Scraper-Path"),
    });
    showResult(data);
    if (data.code != null && data.code !== 200) {
      setStatus(data.msg || "Request failed.", true);
    } else {
      setStatus(`Done in ${formatDuration(durationMs)}.`);
    }
  } catch (err) {
    const durationMs = performance.now() - startedAt;
    showRequestMetrics({ durationMs, httpStatus: null, cache: "", path: "" });
    setStatus(
      `${err.message || "Network error."} (${formatDuration(durationMs)})`,
      true
    );
  } finally {
    setLoading(false);
  }
}

tokenInput.value = loadStoredToken();
tokenInput.addEventListener("input", () => {
  storeToken(tokenInput.value);
});

tokenToggle.addEventListener("click", () => {
  const willShow = tokenInput.type === "password";
  tokenInput.type = willShow ? "text" : "password";
  tokenToggle.textContent = willShow ? "Hide" : "Show";
  tokenToggle.setAttribute("aria-pressed", String(willShow));
  tokenInput.focus({ preventScroll: true });
});

tokenClear.addEventListener("click", () => {
  tokenInput.value = "";
  tokenInput.type = "password";
  tokenToggle.textContent = "Show";
  tokenToggle.setAttribute("aria-pressed", "false");
  storeToken("");
  tokenInput.focus({ preventScroll: true });
  setStatus("API token cleared from this tab.");
});

copyBtn.addEventListener("click", async () => {
  if (!latestJson) return;
  try {
    await navigator.clipboard.writeText(latestJson);
    setStatus("JSON copied.");
  } catch {
    setStatus("Could not copy.", true);
  }
});

downloadBtn.addEventListener("click", () => {
  if (!latestJson) return;
  const blob = new Blob([latestJson + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${String(latestName).replace(/[^\w.-]+/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

form.addEventListener("submit", runCurrent);
selectApi(APIS[0]);
