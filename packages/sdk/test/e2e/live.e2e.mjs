/**
 * E2E tests for the Walrus Memory JS SDK against a live relayer.
 *
 * Targets MEMWAL_SERVER_URL (default: https://relayer-staging.memory.walrus.xyz).
 * The structure mirrors the Python SDK's tests/test_integration.py so the two
 * suites stay comparable; `ask()` has no JS equivalent (its analogue is the
 * `ai/` integration, which needs a model provider and is out of scope here).
 *
 * No-auth tests (always run, no env vars needed):
 *   - /health endpoint
 *   - Compatibility contract (GET /version) accepts this SDK
 *   - Unsigned request → 401
 *   - Wrong signature → 401
 *   - Expired timestamp → 401
 *   - Future timestamp → 401
 *   - Unregistered key → SDK error carrying the 401/403
 *
 * Authenticated tests (require MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID):
 *   - remember() acceptance, rememberAndWait(), namespace handling
 *   - recall()
 *   - analyze() / analyzeAndWait()
 *   - rememberBulkAndWait()
 *   - restore()
 *   - Full e2e: remember → recall → verify
 *
 * Usage:
 *   # Run only no-auth tests (no keys needed)
 *   pnpm --filter @mysten-incubation/memwal test:e2e
 *
 *   # Run full suite with real credentials
 *   MEMWAL_PRIVATE_KEY=<hex> MEMWAL_ACCOUNT_ID=0x... \
 *     pnpm --filter @mysten-incubation/memwal test:e2e
 *
 *   # Point at a specific relayer
 *   MEMWAL_SERVER_URL=https://relayer.dev.memwal.ai ...
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import * as ed from "@noble/ed25519";

import { MemWal, MemWalCompatibilityError } from "../../dist/index.js";
import { bytesToHex, sha256hex } from "../../dist/utils.js";

// ── Config ───────────────────────────────────────────────────────────────────

const SERVER_URL = (process.env.MEMWAL_SERVER_URL ?? "https://relayer-staging.memory.walrus.xyz").replace(/\/$/, "");
const PRIVATE_KEY_HEX = process.env.MEMWAL_PRIVATE_KEY ?? "";
const ACCOUNT_ID = process.env.MEMWAL_ACCOUNT_ID ?? "";

// A live write runs embed -> SEAL encrypt -> Walrus upload -> on-chain metadata.
// Measured around 44s against the dev relayer, so the SDK's 60s default leaves
// too little headroom to be reliable in CI. 120s matches what the SDK already
// uses for bulk pipelines.
function positiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive number of milliseconds, got '${raw}'`);
    }
    return parsed;
}

const REMEMBER_TIMEOUT_MS = positiveIntEnv("MEMWAL_REMEMBER_TIMEOUT_MS", 120_000);

// analyze() fans one input out into N facts, each its own full write pipeline.
// They round-robin across relayer wallet slots and usually overlap, but the
// bench account is shared, so a contended pool can push a 3-fact extraction
// past the single-write budget. Give the fan-out twice the headroom rather
// than letting a slow-but-healthy run report failed jobs.
const ANALYZE_TIMEOUT_MS = REMEMBER_TIMEOUT_MS * 2;

// Every authenticated test writes into a namespace unique to this run. The bench
// account is shared, and `default` in particular is what real users get, so a
// recurring job must not leave live Walrus blobs there.
const E2E_NAMESPACE = `sdk-e2e-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const E2E_NAMESPACE_ALT = `${E2E_NAMESPACE}-alt`;

const HAS_KEY = Boolean(PRIVATE_KEY_HEX && ACCOUNT_ID);

// node:test skips the test (with this reason) when the value is a string.
const requiresKey = HAS_KEY ? false : "MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID not set";

function client(namespace = E2E_NAMESPACE) {
    return MemWal.create({
        key: PRIVATE_KEY_HEX,
        accountId: ACCOUNT_ID,
        serverUrl: SERVER_URL,
        namespace,
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Make a raw signed request without using the SDK (for auth rejection tests).
 * Message format matches memwal.ts signedRequest():
 *   "{timestamp}.{method}.{path}.{body_sha256}.{nonce}.{account_id}"
 */
