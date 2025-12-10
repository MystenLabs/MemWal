#!/usr/bin/env npx ts-node
/**
 * Setup Testnet Script
 *
 * Creates MemoryIndex on Sui testnet for E2E testing.
 * Run once before running E2E tests with memory/search functionality.
 *
 * Usage:
 *   npm run setup:testnet
 *
 * Required environment variables:
 *   - SUI_PRIVATE_KEY: Sui wallet private key (suiprivkey1... format)
 *   - PACKAGE_ID: Deployed Move contract package ID
 *
 * Optional:
 *   - WALRUS_UPLOAD_URL: Walrus upload relay URL (default: testnet)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const CONFIG = {
  suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
  packageId: process.env.PACKAGE_ID || '',
  walrusUploadUrl: process.env.WALRUS_UPLOAD_URL || 'https://publisher.walrus-testnet.walrus.space/v1/blobs',
  network: 'testnet' as const,
};

// Validate configuration
function validateConfig(): void {
  if (!CONFIG.suiPrivateKey) {
    throw new Error('SUI_PRIVATE_KEY environment variable is required');
  }
  if (!CONFIG.packageId) {
    throw new Error('PACKAGE_ID environment variable is required');
  }
  if (!CONFIG.suiPrivateKey.startsWith('suiprivkey1')) {
    throw new Error('SUI_PRIVATE_KEY must be in suiprivkey1... format');
  }
}

// Create keypair from private key
function createKeypair(): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(CONFIG.suiPrivateKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

// Upload content to Walrus and return blob ID
async function uploadToWalrus(content: string, description: string): Promise<string> {
  console.log(`  Uploading ${description} to Walrus...`);

  const response = await fetch(CONFIG.walrusUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: new TextEncoder().encode(content),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Walrus upload failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  // Handle different response formats
  let blobId: string;
  if (result.newlyCreated?.blobObject?.blobId) {
    blobId = result.newlyCreated.blobObject.blobId;
  } else if (result.alreadyCertified?.blobId) {
    blobId = result.alreadyCertified.blobId;
  } else if (result.blobId) {
    blobId = result.blobId;
  } else {
    console.log('  Walrus response:', JSON.stringify(result, null, 2));
    throw new Error('Could not extract blobId from Walrus response');
  }

  console.log(`  ✓ ${description} uploaded: ${blobId}`);
  return blobId;
}

// Create MemoryIndex on Sui blockchain
async function createMemoryIndex(
  client: SuiClient,
  keypair: Ed25519Keypair,
  indexBlobId: string,
  graphBlobId: string
): Promise<string> {
  console.log('  Creating MemoryIndex on Sui...');

  const tx = new Transaction();

  tx.moveCall({
    target: `${CONFIG.packageId}::memory::create_memory_index`,
    arguments: [
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(indexBlobId))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(graphBlobId))),
    ],
  });

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Transaction failed: ${JSON.stringify(result.effects?.status)}`);
  }

  // Find the created MemoryIndex object
  const createdObject = result.objectChanges?.find(
    (change) => change.type === 'created' && change.objectType?.includes('::memory::MemoryIndex')
  );

  if (!createdObject || createdObject.type !== 'created') {
    console.log('  Object changes:', JSON.stringify(result.objectChanges, null, 2));
    throw new Error('Could not find created MemoryIndex object');
  }

  const memoryIndexId = createdObject.objectId;
  console.log(`  ✓ MemoryIndex created: ${memoryIndexId}`);
  console.log(`  Transaction: ${result.digest}`);

  return memoryIndexId;
}

// Main setup function
async function setup(): Promise<void> {
  console.log('\n========================================');
  console.log('  PDW Testnet Setup');
  console.log('========================================\n');

  // Validate
  validateConfig();
  console.log('✓ Configuration validated\n');

  // Create keypair
  const keypair = createKeypair();
  const walletAddress = keypair.toSuiAddress();
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Package: ${CONFIG.packageId}\n`);

  // Create Sui client
  const client = new SuiClient({ url: getFullnodeUrl(CONFIG.network) });

  // Check wallet balance
  const balance = await client.getBalance({ owner: walletAddress });
  const suiBalance = Number(balance.totalBalance) / 1_000_000_000;
  console.log(`Balance: ${suiBalance.toFixed(4)} SUI\n`);

  if (suiBalance < 0.1) {
    console.log('⚠ Low balance. Get testnet SUI from: https://faucet.testnet.sui.io/');
  }

  // Check if MemoryIndex already exists
  console.log('Checking for existing MemoryIndex...');
  const existingObjects = await client.getOwnedObjects({
    owner: walletAddress,
    filter: {
      StructType: `${CONFIG.packageId}::memory::MemoryIndex`,
    },
  });

  if (existingObjects.data.length > 0) {
    const existingId = existingObjects.data[0].data?.objectId;
    console.log(`\n✓ MemoryIndex already exists: ${existingId}`);
    console.log('\nAdd this to your .env file:');
    console.log(`MEMORY_INDEX_ID=${existingId}`);
    console.log('\n========================================\n');
    return;
  }

  console.log('No existing MemoryIndex found. Creating new one...\n');

  // Step 1: Upload empty HNSW index to Walrus
  console.log('Step 1/3: Upload HNSW index placeholder');
  const emptyHnswContent = JSON.stringify({
    type: 'hnsw-index-placeholder',
    version: 1,
    created: new Date().toISOString(),
    note: 'Placeholder for HNSW index. Actual index is stored locally in IndexedDB.',
  });
  const indexBlobId = await uploadToWalrus(emptyHnswContent, 'HNSW index');

  // Step 2: Upload empty Knowledge Graph to Walrus
  console.log('\nStep 2/3: Upload Knowledge Graph placeholder');
  const emptyGraphContent = JSON.stringify({
    type: 'knowledge-graph',
    version: 1,
    created: new Date().toISOString(),
    nodes: [],
    edges: [],
  });
  const graphBlobId = await uploadToWalrus(emptyGraphContent, 'Knowledge Graph');

  // Step 3: Create MemoryIndex on Sui
  console.log('\nStep 3/3: Create MemoryIndex on Sui');
  const memoryIndexId = await createMemoryIndex(client, keypair, indexBlobId, graphBlobId);

  // Output results
  console.log('\n========================================');
  console.log('  Setup Complete!');
  console.log('========================================\n');
  console.log('Add this to your .env file:\n');
  console.log(`MEMORY_INDEX_ID=${memoryIndexId}`);
  console.log(`INDEX_BLOB_ID=${indexBlobId}`);
  console.log(`GRAPH_BLOB_ID=${graphBlobId}`);
  console.log('\nYou can now run E2E tests:');
  console.log('  npm run test:e2e\n');
}

// Run setup
setup().catch((error) => {
  console.error('\n❌ Setup failed:', error.message);
  if (error.stack) {
    console.error('\nStack trace:', error.stack);
  }
  process.exit(1);
});
