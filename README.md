# MemWal

Privacy-first AI memory SDK. Stores encrypted memories on Walrus (decentralized storage) and retrieves them via semantic search. 

## Install

```bash
pnpm add @cmdoss/memwal
```

Peer dependencies (install as needed):

```bash
pnpm add @mysten/sui @mysten/seal @mysten/walrus ai zod
```

## Quick Start

```ts
import { MemWal } from "@cmdoss/memwal";

const memwal = MemWal.create({
  key: "your-delegate-key-hex", // Ed25519 delegate key — get it from app.memwal.com
  serverUrl: "https://your-memwal-server.com",
});

// Store a memory
await memwal.remember("User prefers dark mode and uses TypeScript.");

// Retrieve relevant memories
const memories = await memwal.recall("What are the user's preferences?");
```

## Exports

| Entry | Description |
|---|---|
| `@cmdoss/memwal` | Default client (`MemWal`). Server handles everything: embedding, SEAL encryption, Walrus upload/download, and decryption — all inside a TEE. |
| `@cmdoss/memwal/manual` | Manual mode (`MemWalManual`). You handle SEAL encryption, embedding, and Walrus upload client-side. Server only stores the vector ↔ blobId mapping and returns matching blobIds on recall. Full client-side privacy. |
| `@cmdoss/memwal/ai` | Vercel AI SDK integration — wraps `MemWal` as middleware for use with `streamText`, `generateText`, etc. |

## How It Works

1. **Send** — Text is sent to the server (runs inside a TEE)
2. **Store** — Server embeds → encrypts with SEAL → uploads to Walrus; vector stored with pgvector
3. **Recall** — Query is embedded, similar memories fetched, decrypted inside TEE, returned as plaintext

## License

Apache 2.0