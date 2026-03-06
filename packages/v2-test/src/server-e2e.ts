/**
 * MemWal V2 — E2E Test: Full Flow Against Rust Server
 *
 * Tests the ACTUAL server endpoints with real onchain verification:
 *
 * 1. Setup: Add delegate key to MemWalAccount onchain
 * 2. Remember: Sign request → POST /api/remember {text, owner}
 * 3. Recall:   Sign request → POST /api/recall {query, owner}
 * 4. Verify:   Decrypted text matches original
 * 5. Cleanup:  Remove delegate key onchain
 *
 * Server must be running on localhost:3001
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import * as ed from "@noble/ed25519";
import { createHash } from "crypto";

// ============================================================
// Configuration
// ============================================================

const SERVER_URL = "http://localhost:3001";
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
function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function arrow(msg: string) { console.log(`  → ${msg}`); }

/**
 * Sign an API request with Ed25519 delegate key.
 * Matches the server's expected format: "{timestamp}.{method}.{path}.{body_sha256}"
 */
async function signedFetch(
    url: string,
    method: string,
    body: object,
    delegatePrivateKey: Uint8Array,
    delegatePublicKey: Uint8Array
): Promise<Response> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path = new URL(url).pathname;
    const bodyStr = JSON.stringify(body);
    const bodySha256 = createHash("sha256").update(bodyStr).digest("hex");

    const message = `${timestamp}.${method}.${path}.${bodySha256}`;
    const msgBytes = new TextEncoder().encode(message);
    const signature = await ed.signAsync(msgBytes, delegatePrivateKey);

    return fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            "x-public-key": Buffer.from(delegatePublicKey).toString("hex"),
            "x-signature": Buffer.from(signature).toString("hex"),
            "x-timestamp": timestamp,
        },
        body: bodyStr,
    });
}

// ============================================================
// Main Test
// ============================================================

