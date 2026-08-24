/**
 * `MemWal.create({ key })` must accept every form a delegate key is handed out
 * in, not just bare hex.
 *
 * The Python SDK already normalizes all of them (memwal/utils.py
 * `normalize_private_key`), and its docstring states the TypeScript SDK takes
 * both forms — it did not, so a `suiprivkey1...` key died inside `hexToBytes`
 * with "input contains non-hex characters" before any request went out. That
 * is what broke the JS SDK e2e job against the dev relayer: the shared
 * BENCH_DELEGATE_KEY secret is stored in bech32.
 *
 * Vectors below were produced by `encodeSuiPrivateKey` from `@mysten/sui`,
 * which is the canonical implementation both SDKs mirror.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { bytesToHex, decodeSuiPrivateKey, normalizePrivateKey } from "../dist/utils.js";

const SEED_HEX = "17dc3c1eecfcdc014c0eba65c1f87897abbbd214fa32d4018f48669b5d37c413";
const SEED_BECH32 = "suiprivkey1qqtac0q7an7dcq2vp6axts0c0zt6hw7jznar94qp3ayxdx6axlzpxcetm48";
// Same seed, scheme flag 1 (secp256k1) instead of 0 (Ed25519).
const SECP256K1_BECH32 = "suiprivkey1qytac0q7an7dcq2vp6axts0c0zt6hw7jznar94qp3ayxdx6axlzpxzx7yks";

const ACCOUNT_ID = `0x${"02".repeat(32)}`;

test("decodeSuiPrivateKey recovers the Ed25519 seed from a suiprivkey string", () => {
    assert.equal(bytesToHex(decodeSuiPrivateKey(SEED_BECH32)), SEED_HEX);
});

test("normalizePrivateKey accepts every form a delegate key is handed out in", () => {
    for (const form of [SEED_HEX, `0x${SEED_HEX}`, SEED_BECH32, `  ${SEED_BECH32}  `]) {
        assert.equal(normalizePrivateKey(form), SEED_HEX, `form: ${form}`);
    }
});

test("a bech32 key produces the same client identity as its hex form", async () => {
    const fromHex = MemWal.create({ key: SEED_HEX, accountId: ACCOUNT_ID });
    const fromBech32 = MemWal.create({ key: SEED_BECH32, accountId: ACCOUNT_ID });

    assert.equal(await fromBech32.getPublicKeyHex(), await fromHex.getPublicKeyHex());
});

test("decodeSuiPrivateKey rejects a non-Ed25519 scheme", () => {
    assert.throws(() => decodeSuiPrivateKey(SECP256K1_BECH32), /Ed25519/);
});

test("decodeSuiPrivateKey rejects a corrupted checksum", () => {
    const corrupted = `${SEED_BECH32.slice(0, -1)}${SEED_BECH32.at(-1) === "q" ? "p" : "q"}`;
    assert.throws(() => decodeSuiPrivateKey(corrupted), /checksum/);
});

test("an unparseable key still reports what was wrong with it", () => {
    assert.throws(() => MemWal.create({ key: "not-a-key", accountId: ACCOUNT_ID }), /hex/);
});

// Every entry point that takes a user-supplied delegate key must accept the
// same forms. `delegateKeyToPublicKey` in particular is what a user calls to
// register their key on-chain, so rejecting bech32 there strands them before
// they ever construct a client.

test("MemWalManual signs with the same delegate key whether given hex or bech32", async () => {
    const { MemWalManual } = await import("../dist/manual.js");

    // The delegate key's whole job is the x-public-key header the relayer
    // authenticates on, so assert on that rather than on internal state.
    async function publicKeyHeaderFor(key) {
        const manual = MemWalManual.create({
            key,
            walletSigner: {
                address: "0x2",
                signAndExecuteTransaction: async () => ({ digest: "0xtx" }),
                signPersonalMessage: async () => ({ signature: "sig" }),
            },
            suiClient: {},
            embeddingApiKey: "test",
            packageId: `0x${"33".repeat(32)}`,
            accountId: ACCOUNT_ID,
            registryId: "0xregistry",
            serverUrl: "https://relayer.example",
            sealServerConfigs: [{ objectId: "0xserver", weight: 1 }],
        });

        let captured = null;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            // signedRequest probes GET /version for compatibility first.
            if (String(url).endsWith("/version")) {
                return Response.json({
                    apiVersion: "1.0.0",
                    relayerVersion: "1.0.0",
                    minSupportedSdk: { typescript: "0.0.4" },
                });
            }
            captured = new Headers(init.headers).get("x-public-key");
            return Response.json({ restored: 0, skipped: 0, total: 0, namespace: "demo", owner: "0x1" });
        };
        try {
            await manual.restore("demo");
        } finally {
            globalThis.fetch = originalFetch;
        }
        return captured;
    }

    const fromHex = await publicKeyHeaderFor(SEED_HEX);
    assert.ok(fromHex, "expected the request to carry an x-public-key header");
    assert.equal(await publicKeyHeaderFor(SEED_BECH32), fromHex);
});

test("delegateKeyToPublicKey accepts a bech32 delegate key", async () => {
    const { delegateKeyToPublicKey } = await import("../dist/utils.js");

    assert.deepEqual(
        await delegateKeyToPublicKey(SEED_BECH32),
        await delegateKeyToPublicKey(SEED_HEX),
    );
});

test("delegateKeyToSuiAddress accepts a bech32 delegate key", async () => {
    const { delegateKeyToSuiAddress } = await import("../dist/utils.js");

    assert.equal(
        await delegateKeyToSuiAddress(SEED_BECH32),
        await delegateKeyToSuiAddress(SEED_HEX),
    );
});
