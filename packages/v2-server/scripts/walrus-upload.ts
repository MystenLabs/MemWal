/**
 * Walrus Upload Relay Script (multi-step flow)
 *
 * Uses the writeBlobFlow stateful API (encode → register → upload → certify)
 * instead of writeBlob (one-shot). This avoids signer mismatch errors
 * when existing Blob objects belong to a different wallet.
 *
 * Called by the Rust v2-server as a subprocess.
 *
 * Usage:
 *   npx tsx walrus-upload.ts \
 *     --data <base64-encoded-blob> \
 *     --private-key <suiprivkey1...> \
 *     --owner <0x-sui-address> \
 *     [--epochs <number>]
 *
 * Output (JSON to stdout):
 *   { "blobId": "...", "objectId": "..." }
 *
 * Errors are written to stderr with non-zero exit code.
 */

import { WalrusClient } from "@mysten/walrus";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// ============================================================
// Parse CLI arguments
// ============================================================

function parseArgs(): {
    data: Buffer;
    privateKey: string;
    owner: string;
    epochs: number;
} {
    const args = process.argv.slice(2);
    let data: string | undefined;
    let privateKey: string | undefined;
    let owner: string | undefined;
    let epochs = 5;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--data":
                data = args[++i];
                break;
            case "--private-key":
                privateKey = args[++i];
                break;
            case "--owner":
                owner = args[++i];
                break;
            case "--epochs":
                epochs = parseInt(args[++i], 10);
                break;
            case "--help":
                console.log(
                    "usage: walrus-upload.ts --data <base64> --private-key <suiprivkey1...> --owner <0x...> [--epochs N]"
                );
                process.exit(0);
        }
    }

    if (!data || !privateKey || !owner) {
        console.error(
            "error: required args: --data <base64> --private-key <suiprivkey1...> --owner <0x...>"
        );
        process.exit(1);
    }

    return {
        data: Buffer.from(data, "base64"),
        privateKey,
        owner,
        epochs,
    };
}

// ============================================================
// Main
// ============================================================

async function main() {
    const { data, privateKey, owner, epochs } = parseArgs();

    // Decode Sui private key (bech32 → keypair)
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    const signer = Ed25519Keypair.fromSecretKey(secretKey);

    // Create Sui JSON-RPC client
    const suiClient = new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl("testnet"),
        network: "testnet",
    });

    // Create WalrusClient with upload relay
    const walrusClient = new WalrusClient({
        network: "testnet",
        suiClient: suiClient as any,
        uploadRelay: {
            host: "https://upload-relay.testnet.walrus.space",
            sendTip: { max: 10_000_000 },
        },
    });

    // writeBlobFlow is a stateful object — each step stores results internally
    const flow = walrusClient.writeBlobFlow({
        blob: new Uint8Array(data),
    });

    // Step 1: Encode (Red Stuff encoding, stores internally)
    await flow.encode();

    // Step 2: Register blob on Sui → returns a Transaction
    // Use signer address as owner so sender = signer (avoids mismatch).
    // MemWal only needs the blobId to download/decrypt — blob ownership
    // on Walrus doesn't affect the SEAL encryption/decryption flow.
    const signerAddress = signer.toSuiAddress();
    const registerTx = flow.register({
        epochs,
        owner: signerAddress,
        deletable: true,
    });

    // Sign and execute the register transaction
    const registerResult = await suiClient.signAndExecuteTransaction({
        signer,
        transaction: registerTx,
    });

    // Step 3: Upload encoded data to relay
    await flow.upload({ digest: registerResult.digest });

    // Step 4: Certify blob on Sui → returns a Transaction
    const certifyTx = flow.certify();

    // Sign and execute the certify transaction
    await suiClient.signAndExecuteTransaction({
        signer,
        transaction: certifyTx,
    });

    // Get blob info from the flow
    const blob = await flow.getBlob();

    console.log(JSON.stringify({
        blobId: blob.blobId,
        objectId: (blob.blobObject as any)?.id ?? null,
    }));
}

main().catch((err) => {
    console.error(`walrus-upload error: ${err.message || err}`);
    process.exit(1);
});
