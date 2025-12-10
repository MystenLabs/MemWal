/**
 * Test 04: Vector Indexing
 *
 * Tests vector indexing functionality:
 * - Create HNSW index
 * - Add vectors to index
 * - Search similar vectors
 * - Index statistics
 */

import { VectorManager, EmbeddingService } from '../../src';
import * as fs from 'fs';
import * as path from 'path';

async function testVectorIndex() {
  console.log('🧪 Test 04: Vector Indexing\n');
  console.log('='.repeat(50));

  try {
    // Initialize services
    console.log('\n1️⃣ Initializing services...');

    const embeddingService = new EmbeddingService({
      provider: 'google',
      modelName: 'text-embedding-004',
      dimensions: 768,
      apiKey: process.env.GEMINI_API_KEY,
    });

    // Create temp directory for index
    const indexPath = path.join(__dirname, '../../.tmp/test-index');
    if (!fs.existsSync(indexPath)) {
      fs.mkdirSync(indexPath, { recursive: true });
    }

    const vectorManager = new VectorManager({
      dimension: 768,
      maxElements: 1000,
      M: 16,
      efConstruction: 200,
      indexPath,
    });

    console.log('✅ Services initialized');
    console.log(`   - Vector dimension: 768`);
    console.log(`   - Index path: ${indexPath}`);

    // Test 1: Generate sample vectors
    console.log('\n2️⃣ Generating sample vectors...');
    const sampleTexts = [
      'Machine learning and artificial intelligence',
      'Deep learning neural networks',
      'Natural language processing and text analysis',
      'Computer vision and image recognition',
      'Blockchain and decentralized systems',
      'Cryptocurrency and digital assets',
      'Web development and frontend frameworks',
      'Backend systems and databases',
      'Cloud computing and serverless architecture',
      'DevOps and continuous integration',
    ];

    console.log(`   Generating embeddings for ${sampleTexts.length} texts...`);
    const batchResult = await embeddingService.embedBatch(sampleTexts);

    console.log('✅ Embeddings generated:');
    console.log(`   - Count: ${batchResult.vectors.length}`);
    console.log(`   - Dimensions: ${batchResult.dimension}`);
    console.log(`   - Average time: ${batchResult.averageProcessingTime.toFixed(2)}ms`);

    // Test 2: Add vectors to index
    console.log('\n3️⃣ Adding vectors to index...');
    const memoryIds: string[] = [];

    for (let i = 0; i < batchResult.vectors.length; i++) {
      const memoryId = `memory_${Date.now()}_${i}`;
      await vectorManager.addVector(
        batchResult.vectors[i],
        memoryId,
        { text: sampleTexts[i] }
      );
      memoryIds.push(memoryId);
    }

    console.log('✅ Vectors indexed:');
    console.log(`   - Total vectors: ${memoryIds.length}`);
    console.log(`   - Memory IDs: ${memoryIds.slice(0, 3).join(', ')}...`);

    // Test 3: Search similar vectors
    console.log('\n4️⃣ Searching for similar vectors...');

    const queryText = 'AI and machine learning technologies';
    console.log(`   Query: "${queryText}"`);

    const queryResult = await embeddingService.embedText({ text: queryText });
    const searchResults = await vectorManager.search(queryResult.vector, 5);

    console.log('✅ Search results:');
    searchResults.forEach((result, index) => {
      const metadata = result.metadata as { text?: string };
      console.log(`\n   ${index + 1}. Similarity: ${result.similarity.toFixed(4)}`);
      console.log(`      Distance: ${result.distance.toFixed(4)}`);
      console.log(`      Memory ID: ${result.memoryId}`);
      console.log(`      Text: "${metadata.text || 'N/A'}"`);
    });

    // Test 4: Multiple queries
    console.log('\n5️⃣ Testing multiple queries...');
    const queries = [
      'blockchain technology',
      'web development',
      'cloud services',
    ];

    for (const query of queries) {
      const qResult = await embeddingService.embedText({ text: query });
      const results = await vectorManager.search(qResult.vector, 3);
      const topResult = results[0];
      const topMetadata = topResult.metadata as { text?: string };

      console.log(`\n   Query: "${query}"`);
      console.log(`   Top match: "${topMetadata.text}"`);
      console.log(`   Similarity: ${topResult.similarity.toFixed(4)}`);
    }

    // Test 5: Index statistics
    console.log('\n6️⃣ Index statistics:');
    const stats = vectorManager.getStats();
    console.log('✅ Stats:');
    console.log(`   - Total vectors: ${stats.totalVectors}`);
    console.log(`   - Dimension: ${stats.dimension}`);
    console.log(`   - Index path: ${stats.indexPath || 'N/A'}`);

    // Save index
    console.log('\n7️⃣ Saving index to disk...');
    await vectorManager.saveIndex();
    console.log('✅ Index saved');

    console.log('\n' + '='.repeat(50));
    console.log('🎉 All vector indexing tests passed!');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run tests
testVectorIndex();
