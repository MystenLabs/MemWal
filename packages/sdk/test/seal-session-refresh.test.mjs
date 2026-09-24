// WALM-162: proactive SEAL SessionKey refresh.
//
// Coverage note (deliberate, please read before extending):
//   `buildSealSessionInner()` is NOT exercised here. It dynamically imports
//   `@mysten/seal` + `@mysten/sui`, calls `SessionKey.create()` (which reads the
//   package object over gRPC/JSON-RPC) and signs a personal message, so it needs
//   a live Sui endpoint. What WALM-162 changed is everything around it — the
//   refresh policy, the cache write, the single-flight guard, the expiry
//   recovery and the error tagging — and all of that is real code under test
//   below. Only the network/dynamic-import leaf is stubbed.
//
//   Unlike the other suites in this directory, these tests do NOT monkey-patch
//   `buildSealSession` away: that method is the unit under test.

import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import {
    SEAL_SESSION_REFRESH_AHEAD_MS,
    isSealSessionExpiredResponse,
    sealSessionBuildError,
    sealSessionCacheState,
    sealSessionExpiredError,
} from "../dist/utils.js";

const originalFetch = globalThis.fetch;

function client() {
    return MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

/** Replace the network/dynamic-import leaf with a counter. */
function stubInner(c, impl) {
    const state = { calls: 0 };
    c.buildSealSessionInner = async () => {
        state.calls += 1;
        return impl ? impl(state.calls) : `session-${state.calls}`;
    };
    return state;
}

/** Let queued microtasks and one macrotask turn run. */
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Assert no unhandled rejection escaped while `fn` ran. */
async function withoutUnhandledRejections(fn) {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        await fn();
        await settle();
        await settle();
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(seen, [], "background refresh produced an unhandled rejection");
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ------------------------------------------------------------
// Refresh policy (pure)
// ------------------------------------------------------------

test("sealSessionCacheState: comfortably valid sessions are fresh", () => {
    const now = 1_000_000;
    assert.equal(sealSessionCacheState(now + 5 * 60_000, now), "fresh");
});

test("sealSessionCacheState: the last minute of usable life is refresh-ahead", () => {
    const now = 1_000_000;
    assert.equal(
        sealSessionCacheState(now + SEAL_SESSION_REFRESH_AHEAD_MS - 1, now),
        "refresh-ahead",
    );
    // Boundary: exactly at the window edge already refreshes.
    assert.equal(sealSessionCacheState(now + SEAL_SESSION_REFRESH_AHEAD_MS, now), "refresh-ahead");
    assert.equal(
        sealSessionCacheState(now + SEAL_SESSION_REFRESH_AHEAD_MS + 1, now),
        "fresh",
    );
});

test("sealSessionCacheState: past the deadline is expired, and so is a garbage deadline", () => {
    const now = 1_000_000;
    assert.equal(sealSessionCacheState(now, now), "expired");
    assert.equal(sealSessionCacheState(now - 1, now), "expired");
    assert.equal(sealSessionCacheState(Number.NaN, now), "expired");
});

test("sealSessionCacheState: a zero window reduces to the original lazy behaviour", () => {
    const now = 1_000_000;
    assert.equal(sealSessionCacheState(now + 1, now, 0), "fresh");
    assert.equal(sealSessionCacheState(now - 1, now, 0), "expired");
});

// ------------------------------------------------------------
// Expiry classification + error legibility (pure)
// ------------------------------------------------------------

test("isSealSessionExpiredResponse matches the markers @mysten/seal actually emits", () => {
    // What the sidecar composes when SessionKey.import() rejects an expired envelope.
    const sidecarBody = JSON.stringify({
        error:
            "seal_decrypt failed during resolve_session: Session key has expired " +
            "(traceId=abc, timeoutMs=10000)",
        errorName: "ExpiredSessionKeyError",
        phase: "resolve_session",
    });
    assert.equal(isSealSessionExpiredResponse(500, sidecarBody), true);
    // Key servers answer InvalidCertificate for an expired certificate.
    assert.equal(isSealSessionExpiredResponse(400, '{"error":"InvalidCertificate"}'), true);
});

test("isSealSessionExpiredResponse does not fire on unrelated failures", () => {
    assert.equal(isSealSessionExpiredResponse(500, '{"error":"Internal server error"}'), false);
    assert.equal(isSealSessionExpiredResponse(500, '{"error":"NoAccessError"}'), false);
    assert.equal(isSealSessionExpiredResponse(500, ""), false);
    // A 200 is never an expiry, whatever the body says.
    assert.equal(isSealSessionExpiredResponse(200, "Session key has expired"), false);
});

test("sealSessionBuildError tags transient build failures 503 so withRetry retries them", () => {
    const err = sealSessionBuildError(new Error("fetch failed: ECONNRESET"));
    assert.match(err.message, /Failed to build SEAL session/);
    assert.match(err.message, /ECONNRESET/);
    assert.equal(err.status, 503);
    assert.equal(err.serverCode, "SEAL_SESSION_BUILD_FAILED");
    assert.equal(err.name, "MemWalSealSessionError");
});

test("sealSessionBuildError tags a missing peer dependency 400 so withRetry stops", () => {
    const err = sealSessionBuildError(
        new Error(
            "Required grpc Sui client or Ed25519Keypair not found in @mysten/sui. " +
                "Ensure @mysten/sui >=2.5.0 and @mysten/seal >=1.1.0 are installed.",
        ),
    );
    assert.equal(err.status, 400);
    assert.equal(err.serverCode, "SEAL_SESSION_UNAVAILABLE");
});

test("sealSessionBuildError survives non-Error throws and redacts sidecar URLs", () => {
    const err = sealSessionBuildError("boom at http://localhost:3001/seal/decrypt");
    assert.match(err.message, /Failed to build SEAL session: boom at \[internal\]/);
    assert.equal(err.status, 503);
});

test("sealSessionExpiredError is terminal for retry helpers and keeps the wire status on cause", () => {
    const err = sealSessionExpiredError(500, "Session key has expired");
    assert.match(err.message, /SEAL session expired/);
    // 400, not 500: the rebuild already failed, so withRetry and the
    // `status >= 500` job poll must stop instead of retrying clock skew.
    assert.equal(err.status, 400);
    assert.equal(err.serverCode, "SEAL_SESSION_EXPIRED");
    assert.equal(err.cause.status, 500);
    assert.equal(err.cause.body, "Session key has expired");
});

test("sealSessionBuildError tags an unresolvable peer import 400 so withRetry stops", () => {
    // The dynamic import throws before buildSealSessionInner's own checks run.
    for (const message of [
        "Cannot find package '@mysten/seal' imported from /app/node_modules/.../utils.js",
        "Cannot find module '@mysten/sui/keypairs/ed25519'",
        // A too-old but resolvable package cannot throw a named-export error
        // here: buildSealSessionInner namespace-imports and guards the symbol,
        // so it is this hand-written message that reaches the classifier.
        "Required SessionKey export not found in @mysten/seal. Ensure @mysten/sui >=2.5.0 and @mysten/seal >=1.1.0 are installed.",
    ]) {
        const err = sealSessionBuildError(new Error(message));
        assert.equal(err.status, 400, message);
        assert.equal(err.serverCode, "SEAL_SESSION_UNAVAILABLE", message);
    }
});

// ------------------------------------------------------------
// buildSealSession orchestration (real method, stubbed leaf)
// ------------------------------------------------------------

test("a comfortably fresh cached session is returned without rebuilding", async () => {
    const c = client();
    const inner = stubInner(c);
    c.sessionCache = { bytes: "cached", expiresAt: Date.now() + 5 * 60_000 };

    assert.equal(await c.buildSealSession(), "cached");
    await settle();

    assert.equal(inner.calls, 0);
    assert.equal(c.sessionCache.bytes, "cached");
});

test("inside the refresh-ahead window the cached bytes are returned AND one refresh runs", async () => {
    const c = client();
    const inner = stubInner(c);
    c.sessionCache = { bytes: "cached", expiresAt: Date.now() + 10_000 };

    // Concurrency: three simultaneous callers must share a single rebuild.
    const served = await Promise.all([
        c.buildSealSession(),
        c.buildSealSession(),
        c.buildSealSession(),
    ]);

    // Nobody blocked on the rebuild — everyone got the still-valid bytes.
    assert.deepEqual(served, ["cached", "cached", "cached"]);

    await settle();

    // Single-flight held: exactly one rebuild for three concurrent callers.
    assert.equal(inner.calls, 1);
    // ...and it landed, pushing the deadline back out of the refresh window.
    assert.equal(c.sessionCache.bytes, "session-1");
    assert.ok(c.sessionCache.expiresAt > Date.now() + SEAL_SESSION_REFRESH_AHEAD_MS);
    assert.equal(c.sessionBuildPromise, null);

    // The refreshed session is now fresh, so no further rebuild is triggered.
    assert.equal(await c.buildSealSession(), "session-1");
    await settle();
    assert.equal(inner.calls, 1);
});

test("a failed background refresh leaves the valid cached session usable and rejects nothing", async () => {
    const c = client();
    let calls = 0;
    c.buildSealSessionInner = async () => {
        calls += 1;
        throw new Error("sui rpc unreachable");
    };
    const expiresAt = Date.now() + 10_000;
    c.sessionCache = { bytes: "cached", expiresAt };

    await withoutUnhandledRejections(async () => {
        assert.equal(await c.buildSealSession(), "cached");
    });

    // The still-valid session survived the failed refresh untouched.
    assert.equal(calls, 1);
    assert.equal(c.sessionCache.bytes, "cached");
    assert.equal(c.sessionCache.expiresAt, expiresAt);
    assert.equal(c.sessionBuildPromise, null);

    // Still serving, and the next use re-attempts rather than giving up.
    await withoutUnhandledRejections(async () => {
        assert.equal(await c.buildSealSession(), "cached");
    });
    assert.equal(calls, 2);
});

test("an expired cache blocks on a rebuild and surfaces a classified error when it fails", async () => {
    const c = client();
    c.sessionCache = { bytes: "stale", expiresAt: Date.now() - 1 };
    c.buildSealSessionInner = async () => {
        throw new Error("sui rpc unreachable");
    };

    await assert.rejects(c.buildSealSession(), (err) => {
        assert.match(err.message, /Failed to build SEAL session: sui rpc unreachable/);
        assert.equal(err.status, 503);
        assert.equal(err.serverCode, "SEAL_SESSION_BUILD_FAILED");
        return true;
    });
    assert.equal(c.sessionBuildPromise, null);
});

test("an expired cache is replaced by a blocking rebuild when that rebuild succeeds", async () => {
    const c = client();
    const inner = stubInner(c);
    c.sessionCache = { bytes: "stale", expiresAt: Date.now() - 1 };

    assert.equal(await c.buildSealSession(), "session-1");
    assert.equal(inner.calls, 1);
    assert.equal(c.sessionCache.bytes, "session-1");
});

test("a background refresh that lands after destroy() cannot re-arm the wiped cache", async () => {
    const c = client();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    c.buildSealSessionInner = async () => {
        await gate;
        return "late-session";
    };
    c.sessionCache = { bytes: "cached", expiresAt: Date.now() + 10_000 };

    await withoutUnhandledRejections(async () => {
        // Enters the refresh window and kicks off a rebuild that has not
        // resolved yet...
        assert.equal(await c.buildSealSession(), "cached");
        assert.notEqual(c.sessionBuildPromise, null);

        // ...then the caller drops the client while that rebuild is in flight.
        c.destroy();
        assert.equal(c.sessionCache, null);
        assert.equal(c.sessionBuildPromise, null);

        release();
    });

    // The late build resolved, but must not have resurrected session material.
    assert.equal(c.sessionCache, null);
});

// ------------------------------------------------------------
// Server-side expiry recovery through signedRequest
// ------------------------------------------------------------

function versionResponse() {
    return Response.json({
        apiVersion: "1.0.0",
        relayerVersion: "1.0.0",
        minSupportedSdk: { typescript: "0.0.4" },
    });
}

const EXPIRED_BODY = JSON.stringify({
    error:
        "seal decrypt failed: seal_decrypt failed during resolve_session: " +
        "Session key has expired (traceId=abc, timeoutMs=10000)",
    errorName: "ExpiredSessionKeyError",
});

test("a server-side session expiry invalidates the cache and retries exactly once", async () => {
    const c = client();
    const inner = stubInner(c);
    const sentSessions = [];
    const nonces = [];

    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionResponse();
        if (path === "/api/recall") {
            sentSessions.push(init.headers["x-seal-session"]);
            nonces.push(init.headers["x-nonce"]);
            if (sentSessions.length === 1) {
                return new Response(EXPIRED_BODY, { status: 500 });
            }
            return Response.json({ memories: [] });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const result = await c.signedRequest("POST", "/api/recall", { query: "x" });

    assert.deepEqual(result, { memories: [] });
    // Retried once, with a genuinely rebuilt session — not the rejected one.
    assert.equal(sentSessions.length, 2);
    assert.deepEqual(sentSessions, ["session-1", "session-2"]);
    assert.equal(inner.calls, 2);
    // MED-1 replay protection: the retry must not reuse the first nonce.
    assert.notEqual(nonces[0], nonces[1]);
    assert.equal(c.sessionCache.bytes, "session-2");
});

test("a persistently rejected session stops after one retry instead of looping", async () => {
    const c = client();
    const inner = stubInner(c);
    let recalls = 0;

    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionResponse();
        if (path === "/api/recall") {
            recalls += 1;
            return new Response(EXPIRED_BODY, { status: 500 });
        }
        throw new Error(`unexpected request ${path}`);
    };

    await assert.rejects(c.signedRequest("POST", "/api/recall", { query: "x" }), (err) => {
        assert.match(err.message, /SEAL session expired/);
        assert.equal(err.status, 400);
        assert.equal(err.cause.status, 500);
        assert.equal(err.serverCode, "SEAL_SESSION_EXPIRED");
        return true;
    });

    // Bounded: two attempts total, two session builds. Never a loop.
    assert.equal(recalls, 2);
    assert.equal(inner.calls, 2);
    // The rejected session is not left behind for the next caller to reuse.
    assert.equal(c.sessionCache, null);
});

test("an unrelated server error is not mistaken for an expiry and is not retried", async () => {
    const c = client();
    const inner = stubInner(c);
    let recalls = 0;

    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionResponse();
        if (path === "/api/recall") {
            recalls += 1;
            return new Response(JSON.stringify({ error: "Internal server error (traceId: x)" }), {
                status: 500,
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    await assert.rejects(c.signedRequest("POST", "/api/recall", { query: "x" }), (err) => {
        // Falls through to the pre-existing LOW-26 sanitizer, untouched.
        assert.match(err.message, /Walrus Memory server error \(500\)/);
        assert.notEqual(err.serverCode, "SEAL_SESSION_EXPIRED");
        return true;
    });

    assert.equal(recalls, 1);
    assert.equal(inner.calls, 1);
    // A non-expiry failure must leave the session cache alone.
    assert.equal(c.sessionCache.bytes, "session-1");
});

test("Manual-mode routes send no session and never enter the expiry retry path", async () => {
    const c = client();
    const inner = stubInner(c);
    let calls = 0;

    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionResponse();
        if (path === "/api/recall-manual") {
            calls += 1;
            assert.equal(init.headers["x-seal-session"], undefined);
            return new Response(EXPIRED_BODY, { status: 500 });
        }
        throw new Error(`unexpected request ${path}`);
    };

    await assert.rejects(
        c.signedRequest("POST", "/api/recall-manual", { query: "x" }, [200], {
            includeDelegateKey: false,
        }),
    );

    assert.equal(calls, 1);
    assert.equal(inner.calls, 0);
});
