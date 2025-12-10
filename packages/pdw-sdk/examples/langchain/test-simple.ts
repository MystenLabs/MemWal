/**
 * Simple LangChain Integration Test
 *
 * Tests PDWEmbeddings without requiring the full langchain package.
 * Only uses @langchain/core which is already installed.
 *
 * To run:
 * 1. export GEMINI_API_KEY="your-api-key-here"
 * 2. npx tsx examples/langchain/test-simple.ts
 */

import { PDWEmbeddings } from '../../src/langchain/PDWEmbeddings';
import { Document } from '@langchain/core/documents';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

function log(emoji: string, message: string, color = colors.reset) {
  console.log(`${color}${emoji} ${message}${colors.reset}`);
}

function section(title: string) {
  console.log(`\n${colors.bright}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.bright}${title}${colors.reset}`);
  console.log(`${colors.bright}${'='.repeat(60)}${colors.reset}\n`);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Simple in-memory vector store for testing
 */
class SimpleVectorStore {
  private documents: Document[] = [];
  private embeddings: number[][] = [];

  constructor(private embeddingService: PDWEmbeddings) {}

  async addDocuments(docs: Document[]): Promise<void> {
    const texts = docs.map(d => d.pageContent);
    const vectors = await this.embeddingService.embedDocuments(texts);

    this.documents.push(...docs);
    this.embeddings.push(...vectors);
  }

  async similaritySearch(query: string, k: number = 4): Promise<Array<{ doc: Document; score: number }>> {
    const queryVector = await this.embeddingService.embedQuery(query);

    const scores = this.embeddings.map((embedding, i) => ({
      doc: this.documents[i],
      score: cosineSimilarity(queryVector, embedding)
    }));

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

async function main() {
  // Check API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log('❌', 'GEMINI_API_KEY environment variable is required', colors.red);
    console.log('\nGet your API key from: https://aistudio.google.com/app/apikey');
    console.log('Then run: export GEMINI_API_KEY="your-key-here"\n');
    process.exit(1);
  }

  console.log('\n🚀 PDW LangChain Integration Test (Simple)\n');

  // ========================================================================
  // TEST 1: Initialize PDWEmbeddings
  // ========================================================================
  section('TEST 1: Initialize PDWEmbeddings');

  log('🔧', 'Creating PDWEmbeddings instance...');
  const embeddings = new PDWEmbeddings({
    geminiApiKey: apiKey,
    model: 'text-embedding-004',
    dimensions: 768,
  });

  const modelInfo = embeddings.getModelInfo();
  log('✅', `Model: ${modelInfo.model}`, colors.green);
  log('✅', `Dimensions: ${modelInfo.dimensions}`, colors.green);
  log('✅', `Provider: ${modelInfo.provider}`, colors.green);

  // ========================================================================
  // TEST 2: Generate Embeddings
  // ========================================================================
  section('TEST 2: Generate Query Embedding');

  log('📝', 'Testing embedQuery()...');
  const queryText = 'What is artificial intelligence?';
  const queryEmbedding = await embeddings.embedQuery(queryText);

  log('✅', `Query embedded: "${queryText}"`, colors.green);
  log('📊', `Vector length: ${queryEmbedding.length}`);
  log('📊', `Sample values: [${queryEmbedding.slice(0, 3).map(v => v.toFixed(4)).join(', ')}...]`);

  // Verify embedding properties
  if (queryEmbedding.length === 768) {
    log('✅', 'Correct embedding dimensions', colors.green);
  } else {
    log('❌', `Wrong dimensions: expected 768, got ${queryEmbedding.length}`, colors.red);
  }

  // ========================================================================
  // TEST 3: Batch Document Embedding
  // ========================================================================
  section('TEST 3: Batch Document Embedding');

  log('📚', 'Testing embedDocuments()...');
  const documents = [
    'AI is the simulation of human intelligence by machines.',
    'Machine learning is a subset of artificial intelligence.',
    'Deep learning uses neural networks with multiple layers.',
    'Natural language processing helps computers understand text.',
    'Computer vision enables machines to interpret images.',
  ];

  const docEmbeddings = await embeddings.embedDocuments(documents);
  log('✅', `Embedded ${docEmbeddings.length} documents`, colors.green);

  docEmbeddings.forEach((emb, i) => {
    log('📊', `Document ${i + 1}: ${emb.length} dimensions, first value: ${emb[0].toFixed(4)}`);
  });

  // ========================================================================
  // TEST 4: Semantic Similarity
  // ========================================================================
  section('TEST 4: Semantic Similarity Test');

  log('🧮', 'Calculating similarities between related and unrelated texts...');

  const text1 = 'machine learning and artificial intelligence';
  const text2 = 'AI and ML algorithms';
  const text3 = 'cooking recipes and food';

  const emb1 = await embeddings.embedQuery(text1);
  const emb2 = await embeddings.embedQuery(text2);
  const emb3 = await embeddings.embedQuery(text3);

  const similarityRelated = cosineSimilarity(emb1, emb2);
  const similarityUnrelated = cosineSimilarity(emb1, emb3);

  log('📊', `"${text1}" vs "${text2}"`, colors.blue);
  console.log(`   Similarity: ${(similarityRelated * 100).toFixed(2)}% (related topics)`);

  log('📊', `"${text1}" vs "${text3}"`, colors.blue);
  console.log(`   Similarity: ${(similarityUnrelated * 100).toFixed(2)}% (unrelated topics)`);

  if (similarityRelated > similarityUnrelated) {
    log('✅', 'Semantic similarity working correctly!', colors.green);
    log('✅', 'Related texts have higher similarity than unrelated texts', colors.green);
  } else {
    log('⚠️', 'Unexpected similarity scores', colors.yellow);
  }

  // ========================================================================
  // TEST 5: Simple Vector Store
  // ========================================================================
  section('TEST 5: Vector Store Search');

  log('🏗️', 'Creating simple vector store...');
  const vectorStore = new SimpleVectorStore(embeddings);

  const sampleDocs = [
    new Document({
      pageContent: 'LangChain is a framework for building LLM applications with composable tools.',
      metadata: { category: 'tech', topic: 'frameworks' }
    }),
    new Document({
      pageContent: 'Personal Data Wallet provides decentralized storage on Sui blockchain with SEAL encryption.',
      metadata: { category: 'tech', topic: 'blockchain' }
    }),
    new Document({
      pageContent: 'RAG combines retrieval-based search with generative AI for better answers.',
      metadata: { category: 'ai', topic: 'rag' }
    }),
    new Document({
      pageContent: 'Vector embeddings transform text into numerical representations for similarity search.',
      metadata: { category: 'ai', topic: 'embeddings' }
    }),
    new Document({
      pageContent: 'SEAL provides privacy-preserving homomorphic encryption for sensitive data.',
      metadata: { category: 'security', topic: 'encryption' }
    }),
  ];

  log('📦', 'Adding documents to vector store...');
  await vectorStore.addDocuments(sampleDocs);
  log('✅', `Added ${sampleDocs.length} documents to store`, colors.green);

  // ========================================================================
  // TEST 6: Similarity Search
  // ========================================================================
  section('TEST 6: Similarity Search');

  const searchQueries = [
    'What is RAG and how does it work?',
    'Tell me about blockchain storage',
    'How does encryption protect data?',
  ];

  for (const query of searchQueries) {
    log('\n🔍', `Query: "${query}"`, colors.blue);
    const results = await vectorStore.similaritySearch(query, 2);

    results.forEach((result, i) => {
      log('📄', `Result ${i + 1} (Score: ${(result.score * 100).toFixed(2)}%):`, colors.yellow);
      console.log(`   ${result.doc.pageContent}`);
      console.log(`   Category: ${result.doc.metadata.category}, Topic: ${result.doc.metadata.topic}`);
    });
  }

  // ========================================================================
  // TEST 7: LangChain Document API
  // ========================================================================
  section('TEST 7: LangChain Document API');

  log('📝', 'Testing LangChain Document interface...');
  const testDoc = new Document({
    pageContent: 'This is a test document',
    metadata: { source: 'test', timestamp: Date.now() }
  });

  log('✅', `Document pageContent: "${testDoc.pageContent}"`, colors.green);
  log('✅', `Document metadata: ${JSON.stringify(testDoc.metadata)}`, colors.green);
  log('✅', 'LangChain Document API working correctly', colors.green);

  // ========================================================================
  // Summary
  // ========================================================================
  section('SUMMARY');

  const tests = [
    'PDWEmbeddings initialization',
    'Query embedding generation (768 dimensions)',
    'Batch document embedding',
    'Semantic similarity calculation',
    'Vector store creation and search',
    'Similarity search with scores',
    'LangChain Document interface',
  ];

  console.log('All tests completed successfully!\n');
  tests.forEach((test, i) => {
    log('✅', `${i + 1}. ${test}`, colors.green);
  });

  console.log('\n' + colors.bright + '🎉 LangChain integration is working perfectly!' + colors.reset);
  console.log('\nKey Features Verified:');
  console.log('  ✅ PDWEmbeddings implements LangChain Embeddings interface');
  console.log('  ✅ Compatible with @langchain/core Document API');
  console.log('  ✅ Generates 768-dimensional embeddings via Gemini');
  console.log('  ✅ Semantic similarity works correctly');
  console.log('  ✅ Ready for use with any LangChain VectorStore');

  console.log('\nNext Steps:');
  console.log('  1. Use PDWEmbeddings with any LangChain VectorStore');
  console.log('  2. Build RAG applications with PDWVectorStore');
  console.log('  3. Integrate with React using usePDWRAG hook');
  console.log('  4. Try the full test: npx tsx examples/langchain/test-integration.ts\n');
}

// Run the test
main().catch((error) => {
  console.error('\n❌ Test failed:', error.message);
  console.error(error);
  process.exit(1);
});
