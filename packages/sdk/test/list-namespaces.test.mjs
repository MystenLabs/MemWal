import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const OWNER = "0xowner0000000000000000000000000000000000000000000000000000000001";
const originalFetch = globalThis.fetch;

function client() {
    return MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

/**
 * Stub the three calls a listNamespaces() round-trip makes: the compatibility
 * preflight, the owner resolution, and the read itself. Records every request
 * so tests can assert on paths, headers and call counts.
 */
function stubRelayer(namespacesBody) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = new URL(url);
        calls.push({ path: u.pathname, search: u.search, method: init.method ?? "GET", headers: init.headers ?? {} });

        if (u.pathname === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (u.pathname === "/api/stats") {
            return Response.json({ memory_count: 0, storage_bytes: 0, namespace: "default", owner: OWNER });
        }
        if (u.pathname === `/v1/owners/${OWNER}/namespaces`) {
            return Response.json(namespacesBody);
        }
        throw new Error(`unexpected request: ${u.pathname}`);
    };
    return calls;
}

const ONE_PAGE = {
    namespaces: [
        { id: "ns-1", name: "work", memory_count: 12, storage_used: 2048, updated_at: "2026-08-20T10:00:00Z" },
    ],
    next_cursor: "2026-08-20T10:00:00Z",
    has_more: false,
    snapshot_version: 1,
};

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("listNamespaces reads the owner-scoped namespaces path", async () => {
    const calls = stubRelayer(ONE_PAGE);

    await client().listNamespaces();

    const read = calls.find((c) => c.path.endsWith("/namespaces"));
    assert.ok(read, "expected a request to the namespaces endpoint");
    assert.equal(read.path, `/v1/owners/${OWNER}/namespaces`);
    assert.equal(read.method, "GET");
});

test("listNamespaces resolves the owner once and reuses it", async () => {
    const calls = stubRelayer(ONE_PAGE);
    const memwal = client();

    await memwal.listNamespaces();
    await memwal.listNamespaces();

    const statsCalls = calls.filter((c) => c.path === "/api/stats");
    assert.equal(statsCalls.length, 1, "owner resolution must be memoised across calls");
    assert.equal(calls.filter((c) => c.path.endsWith("/namespaces")).length, 2);
});

test("listNamespaces forwards cursor as updated_after and passes limit", async () => {
    const calls = stubRelayer(ONE_PAGE);

    await client().listNamespaces({ cursor: "2026-08-20T10:00:00Z", limit: 25 });

    const read = calls.find((c) => c.path.endsWith("/namespaces"));
    const params = new URLSearchParams(read.search);
    assert.equal(params.get("updated_after"), "2026-08-20T10:00:00Z");
    assert.equal(params.get("limit"), "25");
});

test("listNamespaces omits query params that were not supplied", async () => {
    const calls = stubRelayer(ONE_PAGE);

    await client().listNamespaces();

    const read = calls.find((c) => c.path.endsWith("/namespaces"));
    const params = new URLSearchParams(read.search);
    assert.equal(params.get("updated_after"), null);
    assert.equal(params.get("limit"), null);
});

test("listNamespaces returns the relayer's wire shape unchanged", async () => {
    stubRelayer(ONE_PAGE);

    const result = await client().listNamespaces();

    assert.deepEqual(result, ONE_PAGE);
    // has_more is the authoritative pagination signal, not page length.
    assert.equal(result.has_more, false);
    assert.equal(result.namespaces[0].name, "work");
});

test("listNamespaces sends no SEAL session on a metadata-only read", async () => {
    const calls = stubRelayer(ONE_PAGE);

    await client().listNamespaces();

    for (const call of calls.filter((c) => c.path !== "/version")) {
        const headers = call.headers;
        assert.equal(
            headers["x-seal-session"],
            undefined,
            `${call.path} must not build a decrypt credential for a metadata-only read`,
        );
    }
});
