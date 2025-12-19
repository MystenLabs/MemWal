/**
 * PDW Tools with AI SDK - Basic Example
 *
 * This example demonstrates how to use pdwTools with Vercel AI SDK
 * to create an AI agent that can save and search personal memories.
 *
 * Features:
 * - Automatic memory saving when user shares information
 * - Semantic search through stored memories
 * - Multi-turn conversations with memory context
 *
 * Requirements:
 * - GEMINI_API_KEY environment variable
 * - SUI_PRIVATE_KEY environment variable
 * - PACKAGE_ID environment variable
 * - WALRUS_AGGREGATOR environment variable
 */

import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { pdwTools } from '../../src/ai-sdk/tools';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import 'dotenv/config';

async function main() {
  console.log('🤖 PDW Tools + AI SDK Example\n');

  // 1. Setup: Initialize keypair and address
  const keypair = Ed25519Keypair.fromSecretKey(
    process.env.SUI_PRIVATE_KEY!
  );
  const userAddress = keypair.toSuiAddress();

  console.log('📦 User Address:', userAddress);
  console.log('');

  // 2. Create embedding model for auto-embedding
  const embedModel = google.textEmbeddingModel('text-embedding-004');

  // 3. Create PDW tools
  const tools = pdwTools({
    userId: userAddress,
    embedModel,
    pdwConfig: {
      walrus: {
        aggregator: process.env.WALRUS_AGGREGATOR!,
        publisher: process.env.WALRUS_PUBLISHER,
      },
      sui: {
        network: 'testnet',
        packageId: process.env.PACKAGE_ID!,
      },
      signer: keypair,
      userAddress,
      dimensions: 768, // Gemini text-embedding-004 dimensions
      features: {
        encryption: false,
        extractKnowledgeGraph: false
      }
    }
  });

  console.log('✅ PDW Tools initialized\n');

  // 4. Example Conversation 1: Save information
  console.log('💬 Conversation 1: Saving information\n');

  const result1 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5, // Allow multiple tool calls
    prompt: 'Remember that I love TypeScript and use it for all my backend projects. Also remember that my favorite food is pizza.'
  });

  console.log('Assistant:', result1.text);
  console.log('\nTool Calls:', result1.toolCalls.length);
  result1.toolCalls.forEach((call, i) => {
    console.log(`  ${i + 1}. ${call.toolName}`);
  });
  console.log('');

  // Wait a bit for storage to propagate
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 5. Example Conversation 2: Retrieve information
  console.log('💬 Conversation 2: Retrieving information\n');

  const result2 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: 'What programming languages do I use?'
  });

  console.log('Assistant:', result2.text);
  console.log('\nTool Calls:', result2.toolCalls.length);
  result2.toolCalls.forEach((call, i) => {
    console.log(`  ${i + 1}. ${call.toolName}`);
  });
  console.log('');

  // 6. Example Conversation 3: Multiple queries
  console.log('💬 Conversation 3: Multiple related queries\n');

  const result3 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: 'What are my food and programming preferences?'
  });

  console.log('Assistant:', result3.text);
  console.log('\nTool Calls:', result3.toolCalls.length);
  result3.toolCalls.forEach((call, i) => {
    console.log(`  ${i + 1}. ${call.toolName}`);
    if (call.toolName === 'search_memory') {
      console.log(`     Query: "${(call.input as any).query}"`);
    }
  });
  console.log('');

  // 7. Example Conversation 4: List all memories
  console.log('💬 Conversation 4: Get memory summary\n');

  const result4 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: 'How many things have I told you about myself?'
  });

  console.log('Assistant:', result4.text);
  console.log('');

  console.log('✨ Example completed!');
  console.log('\n💡 Key Takeaways:');
  console.log('   - AI automatically decides when to save memories');
  console.log('   - AI automatically searches when asked questions');
  console.log('   - All embeddings are generated automatically');
  console.log('   - Memories are stored on Walrus + indexed on Sui');
}

main().catch(console.error);
