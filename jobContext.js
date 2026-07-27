import { AsyncLocalStorage } from "node:async_hooks";

const jobStorage = new AsyncLocalStorage();

export function jobAbortError(signal = null) {
  const reason = signal?.reason;
  if (
    reason instanceof Error &&
    !(reason.name === "AbortError" && reason.constructor?.name === "DOMException")
  ) {
    return reason;
  }
  const error = new Error("Scrape request was cancelled");
  error.name = "AbortError";
  error.code = 499;
  error.cancelled = true;
  return error;
}

export function runWithJobSignal(signal, fn) {
  return jobStorage.run(signal || null, fn);
}

export function currentJobSignal() {
  return jobStorage.getStore() || null;
}

export function throwIfJobAborted() {
  const signal = currentJobSignal();
  if (signal?.aborted) throw jobAbortError(signal);
}

export async function bindContextToJob(context) {
  const signal = currentJobSignal();
  if (!signal) return context;
  if (signal.aborted) {
    await context.close().catch(() => {});
    throw jobAbortError(signal);
  }

  const onAbort = () => void context.close().catch(() => {});
  const cleanup = () => signal.removeEventListener("abort", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  context.once("close", cleanup);
  return context;
}
