import assert from "node:assert/strict";
import test from "node:test";

import {
    MemWal,
    MemWalMock,
    applyTokenBudget,
    validateMaxTokens,
} from "../dist/index.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stubRecall(hits) {
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/config" || path === "/config") {
            return Response.json({ packageId: "0x1", network: "testnet" });
        }
        if (path === "/api/recall" && init.method === "POST") {
            return Response.json({
                results: hits,
                total: hits.length,
            });
        }
        throw new Error(`unexpected request ${path}`);
    };
}

function client() {
    const c = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "test-account",
        serverUrl: "https://relayer.example",
    });
    c.buildSealSession = async () => "test-session";
    return c;
}

function chars(n) {
    return "a".repeat(n);
}

// ── validateMaxTokens ────────────────────────────────────────────────────────

test("validateMaxTokens accepts valid budgets", () => {
    assert.doesNotThrow(() => validateMaxTokens(undefined));
    assert.doesNotThrow(() => validateMaxTokens(0));
    assert.doesNotThrow(() => validateMaxTokens(10));
    assert.doesNotThrow(() => validateMaxTokens(1.5));
    assert.doesNotThrow(() => validateMaxTokens(NaN));
    assert.doesNotThrow(() => validateMaxTokens(Infinity));
});

test("validateMaxTokens throws RangeError on negative budgets", () => {
    assert.throws(
        () => validateMaxTokens(-1),
        {
            name: "RangeError",
            message: "maxTokens must be non-negative",
        },
    );
    assert.throws(
        () => validateMaxTokens(-5),
        {
            name: "RangeError",
            message: "maxTokens must be non-negative",
        },
    );
    assert.throws(
        () => validateMaxTokens(-0.5),
        {
            name: "RangeError",
            message: "maxTokens must be non-negative",
        },
    );
});

test("validateMaxTokens throws TypeError on non-numeric budgets", () => {
    for (const invalid of ["400", null, {}, [], false, true, Symbol("x")]) {
        assert.throws(
            () => validateMaxTokens(invalid),
            {
                name: "TypeError",
                message: "maxTokens must be a number",
            },
        );
    }
});

// ── applyTokenBudget validation ──────────────────────────────────────────────

test("applyTokenBudget validates maxTokens", () => {
    const hits = [{ blob_id: "b1", text: "hello world", distance: 0.1 }];
    assert.throws(
        () => applyTokenBudget(hits, -5),
        {
            name: "RangeError",
            message: "maxTokens must be non-negative",
        },
    );
    assert.throws(
        () => applyTokenBudget(hits, "400"),
        {
            name: "TypeError",
            message: "maxTokens must be a number",
        },
    );
});

test("applyTokenBudget handles zero budget honestly", () => {
    const hits = [
        { blob_id: "b1", text: chars(40), distance: 0.1 },
        { blob_id: "b2", text: chars(40), distance: 0.2 },
    ];
    const budgeted = applyTokenBudget(hits, 0);
    assert.equal(budgeted.results.length, 0);
    assert.equal(budgeted.meta.truncated, true);
    assert.equal(budgeted.meta.tokenEstimate, 0);

    const empty = applyTokenBudget([], 0);
    assert.equal(empty.results.length, 0);
    assert.equal(empty.meta.truncated, false);
    assert.equal(empty.meta.tokenEstimate, 0);
});

test("applyTokenBudget treats NaN and Infinity as no budget", () => {
    const hits = [
        { blob_id: "b1", text: chars(40), distance: 0.1 },
        { blob_id: "b2", text: chars(40), distance: 0.2 },
    ];
    const forNaN = applyTokenBudget(hits, NaN);
    assert.equal(forNaN.results.length, 2);
    assert.equal(forNaN.meta.truncated, false);

    const forInf = applyTokenBudget(hits, Infinity);
    assert.equal(forInf.results.length, 2);
    assert.equal(forInf.meta.truncated, false);
});

// ── MemWal.recall() validation & total preservation ─────────────────────────

test("MemWal.recall() throws RangeError on negative maxTokens before fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return Response.json({});
    };

    await assert.rejects(
        () => client().recall({ query: "test", maxTokens: -5 }),
        {
            name: "RangeError",
            message: "maxTokens must be non-negative",
        },
    );
    assert.equal(fetchCalled, false, "network fetch must not be called when maxTokens is invalid");
});

