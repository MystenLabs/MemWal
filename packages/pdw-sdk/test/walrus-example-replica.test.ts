/**
 * Test that replicates official Walrus SDK examples to validate our environment
 * Based on: https://github.com/MystenLabs/ts-sdks/tree/main/packages/walrus/examples/upload-relay/write-blob.ts
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { WalrusClient } from '@mysten/walrus';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';
import dotenv from 'dotenv';

// Load test environment
dotenv.config({ path: '.env.test' });

describe('Walrus SDK Example Replica', () => {
  let suiClient: SuiClient;
  let keypair: Ed25519Keypair;

  beforeAll(async () => {
    // Verify we have the private key from .env.test
    const privateKeyString = process.env.TEST_PRIVATE_KEY;
    if (!privateKeyString) {
      throw new Error('TEST_PRIVATE_KEY not found in .env.test');
    }

    // Create keypair from private key string
    keypair = Ed25519Keypair.fromSecretKey(privateKeyString);

    console.log('Test wallet address:', keypair.toSuiAddress());
  });

  test('should create Walrus client with upload relay like official examples', async () => {
    // Create client exactly like upload-relay/write-blob.ts example
    const client = new SuiClient({
      url: getFullnodeUrl('testnet'),
      network: 'testnet',
    }).$extend(
      WalrusClient.experimental_asClientExtension({
        uploadRelay: {
          host: 'https://upload-relay.testnet.walrus.space',
          sendTip: {
            max: 1_000,
          },
        },
      })
    );

    expect(client.walrus).toBeDefined();
    expect(typeof client.walrus.writeBlob).toBe('function');
  });

  test('should upload blob using upload relay pattern', async () => {
    // Set up client like the working examples
    const client = new SuiClient({
      url: getFullnodeUrl('testnet'),
      network: 'testnet',
    }).$extend(
      WalrusClient.experimental_asClientExtension({
        uploadRelay: {
          host: 'https://upload-relay.testnet.walrus.space',
          sendTip: {
            max: 1_000,
          },
        },
      })
    );

    // Test data
    const testContent = new TextEncoder().encode('Hello from PDW SDK Test!');

    try {
      const { blobId, blobObject } = await client.walrus.writeBlob({
        blob: testContent,
        deletable: true,
        epochs: 3,
        signer: keypair,
      });

      expect(blobId).toBeTruthy();
      expect(blobObject).toBeTruthy();
      expect(blobObject.id).toBeTruthy();

      console.log('Successfully uploaded blob:', {
        blobId,
        objectId: blobObject.id.id,
        size: testContent.length
      });

      // Try to read it back
      const retrievedContent = await client.walrus.readBlob({ blobId });
      expect(new Uint8Array(retrievedContent)).toEqual(testContent);

      console.log('Successfully retrieved blob content');

    } catch (error) {
      console.error('Upload failed:', error);
      throw error;
    }
  }, 120000); // 2 minute timeout for network operations

  test('should handle StorageService integration', async () => {
    const { StorageService } = await import('../src/services/StorageService');
    
    // Test our StorageService with proper configuration
    const storageService = new StorageService({
      packageId: process.env.PACKAGE_ID!,
      apiUrl: process.env.API_URL || 'http://localhost:3001/api',
      network: 'testnet',
    });

    expect(storageService).toBeDefined();
    
    // Test upload with our service
    const testContent = new TextEncoder().encode('StorageService test content');
    
    try {
      const result = await storageService.upload(testContent, {
        signer: keypair,
        tags: { test: 'true', source: 'sdk-test' }
      });

      expect(result.blobId).toBeTruthy();
      expect(result.metadata).toBeTruthy();
      expect(result.metadata.tags?.test).toBe('true');

      console.log('StorageService upload successful:', {
        blobId: result.blobId,
        size: result.metadata.size
      });

    } catch (error) {
      console.error('StorageService upload failed:', error);
      throw error;
    }
  }, 120000);
});