/**
 * COMPLETE LANGCHAIN INTEGRATION DEMO
 *
 * This demo demonstrates the full LangChain integration with Personal Data Wallet SDK:
 * - PDWEmbeddings: Google Gemini embeddings adapter
 * - PDWVectorStore: Decentralized vector store on Walrus/Sui
 * - createPDWRAG: One-function RAG setup
 *
 * Features demonstrated:
 * - Standard LangChain Embeddings interface
 * - VectorStore with similarity search
 * - RAG (Retrieval-Augmented Generation)
 * - Blockchain-backed memory storage
 * - SEAL encryption (optional)
 *
 * Prerequisites:
 * - .env.test with GOOGLE_AI_API_KEY, TEST_PRIVATE_KEY, TEST_USER_ADDRESS
 * - PACKAGE_ID, ACCESS_REGISTRY_ID
 * - SUI tokens for gas fees
 *
 * Run: npx tsx examples/langchain/complete-rag-demo.ts
 */

import { PDWEmbeddings, PDWVectorStore, createPDWRAG } from '../../src/langchain';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { Document } from '@langchain/core/documents';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.test' });

// Extract and validate environment variables
const GEMINI_API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY!;
const PRIVATE_KEY = process.env.PRIVATE_KEY_ADDRESS!;
const USER_ADDRESS = process.env.WALLET_ADDRESS!;
const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID!;
const ACCESS_REGISTRY_ID = process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID!;

if (!GEMINI_API_KEY || !PRIVATE_KEY || !USER_ADDRESS || !PACKAGE_ID || !ACCESS_REGISTRY_ID) {
  console.error('❌ Missing required environment variables in .env.test');
  console.error('   Need: NEXT_PUBLIC_GEMINI_API_KEY, PRIVATE_KEY_ADDRESS, WALLET_ADDRESS');
  console.error('   NEXT_PUBLIC_PACKAGE_ID, NEXT_PUBLIC_ACCESS_REGISTRY_ID');
  process.exit(1);
}

// ==================== DEMO 1: PDWEmbeddings ====================

async function demo1_Embeddings() {
  console.log('\n' + '='.repeat(80));
  console.log('📊 DEMO 1: PDWEmbeddings - LangChain Embeddings Interface');
  console.log('='.repeat(80) + '\n');

  // Initialize PDWEmbeddings (wraps Gemini)
  const embeddings = new PDWEmbeddings({
    geminiApiKey: GEMINI_API_KEY,
    model: 'text-embedding-004',
    dimensions: 768
  });

  console.log('✅ PDWEmbeddings initialized');
  console.log(`   Model: ${embeddings.getModelInfo().model}`);
  console.log(`   Dimensions: ${embeddings.getModelInfo().dimensions}`);
  console.log(`   Provider: ${embeddings.getModelInfo().provider}\n`);

  // 1. Embed a single query
  console.log('🔍 Test 1: Embed Single Query');
  const startQuery = Date.now();
  const queryVector = await embeddings.embedQuery('What is blockchain technology?');
  const queryTime = Date.now() - startQuery;

  console.log(`   ✅ Query embedded in ${queryTime}ms`);
  console.log(`   Vector length: ${queryVector.length}`);
  console.log(`   First 5 values: [${queryVector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]\n`);

  // 2. Embed multiple documents (batch)
  console.log('📚 Test 2: Embed Multiple Documents (Batch)');
  const documents = [
    'Personal Data Wallet uses Sui blockchain for ownership',
    'Walrus provides decentralized blob storage',
    'SEAL encryption ensures data privacy'
  ];

  const startBatch = Date.now();
  const docVectors = await embeddings.embedDocuments(documents);
  const batchTime = Date.now() - startBatch;

  console.log(`   ✅ ${documents.length} documents embedded in ${batchTime}ms`);
  console.log(`   Average time per doc: ${(batchTime / documents.length).toFixed(0)}ms`);
  console.log(`   Vectors shape: ${docVectors.length} x ${docVectors[0].length}\n`);

  return { embeddings, queryVector, docVectors };
}

// ==================== DEMO 2: PDWVectorStore ====================

