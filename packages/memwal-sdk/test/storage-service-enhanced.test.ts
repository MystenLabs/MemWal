/**
 * StorageService Enhanced Features Test
 * Tests the new memory package upload/retrieval functionality
 */

import { config } from 'dotenv';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { StorageService } from '../src/services/StorageService';

// Load test environment
config({ path: '.env.test' });

describe('StorageService Enhanced Features', () => {
  let storageService: StorageService;
  let keypair: Ed25519Keypair;
  let userAddress: string;

  beforeAll(async () => {
    // Setup test environment
    const suiClient = new SuiClient({
      url: getFullnodeUrl('testnet'),
    });

    const privateKey = process.env.TEST_PRIVATE_KEY || 'suiprivkey1qp0f8lavfvndyru7e2v4rrtevlnmzemsppudkgc6s8grz9v7y4p4sp905g6';
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    keypair = Ed25519Keypair.fromSecretKey(secretKey);
    userAddress = keypair.toSuiAddress();

    storageService = new StorageService({
      suiClient,
      packageId: process.env.SUI_PACKAGE_ID!,
      network: 'testnet',
      useUploadRelay: true,
      epochs: 3
    });
  });

  test('should upload and retrieve JSON memory package', async () => {
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

    console.log('🧪 Testing JSON memory package storage...');

    // Upload memory package
    const uploadResult = await storageService.uploadMemoryPackage(memoryData, {
      signer: keypair,
      epochs: 3,
      deletable: true,
      useUploadRelay: true
    });

    expect(uploadResult.blobId).toBeDefined();
    expect(uploadResult.metadata.isEncrypted).toBe(false);
    console.log(`✅ Upload successful: ${uploadResult.blobId}`);

    // Retrieve memory package
    const retrieveResult = await storageService.retrieveMemoryPackage(uploadResult.blobId);

    expect(retrieveResult.storageApproach).toBe('json-package');
    expect(retrieveResult.isEncrypted).toBe(false);
    expect(retrieveResult.memoryPackage).toBeDefined();
    expect(retrieveResult.memoryPackage.content).toBe(memoryData.content);
    expect(retrieveResult.memoryPackage.embedding).toEqual(memoryData.embedding);
    
    console.log(`✅ Retrieval successful: ${retrieveResult.storageApproach}`);
    console.log(`✅ Content verified: "${retrieveResult.memoryPackage.content}"`);
  }, 60000);

  test('should handle binary SEAL encrypted data storage', async () => {
    // Create mock SEAL encrypted data (Uint8Array)
    const originalData = JSON.stringify({
      content: 'Secret encrypted content',
      embedding: [0.9, 0.8, 0.7],
      metadata: { title: 'Secret Memory' }
    });
    
    const mockEncryptedContent = new TextEncoder().encode(originalData);
    
    const memoryData = {
      content: 'Secret encrypted content',
      embedding: [0.9, 0.8, 0.7],
      metadata: {
        title: 'Secret Memory',
        category: 'encrypted',
        tags: ['seal', 'binary']
      },
      encryptedContent: mockEncryptedContent,
      encryptionType: 'seal-real',
      identity: userAddress
    };

    console.log('🧪 Testing binary SEAL encrypted data storage...');

    // Upload memory package with encrypted content
    const uploadResult = await storageService.uploadMemoryPackage(memoryData, {
      signer: keypair,
      epochs: 3,
      deletable: true,
      useUploadRelay: true
    });

    expect(uploadResult.blobId).toBeDefined();
    expect(uploadResult.metadata.isEncrypted).toBe(true);
    console.log(`✅ Binary upload successful: ${uploadResult.blobId}`);

    // Retrieve memory package
    const retrieveResult = await storageService.retrieveMemoryPackage(uploadResult.blobId);

    expect(retrieveResult.storageApproach).toBe('direct-binary');
    expect(retrieveResult.isEncrypted).toBe(true);
    expect(retrieveResult.content).toBeInstanceOf(Uint8Array);
    expect(retrieveResult.content.length).toBe(mockEncryptedContent.length);
    
    // Verify binary content matches
    expect(Array.from(retrieveResult.content)).toEqual(Array.from(mockEncryptedContent));
    
    console.log(`✅ Binary retrieval successful: ${retrieveResult.storageApproach}`);
    console.log(`✅ Binary integrity verified: ${retrieveResult.content.length} bytes`);
  }, 60000);

  test('should use standard uploadBlob for direct binary data', async () => {
    const binaryData = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253]);
    
    console.log('🧪 Testing standard binary blob upload...');

    const uploadResult = await storageService.uploadBlob(binaryData, {
      signer: keypair,
      epochs: 3,
      deletable: true,
      metadata: {
        'content-type': 'application/octet-stream',
        'test-type': 'binary-blob'
      }
    });

    expect(uploadResult.blobId).toBeDefined();
    console.log(`✅ Binary blob upload: ${uploadResult.blobId}`);

    const retrievedData = await storageService.getBlob(uploadResult.blobId);
    expect(Array.from(retrievedData)).toEqual(Array.from(binaryData));
    
    console.log(`✅ Binary blob retrieval verified`);
  }, 60000);
});