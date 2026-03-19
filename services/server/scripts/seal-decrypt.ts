/**
 * SEAL Decrypt Sidecar Script
 *
 * Decrypts SEAL-encrypted data using admin wallet (TEE server).
 * Called by the Rust server as a subprocess.
 *
 * Flow:
 * 1. Parse EncryptedObject to extract the key ID
 * 2. Create SessionKey signed by admin wallet
 * 3. Build seal_approve PTB with the real ID
 * 4. Fetch keys from key servers (policy check happens here)
 * 5. Decrypt locally using fetched keys
 *
 * Usage:
 *   npx tsx seal-decrypt.ts \
 *     --data <base64-encrypted> \
 *     --private-key <suiprivkey1...> \
 *     --package-id <0x-package-id> \
 *     --registry-id <0x-registry-object-id>
 *
 * Output (JSON to stdout):
 *   { "decryptedData": "<base64>" }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { SealClient, SessionKey, EncryptedObject } from "@mysten/seal";

// Network config from env vars
const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";
const SEAL_KEY_SERVERS = (process.env.SEAL_KEY_SERVERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs(): {
    data: Uint8Array;
    privateKey: string;
    packageId: string;
    registryId: string;
} {
    const args = process.argv.slice(2);
    let data: string | undefined;
    let privateKey: string | undefined;
    let packageId: string | undefined;
    let registryId: string | undefined;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--data":
                data = args[++i];
                break;
            case "--private-key":
                privateKey = args[++i];
                break;
            case "--package-id":
                packageId = args[++i];
                break;
            case "--registry-id":
                registryId = args[++i];
                break;
            case "--help":
                console.log(
                    "usage: seal-decrypt.ts --data <base64> --private-key <suiprivkey1...> --package-id <0x...> --registry-id <0x...>"
                );
                process.exit(0);
        }
    }

    if (!data || !privateKey || !packageId || !registryId) {
        console.error(
            "error: required args: --data <base64> --private-key <suiprivkey1...> --package-id <0x...> --registry-id <0x...>"
        );
        process.exit(1);
    }

    return {
        data: Buffer.from(data, "base64"),
        privateKey,
        packageId,
        registryId,
    };
}

// ============================================================
// Main
// ============================================================

async function main() {
    const { data, privateKey, packageId, registryId } = parseArgs();

    const suiClient = new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl(SUI_NETWORK),
        network: SUI_NETWORK,
    });

    // Decode admin wallet (TEE server wallet = deployer)
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    const adminAddress = keypair.getPublicKey().toSuiAddress();

    // Initialize SEAL client
    const sealClient = new SealClient({
        suiClient: suiClient as any,
        serverConfigs: SEAL_KEY_SERVERS.map((id) => ({
            objectId: id,
            weight: 1,
        })),
        verifyKeyServers: false,
    });

    // Step 1: Parse the encrypted object to get the real key ID
    const encryptedData = new Uint8Array(data);
    const parsed = EncryptedObject.parse(encryptedData);
    const fullId = parsed.id; // hex string of the owner's address

    // Convert hex ID to byte array for the PTB
    const idBytes = Array.from(
        Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
    );

    // Step 2: Create session key (auto-signs with signer)
    const sessionKey = await SessionKey.create({
        address: adminAddress,
        packageId,
        ttlMin: 30,
        signer: keypair,
        suiClient: suiClient as any,
    });

    // Step 3: Build seal_approve PTB with REAL ID
    // seal_approve(id: vector<u8>, registry: &AccountRegistry, ctx: &TxContext)
    const tx = new Transaction();
    tx.moveCall({
        target: `${packageId}::account::seal_approve`,
        arguments: [
            tx.pure("vector<u8>", idBytes),  // real ID from encrypted object
            tx.object(registryId),            // AccountRegistry shared object
        ],
    });
    const txBytes = await tx.build({ client: suiClient as any, onlyTransactionKind: true });

    // Step 4: Fetch keys from key servers (policy check happens here)
    await sealClient.fetchKeys({
        ids: [fullId],
        txBytes,
        sessionKey,
        threshold: 1,
    });

    // Step 5: Decrypt locally using fetched keys
    const decrypted = await sealClient.decrypt({
        data: encryptedData,
        sessionKey,
        txBytes,
    });

    // Output as JSON to stdout
    const decryptedBase64 = Buffer.from(decrypted).toString("base64");
    console.log(JSON.stringify({ decryptedData: decryptedBase64 }));
}

main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`seal-decrypt error: ${msg}`);
    if (err instanceof Error && err.stack) {
        console.error(err.stack);
    }
    process.exit(1);
});
