import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { addDelegateKey, createAccount } from "../dist/account.js";
import { MemWalManual } from "../dist/manual.js";
import {
    createJsonRpcSuiClient,
    jsonRpcUrlForNetwork,
    resolveJsonRpcSuiClientConstructor,
    setCreateJsonRpcSuiClient,
} from "../dist/sui-jsonrpc-client.js";

const ACCOUNT_ID = `0x${"a".repeat(64)}`;

function createdAccountResult(digest) {
    return {
        effects: { status: { status: "success" } },
        objectChanges: [
            {
                type: "created",
                objectType: "0x1::account::MemWalAccount",
                objectId: ACCOUNT_ID,
            },
        ],
        digest,
    };
}

function fakeJsonRpcClient(digest) {
    return {
        signAndExecuteTransaction: async () => ({ digest }),
        waitForTransaction: async () => createdAccountResult(digest),
    };
}

test.describe("JSON-RPC Sui client fallback", { concurrency: false }, () => {
test("installed @mysten/sui exposes SuiJsonRpcClient, not SuiClient", async () => {
    const client = await import("@mysten/sui/client");
    const jsonRpc = await import("@mysten/sui/jsonRpc");
    assert.equal(typeof client.SuiClient, "undefined");
    assert.equal(typeof jsonRpc.SuiJsonRpcClient, "function");
});

test("createJsonRpcSuiClient uses SuiJsonRpcClient on the installed peer", async () => {
    const client = await createJsonRpcSuiClient(jsonRpcUrlForNetwork("testnet"));
    assert.equal(client.constructor.name, "SuiJsonRpcClient");
});

test("resolveJsonRpcSuiClientConstructor prefers legacy SuiClient when present", async () => {
    class LegacySuiClient {
        constructor(opts) {
            this.url = opts.url;
        }
    }
    class JsonRpcClient {
        constructor() {
            throw new Error("jsonRpc should not load when SuiClient exists");
        }
    }

    const Client = await resolveJsonRpcSuiClientConstructor({
        loadClient: async () => ({ SuiClient: LegacySuiClient }),
        loadJsonRpc: async () => ({ SuiJsonRpcClient: JsonRpcClient }),
    });
    assert.equal(Client, LegacySuiClient);
});

test("resolveJsonRpcSuiClientConstructor falls back to SuiJsonRpcClient", async () => {
    class JsonRpcClient {
        constructor(opts) {
            this.url = opts.url;
        }
    }

    const Client = await resolveJsonRpcSuiClientConstructor({
        loadClient: async () => ({}),
        loadJsonRpc: async () => ({ SuiJsonRpcClient: JsonRpcClient }),
    });
    assert.equal(Client, JsonRpcClient);
});

test("createJsonRpcSuiClient throws without telling callers to pass suiClient", async () => {
    await assert.rejects(
        () => createJsonRpcSuiClient("https://fullnode.mainnet.sui.io:443", {
            loadClient: async () => ({}),
            loadJsonRpc: async () => ({}),
        }),
        (err) => {
            assert.match(err.message, /JSON-RPC Sui client not found in @mysten\/sui/);
            assert.equal(err.message.includes("pass suiClient"), false);
            return true;
        },
    );
});

test("account.ts, manual.ts, and memwal.ts share the jsonRpc fallback and drop the v2.6 pass-suiClient error", () => {
    const files = ["account.ts", "manual.ts", "memwal.ts"];
    for (const file of files) {
        const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
        assert.equal(
            src.includes("pass suiClient"),
            false,
            `${file} still tells callers to pass suiClient for v2.6+`,
        );
        assert.match(
            src,
            /from "\.\/sui-jsonrpc-client\.js"/,
            `${file} must use the shared JSON-RPC client helper`,
        );
    }
});

test.describe("default JSON-RPC construction when suiClient is omitted", { concurrency: false }, () => {
    test.afterEach(() => {
        setCreateJsonRpcSuiClient();
    });

    test("createAccount succeeds without a caller-supplied suiClient", async () => {
        const keypair = Ed25519Keypair.generate();
        let createdUrl;
        setCreateJsonRpcSuiClient(async (url) => {
            createdUrl = url;
            return fakeJsonRpcClient("omitted-client");
        });

        const result = await createAccount({
            packageId: "0x1",
            registryId: "0x2",
            suiPrivateKey: keypair.getSecretKey(),
            suiNetwork: "testnet",
        });

        assert.equal(createdUrl, "https://fullnode.testnet.sui.io:443");
        assert.deepEqual(result, {
            accountId: ACCOUNT_ID,
            owner: keypair.getPublicKey().toSuiAddress(),
            digest: "omitted-client",
        });
    });

    test("addDelegateKey succeeds without a caller-supplied suiClient", async () => {
        setCreateJsonRpcSuiClient(async () => fakeJsonRpcClient("omitted-delegate"));

        const result = await addDelegateKey({
            packageId: "0x1",
            registryId: "0x2",
            accountId: ACCOUNT_ID,
            publicKey: new Uint8Array(32).fill(7),
            label: "laptop",
            walletSigner: {
                address: "0x4",
                signAndExecuteTransaction: async () => ({ digest: "omitted-delegate" }),
                signPersonalMessage: async () => ({ signature: "unused" }),
            },
        });

        assert.equal(result.digest, "omitted-delegate");
        assert.equal(result.publicKey.length, 64);
    });

    test("createAccount does not construct a default client when suiClient is provided", async () => {
        const keypair = Ed25519Keypair.generate();
        setCreateJsonRpcSuiClient(async () => {
            throw new Error("default JSON-RPC client should not be constructed");
        });

        const result = await createAccount({
            packageId: "0x1",
            registryId: "0x2",
            suiPrivateKey: keypair.getSecretKey(),
            suiClient: fakeJsonRpcClient("explicit-client"),
        });

        assert.equal(result.digest, "explicit-client");
        assert.equal(result.accountId, ACCOUNT_ID);
    });

    test("MemWalManual default client construction uses SuiJsonRpcClient", async () => {
        const manual = MemWalManual.create({
            key: new Uint8Array(32).fill(1),
            suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
            embeddingApiKey: "test",
            packageId: "0x1",
            accountId: "0x2",
            registryId: "0x3",
            suiNetwork: "testnet",
        });

        const client = await manual.getSuiClient();
        assert.equal(client.constructor.name, "SuiJsonRpcClient");
    });

    test("MemWalManual uses the provided suiClient instead of constructing one", async () => {
        const provided = { marker: "provided" };
        setCreateJsonRpcSuiClient(async () => {
            throw new Error("default JSON-RPC client should not be constructed");
        });
        const manual = MemWalManual.create({
            key: new Uint8Array(32).fill(1),
            walletSigner: {
                address: "0x4",
                signAndExecuteTransaction: async () => ({ digest: "unused" }),
                signPersonalMessage: async () => ({ signature: "unused" }),
            },
            suiClient: provided,
            embeddingApiKey: "test",
            packageId: "0x1",
            accountId: "0x2",
            registryId: "0x3",
        });

        assert.equal(await manual.getSuiClient(), provided);
    });
});
});
