import assert from "node:assert/strict";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import {
    namespaceSealKeyId,
    wrapNamespaceDek,
    generateAndWrapNamespaceDek,
    createNamespace,
    initializeKey,
    grantAccess,
    cancelUninitializedNamespace,
    permissionBits,
} from "../dist/namespace.js";

const GOLDEN_NS = "0xcafe";
const GOLDEN_V1 =
    "000000000000000000000000000000000000000000000000000000000000cafe0100000000000000";
const GOLDEN_V10000 =
    "000000000000000000000000000000000000000000000000000000000000cafe1027000000000000";
const GOLDEN_V0 =
    "000000000000000000000000000000000000000000000000000000000000cafe0000000000000000";

const SUI_CLOCK =
    "0x0000000000000000000000000000000000000000000000000000000000000006";

function toHex(bytes) {
    return Buffer.from(bytes).toString("hex");
}

function dummySigner() {
    return {
        address: "0x4",
        signAndExecuteTransaction: async () => {
            throw new Error("should not send");
        },
        signPersonalMessage: async () => ({ signature: "unused" }),
    };
}

function namespaceOpts(overrides = {}) {
    return {
        packageId: "0xpkg",
        namespaceRegistryId: "0xnsreg",
        accountRegistryId: "0xaccreg",
        accountId: "0xacc",
        namespaceId: "0xns",
        suiClient: {
            waitForTransaction: async () => {
                throw new Error("should not wait");
            },
        },
        walletSigner: dummySigner(),
        ...overrides,
    };
}

test("namespaceSealKeyId is 40 bytes", () => {
    const id = namespaceSealKeyId(GOLDEN_NS, 0);
    assert.equal(id.length, 40);
    assert.equal(namespaceSealKeyId(GOLDEN_NS, 1n).length, 40);
});

test("namespaceSealKeyId matches Move golden vectors (v0, v1, v10000)", () => {
    assert.equal(toHex(namespaceSealKeyId(GOLDEN_NS, 0)), GOLDEN_V0);
    assert.equal(toHex(namespaceSealKeyId(GOLDEN_NS, 1)), GOLDEN_V1);
    assert.equal(toHex(namespaceSealKeyId("0xcafe", 1n)), GOLDEN_V1);
    assert.equal(toHex(namespaceSealKeyId(GOLDEN_NS, 10000)), GOLDEN_V10000);
    assert.equal(
        toHex(namespaceSealKeyId(`0x${"0".repeat(60)}cafe`, 1)),
        GOLDEN_V1,
    );
});

test("namespaceSealKeyId little-endian key_version tail", () => {
    const v0 = namespaceSealKeyId(GOLDEN_NS, 0);
    const v1 = namespaceSealKeyId(GOLDEN_NS, 1);
    assert.deepEqual(v0.slice(32), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
    assert.deepEqual(v1.slice(32), new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]));
    assert.deepEqual(
        namespaceSealKeyId(GOLDEN_NS, 10000).slice(32),
        new Uint8Array([0x10, 0x27, 0, 0, 0, 0, 0, 0]),
    );
});

test("permissionBits WRITE implies READ; SHARE without READ is rejected", () => {
    assert.equal(permissionBits(true, false, false), 1);
    assert.equal(permissionBits(true, true, false), 1 | 2);
    assert.equal(permissionBits(false, true, false), 1 | 2);
    assert.equal(permissionBits(true, false, true), 1 | 4);
    assert.equal(permissionBits(true, true, true), 1 | 2 | 4);
    assert.throws(
        () => permissionBits(false, false, false),
        /at least one/,
    );
    assert.throws(
        () => permissionBits(false, false, true),
        /SHARE requires READ/,
    );
});

test("wrapNamespaceDek rejects dek that is not 32 bytes", async () => {
    const sealClient = {
        encrypt: async () => ({ encryptedObject: new Uint8Array([1]) }),
    };
    await assert.rejects(
        wrapNamespaceDek({
            packageId: "0x1",
            namespaceId: GOLDEN_NS,
            keyVersion: 0,
            dek: new Uint8Array(16),
            threshold: 1,
            sealClient,
        }),
        /32 bytes/,
    );
    await assert.rejects(
        wrapNamespaceDek({
            packageId: "0x1",
            namespaceId: GOLDEN_NS,
            keyVersion: 0,
            dek: new Uint8Array(0),
            threshold: 1,
            sealClient,
        }),
        /32 bytes/,
    );
});

test("wrapNamespaceDek encrypts under hex(namespaceSealKeyId) and omits dek", async () => {
    let captured;
    const dek = new Uint8Array(32).fill(7);
    const wrapped = new Uint8Array([9, 8, 7]);
    const result = await wrapNamespaceDek({
        packageId: "0xabc",
        namespaceId: GOLDEN_NS,
        keyVersion: 1,
        dek,
        threshold: 2,
        sealClient: {
            encrypt: async (input) => {
                captured = input;
                return { encryptedObject: wrapped };
            },
        },
    });

    assert.equal(captured.id, GOLDEN_V1);
    assert.equal(captured.threshold, 2);
    assert.equal(captured.packageId, "0xabc");
    assert.equal(captured.data, dek);
    assert.deepEqual(result.wrappedDek, wrapped);
    assert.equal(Object.hasOwn(result, "dek"), false);
});

test("generateAndWrapNamespaceDek returns a 32-byte dek and wrapped bytes", async () => {
    const result = await generateAndWrapNamespaceDek({
        packageId: "0x1",
        namespaceId: GOLDEN_NS,
        keyVersion: 0,
        threshold: 1,
        sealClient: {
            encrypt: async ({ data }) => {
                assert.equal(data.length, 32);
                return { encryptedObject: new Uint8Array([1, 2]) };
            },
        },
    });
    assert.equal(result.dek.length, 32);
    assert.deepEqual(result.wrappedDek, new Uint8Array([1, 2]));
});