async function demo2_VectorStore() {
  console.log('\n' + '='.repeat(80));
  console.log('🗄️  DEMO 2: PDWVectorStore - LangChain VectorStore Interface');
  console.log('='.repeat(80) + '\n');

  // Initialize Sui client and keypair
  const suiRpcUrl = process.env.SUI_RPC_URL || getFullnodeUrl('testnet');
  const suiClient = new SuiClient({ url: suiRpcUrl });
  const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
  const userAddress = USER_ADDRESS;

  console.log(`👤 User Address: ${userAddress}`);
  console.log(`🌐 Network: testnet\n`);

  // Check balance
  try {
    const balance = await suiClient.getBalance({ owner: userAddress });
    console.log(`💰 SUI Balance: ${(parseInt(balance.totalBalance) / 1e9).toFixed(4)} SUI\n`);
  } catch (error) {
    console.warn('⚠️  Could not fetch balance:', error);
  }

  // Initialize PDWEmbeddings
  const embeddings = new PDWEmbeddings({
    geminiApiKey: GEMINI_API_KEY,
    model: 'text-embedding-004',
    dimensions: 768
  });
  console.log('✅ PDWEmbeddings initialized');

  // Initialize PDWVectorStore
  const vectorStore = new PDWVectorStore(embeddings, {
    userAddress,
    packageId: PACKAGE_ID,
    accessRegistryId: ACCESS_REGISTRY_ID,
    geminiApiKey: GEMINI_API_KEY,
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    walrusNetwork: 'testnet',
    network: 'testnet',
    defaultCategory: 'knowledge',
    defaultImportance: 7
  });
  console.log('✅ PDWVectorStore initialized\n');

  // Prepare test documents
  const testDocuments = [
    new Document({
      pageContent: 'The Sui blockchain uses Move programming language for smart contracts.',
      metadata: { category: 'blockchain', topic: 'Sui', importance: 8 }
    }),
    new Document({
      pageContent: 'Walrus is a decentralized storage network built by Mysten Labs.',
      metadata: { category: 'storage', topic: 'Walrus', importance: 7 }
    }),
    new Document({
      pageContent: 'SEAL provides identity-based encryption with key recovery.',
      metadata: { category: 'security', topic: 'SEAL', importance: 9 }
    })
  ];

  console.log('📝 Adding Documents to VectorStore...');
  console.log(`   Documents: ${testDocuments.length}\n`);

  // Add documents (requires wallet signing)
  const startAdd = Date.now();
  try {
    const blobIds = await vectorStore.addDocuments(testDocuments, {
      account: { address: userAddress },
      signAndExecute: async (params, callbacks) => {
        try {
          // Sign and execute using keypair
          const result = await keypair.signAndExecuteTransaction({
            transaction: params.transaction,
            client: suiClient
          });
          callbacks.onSuccess(result);
        } catch (error) {
          callbacks.onError(error as Error);
        }
      },
      client: suiClient,
      category: 'knowledge',
      importance: 8,
      onProgress: (status) => console.log(`   ${status}`)
    });

    const addTime = Date.now() - startAdd;

    console.log(`\n✅ Documents added successfully in ${addTime}ms`);
    console.log(`   Blob IDs: ${blobIds.length}`);
    for (let i = 0; i < blobIds.length; i++) {
      console.log(`   [${i + 1}] ${blobIds[i]}`);
    }
    console.log();

    // Perform similarity search
    console.log('🔍 Performing Similarity Search...');
    const searchStart = Date.now();
    const results = await vectorStore.similaritySearch('Tell me about blockchain storage', 2);
    const searchTime = Date.now() - searchStart;

    console.log(`✅ Search completed in ${searchTime}ms`);
    console.log(`   Results: ${results.length}\n`);

    for (let i = 0; i < results.length; i++) {
      console.log(`   [${i + 1}] ${results[i].pageContent}`);
      console.log(`       Metadata: ${JSON.stringify(results[i].metadata)}\n`);
    }

    // Search with scores
    console.log('📊 Similarity Search with Scores...');
    const resultsWithScore = await vectorStore.similaritySearchWithScore(
      'encryption and security',
      3
    );

    for (const [doc, score] of resultsWithScore) {
      console.log(`   Score: ${score.toFixed(3)} - ${doc.pageContent.substring(0, 60)}...`);
    }
    console.log();

    // Get statistics
    console.log('📈 Vector Store Statistics:');
    const stats = await vectorStore.getStats();
    console.log(`   Total memories: ${stats.totalMemories}`);
    console.log(`   Index size: ${stats.indexSize}`);
    console.log(`   Categories: ${JSON.stringify(stats.categoryCounts)}`);
    console.log();

    return { vectorStore, blobIds };

  } catch (error) {
    console.error('❌ Error during vector store operations:', error);
    throw error;
  }
}

// ==================== DEMO 3: RAG Chain ====================

