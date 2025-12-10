/**
 * REAL DEMONSTRATION: Multiple File Upload with Metadata Management
 *
 * This example demonstrates actual batch upload to Walrus with real services:
 * - Real AI metadata extraction with Gemini
 * - Real embedding generation
 * - Real SEAL encryption
 * - Real Walrus Quilt upload with transaction signing
 *
 * Prerequisites:
 * - .env.test file with GOOGLE_AI_API_KEY, TEST_PRIVATE_KEY, etc.
 * - SUI tokens in TEST_USER_ADDRESS for gas fees
 * - WAL tokens for Walrus storage epochs
 *
 * Run: npx tsx examples/multiple-file-upload-demo-real.ts
 */

import { StorageService } from '../src/services/StorageService';
import { EmbeddingService } from '../src/services/EmbeddingService';
import { EncryptionService } from '../src/services/EncryptionService';
import { GeminiAIService } from '../src/services/GeminiAIService';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.test' });

// Validate required environment variables
const requiredEnvVars = [
  'GOOGLE_AI_API_KEY',
  'TEST_PRIVATE_KEY',
  'TEST_USER_ADDRESS',
  'PACKAGE_ID',
  'ACCESS_REGISTRY_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    console.error('   Please check your .env.test file');
    process.exit(1);
  }
}

// ==================== REAL BATCH UPLOAD ====================