async function rawSignedRequest(method, path, body, privateKey, overrides = {}) {
    const bodyStr = JSON.stringify(body);
    const bodySha256 = await sha256hex(bodyStr);
    const timestamp = overrides.timestamp ?? Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const accountId = ACCOUNT_ID || "0x0";
    const message = `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${accountId}`;
    const signature = await ed.signAsync(new TextEncoder().encode(message), privateKey);
    const publicKeyHex = overrides.publicKeyHex ?? bytesToHex(await ed.getPublicKeyAsync(privateKey));

    return fetch(`${SERVER_URL}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "x-public-key": publicKeyHex,
            "x-signature": bytesToHex(signature),
            "x-timestamp": timestamp,
            "x-nonce": nonce,
            "x-account-id": accountId,
        },
        body: bodyStr,
    });
}

const REJECTION_BODY = { text: "hello", namespace: "default" };

// ── No-auth tests (always run) ───────────────────────────────────────────────

test("health returns ok with a version string", async () => {
    const mw = MemWal.create({ key: "aa".repeat(32), accountId: "0x0", serverUrl: SERVER_URL });
    const result = await mw.health();
    assert.equal(result.status, "ok", `Expected 'ok', got '${result.status}'`);
    assert.equal(typeof result.version, "string");
});

test("compatibility contract accepts this SDK version", async () => {
    // compatibility() both fetches GET /version and validates it against this
    // SDK's compatibility version — a MemWalCompatibilityError here means the
    // live relayer has dropped support for the SDK as released.
    const mw = MemWal.create({ key: "aa".repeat(32), accountId: "0x0", serverUrl: SERVER_URL });
    const result = await mw.compatibility();
    assert.equal(typeof result.relayerVersion, "string");
    assert.equal(typeof result.apiVersion, "string");
    assert.equal(typeof result.minSupportedSdk.typescript, "string");
});

test("unsigned request is rejected with 401", async () => {
    const res = await fetch(`${SERVER_URL}/api/remember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REJECTION_BODY),
    });
    assert.equal(res.status, 401, `Expected 401, got ${res.status}: ${await res.text()}`);
});

test("wrong signature is rejected with 401", async () => {
    // Sign with key A but claim key B's public key.
    const keyA = ed.utils.randomPrivateKey();
    const keyB = ed.utils.randomPrivateKey();
    const res = await rawSignedRequest("POST", "/api/remember", REJECTION_BODY, keyA, {
        publicKeyHex: bytesToHex(await ed.getPublicKeyAsync(keyB)),
    });
    assert.equal(res.status, 401, `Expected 401, got ${res.status}: ${await res.text()}`);
});

test("expired timestamp is rejected with 401", async () => {
    const key = ed.utils.randomPrivateKey();
    const tenMinutesAgo = String(Math.floor(Date.now() / 1000) - 600);
    const res = await rawSignedRequest("POST", "/api/remember", REJECTION_BODY, key, {
        timestamp: tenMinutesAgo,
    });
    assert.equal(res.status, 401, `Expected 401, got ${res.status}: ${await res.text()}`);
});

test("future timestamp is rejected with 401", async () => {
    const key = ed.utils.randomPrivateKey();
    const tenMinutesAhead = String(Math.floor(Date.now() / 1000) + 600);
    const res = await rawSignedRequest("POST", "/api/remember", REJECTION_BODY, key, {
        timestamp: tenMinutesAhead,
    });
    assert.equal(res.status, 401, `Expected 401, got ${res.status}: ${await res.text()}`);
});

test("SDK surfaces an unregistered key as an auth error", async (t) => {
    const mw = MemWal.create({
        key: "bb".repeat(32), // random, not registered on-chain
        accountId: "0x0",
        serverUrl: SERVER_URL,
    });
    try {
        await mw.remember("hello");
        assert.fail("Expected remember() with an unregistered key to throw");
    } catch (err) {
        if (err instanceof MemWalCompatibilityError) {
            t.skip("live relayer does not expose compatibility metadata yet");
            return;
        }
        const status = err.status ?? 0;
        assert.ok(
            status === 401 || status === 403 || /\b40[13]\b/.test(String(err.message)),
            `Expected a 401/403 auth rejection, got: ${err.message}`,
        );
    }
});

// ── Authenticated tests ──────────────────────────────────────────────────────

test("remember returns a job id and an accepted status", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.remember("Integration test: the sky is blue");
    assert.equal(typeof result.job_id, "string");
    assert.ok(result.job_id.length > 0);
    assert.ok(["pending", "running"].includes(result.status), `unexpected status: ${result.status}`);

    // One-shot status lookup on the accepted job (no polling). This asserts the
    // acceptance contract — the job is known to the relayer and reports a real
    // state — so `failed` is tolerated here: whether the background pipeline
    // succeeds is what rememberAndWait covers. `not_found` is the failure that
    // matters, since it means the accepted job_id addresses nothing.
    const status = await mw.getRememberStatus(result.job_id);
    assert.equal(status.job_id, result.job_id);
    assert.ok(
        ["pending", "running", "uploaded", "done", "failed"].includes(status.status),
        `unexpected job status: ${status.status}`,
    );
});

test("rememberAndWait returns blob and owner", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.rememberAndWait("Integration test: the sky is blue", undefined, {
        timeoutMs: REMEMBER_TIMEOUT_MS,
    });
    assert.equal(typeof result.id, "string");
    assert.ok(result.id.length > 0);
    assert.equal(typeof result.blob_id, "string");
    assert.ok(result.blob_id.length > 0);
    assert.ok(result.owner.startsWith("0x"));
});

test("remember uses the client namespace when none is passed", { skip: requiresKey }, async () => {
    // Omitting `namespace` falls back to the one the client was built with.
    // The literal `"default"` fallback is asserted in the mocked suite; proving
    // it here would mean writing a live blob into the namespace real users get.
    const mw = client();
    const result = await mw.rememberAndWait("Integration test: namespace fallback", undefined, {
        timeoutMs: REMEMBER_TIMEOUT_MS,
    });
    assert.equal(result.namespace, E2E_NAMESPACE);
});

