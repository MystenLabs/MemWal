import assert from "node:assert/strict";
import test from "node:test";

import { MemWalMock } from "../dist/index.js";

test("MemWalMock remembers and recalls deterministically without network access", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error("MemWalMock must not access the network");
    };
    try {
        const mock = MemWalMock.create({
            namespace: "user-a",
            owner: "test-owner",
        });
        const coffee = await mock.rememberAndWait(
            "I prefer coffee in the morning"
        );
        const tea = await mock.rememberAndWait("I drink tea at night");

        assert.equal(coffee.id, "mock-job-000001");
        assert.equal(coffee.job_id, "mock-job-000001");
        assert.equal(coffee.namespace, "user-a");
        assert.equal(tea.blob_id, "mock-blob-000002");

        const recalled = await mock.recall({
            query: "morning coffee",
            limit: 2,
        });
        assert.deepEqual(
            recalled.results.map((memory) => memory.text),
            ["I prefer coffee in the morning", "I drink tea at night"]
        );
        assert.equal(recalled.results[0].distance, 0);
        assert.equal(recalled.results[1].distance, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("MemWalMock isolates namespaces and honors maxDistance", async () => {
    const mock = MemWalMock.create({ namespace: "default" });
    await mock.rememberAndWait("Alice likes ramen", "user-a");
    await mock.rememberAndWait("Bob likes tacos", "user-b");

    const alice = await mock.recall({
        query: "likes",
        namespace: "user-a",
        maxDistance: 0.5,
    });
    const bob = await mock.recall({ query: "likes", namespace: "user-b" });
    const empty = await mock.recall({ query: "likes", namespace: "default" });

    assert.deepEqual(
        alice.results.map((memory) => memory.text),
        ["Alice likes ramen"]
    );
    assert.deepEqual(
        bob.results.map((memory) => memory.text),
        ["Bob likes tacos"]
    );
    assert.equal(empty.total, 0);
});

test("MemWalMock matches production recall overloads and topK precedence", async () => {
    const mock = MemWalMock.create();
    await mock.rememberAndWait("shared first", "options");
    await mock.rememberAndWait("shared second", "options");

    const optionsStyle = await mock.recall("shared", {
        namespace: "options",
        limit: 2,
    });
    const objectStyle = await mock.recall({
        query: "shared",
        namespace: "options",
        limit: 1,
        topK: 2,
    });

    assert.deepEqual(
        optionsStyle.results.map((memory) => memory.text),
        ["shared first", "shared second"]
    );
    assert.equal(objectStyle.results.length, 2);
});

test("MemWalMock matches production token-budget behavior", async () => {
    const mock = MemWalMock.create({
        initialMemories: [
            { text: "a".repeat(40) },
            { text: "a".repeat(40) },
        ],
    });

    assert.equal(mock.countTokens("a".repeat(8)), 2);

    const unbudgeted = await mock.recall({ query: "a", limit: 2 });
    assert.equal(unbudgeted.results.length, 2);
    assert.equal("meta" in unbudgeted, false);

    const budgeted = await mock.recall({
        query: "a",
        limit: 2,
        maxTokens: 10,
    });
    assert.equal(budgeted.results.length, 1);
    assert.equal(budgeted.total, 1);
    assert.deepEqual(budgeted.meta, {
        tokenEstimate: 10,
        truncated: true,
    });
});

test("MemWalMock tokenization does not depend on the host locale", async () => {
    const originalLocaleLowerCase = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = () => {
        throw new Error("locale-dependent lowercase must not be used");
    };
    try {
        const mock = MemWalMock.create();
        await mock.rememberAndWait("I LIKE COFFEE");
        const recalled = await mock.recall({ query: "i like coffee" });

        assert.equal(recalled.results[0].distance, 0);
        assert.equal((await mock.embed("I LIKE COFFEE")).vector.length, 16);
    } finally {
        String.prototype.toLocaleLowerCase = originalLocaleLowerCase;
    }
});

test("MemWalMock supports job, bulk, analyze, forget, and clear flows", async () => {
    const mock = MemWalMock.create();
    const accepted = await mock.remember("single fact");
    assert.deepEqual(await mock.getRememberStatus(accepted.job_id), {
        job_id: "mock-job-000001",
        status: "done",
        owner: "mock-owner",
        namespace: "default",
        blob_id: "mock-blob-000001",
    });

    const bulk = await mock.rememberBulkAndWait([
        { text: "bulk one", namespace: "one" },
        { text: "bulk two", namespace: "two" },
    ]);
    assert.equal(bulk.succeeded, 2);
    assert.equal(bulk.failed, 0);

    const analyzed = await mock.analyzeAndWait(
        "durable analyzed fact",
        "analysis"
    );
    assert.equal(analyzed.facts[0].text, "durable analyzed fact");
    assert.equal(analyzed.results[0].namespace, "analysis");

    assert.equal(mock.forget("mock-blob-000001"), true);
    assert.equal(mock.forget("missing"), false);
    assert.equal(mock.clear("one"), 1);
    assert.equal(
        (await mock.recall({ query: "bulk", namespace: "one" })).total,
        0
    );
});

test("MemWalMock provides deterministic embeddings and seed data", async () => {
    const first = MemWalMock.create({
        initialMemories: [
            { text: "seed memory", namespace: "seed", blobId: "seed-blob" },
        ],
    });
    const second = MemWalMock.create();

    assert.deepEqual(
        await first.embed("same text"),
        await second.embed("same text")
    );
    const recalled = await first.recall({ query: "seed", namespace: "seed" });
    assert.equal(recalled.results[0].blob_id, "seed-blob");
    assert.equal((await first.health()).status, "ok");
    assert.equal((await first.compatibility()).featureFlags.offlineMock, true);
});

test("MemWalMock.listNamespaces aggregates seeded memories by namespace", async () => {
    const mock = MemWalMock.create({
        initialMemories: [
            { text: "one", namespace: "work" },
            { text: "two", namespace: "work" },
            { text: "three", namespace: "home" },
        ],
    });

    const page = await mock.listNamespaces();
    const byName = Object.fromEntries(page.namespaces.map((n) => [n.name, n]));

    assert.deepEqual(Object.keys(byName).sort(), ["home", "work"]);
    assert.equal(byName.work.memory_count, 2);
    assert.equal(byName.home.memory_count, 1);
    assert.equal(page.has_more, false);
});

test("MemWalMock.listNamespaces reports has_more when limit truncates the page", async () => {
    const mock = MemWalMock.create({
        initialMemories: [
            { text: "a", namespace: "alpha" },
            { text: "b", namespace: "bravo" },
            { text: "c", namespace: "charlie" },
        ],
    });

    const page = await mock.listNamespaces({ limit: 2 });

    assert.equal(page.namespaces.length, 2);
    assert.equal(page.has_more, true, "has_more is the pagination signal, not page length");
    assert.ok(page.next_cursor, "a truncated page must hand back a cursor");
});

test("MemWalMock.listNamespaces reports the relayer's current snapshot_version", async () => {
    // Verified against relayer.dev.memwal.ai on 2026-08-28: the live read API
    // returns snapshot_version 2. A double that disagrees with the server on a
    // wire-format version is a trap for anyone testing version-gated logic.
    const page = await MemWalMock.create().listNamespaces();
    assert.equal(page.snapshot_version, 2);
});

test("MemWalMock namespace cursors use the relayer wire format and reset after a walk", async () => {
    const mock = MemWalMock.create({ initialMemories: [
        { text: "a", namespace: "旅行" },
        { text: "b", namespace: "work" },
    ] });
    const first = await mock.listNamespaces({ limit: 1 });
    assert.match(first.next_cursor, /^[A-Za-z0-9_-]+$/);
    const cursor = JSON.parse(Buffer.from(first.next_cursor, "base64url").toString("utf8"));
    assert.equal(cursor.namespace, "旅行");
    assert.equal(cursor.updated_at, first.namespaces[0].updated_at);
    assert.ok(cursor.snapshot_at);
    const last = await mock.listNamespaces({ cursor: first.next_cursor });
    assert.deepEqual(last.namespaces.map(ns => ns.name), ["work"]);
    assert.equal(last.has_more, false);
    assert.equal(JSON.parse(Buffer.from(last.next_cursor, "base64url")).snapshot_at, null);
    const empty = await mock.listNamespaces({ cursor: last.next_cursor });
    assert.deepEqual(empty.namespaces, []);
    assert.equal(empty.next_cursor, last.next_cursor);
});

test("MemWalMock namespace walks defer new writes until the next poll", async () => {
    const mock = MemWalMock.create({ initialMemories: [
        { text: "a", namespace: "alpha" },
        { text: "b", namespace: "bravo" },
    ] });
    const first = await mock.listNamespaces({ limit: 1 });
    await mock.remember("new", "bravo");
    const last = await mock.listNamespaces({ cursor: first.next_cursor });
    assert.deepEqual(last.namespaces, []);
    assert.equal(last.has_more, false);
    const poll = await mock.listNamespaces({ cursor: last.next_cursor });
    assert.deepEqual(poll.namespaces.map(ns => ns.name), ["bravo"]);
    assert.equal(poll.namespaces[0].memory_count, 2);
});

test("MemWalMock.listNamespaces rejects a non-positive limit instead of paging forever", async () => {
    const mock = MemWalMock.create();
    await mock.remember("User likes coffee", "ns-a");
    await mock.remember("User likes tea", "ns-b");
    await mock.remember("User likes water", "ns-c");

    await assert.rejects(
        () => mock.listNamespaces({ limit: 0 }),
        /limit must be positive/,
    );
    await assert.rejects(
        () => mock.listNamespaces({ limit: -1 }),
        /limit must be positive/,
    );
    await assert.rejects(
        () => mock.listNamespaces({ limit: 1.5 }),
        /limit must be positive/,
    );

    const page = await mock.listNamespaces({ limit: 1 });
    assert.equal(page.namespaces.length, 1);
    assert.equal(page.has_more, true);
    assert.ok(page.next_cursor);
});

test("MemWalMock.rememberBulkAsync rejects an empty or non-array batch", async () => {
    const mock = MemWalMock.create();
    const message = "rememberBulkAsync: items must be a non-empty array";
    await assert.rejects(() => mock.rememberBulkAsync([]), {
        name: "Error",
        message,
    });
    await assert.rejects(() => mock.rememberBulkAsync("nope"), {
        name: "Error",
        message,
    });
});

test("MemWalMock collapses a repeated idempotency key onto the original job", async () => {
    const mock = MemWalMock.create();
    const first = await mock.rememberAsync("dedupe me", "ns", {
        idempotencyKey: "key-123",
    });
    const second = await mock.rememberAsync("dedupe me", "ns", {
        idempotencyKey: "key-123",
    });
    assert.equal(first.job_id, second.job_id);
    assert.equal(
        (await mock.recall({ query: "dedupe", namespace: "ns", limit: 10 })).total,
        1,
    );

    await assert.rejects(
        () => mock.rememberAsync("other text", "ns", { idempotencyKey: "key-123" }),
        /different content/,
    );
    await assert.rejects(
        () => mock.rememberAsync("dedupe me", "ns", { idempotencyKey: "" }),
        /cannot be empty/,
    );
    await assert.rejects(
        () =>
            mock.rememberAsync("dedupe me", "ns", {
                idempotencyKey: "k".repeat(256),
            }),
        /maximum length/,
    );

    const written = await mock.rememberAndWait("again", "ns", {
        idempotencyKey: "key-again",
    });
    assert.equal(mock.forget(written.blob_id), true);
    const rewritten = await mock.rememberAndWait("again", "ns", {
        idempotencyKey: "key-again",
    });
    assert.notEqual(rewritten.job_id, written.job_id);
    const after = await mock.recall({
        query: "again",
        namespace: "ns",
        maxDistance: 0.5,
    });
    assert.equal(after.total, 1);
    assert.equal(after.results[0].blob_id, rewritten.blob_id);
});

test("MemWalMock.recall sort recent returns the newest match and keeps relevance ties", async () => {
    const mock = MemWalMock.create();
    await mock.rememberAndWait("project release version one");
    await mock.rememberAndWait("project release version two");

    const recent = await mock.recall({
        query: "project release",
        sort: "recent",
        limit: 1,
    });
    assert.equal(recent.results[0].text, "project release version two");

    const relevance = await mock.recall({
        query: "project release",
        sort: "relevance",
        limit: 1,
    });
    assert.equal(relevance.results[0].text, "project release version one");

    const omitted = await mock.recall({ query: "project release", limit: 1 });
    assert.equal(omitted.results[0].text, "project release version one");
});

test("MemWalMock.recall sort recent stays inside the semantic candidate window", async () => {
    const mock = MemWalMock.create();
    for (let i = 1; i <= 6; i++) {
        await mock.rememberAndWait(`alpha fact ${i}`);
    }
    // Equal overlap, so semantic order is insertion order. limit 1 → window 5.
    const recent = await mock.recall({ query: "alpha", sort: "recent", limit: 1 });
    assert.equal(recent.results[0].text, "alpha fact 5");
});

test("MemWalMock.recall sort recent filters namespace and still applies the token budget", async () => {
    const mock = MemWalMock.create();
    await mock.rememberAndWait("alpha one", "kept");
    await mock.rememberAndWait("alpha two", "kept");
    await mock.rememberAndWait("alpha elsewhere", "other");

    const result = await mock.recall({
        query: "alpha",
        namespace: "kept",
        sort: "recent",
        limit: 2,
        maxTokens: 3,
    });

    assert.deepEqual(
        result.results.map((memory) => memory.text),
        ["alpha two"],
    );
    assert.equal(result.meta.truncated, true);
});

test("MemWalMock.recall uses a positional namespace when the options object omits one", async () => {
    const mock = MemWalMock.create({ namespace: "default" });
    await mock.rememberAndWait("profile fact", "profile");
    await mock.rememberAndWait("default fact", "default");

    const positional = await mock.recall("fact", { limit: 5 }, "profile");
    assert.deepEqual(
        positional.results.map((memory) => memory.text),
        ["profile fact"],
    );

    const explicit = await mock.recall(
        "fact",
        { limit: 5, namespace: "default" },
        "profile",
    );
    assert.deepEqual(
        explicit.results.map((memory) => memory.text),
        ["default fact"],
    );
});
