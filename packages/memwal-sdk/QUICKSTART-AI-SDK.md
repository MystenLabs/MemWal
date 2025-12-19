# PDW Tools for AI SDK - Quick Start Guide

## 🚀 Simplest way to add personal memory to your AI applications

**pdwTools** gives AI agents the ability to save and search personal memories automatically, powered by decentralized storage (Walrus) and blockchain (Sui).

---

## ⚡ Quick Start (3 lines of code!)

```typescript
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { pdwTools } from 'personal-data-wallet-sdk/ai-sdk';

// 1. Create embedding model
const embedModel = google.textEmbeddingModel('text-embedding-004');

// 2. Create PDW tools
const tools = pdwTools({
  userId: 'user-123',
  embedModel,
  pdwConfig: {
    walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
    sui: { network: 'testnet', packageId: process.env.PACKAGE_ID! },
    signer: keypair,
    userAddress: keypair.toSuiAddress(),
    dimensions: 768 // Gemini embedding dimensions
  }
});

// 3. Use with AI - memories are automatic!
const result = await generateText({
  model: google('gemini-2.0-flash-exp'),
  tools,
  prompt: "Remember that I love TypeScript and use it daily"
});

// AI will automatically:
// ✅ Detect "Remember" and call save_memory tool
// ✅ Generate embedding for the text
// ✅ Store to Walrus + Sui blockchain
// ✅ Index for future search
```

---

## 📦 Installation

```bash
npm install personal-data-wallet-sdk ai @ai-sdk/google @mysten/sui
```

---

## 🔑 Environment Setup

Create `.env` file:

```bash
# Gemini API Key (for embeddings + AI)
GEMINI_API_KEY=your_gemini_api_key

# Sui Configuration
SUI_PRIVATE_KEY=your_sui_private_key
PACKAGE_ID=0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde

# Walrus Configuration (Testnet)
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
```

---

## 🛠️ Available Tools

AI agents get 3 powerful tools:

### 1. `search_memory`
Search through personal memories using semantic similarity.

**When AI uses it:**
- User asks: "What did I say about..."
- User asks: "Do you remember when..."
- User asks: "What do I know about..."

**Parameters:**
- `query` - Search query text
- `limit` - Max results (default: 5)
- `minScore` - Min similarity 0-1 (default: 0.7)
- `category` - Filter by category (optional)

### 2. `save_memory`
Save important information to personal memory.

**When AI uses it:**
- User says: "Remember that..."
- User says: "Save this..."
- User says: "I prefer..."
- User shares important facts

**Parameters:**
- `text` - Content to save
- `category` - fact, preference, todo, note, general (optional)
- `importance` - Level 1-10 (optional)

### 3. `list_memories`
Get information about stored memories.

**When AI uses it:**
- User asks: "What do you know about me?"
- User asks: "What have I told you?"
- User wants memory summary

**Parameters:**
- `limit` - Number of memories (default: 10)
- `category` - Filter by category (optional)

---

## 💡 Complete Example

```typescript
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { pdwTools } from 'personal-data-wallet-sdk/ai-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import 'dotenv/config';

async function main() {
  // Setup
  const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY!);
  const embedModel = google.textEmbeddingModel('text-embedding-004');

  const tools = pdwTools({
    userId: keypair.toSuiAddress(),
    embedModel,
    pdwConfig: {
      walrus: {
        aggregator: process.env.WALRUS_AGGREGATOR!,
        publisher: process.env.WALRUS_PUBLISHER
      },
      sui: {
        network: 'testnet',
        packageId: process.env.PACKAGE_ID!
      },
      signer: keypair,
      userAddress: keypair.toSuiAddress(),
      dimensions: 768
    }
  });

  // Conversation 1: Save info
  console.log('User: Remember I love TypeScript\n');

  const result1 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: "Remember that I love TypeScript and use it daily"
  });

  console.log('AI:', result1.text);
  console.log('Tools used:', result1.toolCalls.map(t => t.toolName).join(', '));

  // Wait for storage
  await new Promise(r => setTimeout(r, 2000));

  // Conversation 2: Retrieve info
  console.log('\nUser: What programming languages do I use?\n');

  const result2 = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools,
    maxSteps: 5,
    prompt: "What programming languages do I use?"
  });

  console.log('AI:', result2.text);
}

main();
```