test("remember honors a per-call namespace override", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.rememberAndWait(
        "Integration test: custom namespace",
        E2E_NAMESPACE_ALT,
        { timeoutMs: REMEMBER_TIMEOUT_MS },
    );
    assert.equal(result.namespace, E2E_NAMESPACE_ALT);
});

test("recall returns results with the expected fields", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.recall({ query: "sky blue", limit: 5 });
    assert.ok(Array.isArray(result.results));
    assert.ok(result.total >= 0);
    for (const memory of result.results) {
        assert.equal(typeof memory.text, "string");
        assert.equal(typeof memory.blob_id, "string");
        assert.equal(typeof memory.distance, "number");
    }
});

test("recall respects the limit", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.recall({ query: "test", limit: 2 });
    assert.ok(result.results.length <= 2);
});

test("analyze extracts facts", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.analyze("I love hiking and my favorite food is pho.");
    assert.ok(Array.isArray(result.facts));
    assert.ok(result.fact_count >= 0);
    assert.ok(result.owner.startsWith("0x"));
    for (const fact of result.facts) {
        assert.equal(typeof fact.text, "string");
    }
});

test("analyzeAndWait stores every extracted fact", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.analyzeAndWait(
        "I moved to Lisbon last spring and I play tennis every Saturday.",
        undefined,
        { timeoutMs: ANALYZE_TIMEOUT_MS },
    );
    assert.equal(result.results.length, result.facts.length);
    assert.equal(result.failed, 0, `analyze facts failed to store: ${JSON.stringify(result.results)}`);
    assert.equal(result.succeeded, result.facts.length);
});

test("rememberBulkAndWait stores a batch", { skip: requiresKey }, async () => {
    const mw = client();
    const result = await mw.rememberBulkAndWait(
        [
            { text: "Bulk e2e test: I drink oat-milk coffee" },
            { text: "Bulk e2e test: my desk faces a window" },
        ],
        { timeoutMs: REMEMBER_TIMEOUT_MS },
    );
    assert.equal(result.total, 2);
    assert.equal(result.failed, 0, `bulk items failed: ${JSON.stringify(result.results)}`);
    assert.equal(result.succeeded, 2);
    for (const item of result.results) {
        assert.equal(item.status, "done");
        assert.ok(item.blob_id.length > 0);
        // Client-side bookkeeping, not a server echo: the bulk status endpoint
        // returns no namespace, so the SDK fills this in from the request.
        assert.equal(item.namespace, E2E_NAMESPACE);
    }
});

// `embed()` and the lightweight manual mode (`rememberManual` / `recallManual`)
// are deliberately NOT covered here: both SDK methods target contracts this
// relayer does not serve. `/api/embed` is absent from the protected route table
// (services/server/src/main.rs), and `RememberManualRequest`
// (services/server/src/types.rs) requires `encrypted_data` where the SDK sends
// `blob_id`, so the call 422s before reaching the handler. Tests for them would
// be guaranteed red on the first authenticated run. Tracked in WALM-371.

test("restore reports counts for the run namespace", { skip: requiresKey }, async () => {
    // Everything this run stored is already indexed on the relayer, so restore
    // has no work to do — assert the response shape rather than exact counts:
    // candidate discovery is capped per-owner across namespaces (WALM-319), so
    // `total` for a fresh namespace on the shared bench account is not stable.
    const mw = client();
    const result = await mw.restore(E2E_NAMESPACE);
    assert.equal(result.namespace, E2E_NAMESPACE);
    assert.ok(Number.isInteger(result.restored) && result.restored >= 0);
    assert.ok(Number.isInteger(result.skipped) && result.skipped >= 0);
    assert.ok(Number.isInteger(result.total) && result.total >= 0);
    assert.equal(typeof result.truncated, "boolean");
    assert.ok(result.owner.startsWith("0x"));
});

// ── Full flow ────────────────────────────────────────────────────────────────

test("full flow: remember then recall finds it", { skip: requiresKey }, async () => {
    const unique = randomUUID().replaceAll("-", "").slice(0, 8);
    const text = `SDK e2e test ${unique}: quantum entanglement in photonics`;
    const namespace = `sdk-e2e-${unique}`;

    const mw = client();

    // Store a distinctive memory in an isolated namespace.
    const memory = await mw.rememberAndWait(text, namespace, { timeoutMs: REMEMBER_TIMEOUT_MS });
    assert.ok(memory.id.length > 0);

    // Recall — should find the stored memory.
    const result = await mw.recall({ query: `quantum photonics ${unique}`, limit: 5, namespace });
    assert.ok(result.total >= 1, `Expected >= 1 result, got ${result.total}`);
    assert.ok(
        result.results.some((r) => r.text.includes(unique)),
        `Expected unique marker '${unique}' in recalled texts: ${JSON.stringify(result.results.map((r) => r.text))}`,
    );
});
