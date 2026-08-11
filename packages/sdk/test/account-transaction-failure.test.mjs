import assert from "node:assert/strict";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { createAccount, removeDelegateKey } from "../dist/account.js";

const failure = {
    effects: {
        status: {
            status: "failure",
            error: "MoveAbort in account::remove_delegate_key",
        },
    },
};

function removeOpts(suiClient) {
    return {
        packageId: "0x1",
        registryId: "0x2",
        accountId: "0x3",
        publicKey: new Uint8Array(32),
        suiClient,
    };
}

test("wallet delegate removal rejects a finalized Move abort", async () => {
    const suiClient = { waitForTransaction: async () => failure };
    const walletSigner = {
        address: "0x4",
        signAndExecuteTransaction: async () => ({ digest: "wallet-digest" }),
        signPersonalMessage: async () => ({ signature: "unused" }),
    };

    await assert.rejects(
        removeDelegateKey({ ...removeOpts(suiClient), walletSigner }),
        /Transaction wallet-digest failed: MoveAbort in account::remove_delegate_key/
    );
});

test("keypair delegate removal rejects a finalized Move abort", async () => {
    const suiClient = {
        signAndExecuteTransaction: async () => ({ digest: "keypair-digest" }),
        waitForTransaction: async () => failure,
    };

    await assert.rejects(
        removeDelegateKey({
            ...removeOpts(suiClient),
            suiPrivateKey: Ed25519Keypair.generate().getSecretKey(),
        }),
        /Transaction keypair-digest failed: MoveAbort in account::remove_delegate_key/
    );
});

test("tagged gRPC success extracts the digest and created account", async () => {
    const keypair = Ed25519Keypair.generate();
    const accountId = `0x${"a".repeat(64)}`;
    const success = {
        $kind: "Transaction",
        Transaction: {
            digest: "grpc-digest",
            status: { success: true, error: null },
            effects: {
                changedObjects: [{ objectId: accountId, idOperation: "Created" }],
            },
            objectTypes: {
                [accountId]: "0x1::account::MemWalAccount",
            },
        },
    };
    let waitInput;
    const suiClient = {
        signAndExecuteTransaction: async () => success,
        waitForTransaction: async (input) => {
            waitInput = input;
            return success;
        },
    };

    const result = await createAccount({
        packageId: "0x1",
        registryId: "0x2",
        suiClient,
        suiPrivateKey: keypair.getSecretKey(),
    });

    assert.deepEqual(result, {
        accountId,
        owner: keypair.getPublicKey().toSuiAddress(),
        digest: "grpc-digest",
    });
    assert.equal(waitInput.digest, "grpc-digest");
    assert.deepEqual(waitInput.include, { effects: true, objectTypes: true });
});

test("tagged gRPC failure rejects a flat wallet submission result", async () => {
    const failure = {
        $kind: "FailedTransaction",
        FailedTransaction: {
            digest: "grpc-failure",
            status: {
                success: false,
                error: { kind: "MoveAbort", message: "account::remove_delegate_key" },
            },
        },
    };
    const suiClient = { waitForTransaction: async () => failure };
    const walletSigner = {
        address: "0x4",
        signAndExecuteTransaction: async () => ({ digest: "grpc-failure" }),
        signPersonalMessage: async () => ({ signature: "unused" }),
    };

    await assert.rejects(
        removeDelegateKey({ ...removeOpts(suiClient), walletSigner }),
        /Transaction grpc-failure failed:.*MoveAbort.*account::remove_delegate_key/
    );
});