async function demo3_RAGChain() {
  console.log('\n' + '='.repeat(80));
  console.log('🤖 DEMO 3: createPDWRAG - Retrieval-Augmented Generation');
  console.log('='.repeat(80) + '\n');

  // Initialize components
  const suiRpcUrl = process.env.SUI_RPC_URL || getFullnodeUrl('testnet');
  const suiClient = new SuiClient({ url: suiRpcUrl });
  const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
  const userAddress = USER_ADDRESS;

  // Initialize embeddings
  const embeddings = new PDWEmbeddings({
    geminiApiKey: GEMINI_API_KEY
  });

  // Initialize vector store with sample data
  const vectorStore = new PDWVectorStore(embeddings, {
    userAddress,
    packageId: PACKAGE_ID,
    accessRegistryId: ACCESS_REGISTRY_ID,
    geminiApiKey: GEMINI_API_KEY,
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    walrusNetwork: 'testnet',
    network: 'testnet'
  });

  console.log('✅ Components initialized');
  console.log('   - PDWEmbeddings (Gemini)');
  console.log('   - PDWVectorStore (Walrus + Sui)');
  console.log('   - User: ' + userAddress.substring(0, 20) + '...\n');

  // Add sample knowledge base
  console.log('📚 Building Knowledge Base...\n');
  const knowledgeBase = [
    new Document({
      pageContent: 'Personal Data Wallet (PDW) is a decentralized memory system that stores your data on Walrus and Sui blockchain. It uses AI embeddings for semantic search and SEAL encryption for privacy.',
      metadata: { category: 'overview', source: 'docs' }
    }),
    new Document({
      pageContent: 'The PDW SDK provides LangChain integration through PDWEmbeddings and PDWVectorStore classes. This enables RAG workflows with decentralized storage.',
      metadata: { category: 'integration', source: 'docs' }
    }),
    new Document({
      pageContent: 'Walrus is a decentralized blob storage network. PDW uses Quilts for batch uploads, achieving ~90% gas savings compared to individual uploads.',
      metadata: { category: 'storage', source: 'docs' }
    }),
    new Document({
      pageContent: 'SEAL (Secure Encrypted Access Layer) provides identity-based encryption. Users can encrypt data and grant access to specific wallet addresses.',
      metadata: { category: 'security', source: 'docs' }
    })
  ];

  try {
    const blobIds = await vectorStore.addDocuments(knowledgeBase, {
      account: { address: userAddress },
      signAndExecute: async (params, callbacks) => {
        try {
          const result = await keypair.signAndExecuteTransaction({
            transaction: params.transaction,
            client: suiClient
          });
          callbacks.onSuccess(result);
        } catch (error) {
          callbacks.onError(error as Error);
        }
      },
      client: suiClient,
      category: 'knowledge-base',
      importance: 8,
      onProgress: (status) => console.log(`   ${status}`)
    });

    console.log(`\n✅ Knowledge base created: ${blobIds.length} documents\n`);

    // Initialize LLM (Google Gemini)
    const llm = new ChatGoogleGenerativeAI({
      apiKey: GEMINI_API_KEY,
      model: 'gemini-2.0-flash-exp',
      temperature: 0.2
    });

    console.log('✅ LLM initialized (Gemini 2.0 Flash)\n');

    // Create RAG chain
    console.log('🔗 Creating RAG Chain...\n');
    const ragChain = await createPDWRAG({
      vectorStore,
      llm,
      systemPrompt: 'You are a helpful AI assistant with access to the Personal Data Wallet knowledge base. Answer questions accurately based on the provided context.',
      k: 3,
      minSimilarity: 0.5,
      returnSourceDocuments: true
    });

    console.log('✅ RAG chain created\n');

    // Test RAG queries
    const testQueries = [
      'What is Personal Data Wallet?',
      'How does PDW integrate with LangChain?',
      'Explain the storage architecture',
      'What encryption does PDW use?'
    ];

    console.log('💬 Testing RAG Chain with Queries:\n');

    for (let i = 0; i < testQueries.length; i++) {
      const query = testQueries[i];
      console.log(`${'─'.repeat(80)}`);
      console.log(`Query ${i + 1}: ${query}\n`);

      const startQuery = Date.now();
      const result = await ragChain.invoke({ question: query });
      const queryTime = Date.now() - startQuery;

      console.log(`Answer (${queryTime}ms):`);
      console.log(`${result.answer}\n`);

      if (result.sourceDocuments && result.sourceDocuments.length > 0) {
        console.log(`📎 Sources (${result.sourceDocuments.length}):`);
        result.sourceDocuments.forEach((doc, idx) => {
          console.log(`   [${idx + 1}] ${doc.content.substring(0, 70)}...`);
          console.log(`       Similarity: ${doc.similarity?.toFixed(3) || 'N/A'}`);
        });
        console.log();
      }
    }

    console.log('='.repeat(80));
    console.log('✅ RAG Demo Complete!\n');

    return { ragChain, vectorStore, blobIds };

  } catch (error) {
    console.error('❌ Error during RAG demo:', error);
    throw error;
  }
}