test("createNamespace rejects empty and too-long labels before send", async () => {
    await assert.rejects(
        createNamespace({ ...namespaceOpts(), label: "" }),
        /label must be 1\.\.64 bytes/,
    );
    await assert.rejects(
        createNamespace({ ...namespaceOpts(), label: "a".repeat(65) }),
        /label must be 1\.\.64 bytes, got 65/,
    );
});

test("createNamespace PTB argument order and extracts MemoryNamespace id", async () => {
    const namespaceId = `0x${"b".repeat(64)}`;
    const success = {
        $kind: "Transaction",
        Transaction: {
            digest: "ns-digest",
            status: { success: true, error: null },
            effects: {
                changedObjects: [{ objectId: namespaceId, idOperation: "Created" }],
            },
            objectTypes: {
                [namespaceId]: "0xpkg::namespace::MemoryNamespace",
            },
        },
    };
    const recordedInputs = [];
    const originalAddInput = TransactionDataBuilder.prototype.addInput;
    TransactionDataBuilder.prototype.addInput = function addInputSpy(type, arg) {
        recordedInputs.push(arg);
        return originalAddInput.call(this, type, arg);
    };
    const moveCalls = [];
    const original = Transaction.prototype.moveCall;
    Transaction.prototype.moveCall = function moveCallSpy(input) {
        const result = original.call(this, input);
        moveCalls.push(input);
        return result;
    };

    try {
        const result = await createNamespace({
            packageId: "0xpkg",
            namespaceRegistryId: "0xnsreg",
            accountRegistryId: "0xaccreg",
            accountId: "0xacc",
            label: "notes",
            suiClient: {
                signAndExecuteTransaction: async () => success,
                waitForTransaction: async () => success,
            },
            suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
        });

        assert.deepEqual(result, { namespaceId, digest: "ns-digest" });
        assert.equal(moveCalls.length, 1);
        assert.equal(
            moveCalls[0].target,
            "0xpkg::namespace::create_namespace",
        );
        assert.equal(moveCalls[0].arguments.length, 5);

        const resolved = moveCalls[0].arguments.map(
            (arg) => recordedInputs[arg.Input],
        );
        assert.deepEqual(
            resolved.map((input) => input.UnresolvedObject?.objectId ?? null),
            [
                normalizeSuiAddress("0xnsreg"),
                normalizeSuiAddress("0xaccreg"),
                normalizeSuiAddress("0xacc"),
                null,
                normalizeSuiAddress(SUI_CLOCK),
            ],
        );
        assert.equal(resolved[3].$kind, "Pure");
        assert.ok(resolved[3].Pure?.bytes);
    } finally {
        Transaction.prototype.moveCall = original;
        TransactionDataBuilder.prototype.addInput = originalAddInput;
    }
});

test("grantAccess rejects all-false and SHARE without READ before send", async () => {
    await assert.rejects(
        grantAccess({
            ...namespaceOpts(),
            principal: "0x5",
            canRead: false,
            canWrite: false,
            canShare: false,
        }),
        /at least one/,
    );
    await assert.rejects(
        grantAccess({
            ...namespaceOpts(),
            principal: "0x5",
            canRead: false,
            canWrite: false,
            canShare: true,
        }),
        /SHARE requires READ/,
    );
});

test("initializeKey PTB includes wrapped_dek as vector<u8>", async () => {
    const success = {
        $kind: "Transaction",
        Transaction: {
            digest: "init-digest",
            status: { success: true, error: null },
        },
    };
    const moveCalls = [];
    const original = Transaction.prototype.moveCall;
    Transaction.prototype.moveCall = function moveCallSpy(input) {
        moveCalls.push(input);
        return original.call(this, input);
    };

    try {
        const wrappedDek = new Uint8Array([1, 2, 3, 4]);
        const result = await initializeKey({
            packageId: "0xpkg",
            namespaceRegistryId: "0xnsreg",
            accountRegistryId: "0xaccreg",
            accountId: "0xacc",
            namespaceId: "0xns",
            wrappedDek,
            suiClient: {
                signAndExecuteTransaction: async () => success,
                waitForTransaction: async () => success,
            },
            suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
        });
        assert.equal(result.digest, "init-digest");
        assert.equal(moveCalls[0].target, "0xpkg::namespace::initialize_key");
        assert.equal(moveCalls[0].arguments.length, 6);
    } finally {
        Transaction.prototype.moveCall = original;
    }
});

test("cancelUninitializedNamespace calls the public fun via moveCall", async () => {
    const success = {
        $kind: "Transaction",
        Transaction: {
            digest: "cancel-digest",
            status: { success: true, error: null },
        },
    };
    const moveCalls = [];
    const original = Transaction.prototype.moveCall;
    Transaction.prototype.moveCall = function moveCallSpy(input) {
        moveCalls.push(input);
        return original.call(this, input);
    };

    try {
        const result = await cancelUninitializedNamespace({
            packageId: "0xpkg",
            namespaceRegistryId: "0xnsreg",
            accountRegistryId: "0xaccreg",
            accountId: "0xacc",
            namespaceId: "0xns",
            suiClient: {
                signAndExecuteTransaction: async () => success,
                waitForTransaction: async () => success,
            },
            suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
        });
        assert.equal(result.digest, "cancel-digest");
        assert.equal(
            moveCalls[0].target,
            "0xpkg::namespace::cancel_uninitialized_namespace",
        );
        assert.equal(moveCalls[0].arguments.length, 5);
    } finally {
        Transaction.prototype.moveCall = original;
    }
});
