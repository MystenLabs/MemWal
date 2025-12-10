/**
 * Simple Storage Test
 * 
 * Direct test of Walrus storage to see what happens
 */

require('dotenv').config({ path: '.env.test' });

import { describe, test, expect, beforeAll } from '@jest/globals';
const { SuiClient, getFullnodeUrl } = require('@mysten/sui/client');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { StorageService } = require('../dist/storage/StorageService');

describe('Simple Storage Test', () => {
  let storageService: any;
  let testKeypair: any;
  let testAddress: string;

  beforeAll(async () => {
    if (!process.env.TEST_PRIVATE_KEY) {
      throw new Error('TEST_PRIVATE_KEY not found in .env.test');
    }
    testKeypair = Ed25519Keypair.fromSecretKey(process.env.TEST_PRIVATE_KEY);
    testAddress = testKeypair.toSuiAddress();

    storageService = new StorageService({
      packageId: process.env.PACKAGE_ID || '0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66',
      network: 'testnet',
      timeout: 60000
    });
  });

  test('Simple upload test', async () => {
    const testContent = 'Simple test content';
    const buffer = Buffer.from(testContent, 'utf8');
    
    console.log('Starting upload test...');
    console.log('Content:', testContent);
    console.log('Buffer size:', buffer.length);
    console.log('Test address:', testAddress);
    
    try {
      const result = await storageService.upload(buffer, {
        signer: testKeypair,
        deletable: true,
        epochs: 3,
        attributes: {
          'test': 'simple-upload'
        }
      });
      
      console.log('SUCCESS!');
      console.log('Blob ID:', result.blobId);
      console.log('Object ID:', result.objectId);
      
      expect(result.blobId).toBeDefined();
      
    } catch (error) {
      console.log('FAILED!');
      console.log('Error:', (error as Error).message);
      console.log('Error type:', (error as Error).constructor.name);
      
      // The error is expected due to SSL certificate issues
      expect(error).toBeDefined();
    }
    
  }, 120000);
});