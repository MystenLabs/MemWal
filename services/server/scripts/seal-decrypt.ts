/**
 * Standalone SEAL decrypt utility
 *
 * Decrypts SEAL-encrypted data using an admin wallet. Production requests use
 * the long-lived sidecar; this utility is for diagnostics and manual recovery.
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
 *     --package-id <0x-immutable-package-id> \
 *     [--policy-package-id <0x-current-package-id>] \
 *     --registry-id <0x-registry-object-id>
 *
 * Output (JSON to stdout):
 *   { "decryptedData": "<base64>" }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { SealClient, SessionKey, EncryptedObject } from "@mysten/seal";
import { getSealServerConfigsFromEnv, getSealThresholdFromEnv } from "./seal-config.js";
import { sealIdentityPackageError } from "./sidecar/seal-ptb.js";

// Network config from env vars
const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";
const SEAL_SERVER_CONFIGS = getSealServerConfigsFromEnv();
const SEAL_THRESHOLD = getSealThresholdFromEnv(SEAL_SERVER_CONFIGS);

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs(): {
    data: Uint8Array;
    privateKey: string;
    packageId: string;
    policyPackageId: string;
    registryId: string;
    accountId: string;
} {
    const args = process.argv.slice(2);
    let data: string | undefined;
    let privateKey: string | undefined;
    let packageId: string | undefined;
    let policyPackageId: string | undefined;
    let registryId: string | undefined;
    let accountId: string | undefined;

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
            case "--policy-package-id":
                policyPackageId = args[++i];
                break;
            case "--registry-id":
                registryId = args[++i];
                break;
            case "--account-id":
                accountId = args[++i];
                break;
            case "--help":
                console.log(
                    "usage: seal-decrypt.ts --data <base64> --private-key <suiprivkey1...> --package-id <0x...> [--policy-package-id <0x...>] --registry-id <0x...> --account-id <0x...>"
                );
                process.exit(0);
        }
    }

    if (!data || !privateKey || !packageId || !registryId || !accountId) {
        console.error(
            "error: required args: --data <base64> --private-key <suiprivkey1...> --package-id <0x...> --registry-id <0x...> --account-id <0x...>"
        );
        process.exit(1);
    }

    return {
        data: Buffer.from(data, "base64"),
        privateKey,
        packageId,
        policyPackageId: policyPackageId ?? packageId,
        registryId,
        accountId,
    };
}

// ============================================================
// Main
// ============================================================

async function main() {
    const { data, privateKey, packageId, policyPackageId, registryId, accountId } = parseArgs();

    // Step 1: Parse and bind the immutable namespace before touching wallet or network resources.
    const encryptedData = new Uint8Array(data);
    const parsed = EncryptedObject.parse(encryptedData);
    const packageError = sealIdentityPackageError(packageId, [parsed.packageId], packageId);
    if (packageError) {
        throw new Error(packageError);
    }
    const fullId = parsed.id;

    const grpcUrl = process.env.SUI_GRPC_URL?.trim() || `https://fullnode.${SUI_NETWORK}.sui.io`;
    const suiClient = new SuiGrpcClient({
        baseUrl: grpcUrl,
        network: SUI_NETWORK,
    });

    // Decode admin wallet (TEE server wallet = deployer)
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    const keypair = Ed25519Keypair.fromSecretKey(secretKey);
    const adminAddress = keypair.getPublicKey().toSuiAddress();

    // Initialize SEAL client
    const sealClient = new SealClient({
        suiClient: suiClient as any,
        serverConfigs: SEAL_SERVER_CONFIGS,
        verifyKeyServers: true,
    });

    // Convert hex ID to byte array for the PTB
    const idBytes = Array.from(Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16))));

    // Step 2: Create session key (auto-signs with signer)
    // Reduced from 30 to 5 minutes to match sidecar policy.
    const sessionKey = await SessionKey.create({
        address: adminAddress,
        packageId,
        ttlMin: 5,
        signer: keypair,
        suiClient: suiClient as any,
    });

    // Step 3: Build seal_approve PTB with REAL ID
    // seal_approve(id: vector<u8>, registry: &AccountRegistry, account: &MemWalAccount, ctx: &TxContext)
    const tx = new Transaction();
    tx.moveCall({
        target: `${policyPackageId}::account::seal_approve`,
        arguments: [
            tx.pure("vector<u8>", idBytes), // real ID from encrypted object
            tx.object(registryId), // AccountRegistry shared object
            tx.object(accountId), // MemWalAccount shared object
        ],
    });
    const txBytes = await tx.build({
        client: suiClient as any,
        onlyTransactionKind: true,
    });

    // Step 4: Fetch keys from key servers (policy check happens here)
    await sealClient.fetchKeys({
        ids: [fullId],
        txBytes,
        sessionKey,
        threshold: SEAL_THRESHOLD,
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
