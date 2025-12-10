/**
 * Walrus writeBlobFlow Test - Focused on Single Blob Uploads
 * 
 * Tests the StorageService with writeBlobFlow pattern which is designed
 * for single file uploads at a time. Batching is handled at a higher level.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { StorageService } from '../src/services/StorageService';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import * as dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

describe('Walrus writeBlobFlow Tests', () => {
  let storageService: StorageService;
  let signer: Ed25519Keypair;
  let testAddress: string;
  let uploadResults: any[] = [];

  beforeAll(async () => {
    // Setup test wallet from .env.test
    const privateKeyHex = process.env.TEST_PRIVATE_KEY;
    if (!privateKeyHex) {
      throw new Error('TEST_PRIVATE_KEY not found in .env.test - check your configuration');
    }
    
    signer = Ed25519Keypair.fromSecretKey(privateKeyHex);
    testAddress = signer.toSuiAddress();
    
    console.log('🔑 Test wallet address:', testAddress);
    console.log('📍 Expected address:  ', process.env.TEST_USER_ADDRESS);

    // Create StorageService with upload relay configuration
    storageService = new StorageService({
      packageId: process.env.SUI_PACKAGE_ID || '0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde',
      network: 'testnet',
      useUploadRelay: true, // Test upload relay (preferred)
      epochs: 3,
      timeout: 60000,
    });

    console.log('🚀 StorageService initialized with upload relay support');
  });

  afterAll(() => {
    // Log all upload results for debugging
    console.log('\\n📊 Upload Test Results Summary:');
    uploadResults.forEach((result, index) => {
      console.log(`  ${index + 1}. ${result.testName}: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
      if (result.blobId) {
        console.log(`     Blob ID: ${result.blobId}`);
      }
      if (result.error) {
        console.log(`     Error: ${result.error}`);
      }
    });
  });

  test('Upload single blob with upload relay (writeBlobFlow)', async () => {
    const testName = 'Single Blob Upload (Upload Relay)';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      // Create test data
      const testContent = `Walrus writeBlobFlow test at ${new Date().toISOString()}`;
      const testData = new TextEncoder().encode(testContent);
      
      console.log('📝 Content:', testContent);
      console.log('📏 Size:', testData.length, 'bytes');
      
      // Test upload with relay using writeBlobFlow pattern
      const result = await storageService.uploadBlob(testData, {
        signer,
        epochs: 3,
        deletable: true,
        useUploadRelay: true, // This uses writeBlobFlow with upload relay
        metadata: {
          category: 'test',
          topic: 'writeBlobFlow-test',
          'test-type': 'single-blob-relay'
        }
      });

      console.log('✅ Upload successful!');
      console.log('🆔 Blob ID:', result.blobId);
      console.log('⏱️  Upload time:', result.uploadTimeMs, 'ms');
      console.log('🔒 Encrypted:', result.isEncrypted);
      console.log('📊 Epochs:', result.storageEpochs);

      // Verify result structure
      expect(result).toHaveProperty('blobId');
      expect(result).toHaveProperty('metadata');
      expect(result).toHaveProperty('uploadTimeMs');
      expect(result.blobId).toBeDefined();
      expect(result.uploadTimeMs).toBeGreaterThan(0);

      uploadResults.push({
        testName,
        success: true,
        blobId: result.blobId,
        uploadTimeMs: result.uploadTimeMs
      });

    } catch (error) {
      console.error('❌ Upload failed:', error);
      uploadResults.push({
        testName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }, 120000); // 2 minute timeout

  test('Upload and retrieve blob content integrity', async () => {
    const testName = 'Upload and Retrieve Content Integrity';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      // Create test content with specific data patterns
      const testContent = `Content integrity test
Timestamp: ${new Date().toISOString()}
Random data: ${Math.random()}
Unicode: 🚀 💾 ✅
Multi-line content with special characters: !@#$%^&*()`;
      
      const testData = new TextEncoder().encode(testContent);
      
      console.log('📤 Uploading test content...');
      console.log('📏 Original size:', testData.length, 'bytes');
      
      // Upload blob
      const uploadResult = await storageService.uploadBlob(testData, {
        signer,
        epochs: 3,
        deletable: true,
        useUploadRelay: true,
        metadata: { 'test-type': 'content-integrity' }
      });

      console.log('✅ Upload complete, blob ID:', uploadResult.blobId);
      
      // Retrieve blob
      console.log('📥 Retrieving blob...');
      const retrievedData = await storageService.getBlob(uploadResult.blobId);
      const retrievedContent = new TextDecoder().decode(retrievedData);
      
      console.log('✅ Retrieval successful!');
      console.log('📏 Retrieved size:', retrievedData.length, 'bytes');
      console.log('🔍 Content match:', testContent === retrievedContent ? '✅' : '❌');

      // Verify content integrity
      expect(retrievedContent).toBe(testContent);
      expect(retrievedData).toEqual(testData);

      uploadResults.push({
        testName,
        success: true,
        blobId: uploadResult.blobId,
        contentMatch: testContent === retrievedContent,
        originalSize: testData.length,
        retrievedSize: retrievedData.length
      });

    } catch (error) {
      console.error('❌ Content integrity test failed:', error);
      uploadResults.push({
        testName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }, 120000);

  test('Upload different data types with writeBlobFlow', async () => {
    const testName = 'Different Data Types';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      // Test different data types that would be uploaded individually
      const testCases = [
        {
          name: 'JSON data',
          content: JSON.stringify({ 
            message: 'Test JSON content', 
            timestamp: new Date().toISOString(),
            data: { numbers: [1, 2, 3], text: 'hello world' }
          })
        },
        {
          name: 'Binary data (Uint8Array)',
          content: new Uint8Array([0, 1, 2, 3, 255, 254, 253, 128, 127])
        }
      ];

      const results = [];
      
      // Upload each data type individually (as writeBlobFlow is designed for)
      for (let i = 0; i < testCases.length; i++) {
        const testCase = testCases[i];
        console.log(`📝 Testing ${testCase.name}...`);
        
        const testData = testCase.content instanceof Uint8Array 
          ? testCase.content 
          : new TextEncoder().encode(testCase.content);
        
        const result = await storageService.uploadBlob(testData, {
          signer,
          epochs: 3,
          deletable: true,
          useUploadRelay: true,
          metadata: {
            category: 'data-type-test',
            'test-case': testCase.name,
            'data-size': testData.length.toString()
          }
        });

        console.log(`✅ ${testCase.name} uploaded: ${result.blobId}`);
        results.push({ 
          testCase: testCase.name, 
          blobId: result.blobId,
          size: testData.length 
        });

        // Small delay between uploads to be respectful to the service
        if (i < testCases.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      expect(results).toHaveLength(testCases.length);
      results.forEach(result => {
        expect(result.blobId).toBeDefined();
      });

      uploadResults.push({
        testName,
        success: true,
        testCases: results.length,
        results: results
      });

    } catch (error) {
      console.error('❌ Data type test failed:', error);
      uploadResults.push({
        testName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }, 180000); // 3 minute timeout for multiple uploads

  test('Storage service statistics', async () => {
    const testName = 'Storage Statistics';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      const stats = storageService.getStats();
      
      console.log('📊 Storage Service Statistics:');
      console.log('  Network:', stats.network);
      console.log('  Upload Relay:', stats.useUploadRelay);
      console.log('  Epochs:', stats.epochs);
      console.log('  Has Encryption:', stats.hasEncryption);
      console.log('  Has Batching:', stats.hasBatching);

      expect(stats).toHaveProperty('network');
      expect(stats).toHaveProperty('useUploadRelay');
      expect(stats.network).toBe('testnet');
      expect(stats.useUploadRelay).toBe(true);

      uploadResults.push({
        testName,
        success: true,
        stats
      });

    } catch (error) {
      console.error('❌ Statistics retrieval failed:', error);
      uploadResults.push({
        testName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  });
});