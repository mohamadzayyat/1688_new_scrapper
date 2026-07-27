import assert from "node:assert/strict";
import { runWithJobSignal } from "../jobContext.js";

let fetchCalls = 0;
const response = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

globalThis.fetch = async () => {
  fetchCalls += 1;
  return response({ unexpected: true });
};

const {
  markIfTranslationIncomplete,
  translateTexts,
} = await import("../translate.js");

const malformedSource = "\u6d4b\u8bd5\u5f02\u5e38\u7ffb\u8bd1";
const malformedFirst = await translateTexts([malformedSource]);
assert.equal(malformedFirst[0], malformedSource);
assert.equal(malformedFirst.__translationComplete, false);
assert.equal(markIfTranslationIncomplete({ code: 200 }, malformedFirst).__scraperNoCache, true);
await translateTexts([malformedSource]);
assert.equal(fetchCalls, 2, "malformed translator response was cached");

globalThis.fetch = async (url) => {
  fetchCalls += 1;
  const source = new URL(url).searchParams.get("q");
  return response([[[source]]]);
};
const unchangedSource = "\u539f\u6587\u4e0d\u5e94\u7f13\u5b58";
const unchanged = await translateTexts([unchangedSource]);
assert.equal(unchanged.__translationComplete, false);

globalThis.fetch = async () => {
  fetchCalls += 1;
  return response([[['cache test']]]);
};
const validSource = "\u7f13\u5b58\u6d4b\u8bd5";
const beforeValid = fetchCalls;
const valid = await translateTexts([validSource, validSource]);
assert.deepEqual([...valid], ["cache test", "cache test"]);
assert.equal(valid.__translationComplete, true);
await translateTexts([validSource]);
assert.equal(fetchCalls, beforeValid + 1, "valid deduplicated translation was not cached");

globalThis.fetch = async () => {
  fetchCalls += 1;
  return response([[['only one line']]]);
};
const cardinality = await translateTexts(["\u7b2c\u4e00\u884c", "\u7b2c\u4e8c\u884c"]);
assert.equal(cardinality.__translationComplete, false);

globalThis.fetch = async (_url, { signal }) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), {
      once: true,
    });
  });
const jobController = new AbortController();
const abortedTranslation = runWithJobSignal(jobController.signal, () =>
  translateTexts(["\u4e2d\u6b62\u7ffb\u8bd1"])
);
setImmediate(() => jobController.abort(new Error("test cancellation")));
const aborted = await abortedTranslation;
assert.equal(aborted.__translationComplete, false);

console.log("translation validation tests: OK");
