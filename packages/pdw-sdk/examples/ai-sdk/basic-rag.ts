/**
 * Basic RAG Example with Vercel AI SDK + PDW
 *
 * This example demonstrates how to use PDW as a vector store
 * with Vercel AI SDK for a simple RAG (Retrieval-Augmented Generation) flow.
 *
 * Features demonstrated:
 * - Store embeddings from AI SDK to Walrus
 * - Register on Sui blockchain
 * - Vector similarity search
 * - Use retrieved context with AI generation
 */

import { embed, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { PDWVectorStore } from 'personal-data-wallet-sdk/ai-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import 'dotenv/config';

async function main() {
  console.log('🚀 PDW + AI SDK Basic RAG Example\n');

  // 1. Setup: Initialize PDW Vector Store
  console.log('📦 Initializing PDW Vector Store...');

  const keypair = Ed25519Keypair.fromSecretKey(
    process.env.SUI_PRIVATE_KEY!
  );

  const vectorStore = new PDWVectorStore({
    walrus: {
      aggregator: process.env.WALRUS_AGGREGATOR!,
      publisher: process.env.WALRUS_PUBLISHER,
    },
    sui: {
      network: 'testnet',
      packageId: process.env.PACKAGE_ID!,
    },
    signer: keypair,
    userAddress: keypair.toSuiAddress(),
    dimensions: 1536, // OpenAI text-embedding-3-small
    features: {
      encryption: false, // Optional SEAL encryption
      extractKnowledgeGraph: false, // Optional graph extraction
    },
  });

  console.log('✅ Vector store initialized\n');

  // 2. Store some documents with embeddings
  console.log('📝 Storing documents...');

  const documents = [
    {
      id: 'doc-1',
      text: 'React hooks let you use state and other React features in function components.',
    },
    {
      id: 'doc-2',
      text: 'Next.js is a React framework that enables server-side rendering and static site generation.',
    },
    {
      id: 'doc-3',
      text: 'TypeScript adds static types to JavaScript, improving code quality and developer experience.',
    },
  ];

  for (const doc of documents) {
    console.log(`  → Storing: ${doc.text.substring(0, 50)}...`);

    // Generate embedding with AI SDK
    const { embedding } = await embed({
      model: openai.embedding('text-embedding-3-small'),
      value: doc.text,
    });

    // Store to PDW (Walrus + Sui + HNSW)
    const result = await vectorStore.add({
      id: doc.id,
      vector: embedding,
      text: doc.text,
      metadata: {
        category: 'documentation',
        source: 'example',
      },
    });

    console.log(`    ✓ Stored as blob: ${result.blobId.substring(0, 16)}...`);
  }

  console.log('\n✅ All documents stored\n');

  // 3. Query: Ask a question
  console.log('🔍 Querying: "How do I use state in React?"\n');

  // Generate query embedding
  const { embedding: queryEmbedding } = await embed({
    model: openai.embedding('text-embedding-3-small'),
    value: 'How do I use state in React?',
  });

  // Search PDW for relevant documents
  const searchResults = await vectorStore.search({
    vector: queryEmbedding,
    limit: 2,
  });

  console.log(`📊 Found ${searchResults.length} relevant documents:`);
  searchResults.forEach((result, i) => {
    console.log(`\n  ${i + 1}. Score: ${result.score.toFixed(4)}`);
    console.log(`     Text: ${result.text.substring(0, 80)}...`);
  });

  // 4. Generate: Use retrieved context with AI
  console.log('\n🤖 Generating answer with context...\n');

  const context = searchResults.map(r => r.text).join('\n\n');

  const { text: answer } = await generateText({
    model: openai('gpt-4-turbo'),
    prompt: `
Context from documentation:
${context}

Question: How do I use state in React?

Please answer based on the context provided.
    `.trim(),
  });

  console.log('💬 Answer:');
  console.log(`   ${answer}\n`);

  // 5. Stats
  console.log('📊 Vector Store Stats:');
  const stats = await vectorStore.stats();
  console.log(`   Total vectors: ${stats.totalVectors}`);
  console.log(`   Dimensions: ${stats.index.dimensions}`);
  console.log(`   Distance metric: ${stats.index.distanceMetric}`);

  console.log('\n✨ Example completed!');
}

main().catch(console.error);
