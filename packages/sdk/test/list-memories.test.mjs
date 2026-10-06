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
 * Stub the three calls a listMemories() round-trip makes: the compatibility
 * preflight, the owner resolution, and the read itself. Records every request
 * so tests can assert on paths, headers and call counts.
 */
function stubRelayer(memoriesBody) {
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
        if (u.pathname === `/v1/owners/${OWNER}/memories`) {
            return Response.json(memoriesBody);
        }
        throw new Error(`unexpected request: ${u.pathname}`);
    };
    return calls;
}

function memory(id, namespace) {
    return {
        memory_id: id,
        namespace_id: namespace,
        blob_id: `blob-${id}`,
        created_at: "2026-08-20T10:00:00Z",
        updated_at: "2026-08-20T10:00:00Z",
        size: 512,
        agent_id: null,
        package_id: "0x1",
        status: "active",
        end_epoch: 42,
        expires_at: null,
        importance: null,
    };
}

const PAGE = {
    memories: [memory("m1", "work"), memory("m2", "personal"), memory("m3", "work")],
    next_cursor: "cursor-1",
    has_more: true,
    snapshot_version: 2,
    deleted: [
        { memory_id: "m0", namespace_id: "personal", deleted_at: "2026-08-20T09:00:00Z" },
        { memory_id: "m9", namespace_id: "work", deleted_at: "2026-08-20T09:00:00Z" },
    ],
    must_resync: false,
};

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("listMemories reads the owner-scoped memories path", async () => {
    const calls = stubRelayer(PAGE);

    await client().listMemories();

    const read = calls.find((c) => c.path.endsWith("/memories"));
    assert.ok(read, "expected a request to the memories endpoint");
    assert.equal(read.path, `/v1/owners/${OWNER}/memories`);
    assert.equal(read.method, "GET");
});

test("listMemories forwards cursor as updated_after and passes limit", async () => {
    const calls = stubRelayer(PAGE);

    await client().listMemories({ cursor: "cursor-0", limit: 25 });

    const params = new URLSearchParams(calls.find((c) => c.path.endsWith("/memories")).search);
    assert.equal(params.get("updated_after"), "cursor-0");
    assert.equal(params.get("limit"), "25");
});

test("listMemories never sends the namespace to the relayer", async () => {
    const calls = stubRelayer(PAGE);

    await client().listMemories({ namespace: "work" });

    const params = new URLSearchParams(calls.find((c) => c.path.endsWith("/memories")).search);
    assert.equal(params.get("namespace"), null);
});

test("listMemories without a namespace returns the relayer's wire shape unchanged", async () => {
    stubRelayer(PAGE);

    const result = await client().listMemories();

    assert.deepEqual(result, PAGE);
});

test("listMemories with a namespace keeps only that namespace, pagination intact", async () => {
    stubRelayer(PAGE);

    const result = await client().listMemories({ namespace: "work" });

    assert.deepEqual(result.memories.map((m) => m.memory_id), ["m1", "m3"]);
    assert.deepEqual(result.deleted.map((d) => d.memory_id), ["m9"]);
    assert.equal(result.next_cursor, "cursor-1");
    assert.equal(result.has_more, true);
});

test("listMemories with a namespace can return an empty page that still has more", async () => {
    stubRelayer(PAGE);

    const result = await client().listMemories({ namespace: "nowhere" });

    assert.deepEqual(result.memories, []);
    assert.equal(result.has_more, true, "an empty filtered page is not the end of the walk");
});

test("listMemories defaults tombstone fields an older relayer omits", async () => {
    const { deleted: _d, must_resync: _m, ...legacy } = PAGE;
    stubRelayer(legacy);

    const result = await client().listMemories({ namespace: "work" });

    assert.deepEqual(result.deleted, []);
    assert.equal(result.must_resync, false);
});

test("listMemories walks every page and counts a namespace exactly", async () => {
    const pages = [
        { ...PAGE, memories: [memory("a", "work"), memory("b", "other")], next_cursor: "c1", has_more: true, deleted: [] },
        { ...PAGE, memories: [memory("c", "other")], next_cursor: "c2", has_more: true, deleted: [] },
        { ...PAGE, memories: [memory("d", "work")], next_cursor: "c3", has_more: false, deleted: [] },
    ];
    const cursors = [];
    globalThis.fetch = async (url) => {
        const u = new URL(url);
        if (u.pathname === "/version") {
            return Response.json({ apiVersion: "1.0.0", relayerVersion: "1.0.0", minSupportedSdk: { typescript: "0.0.4" } });
        }
        if (u.pathname === "/api/stats") return Response.json({ owner: OWNER });
        cursors.push(u.searchParams.get("updated_after"));
        return Response.json(pages[cursors.length - 1]);
    };

    const memwal = client();
    let cursor;
    let more = true;
    let count = 0;
    while (more) {
        const page = await memwal.listMemories({ cursor, namespace: "work" });
        count += page.memories.length;
        cursor = page.next_cursor ?? undefined;
        more = page.has_more;
    }

    assert.equal(count, 2);
    assert.deepEqual(cursors, [null, "c1", "c2"]);
});

test("listMemories sends no SEAL session on a metadata-only read", async () => {
    const calls = stubRelayer(PAGE);

    await client().listMemories();

    for (const call of calls.filter((c) => c.path !== "/version")) {
        assert.equal(
            call.headers["x-seal-session"],
            undefined,
            `${call.path} must not build a decrypt credential for a metadata-only read`,
        );
    }
});
