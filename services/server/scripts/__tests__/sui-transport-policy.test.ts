import assert from "node:assert/strict";
import test from "node:test";

import { parseSuiNetwork, validateSuiTransportPolicy } from "../sidecar/sui-transport-policy.js";

test("network parsing normalizes canonical variants and rejects unknown values", () => {
    assert.equal(parseSuiNetwork(" TESTNET "), "testnet");
    assert.throws(() => parseSuiNetwork("test-net"), /unsupported SUI_NETWORK/);
});

test("testnet requires gRPC", () => {
    assert.throws(
        () => validateSuiTransportPolicy({ network: "testnet", grpcUrl: "", txClientOverride: "" }),
        /SUI_GRPC_URL is required/,
    );
});

test("testnet rejects the JSON-RPC transaction override", () => {
    assert.throws(
        () => validateSuiTransportPolicy({
            network: "testnet",
            grpcUrl: "https://grpc.testnet.example",
            txClientOverride: "jsonrpc",
        }),
        /localnet-only/,
    );
});

test("localnet retains its explicit JSON-RPC exception", () => {
    assert.doesNotThrow(() => validateSuiTransportPolicy({
        network: "localnet",
        grpcUrl: "http://127.0.0.1:9000",
        txClientOverride: "jsonrpc",
    }));
});
