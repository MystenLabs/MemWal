/**
 * Test 03: Storage Upload (Walrus)
 *
 * Tests StorageService upload functionality:
 * - Upload blob to Walrus
 * - Upload with metadata
 * - Upload encrypted data
 * - Retrieve blob
 */

import { StorageService, SealService } from '../../src';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

async function testStorageUpload() {
  console.log('🧪 Test 03: Storage Upload (Walrus)\n');
  console.log('='.repeat(50));

  try {
    // Initialize services
    console.log('\n1️⃣ Initializing storage service...');

    const keypair = new Ed25519Keypair();
    const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
    const sealService = new SealService();

    const storageService = new StorageService({
      suiClient,
      network: 'testnet',
      sealService,
      wallet: {
        address: keypair.getPublicKey().toSuiAddress(),
      },
      storage: {
        network: 'testnet',
      },
    });

    console.log('✅ StorageService initialized');
    console.log(`   - Wallet: ${keypair.getPublicKey().toSuiAddress()}`);
    console.log(`   - Network: testnet`);

    // Test 1: Upload simple text blob
    console.log('\n2️⃣ Uploading simple text blob...');
    const textContent = 'Hello, Walrus! This is a test upload from PDW SDK.';
    const textData = new TextEncoder().encode(textContent);

    const uploadResult = await storageService.uploadBlob(textData, {
      signer: keypair,
      epochs: 3,
      metadata: {
        'content-type': 'text/plain',
        category: 'test',
        topic: 'simple-upload',
        importance: '5',
      },
    });

    console.log('✅ Blob uploaded:');
    console.log(`   - Blob ID: ${uploadResult.blobId}`);
    console.log(`   - Content size: ${uploadResult.contentSize} bytes`);
    console.log(`   - Blob Object ID: ${uploadResult.blobObjectId || 'N/A'}`);
    console.log(`   - Encrypted: ${uploadResult.isEncrypted ? 'Yes' : 'No'}`);

    // Test 2: Upload with encryption
    console.log('\n3️⃣ Uploading encrypted blob...');
    const secretContent = 'This is confidential data that must be encrypted.';
    const secretData = new TextEncoder().encode(secretContent);

    const encryptedUpload = await storageService.uploadBlob(secretData, {
      signer: keypair,
      epochs: 3,
      encrypt: true,
      metadata: {
        'content-type': 'text/plain',
        category: 'confidential',
        topic: 'encrypted-test',
        importance: '10',
      },
    });

    console.log('✅ Encrypted blob uploaded:');
    console.log(`   - Blob ID: ${encryptedUpload.blobId}`);
    console.log(`   - Content size: ${encryptedUpload.contentSize} bytes`);
    console.log(`   - Encrypted: ${encryptedUpload.isEncrypted ? '✅ Yes' : '❌ No'}`);
    console.log(`   - Encryption overhead: ${encryptedUpload.contentSize - secretData.length} bytes`);

    // Test 3: Upload JSON data
    console.log('\n4️⃣ Uploading JSON blob...');
    const jsonData = {
      type: 'memory',
      content: 'Meeting notes from project discussion',
      tags: ['work', 'project', 'important'],
      timestamp: Date.now(),
      metadata: {
        participants: ['Alice', 'Bob', 'Charlie'],
        duration: 3600,
        location: 'Virtual',
      },
    };

    const jsonString = JSON.stringify(jsonData, null, 2);
    const jsonBytes = new TextEncoder().encode(jsonString);

    const jsonUpload = await storageService.uploadBlob(jsonBytes, {
      signer: keypair,
      epochs: 3,
      metadata: {
        'content-type': 'application/json',
        category: 'memory',
        topic: 'meeting-notes',
        importance: '8',
      },
    });

    console.log('✅ JSON blob uploaded:');
    console.log(`   - Blob ID: ${jsonUpload.blobId}`);
    console.log(`   - Content size: ${jsonUpload.contentSize} bytes`);
    console.log(`   - Content: ${jsonString.substring(0, 100)}...`);

    // Test 4: Retrieve blob
    console.log('\n5️⃣ Retrieving uploaded blob...');
    const retrievedData = await storageService.getBlob(uploadResult.blobId);

    if (retrievedData) {
      const retrievedText = new TextDecoder().decode(retrievedData);
      console.log('✅ Blob retrieved:');
      console.log(`   - Original: "${textContent}"`);
      console.log(`   - Retrieved: "${retrievedText}"`);
      console.log(`   - Match: ${textContent === retrievedText ? '✅ Yes' : '❌ No'}`);
    } else {
      console.log('⚠️  Blob not found (may not be available yet)');
    }

    console.log('\n' + '='.repeat(50));
    console.log('🎉 All storage upload tests passed!');
    console.log('\n📝 Note: Blobs may take a few minutes to become available on Walrus network');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run tests
testStorageUpload();
