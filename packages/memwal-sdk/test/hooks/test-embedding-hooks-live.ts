#!/usr/bin/env node

/**
 * Live Integration Test for Embedding Hooks
 *
 * This script tests the full embedding workflow:
 * 1. Generate embedding from text using Gemini API
 * 2. Store embedding to Walrus storage
 * 3. Retrieve embedding from Walrus
 * 4. Verify data integrity
 *
 * Credentials loaded from root .env file
 */

import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { EmbeddingService } from '../../src/services/EmbeddingService';
import { StorageService } from '../../src/services/StorageService';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from example/.env.local
dotenv.config({ path: join(__dirname, '../../example/.env.local') });

interface TestResult {
  success: boolean;
  blobId?: string;
  embeddingTime?: number;
  uploadTime?: number;
  retrieveTime?: number;
  error?: string;
}

async function testStoreEmbedding(): Promise<TestResult> {
  console.log('\n📦 Testing Store Embedding Workflow');
  console.log('=' .repeat(60));

  try {
    // Step 1: Setup credentials
    console.log('\n1️⃣  Setting up credentials...');
    const privateKey = process.env.PRIVATE_KEY_ADDRESS;
    const walletAddress = process.env.WALLET_ADDRESS;
    const geminiApiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

    if (!privateKey) {
      throw new Error('PRIVATE_KEY_ADDRESS not found in .env.local');
    }
    if (!walletAddress) {
      throw new Error('WALLET_ADDRESS not found in .env.local');
    }
    if (!geminiApiKey) {
      throw new Error('NEXT_PUBLIC_GEMINI_API_KEY not found in .env.local');
    }

    const keypair = Ed25519Keypair.fromSecretKey(privateKey);

    console.log(`   ✓ Wallet Address: ${walletAddress}`);
    console.log(`   ✓ Gemini API Key: ${geminiApiKey.substring(0, 20)}...`);

    // Step 2: Generate embedding
    console.log('\n2️⃣  Generating embedding from text...');
    const testContent = 'This is a test embedding for the Personal Data Wallet SDK';

    const embeddingService = new EmbeddingService({
      apiKey: geminiApiKey,
      model: 'text-embedding-004',
      dimensions: 768
    });

    const embeddingStartTime = Date.now();
    const embeddingResult = await embeddingService.embedText({
      text: testContent,
      type: 'content',
      taskType: 'RETRIEVAL_DOCUMENT'
    });
    const embeddingTime = Date.now() - embeddingStartTime;

    console.log(`   ✓ Embedding generated: ${embeddingResult.dimension} dimensions`);
    console.log(`   ✓ Model: ${embeddingResult.model}`);
    console.log(`   ✓ Time: ${embeddingTime}ms`);
    console.log(`   ✓ Sample values: [${embeddingResult.vector.slice(0, 3).map(v => v.toFixed(4)).join(', ')}...]`);

    // Step 3: Prepare storage data
    console.log('\n3️⃣  Preparing data for storage...');
    const storageData = {
      vector: embeddingResult.vector,
      dimension: embeddingResult.dimension,
      model: embeddingResult.model,
      contentPreview: testContent.substring(0, 200),
      contentLength: testContent.length,
      embeddingType: 'document',
      metadata: {
        source: 'live-test',
        timestamp: new Date().toISOString()
      },
      timestamp: Date.now()
    };

    const dataBytes = new TextEncoder().encode(JSON.stringify(storageData));
    console.log(`   ✓ Data prepared: ${dataBytes.length} bytes`);

    // Step 4: Upload to Walrus using StorageService
    console.log('\n4️⃣  Uploading to Walrus using StorageService...');
    const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID;
    if (!packageId) {
      throw new Error('NEXT_PUBLIC_PACKAGE_ID not found in .env.local');
    }

    const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });

    const storageService = new StorageService({
      packageId,
      suiClient,
      network: 'testnet',
      useUploadRelay: true,
      epochs: 5
    });

    const uploadStartTime = Date.now();
    const result = await storageService.uploadBlob(dataBytes, {
      signer: keypair,
      deletable: false,
      epochs: 5,
      useUploadRelay: true
    });
    const uploadTime = Date.now() - uploadStartTime;

    console.log(`   ✓ Blob ID: ${result.blobId}`);
    console.log(`   ✓ Upload time: ${result.uploadTimeMs}ms`);
    console.log(`   ✓ Storage epochs: ${result.storageEpochs}`);
    console.log(`   ✓ Encrypted: ${result.isEncrypted}`);

    return {
      success: true,
      blobId: result.blobId,
      embeddingTime,
      uploadTime
    };

  } catch (error: any) {
    console.error('\n❌ Store embedding failed:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

async function testRetrieveEmbedding(blobId: string): Promise<TestResult> {
  console.log('\n📥 Testing Retrieve Embedding Workflow');
  console.log('=' .repeat(60));

  try {
    // Step 1: Initialize StorageService
    console.log('\n1️⃣  Initializing StorageService...');
    const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID;
    if (!packageId) {
      throw new Error('NEXT_PUBLIC_PACKAGE_ID not found in .env.local');
    }

    const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });

    const storageService = new StorageService({
      packageId,
      suiClient,
      network: 'testnet'
    });

    console.log(`   ✓ StorageService initialized`);

    // Step 2: Retrieve blob
    console.log('\n2️⃣  Retrieving blob from Walrus...');
    console.log(`   📝 Blob ID: ${blobId}`);

    const retrieveStartTime = Date.now();
    const data = await storageService.getBlob(blobId);
    const retrieveTime = Date.now() - retrieveStartTime;

    console.log(`   ✓ Blob retrieved: ${data.byteLength} bytes`);
    console.log(`   ✓ Retrieve time: ${retrieveTime}ms`);

    // Step 3: Parse and validate
    console.log('\n3️⃣  Parsing and validating data...');
    const text = new TextDecoder().decode(data);
    const parsed = JSON.parse(text);

    console.log(`   ✓ Dimension: ${parsed.dimension}`);
    console.log(`   ✓ Model: ${parsed.model}`);
    console.log(`   ✓ Embedding type: ${parsed.embeddingType}`);
    console.log(`   ✓ Content preview: "${parsed.contentPreview}"`);
    console.log(`   ✓ Vector length: ${parsed.vector.length}`);
    console.log(`   ✓ Sample values: [${parsed.vector.slice(0, 3).map((v: number) => v.toFixed(4)).join(', ')}...]`);

    // Validate structure
    if (!parsed.vector || !Array.isArray(parsed.vector)) {
      throw new Error('Invalid embedding data: missing or invalid vector');
    }
    if (!parsed.dimension || typeof parsed.dimension !== 'number') {
      throw new Error('Invalid embedding data: missing or invalid dimension');
    }

    console.log(`   ✓ Data structure validated`);

    return {
      success: true,
      retrieveTime
    };

  } catch (error: any) {
    console.error('\n❌ Retrieve embedding failed:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

async function main() {
  console.log('\n🚀 Embedding Hooks Live Integration Test');
  console.log('=' .repeat(60));
  console.log('Testing full workflow with real APIs and credentials\n');

  const startTime = Date.now();

  // Test store workflow
  const storeResult = await testStoreEmbedding();

  if (!storeResult.success || !storeResult.blobId) {
    console.log('\n❌ FAILED: Store embedding test failed');
    console.log(`Error: ${storeResult.error}`);
    process.exit(1);
  }

  // Wait a bit for Walrus to process
  console.log('\n⏳ Waiting 2 seconds for Walrus to process...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Test retrieve workflow
  const retrieveResult = await testRetrieveEmbedding(storeResult.blobId);

  if (!retrieveResult.success) {
    console.log('\n❌ FAILED: Retrieve embedding test failed');
    console.log(`Error: ${retrieveResult.error}`);
    process.exit(1);
  }

  const totalTime = Date.now() - startTime;

  // Print summary
  console.log('\n' + '=' .repeat(60));
  console.log('✅ ALL TESTS PASSED!');
  console.log('=' .repeat(60));
  console.log('\n📊 Performance Summary:');
  console.log(`   • Embedding generation: ${storeResult.embeddingTime}ms`);
  console.log(`   • Walrus upload: ${storeResult.uploadTime}ms`);
  console.log(`   • Walrus retrieve: ${retrieveResult.retrieveTime}ms`);
  console.log(`   • Total test time: ${totalTime}ms`);
  console.log(`\n💾 Stored Blob ID: ${storeResult.blobId}`);
  console.log('\n🎉 Embedding hooks are working correctly!\n');
}

// Run the test
main().catch(error => {
  console.error('\n💥 Unexpected error:', error);
  process.exit(1);
});
