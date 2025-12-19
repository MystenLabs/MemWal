/**
 * Basic Example: Using PDWEmbeddings with LangChain
 *
 * This example demonstrates how to use PDW's embedding service
 * with standard LangChain interfaces.
 *
 * To run:
 * 1. Set GEMINI_API_KEY environment variable
 * 2. npm install
 * 3. tsx examples/langchain/basic-embeddings.ts
 */

import { PDWEmbeddings } from '../../src/langchain/PDWEmbeddings';

async function main() {
  // Check for API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required');
    console.log('Get your API key from: https://aistudio.google.com/app/apikey');
    process.exit(1);
  }

  console.log('🚀 PDW LangChain Embeddings Example\n');

  // Initialize PDWEmbeddings
  console.log('Initializing PDWEmbeddings...');
  const embeddings = new PDWEmbeddings({
    geminiApiKey: apiKey,
    model: 'text-embedding-004',
    dimensions: 768
  });

  // Get model information
  const modelInfo = embeddings.getModelInfo();
  console.log('Model Info:', modelInfo);
  console.log();

  // Example 1: Embed a single query
  console.log('📝 Example 1: Embedding a single query');
  const query = 'What is the capital of France?';
  console.log(`Query: "${query}"`);

  const queryEmbedding = await embeddings.embedQuery(query);
  console.log(`Embedding dimensions: ${queryEmbedding.length}`);
  console.log(`First 5 values: [${queryEmbedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
  console.log();

  // Example 2: Embed multiple documents
  console.log('📚 Example 2: Embedding multiple documents');
  const documents = [
    'Paris is the capital of France.',
    'London is the capital of England.',
    'Berlin is the capital of Germany.'
  ];

  console.log(`Embedding ${documents.length} documents...`);
  const docEmbeddings = await embeddings.embedDocuments(documents);

  console.log(`Generated ${docEmbeddings.length} embeddings`);
  docEmbeddings.forEach((embedding, i) => {
    console.log(
      `  Doc ${i + 1}: ${embedding.length} dimensions, ` +
      `first 3 values: [${embedding.slice(0, 3).map(v => v.toFixed(4)).join(', ')}...]`
    );
  });
  console.log();

  // Example 3: Calculate similarity
  console.log('🔍 Example 3: Calculating similarity');
  const similarity = cosineSimilarity(queryEmbedding, docEmbeddings[0]);
  console.log(`Similarity between query and first document: ${(similarity * 100).toFixed(2)}%`);
  console.log();

  console.log('✅ Example completed successfully!');
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Run the example
main().catch(console.error);
