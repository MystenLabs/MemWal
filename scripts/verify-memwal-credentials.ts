#!/usr/bin/env tsx

import { delegateKeyToPublicKey } from "../packages/sdk/src/utils.ts";

const HEX_32_BYTES = /^(0x)?[0-9a-fA-F]{64}$/;
const ACCOUNT_ID = /^0x[0-9a-fA-F]{64}$/;

function normalizeHex(value: string): string {
    return value.trim().replace(/^0x/i, "").toLowerCase();
}

async function main() {
    const privateKey = process.env.MEMWAL_PRIVATE_KEY ?? "";
    const accountId = process.env.MEMWAL_ACCOUNT_ID ?? "";
    const expectedPublicKey = process.env.MEMWAL_DELEGATE_PUBLIC_KEY ?? "";
    const serverUrl = process.env.MEMWAL_SERVER_URL ?? "";

    if (!privateKey) {
        throw new Error("MEMWAL_PRIVATE_KEY is required");
    }
    if (!HEX_32_BYTES.test(privateKey)) {
        throw new Error("MEMWAL_PRIVATE_KEY must be a 64-character Ed25519 private key hex string");
    }
    if (accountId && !ACCOUNT_ID.test(accountId)) {
        throw new Error("MEMWAL_ACCOUNT_ID must be a 0x-prefixed 32-byte Sui object ID");
    }

    const derivedPublicKey = Buffer.from(
        await delegateKeyToPublicKey(normalizeHex(privateKey)),
    ).toString("hex");

    if (expectedPublicKey) {
        const expected = normalizeHex(expectedPublicKey);
        if (!HEX_32_BYTES.test(expectedPublicKey) || derivedPublicKey !== expected) {
            throw new Error(
                "MEMWAL_PRIVATE_KEY does not derive MEMWAL_DELEGATE_PUBLIC_KEY. " +
                "You may have pasted a public key or a key from another account.",
            );
        }
    }

    console.log("MemWal credentials look parseable.");
    console.log(`Derived delegate public key: ${derivedPublicKey}`);
    if (accountId) console.log(`Account ID: ${accountId}`);
    if (serverUrl) console.log(`Relayer URL: ${serverUrl}`);
    if (!expectedPublicKey) {
        console.log("Set MEMWAL_DELEGATE_PUBLIC_KEY to make this script fail on public/private key mismatch.");
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
