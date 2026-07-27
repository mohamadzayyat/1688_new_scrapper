import assert from "node:assert/strict";

process.env.MAX_CONCURRENT = "1";
process.env.MAX_QUEUE = "2";
process.env.QUEUE_TIMEOUT_MS = "1000";

process.env.MAX_SERIAL_WAITERS = "2";
process.env.MAX_SERIAL_WAITERS_PER_KEY = "1";

const { enqueueJob, runSerializedJob, jobQueueStats } = await import("../jobQueue.js");

let releaseFirst;
const first = enqueueJob(
  "first",
  () => new Promise((resolve) => {
    releaseFirst = resolve;
  })
);
await new Promise((resolve) => setImmediate(resolve));

const controller = new AbortController();
const second = enqueueJob("second", async () => "should-not-run", {
  signal: controller.signal,
});
controller.abort();

await assert.rejects(second, (error) => error?.code === 499 && error?.cancelled);
assert.equal(jobQueueStats().queued, 0);
assert.equal(jobQueueStats().cancelled, 1);

releaseFirst("done");
assert.equal(await first, "done");
assert.equal(jobQueueStats().active, 0);

const fifoOrder = [];
let releaseFifoBlocker;
const fifoBlocker = enqueueJob(
  "fifo-blocker",
  () =>
    new Promise((resolve) => {
      fifoOrder.push("first");
      releaseFifoBlocker = resolve;
    })
);
await new Promise((resolve) => setImmediate(resolve));
const fifoSecond = enqueueJob("fifo-second", async () => {
  fifoOrder.push("second");
  return "second";
});
const fifoThird = enqueueJob("fifo-third", async () => {
  fifoOrder.push("third");
  return "third";
});
assert.equal(jobQueueStats().queued, 2);
assert.throws(
  () => enqueueJob("fifo-overflow", async () => "overflow"),
  (error) => error?.code === 439 && error?.queueFull
);
releaseFifoBlocker("first");
assert.deepEqual(await Promise.all([fifoBlocker, fifoSecond, fifoThird]), [
  "first",
  "second",
  "third",
]);
assert.deepEqual(fifoOrder, ["first", "second", "third"]);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(jobQueueStats().active, 0);

const activeController = new AbortController();
const activeCancelled = enqueueJob(
  "active-cancel",
  () =>
    new Promise((_, reject) => {
      activeController.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("active job cancelled");
          error.code = 499;
          reject(error);
        },
        { once: true }
      );
    }),
  { signal: activeController.signal }
);
await new Promise((resolve) => setImmediate(resolve));
activeController.abort();
await assert.rejects(activeCancelled, (error) => error?.code === 499);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(jobQueueStats().active, 0);

let releaseBlocker;
const blocker = enqueueJob(
  "blocker",
  () => new Promise((resolve) => {
    releaseBlocker = resolve;
  })
);
await new Promise((resolve) => setImmediate(resolve));
const timedOut = enqueueJob("timed-out", async () => "should-not-run");
await assert.rejects(timedOut, (error) => error?.code === 439);
assert.equal(jobQueueStats().timedOut, 1);
releaseBlocker("done");
await blocker;

let releaseReasonBlocker;
const reasonBlocker = enqueueJob(
  "reason-blocker",
  () => new Promise((resolve) => {
    releaseReasonBlocker = resolve;
  })
);
await new Promise((resolve) => setImmediate(resolve));
const reasonController = new AbortController();
const deadlineReason = new Error("custom deadline");
deadlineReason.code = 504;
const reasonQueued = enqueueJob("reason-queued", async () => "should-not-run", {
  signal: reasonController.signal,
});
reasonController.abort(deadlineReason);
await assert.rejects(reasonQueued, (error) => error === deadlineReason);
releaseReasonBlocker("done");
await reasonBlocker;

let releaseSerial;
const serialFirst = runSerializedJob(
  "category-a",
  () => new Promise((resolve) => {
    releaseSerial = resolve;
  })
);
await new Promise((resolve) => setImmediate(resolve));
const serialAbort = new AbortController();
const serialSecond = runSerializedJob("category-a", async () => "should-not-run", {
  signal: serialAbort.signal,
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(jobQueueStats().serialized.waiting, 1);
await assert.rejects(
  runSerializedJob("category-a", async () => "overflow"),
  (error) => error?.code === 439 && error?.queueFull
);
serialAbort.abort();
await assert.rejects(serialSecond, (error) => error?.code === 499);
assert.equal(jobQueueStats().serialized.waiting, 0);
releaseSerial("serial-done");
assert.equal(await serialFirst, "serial-done");
assert.equal(jobQueueStats().serialized.activeKeys, 0);

await assert.rejects(
  runSerializedJob("throwing-category", async () => {
    throw new Error("serialized task failed");
  }),
  /serialized task failed/
);
assert.equal(
  await runSerializedJob("throwing-category", async () => "released-after-error"),
  "released-after-error"
);

const globalActivePromises = [];
const globalReleaseByKey = {};
for (const key of ["global-a", "global-b", "global-c"]) {
  globalActivePromises.push(
    runSerializedJob(
      key,
      () => new Promise((resolve) => {
        globalReleaseByKey[key] = resolve;
      })
    )
  );
}
await new Promise((resolve) => setImmediate(resolve));
const globalWaitA = runSerializedJob("global-a", async () => "a-waiter");
const globalWaitB = runSerializedJob("global-b", async () => "b-waiter");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(jobQueueStats().serialized.waiting, 2);
await assert.rejects(
  runSerializedJob("global-c", async () => "global-overflow"),
  (error) => error?.code === 439 && error?.queueFull
);
globalReleaseByKey["global-a"]("a-active");
globalReleaseByKey["global-b"]("b-active");
globalReleaseByKey["global-c"]("c-active");
assert.deepEqual(await Promise.all(globalActivePromises), [
  "a-active",
  "b-active",
  "c-active",
]);
assert.deepEqual(await Promise.all([globalWaitA, globalWaitB]), ["a-waiter", "b-waiter"]);
assert.equal(jobQueueStats().serialized.waiting, 0);
assert.equal(jobQueueStats().serialized.activeKeys, 0);

console.log("job queue cancellation tests: OK");
