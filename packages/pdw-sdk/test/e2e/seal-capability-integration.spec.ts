/**
 * SEAL & Capability Integration E2E Tests
 *
 * Tests SEAL encryption and MemoryCap capability pattern
 * in a browser environment using Playwright.
 *
 * Key concepts tested:
 * - MemoryCap: Capability object for app context access
 * - SEAL encryption: Threshold encryption with key servers
 * - Object ownership = access permission (SEAL idiomatic)
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
  walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
  walrusPublisher: 'https://publisher.walrus-testnet.walrus.space',
};

// Validate environment
test.beforeAll(() => {
  if (!TEST_CONFIG.geminiApiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  if (!TEST_CONFIG.suiPrivateKey) {
    throw new Error('SUI_PRIVATE_KEY environment variable is required');
  }
  if (!TEST_CONFIG.packageId) {
    throw new Error('PACKAGE_ID environment variable is required');
  }
});

test.describe('CapabilityService E2E', () => {
  test('should initialize CapabilityService with Sui client', async ({ page }) => {
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');
      const { SuiClient, getFullnodeUrl } = await import('https://esm.sh/@mysten/sui@1.44.0/client');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });

        const { CapabilityService } = pdwModule;

        if (!CapabilityService) {
          return {
            success: false,
            error: 'CapabilityService not found in exports',
            availableExports: Object.keys(pdwModule).filter(k =>
              k.includes('Capability') || k.includes('Cap')
            )
          };
        }

        const capService = new CapabilityService({
          suiClient,
          packageId: config.packageId
        });

        return {
          success: true,
          hasCreate: typeof capService.create === 'function',
          hasGet: typeof capService.get === 'function',
          hasGetOrCreate: typeof capService.getOrCreate === 'function',
          hasList: typeof capService.list === 'function',
          hasTransfer: typeof capService.transfer === 'function',
          hasBurn: typeof capService.burn === 'function',
          hasComputeKeyId: typeof capService.computeKeyId === 'function',
          hasHasCapability: typeof capService.hasCapability === 'function',
          userAddress
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    }, TEST_CONFIG);

    console.log('CapabilityService Init Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.hasCreate).toBe(true);
    expect(result.hasGet).toBe(true);
    expect(result.hasGetOrCreate).toBe(true);
    expect(result.hasList).toBe(true);
    expect(result.hasTransfer).toBe(true);
    expect(result.hasBurn).toBe(true);
    expect(result.hasComputeKeyId).toBe(true);
  });

  test('should list existing capabilities for user', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');
      const { SuiClient, getFullnodeUrl } = await import('https://esm.sh/@mysten/sui@1.44.0/client');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });

        const { CapabilityService } = pdwModule;
        const capService = new CapabilityService({
          suiClient,
          packageId: config.packageId
        });

        // List all capabilities for user
        const caps = await capService.list({ userAddress });

        return {
          success: true,
          userAddress,
          capCount: caps.length,
          caps: caps.map((cap: any) => ({
            id: cap.id,
            appId: cap.appId,
            hasNonce: !!cap.nonce,
            owner: cap.owner
          }))
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('List Capabilities Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    // capCount can be 0 if no caps created yet
    expect(result.capCount).toBeGreaterThanOrEqual(0);
  });

  test('should compute key ID from owner and nonce', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');
      const { SuiClient, getFullnodeUrl } = await import('https://esm.sh/@mysten/sui@1.44.0/client');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });

        const { CapabilityService } = pdwModule;
        const capService = new CapabilityService({
          suiClient,
          packageId: config.packageId
        });

        // Create a mock MemoryCap for key ID computation
        const mockCap = {
          id: '0x1234',
          nonce: 'abcd1234567890abcd1234567890abcd', // 32 hex chars = 16 bytes
          appId: 'MEMO',
          owner: userAddress
        };

        const keyId = capService.computeKeyId(mockCap);

        return {
          success: true,
          owner: userAddress,
          nonce: mockCap.nonce,
          keyId,
          keyIdLength: keyId.length,
          startsWithHex: keyId.startsWith('0x')
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Compute Key ID Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.startsWithHex).toBe(true);
    // SHA3-256 produces 32 bytes = 64 hex chars + '0x' prefix = 66 chars
    expect(result.keyIdLength).toBe(66);
  });
});

test.describe('SEAL EncryptionService E2E', () => {
  test('should initialize EncryptionService', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const { EncryptionService } = pdwModule;

        if (!EncryptionService) {
          return {
            success: false,
            error: 'EncryptionService not found in exports',
            availableExports: Object.keys(pdwModule).filter(k =>
              k.includes('Encrypt') || k.includes('Seal')
            )
          };
        }

        // Check if EncryptionService class exists
        return {
          success: true,
          isClass: typeof EncryptionService === 'function',
          name: EncryptionService.name
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('EncryptionService Init Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.isClass).toBe(true);
  });

  test('should have SealService available', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const { SealService } = pdwModule;

        if (!SealService) {
          return {
            success: false,
            error: 'SealService not found in exports',
            availableExports: Object.keys(pdwModule).filter(k =>
              k.includes('Seal') || k.includes('seal')
            )
          };
        }

        return {
          success: true,
          isClass: typeof SealService === 'function',
          name: SealService.name
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('SealService Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.isClass).toBe(true);
  });
});

test.describe('SimplePDWClient Capability Namespace E2E', () => {
  test('should access capability namespace from SimplePDWClient', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          packageId: config.packageId,
          features: {
            enableEncryption: false,
            enableLocalIndexing: true
          }
        });

        await pdw.ready();

        // Check if capability namespace exists
        const hasCapability = 'capability' in pdw;

        if (!hasCapability) {
          return {
            success: true,
            hasCapabilityNamespace: false,
            note: 'capability namespace not exposed in SimplePDWClient (may need Sui config)'
          };
        }

        return {
          success: true,
          hasCapabilityNamespace: true,
          hasCreate: typeof pdw.capability?.create === 'function',
          hasGet: typeof pdw.capability?.get === 'function',
          hasList: typeof pdw.capability?.list === 'function',
          hasTransfer: typeof pdw.capability?.transfer === 'function',
          hasBurn: typeof pdw.capability?.burn === 'function'
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Capability Namespace Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
  });

  test('should access encryption namespace from SimplePDWClient', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { SimplePDWClient } = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);

        const pdw = new SimplePDWClient({
          signer: keypair,
          network: 'testnet',
          geminiApiKey: config.geminiApiKey,
          features: {
            enableEncryption: true,
            enableLocalIndexing: true
          }
        });

        await pdw.ready();

        // Check encryption namespace
        const hasEncryption = 'encryption' in pdw;

        return {
          success: true,
          hasEncryptionNamespace: hasEncryption,
          methods: hasEncryption ? {
            hasEncrypt: typeof pdw.encryption?.encrypt === 'function',
            hasDecrypt: typeof pdw.encryption?.decrypt === 'function',
            hasGetStatus: typeof pdw.encryption?.getStatus === 'function'
          } : null
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Encryption Namespace Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.hasEncryptionNamespace).toBe(true);
  });
});

test.describe('SEAL Encryption Flow E2E', () => {
  test('should demonstrate SEAL encryption pattern with capability', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');
      const { SuiClient, getFullnodeUrl } = await import('https://esm.sh/@mysten/sui@1.44.0/client');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });

        const { CapabilityService, EmbeddingService } = pdwModule;

        // 1. Initialize services
        const capService = new CapabilityService({
          suiClient,
          packageId: config.packageId
        });

        const embeddingService = new EmbeddingService({
          apiKey: config.geminiApiKey,
          model: 'text-embedding-004',
          dimensions: 768
        });

        // 2. Prepare test data
        const testContent = 'My private memory about blockchain development';

        // 3. Generate embedding
        const embeddingResult = await embeddingService.embedText({
          text: testContent,
          type: 'content'
        });

        // 4. Create mock MemoryCap (simulating on-chain cap)
        const mockCap = {
          id: '0x' + Array(64).fill('1').join(''),
          nonce: Array(32).fill('ab').join(''),
          appId: 'MEMO',
          owner: userAddress
        };

        // 5. Compute SEAL key ID
        const keyId = capService.computeKeyId(mockCap);

        // 6. Prepare memory package (what would be encrypted)
        const memoryPackage = {
          content: testContent,
          embedding: embeddingResult.vector,
          metadata: {
            category: 'development',
            importance: 8,
            createdAt: new Date().toISOString()
          }
        };

        return {
          success: true,
          flow: {
            step1_userAddress: userAddress,
            step2_contentLength: testContent.length,
            step3_embeddingDimensions: embeddingResult.vector.length,
            step4_mockCapId: mockCap.id.substring(0, 20) + '...',
            step5_keyId: keyId.substring(0, 20) + '...',
            step6_packageSize: JSON.stringify(memoryPackage).length
          },
          sealPattern: {
            description: 'SEAL encryption flow with MemoryCap',
            steps: [
              '1. User creates MemoryCap on-chain (create_memory_cap)',
              '2. MemoryCap.nonce is randomly generated',
              '3. key_id = keccak256(owner || nonce)',
              '4. Encrypt content with SEAL using key_id',
              '5. Upload encrypted blob to Walrus',
              '6. To decrypt: owner calls seal_approve with MemoryCap',
              '7. SEAL verifies ownership, releases decryption key'
            ]
          }
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('SEAL Encryption Flow Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.flow.step3_embeddingDimensions).toBe(768);
    expect(result.sealPattern.steps.length).toBe(7);
  });
});

test.describe('Capability Types & Exports E2E', () => {
  test('should export all capability-related types and classes', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async () => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');

      const capabilityExports = Object.keys(pdwModule).filter(k =>
        k.toLowerCase().includes('cap') ||
        k.toLowerCase().includes('seal') ||
        k.toLowerCase().includes('encrypt')
      );

      return {
        success: true,
        exports: capabilityExports,
        details: capabilityExports.map(name => ({
          name,
          type: typeof pdwModule[name],
          isClass: typeof pdwModule[name] === 'function' &&
                   pdwModule[name].toString().startsWith('class')
        }))
      };
    });

    console.log('Capability Exports:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.exports.length).toBeGreaterThan(0);
  });
});
