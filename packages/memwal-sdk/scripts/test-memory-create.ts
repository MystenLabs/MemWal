/**
 * Test script to create a memory and print detailed output
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SimplePDWClient } from '../src/client/SimplePDWClient';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  console.log('='.repeat(60));
  console.log('Memory Create Test');
  console.log('='.repeat(60));

  // Validate environment
  const suiPrivateKey = process.env.SUI_PRIVATE_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const packageId = process.env.PACKAGE_ID;

  if (!suiPrivateKey || !geminiApiKey || !packageId) {
    console.error('Missing required environment variables:');
    console.error('  SUI_PRIVATE_KEY:', suiPrivateKey ? '✓' : '✗');
    console.error('  GEMINI_API_KEY:', geminiApiKey ? '✓' : '✗');
    console.error('  PACKAGE_ID:', packageId ? '✓' : '✗');
    process.exit(1);
  }

  console.log('\n📋 Configuration:');
  console.log('  Package ID:', packageId);
  console.log('  Network: testnet');

  // Create keypair
  const { secretKey } = decodeSuiPrivateKey(suiPrivateKey);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const walletAddress = keypair.getPublicKey().toSuiAddress();
  console.log('  Wallet Address:', walletAddress);

  // Initialize SimplePDWClient
  console.log('\n🔧 Initializing SimplePDWClient...');
  const pdw = new SimplePDWClient({
    signer: keypair,
    network: 'testnet',
    geminiApiKey: geminiApiKey,
    sui: {
      packageId: packageId
    },
    features: {
      enableEncryption: false,
      enableLocalIndexing: true,
      enableKnowledgeGraph: true
    }
  });

  await pdw.ready();
  console.log('✅ SimplePDWClient initialized');

  // Create memory
  const content = 'I am working at CommandOSS';
  console.log('\n📝 Creating memory:');
  console.log('  Content:', content);

  try {
    const memory = await pdw.memory.create(content, {
      category: 'fact',
      importance: 8,
      topic: 'work',
      metadata: {
        company: 'CommandOSS',
        type: 'employment'
      },
      onProgress: (stage, percent) => {
        console.log(`  [${percent}%] ${stage}`);
      }
    });

    console.log('\n' + '='.repeat(60));
    console.log('✅ Memory Created Successfully!');
    console.log('='.repeat(60));
    console.log('\n📦 Memory Object:');
    console.log(JSON.stringify(memory, null, 2));

    console.log('\n📊 Summary:');
    console.log('  Memory ID (on-chain):', memory.id);
    console.log('  Blob ID (Walrus):', memory.blobId);
    console.log('  Vector ID:', memory.vectorId);
    console.log('  Category:', memory.category);
    console.log('  Importance:', memory.importance);
    console.log('  Topic:', memory.topic);
    console.log('  Encrypted:', memory.encrypted);
    console.log('  Created At:', new Date(memory.createdAt).toISOString());

    if (memory.embedding) {
      console.log('  Embedding:');
      console.log('    Dimensions:', memory.embedding.length);
      console.log('    First 5 values:', memory.embedding.slice(0, 5));
    }

    // Verify by listing memories
    console.log('\n🔍 Verifying by listing memories...');
    const memories = await pdw.memory.list({ limit: 5 });
    console.log(`  Found ${memories.length} memories`);

    const found = memories.find(m => m.blobId === memory.blobId || m.id === memory.id);
    if (found) {
      console.log('  ✅ Memory found in list!');
      console.log('    ID:', found.id);
      console.log('    Category:', found.category);
    } else {
      console.log('  ⚠️ Memory not found in list (may need time to sync)');
    }

    // Test vector search
    console.log('\n🔎 Testing vector search for "CommandOSS"...');
    const searchResults = await pdw.search.vector('CommandOSS', { limit: 3 });
    console.log(`  Found ${searchResults.length} results`);
    searchResults.forEach((r, i) => {
      console.log(`  [${i + 1}] Score: ${r.score.toFixed(4)}, ID: ${r.id}`);
    });

  } catch (error: any) {
    console.error('\n❌ Error creating memory:');
    console.error('  Message:', error.message);
    if (error.stack) {
      console.error('  Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
    }
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Test completed successfully!');
  console.log('='.repeat(60));
}

main().catch(console.error);
