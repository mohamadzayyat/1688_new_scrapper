import assert from "node:assert/strict";
import {
  __extendCategoryMergeState,
  getCategoryProducts,
} from "../extraScrape.js";

function makeState(sources, chunkSize = 7) {
  const streams = sources.map((source, index) => ({
    categoryId: String(index + 1),
    source: source.map((offerId) => ({
      offerId: String(offerId),
      category_path: [{ cat_id: String(index + 1) }],
    })),
    sourceCursor: 0,
    chunkSize,
    items: [],
    cursor: 0,
    exhausted: source.length === 0,
  }));
  return {
    streams,
    nextStream: 0,
    seen: new Map(),
    merged: [],
    duplicates: 0,
    exhausted: streams.every((stream) => stream.exhausted),
  };
}

async function loadSynthetic(streams) {
  for (const stream of streams) {
    const next = stream.source.slice(
      stream.sourceCursor,
      stream.sourceCursor + stream.chunkSize
    );
    stream.sourceCursor += next.length;
    stream.items.push(...next);
    if (stream.sourceCursor >= stream.source.length) stream.exhausted = true;
  }
}

const uneven = makeState([
  ["a0"],
  Array.from({ length: 100 }, (_, index) => `b${index}`),
]);
await __extendCategoryMergeState(uneven, 21, loadSynthetic);
assert.equal(uneven.merged.length, 21, "exhausted stream left holes on page 1");
await __extendCategoryMergeState(uneven, 41, loadSynthetic);
assert.equal(uneven.merged.length, 41, "exhausted stream left holes on page 2");
await __extendCategoryMergeState(uneven, 200, loadSynthetic);
assert.equal(uneven.merged.length, 101);
assert.equal(uneven.exhausted, true);
assert.equal(new Set(uneven.merged.map((item) => item.offerId)).size, 101);

const emptyFirst = makeState([[], Array.from({ length: 40 }, (_, i) => `x${i}`)]);
await __extendCategoryMergeState(emptyFirst, 20, loadSynthetic);
assert.equal(emptyFirst.merged.length, 20, "empty stream was not skipped");

const duplicates = makeState([
  ["a", "b", "c"],
  ["b", "d", "e"],
], 2);
await __extendCategoryMergeState(duplicates, 10, loadSynthetic);
assert.deepEqual(
  duplicates.merged.map((item) => item.offerId),
  ["a", "b", "d", "c", "e"]
);
assert.equal(duplicates.exhausted, true);
assert.equal(duplicates.seen.get("b").category_path.length, 2);

const invalidCategory = await getCategoryProducts({
  cat_id: "999999999999",
  keyword: "*",
});
assert.equal(invalidCategory.code, 422, "oversized category ID reached upstream search");

console.log("category merge pagination tests: OK");