// ==================== DEMO 4: Advanced Features ====================

async function demo4_AdvancedFeatures() {
  console.log('\n' + '='.repeat(80));
  console.log('⚡ DEMO 4: Advanced VectorStore Features');
  console.log('='.repeat(80) + '\n');

  const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
  const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
  const userAddress = USER_ADDRESS;

  const embeddings = new PDWEmbeddings({
    geminiApiKey: GEMINI_API_KEY
  });

  const vectorStore = new PDWVectorStore(embeddings, {
    userAddress,
    packageId: PACKAGE_ID,
    accessRegistryId: ACCESS_REGISTRY_ID,
    geminiApiKey: GEMINI_API_KEY,
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    walrusNetwork: 'testnet',
    network: 'testnet'
  });

  // Test 1: Factory Methods
  console.log('🏭 Test 1: Factory Methods\n');

  console.log('   Creating VectorStore from texts...');
  const vectorStoreFromTexts = await PDWVectorStore.fromTexts(
    ['Blockchain is a distributed ledger', 'Smart contracts are self-executing code'],
    [{ category: 'education' }, { category: 'education' }],
    embeddings,
    {
      userAddress,
      packageId: PACKAGE_ID,
      geminiApiKey: GEMINI_API_KEY,
      walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
      walrusNetwork: 'testnet',
      network: 'testnet',
      addOptions: {
        account: { address: userAddress },
        signAndExecute: async (params, callbacks) => {
          try {
            const result = await keypair.signAndExecuteTransaction({
              transaction: params.transaction,
              client: suiClient
            });
            callbacks.onSuccess(result);
          } catch (error) {
            callbacks.onError(error as Error);
          }
        },
        client: suiClient
      }
    }
  );

  console.log('   ✅ VectorStore created from texts\n');

  // Test 2: Filtered Search
  console.log('🔎 Test 2: Filtered Similarity Search\n');

  const filteredResults = await vectorStore.similaritySearch(
    'blockchain technology',
    5,
    { category: 'education', minSimilarity: 0.3 }
  );

  console.log(`   ✅ Found ${filteredResults.length} results with category filter\n`);

  // Test 3: MMR Search (diversity)
  console.log('🎯 Test 3: Maximum Marginal Relevance Search\n');
  console.log('   (Balances relevance with diversity)\n');

  const mmrResults = await vectorStore.maxMarginalRelevanceSearch(
    'decentralized systems',
    {
      k: 3,
      fetchK: 10,
      lambda: 0.5  // 50% relevance, 50% diversity
    }
  );

  console.log(`   ✅ MMR returned ${mmrResults.length} diverse results\n`);
  mmrResults.forEach((doc, idx) => {
    console.log(`   [${idx + 1}] ${doc.pageContent.substring(0, 60)}...`);
  });
  console.log();

  // Test 4: Statistics
  console.log('📊 Test 4: Analytics and Statistics\n');
  const stats = await vectorStore.getStats();

  console.log(`   Total memories: ${stats.totalMemories}`);
  console.log(`   Categories: ${Object.keys(stats.categoryCounts).join(', ')}`);
  console.log(`   Average importance: ${stats.averageImportance.toFixed(1)}/10`);
  console.log(`   Index size: ${stats.indexSize} bytes\n`);

  console.log('✅ Advanced features demo complete!\n');

  return { vectorStore };
}

// ==================== MAIN EXECUTION ====================

async function main() {
  console.log('\n');
  console.log('╔' + '═'.repeat(78) + '╗');
  console.log('║' + ' '.repeat(78) + '║');
  console.log('║' + '  PDW SDK - COMPLETE LANGCHAIN INTEGRATION DEMONSTRATION'.padEnd(78) + '║');
  console.log('║' + ' '.repeat(78) + '║');
  console.log('╚' + '═'.repeat(78) + '╝');

  try {
    // Run all demos
    await demo1_Embeddings();
    await demo2_VectorStore();
    await demo3_RAGChain();
    await demo4_AdvancedFeatures();

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ALL DEMONSTRATIONS COMPLETE');
    console.log('='.repeat(80));
    console.log();
    console.log('✅ Verified:');
    console.log('   - PDWEmbeddings ✅ LangChain Embeddings interface');
    console.log('   - PDWVectorStore ✅ LangChain VectorStore interface');
    console.log('   - createPDWRAG ✅ Standard RAG pattern');
    console.log('   - Decentralized storage ✅ Walrus + Sui');
    console.log('   - Semantic search ✅ HNSW vector indexing');
    console.log('   - Blockchain ownership ✅ Sui transactions');
    console.log();
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

export { demo1_Embeddings, demo2_VectorStore, demo3_RAGChain, demo4_AdvancedFeatures };
