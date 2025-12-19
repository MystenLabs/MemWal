/**
 * PDW Tools with AI SDK - Advanced Example
 *
 * This example demonstrates advanced usage of pdwTools including:
 * - Categorical memory organization
 * - Importance scoring
 * - Multi-turn conversation with context
 * - Selective tool enabling
 *
 * Use cases:
 * - Personal AI assistant
 * - Knowledge management system
 * - Conversation memory augmentation
 */

import { generateText, streamText } from 'ai';
import { google } from '@ai-sdk/google';
import { pdwTools } from '../../src/ai-sdk/tools';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import 'dotenv/config';

async function demonstrateCategories() {
  console.log('\n📂 Demo 1: Categorical Memory Organization\n');

  const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
  const embedModel = google.textEmbeddingModel('text-embedding-004');

  const tools = pdwTools({
    userId: keypair.toSuiAddress(),
    embedModel,
    pdwConfig: {
      walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
      sui: {
        network: 'testnet',
        packageId: process.env.PACKAGE_ID!,
      },
      signer: keypair,
      userAddress: keypair.toSuiAddress(),
      dimensions: 768
    }
  });

  // Save different types of information
  const result = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 10,
    prompt: `
Remember the following about me:
- I prefer dark mode in all my apps (preference)
- The capital of France is Paris (fact)
- I need to buy milk tomorrow (todo)
- React hooks are powerful but can be tricky (note)
    `.trim()
  });

  console.log('✅ Saved categorized memories');
  console.log(`   Tool calls: ${result.toolCalls.length}`);
  console.log('');

  // Query by category
  const searchResult = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: 'What are my TODOs?'
  });

  console.log('Assistant:', searchResult.text);
}

async function demonstrateImportance() {
  console.log('\n⭐ Demo 2: Importance-based Memory\n');

  const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
  const embedModel = google.textEmbeddingModel('text-embedding-004');

  const tools = pdwTools({
    userId: keypair.toSuiAddress(),
    embedModel,
    pdwConfig: {
      walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
      sui: {
        network: 'testnet',
        packageId: process.env.PACKAGE_ID!,
      },
      signer: keypair,
      userAddress: keypair.toSuiAddress(),
      dimensions: 768
    }
  });

  const result = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    system: `When saving memories, assign importance:
- Critical information (passwords, addresses): 9-10
- Important preferences: 7-8
- Regular facts: 5-6
- Minor notes: 1-4`,
    prompt: 'Remember: My emergency contact is John at +1-555-0123 (very important)'
  });

  console.log('✅ Saved with importance level');
  console.log('   AI assigned appropriate importance\n');
}

async function demonstrateStreaming() {
  console.log('\n🌊 Demo 3: Streaming with Tool Calls\n');

  const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
  const embedModel = google.textEmbeddingModel('text-embedding-004');

  const tools = pdwTools({
    userId: keypair.toSuiAddress(),
    embedModel,
    pdwConfig: {
      walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
      sui: {
        network: 'testnet',
        packageId: process.env.PACKAGE_ID!,
      },
      signer: keypair,
      userAddress: keypair.toSuiAddress(),
      dimensions: 768
    }
  });

  const stream = await streamText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: 'Tell me everything you know about my preferences'
  });

  process.stdout.write('Assistant: ');

  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk);
  }

  console.log('\n');
}

async function demonstrateSelectiveTools() {
  console.log('\n🔧 Demo 4: Selective Tool Enabling\n');

  const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
  const embedModel = google.textEmbeddingModel('text-embedding-004');

  // Only enable search (read-only mode)
  const readOnlyTools = pdwTools({
    userId: keypair.toSuiAddress(),
    embedModel,
    enabledTools: ['search_memory', 'list_memories'], // No save_memory
    pdwConfig: {
      walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
      sui: {
        network: 'testnet',
        packageId: process.env.PACKAGE_ID!,
      },
      signer: keypair,
      userAddress: keypair.toSuiAddress(),
      dimensions: 768
    }
  });

  const result = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools: readOnlyTools,
    maxSteps: 5,
    prompt: 'Remember that I love JavaScript' // AI won't be able to save this
  });

  console.log('Read-only mode:', result.text);
  console.log('   (AI cannot save, only search)\n');
}

async function demonstrateConversation() {
  console.log('\n💬 Demo 5: Multi-turn Conversation with Memory\n');

  const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
  const embedModel = google.textEmbeddingModel('text-embedding-004');

  const tools = pdwTools({
    userId: keypair.toSuiAddress(),
    embedModel,
    pdwConfig: {
      walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
      sui: {
        network: 'testnet',
        packageId: process.env.PACKAGE_ID!,
      },
      signer: keypair,
      userAddress: keypair.toSuiAddress(),
      dimensions: 768
    }
  });

  // Turn 1: Save info
  console.log('👤 User: I work at Acme Corp as a senior developer');

  const turn1 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: 'I work at Acme Corp as a senior developer'
  });

  console.log('🤖 AI:', turn1.text);
  console.log('');

  await new Promise(resolve => setTimeout(resolve, 1000));

  // Turn 2: Recall info
  console.log('👤 User: Where do I work?');

  const turn2 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: 'Where do I work?'
  });

  console.log('🤖 AI:', turn2.text);
  console.log('');

  // Turn 3: Build on context
  console.log('👤 User: What tech stack should I use for my company project?');

  const turn3 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    system: 'Use stored memories about the user to provide personalized recommendations',
    prompt: 'What tech stack should I use for my company project?'
  });

  console.log('🤖 AI:', turn3.text);
  console.log('');
}

async function main() {
  console.log('🚀 PDW Tools - Advanced Examples\n');
  console.log('='.repeat(50));

  try {
    await demonstrateCategories();
    await demonstrateImportance();
    await demonstrateStreaming();
    await demonstrateSelectiveTools();
    await demonstrateConversation();

    console.log('='.repeat(50));
    console.log('\n✨ All demos completed!');
    console.log('\n💡 Advanced Features Demonstrated:');
    console.log('   ✅ Categorical organization (fact, preference, todo, note)');
    console.log('   ✅ Importance scoring (1-10)');
    console.log('   ✅ Streaming responses with tool calls');
    console.log('   ✅ Selective tool enabling (read-only mode)');
    console.log('   ✅ Multi-turn conversations with context');
  } catch (error) {
    console.error('Error:', error);
  }
}

main().catch(console.error);
