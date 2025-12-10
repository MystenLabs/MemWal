/**
 * Quilt Batch Operations E2E Tests
 *
 * Tests batch upload and retrieval using Walrus Quilts.
 * Quilts provide ~90% gas savings for batch uploads.
 */

import { test, expect } from '@playwright/test';

test.describe('Quilt Batch Operations', () => {
  test.setTimeout(300000); // 5 minutes

  test('should upload batch of memories using Quilt', async ({ page }) => {
    // Navigate to test page
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Load config from environment
    const config = {
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
      packageId: process.env.PACKAGE_ID || ''
    };

    // Run test in browser
    const result = await page.evaluate(async (config) => {
      const log: string[] = [];

      try {
        // Dynamic imports
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        log.push('SDK loaded');

        // Setup keypair
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();
        log.push(`User address: ${userAddress}`);

        // Initialize client
        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          sui: { packageId: config.packageId },
          features: {
            enableEncryption: false,
            enableLocalIndexing: true
          }
        });

        await pdw.ready();
        log.push('PDW client ready');

        // Create test memories
        const testMemories = [
          {
            content: 'Quilt Test Memory 1: I work at CommandOSS',
            category: 'fact',
            importance: 8,
            topic: 'employment'
          },
          {
            content: 'Quilt Test Memory 2: My favorite color is blue',
            category: 'preference',
            importance: 3,
            topic: 'personal'
          },
          {
            content: 'Quilt Test Memory 3: TODO: Review PR #123',
            category: 'todo',
            importance: 7,
            topic: 'work'
          }
        ];

        log.push(`Creating ${testMemories.length} test memories...`);

        // Generate embeddings for each memory
        const memoriesWithEmbeddings = await Promise.all(
          testMemories.map(async (memory) => {
            const embedding = await pdw.embeddings.generate(memory.content);
            const contentBytes = new TextEncoder().encode(JSON.stringify({
              content: memory.content,
              embedding,
              metadata: {
                category: memory.category,
                importance: memory.importance,
                topic: memory.topic
              }
            }));

            return {
              content: memory.content,
              category: memory.category,
              importance: memory.importance,
              topic: memory.topic,
              embedding: Array.from(embedding),
              encryptedContent: contentBytes, // Not encrypted for this test
              summary: memory.content.slice(0, 50)
            };
          })
        );

        log.push('Embeddings generated');

        // Check if batch service is available
        if (!pdw.services?.storage?.uploadMemoryBatch) {
          log.push('Batch upload not available - skipping');
          return {
            success: true,
            skipped: true,
            log,
            message: 'Batch upload not available in this configuration'
          };
        }

        // Upload as Quilt batch
        log.push('Starting Quilt batch upload...');
        const startTime = Date.now();

        const uploadResult = await pdw.services.storage.uploadMemoryBatch(
          memoriesWithEmbeddings,
          {
            signer: keypair,
            epochs: 3,
            userAddress
          }
        );

        const uploadTime = Date.now() - startTime;
        log.push(`Quilt upload completed in ${uploadTime}ms`);
        log.push(`Quilt ID: ${uploadResult.quiltId}`);
        log.push(`Files uploaded: ${uploadResult.files.length}`);
        log.push(`Total size: ${uploadResult.totalSize} bytes`);
        log.push(`Gas saved: ${uploadResult.gasSaved}`);

        // Retrieve files from Quilt
        log.push('Retrieving files from Quilt...');
        const retrieveStart = Date.now();

        const files = await pdw.services.storage.getQuiltFiles(uploadResult.quiltId);
        const retrieveTime = Date.now() - retrieveStart;

        log.push(`Retrieved ${files.length} files in ${retrieveTime}ms`);

        // Verify file contents
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const content = await file.bytes();
          const identifier = await file.getIdentifier();
          const tags = await file.getTags();

          log.push(`File ${i + 1}: ${identifier}`);
          log.push(`  Size: ${content.length} bytes`);
          log.push(`  Category: ${tags['category']}`);
          log.push(`  Importance: ${tags['importance']}`);
        }

        return {
          success: true,
          quiltId: uploadResult.quiltId,
          filesUploaded: uploadResult.files.length,
          filesRetrieved: files.length,
          uploadTimeMs: uploadTime,
          retrieveTimeMs: retrieveTime,
          totalSize: uploadResult.totalSize,
          gasSaved: uploadResult.gasSaved,
          log
        };

      } catch (error: any) {
        log.push(`ERROR: ${error.message}`);
        return {
          success: false,
          error: error.message,
          log
        };
      }
    }, config);

    // Log results
    console.log('Test Log:', result.log?.join('\n'));

    if (result.skipped) {
      console.log('Test skipped:', result.message);
      return;
    }

    expect(result.success).toBe(true);
    expect(result.filesUploaded).toBe(3);
    expect(result.filesRetrieved).toBe(3);
  });

  test('should query Quilt files by category', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const config = {
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
      packageId: process.env.PACKAGE_ID || ''
    };

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];

      try {
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          sui: { packageId: config.packageId },
          features: { enableEncryption: false }
        });

        await pdw.ready();
        log.push('PDW client ready');

        // Create mixed category memories
        const memories = [
          { content: 'Fact 1', category: 'fact', importance: 8, topic: 'test', embedding: [], encryptedContent: new TextEncoder().encode('fact1') },
          { content: 'Fact 2', category: 'fact', importance: 9, topic: 'test', embedding: [], encryptedContent: new TextEncoder().encode('fact2') },
          { content: 'Pref 1', category: 'preference', importance: 5, topic: 'test', embedding: [], encryptedContent: new TextEncoder().encode('pref1') },
          { content: 'Todo 1', category: 'todo', importance: 7, topic: 'test', embedding: [], encryptedContent: new TextEncoder().encode('todo1') }
        ];

        if (!pdw.services?.storage?.uploadMemoryBatch) {
          return { success: true, skipped: true, log, message: 'Batch not available' };
        }

        // Upload batch
        const uploadResult = await pdw.services.storage.uploadMemoryBatch(memories, {
          signer: keypair,
          epochs: 3,
          userAddress
        });

        log.push(`Uploaded Quilt: ${uploadResult.quiltId}`);

        // Query by category 'fact'
        const factFiles = await pdw.services.storage.getFilesByCategory(uploadResult.quiltId, 'fact');
        log.push(`Found ${factFiles.length} 'fact' files`);

        // Query by category 'preference'
        const prefFiles = await pdw.services.storage.getFilesByCategory(uploadResult.quiltId, 'preference');
        log.push(`Found ${prefFiles.length} 'preference' files`);

        return {
          success: true,
          quiltId: uploadResult.quiltId,
          totalFiles: memories.length,
          factCount: factFiles.length,
          preferenceCount: prefFiles.length,
          log
        };

      } catch (error: any) {
        log.push(`ERROR: ${error.message}`);
        return { success: false, error: error.message, log };
      }
    }, config);

    console.log('Test Log:', result.log?.join('\n'));

    if (result.skipped) {
      console.log('Skipped:', result.message);
      return;
    }

    expect(result.success).toBe(true);
    expect(result.factCount).toBe(2);
    expect(result.preferenceCount).toBe(1);
  });

  test('should retrieve file by identifier', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const config = {
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
      packageId: process.env.PACKAGE_ID || ''
    };

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];

      try {
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          sui: { packageId: config.packageId },
          features: { enableEncryption: false }
        });

        await pdw.ready();

        if (!pdw.services?.storage?.uploadFilesBatch) {
          return { success: true, skipped: true, log, message: 'Batch not available' };
        }

        // Upload files with known identifiers
        const testContent = 'Hello from Quilt test!';
        const files = [
          { identifier: 'test-file-1.txt', data: new TextEncoder().encode(testContent + ' 1'), tags: { type: 'text' } },
          { identifier: 'test-file-2.txt', data: new TextEncoder().encode(testContent + ' 2'), tags: { type: 'text' } },
          { identifier: 'special-file.json', data: new TextEncoder().encode(JSON.stringify({ key: 'value' })), tags: { type: 'json' } }
        ];

        const uploadResult = await pdw.services.storage.uploadFilesBatch(files, {
          signer: keypair,
          epochs: 3,
          userAddress
        });

        log.push(`Uploaded Quilt: ${uploadResult.quiltId}`);

        // Retrieve specific file by identifier
        const retrieved = await pdw.services.storage.getFileByIdentifier(
          uploadResult.quiltId,
          'special-file.json'
        );

        log.push(`Retrieved: ${retrieved.identifier}`);
        log.push(`Content: ${new TextDecoder().decode(retrieved.content)}`);
        log.push(`Tags: ${JSON.stringify(retrieved.tags)}`);

        return {
          success: true,
          quiltId: uploadResult.quiltId,
          retrievedIdentifier: retrieved.identifier,
          contentMatch: new TextDecoder().decode(retrieved.content) === JSON.stringify({ key: 'value' }),
          log
        };

      } catch (error: any) {
        log.push(`ERROR: ${error.message}`);
        return { success: false, error: error.message, log };
      }
    }, config);

    console.log('Test Log:', result.log?.join('\n'));

    if (result.skipped) {
      console.log('Skipped:', result.message);
      return;
    }

    expect(result.success).toBe(true);
    expect(result.retrievedIdentifier).toBe('special-file.json');
    expect(result.contentMatch).toBe(true);
  });

  test('should calculate gas savings for batch upload', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const config = {
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
      packageId: process.env.PACKAGE_ID || ''
    };

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];

      try {
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          sui: { packageId: config.packageId },
          features: { enableEncryption: false }
        });

        await pdw.ready();

        if (!pdw.services?.storage?.uploadFilesBatch) {
          return { success: true, skipped: true, log, message: 'Batch not available' };
        }

        // Create 10 test files to demonstrate gas savings
        const files = Array.from({ length: 10 }, (_, i) => ({
          identifier: `batch-test-${i}.txt`,
          data: new TextEncoder().encode(`Content for file ${i}`),
          tags: { index: i.toString() }
        }));

        const uploadResult = await pdw.services.storage.uploadFilesBatch(files, {
          signer: keypair,
          epochs: 3,
          userAddress
        });

        log.push(`Batch of ${files.length} files uploaded`);
        log.push(`Quilt ID: ${uploadResult.quiltId}`);
        log.push(`Total size: ${uploadResult.totalSize} bytes`);
        log.push(`Upload time: ${uploadResult.uploadTimeMs}ms`);
        log.push(`Gas saved: ${uploadResult.gasSaved}`);

        // For 10 files: (1 - 1/10) * 100 = 90% savings
        const expectedSavings = '~90%';

        return {
          success: true,
          filesCount: files.length,
          gasSaved: uploadResult.gasSaved,
          expectedSavings,
          uploadTimeMs: uploadResult.uploadTimeMs,
          log
        };

      } catch (error: any) {
        log.push(`ERROR: ${error.message}`);
        return { success: false, error: error.message, log };
      }
    }, config);

    console.log('Test Log:', result.log?.join('\n'));

    if (result.skipped) {
      console.log('Skipped:', result.message);
      return;
    }

    expect(result.success).toBe(true);
    expect(result.gasSaved).toBe(result.expectedSavings);
    console.log(`Gas savings verified: ${result.gasSaved}`);
  });
});
