/**
 * LANGCHAIN INTEGRATION - QUICK START DEMO
 *
 * Minimal example showing PDW + LangChain integration in ~50 lines.
 * Perfect for getting started quickly!
 *
 * What this demo does:
 * 1. Create PDW embeddings adapter
 * 2. Create PDW vector store
 * 3. Add some documents
 * 4. Search your memories
 * 5. Build a simple RAG chain
 *
 * Prerequisites:
 * - .env.test file in packages/pdw-sdk directory
 * - NEXT_PUBLIC_GEMINI_API_KEY, PRIVATE_KEY_ADDRESS, WALLET_ADDRESS
 * - NEXT_PUBLIC_PACKAGE_ID, NEXT_PUBLIC_ACCESS_REGISTRY_ID
 *
 * Run: npx tsx examples/langchain/quickstart-demo.ts
 */

import { PDWEmbeddings, PDWVectorStore, createPDWRAG } from '../../src/langchain';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { Document } from '@langchain/core/documents';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

// Extract environment variables
const GEMINI_API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY!;
const PRIVATE_KEY = process.env.PRIVATE_KEY_ADDRESS!;
const USER_ADDRESS = process.env.WALLET_ADDRESS!;
const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID!;
const ACCESS_REGISTRY_ID = process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID!;

async function quickstart() {
  console.log('\n🚀 PDW + LangChain Quick Start\n');

  // 1. Setup
  const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
  const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
  const userAddress = USER_ADDRESS;

  console.log(`👤 User: ${userAddress.substring(0, 20)}...\n`);

  // 2. Initialize PDW LangChain components
  const embeddings = new PDWEmbeddings({
    geminiApiKey: GEMINI_API_KEY
  });

  const vectorStore = new PDWVectorStore(embeddings, {
    userAddress,
    packageId: PACKAGE_ID,
    geminiApiKey: GEMINI_API_KEY,
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    network: 'testnet'
  });

  console.log('✅ PDWEmbeddings + PDWVectorStore initialized\n');

  // 3. Add some documents
  console.log('📚 Adding documents...\n');

  const docs = [
    new Document({
      pageContent: 'I love hiking in the mountains every weekend.',
      metadata: { category: 'hobby' }
    }),
    new Document({
      pageContent: 'My favorite programming language is TypeScript.',
      metadata: { category: 'tech' }
    })
  ];

  await vectorStore.addDocuments(docs, {
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
    onProgress: (status) => console.log(`   ${status}`)
  });

  console.log('\n✅ Documents added!\n');

  // 4. Search
  console.log('🔍 Searching: "outdoor activities"\n');
  const results = await vectorStore.similaritySearch('outdoor activities', 1);

  console.log(`Found: "${results[0].pageContent}"\n`);

  // 5. Create RAG chain
  console.log('🤖 Creating RAG chain...\n');

  const llm = new ChatGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    model: 'gemini-2.0-flash-exp'
  });

  const ragChain = await createPDWRAG({
    vectorStore,
    llm,
    systemPrompt: 'You are my personal AI assistant.',
    k: 2
  });

  // 6. Ask questions with RAG
  console.log('💬 Question: "What are my hobbies?"\n');
  const answer = await ragChain.invoke({ question: 'What are my hobbies?' });

  console.log(`Answer: ${answer.answer}\n`);

  console.log('✅ Quick start complete!\n');
  console.log('📖 Next steps:');
  console.log('  1. Add more documents to your knowledge base');
  console.log('  2. Customize the RAG prompts and parameters');
  console.log('  3. Build a full chat application with UI');
  console.log('  4. See complete-rag-demo.ts for advanced features\n');

  console.log('🎯 Key Takeaways:');
  console.log('  ✅ PDWEmbeddings = Standard LangChain Embeddings');
  console.log('  ✅ PDWVectorStore = Decentralized VectorStore');
  console.log('  ✅ Works with ANY LangChain LLM or chain');
  console.log('  ✅ Your data stored on Walrus + Sui blockchain\n');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  quickstart().catch((error) => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  });
}

export { quickstart };
