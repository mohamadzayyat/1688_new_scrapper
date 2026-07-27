const DEFAULT_ITEM = "874039857500";
const DEFAULT_URL = "https://detail.1688.com/offer/874039857500.html";
const DEFAULT_MEMBER = "b2b-221822542203833240";
const DEFAULT_SHOP =
  "https://winport.m.1688.com/page/index.html?memberId=b2b-221822542203833240";
const DEFAULT_IMG =
  "https://cbu01.alicdn.com/img/ibank/O1CN01AN5iRY1QvSD0m86OZ_!!2218225422038-0-cib.jpg";
const DEFAULT_KEYWORD = "armrest pad";

/** @type {Array<{id:string,label:string,method:string,path:string,fields:Array<object>}>} */
const APIS = [
  {
    id: "item_detail",
    label: "Item detail (by ID)",
    method: "GET",
    path: "/1688/v2/item_detail",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
      { name: "optimize_title", label: "optimize_title", type: "checkbox", default: false },
    ],
  },
  {
    id: "item_detail_by_url",
    label: "Item detail (by URL)",
    method: "POST",
    path: "/1688/v2/item_detail_by_url",
    fields: [
      { name: "url", label: "url", default: DEFAULT_URL, required: true, wide: true },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
      { name: "optimize_title", label: "optimize_title", type: "checkbox", default: false },
    ],
  },
  {
    id: "item_desc",
    label: "Description pictures",
    method: "GET",
    path: "/1688/item_desc",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "item_review",
    label: "Reviews",
    method: "GET",
    path: "/1688/item_review",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "20" },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "item_freight",
    label: "Shipping / freight",
    method: "GET",
    path: "/1688/item_freight",
    fields: [
      { name: "item_id", label: "item_id", default: DEFAULT_ITEM, required: true },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "search_items",
    label: "Search by keyword",
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
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "search_img",
    label: "Search by image",
    method: "POST",
    path: "/1688/search/img",
    fields: [
      { name: "img_url", label: "img_url", default: DEFAULT_IMG, required: true, wide: true },
      { name: "page", label: "page", default: "1" },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "shop_items",
    label: "Shop products",
    method: "GET",
    path: "/1688/shop/items/v2",
    fields: [
      { name: "shop_url", label: "shop_url", default: DEFAULT_SHOP, wide: true },
      { name: "member_id", label: "member_id", default: DEFAULT_MEMBER },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "shop_info",
    label: "Shop info",
    method: "GET",
    path: "/1688/shop/info",
    fields: [
      { name: "shop_url", label: "shop_url", default: DEFAULT_SHOP, wide: true },
      { name: "member_id", label: "member_id", default: DEFAULT_MEMBER },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "shop_cats",
    label: "Shop categories",
    method: "GET",
    path: "/1688/shop/cats",
    fields: [
      { name: "shop_url", label: "shop_url", default: DEFAULT_SHOP, wide: true },
      { name: "member_id", label: "member_id", default: DEFAULT_MEMBER },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "category_products",
    label: "Category products",
    method: "GET",
    path: "/1688/category/products",
    fields: [
      { name: "cat_id", label: "cat_id", default: "122234002" },
      { name: "keyword", label: "keyword", default: DEFAULT_KEYWORD, wide: true },
      { name: "page", label: "page", default: "1" },
      { name: "page_size", label: "page_size", default: "10" },
      {
        name: "language",
        label: "language",
        type: "select",
        options: ["en", "zh"],
        default: "en",
      },
    ],
  },
  {
    id: "img_convert",
    label: "Image URL convert",
    method: "GET",
    path: "/1688/tools/img_convert",
    fields: [
      { name: "img_url", label: "img_url", default: DEFAULT_IMG, required: true, wide: true },
      { name: "width", label: "width", default: "220" },
      { name: "height", label: "height", default: "220" },
    ],
  },
  {
    id: "parse_url",
    label: "Parse URL → ID",
    method: "GET",
    path: "/1688/tools/parse_url",
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
    cards.push(["Item ID", d.item_id], ["Price", d.sku_price_scale || "—"], ["SKUs", d.skus?.length ?? "—"], ["Props", d.product_props?.length ?? "—"]);
  } else if (Array.isArray(d.items)) {
    cards.push(["Page", d.page ?? "—"], ["Items", d.items.length], ["Total", d.total_count ?? "—"], ["Keyword", d.keyword || "—"]);
  } else if (Array.isArray(d.images)) {
    cards.push(["Item ID", d.item_id ?? "—"], ["Images", d.images.length]);
  } else if (d.converted) {
    cards.push(["Width", d.width ?? "—"], ["Height", d.height ?? "—"]);
  } else if (d.item_id && !d.skus) {
    cards.push(["Item ID", d.item_id]);
  } else if (d.shop_name) {
    cards.push(["Shop", d.shop_name], ["Member", d.member_id || "—"]);
  } else if (Array.isArray(d.categories)) {
    cards.push(["Categories", d.categories.length]);
  } else if (d.freight_text || d.shipping_raw) {
    cards.push(["Freight", d.freight_text || "—"], ["From", d.location_from || "—"]);
  }

  if (!cards.length) {
    summary.hidden = true;
    return;
  }
  summary.hidden = false;
  summary.innerHTML = cards
    .map(
      ([label, value]) =>
        `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
    )
    .join("");
}

function showResult(data) {
  latestJson = JSON.stringify(data, null, 2);
  latestName =
    data?.data?.item_id ||
    data?.data?.keyword ||
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
  setLoading(true);
  setStatus(`Running ${current.label}…`);
  panel.hidden = true;

  try {
    let res;
    if (current.method === "POST") {
      res = await fetch(current.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
    } else {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === "boolean") params.set(k, v ? "true" : "false");
        else if (v !== "") params.set(k, v);
      }
      res = await fetch(`${current.path}?${params}`);
    }
    const data = await res.json();
    showResult(data);
    if (data.code != null && data.code !== 200) {
      setStatus(data.msg || "Request failed.", true);
    } else {
      setStatus("Done.");
    }
  } catch (err) {
    setStatus(err.message || "Network error.", true);
  } finally {
    setLoading(false);
  }
}

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
