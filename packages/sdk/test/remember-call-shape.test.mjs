import assert from "node:assert/strict";
import test from "node:test";

import { MemWal, MemWalMock } from "../dist/index.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function client() {
    return MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

function versionBody() {
    return Response.json({
        apiVersion: "1.0.0",
        relayerVersion: "1.0.0",
        minSupportedSdk: { typescript: "0.0.4" },
    });
}

test("remember(text, options) keeps the client namespace", async () => {
    let posted;
    let seal = false;
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember" && init.method === "POST") {
            posted = JSON.parse(init.body);
            seal = init.headers["x-seal-session"] !== undefined;
            return Response.json({ job_id: "job-1", status: "pending" }, { status: 202 });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const memwal = client();
    memwal.buildSealSession = async () => "test-session";
    const accepted = await memwal.remember("hello", { idempotencyKey: "key-1" });

    assert.equal(accepted.job_id, "job-1");
    assert.equal(posted.namespace, "default");
    assert.equal(posted.idempotency_key, "key-1");
    assert.equal(posted.text, "hello");
    assert.equal(seal, true);
});

test("remember(text, namespace, options) still uses the string namespace", async () => {
    let posted;
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember" && init.method === "POST") {
            posted = JSON.parse(init.body);
            return Response.json({ job_id: "job-1", status: "pending" }, { status: 202 });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const memwal = client();
    memwal.buildSealSession = async () => "test-session";
    await memwal.remember("hello", "profile", { idempotencyKey: "key-1" });

    assert.equal(posted.namespace, "profile");
    assert.equal(posted.idempotency_key, "key-1");
});

