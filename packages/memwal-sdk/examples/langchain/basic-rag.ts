/**
 * Complete RAG Example: Using PDWVectorStore with LangChain
 *
 * This example demonstrates:
 * 1. Creating a PDWVectorStore with decentralized storage
 * 2. Adding documents (memories) to the store
 * 3. Performing semantic search
 * 4. Building a simple RAG chain
 *
 * Requirements:
 * - GEMINI_API_KEY environment variable
 * - Sui wallet with testnet SUI tokens
 * - PDW contracts deployed on testnet
 *
 * To run:
 * 1. Set environment variables
 * 2. npm install
 * 3. tsx examples/langchain/basic-rag.ts
 */

import { PDWEmbeddings, PDWVectorStore } from '../../src/langchain';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

// Mock wallet for example (in real app, use @mysten/dapp-kit)
const mockWallet = {
  account: { address: '0x1234567890abcdef1234567890abcdef12345678' },
  signAndExecute: (params: any, callbacks: any) => {
    console.log('📝 Mock: Signing transaction...');
    // In real app, this would sign with user's wallet
    callbacks.onSuccess({ digest: 'mock-tx-digest' });
  },
  client: null as any, // Would be SuiClient in real app
};

async function main() {
  // Check for API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required');
    console.log('Get your API key from: https://aistudio.google.com/app/apikey');
    process.exit(1);
  }

  console.log('🚀 PDW LangChain RAG Example\n');

  // ============================================================================
  // STEP 1: Initialize PDWEmbeddings
  // ============================================================================
  console.log('📦 Step 1: Initializing PDWEmbeddings...');
  const embeddings = new PDWEmbeddings({
    geminiApiKey: apiKey,
    model: 'text-embedding-004',
    dimensions: 768
  });
  console.log('✅ PDWEmbeddings initialized');
  console.log();

  // ============================================================================
  // STEP 2: Initialize PDWVectorStore
  // ============================================================================
  console.log('📦 Step 2: Initializing PDWVectorStore...');
  const vectorStore = new PDWVectorStore(embeddings, {
    userAddress: mockWallet.account.address,
    packageId: '0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde',
    accessRegistryId: '0x1d0a1936e170e54ff12ef30a042b390a8ef6dae0febcdd62c970a87eebed8659',
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    geminiApiKey: apiKey,
    defaultCategory: 'example',
  });
  console.log('✅ PDWVectorStore initialized');
  console.log('   - Decentralized storage: Walrus testnet');
  console.log('   - Blockchain: Sui testnet');
  console.log('   - Vector search: HNSW (browser-compatible)');
  console.log();

  // ============================================================================
  // STEP 3: Add Documents (Create Memories)
  // ============================================================================
  console.log('📚 Step 3: Adding documents to vector store...');
  console.log('Note: In production, this requires real Sui wallet signing');
  console.log();

  const documents = [
    {
      pageContent: 'LangChain is a framework for developing applications powered by language models.',
      metadata: { category: 'tech', topic: 'LangChain overview' }
    },
    {
      pageContent: 'Personal Data Wallet provides decentralized storage with SEAL encryption on Sui blockchain.',
      metadata: { category: 'tech', topic: 'PDW features' }
    },
    {
      pageContent: 'RAG (Retrieval-Augmented Generation) combines vector search with LLM generation.',
      metadata: { category: 'tech', topic: 'RAG explanation' }
    }
  ];

  try {
    // Note: This will fail without real wallet, but shows the API
    console.log('Attempting to add documents (will use mock wallet)...');
    const blobIds = await vectorStore.addDocuments(documents, {
      account: mockWallet.account,
      signAndExecute: mockWallet.signAndExecute,
      client: mockWallet.client,
      onProgress: (status) => console.log(`   ${status}`)
    });
    console.log(`✅ Added ${blobIds.length} documents`);
    console.log(`   Blob IDs: ${blobIds.join(', ')}`);
  } catch (error) {
    console.log('⚠️  Mock wallet - document addition skipped in example');
    console.log('   In production: Documents would be stored on Walrus + Sui blockchain');
  }
  console.log();

  // ============================================================================
  // STEP 4: Semantic Search
  // ============================================================================
  console.log('🔍 Step 4: Performing semantic search...');
  const searchQuery = 'What is RAG?';
  console.log(`Query: "${searchQuery}"`);

  try {
    const searchResults = await vectorStore.similaritySearch(searchQuery, 3);
    console.log(`Found ${searchResults.length} results:`);
    searchResults.forEach((doc, i) => {
      console.log(`\n   ${i + 1}. ${doc.pageContent.substring(0, 80)}...`);
      console.log(`      Category: ${doc.metadata.category}`);
      console.log(`      Topic: ${doc.metadata.topic}`);
    });
  } catch (error) {
    console.log('⚠️  Search skipped (no documents in store yet)');
  }
  console.log();

  // ============================================================================
  // STEP 5: Build RAG Chain
  // ============================================================================
  console.log('🔗 Step 5: Building RAG chain...');

  // Create retriever from vector store
  const retriever = vectorStore.asRetriever({ k: 3 });

  // Create RAG prompt template
  const prompt = ChatPromptTemplate.fromTemplate(`
You are a helpful assistant with access to a knowledge base.
Use the following context to answer the question.

Context:
{context}

Question: {question}

Answer based on the context above:
  `);

  // Initialize LLM
  const llm = new ChatGoogleGenerativeAI({
    modelName: 'gemini-2.0-flash-exp',
    apiKey: apiKey,
  });

  // Build RAG chain
  const ragChain = RunnableSequence.from([
    {
      context: async (input: { question: string }) => {
        const docs = await retriever.invoke(input.question);
        return docs.map(d => d.pageContent).join('\n\n');
      },
      question: (input: { question: string }) => input.question
    },
    prompt,
    llm,
    new StringOutputParser()
  ]);

  console.log('✅ RAG chain created');
  console.log('   Pipeline: Retriever → Prompt → LLM → Parser');
  console.log();

  // ============================================================================
  // STEP 6: Query with RAG
  // ============================================================================
  console.log('💬 Step 6: Querying with RAG...');
  const question = 'What is Personal Data Wallet?';
  console.log(`Question: "${question}"`);
  console.log();

  try {
    console.log('Generating answer...');
    const answer = await ragChain.invoke({ question });
    console.log('Answer:');
    console.log(answer);
  } catch (error) {
    console.log('⚠️  RAG query skipped (requires documents in store)');
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log();

  // ============================================================================
  // STEP 7: Get Statistics
  // ============================================================================
  console.log('📊 Step 7: Vector store statistics...');
  try {
    const stats = await vectorStore.getStats();
    console.log('Stats:');
    console.log(`   Total memories: ${stats.totalMemories}`);
    console.log(`   User memories: ${stats.userMemories}`);
    console.log(`   Categories:`, stats.categories);
  } catch (error) {
    console.log('⚠️  Stats not available yet');
  }
  console.log();

  console.log('✅ Example completed successfully!');
  console.log();
  console.log('🎯 Next Steps:');
  console.log('   1. Use with real Sui wallet (@mysten/dapp-kit)');
  console.log('   2. Deploy to production with real contract IDs');
  console.log('   3. Build a full RAG application');
  console.log('   4. Integrate with existing LangChain chains');
}

// Run the example
main().catch(console.error);
