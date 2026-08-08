import assert from "node:assert/strict";
import test from "node:test";
import { EncryptedObject } from "@mysten/seal";

import { MemWalManual } from "../dist/manual.js";

const ACCOUNT_ID = `0x${"aa".repeat(32)}`;
const PACKAGE_ID = `0x${"33".repeat(32)}`;
const OWNER = `0x${"11".repeat(32)}`;
const DELEGATE_SIGNER = `0x${"22".repeat(32)}`;
const COUNTER_LE_7 = "0700000000000000";

function ciphertext(packageId) {
    return EncryptedObject.serialize({
        version: 0,
        packageId,
        id: "aabb",
        services: [[ACCOUNT_ID, 1]],
        threshold: 1,
        encryptedShares: {
            BonehFranklinBLS12381: {
                nonce: new Uint8Array(96),
                encryptedShares: [new Uint8Array(32)],
                encryptedRandomness: new Uint8Array(32),
            },
        },
        ciphertext: { Plain: {} },
    }).toBytes();
}

function manualWithAccountResponse(response) {
    const encryptCalls = [];
    const objectRequests = [];
    const manual = MemWalManual.create({
        key: new Uint8Array(32).fill(1),
        walletSigner: {
            address: DELEGATE_SIGNER,
            signAndExecuteTransaction: async () => ({ digest: "0xtx" }),
            signPersonalMessage: async () => ({ signature: "sig" }),
        },
        suiClient: {
            getObject: async (request) => {
                objectRequests.push(request);
                return response;
            },
        },
        embeddingApiKey: "test",
        packageId: PACKAGE_ID,
        accountId: ACCOUNT_ID,
        registryId: "0xregistry",
        sealServerConfigs: [{ objectId: "0xserver", weight: 1 }],
    });
    manual._sealClient = {
        encrypt: async (input) => {
            encryptCalls.push(input);
            return { encryptedObject: new Uint8Array([1]) };
        },
    };
    return { manual, encryptCalls, objectRequests };
}

async function encryptId(response) {
    const state = manualWithAccountResponse(response);
    await state.manual.sealEncrypt(new Uint8Array([9]), "agent-state");
    assert.equal(state.objectRequests[0].objectId, ACCOUNT_ID);
    return state.encryptCalls[0].id;
}

test("delegate signer encrypts under the gRPC account owner identity", async () => {
    const id = await encryptId({
        object: {
            type: `${PACKAGE_ID}::account::MemWalAccount`,
            json: { owner: OWNER, active: true, access_counter_version: "7" },
        },
    });

    assert.equal(id, `${Buffer.from("agent-state").toString("hex")}${OWNER.slice(2)}${COUNTER_LE_7}`);
    assert.ok(!id.endsWith(`${DELEGATE_SIGNER.slice(2)}${COUNTER_LE_7}`));
});

test("delegate signer encrypts under the legacy-client account owner identity", async () => {
    const id = await encryptId({
        data: {
            type: `${PACKAGE_ID}::account::MemWalAccount`,
            content: {
                fields: { owner: OWNER, active: true, access_counter_version: 7 },
            },
        },
    });

    assert.ok(id.endsWith(`${OWNER.slice(2)}${COUNTER_LE_7}`));
});

test("missing account owner never falls back to the delegate signer", async () => {
    const { manual, encryptCalls } = manualWithAccountResponse({
        object: {
            type: `${PACKAGE_ID}::account::MemWalAccount`,
            json: { active: true, access_counter_version: "7" },
        },
    });

    await assert.rejects(manual.sealEncrypt(new Uint8Array([9]), "agent-state"), /has no owner field/);
    assert.equal(encryptCalls.length, 0);
});

test("foreign account objects fail before encryption", async () => {
    const { manual, encryptCalls } = manualWithAccountResponse({
        object: {
            type: "0x44::account::MemWalAccount",
            json: { owner: OWNER, active: true, access_counter_version: "7" },
        },
    });

    await assert.rejects(manual.sealEncrypt(new Uint8Array([9]), "agent-state"), /is not a .*MemWalAccount/);
    assert.equal(encryptCalls.length, 0);
});

test("inactive accounts fail before encryption", async () => {
    const { manual, encryptCalls } = manualWithAccountResponse({
        object: {
            type: `${PACKAGE_ID}::account::MemWalAccount`,
            json: { owner: OWNER, active: false, access_counter_version: "7" },
        },
    });

    await assert.rejects(manual.sealEncrypt(new Uint8Array([9]), "agent-state"), /is not active/);
    assert.equal(encryptCalls.length, 0);
});

test("manual recall rejects a foreign ciphertext package before fetching keys", async () => {
    const { manual } = manualWithAccountResponse({});
    let fetchCalls = 0;
    manual.embed = async () => [0];
    manual.signedRequest = async () => ({
        results: [{ blob_id: "foreign", distance: 0 }],
        total: 1,
    });
    manual.walrusDownload = async () => ciphertext(`0x${"44".repeat(32)}`);
    manual._sealClient = {
        fetchKeys: async () => {
            fetchCalls += 1;
        },
        decrypt: async () => new Uint8Array(),
    };

    await assert.rejects(
        manual.recallManual("query"),
        /ciphertext foreign packageId does not match the configured immutable packageId/
    );
    assert.equal(fetchCalls, 0);
});
