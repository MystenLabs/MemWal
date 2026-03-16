/**
 * SEAL Encrypt Sidecar Script
 *
 * Encrypts data using SEAL threshold encryption.
 * Called by the Rust server as a subprocess.
 *
 * Uses @mysten/seal SealClient.encrypt() with the user's address as key ID.
 *
 * Usage:
 *   npx tsx seal-encrypt.ts \
 *     --data <base64-encoded-plaintext> \
 *     --owner <0x-sui-address> \
 *     --package-id <0x-package-id>
 *
 * Output (JSON to stdout):
 *   { "encryptedData": "<base64>" }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { SealClient } from "@mysten/seal";

// SEAL testnet key server object IDs
const TESTNET_KEY_SERVERS = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
];

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs(): {
    data: Uint8Array;
    owner: string;
    packageId: string;
} {
    const args = process.argv.slice(2);
    let data: string | undefined;
    let owner: string | undefined;
    let packageId: string | undefined;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--data":
                data = args[++i];
                break;
            case "--owner":
                owner = args[++i];
                break;
            case "--package-id":
                packageId = args[++i];
                break;
            case "--help":
                console.log(
                    "usage: seal-encrypt.ts --data <base64> --owner <0x...> --package-id <0x...>"
                );
                process.exit(0);
        }
    }

    if (!data || !owner || !packageId) {
        console.error(
            "error: required args: --data <base64> --owner <0x...> --package-id <0x...>"
        );
        process.exit(1);
    }

    return {
        data: Buffer.from(data, "base64"),
        owner,
        packageId,
    };
}

// ============================================================
// Main
// ============================================================

async function main() {
    const { data, owner, packageId } = parseArgs();

    const suiClient = new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl("testnet"),
        network: "testnet",
    });

    const sealClient = new SealClient({
        suiClient: suiClient as any,
        serverConfigs: TESTNET_KEY_SERVERS.map((id) => ({
            objectId: id,
            weight: 1,
        })),
        verifyKeyServers: false,
    });

    // Encrypt with threshold 1 (need 1 of N key servers to decrypt)
    // The SEAL SDK uses packageId + id to derive the encryption key
    const result = await sealClient.encrypt({
        threshold: 1,
        packageId,
        id: owner,
        data: new Uint8Array(data),
    });

    // Output as JSON to stdout
    const encryptedBase64 = Buffer.from(result.encryptedObject).toString("base64");
    console.log(JSON.stringify({ encryptedData: encryptedBase64 }));
}

main().catch((err) => {
    console.error(`seal-encrypt error: ${err.message || err}`);
    process.exit(1);
});
