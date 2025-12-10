import { StorageService } from '../src/services/StorageService';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { fromHex } from '@mysten/sui/utils';
import * as dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

describe('Debug Upload Operation', () => {
  let storageService: StorageService;
  let signer: Ed25519Keypair;
  let suiClient: SuiClient;

  beforeAll(() => {
    // Use the actual funded keypair from .env.test
    const privateKeyHex = process.env.TEST_PRIVATE_KEY;
    if (!privateKeyHex) {
      throw new Error('TEST_PRIVATE_KEY not found in .env.test');
    }
    
    // Import the keypair from the private key
    signer = Ed25519Keypair.fromSecretKey(privateKeyHex);
    
    // Verify this matches our expected address
    const expectedAddress = process.env.TEST_USER_ADDRESS;
    const actualAddress = signer.toSuiAddress();
    
    console.log('🔑 Expected address:', expectedAddress);
    console.log('🔑 Actual address:  ', actualAddress);
    
    if (actualAddress !== expectedAddress) {
      throw new Error(`Address mismatch! Expected: ${expectedAddress}, Got: ${actualAddress}`);
    }
    
    // Create SuiClient with testnet URL
    suiClient = new SuiClient({ 
      url: process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443' 
    });

    // Initialize StorageService with testnet config
    storageService = new StorageService({
      packageId: process.env.SUI_PACKAGE_ID || '0x123',
      apiUrl: 'https://test-api',
      suiClient,
      network: 'testnet',
      timeout: 30000,
    });
  });

  test('should debug WalrusClient writeBlob call', async () => {
    const testContent = new TextEncoder().encode('Hello Walrus Debug');
    
    try {
      console.log('🔍 Starting upload debug test...');
      console.log('📦 Content size:', testContent.length, 'bytes');
      console.log('🔑 Signer address:', signer.toSuiAddress());
      
      // Try the upload operation with correct interface
      const result = await storageService.upload(testContent, {
        tags: { debug: 'test' },
        provider: 'walrus',
        signer,
        epochs: 1,
      });
      
      console.log('✅ Upload successful:', result);
      console.log('📋 Result details:', {
        blobId: result.blobId,
        walrusUrl: result.walrusUrl,
        cached: result.cached,
        processingTimeMs: result.processingTimeMs
      });
      
      // Basic validation
      if (!result.blobId) {
        throw new Error('Upload result missing blobId');
      }
      
    } catch (error: any) {
      console.error('❌ Upload failed with error:');
      console.error('Error name:', error?.name);
      console.error('Error message:', error?.message);
      console.error('Error stack:', error?.stack);
      console.error('Full error:', error);
      
      // Check if it's a network error
      if (error?.message?.includes('fetch failed')) {
        console.log('🌐 This appears to be a network connectivity issue');
        console.log('📋 Troubleshooting steps:');
        console.log('  1. Check internet connection');
        console.log('  2. Verify Walrus testnet is accessible');
        console.log('  3. Check firewall/proxy settings');
        console.log('  4. Verify @mysten/walrus package version');
      }
      
      // Re-throw to fail the test with full error info
      throw error;
    }
  }, 45000);

  test('should check WalrusClient configuration', async () => {
    console.log('🔧 Checking WalrusClient configuration...');
    
    // Access private members for debugging (using any cast)
    const service = storageService as any;
    console.log('📦 WalrusClient config:', {
      hasWalrusClient: !!service.walrusClient,
      hasSuiClient: !!service.suiClient,
    });
    
    // Try to get Sui client info
    try {
      const nodeInfo = await suiClient.getRpcApiVersion();
      console.log('🌐 Sui RPC version:', nodeInfo);
    } catch (error: any) {
      console.error('❌ Failed to connect to Sui RPC:', error?.message);
    }
  });
});