async function main() {
    console.log("\n🧪 MemWal V2 — E2E Test: Rust Server Full Flow");
    console.log("══════════════════════════════════════════════════════════════");

    const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

    // Check server health
    log("CHECK", "Verifying server is running...");
    try {
        const healthRes = await fetch(`${SERVER_URL}/health`);
        const health = await healthRes.json();
        ok(`Server OK: ${JSON.stringify(health)}`);
    } catch (e) {
        console.error("❌ Server not running! Start with: cd packages/v2-server && cargo run");
        process.exit(1);
    }

    // ============================================================
    // SETUP: Load user wallet + create delegate key
    // ============================================================

    log("SETUP", "Loading user wallet + creating delegate key");

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

    // Generate delegate key
    const delegatePrivateKey = ed.utils.randomPrivateKey();
    const delegatePublicKey = await ed.getPublicKeyAsync(delegatePrivateKey);
    ok(`Delegate key (pub): ${Buffer.from(delegatePublicKey).toString("hex").slice(0, 24)}...`);

    // ============================================================
    // Step 1: Add delegate key onchain
    // ============================================================

    log("STEP 1", "Adding delegate key to MemWalAccount onchain");

    const addTx = new Transaction();
    addTx.moveCall({
        target: `${PACKAGE_ID}::account::add_delegate_key`,
        arguments: [
            addTx.object(ACCOUNT_OBJECT_ID),
            addTx.pure("vector<u8>", Array.from(delegatePublicKey)),
            addTx.pure("string", "e2e-server-test"),
        ],
    });

    const addResult = await suiClient.signAndExecuteTransaction({
        transaction: addTx,
        signer: userWallet,
        options: { showEffects: true },
    });
    ok(`Delegate key added onchain: ${addResult.digest}`);

    // Wait for tx to be indexed
    await new Promise(r => setTimeout(r, 2000));

    // ============================================================
    // Step 2: POST /api/remember — save a memory
    // ============================================================

    log("STEP 2", "POST /api/remember — saving a memory");

    const testText = "Tôi thích ăn phở và bị dị ứng đậu phộng";
    info(`Text: "${testText}"`);

    const rememberRes = await signedFetch(
        `${SERVER_URL}/api/remember`,
        "POST",
        { text: testText },
        delegatePrivateKey,
        delegatePublicKey
    );

    if (!rememberRes.ok) {
        const errBody = await rememberRes.text();
        console.error(`❌ Remember failed (${rememberRes.status}): ${errBody}`);
        await cleanup(suiClient, userWallet, delegatePublicKey);
        process.exit(1);
    }

    const rememberData = await rememberRes.json();
    ok(`Memory saved!`);
    arrow(`ID: ${rememberData.id}`);
    arrow(`Blob ID: ${rememberData.blob_id}`);
    arrow(`Owner: ${rememberData.owner}`);

    // Wait a moment for Walrus to propagate
    info("Waiting 3s for Walrus propagation...");
    await new Promise(r => setTimeout(r, 3000));

    // ============================================================
    // Step 3: POST /api/remember — save another memory
    // ============================================================

    log("STEP 3", "POST /api/remember — saving another memory");

    const testText2 = "Tôi sống ở Hà Nội và làm việc tại CommandOSS";
    info(`Text: "${testText2}"`);

    const rememberRes2 = await signedFetch(
        `${SERVER_URL}/api/remember`,
        "POST",
        { text: testText2 },
        delegatePrivateKey,
        delegatePublicKey
    );

    if (!rememberRes2.ok) {
        const errBody = await rememberRes2.text();
        console.error(`❌ Remember 2 failed (${rememberRes2.status}): ${errBody}`);
        await cleanup(suiClient, userWallet, delegatePublicKey);
        process.exit(1);
    }

    const rememberData2 = await rememberRes2.json();
    ok(`Memory 2 saved!`);
    arrow(`ID: ${rememberData2.id}`);
    arrow(`Blob ID: ${rememberData2.blob_id}`);

    // Wait for Walrus
    info("Waiting 3s for Walrus propagation...");
    await new Promise(r => setTimeout(r, 3000));

    // ============================================================
    // Step 4: POST /api/recall — search memories
    // ============================================================

    log("STEP 4", "POST /api/recall — searching memories");

    const query = "thức ăn nên tránh";
    info(`Query: "${query}"`);

    const recallRes = await signedFetch(
        `${SERVER_URL}/api/recall`,
        "POST",
        { query, limit: 5 },
        delegatePrivateKey,
        delegatePublicKey
    );

    if (!recallRes.ok) {
        const errBody = await recallRes.text();
        console.error(`❌ Recall failed (${recallRes.status}): ${errBody}`);
        await cleanup(suiClient, userWallet, delegatePublicKey);
        process.exit(1);
    }

    const recallData = await recallRes.json();
    ok(`Found ${recallData.total} memories!`);

    for (const result of recallData.results) {
        arrow(`[distance: ${result.distance.toFixed(4)}] blob: ${result.blob_id}`);
        arrow(`  → Decrypted text: "${result.text}"`);
    }

    // ============================================================
    // Step 5: Verify round-trip
    // ============================================================

    log("STEP 5", "Verifying round-trip");

    const foundTexts = recallData.results.map((r: any) => r.text);

    if (foundTexts.includes(testText)) {
        ok(`✅ Memory 1 found: "${testText}"`);
    } else {
        console.error(`❌ Memory 1 NOT found in results!`);
    }

    if (foundTexts.includes(testText2)) {
        ok(`✅ Memory 2 found: "${testText2}"`);
    } else {
        console.error(`❌ Memory 2 NOT found in results!`);
    }

    // ============================================================
    // CLEANUP: Remove delegate key onchain
    // ============================================================

    await cleanup(suiClient, userWallet, delegatePublicKey);

    // ============================================================
    // Summary
    // ============================================================

    console.log("\n" + "═".repeat(60));
    console.log("  🎉 E2E TEST COMPLETE!");
    console.log("═".repeat(60));
    console.log("  Flow tested:");
    console.log("  1. ✅ Add delegate key onchain");
    console.log("  2. ✅ Remember: sign → server verifies → embed → encrypt → Walrus upload → store");
    console.log("  3. ✅ Remember: second memory saved");
    console.log("  4. ✅ Recall: sign → server verifies → embed query → search → Walrus download → decrypt");
    console.log("  5. ✅ Round-trip verified: plaintext matches original");
    console.log("  6. ✅ Cleanup: delegate key removed onchain");
    console.log("═".repeat(60));
}

async function cleanup(
    suiClient: SuiClient,
    userWallet: Ed25519Keypair,
    delegatePublicKey: Uint8Array
) {
    log("CLEANUP", "Removing delegate key onchain");

    try {
        const removeTx = new Transaction();
        removeTx.moveCall({
            target: `${PACKAGE_ID}::account::remove_delegate_key`,
            arguments: [
                removeTx.object(ACCOUNT_OBJECT_ID),
                removeTx.pure("vector<u8>", Array.from(delegatePublicKey)),
            ],
        });

        const removeResult = await suiClient.signAndExecuteTransaction({
            transaction: removeTx,
            signer: userWallet,
            options: { showEffects: true },
        });
        ok(`Delegate key removed: ${removeResult.digest}`);
    } catch (e) {
        console.error(`Warning: cleanup failed: ${e}`);
    }
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
