import assert from "node:assert/strict";
import test from "node:test";

import { MemWalManual } from "../dist/manual.js";
import { RESTORE_REQUEST_TIMEOUT_MS } from "../dist/utils.js";


const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

const ACCOUNT_ID = `0x${"aa".repeat(32)}`;
const PACKAGE_ID = `0x${"33".repeat(32)}`;
const REGISTRY_ID = `0x${"bb".repeat(32)}`;
const DELEGATE_SIGNER = `0x${"22".repeat(32)}`;

function createManualClient() {
    return MemWalManual.create({
        key: new Uint8Array(32).fill(1),
        walletSigner: {
            address: DELEGATE_SIGNER,
            signAndExecuteTransaction: async () => ({ digest: "0xtx" }),
            signPersonalMessage: async () => ({ signature: "test-sig" }),
        },
        embeddingApiKey: "test-key",
        packageId: PACKAGE_ID,
        accountId: ACCOUNT_ID,
        registryId: REGISTRY_ID,
        serverUrl: "https://relayer.example",
    });
}

test("MemWalManual.restore() attaches x-seal-session header and applies RESTORE_REQUEST_TIMEOUT_MS", async () => {
    let capturedHeaders = null;
    let hadAbortSignal = false;

    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "0.1.8",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/restore" && init.method === "POST") {
            capturedHeaders = init.headers;
            hadAbortSignal = Boolean(init.signal);
            return Response.json({
                restored: 2,
                skipped: 0,
                failed: 0,
                total: 2,
                namespace: "default",
                owner: "0x1",
                truncated: false,
            });
        }
        throw new Error(`Unexpected request: ${path}`);
    };

    const client = createManualClient();
    client.buildSealSession = async () => "mock-seal-session-token";

    const result = await client.restore("default", 10);

    assert.equal(result.restored, 2);
    assert.ok(capturedHeaders, "Headers must be captured");
    assert.equal(capturedHeaders["x-seal-session"], "mock-seal-session-token");
    assert.ok(hadAbortSignal, "Must pass an abort signal to bound the request");
});

test("restore() times out when the body stalls after headers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "0.1.8",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/restore") {
            started();
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: () => new Promise((_, reject) => {
                    const abort = () => {
                        const err = new Error("The operation was aborted");
                        err.name = "AbortError";
                        reject(err);
                    };
                    if (init.signal?.aborted) abort();
                    else init.signal?.addEventListener("abort", abort, { once: true });
                }),
            };
        }
        throw new Error(`Unexpected request: ${path}`);
    };

    const client = createManualClient();
    client.buildSealSession = async () => "mock-seal-session-token";
    let started = () => {};
    const bodyStalled = new Promise((resolve) => { started = resolve; });
    const pending = client.restore("default", 10).catch((err) => err);
    await bodyStalled;
    t.mock.timers.tick(RESTORE_REQUEST_TIMEOUT_MS);
    const err = await pending;
    assert.equal(err.name, "MemWalRequestTimeout");
    assert.equal(err.status, 504);
});