async function realBatchUpload() {
  console.log('\n' + '='.repeat(80));
  console.log('🚀 REAL BATCH UPLOAD WITH ACTUAL SERVICES');
  console.log('='.repeat(80) + '\n');

  // Initialize Sui client
  const suiRpcUrl = process.env.SUI_RPC_URL || getFullnodeUrl('testnet');
  const suiClient = new SuiClient({ url: suiRpcUrl });

  // Create keypair from private key (Sui bech32 format: suiprivkey1...)
  const keypair = Ed25519Keypair.fromSecretKey(process.env.TEST_PRIVATE_KEY!);
  const userAddress = process.env.TEST_USER_ADDRESS!;

  console.log(`👤 User Address: ${userAddress}`);
  console.log(`🌐 Network: testnet`);
  console.log(`📦 Package ID: ${process.env.PACKAGE_ID}\n`);

  // Check balance
  try {
    const balance = await suiClient.getBalance({ owner: userAddress });
    console.log(`💰 SUI Balance: ${(parseInt(balance.totalBalance) / 1e9).toFixed(4)} SUI\n`);
  } catch (error) {
    console.warn('⚠️  Could not fetch balance:', error);
  }

  // Initialize all services
  console.log('🔧 Initializing services...\n');

  const walrusNetwork = (process.env.WALRUS_NETWORK || 'testnet') as 'testnet' | 'mainnet';
  const walrusAggregatorUrl = walrusNetwork === 'mainnet'
    ? 'https://aggregator.walrus.space'
    : 'https://aggregator.walrus-testnet.walrus.space';

  const storageService = new StorageService({
    packageId: process.env.PACKAGE_ID!,
    walrusAggregatorUrl,
    network: walrusNetwork
  });
  console.log('  ✅ StorageService initialized');

  const embeddingService = new EmbeddingService({
    apiKey: process.env.GOOGLE_AI_API_KEY!,
    model: 'text-embedding-004',
    dimensions: 768
  });
  console.log('  ✅ EmbeddingService initialized');

  const encryptionService = new EncryptionService(
    suiClient,
    {
      packageId: process.env.PACKAGE_ID!,
      accessRegistryId: process.env.ACCESS_REGISTRY_ID!
    }
  );
  console.log('  ✅ EncryptionService initialized');

  const geminiAIService = new GeminiAIService({
    apiKey: process.env.GOOGLE_AI_API_KEY!,
    model: 'gemini-2.0-flash-exp',
    temperature: 0.1
  });
  console.log('  ✅ GeminiAIService initialized\n');

  // ========== STEP 1: Prepare Multiple Memories ==========

  const memoriesToUpload = [
    {
      content: 'Met with the team to discuss Q4 roadmap. Focus on AI features and blockchain integration.',
      category: 'work'
    },
    {
      content: 'Completed a 10km run in 55 minutes. New personal best! Feeling great about fitness progress.',
      category: 'health'
    },
    {
      content: 'Read chapter 5 of "Deep Learning" by Goodfellow. Detailed notes on Convolutional Neural Networks.',
      category: 'education'
    }
  ];

  console.log('📝 STEP 1: Preparing Memories');
  console.log('─'.repeat(80));
  console.log(`Memories to upload: ${memoriesToUpload.length}\n`);

  for (let i = 0; i < memoriesToUpload.length; i++) {
    console.log(`[${i + 1}] ${memoriesToUpload[i].content.substring(0, 60)}...`);
  }
  console.log();

  // ========== STEP 2: AI Metadata Extraction (Batch) ==========

  console.log('🤖 STEP 2: AI Metadata Extraction (Batch)');
  console.log('─'.repeat(80));
  console.log('Extracting rich metadata using Gemini AI...\n');

  const startMetadata = Date.now();
  const metadataArray = await geminiAIService.extractRichMetadataBatch(memoriesToUpload);
  const metadataTime = Date.now() - startMetadata;

  console.log(`✅ Metadata extracted in ${metadataTime}ms\n`);

  for (let i = 0; i < metadataArray.length; i++) {
    console.log(`[${i + 1}] ${metadataArray[i].topic}`);
    console.log(`    Importance: ${metadataArray[i].importance}/10`);
    console.log(`    Category: ${metadataArray[i].category}`);
    console.log(`    Summary: ${metadataArray[i].summary.substring(0, 80)}...`);
    console.log();
  }

  // ========== STEP 3: Process Each Memory ==========

  console.log('⚙️  STEP 3: Processing Each Memory');
  console.log('─'.repeat(80));

  const processedMemories = [];
  let totalEmbeddingTime = 0;
  let totalEncryptionTime = 0;

  for (let i = 0; i < memoriesToUpload.length; i++) {
    const memory = memoriesToUpload[i];
    const metadata = metadataArray[i];

    console.log(`\n[Memory ${i + 1}/${memoriesToUpload.length}] Processing...`);

    // 3a. Generate embedding
    const startEmbed = Date.now();
    const embeddingResult = await embeddingService.embedText({
      text: memory.content,
      taskType: 'RETRIEVAL_DOCUMENT'
    });
    const embedTime = Date.now() - startEmbed;
    totalEmbeddingTime += embedTime;
    console.log(`  🔢 Embedding generated (${embedTime}ms) - 768D vector`);

    // 3b. Encrypt content
    const startEncrypt = Date.now();
    const encryptionResult = await encryptionService.encrypt(
      new TextEncoder().encode(memory.content),
      userAddress
    );
    const encryptTime = Date.now() - startEncrypt;
    totalEncryptionTime += encryptTime;
    console.log(`  🔐 Content encrypted (${encryptTime}ms) - ${encryptionResult.encryptedObject.length} bytes`);

    processedMemories.push({
      content: memory.content,
      category: metadata.category,
      importance: metadata.importance,
      topic: metadata.topic,
      embedding: embeddingResult.vector,
      encryptedContent: encryptionResult.encryptedObject,
      summary: metadata.summary
    });
  }

  console.log(`\n✅ All memories processed!`);
  console.log(`   Total embedding time: ${totalEmbeddingTime}ms`);
  console.log(`   Total encryption time: ${totalEncryptionTime}ms\n`);

  // ========== STEP 4: Upload to Walrus Quilt ==========

  console.log('📦 STEP 4: Uploading to Walrus Quilt');
  console.log('─'.repeat(80));
  console.log('Creating batch upload transaction...\n');

  console.log('Uploading to Walrus...\n');

  const startUpload = Date.now();

  // Pass the keypair directly - Ed25519Keypair implements the Signer interface
  const uploadResult = await storageService.uploadMemoryBatch(
    processedMemories,
    {
      signer: keypair,
      epochs: 5,
      userAddress: userAddress
    }
  );
  const uploadTime = Date.now() - startUpload;

  // ========== STEP 5: Display Results ==========

  console.log('\n' + '='.repeat(80));
  console.log('🎉 BATCH UPLOAD COMPLETE!');
  console.log('='.repeat(80));
  console.log();
  console.log(`📊 Results:`);
  console.log(`   Quilt ID:          ${uploadResult.quiltId}`);
  console.log(`   Files Uploaded:    ${uploadResult.files.length}`);
  console.log(`   Memories Created:  ${processedMemories.length}`);
  console.log();
  console.log(`⏱️  Performance:`);
  console.log(`   AI Metadata:       ${metadataTime}ms (batch)`);
  console.log(`   Embeddings:        ${totalEmbeddingTime}ms (${(totalEmbeddingTime / memoriesToUpload.length).toFixed(0)}ms avg)`);
  console.log(`   Encryption:        ${totalEncryptionTime}ms (${(totalEncryptionTime / memoriesToUpload.length).toFixed(0)}ms avg)`);
  console.log(`   Walrus Upload:     ${uploadTime}ms`);
  console.log(`   Total:             ${metadataTime + totalEmbeddingTime + totalEncryptionTime + uploadTime}ms`);
  console.log();
  console.log(`💰 Gas Savings:`);
  console.log(`   Individual uploads:  ${memoriesToUpload.length} transactions`);
  console.log(`   Batch upload:        1 transaction`);
  console.log(`   Savings:             ~${((1 - 1/memoriesToUpload.length) * 100).toFixed(0)}%`);
  console.log();
  console.log(`📦 Files in Quilt:`);

  for (let i = 0; i < uploadResult.files.length; i++) {
    console.log(`   [${i + 1}] Blob ID: ${uploadResult.files[i].blobId}`);
    console.log(`       Identifier: ${uploadResult.files[i].identifier || 'N/A'}`);
  }

  console.log();
  console.log('='.repeat(80));
  console.log();
  console.log('✅ You can now retrieve these files using:');
  console.log(`   - Quilt ID: ${uploadResult.quiltId}`);
  console.log(`   - Tag-based filtering (category, importance, topic)`);
  console.log(`   - Individual Blob IDs`);
  console.log();

  return uploadResult;
}

// ==================== MAIN EXECUTION ====================

async function main() {
  console.log('\n');
  console.log('╔' + '═'.repeat(78) + '╗');
  console.log('║' + ' '.repeat(78) + '║');
  console.log('║' + '  PERSONAL DATA WALLET SDK - REAL BATCH UPLOAD DEMONSTRATION'.padEnd(78) + '║');
  console.log('║' + ' '.repeat(78) + '║');
  console.log('╚' + '═'.repeat(78) + '╝');

  try {
    await realBatchUpload();

    console.log('\n' + '='.repeat(80));
    console.log('✅ DEMONSTRATION COMPLETE');
    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ ERROR DURING DEMONSTRATION');
    console.error('='.repeat(80));
    console.error();
    console.error('Error:', error.message);

    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }

    console.error();
    console.error('='.repeat(80) + '\n');

    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { realBatchUpload };
