import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MemWal } from "../dist/memwal.js";
import { isTimeoutError, DEFAULT_RECALL_TIMEOUT_MS } from "../dist/utils.js";

// WALM-598 / GH #438.
//
// `recall()` used to arm a single 15s AbortController *before* calling
// `signedRequest`, which then awaited two unabortable, untimed preflights —
// `ensureCompatibleRelayer()` (`GET /version`, falling back to `GET /health`)
// and `buildSealSession()` (`GET /config` + a Sui RPC round-trip). A relayer
// whose `/health` p50 had drifted to ~9s therefore spent most of the caller's
// budget before `/api/recall` was even dispatched, and the resulting
// `AbortError` surfaced on the recall fetch even though recall was healthy.
//
// The budget now starts on the recall request itself; the preflights carry
// their own independent deadlines.

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/**
 * Resolve `factory()` after `ms`, or reject with an `AbortError` if the
 * caller's signal fires first — i.e. behave like a real `fetch`. Without the
 * signal handling these tests could not observe an abort at all.
 */
function delayed(ms, factory, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const tid = setTimeout(() => resolve(factory()), ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(tid);
                reject(abortError());
            },
            { once: true },
        );
    });
}

function abortError() {
    return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

const VERSION_BODY = {
    apiVersion: "1.0.0",
    relayerVersion: "1.0.0",
    minSupportedSdk: { typescript: "0.0.4" },
};

/**
 * Route stub with per-path latency. `never` means "hang until aborted",
 * which is how a wedged preflight looks to the client.
 */
function stubServer({ versionDelayMs = 0, recallDelayMs = 0, hits = [] } = {}) {
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        seen.push(path);
        if (path === "/version") {
            if (versionDelayMs === "never") return delayed(1e9, () => null, init.signal);
            return delayed(versionDelayMs, () => Response.json(VERSION_BODY), init.signal);
        }
        if (path === "/api/recall" && init.method === "POST") {
            return delayed(
                recallDelayMs,
                () => Response.json({ results: hits, total: hits.length }),
                init.signal,
            );
        }
        throw new Error(`unexpected request ${path}`);
    };
    return seen;
}

function client(config = {}) {
    const c = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
        ...config,
    });
    // Standard SEAL stub — building a real SessionKey needs @mysten/seal and
    // a live Sui RPC. `buildSealSession` is awaited inside `signedRequest`,
    // i.e. in the same preflight window as `/config`.
    c.buildSealSession = async () => "test-session";
    return c;
}

test("a slow /version preflight does not abort a healthy recall", async () => {
    // The regression, reproduced at test speed: the preflight takes longer
    // than the entire recall budget. Before WALM-598 the shared
    // AbortController had already fired by the time `/api/recall` was
    // dispatched, so this rejected with an unlabeled AbortError.
    const seen = stubServer({ versionDelayMs: 120, recallDelayMs: 0 });

    const result = await client({ recallTimeoutMs: 40 }).recall({ query: "food allergies" });

    assert.deepEqual(result.results, []);
    assert.deepEqual(seen, ["/version", "/api/recall"]);
});

test("a slow SEAL session build does not abort a healthy recall", async () => {
    // `buildSealSession()` is the other unabortable preflight inside the old
    // budget: on a cold cache it fetches /config, dynamic-imports @mysten/seal
    // and @mysten/sui, and calls SessionKey.create() against Sui RPC.
    stubServer({ recallDelayMs: 0 });

    const c = client({ recallTimeoutMs: 40 });
    c.buildSealSession = async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return "test-session";
    };

    const result = await c.recall({ query: "food allergies" });
    assert.deepEqual(result.results, []);
});

test("recall honours a per-call timeoutMs", async () => {
    stubServer({ recallDelayMs: 5_000 });

    await assert.rejects(
        client().recall({ query: "food allergies", timeoutMs: 30 }),
        (err) => {
            assert.ok(isTimeoutError(err), `expected a TimeoutError, got ${err?.name}`);
            assert.equal(err.timeoutMs, 30);
            return true;
        },
    );
});

test("recall honours a client-level recallTimeoutMs", async () => {
    stubServer({ recallDelayMs: 5_000 });

    await assert.rejects(client({ recallTimeoutMs: 30 }).recall({ query: "q" }), (err) => {
        assert.ok(isTimeoutError(err));
        assert.equal(err.timeoutMs, 30);
        return true;
    });
});

test("a per-call timeoutMs overrides the client default", async () => {
    stubServer({ recallDelayMs: 5_000 });

    await assert.rejects(
        client({ recallTimeoutMs: 60_000 }).recall({ query: "q", timeoutMs: 25 }),
        (err) => {
            assert.equal(err.timeoutMs, 25);
            return true;
        },
    );
});

test("a recall timeout names the recall request as the phase", async () => {
    // The diagnostic that was missing: every stall in the chain used to
    // surface as an unlabeled AbortError on the recall fetch.
    stubServer({ recallDelayMs: 5_000 });

    await assert.rejects(client().recall({ query: "q", timeoutMs: 25 }), (err) => {
        assert.equal(err.phase, "POST /api/recall");
        assert.match(err.message, /timed out after 25ms during POST \/api\/recall/);
        return true;
    });
});

test("a preflight timeout names the preflight as the phase", async () => {
    // A wedged /version now fails on its own budget instead of hanging
    // forever (it carried no signal at all before) or being misreported as
    // a recall abort.
    stubServer({ versionDelayMs: "never" });

    await assert.rejects(
        client({ preflightTimeoutMs: 30, recallTimeoutMs: 5_000 }).recall({ query: "q" }),
        (err) => {
            assert.ok(isTimeoutError(err));
            assert.equal(err.phase, "preflight GET /version");
            assert.equal(err.timeoutMs, 30);
            return true;
        },
    );
});

test("health() is bounded by the preflight budget", async () => {
    globalThis.fetch = async (url, init = {}) => {
        assert.equal(new URL(url).pathname, "/health");
        return delayed(1e9, () => null, init.signal);
    };

    await assert.rejects(client({ preflightTimeoutMs: 30 }).health(), (err) => {
        assert.ok(isTimeoutError(err));
        assert.equal(err.phase, "GET /health");
        return true;
    });
});

test("the default recall budget is unchanged at 15s", async () => {
    assert.equal(DEFAULT_RECALL_TIMEOUT_MS, 15_000);
});

test("RecallOptions and MemWalConfig declare the timeout knobs", () => {
    // A .mjs test cannot catch a missing type; assert on the emitted .d.ts,
    // which is what a TypeScript consumer actually resolves.
    const dts = readFileSync(
        fileURLToPath(new URL("../dist/types.d.ts", import.meta.url)),
        "utf8",
    );

    assert.match(dts, /recallTimeoutMs\?: number;/);
    assert.match(dts, /preflightTimeoutMs\?: number;/);
});
