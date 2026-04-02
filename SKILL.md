---
name: memwal
version: 0.0.1
description: |
  Privacy-first AI memory SDK for decentralized storage on Sui blockchain with Walrus.

  Use when users say:
  - "add memory to my app"
  - "store encrypted memories"
  - "integrate MemWal"
  - "AI agent memory"
  - "persistent memory SDK"
  - "Walrus memory storage"
  - "setup MemWal"
  - "recall memories"

keywords:
  - memwal
  - memory sdk
  - ai memory
  - encrypted memory
  - walrus storage
  - sui blockchain
  - delegate key
  - semantic search
  - vercel ai sdk
---

# MemWal — Privacy-First AI Memory SDK

MemWal is a TypeScript SDK for persistent, encrypted AI memory. It stores memories on Walrus (decentralized storage), encrypts them with SEAL, enforces ownership onchain via Sui smart contracts, and retrieves them with semantic (vector) search. Memories are scoped by `owner + namespace` — each namespace is an isolated memory space.

---

## When to Use

Use MemWal when your app or agent needs:

- **Persistent memory** across sessions, devices, or restarts
- **Encrypted storage** — end-to-end encryption, only the owner and authorized delegates can decrypt
- **Semantic recall** — retrieve memories by meaning, not just keywords
- **Decentralized storage** — no single point of failure, stored on Walrus
- **Onchain ownership** — cryptographically enforced access control on Sui
- **Cross-app memory** — share memory between apps via delegate keys

---

## When NOT to Use

- Temporary conversation context that only matters in the current session
- Large file storage (MemWal is optimized for text memories)
- Use cases that don't need encryption or decentralization

---

## Installation

```bash
# Install the SDK
pnpm add @mysten-incubation/memwal

# Optional: for Vercel AI SDK integration
pnpm add ai zod

# Optional: for manual client (client-side SEAL encryption)
pnpm add @mysten/sui @mysten/seal @mysten/walrus
```

---

## Quick Start

### 1. Get Your Credentials

You need a **delegate key** (Ed25519 private key) and **account ID** (MemWalAccount object ID on Sui).

Generate them at:
- Production: https://memwal.ai or https://memwal.wal.app
- Staging: https://staging.memwal.ai

### 2. Initialize the SDK

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: "<your-ed25519-private-key-hex>",
  accountId: "<your-memwal-account-id>",
  serverUrl: "https://relayer.memwal.ai",
  namespace: "my-app",
});
```

### 3. Store and Recall Memories

```ts
// Store a memory
await memwal.remember("User prefers dark mode and works in TypeScript.");

// Recall by meaning
const result = await memwal.recall("What are the user's preferences?");
console.log(result.results);

// Extract and store facts from text
await memwal.analyze("I live in Hanoi and prefer dark mode.");

// Check relayer health
await memwal.health();
```

---

## SDK Entry Points

| Entry Point | Import | Description |
|---|---|---|
| `MemWal` | `@mysten-incubation/memwal` | **Default.** Relayer handles embedding, SEAL encryption, Walrus upload, vector search |
| `MemWalManual` | `@mysten-incubation/memwal/manual` | Manual flow — client handles embedding and SEAL encryption |
| `withMemWal` | `@mysten-incubation/memwal/ai` | Vercel AI SDK middleware — auto recall + save around AI conversations |
| Account utils | `@mysten-incubation/memwal/account` | Account creation, delegate key management |

---

## API Surface

### MemWal Methods

| Method | Description | Returns |
|---|---|---|
| `remember(text, namespace?)` | Store one memory (relayer embeds, encrypts, uploads) | `{ id, blob_id, owner, namespace }` |
| `recall(query, limit?, namespace?)` | Semantic search for memories | `{ results: [{ blob_id, text, distance }], total }` |
| `analyze(text, namespace?)` | Extract facts via LLM, store each as a memory | `{ facts: [{ text, id, blob_id }], total, owner }` |
| `restore(namespace, limit?)` | Rebuild missing index entries from Walrus | `{ restored, skipped, total, namespace, owner }` |
| `health()` | Check relayer health | `{ status, version }` |
| `getPublicKeyHex()` | Get hex-encoded public key | `string` |

### Lower-Level Methods

| Method | Description |
|---|---|
| `rememberManual({ blobId, vector, namespace? })` | Register pre-uploaded blob with pre-computed vector |
| `recallManual({ vector, limit?, namespace? })` | Search with pre-computed vector (returns blob IDs only) |
| `embed(text)` | Generate embedding vector (no storage) |

---

## Configuration

### MemWalConfig

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `key` | `string` | Yes | — | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | — | MemWalAccount object ID on Sui |
| `serverUrl` | `string` | No | `http://localhost:8000` | Relayer URL |
| `namespace` | `string` | No | `"default"` | Default namespace for memory isolation |

### Managed Relayer Endpoints

| Network | Relayer URL |
|---|---|
| **Production** (mainnet) | `https://relayer.memwal.ai` |
| **Staging** (testnet) | `https://relayer.staging.memwal.ai` |

---

## Vercel AI SDK Integration

```ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { withMemWal } from "@mysten-incubation/memwal/ai";

const model = withMemWal(openai("gpt-4o"), {
  key: "<your-delegate-key>",
  accountId: "<your-account-id>",
  serverUrl: "https://relayer.memwal.ai",
  namespace: "chat",
  maxMemories: 5,
  autoSave: true,
  minRelevance: 0.3,
});

const result = streamText({
  model,
  messages: [{ role: "user", content: "What do you remember about me?" }],
});
```

The middleware automatically:
- Recalls relevant memories before generation
- Extracts and saves facts from conversations after generation

---

## OpenClaw / NemoClaw Plugin

For OpenClaw agent integration, use the `@mysten-incubation/oc-memwal` plugin.

### Install

```bash
openclaw plugins install @mysten-incubation/oc-memwal
```

### Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": { "memory": "oc-memwal" },
    "entries": {
      "oc-memwal": {
        "enabled": true,
        "config": {
          "privateKey": "${MEMWAL_PRIVATE_KEY}",
          "accountId": "0x...",
          "serverUrl": "https://relayer.memwal.ai"
        }
      }
    }
  }
}
```

Lifecycle hooks run automatically:
- `before_prompt_build` — injects relevant memories as context
- `before_reset` — saves session summary
- `agent_end` — captures last response

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `health()` returns error | Check relayer URL is correct and reachable |
| `recall()` returns empty | Verify namespace matches what was used in `remember()` |
| `401 Unauthorized` | Verify delegate key is correct and registered on the account |
| SDK import errors | Run `pnpm add @mysten-incubation/memwal` — check Node.js ≥ 18 |
| Manual client errors | Install peer deps: `@mysten/sui @mysten/seal @mysten/walrus` |

---

## Links

- **Docs**: https://docs.memwal.ai
- **SDK on npm**: https://www.npmjs.com/package/@mysten-incubation/memwal
- **GitHub**: https://github.com/CommandOSSLabs/MemWal
- **Dashboard**: https://memwal.ai
- **llms.txt**: https://docs.memwal.ai/llms.txt
