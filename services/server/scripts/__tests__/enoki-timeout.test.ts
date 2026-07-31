import test from "node:test";
import assert from "node:assert/strict";

test("callEnoki keeps requests and retry backoff inside one deadline", async () => {
    process.env.ENOKI_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    const originalTimeout = AbortSignal.timeout;
    let attempts = 0;

    AbortSignal.timeout = () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("request timed out", "TimeoutError")), 20);
        return controller.signal;
    };
    globalThis.fetch = ((_input, init) => {
        attempts += 1;
        const signal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    }) as typeof fetch;

    try {
        const { callEnoki } = await import("../sidecar/enoki.js");
        await assert.rejects(callEnoki("/transaction-blocks/sponsor", {}), /timeout/i);
        assert.equal(attempts, 1);

        attempts = 0;
        globalThis.fetch = (async () => {
            attempts += 1;
            return new Response("temporarily unavailable", {
                status: 503,
                headers: { "retry-after": "30" },
            });
        }) as typeof fetch;
        await assert.rejects(callEnoki("/transaction-blocks/sponsor", {}), /aborted/i);
        assert.equal(attempts, 1);
    } finally {
        globalThis.fetch = originalFetch;
        AbortSignal.timeout = originalTimeout;
        delete process.env.ENOKI_API_KEY;
    }
});