---

## 🎨 Advanced Usage

### Selective Tool Enabling

```typescript
// Read-only mode (no saving)
const readOnlyTools = pdwTools({
  userId,
  embedModel,
  pdwConfig,
  enabledTools: ['search_memory', 'list_memories']  // No save_memory
});
```

### Custom Descriptions

```typescript
const tools = pdwTools({
  userId,
  embedModel,
  pdwConfig,
  customDescriptions: {
    save_memory: 'Save important user preferences and facts',
    search_memory: 'Find relevant information from past conversations'
  }
});
```

### Streaming Responses

```typescript
import { streamText } from 'ai';

const stream = await streamText({
  model: google('gemini-2.0-flash-exp'),
  tools,
  prompt: "What do you know about my preferences?"
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

---

## 🌐 Use Cases

### 1. Personal AI Assistant
```typescript
// AI remembers user preferences automatically
const chatbot = await generateText({
  model: google('gemini-2.0-flash-exp'),
  tools: pdwTools(config),
  prompt: userMessage
});
```

### 2. API Endpoint
```typescript
export async function POST(req: Request) {
  const { message } = await req.json();

  const result = await generateText({
    model: google('gemini-2.0-flash-exp'),
    tools: pdwTools(serverConfig),
    prompt: message
  });

  return Response.json({ response: result.text });
}
```

### 3. CLI Tool
```typescript
// Terminal AI with memory
const response = await generateText({
  model: google('gemini-2.0-flash-exp'),
  tools: pdwTools(config),
  prompt: process.argv[2]
});

console.log(response.text);
```

---

## 🔧 Configuration Reference

```typescript
interface PDWToolsConfig {
  // Required
  userId: string;                    // User identifier
  embedModel: EmbeddingModel;        // AI SDK embedding model
  pdwConfig: PDWVectorStoreConfig;   // PDW configuration

  // Optional
  enabledTools?: string[] | 'all';   // Which tools to enable
  customDescriptions?: {             // Custom tool descriptions
    search_memory?: string;
    save_memory?: string;
    list_memories?: string;
  };
}
```

---

## 📊 Why pdwTools?

| Feature | Traditional RAG | pdwTools |
|---------|----------------|----------|
| **Setup** | 50+ lines | 3 lines |
| **Embedding** | Manual | Automatic |
| **Storage** | Centralized | Decentralized (Walrus + Sui) |
| **AI Control** | Manual save/search | AI decides when |
| **Memory** | Per-session only | Permanent blockchain |

---

## 🔗 Learn More

- **Full Examples**: [`packages/pdw-sdk/examples/ai-sdk/`](./examples/ai-sdk/)
- **API Reference**: [`packages/pdw-sdk/src/ai-sdk/`](./src/ai-sdk/)
- **PDW SDK Docs**: [`packages/pdw-sdk/CLAUDE.md`](./CLAUDE.md)

---

## 🆘 Troubleshooting

### "Embedding model not configured"
Make sure to provide `embedModel` in config:
```typescript
const embedModel = google.textEmbeddingModel('text-embedding-004');
const tools = pdwTools({ userId, embedModel, pdwConfig });
```

### "API key not found"
Set `GEMINI_API_KEY` environment variable or pass in config.

### "Dimension mismatch"
Ensure `dimensions` in `pdwConfig` matches your embedding model:
- Gemini text-embedding-004: **768**
- OpenAI text-embedding-3-small: 1536
- OpenAI text-embedding-3-large: 3072

---

## ✨ That's it!

You now have an AI agent with **permanent, decentralized memory** powered by Walrus and Sui blockchain.

Ready to ship! 🚀
