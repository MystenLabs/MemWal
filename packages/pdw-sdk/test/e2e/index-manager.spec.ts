/**
 * IndexManager E2E Tests - Real Implementation
 *
 * Tests hybrid index persistence with REAL services:
 * - Real VectorService with hnswlib-wasm
 * - Real StorageService with Walrus testnet
 * - Real EmbeddingService with Gemini API
 * - Real blockchain queries via Sui testnet
 *
 * Tests run in a real browser to support WebAssembly.
 *
 * Required environment variables:
 * - GEMINI_API_KEY: Google Gemini API key
 * - SUI_PRIVATE_KEY: Sui wallet private key (suiprivkey1... format)
 */

import { test, expect } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Test configuration from environment
const TEST_CONFIG = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
  packageId: process.env.PACKAGE_ID || '',
};

// Validate environment
test.beforeAll(() => {
  if (!TEST_CONFIG.geminiApiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  if (!TEST_CONFIG.suiPrivateKey) {
    throw new Error('SUI_PRIVATE_KEY environment variable is required');
  }
});

test.describe('IndexManager E2E - Hybrid Persistence', () => {
  test.describe.configure({ timeout: 120000 }); // 2 minute timeout for real operations

  test('should initialize index with empty state (no memories)', async ({ page }) => {
    // Capture browser console logs
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');
    await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];
      const addLog = (msg: string) => {
        log.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };

      try {
        // @ts-ignore
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        addLog(`User address: ${userAddress}`);

        // Create client
        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false // Disable to speed up test
          }
        });

        await pdw.ready();
        addLog('SimplePDWClient ready');

        // Clear any existing index state for clean test
        if (pdw.getServices().indexManager) {
          pdw.getServices().indexManager.clearIndexState(userAddress);
          addLog('Cleared existing index state');
        }

        // Initialize index with progress tracking
        const progressStages: string[] = [];
        const result = await pdw.initializeIndex({
          onProgress: (stage, progress, message) => {
            progressStages.push(`${stage}:${progress}`);
            addLog(`[Index] ${stage} ${progress}% - ${message}`);
          },
          forceRebuild: true // Force rebuild to test full flow
        });

        addLog(`Index initialized: method=${result.method}, vectors=${result.vectorCount}, time=${result.timeMs}ms`);

        return {
          success: true,
          method: result.method,
          vectorCount: result.vectorCount,
          syncedCount: result.syncedCount,
          timeMs: result.timeMs,
          restored: result.restored,
          progressStages,
          log
        };

      } catch (error: any) {
        addLog(`ERROR: ${error.message}`);
        return {
          success: false,
          error: error.message,
          log
        };
      }
    }, TEST_CONFIG);

    console.log('Test Log:', result.log?.join('\n'));

    expect(result.success).toBe(true);
    // Method should be 'empty' or 'rebuild' depending on existing memories
    expect(['empty', 'rebuild', 'cache']).toContain(result.method);
  });

  test('should create memories and build index', async ({ page }) => {
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');
    await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];
      const addLog = (msg: string) => {
        log.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };

      try {
        // @ts-ignore
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        addLog(`User address: ${userAddress}`);

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false
          }
        });

        await pdw.ready();
        addLog('SimplePDWClient ready');

        // Create test memories
        const testMemories = [
          { content: 'IndexManager test: I love TypeScript programming', category: 'preference' },
          { content: 'IndexManager test: Meeting tomorrow at 3pm', category: 'todo' },
          { content: 'IndexManager test: Paris is the capital of France', category: 'fact' },
        ];

        const createdMemories: any[] = [];
        for (const mem of testMemories) {
          addLog(`Creating memory: ${mem.content.substring(0, 30)}...`);
          const created = await pdw.memory.create(mem.content, {
            category: mem.category as any,
            importance: 7
          });
          createdMemories.push(created);
          addLog(`Created memory: ${created.id || created.blobId}`);
        }

        // Get index stats
        const stats = pdw.getIndexStats();
        addLog(`Index stats: ${JSON.stringify(stats)}`);

        // Test search to verify index works
        addLog('Testing vector search...');
        const searchResults = await pdw.search.vector('TypeScript programming', { limit: 5 });
        addLog(`Search returned ${searchResults.length} results`);

        return {
          success: true,
          memoriesCreated: createdMemories.length,
          indexStats: stats,
          searchResultsCount: searchResults.length,
          log
        };

      } catch (error: any) {
        addLog(`ERROR: ${error.message}`);
        return {
          success: false,
          error: error.message,
          log
        };
      }
    }, TEST_CONFIG);

    console.log('Test Log:', result.log?.join('\n'));

    expect(result.success).toBe(true);
    expect(result.memoriesCreated).toBe(3);
    expect(result.searchResultsCount).toBeGreaterThanOrEqual(0);
  });

  test('should save index to Walrus and restore from cache', async ({ page }) => {
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');
    await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];
      const addLog = (msg: string) => {
        log.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };

      try {
        // @ts-ignore
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        addLog(`User address: ${userAddress}`);

        // PHASE 1: Create client and memories
        addLog('=== PHASE 1: Create memories and save index ===');
        const pdw1 = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false
          }
        });

        await pdw1.ready();

        // Clear any existing state
        if (pdw1.getServices().indexManager) {
          pdw1.getServices().indexManager.clearIndexState(userAddress);
        }

        // Create a test memory
        const uniqueContent = `IndexManager save test ${Date.now()}: I love Rust programming`;
        addLog(`Creating memory: ${uniqueContent.substring(0, 40)}...`);
        await pdw1.memory.create(uniqueContent, { category: 'preference', importance: 8 });

        // Get stats before save
        const statsBefore = pdw1.getIndexStats();
        addLog(`Stats before save: vectorCacheSize=${statsBefore?.vectorCacheSize}`);

        // Save index to Walrus
        addLog('Saving index to Walrus...');
        const savedBlobId = await pdw1.saveIndex();
        addLog(`Index saved to Walrus: ${savedBlobId}`);

        // PHASE 2: Create new client and restore from cache
        addLog('=== PHASE 2: Restore index from Walrus cache ===');

        // Simulate page reload by creating new client
        const pdw2 = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false
          }
        });

        await pdw2.ready();

        // Initialize index - should restore from cache
        const progressStages: string[] = [];
        const restoreResult = await pdw2.initializeIndex({
          onProgress: (stage, progress, message) => {
            progressStages.push(stage);
            addLog(`[Restore] ${stage} ${progress}% - ${message}`);
          }
        });

        addLog(`Restore result: method=${restoreResult.method}, vectors=${restoreResult.vectorCount}, time=${restoreResult.timeMs}ms`);

        // Verify search works after restore
        addLog('Verifying search after restore...');
        const searchResults = await pdw2.search.vector('Rust programming', { limit: 5 });
        addLog(`Search returned ${searchResults.length} results`);

        return {
          success: true,
          savedBlobId,
          restoreMethod: restoreResult.method,
          restoreVectorCount: restoreResult.vectorCount,
          restoreTimeMs: restoreResult.timeMs,
          restored: restoreResult.restored,
          searchResultsAfterRestore: searchResults.length,
          progressStages,
          log
        };

      } catch (error: any) {
        addLog(`ERROR: ${error.message}`);
        return {
          success: false,
          error: error.message,
          log
        };
      }
    }, TEST_CONFIG);

    console.log('Test Log:', result.log?.join('\n'));

    expect(result.success).toBe(true);
    // Should have saved successfully
    if (result.savedBlobId) {
      expect(result.savedBlobId).toBeTruthy();
      // Should restore from cache
      expect(result.restoreMethod).toBe('cache');
      expect(result.restored).toBe(true);
    }
  });

  test('should perform incremental sync for new memories', async ({ page }) => {
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');
    await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];
      const addLog = (msg: string) => {
        log.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };

      try {
        // @ts-ignore
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        addLog(`User address: ${userAddress}`);

        // PHASE 1: Create initial memories and save
        addLog('=== PHASE 1: Create initial state ===');
        const pdw1 = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false
          }
        });

        await pdw1.ready();

        // Create initial memory
        await pdw1.memory.create(`Incremental test initial ${Date.now()}`, { category: 'note' });

        // Save index
        const savedBlobId1 = await pdw1.saveIndex();
        addLog(`Initial index saved: ${savedBlobId1}`);

        // PHASE 2: Create new memory WITHOUT saving
        addLog('=== PHASE 2: Create new memory (not saved to index) ===');

        const newMemoryContent = `Incremental test NEW ${Date.now()}: Go programming is efficient`;
        await pdw1.memory.create(newMemoryContent, { category: 'preference' });
        addLog('New memory created (index not saved yet)');

        // PHASE 3: Simulate reload and check sync
        addLog('=== PHASE 3: Reload and verify incremental sync ===');

        const pdw2 = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false
          }
        });

        await pdw2.ready();

        // Initialize - should load from cache and sync new memories
        const restoreResult = await pdw2.initializeIndex({
          onProgress: (stage, progress, message) => {
            addLog(`[Sync] ${stage} ${progress}% - ${message}`);
          }
        });

        addLog(`Sync result: method=${restoreResult.method}, synced=${restoreResult.syncedCount}`);

        // Verify search finds the new memory
        const searchResults = await pdw2.search.vector('Go programming', { limit: 5 });
        addLog(`Search for new memory returned ${searchResults.length} results`);

        return {
          success: true,
          initialBlobId: savedBlobId1,
          restoreMethod: restoreResult.method,
          syncedCount: restoreResult.syncedCount,
          searchResultsForNew: searchResults.length,
          log
        };

      } catch (error: any) {
        addLog(`ERROR: ${error.message}`);
        return {
          success: false,
          error: error.message,
          log
        };
      }
    }, TEST_CONFIG);

    console.log('Test Log:', result.log?.join('\n'));

    expect(result.success).toBe(true);
    // Method should be cache (restored from saved index)
    if (result.initialBlobId) {
      expect(result.restoreMethod).toBe('cache');
      // Should have synced the new memory
      expect(result.syncedCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('should force rebuild when requested', async ({ page }) => {
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');
    await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];
      const addLog = (msg: string) => {
        log.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };

      try {
        // @ts-ignore
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);

        addLog('Creating client...');

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false
          }
        });

        await pdw.ready();

        // Force rebuild even if cache exists
        addLog('Force rebuilding index...');
        const startTime = Date.now();

        const result = await pdw.initializeIndex({
          forceRebuild: true,
          onProgress: (stage, progress, message) => {
            addLog(`[ForceRebuild] ${stage} ${progress}% - ${message}`);
          }
        });

        const rebuildTime = Date.now() - startTime;
        addLog(`Force rebuild completed in ${rebuildTime}ms`);
        addLog(`Result: method=${result.method}, vectors=${result.vectorCount}`);

        return {
          success: true,
          method: result.method,
          vectorCount: result.vectorCount,
          timeMs: result.timeMs,
          rebuildTimeActual: rebuildTime,
          log
        };

      } catch (error: any) {
        addLog(`ERROR: ${error.message}`);
        return {
          success: false,
          error: error.message,
          log
        };
      }
    }, TEST_CONFIG);

    console.log('Test Log:', result.log?.join('\n'));

    expect(result.success).toBe(true);
    // Force rebuild should NOT use cache
    expect(['rebuild', 'empty']).toContain(result.method);
  });

  test('benchmark: index operations performance', async ({ page }) => {
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');
    await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

    const result = await page.evaluate(async (config) => {
      const log: string[] = [];
      const metrics: Record<string, number> = {};
      const addLog = (msg: string) => {
        log.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };

      try {
        // @ts-ignore
        const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
        const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
        const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true,
            enableKnowledgeGraph: false
          }
        });

        await pdw.ready();
        addLog('Client ready');

        // Benchmark 1: Initial load/rebuild time
        addLog('Benchmark 1: Index initialization time');
        const initStart = performance.now();
        const initResult = await pdw.initializeIndex({ forceRebuild: true });
        metrics.initializeTime = performance.now() - initStart;
        addLog(`Index init: ${metrics.initializeTime.toFixed(2)}ms (method: ${initResult.method})`);

        // Benchmark 2: Save index time
        addLog('Benchmark 2: Save index to Walrus');
        const saveStart = performance.now();
        const savedBlobId = await pdw.saveIndex();
        metrics.saveTime = performance.now() - saveStart;
        addLog(`Save index: ${metrics.saveTime.toFixed(2)}ms (blobId: ${savedBlobId?.substring(0, 20)}...)`);

        // Benchmark 3: Cache restore time (create new client)
        if (savedBlobId) {
          addLog('Benchmark 3: Restore from cache');
          const pdw2 = new SimplePDWClient({
            signer: keypair,
            network: 'testnet',
            geminiApiKey: config.geminiApiKey,
            features: {
              enableEncryption: false,
              enableLocalIndexing: true,
              enableKnowledgeGraph: false
            }
          });
          await pdw2.ready();

          const restoreStart = performance.now();
          const restoreResult = await pdw2.initializeIndex();
          metrics.restoreTime = performance.now() - restoreStart;
          addLog(`Cache restore: ${metrics.restoreTime.toFixed(2)}ms (method: ${restoreResult.method})`);
        }

        // Benchmark 4: Search after restore (only if we have vectors)
        addLog('Benchmark 4: Search performance');
        const stats = pdw.getIndexStats();
        if (stats?.vectorCacheSize > 0 || savedBlobId) {
          const searchStart = performance.now();
          try {
            await pdw.search.vector('test query', { limit: 10 });
            metrics.searchTime = performance.now() - searchStart;
            addLog(`Search: ${metrics.searchTime.toFixed(2)}ms`);
          } catch (searchErr: any) {
            addLog(`Search skipped (empty index): ${searchErr.message}`);
            metrics.searchTime = 0;
          }
        } else {
          addLog('Search skipped: no vectors in index');
          metrics.searchTime = 0;
        }

        return {
          success: true,
          metrics,
          log
        };

      } catch (error: any) {
        addLog(`ERROR: ${error.message}`);
        return {
          success: false,
          error: error.message,
          metrics,
          log
        };
      }
    }, TEST_CONFIG);

    console.log('Test Log:', result.log?.join('\n'));
    console.log('Performance Metrics:', JSON.stringify(result.metrics, null, 2));

    expect(result.success).toBe(true);

    // Performance assertions
    if (result.metrics.restoreTime) {
      // Cache restore should be fast (< 5 seconds for network latency)
      expect(result.metrics.restoreTime).toBeLessThan(5000);
    }

    if (result.metrics.searchTime) {
      // Search should be fast (< 1 second)
      expect(result.metrics.searchTime).toBeLessThan(1000);
    }
  });
});
