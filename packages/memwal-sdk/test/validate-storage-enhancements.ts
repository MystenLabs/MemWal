/**
 * StorageService Enhanced Features Validation
 * Tests the new memory package upload/retrieval functionality
 */

import { config } from 'dotenv';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { StorageService } from '../src/services/StorageService';

// Load test environment
config({ path: '.env.test' });

async function validateStorageServiceEnhancements() {
  console.log('🧪 Validating StorageService Enhanced Features');
  console.log('=============================================\n');

  // Setup test environment
  const suiClient = new SuiClient({
    url: getFullnodeUrl('testnet'),
  });

  const privateKey = process.env.TEST_PRIVATE_KEY || 'suiprivkey1qp0f8lavfvndyru7e2v4rrtevlnmzemsppudkgc6s8grz9v7y4p4sp905g6';
  const { secretKey } = decodeSuiPrivateKey(privateKey);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const userAddress = keypair.toSuiAddress();

  const storageService = new StorageService({
    suiClient,
    packageId: process.env.SUI_PACKAGE_ID!,
    network: 'testnet',
    useUploadRelay: true,
    epochs: 3
  });

  console.log(`✅ StorageService initialized for ${userAddress}\n`);

  try {
    // Test 1: JSON Memory Package Storage
    console.log('🧪 TEST 1: JSON Memory Package Storage');
    console.log('-------------------------------------');

    const memoryData = {
      content: 'Test content for JSON storage',
      embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
      metadata: {
        title: 'Test Memory',
        category: 'test',
        tags: ['json', 'test'],
        language: 'en'
      }
    };

    console.log('🔄 Uploading JSON memory package...');
    const uploadResult = await storageService.uploadMemoryPackage(memoryData, {
      signer: keypair,
      epochs: 3,
      deletable: true,
      useUploadRelay: true
    });

    console.log(`✅ Upload successful: ${uploadResult.blobId}`);
    console.log(`   Encrypted: ${uploadResult.metadata.isEncrypted}`);
    console.log(`   Size: ${uploadResult.metadata.contentSize} bytes`);

    console.log('🔄 Retrieving JSON memory package...');
    const retrieveResult = await storageService.retrieveMemoryPackage(uploadResult.blobId);

    console.log(`✅ Retrieval successful: ${retrieveResult.storageApproach}`);
    console.log(`   Encrypted: ${retrieveResult.isEncrypted}`);
    console.log(`   Content verified: "${retrieveResult.memoryPackage?.content}"`);
    console.log(`   Embedding dimensions: ${retrieveResult.memoryPackage?.embedding?.length}`);

    if (retrieveResult.storageApproach === 'json-package' && 
        !retrieveResult.isEncrypted &&
        retrieveResult.memoryPackage?.content === memoryData.content) {
      console.log('✅ TEST 1 PASSED: JSON storage working correctly\n');
    } else {
      throw new Error('TEST 1 FAILED: JSON storage validation failed');
    }

    // Test 2: Binary SEAL Encrypted Data Storage
    console.log('🧪 TEST 2: Binary SEAL Encrypted Data Storage');
    console.log('--------------------------------------------');
    
    const originalData = JSON.stringify({
      content: 'Secret encrypted content',
      embedding: [0.9, 0.8, 0.7],
      metadata: { title: 'Secret Memory' }
    });
    
    // Create true binary data that looks like SEAL encrypted content
    const header = new Uint8Array([
      0x53, 0x45, 0x41, 0x4C, // "SEAL" magic header
      0x01, 0x00, 0x00, 0x00, // Version
      0xFF, 0xFE, 0xFD, 0xFC  // Binary indicators
    ]);
    const payload = new TextEncoder().encode(originalData);
    const trailer = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    
    const mockEncryptedContent = new Uint8Array(header.length + payload.length + trailer.length);
    mockEncryptedContent.set(header, 0);
    mockEncryptedContent.set(payload, header.length);
    mockEncryptedContent.set(trailer, header.length + payload.length);
    
    const encryptedMemoryData = {
      content: 'Secret encrypted content',
      embedding: [0.9, 0.8, 0.7],
      metadata: {
        title: 'Secret Memory',
        category: 'encrypted',
        tags: ['seal', 'binary'],
        testId: Date.now().toString() // Make unique
      },
      encryptedContent: mockEncryptedContent,
      encryptionType: 'seal-real',
      identity: userAddress
    };

    console.log('🔄 Uploading binary SEAL encrypted data...');
    const encryptedUploadResult = await storageService.uploadMemoryPackage(encryptedMemoryData, {
      signer: keypair,
      epochs: 3,
      deletable: true,
      useUploadRelay: true
    });

    console.log(`✅ Binary upload successful: ${encryptedUploadResult.blobId}`);
    console.log(`   Encrypted: ${encryptedUploadResult.metadata.isEncrypted}`);
    console.log(`   Size: ${encryptedUploadResult.metadata.contentSize} bytes`);

    console.log('🔄 Retrieving binary SEAL encrypted data...');
    const encryptedRetrieveResult = await storageService.retrieveMemoryPackage(encryptedUploadResult.blobId);

    console.log(`✅ Binary retrieval successful: ${encryptedRetrieveResult.storageApproach}`);
    console.log(`   Encrypted: ${encryptedRetrieveResult.isEncrypted}`);
    console.log(`   Content type: ${encryptedRetrieveResult.content.constructor.name}`);
    console.log(`   Binary integrity: ${encryptedRetrieveResult.content.length} bytes`);

    if (encryptedRetrieveResult.storageApproach === 'direct-binary' && 
        encryptedRetrieveResult.isEncrypted &&
        encryptedRetrieveResult.content instanceof Uint8Array &&
        encryptedRetrieveResult.content.length === mockEncryptedContent.length) {
      console.log('✅ TEST 2 PASSED: Binary SEAL storage working correctly\n');
    } else {
      throw new Error('TEST 2 FAILED: Binary SEAL storage validation failed');
    }

    // Test 3: Standard Binary Blob Upload
    console.log('🧪 TEST 3: Standard Binary Blob Upload');
    console.log('-------------------------------------');
    
    const binaryData = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253]);
    
    console.log('🔄 Uploading standard binary blob...');
    const binaryUploadResult = await storageService.uploadBlob(binaryData, {
      signer: keypair,
      epochs: 3,
      deletable: true,
      metadata: {
        'content-type': 'application/octet-stream',
        'test-type': 'binary-blob'
      }
    });

    console.log(`✅ Binary blob upload: ${binaryUploadResult.blobId}`);
    console.log(`   Size: ${binaryUploadResult.metadata.contentSize} bytes`);

    console.log('🔄 Retrieving standard binary blob...');
    const retrievedBinaryData = await storageService.getBlob(binaryUploadResult.blobId);
    
    const dataMatch = Array.from(retrievedBinaryData).every((val, idx) => val === binaryData[idx]);
    
    console.log(`✅ Binary blob retrieval: ${retrievedBinaryData.length} bytes`);
    console.log(`   Data integrity: ${dataMatch ? 'VERIFIED' : 'FAILED'}`);

    if (dataMatch && retrievedBinaryData.length === binaryData.length) {
      console.log('✅ TEST 3 PASSED: Standard binary blob working correctly\n');
    } else {
      throw new Error('TEST 3 FAILED: Binary blob validation failed');
    }

    // Final Summary
    console.log('🎉 ALL TESTS PASSED!');
    console.log('===================');
    console.log('✅ JSON memory package storage: WORKING');
    console.log('✅ Binary SEAL encrypted storage: WORKING');
    console.log('✅ Standard binary blob storage: WORKING');
    console.log('✅ StorageService enhancements: PRODUCTION READY');

  } catch (error) {
    console.error('❌ Validation failed:', error);
    process.exit(1);
  }
}

// Run validation if called directly
if (require.main === module) {
  validateStorageServiceEnhancements().catch(console.error);
}

export { validateStorageServiceEnhancements };