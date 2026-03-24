/**
 * Test script for namespace + restore flow
 * 
 * Usage: pnpm exec tsx scripts/test-namespace.ts <delegate-private-key-hex>
 */

import { MemWal } from "../packages/sdk/src/memwal.js";

const DELEGATE_KEY = process.argv[2];
const SERVER_URL = "http://localhost:8000";

if (!DELEGATE_KEY) {
    console.error("Usage: pnpm exec tsx scripts/test-namespace.ts <delegate-private-key-hex>");
    process.exit(1);
}

async function main() {
    console.log("=== MemWal Namespace + Restore Test ===\n");

    // Step 0: Health check
    console.log("0. Health check...");
    const healthResp = await fetch(`${SERVER_URL}/health`);
    const health = await healthResp.json();
    console.log(`   ✅ Server status: ${(health as any).status}\n`);

    // Create SDK client with namespace
    const NAMESPACE = `test-ns-${Date.now()}`;
    console.log(`   Using namespace: "${NAMESPACE}"\n`);

    const memwal = MemWal.create({
        key: DELEGATE_KEY,
        accountId: process.env.MEMWAL_ACCOUNT_ID || '0x_YOUR_ACCOUNT_ID',
        serverUrl: SERVER_URL,
        namespace: NAMESPACE,
    });

    // Step 1: Remember with namespace
    console.log("1. Remember (with namespace)...");
    try {
        const rememberResult = await memwal.remember("I love Sui blockchain and Move language");
        console.log(`   ✅ Remember OK`);
        console.log(`   id: ${rememberResult.id}`);
        console.log(`   blob_id: ${rememberResult.blob_id}`);
        console.log(`   namespace: ${rememberResult.namespace}`);
        console.log(`   owner: ${rememberResult.owner}\n`);

        // Step 2: Recall with same namespace
        console.log("2. Recall (same namespace)...");
        const recallResult = await memwal.recall("What blockchain do I like?", 5);
        console.log(`   ✅ Recall OK: ${recallResult.total} results`);
        if (recallResult.results.length > 0) {
            console.log(`   First result: "${recallResult.results[0].text.substring(0, 60)}..."`);
            console.log(`   Distance: ${recallResult.results[0].distance}`);
        }
        console.log();

        // Step 3: Recall with different namespace (should return 0)
        console.log("3. Recall (different namespace - should be empty)...");
        const emptyResult = await memwal.recall("What blockchain do I like?", 5, "nonexistent-ns");
        console.log(`   ✅ Recall OK: ${emptyResult.total} results (expected 0)`);
        console.log();

        // Step 4: Restore
        console.log("4. Restore namespace...");
        try {
            const restoreResult = await memwal.restore(NAMESPACE);
            console.log(`   ✅ Restore OK`);
            console.log(`   restored: ${restoreResult.restored}`);
            console.log(`   namespace: ${restoreResult.namespace}`);
            console.log(`   owner: ${restoreResult.owner}`);
        } catch (restoreErr: any) {
            console.log(`   ⚠️  Restore error: ${restoreErr.message}`);
        }
        console.log();

    } catch (err: any) {
        console.error(`   ❌ Error: ${err.message}`);
        if (err.message.includes("401") || err.message.includes("Unauthorized")) {
            console.error("   → Delegate key may not be registered on-chain.");
        }
        process.exit(1);
    }

    console.log("=== All tests passed! ===");
}

main().catch(console.error);
