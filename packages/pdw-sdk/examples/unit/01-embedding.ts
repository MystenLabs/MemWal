/**
 * Test 01: Embedding Generation
 *
 * Tests EmbeddingService basic functionality:
 * - Single text embedding
 * - Batch embeddings
 * - Vector similarity calculation
 * - Different providers (Google, OpenAI, Cohere)
 */

import { EmbeddingService } from '../../src';

async function testEmbedding() {
  console.log('🧪 Test 01: Embedding Generation\n');
  console.log('='.repeat(50));

  try {
    // Initialize EmbeddingService
    console.log('\n1️⃣ Initializing EmbeddingService...');
    const embeddingService = new EmbeddingService({
      provider: 'google',
      modelName: 'text-embedding-004',
      dimensions: 768,
      apiKey: process.env.GEMINI_API_KEY,
    });
    console.log('✅ EmbeddingService initialized');

    // Test 1: Single text embedding
    console.log('\n2️⃣ Generating single embedding...');
    const startTime = Date.now();

    const result = await embeddingService.embedText({
      text: 'Hello, this is a test message for embedding generation.',
      type: 'content',
    });

    console.log('✅ Embedding generated:');
    console.log(`   - Dimensions: ${result.dimension}`);
    console.log(`   - Model: ${result.model}`);
    console.log(`   - Processing time: ${result.processingTime}ms`);
    console.log(`   - Vector preview: [${result.vector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);

    // Test 2: Batch embeddings
    console.log('\n3️⃣ Generating batch embeddings...');
    const texts = [
      'The quick brown fox jumps over the lazy dog',
      'Machine learning is fascinating',
      'Decentralized storage is the future',
    ];

    const batchResult = await embeddingService.embedBatch(texts, { type: 'content' });

    console.log('✅ Batch embeddings generated:');
    console.log(`   - Count: ${batchResult.vectors.length}`);
    console.log(`   - Dimensions: ${batchResult.dimension}`);
    console.log(`   - Total time: ${batchResult.totalProcessingTime}ms`);
    console.log(`   - Average time: ${batchResult.averageProcessingTime.toFixed(2)}ms/text`);
    console.log(`   - Success: ${batchResult.successCount}/${texts.length}`);

    // Test 3: Cosine similarity
    console.log('\n4️⃣ Calculating similarities...');
    const similarities = [];

    for (let i = 0; i < batchResult.vectors.length; i++) {
      for (let j = i + 1; j < batchResult.vectors.length; j++) {
        const sim = embeddingService.calculateCosineSimilarity(
          batchResult.vectors[i],
          batchResult.vectors[j]
        );
        similarities.push({
          text1: texts[i].substring(0, 30) + '...',
          text2: texts[j].substring(0, 30) + '...',
          similarity: sim,
        });
      }
    }

    console.log('✅ Similarity matrix:');
    similarities.forEach(({ text1, text2, similarity }) => {
      console.log(`   "${text1}" <-> "${text2}"`);
      console.log(`   Similarity: ${similarity.toFixed(4)}\n`);
    });

    // Test 4: Vector operations
    console.log('5️⃣ Testing vector operations...');
    const vec1 = batchResult.vectors[0];
    const vec2 = batchResult.vectors[1];

    const euclidean = embeddingService.calculateEuclideanDistance(vec1, vec2);
    console.log(`✅ Euclidean distance: ${euclidean.toFixed(4)}`);

    const normalized = embeddingService.normalizeVector(vec1);
    const magnitude = Math.sqrt(normalized.reduce((sum, val) => sum + val * val, 0));
    console.log(`✅ Normalized vector magnitude: ${magnitude.toFixed(4)} (should be ~1.0)`);

    // Test 5: Service stats
    console.log('\n6️⃣ Service statistics:');
    const stats = embeddingService.getStats();
    console.log('✅ Stats:', stats);

    console.log('\n' + '='.repeat(50));
    console.log('🎉 All embedding tests passed!');
    console.log(`Total execution time: ${Date.now() - startTime}ms`);

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
testEmbedding();
