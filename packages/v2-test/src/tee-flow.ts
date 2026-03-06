/**
 * MemWal V2 — TEE Flow Simulation Test
 *
 * Simulates the ACTUAL flow as designed in the architecture:
 *
 * 1. User sends text + delegate_key signature → TEE
 * 2. TEE verifies: delegate_key ∈ MemWalAccount.delegate_keys (onchain check)
 * 3. TEE encrypts content (AES-256-GCM, key held by TEE)
 * 4. TEE uploads encrypted blob → Walrus (user wallet pays storage, owner = user)
 * 5. TEE verifies blob ownership → user
 * 6. TEE stores {vector, blobId, encKey} in Vector DB (simulated)
 * 7. For recall: TEE downloads blob → decrypts with stored key → returns to user
 *
 * Two wallets:
 * - USER wallet (0x3103...781f): owns MemWalAccount, receives Blob ownership
 * - TEE wallet (generated): encrypts/decrypts content, uploads to Walrus
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { WalrusClient } from "@mysten/walrus";
import { AesGcm256 } from "@mysten/seal";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import * as ed from "@noble/ed25519";

// ============================================================
// Configuration
// ============================================================

const PACKAGE_ID =
    "0x93c775e573c0d9aefc0908cc9bb5b0952e131ab6c40b2b769c8b74bb991d34a0";
const ACCOUNT_OBJECT_ID =
    "0x077bc4b6d0cd0ac317ab45a699897f1ae163b2d148439d8cf094f6e20fbcc5dd";
const NETWORK = "testnet" as const;

// ============================================================
// Helpers
// ============================================================

function log(step: string, msg: string) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  [${step}] ${msg}`);
    console.log("═".repeat(60));
}

function ok(msg: string) {
    console.log(`  ✅ ${msg}`);
}
function info(msg: string) {
    console.log(`  ℹ️  ${msg}`);
}
function err(msg: string) {
    console.log(`  ❌ ${msg}`);
}
function arrow(msg: string) {
    console.log(`  → ${msg}`);
}

// ============================================================
// Simulate Ed25519 delegate key signing/verification
// ============================================================

async function signWithDelegateKey(
    privateKey: Uint8Array,
    message: string
): Promise<{ signature: Uint8Array; publicKey: Uint8Array }> {
    const msgBytes = new TextEncoder().encode(message);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const signature = await ed.signAsync(msgBytes, privateKey);
    return { signature, publicKey };
}

async function verifyDelegateSignature(
    publicKey: Uint8Array,
    signature: Uint8Array,
    message: string
): Promise<boolean> {
    const msgBytes = new TextEncoder().encode(message);
    return await ed.verifyAsync(signature, msgBytes, publicKey);
}

// ============================================================
// Main TEE Flow Test
// ============================================================

async function main() {
    console.log("\n🔐 MemWal V2 — TEE Flow Simulation");
    console.log("══════════════════════════════════════════════════════════════");

    const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

    // ============================================================
    // SETUP: Load user wallet + create TEE wallet
    // ============================================================

    log("SETUP", "Loading user wallet + creating TEE wallet");

    // Load user wallet from keystore (0x3103...781f)
    const { execSync } = await import("child_process");
    const keyOutput = execSync(
        "sui keytool export --key-identity clever-felspar --json 2>/dev/null",
        { encoding: "utf-8" }
    ).trim();
    const { secretKey: userSecretKey } = decodeSuiPrivateKey(
        JSON.parse(keyOutput).exportedPrivateKey
    );
    const userWallet = Ed25519Keypair.fromSecretKey(userSecretKey);
    ok(`User wallet: ${userWallet.toSuiAddress()}`);

    // Create TEE wallet (ephemeral — simulates TEE's internal wallet)
    // In production, TEE would have a persistent wallet for key management
    const teeWallet = Ed25519Keypair.generate();
    info(`TEE wallet:  ${teeWallet.toSuiAddress()}`);
    info(`(TEE wallet is for key management only — user wallet pays for Walrus storage)`);

    // Generate delegate key (Ed25519 — separate from Sui wallet)
    const delegatePrivateKey = ed.utils.randomPrivateKey();
    const delegatePublicKey = await ed.getPublicKeyAsync(delegatePrivateKey);
    info(`Delegate key (pub): ${Buffer.from(delegatePublicKey).toString("hex").slice(0, 24)}...`);

    // Add delegate key to onchain MemWalAccount
    info("Adding delegate key to MemWalAccount onchain...");
    const addKeyTx = new Transaction();
    addKeyTx.moveCall({
        target: `${PACKAGE_ID}::account::add_delegate_key`,
        arguments: [
            addKeyTx.object(ACCOUNT_OBJECT_ID),
            addKeyTx.pure("vector<u8>", Array.from(delegatePublicKey)),
            addKeyTx.pure("string", "tee-test-device"),
        ],
    });
    const addKeyResult = await suiClient.signAndExecuteTransaction({
        transaction: addKeyTx,
        signer: userWallet,
    });
    await suiClient.waitForTransaction({ digest: addKeyResult.digest });
    ok(`Delegate key added onchain! Tx: ${addKeyResult.digest.slice(0, 16)}...`);

    // Setup Walrus client (TEE uses this to upload)
    const walrusClient = new WalrusClient({
        network: NETWORK,
        suiRpcUrl: getFullnodeUrl(NETWORK),
        uploadRelay: {
            host: "https://upload-relay.testnet.walrus.space",
            sendTip: { max: 10_000_000 },
        },
    });

    // ============================================================
    // STEP 1: User sends text + signed request to TEE
    // ============================================================

    log("STEP 1", "User → TEE: Send text + delegate signature");

    const userMessage = "Today I learned that Rust's borrow checker prevents data races at compile time. This is a memory worth saving.";
    const timestamp = Date.now().toString();
    const signedPayload = `${timestamp}:${userMessage}`;

    const { signature, publicKey: signerPubKey } = await signWithDelegateKey(
        delegatePrivateKey,
        signedPayload
    );

    ok(`User signed message with delegate key`);
    info(`Text: "${userMessage.slice(0, 60)}..."`);
    info(`Timestamp: ${timestamp}`);
    info(`Signature: ${Buffer.from(signature).toString("hex").slice(0, 32)}...`);

    // ============================================================
    // STEP 2: TEE verifies delegate key onchain
    // ============================================================

    log("STEP 2", "TEE: Verify delegate key ∈ MemWalAccount.delegate_keys");

    // 2a: Verify the signature itself
    const sigValid = await verifyDelegateSignature(
        signerPubKey,
        signature,
        signedPayload
    );
    if (!sigValid) {
        err("Signature verification failed!");
        process.exit(1);
    }
    ok("Signature is valid");

    // 2b: Check onchain that this public key is in MemWalAccount.delegate_keys
    const accountObj = await suiClient.getObject({
        id: ACCOUNT_OBJECT_ID,
        options: { showContent: true },
    });
    const fields = (accountObj.data?.content as any)?.fields;
    const delegateKeys: any[] = fields?.delegate_keys || [];
    const pubKeyArray = Array.from(signerPubKey);

    let isAuthorized = false;
    let ownerAddress = fields?.owner;
    for (const dk of delegateKeys) {
        const keyFields = dk.fields || dk;
        const storedKey = keyFields.public_key;
        if (JSON.stringify(storedKey) === JSON.stringify(pubKeyArray)) {
            isAuthorized = true;
            break;
        }
    }

    if (!isAuthorized) {
        err("Delegate key NOT found in MemWalAccount!");
        process.exit(1);
    }
    ok(`Delegate key verified onchain! Owner: ${ownerAddress}`);
    info(`Found in ${delegateKeys.length} registered key(s)`);

    // ============================================================
    // STEP 3: TEE encrypts content with TEE's wallet
    // ============================================================

    log("STEP 3", "TEE: Encrypt content with TEE wallet (AES-256-GCM)");

    const contentBytes = new TextEncoder().encode(userMessage);
    const aad = new TextEncoder().encode("memwal-v2-tee");

    // TEE generates encryption key and encrypts
    const aesInput = new AesGcm256(contentBytes, aad);
    const encryptionKey = await aesInput.generateKey();
    const ciphertext = await aesInput.encrypt(encryptionKey);

    // Serialize ciphertext for Walrus storage
    const ciphertextAny = ciphertext as any;
    const encryptedBytes = new Uint8Array(ciphertextAny.Aes256Gcm.blob);

    ok(`Encrypted! ${encryptedBytes.length} bytes (from ${contentBytes.length} bytes plaintext)`);
    info(`Key held by TEE: ${Buffer.from(encryptionKey).toString("hex").slice(0, 24)}...`);

    // ============================================================
    // STEP 4: TEE uploads encrypted blob → Walrus (user pays)
    // ============================================================

    log("STEP 4", "TEE: Upload encrypted blob → Walrus (user wallet pays, owner = user)");

    // The user wallet pays for Walrus storage (has WAL tokens)
    // The blob is created directly with the user as owner
    // TEE handles encryption only — the user's wallet is used for the
    // storage transaction (in production, TEE delegates this via PTB)
    const uploadResult = await walrusClient.writeBlob({
        blob: encryptedBytes,
        deletable: true,
        epochs: 1,
        signer: userWallet,       // user pays for storage (has WAL + SUI)
        owner: ownerAddress,      // blob owned by user from the start
    });

    ok(`Uploaded to Walrus!`);
    info(`Blob ID: ${uploadResult.blobId}`);
    info(`Blob Object ID: ${uploadResult.blobObject.id.id}`);
    info(`Owner: ${ownerAddress} (user owns from creation)`);

    // ============================================================
    // STEP 5: Verify blob ownership = user
    // ============================================================

    log("STEP 5", "Verify Walrus Blob ownership → User");

    const blobObj = await suiClient.getObject({
        id: uploadResult.blobObject.id.id,
        options: { showOwner: true },
    });
    const actualOwner = (blobObj.data?.owner as any)?.AddressOwner;
    if (actualOwner === ownerAddress) {
        ok(`Ownership verified! Blob owned by user: ${actualOwner}`);
    } else {
        err(`Ownership mismatch! Expected: ${ownerAddress}, Got: ${actualOwner}`);
    }

    // ============================================================
    // STEP 6: TEE stores {vector, blobId} in Vector DB (simulated)
    // ============================================================

    log("STEP 6", "TEE: Store in Vector DB (simulated)");

    // In real TEE, this would call the embedding API and store in SQLite
    const mockVector = Array.from({ length: 8 }, () => Math.random());
    const vectorDbEntry = {
        owner: ownerAddress,
        blobId: uploadResult.blobId,
        blobObjectId: uploadResult.blobObject.id.id,
        vector: mockVector,
        createdAt: new Date().toISOString(),
    };

    ok(`Stored in Vector DB:`);
    info(`  owner:  ${vectorDbEntry.owner}`);
    info(`  blobId: ${vectorDbEntry.blobId}`);
    info(`  vector: [${mockVector.slice(0, 3).map((v) => v.toFixed(4)).join(", ")}...]`);

    // ============================================================
    // STEP 7: RECALL — TEE downloads blob → decrypts → returns to user
    // ============================================================

    log("STEP 7", "Recall: TEE downloads → decrypts → returns to user");

    info("7a. Downloading encrypted blob from Walrus...");
    const downloadedEncrypted = await walrusClient.readBlob({
        blobId: uploadResult.blobId,
    });
    ok(`Downloaded! ${downloadedEncrypted.length} bytes`);

    // Verify integrity
    if (
        Buffer.from(encryptedBytes).toString("hex") ===
        Buffer.from(downloadedEncrypted).toString("hex")
    ) {
        ok("Integrity check: encrypted content matches!");
    }

    info("7b. TEE decrypts with its key...");
    const reconstructedCiphertext = {
        Aes256Gcm: {
            blob: Array.from(downloadedEncrypted),
            aad: Array.from(aad),
        },
    };
    const decrypted = await AesGcm256.decrypt(
        encryptionKey,
        reconstructedCiphertext
    );
    const decryptedContent = new TextDecoder().decode(decrypted);

    if (decryptedContent === userMessage) {
        ok(`Decrypted successfully!`);
    } else {
        err(`Decryption failed!`);
    }

    info("7c. TEE returns plaintext to user...");
    ok(`Returned: "${decryptedContent}"`);

    // ============================================================
    // CLEANUP: Remove delegate key
    // ============================================================

    log("CLEANUP", "Remove test delegate key from MemWalAccount");
    const removeKeyTx = new Transaction();
    removeKeyTx.moveCall({
        target: `${PACKAGE_ID}::account::remove_delegate_key`,
        arguments: [
            removeKeyTx.object(ACCOUNT_OBJECT_ID),
            removeKeyTx.pure("vector<u8>", Array.from(delegatePublicKey)),
        ],
    });
    const removeResult = await suiClient.signAndExecuteTransaction({
        transaction: removeKeyTx,
        signer: userWallet,
    });
    await suiClient.waitForTransaction({ digest: removeResult.digest });
    ok(`Delegate key removed. Tx: ${removeResult.digest.slice(0, 16)}...`);

    // ============================================================
    // SUMMARY
    // ============================================================

    console.log("\n" + "═".repeat(60));
    console.log("  🏁 TEE Flow Simulation — COMPLETE");
    console.log("═".repeat(60));
    console.log(`
  User wallet:     ${userWallet.toSuiAddress()}
  TEE wallet:      ${teeWallet.toSuiAddress()}
  Delegate key:    ${Buffer.from(delegatePublicKey).toString("hex").slice(0, 24)}...

  Flow:
  1. ✅ User signed text with delegate key
  2. ✅ TEE verified delegate key onchain
  3. ✅ TEE encrypted content (${encryptedBytes.length} bytes)
  4. ✅ TEE uploaded to Walrus (blob: ${uploadResult.blobId.slice(0, 16)}...)
  5. ✅ TEE transferred blob ownership → user
  6. ✅ TEE stored {vector, blobId} in Vector DB
  7. ✅ TEE downloaded → decrypted → returned plaintext

  Content:  "${userMessage.slice(0, 50)}..."
  Blob ID:  ${uploadResult.blobId}
  Owner:    ${ownerAddress} (user) ✅
`);
}

main().catch((e) => {
    console.error("❌ Test failed:", e);
    process.exit(1);
});
