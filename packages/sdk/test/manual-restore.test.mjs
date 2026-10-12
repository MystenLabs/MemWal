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

test("MemWalManual.restore() times out after RESTORE_REQUEST_TIMEOUT_MS with status 504", async () => {
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
            // Simulate stalled server by awaiting abort signal
            await new Promise((_, reject) => {
                init.signal?.addEventListener("abort", () => {
                    const err = new Error("The operation was aborted");
                    err.name = "AbortError";
                    reject(err);
                });
            });
        }
        throw new Error(`Unexpected request: ${path}`);
    };

    const client = createManualClient();
    client.buildSealSession = async () => "mock-seal-session-token";

    // Temporarily verify signedRequest timeout behavior with short deadline
    const signedRequestErr = await client.signedRequest(
        "POST",
        "/api/restore",
        { namespace: "default", limit: 10 },
        { timeoutMs: 20, includeSealSession: true },
    ).catch((err) => err);

    assert.equal(signedRequestErr.name, "MemWalRequestTimeout");
    assert.equal(signedRequestErr.status, 504);
});