test("rememberAndWait(text, options) does not send the options object as a namespace", async () => {
    let posted;
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember" && init.method === "POST") {
            posted = JSON.parse(init.body);
            return Response.json({ job_id: "job-1", status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/job-1") {
            return Response.json({
                job_id: "job-1",
                status: "done",
                blob_id: "blob-1",
                owner: "0xabc",
                namespace: "default",
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const memwal = client();
    memwal.buildSealSession = async () => "test-session";
    const stored = await memwal.rememberAndWait("hello", {
        timeoutMs: 5_000,
        idempotencyKey: "key-1",
    });

    assert.equal(posted.namespace, "default");
    assert.equal(posted.idempotency_key, "key-1");
    assert.equal(stored.blob_id, "blob-1");
    assert.equal(stored.namespace, "default");
});

test("rememberAndWait merges a third options bag and lets it win", async () => {
    let posted;
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember" && init.method === "POST") {
            posted = JSON.parse(init.body);
            return Response.json({ job_id: "job-1", status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/job-1") {
            return Response.json({
                job_id: "job-1",
                status: "pending",
                namespace: "default",
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const memwal = client();
    memwal.buildSealSession = async () => "test-session";
    const started = Date.now();
    await assert.rejects(
        memwal.rememberAndWait(
            "hello",
            { timeoutMs: 30, idempotencyKey: "from-slot" },
            { idempotencyKey: "stable" },
        ),
        /timed out after 30ms/,
    );

    assert.ok(Date.now() - started < 5_000);
    assert.equal(posted.namespace, "default");
    assert.equal(posted.idempotency_key, "stable");
});

test("an empty job id never requests GET /api/remember/", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
        fetches += 1;
        throw new Error("empty job id must not be requested");
    };

    const memwal = client();
    const status = await memwal.getRememberStatus("");
    assert.equal(status.status, "not_found");
    assert.equal(status.job_id, "");

    const started = Date.now();
    await assert.rejects(memwal.waitForRememberJob(""), (err) => {
        assert.equal(err.status, 404);
        assert.match(err.message, /remember job not found/);
        return true;
    });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(fetches, 0);
});

test("status reads do not build a SEAL session", async () => {
    const paths = [];
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        paths.push(path);
        assert.equal(init.headers?.["x-seal-session"], undefined);
        if (path === "/version") return versionBody();
        if (path === "/api/remember/job-1") {
            return Response.json({
                job_id: "job-1",
                status: "done",
                blob_id: "blob-1",
                owner: "0xabc",
                namespace: "profile",
            });
        }
        if (path === "/api/remember/bulk/status") {
            return Response.json({
                results: [{ job_id: "job-1", status: "done", blob_id: "blob-1", namespace: "profile" }],
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const memwal = client();
    memwal.buildSealSession = async () => {
        throw new Error("status must not build a seal session");
    };

    const one = await memwal.getRememberStatus("job-1");
    assert.equal(one.namespace, "profile");
    const bulk = await memwal.getRememberBulkStatus(["job-1"]);
    assert.equal(bulk.results[0].namespace, "profile");
    const waited = await memwal.waitForRememberJob("job-1", { pollIntervalMs: 1, timeoutMs: 5_000 });
    assert.equal(waited.namespace, "profile");
    assert.deepEqual(paths.filter((path) => path !== "/version"), [
        "/api/remember/job-1",
        "/api/remember/bulk/status",
        "/api/remember/job-1",
    ]);
});

test("duplicate job ids settle in every slot, using the server namespace", async () => {
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember/bulk/status") {
            const body = JSON.parse(init.body);
            assert.deepEqual(body.job_ids, ["job-a", "job-a"]);
            return Response.json({
                results: [
                    { job_id: "job-a", status: "done", blob_id: "blob-a", namespace: "profile" },
                ],
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const memwal = client();
    memwal.buildSealSession = async () => {
        throw new Error("status must not build a seal session");
    };
    const batch = await memwal.waitForRememberJobs(["job-a", "job-a"], [], {
        pollIntervalMs: 1,
        timeoutMs: 5_000,
    });

    assert.equal(batch.succeeded, 2);
    assert.equal(batch.failed, 0);
    assert.equal(batch.results[0].status, "done");
    assert.equal(batch.results[1].status, "done");
    assert.equal(batch.results[0].namespace, "profile");
    assert.equal(batch.results[1].namespace, "profile");
    assert.equal(batch.results[0].blob_id, "blob-a");
});

test("duplicate ids that stay pending time out in every slot", async () => {
    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember/bulk/status") {
            return Response.json({
                results: [{ job_id: "job-a", status: "pending", namespace: "profile" }],
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const batch = await client().waitForRememberJobs(["job-a", "job-a"], [], {
        pollIntervalMs: 1,
        timeoutMs: 30,
    });

    assert.equal(batch.succeeded, 0);
    assert.equal(batch.results[0].status, "timeout");
    assert.equal(batch.results[1].status, "timeout");
    assert.match(batch.results[0].error, /still pending after 30ms/);
    assert.match(batch.results[1].error, /still pending after 30ms/);
    assert.equal(batch.results[0].namespace, "profile");
    assert.equal(batch.results[1].namespace, "profile");
});

test("a caller namespace wins over the one on the status row", async () => {
    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") return versionBody();
        if (path === "/api/remember/bulk/status") {
            return Response.json({
                results: [
                    { job_id: "job-a", status: "done", blob_id: "blob-a", namespace: "profile" },
                    { job_id: "job-b", status: "not_found" },
                ],
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const memwal = client();
    const batch = await memwal.waitForRememberJobs(["job-a", "job-b"], ["caller"], {
        pollIntervalMs: 1,
        timeoutMs: 5_000,
    });

    assert.equal(batch.results[0].namespace, "caller");
    assert.equal(batch.results[0].status, "done");
    assert.equal(batch.results[1].status, "failed");
    assert.equal(batch.results[1].error, "job not found");
    assert.equal(batch.results[1].namespace, "default");
});

test("rememberBulkAsync rejects more than 20 items before signing", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
        fetches += 1;
        throw new Error("over-limit bulk must not be requested");
    };

    const items = Array.from({ length: 21 }, (_, i) => ({ text: `fact ${i}` }));
    await assert.rejects(client().rememberBulkAsync(items), /maximum of 20/);
    assert.equal(fetches, 0);
});

test("destroy() rejects key reads and requests without calling the relayer", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
        fetches += 1;
        throw new Error("a destroyed client must not call the relayer");
    };

    const cached = client();
    const before = await cached.getPublicKeyHex();
    assert.match(before, /^[0-9a-f]{64}$/);
    cached.destroy();
    await assert.rejects(cached.getPublicKeyHex(), /destroyed/);
    await assert.rejects(cached.remember("hi"), /destroyed/);

    const fresh = client();
    fresh.destroy();
    await assert.rejects(fresh.getPublicKeyHex(), /destroyed/);
    await assert.rejects(fresh.remember("hi"), /destroyed/);
    assert.equal(fetches, 0);
});

test("destroy() during an in-flight getPublicKeyHex rejects", async () => {
    const cached = client();
    const before = await cached.getPublicKeyHex();
    assert.match(before, /^[0-9a-f]{64}$/);
    assert.notEqual(before, "0".repeat(64));

    const pendingCached = cached.getPublicKeyHex();
    cached.destroy();
    await assert.rejects(pendingCached, /destroyed/);

    const fresh = client();
    const pendingFresh = fresh.getPublicKeyHex();
    fresh.destroy();
    await assert.rejects(pendingFresh, /destroyed/);
});

test("destroy() during an in-flight remember does not send the remember", async () => {
    let releaseVersion;
    const versionGate = new Promise((resolve) => {
        releaseVersion = resolve;
    });
    const requested = [];
    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        requested.push(path);
        if (path === "/version") {
            await versionGate;
            return versionBody();
        }
        throw new Error(`a wiped client still sent ${path}`);
    };

    const memwal = client();
    memwal.buildSealSession = async () => "test-session";
    const pending = memwal.remember("hi");
    await new Promise((resolve) => setImmediate(resolve));
    memwal.destroy();
    releaseVersion();

    await assert.rejects(pending, /destroyed/);
    assert.deepEqual(requested, ["/version"]);
});

test("MemWalMock.remember(text, options) stores under the client namespace", async () => {
    const mock = MemWalMock.create();
    const accepted = await mock.remember("hello", { idempotencyKey: "k" });
    const status = await mock.getRememberStatus(accepted.job_id);
    assert.equal(status.namespace, "default");
    assert.equal(typeof status.namespace, "string");

    const stored = await mock.rememberAndWait("hello again", { timeoutMs: 10, idempotencyKey: "k2" });
    assert.equal(stored.namespace, "default");

    const items = Array.from({ length: 21 }, (_, i) => ({ text: `fact ${i}` }));
    await assert.rejects(mock.rememberBulkAsync(items), /maximum of 20/);
});
