import test from "node:test";
import assert from "node:assert/strict";

process.env.UPLOAD_RELAY_TIP_TIMEOUT_MS = "10";

test("upload relay tip discovery aborts and propagates a hung fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let aborted = false;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      const onAbort = () => {
        aborted = true;
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
  console.warn = () => {};
  // Importing the Walrus SDK can take several seconds on a cold CI worker.
  // AbortSignal.timeout uses an unref'ed timer, so keep the test process alive
  // until the assertion completes rather than only through module loading.
  const keepAlive = setTimeout(() => {}, 30_000);

  try {
    const { clearUploadRelayTipCache, getUploadRelayTipAddress } = await import(
      "../sidecar/clients.js"
    );
    clearUploadRelayTipCache();
    const startedAt = Date.now();
    await assert.rejects(getUploadRelayTipAddress(), /abort|timeout/i);
    assert.equal(aborted, true);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
