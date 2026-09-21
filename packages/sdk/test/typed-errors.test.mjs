import assert from "node:assert/strict";
import test from "node:test";

import {
    MemWal,
    MemWalCompatibilityError,
    RateLimitError,
    RememberJobError,
    RememberJobFailedError,
    RememberJobNotFoundError,
    RememberJobTimeoutError,
} from "../dist/index.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function versionAndConfigFetch(route) {
    return async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/config") {
            return Response.json({ packageId: "0x1", network: "testnet" });
        }
        return route(path, init);
    };
}

function client() {
    const memwal = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    memwal.buildSealSession = async () => "test-session";
    return memwal;
}

test("waitForRememberJob throws RememberJobFailedError on a failed job", async () => {
    globalThis.fetch = versionAndConfigFetch(async (path) => {
        if (path === "/api/remember/job-1") {
            return Response.json({
                job_id: "job-1",
                status: "failed",
                error: "sidecar exploded",
            });
        }
        throw new Error(`unexpected request ${path}`);
    });

    await assert.rejects(
        () => client().waitForRememberJob("job-1", { pollIntervalMs: 0, timeoutMs: 1_000 }),
        (err) => {
            assert.equal(err instanceof RememberJobFailedError, true);
            assert.equal(err instanceof RememberJobError, true);
            assert.equal(err instanceof RememberJobTimeoutError, false);
            assert.equal(err.name, "RememberJobFailedError");
            assert.equal(err.status, 500);
            assert.equal(err.jobId, "job-1");
            assert.equal(err.message, "remember job failed: sidecar exploded");
            return true;
        },
    );
});

test("waitForRememberJob throws RememberJobNotFoundError when the job is missing", async () => {
    globalThis.fetch = versionAndConfigFetch(async (path) => {
        if (path === "/api/remember/missing") {
            return Response.json({ job_id: "missing", status: "not_found" });
        }
        throw new Error(`unexpected request ${path}`);
    });

    await assert.rejects(
        () => client().waitForRememberJob("missing", { pollIntervalMs: 0, timeoutMs: 1_000 }),
        (err) => {
            assert.equal(err instanceof RememberJobNotFoundError, true);
            assert.equal(err instanceof RememberJobError, true);
            assert.equal(err.status, 404);
            assert.equal(err.jobId, "missing");
            return true;
        },
    );
});

test("remember throws RateLimitError on HTTP 429", async () => {
    globalThis.fetch = versionAndConfigFetch(async (path) => {
        if (path === "/api/remember") {
            return new Response("slow down", {
                status: 429,
                headers: { "retry-after": "7" },
            });
        }
        throw new Error(`unexpected request ${path}`);
    });

    await assert.rejects(
        () => client().remember("hi"),
        (err) => {
            assert.equal(err instanceof RateLimitError, true);
            assert.equal(err instanceof RememberJobError, false);
            assert.equal(err.name, "RateLimitError");
            assert.equal(err.status, 429);
            assert.equal(err.retryAfterSeconds, 7);
            return true;
        },
    );
});

test("signed-request HTTP 426 stays MemWalCompatibilityError", async () => {
    globalThis.fetch = versionAndConfigFetch(async (path) => {
        if (path === "/api/remember") {
            return new Response("upgrade required", { status: 426 });
        }
        throw new Error(`unexpected request ${path}`);
    });

    await assert.rejects(
        () => client().remember("hi"),
        (err) => {
            assert.equal(err instanceof MemWalCompatibilityError, true);
            assert.equal(err instanceof RateLimitError, false);
            assert.equal(err.name, "MemWalCompatibilityError");
            assert.match(err.message, /HTTP 426/);
            return true;
        },
    );
});
