# Personal Data Wallet (PDW) - MemWal

A decentralized personal data wallet that stores your memories on the Sui blockchain with AI-powered vector search, knowledge graph extraction, and optional SEAL encryption.

**SDK Package**: [@cmdoss/memwal](https://www.npmjs.com/package/@cmdoss/memwal)

## Features

- **Blockchain Storage**: Memories stored on Sui blockchain with Walrus decentralized storage
- **AI-Powered Search**: Vector embeddings with HNSW index for semantic search
- **Knowledge Graph**: Automatic entity and relationship extraction
- **Batch Upload**: Quilt technology for efficient multi-memory uploads (50-67% gas savings)
- **Option A+**: Local content caching for 41x faster search (2.3s vs 90s)
- **Optional Encryption**: SEAL integration for end-to-end encryption

## Prerequisites

### Required Software

| Software | Version | Installation |
|----------|---------|--------------|
| Node.js | v20+ | [nodejs.org](https://nodejs.org/) |
| pnpm | v8+ | `npm install -g pnpm` |
| Sui CLI | latest | [Sui Installation](https://docs.sui.io/guides/developer/getting-started/sui-install) |
| Git | latest | [git-scm.com](https://git-scm.com/) |

### API Keys Required

| Service | Purpose | Get Key |
|---------|---------|---------|
| OpenRouter | AI embeddings & chat | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Sui Wallet | Blockchain transactions | `sui client new-address ed25519` |

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/cmdoss/personal-data-wallet.git
cd personal-data-wallet

# Install dependencies
pnpm install
```

### 2. Setup Sui Wallet

```bash
# Create new wallet (if you don't have one)
sui client new-address ed25519

# Get testnet SUI tokens
sui client faucet

# Export private key (KEEP THIS SAFE!)
sui keytool export --key-identity <your-alias>
```

### 3. Deploy Smart Contract

```bash
cd smart-contract

# Deploy to testnet
sui client publish --gas-budget 100000000

# Save the output - you'll need:
# - Package ID
# - Access Registry ID
# - Wallet Registry ID
```

### 4. Configure Environment

```bash
# Copy example config
cp .env.example .env

# Edit .env with your values
```

**Required `.env` variables:**

```env
# Sui Network
SUI_NETWORK=testnet

# From smart contract deployment
PACKAGE_ID=0x_your_package_id_here
ACCESS_REGISTRY_ID=0x_your_access_registry_id_here
WALLET_REGISTRY_ID=0x_your_wallet_registry_id_here

# Sui Wallet
WALLET_ADDRESS=0x_your_wallet_address
SUI_PRIVATE_KEY=suiprivkey1q_your_private_key

# Walrus (testnet defaults work out of box)
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space

# OpenRouter API Key
OPENROUTER_API_KEY=sk-or-v1-your_key_here
EMBEDDING_PROVIDER=openrouter
```

### 5. Build SDK

```bash
cd packages/pdw-sdk
pnpm install
pnpm build
```

### 6. Run the App

```bash
# Back to root directory
cd ../..

# Start development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
personal-data-wallet/
├── app/                      # Next.js app (frontend)
│   ├── api/                  # API routes
│   │   ├── chat/             # Chat endpoint with RAG
│   │   ├── memories/         # Memory management
│   │   └── index/            # Index rebuild
│   └── page.tsx              # Main chat UI
├── packages/
│   └── pdw-sdk/              # TypeScript SDK
│       ├── src/
│       │   ├── client/       # SimplePDWClient
│       │   ├── services/     # Core services
│       │   ├── vector/       # HNSW index
│       │   └── utils/        # Utilities
│       └── dist/             # Built output
├── smart-contract/           # Sui Move contract
│   └── sources/              # Move source files
├── lib/                      # App utilities
│   └── pdw-service.ts        # PDW client singleton
└── scripts/                  # Utility scripts
    ├── benchmark-curl.sh     # API benchmark
    └── benchmark-search.ts   # SDK benchmark
```

## SDK Usage

### Basic Example

```typescript
import { SimplePDWClient } from '@cmdoss/memwal';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Initialize client
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  sui: {
    packageId: process.env.PACKAGE_ID,
  },
  embedding: {
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY,
  },
  walrus: {
    aggregator: 'https://aggregator.walrus-testnet.walrus.space',
    publisher: 'https://publisher.walrus-testnet.walrus.space',
  },
  features: {
    enableLocalIndexing: true,
    enableKnowledgeGraph: true,
  },
});

await pdw.ready();

// Save a memory
const result = await pdw.memory.create('I live in Ho Chi Minh City', {
  category: 'personal',
  importance: 5,
});

// Search memories
const results = await pdw.search.vector('where do I live', {
  limit: 10,
  threshold: 0.5,
  fetchContent: true,
});

// Batch save multiple memories
const batchResult = await pdw.memory.createBatch([
  'My favorite food is pho',
  'I work at CommandOSS',
  'I love programming in TypeScript',
]);
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUI_NETWORK` | Yes | `testnet` | Sui network (testnet/mainnet) |
| `PACKAGE_ID` | Yes | - |cmdoss/personal-data-wallet
 Deployed smart contract package ID |
| `WALLET_ADDRESS` | Yes | - | Your Sui wallet address |
| `SUI_PRIVATE_KEY` | Yes | - | Sui private key (suiprivkey1q...) |
| `OPENROUTER_API_KEY` | Yes | - | OpenRouter API key for embeddings |
| `EMBEDDING_MODEL` | No | `google/gemini-embedding-001` | Embedding model |
| `EMBEDDING_DIMENSIONS` | No | `3072` | Embedding vector dimensions |
| `WALRUS_PUBLISHER` | No | testnet URL | Walrus publisher endpoint |
| `WALRUS_AGGREGATOR` | No | testnet URL | Walrus aggregator endpoint |
| `ENABLE_SEAL_ENCRYPTION` | No | `false` | Enable SEAL encryption |

## Performance Benchmarks

| Operation | Time | Notes |
|-----------|------|-------|
| Chat Search | ~2.3s | Local HNSW index |
| Single Memory Save | ~17s | Full pipeline with KG |
| Batch Save (Quilt) | ~13s | 50-67% gas savings |
| Memory List | 116-950ms | Depends on cache |
| Knowledge Graph Extraction | ~3s | Per memory |

### Cost Analysis (Sui Testnet)

| Operation | Gas Cost |
|-----------|----------|
| Single Memory Register | ~0.0035 SUI |
| Quilt Blob Storage | ~0.0061 SUI |
| Total per Memory | ~0.0056 SUI |

## API Reference

### Chat

#### `POST /api/chat`
Main chat endpoint with RAG (Retrieval Augmented Generation).

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "What is my name?" }
  ]
}
```

**Response:** Streaming text response with memories context.

---

#### `POST /api/chat/extract-memory`
Automatically extract and save personal data from conversation.

**Request:**
```json
{
  "userMessage": "My favorite color is blue",
  "assistantResponse": "I'll remember that your favorite color is blue!"
}
```

**Response:**
```json
{
  "saved": true,
  "memoryId": "0x...",
  "blobId": "abc123...",
  "category": "preference",
  "importance": 5
}
```

---

### Memories

#### `GET /api/memories/list`
Get all memories from blockchain.

**Response:**
```json
{
  "memories": [
    {
      "id": "0x...",
      "content": "I live in Ho Chi Minh City",
      "blobId": "abc123...",
      "category": "personal",
      "importance": 5,
      "createdAt": 1766037297534
    }
  ],
  "count": 50,
  "success": true
}
```

---

#### `POST /api/memory/save`
Manually save a memory to blockchain.

**Request:**
```json
{
  "content": "My birthday is January 15th",
  "category": "personal"
}
```

**Response:**
```json
{
  "success": true,
  "memoryId": "0x...",
  "blobId": "abc123...",
  "message": "Memory saved to blockchain successfully"
}
```

---

### Index Management

#### `POST /api/index/rebuild`
Force rebuild HNSW index from blockchain + Walrus.

**Request:** No body required.

**Response:**
```json
{
  "success": true,
  "message": "Index rebuilt successfully: 50/50 memories indexed",
  "data": {
    "totalMemories": 50,
    "indexedMemories": 50,
    "failedMemories": 0,
    "duration": 12500,
    "durationFormatted": "12.50s"
  }
}
```

**Use cases:**
- New device login
- Index out of sync
- Enable Option A+ for old memories

---

## Scripts

```bash
# Development
pnpm dev                    # Start Next.js dev server

# Build
pnpm build                  # Build production app
cd packages/pdw-sdk && pnpm build  # Build SDK

# Testing
pnpm lint                   # Run linter

# Benchmarks
bash scripts/benchmark-curl.sh http://localhost:3000  # API benchmark
npx tsx scripts/benchmark-search.ts                    # SDK benchmark

# Index Management
curl -X POST http://localhost:3000/api/index/rebuild   # Rebuild HNSW index
```

## Troubleshooting

### Common Issues

**1. "PDW Client not available during build time"**
- This is expected during Next.js static build
- The client initializes at runtime, not build time

**2. "Missing required environment variables"**
- Check all required variables in `.env`
- Make sure `.env` is in the root directory

**3. "Index already exists"**
- The HNSW index is automatically created
- To rebuild: `curl -X POST http://localhost:3000/api/index/rebuild`

**4. "Walrus fetch taking too long"**
- Old memories may not have local content cached
- Rebuild index to enable Option A+: `/api/index/rebuild`

**5. "sui client publish fails"**
- Ensure you have enough SUI: `sui client faucet`
- Check gas budget: use `--gas-budget 100000000`

**6. "hnswlib-node bindings not found" (Windows)**

Error: `Could not locate the bindings file` or `MSB8036: The Windows SDK version 10.0.22621.0 was not found`

This happens because `hnswlib-node` requires native compilation with Windows SDK.

**Solution:**
1. Open **Visual Studio Installer**
2. Select **Modify** for VS Build Tools 2022
3. Go to **Individual components** tab
4. Check **Windows 10/11 SDK (10.0.22621.0)** or newer version
5. Click **Modify** to install
6. Restart terminal and rebuild:
   ```bash
   npm rebuild hnswlib-node
   ```

**Alternative:** If you can't install Windows SDK, the SDK will fall back to `hnswlib-wasm` (slower but works without native compilation).

### Debug Mode

Enable verbose logging:

```env
DEBUG=pdw:*
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Next.js App                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Chat Interface                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                     API Routes                            │   │
│  │  /api/chat  │  /api/memories  │  /api/index              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────────────────────────────────────────┐
│                      PDW SDK (TypeScript)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Memory      │  │ Search      │  │ AI                      │  │
│  │ Namespace   │  │ Namespace   │  │ Namespace               │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│         │                │                     │                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Core Services                            ││
│  │  StorageService │ EmbeddingService │ VectorService          ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼───────┐    ┌────────▼────────┐    ┌───────▼───────┐
│ Sui Blockchain│    │  Walrus Storage │    │  HNSW Index   │
│ (Move Contract)    │  (Blob Storage) │    │  (Local/WASM) │
└───────────────┘    └─────────────────┘    └───────────────┘
```

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [MemWal SDK Documentation](packages/pdw-sdk/README.md)
- [Sui Documentation](https://docs.sui.io/)
- [Walrus Documentation](https://docs.walrus.site/)
- [OpenRouter](https://openrouter.ai/)
- [SEAL Encryption](https://docs.seal.mysten.app/)
