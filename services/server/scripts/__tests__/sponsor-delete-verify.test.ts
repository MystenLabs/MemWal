import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

import { verifyDeleteOnlyKind } from "../sidecar/sponsor-delete-verify.js";

// The deleteOnly sponsor path (WALM-264) skips both sponsor rate-limit axes,
// so this verifier is the only thing standing between the exemption and a
// free bypass for sponsoring arbitrary transactions. These tests build real
// TransactionKind bytes offline (objectRef inputs need no chain resolution)
// and assert that ONLY pure delete-blob cleanups pass.

const WALRUS_PKG = "0x" + "ab".repeat(32);
const OTHER_PKG = "0x" + "cd".repeat(32);
const SENDER = "0x" + "12".repeat(32);
const OTHER_ADDR = "0x" + "34".repeat(32);

// base58 of 32 zero bytes — any well-formed digest works for an objectRef.
const DIGEST = "11111111111111111111111111111111";

let nextObjectId = 0;
function objectRef(tx: Transaction) {
    nextObjectId++;
    return tx.objectRef({
        objectId: "0x" + nextObjectId.toString(16).padStart(64, "0"),
        version: "1",
        digest: DIGEST,
    });
}

function deleteBlobCall(tx: Transaction, pkg: string = WALRUS_PKG) {
    return tx.moveCall({
        package: pkg,
        module: "system",
        function: "delete_blob",
        arguments: [objectRef(tx), objectRef(tx)],
    });
}

async function kindBase64(build: (tx: Transaction) => void): Promise<string> {
    const tx = new Transaction();
    build(tx);
    return toBase64(await tx.build({ onlyTransactionKind: true }));
}

test("accepts deletes plus transfer of reclaimed storage to the sender", async () => {
    const kind = await kindBase64((tx) => {
        const a = deleteBlobCall(tx);
        const b = deleteBlobCall(tx);
        tx.transferObjects([a, b], SENDER);
    });
    assert.equal(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG), null);
});

test("accepts deletes without a transfer", async () => {
    const kind = await kindBase64((tx) => {
        deleteBlobCall(tx);
    });
    assert.equal(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG), null);
});

test("normalizes addresses before comparing", async () => {
    const kind = await kindBase64((tx) => {
        const a = deleteBlobCall(tx);
        tx.transferObjects([a], SENDER);
    });
    assert.equal(
        verifyDeleteOnlyKind(kind, SENDER.toUpperCase().replace("0X", "0x"), WALRUS_PKG.toUpperCase().replace("0X", "0x")),
        null,
    );
});

test("rejects a move call against a foreign package", async () => {
    const kind = await kindBase64((tx) => {
        deleteBlobCall(tx, OTHER_PKG);
    });
    assert.match(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG) ?? "", /delete_blob calls are allowed/);
});

test("rejects a different function in the walrus system module", async () => {
    const kind = await kindBase64((tx) => {
        tx.moveCall({
            package: WALRUS_PKG,
            module: "system",
            function: "extend_blob",
            arguments: [objectRef(tx), objectRef(tx)],
        });
    });
    assert.match(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG) ?? "", /delete_blob calls are allowed/);
});

test("rejects a transfer to anyone but the sender", async () => {
    const kind = await kindBase64((tx) => {
        const a = deleteBlobCall(tx);
        tx.transferObjects([a], OTHER_ADDR);
    });
    assert.match(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG) ?? "", /recipient must be the sender/);
});

test("rejects transferring pre-existing owned objects (inputs, not results)", async () => {
    const kind = await kindBase64((tx) => {
        deleteBlobCall(tx);
        tx.transferObjects([objectRef(tx)], SENDER);
    });
    assert.match(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG) ?? "", /results of delete_blob/);
});

test("rejects other command kinds", async () => {
    const kind = await kindBase64((tx) => {
        deleteBlobCall(tx);
        tx.splitCoins(tx.gas, [1n]);
    });
    assert.match(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG) ?? "", /SplitCoins is not allowed/);
});

test("rejects a transaction with no delete_blob calls", async () => {
    const kind = await kindBase64((tx) => {
        tx.transferObjects([objectRef(tx)], SENDER);
    });
    assert.notEqual(verifyDeleteOnlyKind(kind, SENDER, WALRUS_PKG), null);
});

test("rejects bytes that are not a TransactionKind", () => {
    assert.match(
        verifyDeleteOnlyKind(toBase64(new Uint8Array([1, 2, 3])), SENDER, WALRUS_PKG) ?? "",
        /not a valid TransactionKind/,
    );
});
