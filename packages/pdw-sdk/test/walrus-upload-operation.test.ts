/**
 * Walrus Upload Operation Test
 * 
 * Tests the new StorageService with official Walrus SDK patterns:
 * - Upload relay support (preferred)
 * - Storage node fallback  
 * - writeBlobFlow() pattern
 * - w        console.log(`📝 Testing ${testCase.name}...`);
        const testData = new TextEncoder().encode(testCase.content);
        
        const result = await storageService.uploadBlob(testData, {
          signer,
          epochs: 3,
          deletable: true,
          useUploadRelay: true,
          metadata: {
            category: 'content-type-test',
            'content-type': testCase.contentType,
            'test-case': testCase.name
          }
        });

        console.log(`✅ ${testCase.name} uploaded: ${result.blobId}`);pattern
 * - Network configuration
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { StorageService } from '../src/services/StorageService';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import * as dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

describe('Walrus Upload Operation Tests', () => {
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
    
    // Verify wallet address matches expected
    if (testAddress !== process.env.TEST_USER_ADDRESS) {
      console.warn('⚠️  Wallet address mismatch - proceeding with actual address');
    }

    // Create StorageService with upload relay configuration
    storageService = new StorageService({
      packageId: process.env.SUI_PACKAGE_ID || '0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde',
      network: 'testnet',
      useUploadRelay: true, // Test upload relay (preferred)
      epochs: 3,
      timeout: 60000,
    });

    console.log('🚀 StorageService initialized with upload relay support');
    console.log('📦 Package ID:', process.env.SUI_PACKAGE_ID);
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

  test('Upload single blob with upload relay (preferred method)', async () => {
    const testName = 'Single Blob Upload (Upload Relay)';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      // Create test data
      const testContent = `Walrus test upload at ${new Date().toISOString()}`;
      const testData = new TextEncoder().encode(testContent);
      
      console.log('📝 Content:', testContent);
      console.log('📏 Size:', testData.length, 'bytes');
      
      // Test upload with relay (default behavior)
      const result = await storageService.uploadBlob(testData, {
        signer,
        epochs: 3,
        deletable: true,
        useUploadRelay: true,
        metadata: {
          category: 'test',
          topic: 'walrus-upload-test',
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
      
      // Don't fail the test immediately - let's see what type of error we get
      console.log('🔍 Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split('\\n').slice(0, 3) : 'No stack'
      });
      
      throw error;
    }
  }, 120000); // 2 minute timeout

  test('Upload single blob with storage nodes (fallback method)', async () => {
    const testName = 'Single Blob Upload (Storage Nodes)';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      // Create different test data
      const testContent = `Walrus storage node test at ${new Date().toISOString()}`;
      const testData = new TextEncoder().encode(testContent);
      
      console.log('📝 Content:', testContent);
      console.log('📏 Size:', testData.length, 'bytes');
      
      // Test upload without relay (direct to storage nodes)
      const result = await storageService.uploadBlob(testData, {
        signer,
        epochs: 3,
        deletable: true,
        useUploadRelay: false, // Test storage node fallback
        metadata: {
          category: 'test',
          topic: 'walrus-upload-test',
          'test-type': 'single-blob-storage-nodes'
        }
      });

      console.log('✅ Storage node upload successful!');
      console.log('🆔 Blob ID:', result.blobId);
      console.log('⏱️  Upload time:', result.uploadTimeMs, 'ms');

      expect(result).toHaveProperty('blobId');
      expect(result.blobId).toBeDefined();

      uploadResults.push({
        testName,
        success: true,
        blobId: result.blobId,
        uploadTimeMs: result.uploadTimeMs
      });

    } catch (error) {
      console.error('❌ Storage node upload failed:', error);
      uploadResults.push({
        testName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // This might fail due to SSL certificate issues mentioned in the guide
      console.log('ℹ️  Note: Storage node failures may be due to SSL certificate issues on testnet');
      throw error;
    }
  }, 120000);

  test('Upload blob with different content types', async () => {
    const testName = 'Different Content Types Upload';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      // Test different content types with writeBlobFlow
      const testCases = [
        {
          name: 'JSON data',
          content: JSON.stringify({ 
            message: 'Test JSON content', 
            timestamp: new Date().toISOString(),
            data: { numbers: [1, 2, 3], text: 'hello world' }
          }),
          contentType: 'application/json'
        },
        {
          name: 'Plain text',
          content: `This is a plain text test file.
Multiple lines of content.
Created at ${new Date().toISOString()}`,
          contentType: 'text/plain'
        }
      ];

      const results = [];
      
      for (const testCase of testCases) {
        console.log(\`� Testing \${testCase.name}...\`);
        const testData = new TextEncoder().encode(testCase.content);
        
        const result = await storageService.uploadBlob(testData, {
          signer,
          epochs: 3,
          deletable: true,
          useUploadRelay: true,
          metadata: {
            category: 'content-type-test',
            'content-type': testCase.contentType,
            'test-case': testCase.name
          }
        });

        console.log(\`✅ \${testCase.name} uploaded: \${result.blobId}\`);
        results.push({ testCase: testCase.name, blobId: result.blobId });
      }

      expect(results).toHaveLength(testCases.length);
      results.forEach(result => {
        expect(result.blobId).toBeDefined();
      });

      uploadResults.push({
        testName,
        success: true,
        testCases: results.length
      });

    } catch (error) {
      console.error('❌ Content type test failed:', error);
      uploadResults.push({
        testName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }, 120000);

  test('Retrieve uploaded blob', async () => {
    const testName = 'Blob Retrieval';
    console.log(`\\n🧪 Testing: ${testName}`);
    
    try {
      // First, upload a blob to retrieve
      const testContent = `Retrieval test content at ${new Date().toISOString()}`;
      const testData = new TextEncoder().encode(testContent);
      
      console.log('📤 Uploading test blob for retrieval...');
      const uploadResult = await storageService.uploadBlob(testData, {
        signer,
        epochs: 3,
        deletable: true,
        metadata: { 'test-type': 'retrieval-test' }
      });

      console.log('✅ Upload complete, blob ID:', uploadResult.blobId);
      
      // Now retrieve the blob
      console.log('📥 Retrieving blob...');
      const retrievedData = await storageService.getBlob(uploadResult.blobId);
      const retrievedContent = new TextDecoder().decode(retrievedData);
      
      console.log('✅ Retrieval successful!');
      console.log('📝 Original content:', testContent);
      console.log('📝 Retrieved content:', retrievedContent);
      console.log('🔍 Content match:', testContent === retrievedContent ? '✅' : '❌');

      // Verify content integrity
      expect(retrievedContent).toBe(testContent);
      expect(retrievedData).toEqual(testData);

      uploadResults.push({
        testName,
        success: true,
        blobId: uploadResult.blobId,
        contentMatch: testContent === retrievedContent
      });

    } catch (error) {
      console.error('❌ Blob retrieval failed:', error);
      uploadResults.push({
        testName,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }, 120000);

  test('Get storage service statistics', async () => {
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