test("MemWal.recall() throws TypeError on non-numeric maxTokens before fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return Response.json({});
    };

    for (const invalid of ["400", null, {}, false]) {
        await assert.rejects(
            () => client().recall({ query: "test", maxTokens: invalid }),
            {
                name: "TypeError",
                message: "maxTokens must be a number",
            },
        );
        assert.equal(fetchCalled, false, "network fetch must not be called when maxTokens is invalid");
    }
});

test("MemWal.recall() preserves relayer total when results are trimmed by token budget", async () => {
    const hits = [
        { blob_id: "b1", text: chars(40), distance: 0.1 },
        { blob_id: "b2", text: chars(40), distance: 0.2 },
        { blob_id: "b3", text: chars(40), distance: 0.3 },
    ];
    stubRecall(hits);

    const result = await client().recall({ query: "test", maxTokens: 10 });
    assert.equal(result.results.length, 1, "only 1 memory fits within 10 tokens");
    assert.equal(result.total, 3, "total preserves matching relayer count, not trimmed count");
    assert.ok(result.meta);
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.tokenEstimate, 10);
});

test("MemWal.recall() preserves total when maxTokens is 0", async () => {
    const hits = [
        { blob_id: "b1", text: chars(40), distance: 0.1 },
        { blob_id: "b2", text: chars(40), distance: 0.2 },
    ];
    stubRecall(hits);

    const result = await client().recall({ query: "test", maxTokens: 0 });
    assert.equal(result.results.length, 0);
    assert.equal(result.total, 2, "total preserves 2 matching memories even when 0 returned");
    assert.ok(result.meta);
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.tokenEstimate, 0);
});

test("MemWal.recall() with maxTokens NaN or Infinity leaves results unchanged and untruncated", async () => {
    const hits = [
        { blob_id: "b1", text: chars(40), distance: 0.1 },
        { blob_id: "b2", text: chars(40), distance: 0.2 },
    ];
    stubRecall(hits);

    const forNaN = await client().recall({ query: "test", maxTokens: NaN });
    assert.equal(forNaN.results.length, 2);
    assert.equal(forNaN.total, 2);
    assert.equal(forNaN.meta.truncated, false);

    const forInf = await client().recall({ query: "test", maxTokens: Infinity });
    assert.equal(forInf.results.length, 2);
    assert.equal(forInf.total, 2);
    assert.equal(forInf.meta.truncated, false);
});

// ── MemWalMock.recall() validation & total preservation ───────────────────────

test("MemWalMock.recall() throws RangeError on negative maxTokens", async () => {
    const mock = MemWalMock.create({
        initialMemories: [{ text: "hello world" }],
    });

    await assert.rejects(
        () => mock.recall({ query: "hello", maxTokens: -5 }),
        {
            name: "RangeError",
            message: "maxTokens must be non-negative",
        },
    );
});

test("MemWalMock.recall() throws TypeError on non-numeric maxTokens", async () => {
    const mock = MemWalMock.create({
        initialMemories: [{ text: "hello world" }],
    });

    for (const invalid of ["400", null, {}, false]) {
        await assert.rejects(
            () => mock.recall({ query: "hello", maxTokens: invalid }),
            {
                name: "TypeError",
                message: "maxTokens must be a number",
            },
        );
    }
});

test("MemWalMock.recall() preserves total matching count when trimmed by token budget", async () => {
    const mock = MemWalMock.create({
        initialMemories: [
            { text: chars(40) },
            { text: chars(40) },
            { text: chars(40) },
        ],
    });

    const result = await mock.recall({ query: "a", limit: 3, maxTokens: 10 });
    assert.equal(result.results.length, 1);
    assert.equal(result.total, 3, "mock total preserves matching count of 3");
    assert.ok(result.meta);
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.tokenEstimate, 10);
});

test("MemWalMock.recall() preserves total when maxTokens is 0", async () => {
    const mock = MemWalMock.create({
        initialMemories: [
            { text: chars(40) },
            { text: chars(40) },
        ],
    });

    const result = await mock.recall({ query: "a", limit: 2, maxTokens: 0 });
    assert.equal(result.results.length, 0);
    assert.equal(result.total, 2, "mock total preserves matching count of 2");
    assert.ok(result.meta);
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.tokenEstimate, 0);
});
