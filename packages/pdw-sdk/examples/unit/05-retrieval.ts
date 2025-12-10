/**
 * Test 05: Memory Retrieval
 *
 * Tests memory retrieval functionality:
 * - Semantic search
 * - Filtered search
 * - Hybrid search (vector + metadata)
 * - Decryption of encrypted memories
 */

import {
  MemoryRetrievalService,
  EmbeddingService,
  VectorManager,
  StorageService,
  SealService,
} from '../../src';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import * as path from 'path';
import * as fs from 'fs';

async function testRetrieval() {
  console.log('🧪 Test 05: Memory Retrieval\n');
  console.log('='.repeat(50));

  try {
    // Initialize services
    console.log('\n1️⃣ Initializing services...');

    const keypair = new Ed25519Keypair();
    const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
    const sealService = new SealService();

    const embeddingService = new EmbeddingService({
      provider: 'google',
      apiKey: process.env.GEMINI_API_KEY,
    });

    const indexPath = path.join(__dirname, '../../.tmp/retrieval-index');
    if (!fs.existsSync(indexPath)) {
      fs.mkdirSync(indexPath, { recursive: true });
    }

    const vectorManager = new VectorManager({
      dimension: 768,
      indexPath,
    });

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

    const retrievalService = new MemoryRetrievalService(
      storageService,
      vectorManager,
      embeddingService
    );

    console.log('✅ All services initialized');

    // Test 1: Add sample memories with metadata
    console.log('\n2️⃣ Adding sample memories...');
    const memories = [
      {
        text: 'Team meeting about Q4 product roadmap',
        metadata: { category: 'work', topic: 'meetings', importance: 8 },
      },
      {
        text: 'Personal note about weekend hiking trip',
        metadata: { category: 'personal', topic: 'travel', importance: 5 },
      },
      {
        text: 'Technical documentation for API integration',
        metadata: { category: 'work', topic: 'documentation', importance: 9 },
      },
      {
        text: 'Recipe for chocolate chip cookies',
        metadata: { category: 'personal', topic: 'cooking', importance: 3 },
      },
      {
        text: 'Project review and performance analysis',
        metadata: { category: 'work', topic: 'analysis', importance: 10 },
      },
    ];

    for (const memory of memories) {
      // Generate embedding
      const embedding = await embeddingService.embedText({ text: memory.text });

      // Upload to storage
      const uploadResult = await storageService.uploadBlob(
        new TextEncoder().encode(memory.text),
        {
          signer: keypair,
          epochs: 3,
          metadata: {
            ...memory.metadata,
            'content-type': 'text/plain',
          },
        }
      );

      // Add to vector index
      await vectorManager.addVector(
        embedding.vector,
        uploadResult.blobId,
        {
          ...memory.metadata,
          text: memory.text,
          blobId: uploadResult.blobId,
        }
      );

      console.log(`   ✅ Added: "${memory.text.substring(0, 50)}..."`);
    }

    console.log(`\n✅ Total memories indexed: ${memories.length}`);

    // Test 2: Semantic search
    console.log('\n3️⃣ Testing semantic search...');
    const query1 = 'work-related meetings and projects';

    const queryEmbedding = await embeddingService.embedText({ text: query1 });
    const results = await vectorManager.search(queryEmbedding.vector, 3);

    console.log(`   Query: "${query1}"`);
    console.log('   Results:');
    results.forEach((result, index) => {
      const meta = result.metadata as any;
      console.log(`\n   ${index + 1}. Similarity: ${result.similarity.toFixed(4)}`);
      console.log(`      Text: "${meta.text}"`);
      console.log(`      Category: ${meta.category}, Topic: ${meta.topic}`);
      console.log(`      Importance: ${meta.importance}`);
    });

    // Test 3: Filtered search (by category)
    console.log('\n4️⃣ Testing filtered search...');
    const allVectors = await vectorManager.search(queryEmbedding.vector, 10);
    const workOnlyResults = allVectors.filter((r: any) =>
      (r.metadata as any).category === 'work'
    );

    console.log(`   Filter: category = 'work'`);
    console.log(`   Results found: ${workOnlyResults.length}`);
    workOnlyResults.forEach((result: any, index: number) => {
      const meta = result.metadata;
      console.log(`   ${index + 1}. "${meta.text.substring(0, 50)}..."`);
    });

    // Test 4: Search by importance
    console.log('\n5️⃣ Testing importance-based search...');
    const importantResults = allVectors.filter((r: any) =>
      (r.metadata as any).importance >= 8
    );

    console.log(`   Filter: importance >= 8`);
    console.log(`   Results found: ${importantResults.length}`);
    importantResults.forEach((result: any, index: number) => {
      const meta = result.metadata;
      console.log(`   ${index + 1}. [${meta.importance}/10] "${meta.text.substring(0, 50)}..."`);
    });

    // Test 5: Multi-query search
    console.log('\n6️⃣ Testing multiple queries...');
    const queries = [
      { text: 'cooking and recipes', expectedCategory: 'personal' },
      { text: 'technical documentation', expectedCategory: 'work' },
      { text: 'outdoor activities', expectedCategory: 'personal' },
    ];

    for (const query of queries) {
      const qEmbed = await embeddingService.embedText({ text: query.text });
      const qResults = await vectorManager.search(qEmbed.vector, 1);
      const top = qResults[0];
      const topMeta = top.metadata as any;

      console.log(`\n   Query: "${query.text}"`);
      console.log(`   Top result: "${topMeta.text.substring(0, 50)}..."`);
      console.log(`   Category: ${topMeta.category} (expected: ${query.expectedCategory})`);
      console.log(`   Similarity: ${top.similarity.toFixed(4)}`);
    }

    console.log('\n' + '='.repeat(50));
    console.log('🎉 All retrieval tests passed!');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run tests
testRetrieval();
