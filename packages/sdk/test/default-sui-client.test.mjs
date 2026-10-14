import assert from "node:assert/strict";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { isSuiGrpcClient } from "@mysten/sui/grpc";

import { addDelegateKey, createAccount } from "../dist/account.js";
import { MemWalManual } from "../dist/manual.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** Record every outbound request and fail it, so no test reaches the network. */
function recordRequests() {
    const urls = [];
    globalThis.fetch = async (input) => {
        urls.push(typeof input === "string" ? input : input.url);
        throw new Error("network disabled in test");
    };
    return urls;
}

function accountOpts(extra = {}) {
    return {
        packageId: "0x1",
        registryId: "0x2",
        suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
        ...extra,
    };
}

function manualClient(extra = {}) {
    return MemWalManual.create({
        key: new Uint8Array(32).fill(1),
        suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
        embeddingApiKey: "unused",
        packageId: "0x1",
        accountId: "0x3",
        registryId: "0x2",
        serverUrl: "https://relayer.example",
        ...extra,
    });
}

test("createAccount without suiClient talks gRPC to the mainnet fullnode", async () => {
    const urls = recordRequests();

    await assert.rejects(createAccount(accountOpts()), (err) => {
        assert.doesNotMatch(String(err?.message), /SuiClient not found/);
        return true;
    });

    assert.ok(urls.length > 0, "expected the default client to issue a request");
    for (const url of urls) {
        assert.match(url, /^https:\/\/fullnode\.mainnet\.sui\.io(:443)?\/sui\.rpc\.v2\./);
    }
});

test("addDelegateKey without suiClient honors suiNetwork", async () => {
    const urls = recordRequests();

    await assert.rejects(
        addDelegateKey(accountOpts({
            accountId: "0x3",
            publicKey: new Uint8Array(32),
            label: "test",
            suiNetwork: "testnet",
        })),
        (err) => {
            assert.doesNotMatch(String(err?.message), /SuiClient not found/);
            return true;
        },
    );

    assert.ok(urls.length > 0, "expected the default client to issue a request");
    for (const url of urls) {
        assert.match(url, /^https:\/\/fullnode\.testnet\.sui\.io(:443)?\/sui\.rpc\.v2\./);
    }
});

test("an explicit suiClient still wins over the default", async () => {
    const urls = recordRequests();
    const calls = [];
    const suiClient = {
        signAndExecuteTransaction: async () => {
            calls.push("signAndExecuteTransaction");
            return { digest: "explicit-digest" };
        },
        waitForTransaction: async () => {
            calls.push("waitForTransaction");
            return { effects: { status: { status: "success" } } };
        },
    };

    const result = await createAccount(accountOpts({ suiClient }));

    assert.equal(result.digest, "explicit-digest");
    assert.deepEqual(calls, ["signAndExecuteTransaction", "waitForTransaction"]);
    assert.deepEqual(urls, []);
});

test("MemWalManual builds a gRPC client when suiClient is omitted", async () => {
    const mainnet = await manualClient().getSuiClient();
    assert.equal(isSuiGrpcClient(mainnet), true);
    assert.equal(mainnet.network, "mainnet");

    const testnet = await manualClient({ suiNetwork: "testnet" }).getSuiClient();
    assert.equal(isSuiGrpcClient(testnet), true);
    assert.equal(testnet.network, "testnet");
});

test("MemWalManual keeps an explicit suiClient", async () => {
    const suiClient = { marker: "explicit" };
    assert.equal(await manualClient({ suiClient }).getSuiClient(), suiClient);
});
