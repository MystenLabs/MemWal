/**
 * Multi-Provider Example with AI SDK + PDW
 *
 * Demonstrates using PDW with different AI providers:
 * - OpenAI embeddings
 * - Google Gemini embeddings
 * - Cohere embeddings
 *
 * Shows how PDW is provider-agnostic and works with any AI SDK model.
 */

import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
// import { cohere } from '@ai-sdk/cohere'; // Optional
import { PDWVectorStore } from 'personal-data-wallet-sdk/ai-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import 'dotenv/config';

async function main() {
  console.log('🌐 Multi-Provider Example\n');

  const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);

  // Example 1: OpenAI Embeddings
  console.log('1️⃣  Using OpenAI (text-embedding-3-large)');

  const openaiStore = new PDWVectorStore({
    walrus: {
      aggregator: process.env.WALRUS_AGGREGATOR!,
    },
    sui: {
      network: 'testnet',
      packageId: process.env.PACKAGE_ID!,
    },
    signer: keypair,
    userAddress: keypair.toSuiAddress(),
    dimensions: 3072, // text-embedding-3-large dimensions
  });

  const { embedding: openaiEmbedding } = await embed({
    model: openai.embedding('text-embedding-3-large'),
    value: 'Hello from OpenAI',
  });

  await openaiStore.add({
    id: 'openai-doc-1',
    vector: openaiEmbedding,
    text: 'Hello from OpenAI',
    metadata: { provider: 'openai' },
  });

  console.log('   ✅ Stored OpenAI embedding to Walrus\n');

  // Example 2: Google Gemini Embeddings
  console.log('2️⃣  Using Google Gemini (text-embedding-004)');

  const geminiStore = new PDWVectorStore({
    walrus: {
      aggregator: process.env.WALRUS_AGGREGATOR!,
    },
    sui: {
      network: 'testnet',
      packageId: process.env.PACKAGE_ID!,
    },
    signer: keypair,
    userAddress: keypair.toSuiAddress(),
    dimensions: 768, // Gemini dimensions
    geminiApiKey: process.env.GEMINI_API_KEY!, // For optional graph extraction
  });

  const { embedding: geminiEmbedding } = await embed({
    model: google.textEmbedding('text-embedding-004'),
    value: 'Hello from Gemini',
  });

  await geminiStore.add({
    id: 'gemini-doc-1',
    vector: geminiEmbedding,
    text: 'Hello from Gemini',
    metadata: { provider: 'gemini' },
  });

  console.log('   ✅ Stored Gemini embedding to Walrus\n');

  // Example 3: Cohere Embeddings (if installed)
  if (process.env.COHERE_API_KEY) {
    console.log('3️⃣  Using Cohere (embed-english-v3.0)');

    try {
      const { cohere } = await import('@ai-sdk/cohere');

      const cohereStore = new PDWVectorStore({
        walrus: {
          aggregator: process.env.WALRUS_AGGREGATOR!,
        },
        sui: {
          network: 'testnet',
          packageId: process.env.PACKAGE_ID!,
        },
        signer: keypair,
        userAddress: keypair.toSuiAddress(),
        dimensions: 1024, // Cohere dimensions
      });

      const { embedding: cohereEmbedding } = await embed({
        model: cohere.textEmbedding('embed-english-v3.0'),
        value: 'Hello from Cohere',
      });

      await cohereStore.add({
        id: 'cohere-doc-1',
        vector: cohereEmbedding,
        text: 'Hello from Cohere',
        metadata: { provider: 'cohere' },
      });

      console.log('   ✅ Stored Cohere embedding to Walrus\n');
    } catch (error) {
      console.log('   ⚠️  Cohere not installed (npm install @ai-sdk/cohere)\n');
    }
  }

  console.log('✨ Multi-provider example completed!');
  console.log('\n💡 Key Takeaway:');
  console.log('   PDW works with ANY ai-sdk compatible provider.');
  console.log('   Your data is stored on Walrus (decentralized) regardless of embedding provider.');
}

main().catch(console.error);
