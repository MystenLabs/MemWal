/**
 * Memory tools call the SDK, not an SSE session.
 *
 * A stub client stands in for MemWal: no HTTP, no /api/mcp/sse mock.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatToolError, UNAUTHORIZED_TEXT } from "../dist/format.js";
import { runMemoryTool } from "../dist/tools.js";

function stub(overrides = {}) {
    const calls = [];
    const client = {
        calls,
        rememberAndWait: async (text, namespace) => {
            calls.push(["rememberAndWait", text, namespace]);
            return { blob_id: "blob-1", namespace: namespace ?? "default" };
        },
        rememberBulkAndWait: async (items) => {
            calls.push(["rememberBulkAndWait", items]);
            return {
                results: items.map(() => ({ status: "done", blob_id: "blob-b" })),
                succeeded: items.length,
                total: items.length,
                failed: 0,
            };
        },
        recall: async (params) => {
            calls.push(["recall", params]);
            return {
                results: [
                    {
                        text: "montreal trip",
                        distance: 0.1,
                        created_at: "2026-09-01T12:00:00Z",
                    },
                ],
            };
        },
        analyzeAndWait: async (text, namespace) => {
            calls.push(["analyzeAndWait", text, namespace]);
            return {
                facts: [{ text: "likes coffee" }],
                results: [{ status: "done", blob_id: "blob-a" }],
                succeeded: 1,
                failed: 0,
            };
        },
        restore: async (namespace, limit) => {
            calls.push(["restore", namespace, limit]);
            return {
                namespace,
                total: 3,
                restored: 2,
                skipped: 1,
                failed: 0,
                truncated: false,
            };
        },
        health: async () => {
            calls.push(["health"]);
            return { status: "ok", version: "1.2.3", write_ready: true };
        },
        destroy() {},
        ...overrides,
    };
    return client;
}

const RELAYER = "https://relayer.dev.memwal.ai";

test("memwal_remember goes through rememberAndWait and never mentions SSE", async () => {
    const client = stub();
    const result = await runMemoryTool(
        "memwal_remember",
        { text: "I use pnpm" },
        "work",
        client,
        RELAYER,
    );
    assert.equal(result.isError, false);
    assert.match(result.text, /blob_id=blob-1/);
    assert.match(result.text, /namespace=work/);
    assert.doesNotMatch(result.text, /sse/i);
    assert.deepEqual(client.calls[0], ["rememberAndWait", "I use pnpm", "work"]);
});

test("memwal_recall goes through recall with maxDistance and formats hits", async () => {
    const client = stub();
    const result = await runMemoryTool(
        "memwal_recall",
        { query: "trip", limit: 5, maxDistance: 0.4 },
        undefined,
        client,
        RELAYER,
    );
    assert.equal(result.isError, false);
    assert.match(result.text, /montreal trip/);
    assert.match(result.text, /score=0.900/);
    assert.match(result.text, /written=2026-09-01/);
    assert.deepEqual(client.calls[0][1], {
        query: "trip",
        limit: 5,
        namespace: undefined,
        maxDistance: 0.4,
    });
});

test("memwal_remember_bulk maps facts onto rememberBulkAndWait", async () => {
    const client = stub();
    const result = await runMemoryTool(
        "memwal_remember_bulk",
        { facts: ["a", "b"] },
        "ns",
        client,
        RELAYER,
    );
    assert.equal(result.isError, false);
    assert.match(result.text, /Saved 2\/2/);
    assert.equal(client.calls[0][0], "rememberBulkAndWait");
    assert.deepEqual(client.calls[0][1], [
        { text: "a", namespace: "ns" },
        { text: "b", namespace: "ns" },
    ]);
});

test("memwal_health names the dialled relayer", async () => {
    const client = stub();
    const result = await runMemoryTool("memwal_health", {}, undefined, client, RELAYER);
    assert.equal(result.isError, false);
    assert.match(result.text, /status=ok/);
    assert.match(result.text, /write_ready=true/);
    assert.match(result.text, new RegExp(`relayer=${RELAYER}`));
});

test("memwal_restore reports counts from restore()", async () => {
    const client = stub();
    const result = await runMemoryTool(
        "memwal_restore",
        { namespace: "work" },
        undefined,
        client,
        RELAYER,
    );
    assert.equal(result.isError, false);
    assert.match(result.text, /restored=2/);
    assert.match(result.text, /truncated=false/);
});

test("a 401 from the SDK is not a creds wipe — it names login", async () => {
    const err = Object.assign(new Error("unauthorized"), { status: 401 });
    const formatted = formatToolError(err);
    assert.equal(formatted.isError, true);
    assert.equal(formatted.text, UNAUTHORIZED_TEXT);

    const client = stub({
        recall: async () => {
            throw Object.assign(new Error("nope"), { status: 401 });
        },
    });
    const result = await runMemoryTool(
        "memwal_recall",
        { query: "x" },
        undefined,
        client,
        RELAYER,
    );
    assert.equal(result.isError, true);
    assert.equal(result.text, UNAUTHORIZED_TEXT);
});
