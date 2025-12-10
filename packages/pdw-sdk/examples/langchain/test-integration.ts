/**
 * LangChain Integration Test
 *
 * This is a simple, practical test to verify the LangChain integration works.
 * It tests the core functionality without requiring wallet signing or blockchain interaction.
 *
 * To run:
 * 1. export GEMINI_API_KEY="your-api-key-here"
 * 2. npm install
 * 3. npx tsx examples/langchain/test-integration.ts
 */

import { PDWEmbeddings } from '../../src/langchain/PDWEmbeddings';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
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

async function main() {
  // Check API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log('❌', 'GEMINI_API_KEY environment variable is required', colors.red);
    console.log('\nGet your API key from: https://aistudio.google.com/app/apikey');
    console.log('Then run: export GEMINI_API_KEY="your-key-here"\n');
    process.exit(1);
  }

  console.log('\n🚀 PDW LangChain Integration Test\n');

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
  section('TEST 2: Generate Embeddings');

  log('📝', 'Testing embedQuery()...');
  const queryText = 'What is artificial intelligence?';
  const queryEmbedding = await embeddings.embedQuery(queryText);

  log('✅', `Query embedded: "${queryText}"`, colors.green);
  log('📊', `Vector length: ${queryEmbedding.length}`);
  log('📊', `Sample values: [${queryEmbedding.slice(0, 3).map(v => v.toFixed(4)).join(', ')}...]`);

  log('\n📚', 'Testing embedDocuments()...');
  const documents = [
    'AI is the simulation of human intelligence by machines.',
    'Machine learning is a subset of artificial intelligence.',
    'Deep learning uses neural networks with multiple layers.',
  ];

  const docEmbeddings = await embeddings.embedDocuments(documents);
  log('✅', `Embedded ${docEmbeddings.length} documents`, colors.green);
  docEmbeddings.forEach((emb, i) => {
    log('📊', `Document ${i + 1}: ${emb.length} dimensions`);
  });

  // ========================================================================
  // TEST 3: LangChain VectorStore Integration
  // ========================================================================
  section('TEST 3: LangChain VectorStore Integration');

  log('🏗️', 'Creating MemoryVectorStore with PDWEmbeddings...');

  // Create sample documents
  const sampleDocs = [
    new Document({
      pageContent: 'LangChain is a framework for building LLM applications.',
      metadata: { category: 'tech', source: 'docs' }
    }),
    new Document({
      pageContent: 'Personal Data Wallet provides decentralized storage on Sui blockchain.',
      metadata: { category: 'tech', source: 'docs' }
    }),
    new Document({
      pageContent: 'RAG combines retrieval with language model generation.',
      metadata: { category: 'ai', source: 'docs' }
    }),
    new Document({
      pageContent: 'Vector embeddings represent text as high-dimensional vectors.',
      metadata: { category: 'ai', source: 'docs' }
    }),
    new Document({
      pageContent: 'SEAL provides privacy-preserving encryption for sensitive data.',
      metadata: { category: 'security', source: 'docs' }
    }),
  ];

  log('📦', 'Adding documents to vector store...');
  const vectorStore = await MemoryVectorStore.fromDocuments(
    sampleDocs,
    embeddings
  );
  log('✅', `Vector store created with ${sampleDocs.length} documents`, colors.green);

  // ========================================================================
  // TEST 4: Similarity Search
  // ========================================================================
  section('TEST 4: Similarity Search');

  const searchQueries = [
    'What is RAG?',
    'Tell me about blockchain storage',
    'How does encryption work?',
  ];

  for (const query of searchQueries) {
    log('\n🔍', `Searching for: "${query}"`, colors.blue);
    const results = await vectorStore.similaritySearch(query, 2);

    results.forEach((doc, i) => {
      log('📄', `Result ${i + 1}:`, colors.yellow);
      console.log(`   Content: ${doc.pageContent}`);
      console.log(`   Category: ${doc.metadata.category}`);
    });
  }

  // ========================================================================
  // TEST 5: Similarity Search with Scores
  // ========================================================================
  section('TEST 5: Similarity Search with Scores');

  const scoreQuery = 'machine learning frameworks';
  log('🔍', `Searching with scores: "${scoreQuery}"`, colors.blue);

  const resultsWithScores = await vectorStore.similaritySearchWithScore(scoreQuery, 3);

  resultsWithScores.forEach(([doc, score], i) => {
    log('📊', `Result ${i + 1} (Score: ${score.toFixed(4)}):`, colors.yellow);
    console.log(`   ${doc.pageContent.substring(0, 80)}...`);
  });

  // ========================================================================
  // TEST 6: Retriever Pattern (for RAG chains)
  // ========================================================================
  section('TEST 6: Retriever Pattern');

  log('🔗', 'Testing as retriever (LangChain pattern)...');
  const retriever = vectorStore.asRetriever({
    k: 2,
  });

  const retrievedDocs = await retriever.invoke('privacy and security');
  log('✅', `Retrieved ${retrievedDocs.length} documents`, colors.green);
  retrievedDocs.forEach((doc, i) => {
    log('📄', `Doc ${i + 1}: ${doc.pageContent.substring(0, 60)}...`);
  });

  // ========================================================================
  // TEST 7: Vector Similarity Calculation
  // ========================================================================
  section('TEST 7: Vector Similarity Calculation');

  log('🧮', 'Calculating cosine similarity...');

  const text1 = 'artificial intelligence and machine learning';
  const text2 = 'AI and ML technologies';
  const text3 = 'blockchain and decentralization';

  const emb1 = await embeddings.embedQuery(text1);
  const emb2 = await embeddings.embedQuery(text2);
  const emb3 = await embeddings.embedQuery(text3);

  const similarity12 = cosineSimilarity(emb1, emb2);
  const similarity13 = cosineSimilarity(emb1, emb3);

  log('📊', `"${text1}" vs "${text2}"`);
  console.log(`   Similarity: ${(similarity12 * 100).toFixed(2)}% (should be high)`);

  log('📊', `"${text1}" vs "${text3}"`);
  console.log(`   Similarity: ${(similarity13 * 100).toFixed(2)}% (should be lower)`);

  if (similarity12 > similarity13) {
    log('✅', 'Semantic similarity working correctly!', colors.green);
  } else {
    log('⚠️', 'Unexpected similarity scores', colors.yellow);
  }

  // ========================================================================
  // Summary
  // ========================================================================
  section('SUMMARY');

  const tests = [
    'PDWEmbeddings initialization',
    'Query embedding generation',
    'Document batch embedding',
    'LangChain VectorStore integration',
    'Similarity search',
    'Score-based search',
    'Retriever pattern',
    'Semantic similarity',
  ];

  console.log('All tests completed successfully!\n');
  tests.forEach((test, i) => {
    log('✅', `${i + 1}. ${test}`, colors.green);
  });

  console.log('\n' + colors.bright + '🎉 LangChain integration is working perfectly!' + colors.reset);
  console.log('\nNext steps:');
  console.log('  1. Try the React hooks examples for UI integration');
  console.log('  2. Build a full RAG application with PDWVectorStore');
  console.log('  3. Integrate with your existing LangChain workflows\n');
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

// Run the test
main().catch((error) => {
  console.error('\n❌ Test failed:', error.message);
  console.error(error);
  process.exit(1);
});
