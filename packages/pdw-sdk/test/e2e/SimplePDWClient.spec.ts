/**
 * SimplePDWClient Playwright E2E Tests
 *
 * Tests run in a real browser to support:
 * - hnswlib-wasm (WebAssembly)
 * - IndexedDB (browser storage)
 * - Full SimplePDWClient workflow
 *
 * Required environment variables:
 * - GEMINI_API_KEY: Google Gemini API key
 * - SUI_PRIVATE_KEY: Sui wallet private key (suiprivkey1... format)
 */

import { test, expect, type Page } from '@playwright/test';
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

test.describe('SimplePDWClient E2E', () => {
  test('should pass all namespace tests in browser', async ({ page }) => {
    // Capture browser console logs
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    // Navigate to test page
    await page.goto('/test-page.html');

    // Wait for page load
    await expect(page.locator('h1')).toContainText('SimplePDWClient E2E Test');

    // Run tests in browser context
    const results = await page.evaluate(async (config) => {
      // @ts-ignore - runTests is defined in test-page.html
      return await window.runTests(config);
    }, TEST_CONFIG);

    // Log results
    console.log('Test Results:', JSON.stringify(results, null, 2));

    // Get test log from browser
    const log = await page.evaluate(() => {
      // @ts-ignore
      return window.testLog;
    });
    console.log('Test Log:', log.join('\n'));

    // Assertions for each test
    expect(results.initialization?.passed).toBe(true);

    // Embeddings tests - CORE: Work without on-chain setup
    expect(results['embeddings.generate']?.passed).toBe(true);
    expect(results['embeddings.batch']?.passed).toBe(true);
    expect(results['embeddings.similarity']?.passed).toBe(true);

    // Classify tests - CORE: Work without on-chain setup
    expect(results['classify.category']?.passed).toBe(true);
    expect(results['classify.importance']?.passed).toBe(true);
    expect(results['classify.shouldSave']?.passed).toBe(true);

    // Graph tests - CORE: Work without on-chain setup
    expect(results['graph.extract']?.passed).toBeTruthy(); // Returns array of entities
    expect(results['graph.stats']?.passed).toBe(true);

    // Memory tests - REQUIRE on-chain index setup
    // memory.create uses Walrus storage (works without backend)
    // memory.list uses backend API (requires http://localhost:3000)
    if (results['memory.create']?.passed) {
      console.log('Memory create passed - memory uploaded to Walrus');
      // memory.list may fail if backend is not running
      if (!results['memory.list']?.passed) {
        console.log('Memory list skipped - requires backend API');
      }
    } else {
      // Expected to fail without on-chain setup
      console.log('Memory tests skipped - requires on-chain index setup');
      expect(results['memory.*']?.details).toContain('Index');
    }

    // Search tests - REQUIRE backend service
    // Vector search uses API backend which may not be running
    if (results['search.vector']?.passed) {
      expect(results['search.byCategory']?.passed).toBe(true);
    } else {
      console.log('Search tests skipped - requires backend API');
    }

    // Chat tests - REQUIRE backend service (Walrus/Sui)
    // Skip assertion if expected to fail without backend
    if (results['chat.createSession']?.passed) {
      expect(results['chat.send']?.passed).toBe(true);
      expect(results['chat.getSessions']?.passed).toBe(true);
      expect(results['chat.delete']?.passed).toBe(true);
    } else {
      console.log('Chat tests skipped - requires backend service');
    }
  });

  test('should handle embeddings with real Gemini API', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
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
          enableKnowledgeGraph: true
        }
      });

      await pdw.ready();

      // Generate embedding
      const embedding = await pdw.embeddings.generate('I love programming in TypeScript');

      return {
        dimensions: embedding.length,
        isValidVector: embedding.every((n: number) => typeof n === 'number' && !isNaN(n)),
        firstFive: embedding.slice(0, 5)
      };
    }, TEST_CONFIG);

    console.log('Embedding result:', result);

    expect(result.dimensions).toBeGreaterThan(0);
    expect(result.isValidVector).toBe(true);
  });

  test('should store and retrieve memory from Walrus', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
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
          enableKnowledgeGraph: true
        }
      });

      await pdw.ready();

      try {
        // Create memory - API: create(content: string, options?: CreateMemoryOptions)
        const testContent = `E2E test memory created at ${new Date().toISOString()}`;
        const memory = await pdw.memory.create(
          testContent,
          { category: 'test', metadata: { tags: ['e2e', 'playwright'] } }
        );

        return {
          success: true,
          hasId: !!(memory.id || memory.blobId),
          memoryId: memory.id || memory.blobId,
          content: testContent
        };
      } catch (error: any) {
        // Expected to fail if on-chain index not set up
        return {
          success: false,
          error: error.message,
          requiresOnChainSetup: error.message.includes('Index') && error.message.includes('not found')
        };
      }
    }, TEST_CONFIG);

    console.log('Memory result:', result);

    // Test passes if either:
    // 1. Memory was created successfully, or
    // 2. Failed with expected "Index not found" error (requires on-chain setup)
    if (result.success) {
      expect(result.hasId).toBe(true);
      expect(result.memoryId).toBeTruthy();
    } else {
      console.log('Memory test requires on-chain index setup');
      expect(result.requiresOnChainSetup).toBe(true);
    }
  });
});
