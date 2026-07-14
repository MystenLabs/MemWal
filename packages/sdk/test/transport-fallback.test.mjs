import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

function client() {
    return MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

function configResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("legacy testnet config retains JSON-RPC as a gRPC fallback", async () => {
    globalThis.fetch = async () => configResponse({
        packageId: "0x1",
        network: "testnet",
        suiRpcUrl: "https://rpc.example",
    });

    const config = await client().fetchServerConfig();

    assert.equal(config.suiTransport, "grpc");
    assert.equal(config.suiGrpcUrl, undefined);
    assert.equal(config.suiRpcUrl, "https://rpc.example");
});

test("preferred gRPC config retains its advertised JSON-RPC fallback", async () => {
    globalThis.fetch = async () => configResponse({
        packageId: "0x1",
        network: "mainnet",
        suiTransport: "grpc",
        suiGrpcUrl: "https://grpc.example",
        suiRpcUrl: "https://rpc.example",
    });

    const config = await client().fetchServerConfig();

    assert.equal(config.suiTransport, "grpc");
    assert.equal(config.suiGrpcUrl, "https://grpc.example");
    assert.equal(config.suiRpcUrl, "https://rpc.example");
});
