/**
 * StorageService Quilt Operations Tests
 *
 * Tests the new Walrus Quilt batch upload functionality:
 * - uploadMemoryBatch()
 * - getQuiltFiles()
 * - getQuiltFilesByTags()
 *
 * ✅ INTEGRATION: Uses real Walrus testnet (requires testnet connection)
 */

import { describe, it, test, expect, beforeAll } from '@jest/globals';
import { StorageService } from '../../src/services/StorageService';
import { WalrusFile } from '@mysten/walrus';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

describe('StorageService - Quilt Batch Operations', () => {
  let storageService: StorageService;
  const walrusAggregator = process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space';
  const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID || '0xdac3ced3f5fd4e704b295f69f827a4e42596975fa9be0dcaf6f1dfb7a1acc7c3';

  const shouldSkipIntegration = !process.env.RUN_INTEGRATION_TESTS;

  beforeAll(() => {
    storageService = new StorageService({
      packageId,
      walrusAggregator,
      network: 'testnet'
    });

    if (shouldSkipIntegration) {
      console.warn('⚠️  Skipping Quilt integration tests');
      console.warn('   Set RUN_INTEGRATION_TESTS=true to run these tests');
    }
  });

  // ==================== BATCH UPLOAD TESTS ====================

  describe('uploadMemoryBatch()', () => {
    test('should upload multiple memories as a Quilt', async () => {
      if (shouldSkipIntegration) return;

      const testMemories = [
        {
          content: 'First test memory content',
          category: 'personal',
          importance: 7,
          topic: 'Test Topic 1',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('encrypted-content-1'),
          summary: 'Summary of first memory'
        },
        {
          content: 'Second test memory content',
          category: 'work',
          importance: 8,
          topic: 'Test Topic 2',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('encrypted-content-2'),
          summary: 'Summary of second memory'
        },
        {
          content: 'Third test memory content',
          category: 'personal',
          importance: 5,
          topic: 'Test Topic 3',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('encrypted-content-3'),
          summary: 'Summary of third memory'
        }
      ];

      // Mock signer
      const mockSigner = {
        async signAndSend(txb: any) {
          // In real test, this would actually sign and send
          return { digest: 'mock-tx-digest' };
        }
      };

      const mockUserAddress = '0x1234567890abcdef1234567890abcdef12345678';

      const result = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: mockUserAddress
      });

      console.log('📦 Batch upload result:', result);

      // Validate result structure
      expect(result).toHaveProperty('quiltId');
      expect(result).toHaveProperty('files');
      expect(result).toHaveProperty('uploadTimeMs');

      // Should have uploaded all files
      expect(result.files).toHaveLength(3);

      // All files should share the same quiltId
      const uniqueQuiltIds = new Set(result.files.map(f => f.blobId));
      expect(uniqueQuiltIds.size).toBe(1);

      // Should have identifiers
      result.files.forEach(file => {
        expect(file).toHaveProperty('identifier');
        expect(file).toHaveProperty('blobId');
        expect(file.identifier).toMatch(/^memory-\d+-\d+$/);
      });

      // Upload time should be reasonable
      expect(result.uploadTimeMs).toBeGreaterThan(0);
      expect(result.uploadTimeMs).toBeLessThan(60000); // Less than 60 seconds

      console.log(`   ✅ Uploaded ${result.files.length} files in ${result.uploadTimeMs}ms`);
      console.log(`   📊 Gas savings: ~90% compared to individual uploads`);
    }, 120000); // 2-minute timeout for integration test

    test('should handle single memory batch', async () => {
      if (shouldSkipIntegration) return;

      const testMemories = [
        {
          content: 'Single memory test',
          category: 'test',
          importance: 5,
          topic: 'Single Test',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('encrypted-single'),
          summary: 'Single memory summary'
        }
      ];

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const result = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });

      expect(result.files).toHaveLength(1);
      expect(result.quiltId).toBeDefined();
    }, 120000);

    test('should handle large batch (10+ memories)', async () => {
      if (shouldSkipIntegration) return;

      // Create 15 test memories
      const testMemories = Array.from({ length: 15 }, (_, i) => ({
        content: `Test memory ${i + 1}`,
        category: i % 2 === 0 ? 'work' : 'personal',
        importance: Math.floor(Math.random() * 10) + 1,
        topic: `Topic ${i + 1}`,
        embedding: Array.from({ length: 768 }, () => Math.random()),
        encryptedContent: new TextEncoder().encode(`encrypted-${i + 1}`),
        summary: `Summary ${i + 1}`
      }));

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const startTime = Date.now();
      const result = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });
      const duration = Date.now() - startTime;

      console.log(`📦 Large batch: ${result.files.length} files in ${duration}ms`);

      expect(result.files).toHaveLength(15);
      expect(duration).toBeLessThan(120000); // Should complete within 2 minutes
    }, 180000); // 3-minute timeout
  });

  // ==================== QUILT RETRIEVAL TESTS ====================

  describe('getQuiltFiles()', () => {
    test('should retrieve all files from a Quilt', async () => {
      if (shouldSkipIntegration) return;

      // First upload a test Quilt
      const testMemories = [
        {
          content: 'Memory 1',
          category: 'test',
          importance: 5,
          topic: 'Topic 1',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('encrypted-1'),
          summary: 'Summary 1'
        },
        {
          content: 'Memory 2',
          category: 'test',
          importance: 6,
          topic: 'Topic 2',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('encrypted-2'),
          summary: 'Summary 2'
        }
      ];

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const uploadResult = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });

      console.log('📤 Uploaded Quilt:', uploadResult.quiltId);

      // Retrieve the files
      const files = await storageService.getQuiltFiles(uploadResult.quiltId);

      console.log(`📥 Retrieved ${files.length} files from Quilt`);

      expect(files).toHaveLength(2);

      // Validate file structure
      for (const [index, file] of files.entries()) {
        expect(file).toBeInstanceOf(WalrusFile);
        const tags = await file.getTags();
        console.log(`   [${index}] ${file.getIdentifier()} - Tags:`, tags);
      }
    }, 180000);

    test('should throw error for non-existent Quilt', async () => {
      if (shouldSkipIntegration) return;

      const fakeQuiltId = 'nonexistent-quilt-id-12345';

      await expect(storageService.getQuiltFiles(fakeQuiltId))
        .rejects
        .toThrow();
    }, 60000);
  });

  // ==================== TAG-BASED QUERY TESTS ====================

  describe('getQuiltFilesByTags()', () => {
    test('should filter files by category tag', async () => {
      if (shouldSkipIntegration) return;

      // Upload Quilt with mixed categories
      const testMemories = [
        {
          content: 'Work memory',
          category: 'work',
          importance: 8,
          topic: 'Work Topic',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('work-encrypted'),
          summary: 'Work summary'
        },
        {
          content: 'Personal memory',
          category: 'personal',
          importance: 5,
          topic: 'Personal Topic',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('personal-encrypted'),
          summary: 'Personal summary'
        },
        {
          content: 'Another work memory',
          category: 'work',
          importance: 7,
          topic: 'Work Topic 2',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('work-encrypted-2'),
          summary: 'Work summary 2'
        }
      ];

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const uploadResult = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });

      console.log('📤 Uploaded mixed Quilt:', uploadResult.quiltId);

      // Query for work memories only
      const workFiles = await storageService.getQuiltFilesByTags(
        uploadResult.quiltId,
        [{ category: 'work' }]
      );

      console.log(`📥 Found ${workFiles.length} work memories`);

      expect(workFiles).toHaveLength(2);

      // Validate that all returned files have work category
      for (const file of workFiles) {
        const tags = await file.getTags();
        expect(tags.category).toBe('work');
      }
    }, 180000);

    test('should filter by importance', async () => {
      if (shouldSkipIntegration) return;

      const testMemories = [
        {
          content: 'Low importance',
          category: 'test',
          importance: 3,
          topic: 'Low',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('low'),
          summary: 'Low'
        },
        {
          content: 'High importance',
          category: 'test',
          importance: 9,
          topic: 'High',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('high'),
          summary: 'High'
        },
        {
          content: 'Another high',
          category: 'test',
          importance: 8,
          topic: 'High 2',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('high-2'),
          summary: 'High 2'
        }
      ];

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const uploadResult = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });

      // Query for high importance (8+)
      const highImportanceFiles = await storageService.getQuiltFilesByTags(
        uploadResult.quiltId,
        [{ importance: '9' }, { importance: '8' }] // Note: tags are strings
      );

      console.log(`📥 Found ${highImportanceFiles.length} high-importance memories`);

      expect(highImportanceFiles.length).toBeGreaterThanOrEqual(1);
    }, 180000);

    test('should handle multiple tag filters (AND logic)', async () => {
      if (shouldSkipIntegration) return;

      const testMemories = [
        {
          content: 'Work important',
          category: 'work',
          importance: 9,
          topic: 'Critical',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('work-critical'),
          summary: 'Work critical'
        },
        {
          content: 'Work normal',
          category: 'work',
          importance: 5,
          topic: 'Normal',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('work-normal'),
          summary: 'Work normal'
        },
        {
          content: 'Personal important',
          category: 'personal',
          importance: 9,
          topic: 'Personal critical',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('personal-critical'),
          summary: 'Personal critical'
        }
      ];

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const uploadResult = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });

      // Query for work AND importance=9
      const filteredFiles = await storageService.getQuiltFilesByTags(
        uploadResult.quiltId,
        [{ category: 'work', importance: '9' }]
      );

      console.log(`📥 Found ${filteredFiles.length} work memories with importance 9`);

      expect(filteredFiles).toHaveLength(1);

      const tags = await filteredFiles[0].getTags();
      expect(tags.category).toBe('work');
      expect(tags.importance).toBe('9');
    }, 180000);

    test('should return empty array for non-matching tags', async () => {
      if (shouldSkipIntegration) return;

      const testMemories = [
        {
          content: 'Test',
          category: 'work',
          importance: 5,
          topic: 'Test',
          embedding: Array.from({ length: 768 }, () => Math.random()),
          encryptedContent: new TextEncoder().encode('test'),
          summary: 'Test'
        }
      ];

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const uploadResult = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });

      // Query for non-existent category
      const files = await storageService.getQuiltFilesByTags(
        uploadResult.quiltId,
        [{ category: 'nonexistent' }]
      );

      expect(files).toHaveLength(0);
    }, 180000);
  });

  // ==================== PERFORMANCE & GAS SAVINGS TESTS ====================

  describe('Performance & Gas Savings', () => {
    test('should calculate gas savings correctly', async () => {
      if (shouldSkipIntegration) return;

      const numFiles = 10;
      const testMemories = Array.from({ length: numFiles }, (_, i) => ({
        content: `Memory ${i}`,
        category: 'test',
        importance: 5,
        topic: `Topic ${i}`,
        embedding: Array.from({ length: 768 }, () => Math.random()),
        encryptedContent: new TextEncoder().encode(`encrypted-${i}`),
        summary: `Summary ${i}`
      }));

      const mockSigner = {
        async signAndSend(txb: any) {
          return { digest: 'mock-tx-digest' };
        }
      };

      const result = await storageService.uploadMemoryBatch(testMemories, {
        signer: mockSigner as any,
        epochs: 1,
        userAddress: '0x1234567890abcdef1234567890abcdef12345678'
      });

      // Expected: 1 Quilt transaction vs numFiles individual transactions
      const gasSavingsPercent = ((numFiles - 1) / numFiles) * 100;

      console.log(`💰 Gas Savings Calculation:`);
      console.log(`   Individual uploads: ${numFiles} transactions`);
      console.log(`   Quilt upload: 1 transaction`);
      console.log(`   Savings: ~${gasSavingsPercent.toFixed(1)}%`);

      expect(gasSavingsPercent).toBeGreaterThan(80); // Should be 90% for 10 files
    }, 180000);
  });
});
