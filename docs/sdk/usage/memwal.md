---
title: "MemWal"
description: "The recommended default client — relayer handles embeddings, SEAL, and storage."
---

The recommended default client. The relayer handles embeddings, SEAL encryption, Walrus upload, and vector indexing.

## How It Works

1. The SDK signs each request with your delegate key
2. The relayer verifies delegate access
3. `remember` encrypts via SEAL, uploads to Walrus, and indexes the vector embedding
4. `recall` searches by Memory Space and returns decrypted matches

```ts
import { MemWal } from "@mysten/memwal";

const memwal = MemWal.create({
  key: "<your-ed25519-private-key>",
  serverUrl: "https://your-relayer-url.com",
  namespace: "chatbot-prod",
});
```

## Core Methods

```ts
// Store a memory
await memwal.remember("User prefers dark mode and works in TypeScript.");

// Recall relevant memories
const result = await memwal.recall("What do we know about this user?", 5);

// Extract and store facts from longer text
const analyzed = await memwal.analyze(
  "I live in Hanoi, prefer dark mode, and usually work late at night."
);
console.log(analyzed.facts);

// Check relayer health
await memwal.health();
```

## Restore

Rebuild missing indexed entries for one namespace. Incremental, namespace-scoped, and meant to
repair PostgreSQL vector state from Walrus-backed memory.

```ts
const result = await memwal.restore("chatbot-prod", 50);
```

## Lower-Level Methods

Use these when you already have a vector or encrypted payload:

- `rememberManual({ blobId, vector, namespace? })`
- `recallManual({ vector, limit?, namespace? })`
- `embed(text)`
