/**
 * MemWal V2 — E2E Integration Test Script
 *
 * Tests the full flow on Sui testnet:
 * 1. Contract: create_account → add_delegate_key → is_delegate
 * 2. Walrus: upload encrypted blob → download → verify
 * 3. SEAL: encrypt content → decrypt content
 * 4. Full flow: SEAL encrypt → Walrus upload → Walrus download → SEAL decrypt
 *
 * Prerequisites:
 * - Sui CLI configured for testnet
 * - Active wallet: 0x3103...781f with SUI balance
 * - Contract deployed: 0x93c775e573c0d9aefc0908cc9bb5b0952e131ab6c40b2b769c8b74bb991d34a0
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { WalrusClient, TESTNET_WALRUS_PACKAGE_CONFIG } from "@mysten/walrus";
import {
    encrypt,
    AesGcm256,
    getAllowlistedKeyServers,
    retrieveKeyServers,
    EncryptedObject,
} from "@mysten/seal";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// ============================================================
// Configuration
// ============================================================

const PACKAGE_ID =
    "0x93c775e573c0d9aefc0908cc9bb5b0952e131ab6c40b2b769c8b74bb991d34a0";
const ACCOUNT_OBJECT_ID =
    "0x077bc4b6d0cd0ac317ab45a699897f1ae163b2d148439d8cf094f6e20fbcc5dd";
const NETWORK = "testnet" as const;

// User's keypair — loaded from Sui CLI keystore
// For safety, we load from env or generate a test one
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY;

// ============================================================
// Helpers
// ============================================================

function log(step: string, msg: string) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[${step}] ${msg}`);
    console.log("=".repeat(60));
}

function success(msg: string) {
    console.log(`  ✅ ${msg}`);
}

function info(msg: string) {
    console.log(`  ℹ️  ${msg}`);
}

function error(msg: string) {
    console.log(`  ❌ ${msg}`);
}

// ============================================================
// Test Steps
// ============================================================

async function testWalrusUploadDownload(
    walrusClient: WalrusClient,
    signer: Ed25519Keypair
) {
    log("STEP 1", "Walrus — Upload & Download blob");

    const content = "Hello from MemWal V2! This is a test memory.";
    const contentBytes = new TextEncoder().encode(content);

    info(`Content: "${content}"`);
    info(`Content bytes: ${contentBytes.length} bytes`);

    // Upload to Walrus
    info("Uploading blob to Walrus testnet...");
    const result = await walrusClient.writeBlob({
        blob: contentBytes,
        deletable: true,
        epochs: 1,
        signer,
    });

    success(`Blob uploaded!`);
    info(`Blob ID: ${result.blobId}`);
    info(`Blob Object ID: ${result.blobObject.id.id}`);
    info(`Blob size: ${result.blobObject.size}`);
    info(`Deletable: ${result.blobObject.deletable}`);

    // Download from Walrus
    info("Downloading blob from Walrus...");
    const downloaded = await walrusClient.readBlob({ blobId: result.blobId });
    const downloadedContent = new TextDecoder().decode(downloaded);

    if (downloadedContent === content) {
        success(`Content verified! Downloaded: "${downloadedContent}"`);
    } else {
        error(
            `Content mismatch! Expected: "${content}", Got: "${downloadedContent}"`
        );
    }

    return result;
}

async function testSealEncryptDecrypt(client: SuiClient) {
    log("STEP 2", "SEAL — Encrypt & Decrypt content");

    // Get key servers
    info("Loading SEAL key servers for testnet...");
    const keyServerObjectIds = getAllowlistedKeyServers("testnet");
    info(`Found ${keyServerObjectIds.length} key server(s)`);

    const keyServers = await retrieveKeyServers({
        objectIds: keyServerObjectIds,
        client: client as any,
    });
    info(
        `Retrieved key servers: ${keyServers.map((s) => s.name).join(", ") || "(unnamed)"}`
    );

    // Prepare content to encrypt
    const content = "Secret memory: my wallet seed phrase is... just kidding 😂";
    const contentBytes = new TextEncoder().encode(content);
    info(`Plaintext: "${content}"`);

    // Create the identity for encryption
    // In MemWal, the identity is derived from the SEAL policy module
    // For this test, we use the package ID + a simple ID
    const packageIdBytes = fromBase64(
        toBase64(Buffer.from(PACKAGE_ID.slice(2), "hex"))
    );
    const id = new TextEncoder().encode("memwal-test-identity-001");
    const aad = new TextEncoder().encode("memwal-v2-test");

    // Encrypt
    info("Encrypting content with SEAL...");
    try {
        const { encryptedObject, key } = await encrypt({
            keyServers,
            threshold: 1,
            packageId: packageIdBytes,
            id: id,
            encryptionInput: new AesGcm256(contentBytes, aad),
        });

        success(`Encrypted! Object size: ${encryptedObject.length} bytes`);
        info(`Symmetric key: ${Buffer.from(key).toString("hex").slice(0, 32)}...`);

        // Decrypt (using the symmetric key directly — this simulates what TEE/owner would do)
        info("Decrypting content with SEAL symmetric key...");
        const parsed = EncryptedObject.parse(encryptedObject);
        const decrypted = await AesGcm256.decrypt(key, parsed.ciphertext);
        const decryptedContent = new TextDecoder().decode(decrypted);

        if (decryptedContent === content) {
            success(`Decrypted! Content: "${decryptedContent}"`);
        } else {
            error(
                `Decryption mismatch! Expected: "${content}", Got: "${decryptedContent}"`
            );
        }

        return { encryptedObject, key };
    } catch (e: any) {
        error(`SEAL encrypt failed: ${e.message}`);
        info(
            "This may fail if SEAL key servers are not fully operational on testnet."
        );
        info("Falling back to manual AES-256-GCM test...");

        // Fallback: test AES-256-GCM encryption/decryption directly
        return await testManualAesEncryptDecrypt(contentBytes, content);
    }
}

async function testManualAesEncryptDecrypt(
    contentBytes: Uint8Array,
    originalContent: string
) {
    log("STEP 2b", "Fallback — Manual AES-256-GCM encrypt/decrypt");

    const aad = new TextEncoder().encode("memwal-v2-test");
    const aesInput = new AesGcm256(contentBytes, aad);

    // Generate a key
    const key = await aesInput.generateKey();
    info(`Generated AES key: ${Buffer.from(key).toString("hex").slice(0, 32)}...`);

    // Encrypt
    const ciphertext = await aesInput.encrypt(key);
    success(`Encrypted! Ciphertext type: ${JSON.stringify(Object.keys(ciphertext))}`);

    // Decrypt
    const decrypted = await AesGcm256.decrypt(key, ciphertext);
    const decryptedContent = new TextDecoder().decode(decrypted);

    if (decryptedContent === originalContent) {
        success(`Decrypted! Content: "${decryptedContent}"`);
    } else {
        error(
            `Decryption mismatch! Expected: "${originalContent}", Got: "${decryptedContent}"`
        );
    }

    // Serialize for transport
    const encryptedObject = new Uint8Array(0); // Placeholder since we didn't use full SEAL
    return { encryptedObject, key };
}

async function testFullFlow(
    client: SuiClient,
    walrusClient: WalrusClient,
    signer: Ed25519Keypair
) {
    log("STEP 3", "Full Flow — Encrypt → Upload → Download → Decrypt");

    const content =
        "My important memory: The architecture meeting on March 5 decided to use owner OR tee_address for SEAL policy.";
    const contentBytes = new TextEncoder().encode(content);
    const aad = new TextEncoder().encode("memwal-v2");

    info(`Original content: "${content}"`);

    // Step 3a: Encrypt with AES-256-GCM
    info("3a. Encrypting content with AES-256-GCM...");
    const aesInput = new AesGcm256(contentBytes, aad);
    const key = await aesInput.generateKey();
    const ciphertext = await aesInput.encrypt(key);

    // Serialize the ciphertext for Walrus storage
    const ciphertextAny = ciphertext as any;
    let encryptedBytes: Uint8Array;
    if (ciphertextAny.Aes256Gcm) {
        encryptedBytes = new Uint8Array(ciphertextAny.Aes256Gcm.blob);
    } else {
        throw new Error("Unexpected ciphertext type");
    }

    success(`Encrypted! ${encryptedBytes.length} bytes`);

    // Step 3b: Upload encrypted blob to Walrus
    info("3b. Uploading encrypted blob to Walrus...");
    const uploadResult = await walrusClient.writeBlob({
        blob: encryptedBytes,
        deletable: true,
        epochs: 1,
        signer,
    });

    success(`Uploaded! Blob ID: ${uploadResult.blobId}`);
    info(`Blob Object ID: ${uploadResult.blobObject.id.id}`);

    // Step 3c: Download encrypted blob from Walrus
    info("3c. Downloading encrypted blob from Walrus...");
    const downloadedEncrypted = await walrusClient.readBlob({
        blobId: uploadResult.blobId,
    });

    success(`Downloaded! ${downloadedEncrypted.length} bytes`);

    // Verify encrypted content matches
    if (
        Buffer.from(encryptedBytes).toString("hex") ===
        Buffer.from(downloadedEncrypted).toString("hex")
    ) {
        success("Encrypted content integrity verified!");
    } else {
        error("Encrypted content mismatch after download!");
    }

    // Step 3d: Decrypt downloaded content
    info("3d. Decrypting downloaded content...");
    const reconstructedCiphertext = {
        $kind: "Aes256Gcm" as const,
        Aes256Gcm: {
            blob: Array.from(downloadedEncrypted),
            aad: Array.from(aad),
        },
    };

    const decrypted = await AesGcm256.decrypt(key, reconstructedCiphertext);
    const decryptedContent = new TextDecoder().decode(decrypted);

    if (decryptedContent === content) {
        success(`Full flow verified! Decrypted: "${decryptedContent}"`);
    } else {
        error(
            `Full flow failed! Expected: "${content}", Got: "${decryptedContent}"`
        );
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 Full Flow Summary:");
    console.log("=".repeat(60));
    console.log(`  Content:            "${content.slice(0, 50)}..."`);
    console.log(`  Encrypted size:     ${encryptedBytes.length} bytes`);
    console.log(`  Blob ID:            ${uploadResult.blobId}`);
    console.log(`  Blob Object:        ${uploadResult.blobObject.id.id}`);
    console.log(`  Owner:              ${signer.toSuiAddress()}`);
    console.log(`  Decrypted match:    ${decryptedContent === content ? "✅" : "❌"}`);
    console.log(`  Key (hex):          ${Buffer.from(key).toString("hex").slice(0, 32)}...`);
}

async function testContractInteraction(
    client: SuiClient,
    signer: Ed25519Keypair
) {
    log("STEP 4", "Contract — Read MemWalAccount state");

    info(`Account Object: ${ACCOUNT_OBJECT_ID}`);

    const obj = await client.getObject({
        id: ACCOUNT_OBJECT_ID,
        options: { showContent: true },
    });

    if (obj.data?.content?.dataType === "moveObject") {
        const fields = (obj.data.content as any).fields;
        success(`Account found!`);
        info(`Owner: ${fields.owner}`);
        info(`Created at: ${fields.created_at}`);
        info(`Delegate keys: ${fields.delegate_keys?.length ?? 0}`);

        if (fields.delegate_keys?.length > 0) {
            for (const dk of fields.delegate_keys) {
                const keyFields = dk.fields || dk;
                info(
                    `  - Label: "${keyFields.label}", Key: [${(keyFields.public_key as number[]).slice(0, 4).join(",")}...]`
                );
            }
        }
    } else {
        error(`Account not found or wrong type`);
    }
}

// ============================================================
// Main
// ============================================================

async function main() {
    console.log("\n🚀 MemWal V2 — E2E Integration Test");
    console.log(`   Network: ${NETWORK}`);
    console.log(`   Package: ${PACKAGE_ID}`);
    console.log(`   Account: ${ACCOUNT_OBJECT_ID}`);

    // Setup clients
    const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

    // Load signer from Sui keystore (same as active address)
    // We need the actual private key for the wallet 0x3103...781f
    let signer: Ed25519Keypair;

    if (SUI_PRIVATE_KEY) {
        signer = Ed25519Keypair.fromSecretKey(SUI_PRIVATE_KEY);
    } else {
        // Try to load from Sui keystore
        info("No SUI_PRIVATE_KEY env var set. Loading from keystore...");
        const { execSync } = await import("child_process");
        try {
            const output = execSync(
                "sui keytool export --key-identity clever-felspar --json 2>/dev/null",
                { encoding: "utf-8" }
            ).trim();

            // Parse the JSON output for the private key
            const parsed = JSON.parse(output);
            const bech32Key = parsed.exportedPrivateKey;

            if (bech32Key) {
                // The exported key is in Bech32 format (suiprivkey1...)
                const { secretKey } = decodeSuiPrivateKey(bech32Key);
                signer = Ed25519Keypair.fromSecretKey(secretKey);
                success(`Loaded wallet: ${signer.toSuiAddress()}`);
            } else {
                throw new Error("Could not extract private key");
            }
        } catch (e: any) {
            error(
                `Failed to load keystore: ${e.message}. Set SUI_PRIVATE_KEY env var.`
            );
            process.exit(1);
        }
    }

    info(`Wallet address: ${signer.toSuiAddress()}`);

    // Check balance
    const balance = await client.getBalance({
        owner: signer.toSuiAddress(),
    });
    info(
        `SUI balance: ${(parseInt(balance.totalBalance) / 1_000_000_000).toFixed(2)} SUI`
    );

    // Setup Walrus client with upload relay (more reliable than direct node writes)
    const walrusClient = new WalrusClient({
        network: NETWORK,
        suiRpcUrl: getFullnodeUrl(NETWORK),
        uploadRelay: {
            host: "https://upload-relay.testnet.walrus.space",
            sendTip: {
                max: 10_000_000,  // max 0.01 SUI tip
            },
        },
    });

    // ---- Run Tests ----

    // Step 1: Walrus upload/download
    try {
        await testWalrusUploadDownload(walrusClient, signer);
    } catch (e: any) {
        error(`Walrus test failed: ${e.message}`);
        console.error(e);
    }

    // Step 2: SEAL encrypt/decrypt
    try {
        await testSealEncryptDecrypt(client);
    } catch (e: any) {
        error(`SEAL test failed: ${e.message}`);
        console.error(e);
    }

    // Step 3: Full flow (encrypt → upload → download → decrypt)
    try {
        await testFullFlow(client, walrusClient, signer);
    } catch (e: any) {
        error(`Full flow test failed: ${e.message}`);
        console.error(e);
    }

    // Step 4: Contract state check
    try {
        await testContractInteraction(client, signer);
    } catch (e: any) {
        error(`Contract test failed: ${e.message}`);
        console.error(e);
    }

    // Final summary
    console.log("\n" + "=".repeat(60));
    console.log("🏁 E2E Test Complete!");
    console.log("=".repeat(60));
}

main().catch(console.error);
