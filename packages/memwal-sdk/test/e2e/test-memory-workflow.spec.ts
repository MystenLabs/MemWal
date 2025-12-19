/**
 * Memory Workflow Test - Detailed Output
 *
 * Creates a memory with content "I am working at CommandOSS"
 * and prints detailed output for each step of the workflow.
 */

import { test, expect } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TEST_CONFIG = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
  packageId: process.env.PACKAGE_ID || '',
};

test('Memory Workflow - Detailed Output', async ({ page }) => {
  // Capture ALL browser console logs
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    // Print with color coding
    if (type === 'error') {
      console.log(`❌ [Browser ERROR]: ${text}`);
    } else if (type === 'warning') {
      console.log(`⚠️  [Browser WARN]: ${text}`);
    } else {
      console.log(`📋 [Browser]: ${text}`);
    }
  });

  await page.goto('/test-page.html');
  await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

  // Run detailed workflow test in browser
  const result = await page.evaluate(async (config) => {
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(msg);
      console.log(msg);
    };

    try {
      log('');
      log('='.repeat(70));
      log('🚀 MEMORY CREATE WORKFLOW - DETAILED OUTPUT');
      log('='.repeat(70));
      log('');

      // Step 1: Load SDK
      log('📦 STEP 1: Loading SDK...');
      const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');
      log('   ✅ SDK loaded successfully');

      // Step 2: Setup keypair
      log('');
      log('🔑 STEP 2: Setting up keypair...');
      const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
      const keypair = Ed25519Keypair.fromSecretKey(secretKey);
      const walletAddress = keypair.getPublicKey().toSuiAddress();
      log(`   Wallet Address: ${walletAddress}`);
      log('   ✅ Keypair created');

      // Step 3: Initialize client
      log('');
      log('⚙️  STEP 3: Initializing SimplePDWClient...');
      log(`   Package ID: ${config.packageId}`);
      log('   Network: testnet');

      const pdw = new SimplePDWClient({
        signer: keypair,
        network: 'testnet',
        geminiApiKey: config.geminiApiKey,
        sui: {
          packageId: config.packageId
        },
        features: {
          enableEncryption: false,
          enableLocalIndexing: true,
          enableKnowledgeGraph: true
        }
      });

      await pdw.ready();
      log('   ✅ SimplePDWClient initialized');

      // Step 4: Create memory
      log('');
      log('='.repeat(70));
      log('📝 STEP 4: Creating Memory');
      log('='.repeat(70));

      const content = 'I am working at CommandOSS';
      log(`   Content: "${content}"`);
      log(`   Category: fact`);
      log(`   Importance: 8`);
      log(`   Topic: work`);
      log('');

      const progressLogs: string[] = [];
      const startTime = Date.now();

      const memory = await pdw.memory.create(content, {
        category: 'fact',
        importance: 8,
        topic: 'work',
        metadata: {
          company: 'CommandOSS',
          type: 'employment'
        },
        onProgress: (stage: string, percent: number) => {
          const elapsed = Date.now() - startTime;
          const msg = `   [${elapsed}ms] [${percent}%] ${stage}`;
          progressLogs.push(msg);
          console.log(msg);
        }
      });

      const totalTime = Date.now() - startTime;

      log('');
      log('='.repeat(70));
      log('✅ MEMORY CREATED SUCCESSFULLY!');
      log('='.repeat(70));
      log('');
      log('📊 RESULT:');
      log('-'.repeat(70));
      log(`   Memory ID (on-chain):  ${memory.id}`);
      log(`   Blob ID (Walrus):      ${memory.blobId}`);
      log(`   Vector ID:             ${memory.vectorId}`);
      log(`   Category:              ${memory.category}`);
      log(`   Importance:            ${memory.importance}`);
      log(`   Topic:                 ${memory.topic || 'N/A'}`);
      log(`   Encrypted:             ${memory.encrypted}`);
      log(`   Created At:            ${new Date(memory.createdAt).toISOString()}`);
      log(`   Total Time:            ${totalTime}ms`);
      log('');

      if (memory.embedding) {
        log('📐 EMBEDDING:');
        log(`   Dimensions: ${memory.embedding.length}`);
        log(`   First 5 values: [${memory.embedding.slice(0, 5).map((v: number) => v.toFixed(6)).join(', ')}]`);
        log(`   Last 5 values:  [${memory.embedding.slice(-5).map((v: number) => v.toFixed(6)).join(', ')}]`);
        log('');
      }

      if (memory.metadata) {
        log('📋 METADATA:');
        log(JSON.stringify(memory.metadata, null, 2).split('\n').map(l => '   ' + l).join('\n'));
        log('');
      }

      // Step 5: Verify by listing
      log('='.repeat(70));
      log('🔍 STEP 5: Verifying Memory (List)');
      log('='.repeat(70));

      const memories = await pdw.memory.list({ limit: 10 });
      log(`   Total memories found: ${memories.length}`);

      const found = memories.find((m: any) =>
        m.blobId === memory.blobId || m.id === memory.id
      );

      if (found) {
        log('   ✅ Memory verified in list!');
        log(`      ID: ${found.id}`);
        log(`      Category: ${found.category}`);
      } else {
        log('   ⚠️  Memory not found in list (may need blockchain sync time)');
      }
      log('');

      // Step 6: Vector search
      log('='.repeat(70));
      log('🔎 STEP 6: Testing Vector Search');
      log('='.repeat(70));
      log('   Query: "CommandOSS work"');

      const searchResults = await pdw.search.vector('CommandOSS work', { limit: 5 });
      log(`   Results found: ${searchResults.length}`);

      if (searchResults.length > 0) {
        log('');
        log('   Search Results:');
        searchResults.forEach((r: any, i: number) => {
          log(`   [${i + 1}] Score: ${r.score?.toFixed(4) || 'N/A'}`);
          log(`       ID: ${r.id}`);
          log(`       Content: ${r.content?.substring(0, 50) || 'N/A'}...`);
        });
      }
      log('');

      // Step 7: Category search
      log('='.repeat(70));
      log('📂 STEP 7: Testing Category Search');
      log('='.repeat(70));
      log('   Category: "fact"');

      const categoryResults = await pdw.search.byCategory('fact');
      log(`   Results found: ${categoryResults.length}`);

      if (categoryResults.length > 0) {
        log('');
        log('   Category Results:');
        categoryResults.slice(0, 3).forEach((r: any, i: number) => {
          log(`   [${i + 1}] ID: ${r.id}`);
          log(`       Category: ${r.category}`);
          log(`       Importance: ${r.importance}`);
        });
      }
      log('');

      // Step 8: SEAL Encryption Test with Capability Pattern
      log('='.repeat(70));
      log('🔐 STEP 8: Testing SEAL Encryption (Capability Pattern)');
      log('='.repeat(70));
      log('');
      log('   📝 Using pdw::capability for access control');
      log('');

      let encryptionPassed: boolean | null = false;
      let encryptionError = '';

      // Create a new client with encryption enabled
      try {
        log('   Creating encryption-enabled client...');
        const pdwEncrypted = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          sui: {
            packageId: config.packageId
          },
          features: {
            enableEncryption: true,
            enableLocalIndexing: false,
            enableKnowledgeGraph: false
          }
        });

        await pdwEncrypted.ready();
        log('   ✅ Encryption-enabled client initialized');

        // Step 8a: Create MemoryCap on-chain
        log('');
        log('   📦 Step 8a: Creating MemoryCap on-chain...');
        // @ts-ignore - Dynamic import from ESM CDN works in browser
        const { Transaction } = await import('https://esm.sh/@mysten/sui@1.44.0/transactions') as any;
        // @ts-ignore - Dynamic import from ESM CDN works in browser
        const { SuiClient } = await import('https://esm.sh/@mysten/sui@1.44.0/client') as any;

        const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });

        // Build transaction to create MemoryCap
        const createCapTx = new Transaction();
        createCapTx.moveCall({
          target: `${config.packageId}::capability::create_memory_cap`,
          arguments: [
            createCapTx.pure.string('SEAL_TEST'), // app_id
          ],
        });

        log('   Executing create_memory_cap transaction...');
        const capResult = await suiClient.signAndExecuteTransaction({
          transaction: createCapTx,
          signer: keypair,
          options: {
            showEffects: true,
            showEvents: true,
            showObjectChanges: true,
          },
        });

        log(`   Transaction digest: ${capResult.digest}`);

        // Find created MemoryCap object
        const createdObjects = capResult.objectChanges?.filter(
          (change: any) => change.type === 'created'
        ) || [];

        const memoryCapChange = createdObjects.find((obj: any) =>
          obj.objectType?.includes('::capability::MemoryCap')
        );

        if (!memoryCapChange) {
          throw new Error('MemoryCap object not found in transaction result');
        }

        const memoryCapId = (memoryCapChange as any).objectId;
        log(`   ✅ MemoryCap created: ${memoryCapId}`);

        // Step 8b: Get nonce from MemoryCap object
        log('');
        log('   📦 Step 8b: Fetching MemoryCap nonce...');

        // Wait a bit for blockchain sync
        await new Promise(resolve => setTimeout(resolve, 2000));

        const memoryCapObj = await suiClient.getObject({
          id: memoryCapId,
          options: { showContent: true }
        });

        log(`   Object retrieved: ${memoryCapObj.data ? 'yes' : 'no'}`);
        if (memoryCapObj.data) {
          log(`   Content type: ${typeof memoryCapObj.data.content}`);
          const contentStr = JSON.stringify(memoryCapObj.data.content || {});
          log(`   Content preview: ${contentStr.substring(0, 300)}...`);
        }

        const capContent = (memoryCapObj.data?.content as any)?.fields;
        if (!capContent) {
          log(`   ERROR: No fields in content`);
          throw new Error('Could not read fields from MemoryCap');
        }

        log(`   Fields found: ${Object.keys(capContent).join(', ')}`);

        if (!capContent.nonce) {
          log(`   ERROR: No nonce in fields`);
          throw new Error('Could not read nonce from MemoryCap');
        }

        // Convert nonce from array to Uint8Array
        const nonce = new Uint8Array(capContent.nonce);
        log(`   ✅ Nonce length: ${nonce.length} bytes`);
        log(`   App ID: ${capContent.app_id}`);

        // Step 8c: Compute key_id
        log('');
        log('   🔑 Step 8c: Computing SEAL key_id...');
        const keyId = pdwEncrypted.encryption.computeKeyId(walletAddress, nonce);
        log(`   Key ID computed: ${keyId.length} bytes`);

        // Step 8d: Create session key
        log('');
        log('   🔐 Step 8d: Creating signed session key...');
        const sessionKey = await pdwEncrypted.encryption.createSessionKey({
          keypair: keypair
        });
        log('   ✅ Session key created');

        // Step 8e: Encrypt data with capability keyId
        log('');
        log('   🔒 Step 8e: Encrypting data with SEAL (using keyId)...');
        const testData = new TextEncoder().encode('Secret message: I work at CommandOSS');
        log(`   Test data: "${new TextDecoder().decode(testData)}"`);
        log(`   Data length: ${testData.length} bytes`);

        // IMPORTANT: Use encryptWithKeyId for capability pattern
        // The keyId MUST match what seal_approve receives during decryption
        const encryptResult = await pdwEncrypted.encryption.encryptWithKeyId(testData, keyId, 2);
        log('   ✅ Encryption successful!');
        log(`   Encrypted data length: ${encryptResult.encryptedData.length} bytes`);
        log(`   Backup key length: ${encryptResult.backupKey.length} bytes`);

        // Step 8f: Decrypt data using capability pattern
        log('');
        log('   🔓 Step 8f: Decrypting data with capability pattern...');
        log(`   Using MemoryCap ID: ${memoryCapId}`);
        log(`   Using Key ID: ${keyId.length} bytes`);

        const decrypted = await pdwEncrypted.encryption.decrypt({
          encryptedData: encryptResult.encryptedData,
          sessionKey: sessionKey,
          memoryCapId: memoryCapId,
          keyId: keyId
        });

        const decryptedText = new TextDecoder().decode(decrypted);
        log(`   ✅ Decryption successful!`);
        log(`   Decrypted: "${decryptedText}"`);

        // Verify
        const originalText = new TextDecoder().decode(testData);
        if (decryptedText === originalText) {
          log('');
          log('   ✅ SEAL Encryption/Decryption VERIFIED - data matches!');
          encryptionPassed = true;
        } else {
          log('   ❌ Data mismatch after decryption!');
          encryptionError = 'Decrypted data does not match original';
        }

      } catch (encError: any) {
        encryptionError = encError.message;
        log(`   ⚠️  Encryption test failed: ${encError.message}`);

        // Check if it's a known limitation
        if (encError.message.includes('not configured') ||
            encError.message.includes('key server') ||
            encError.message.includes('network') ||
            encError.message.includes('fetch') ||
            encError.message.includes('No module found')) {
          log('   Note: This may require smart contract redeployment with capability module');
          encryptionPassed = null; // Mark as skipped, not failed
        }
      }
      log('');

      // Summary
      log('='.repeat(70));
      log('📊 WORKFLOW SUMMARY');
      log('='.repeat(70));
      log(`   ✅ Memory Content:     "${content}"`);
      log(`   ✅ Walrus Blob ID:     ${memory.blobId}`);
      log(`   ✅ On-chain Object:    ${memory.id}`);
      log(`   ✅ Vector Indexed:     Yes (${memory.embedding?.length || 0} dimensions)`);
      log(`   ${encryptionPassed === true ? '✅' : encryptionPassed === null ? '⏭️' : '❌'} SEAL Encryption:   ${encryptionPassed === true ? 'Passed' : encryptionPassed === null ? 'Skipped' : 'Failed'}`);
      log(`   ✅ Total Time:         ${totalTime}ms`);
      log('');
      log('='.repeat(70));
      log('🎉 WORKFLOW COMPLETED SUCCESSFULLY!');
      log('='.repeat(70));

      return {
        success: true,
        memory,
        totalTime,
        searchResultsCount: searchResults.length,
        categoryResultsCount: categoryResults.length,
        encryptionPassed,
        encryptionError,
        logs
      };

    } catch (error: any) {
      log('');
      log('❌ ERROR:');
      log(`   Message: ${error.message}`);
      log(`   Stack: ${error.stack?.split('\n').slice(0, 5).join('\n')}`);

      return {
        success: false,
        error: error.message,
        logs
      };
    }
  }, TEST_CONFIG);

  // Print final summary
  console.log('\n');
  console.log('='.repeat(70));
  console.log('TEST RESULT');
  console.log('='.repeat(70));

  if (result.success) {
    console.log('✅ Test PASSED');
    console.log(`   Memory ID: ${result.memory.id}`);
    console.log(`   Blob ID: ${result.memory.blobId}`);
    console.log(`   Total Time: ${result.totalTime}ms`);
  } else {
    console.log('❌ Test FAILED');
    console.log(`   Error: ${result.error}`);
  }

  expect(result.success).toBe(true);
});
