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
  key: process.env.MEMWAL_PRIVATE_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai",
  namespace: "my-app",
});
```

### 3. Store and Recall Memories

```ts
// Store one already-distilled fact and wait until it is indexed.
await memwal.rememberAndWait(
  "User prefers dark mode and works in TypeScript.",
  undefined,
  { timeoutMs: 30_000 },
);

// Recall by meaning
const result = await memwal.recall("What are the user's preferences?");
console.log(result.results);

// Extract facts from free-form text and wait until all accepted facts are indexed.
const analyzed = await memwal.analyzeAndWait(
  "I live in Hanoi and prefer dark mode.",
  undefined,
  { timeoutMs: 30_000 },
);
console.log(analyzed.facts.map((fact) => fact.text));

// Check relayer health
await memwal.health();
```

Use `*AndWait` when a workshop UI saves and then immediately recalls in the
same flow. Indexing can lag by a few seconds, so `remember()` / `analyze()`
may return before recall can find the new memory. Manual polling is still
available for advanced async UIs:

```ts
const accepted = await memwal.remember("User likes Sui.");
const stored = await memwal.waitForRememberJob(accepted.job_id, {
  pollIntervalMs: 750,
  timeoutMs: 30_000,
});
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
| `remember(text, namespace?)` | Accept one memory job immediately | `{ job_id, status }` |
| `rememberAndWait(text, namespace?, opts?)` | Store one memory and wait for completion | `{ id, job_id, blob_id, owner, namespace }` |
| `recall(query, limitOrOptions?, namespace?)` | Semantic search for memories | `{ results: [{ blob_id, text, distance }], total }` |
| `analyze(text, namespace?)` | Extract facts and accept one memory job per fact | `{ job_ids, facts, fact_count, status, owner }` |
| `analyzeAndWait(text, namespace?, opts?)` | Extract facts and wait for all fact jobs to complete | `{ results, facts, total, succeeded, failed, owner }` |
| `restore(namespace, limit?)` | Rebuild missing index entries from Walrus | `{ restored, skipped, total, namespace, owner }` |
| `health()` | Check relayer health | `{ status, version }` |
| `getPublicKeyHex()` | Get hex-encoded public key | `string` |

### Lower-Level Methods

| Method | Description |
|---|---|
| `rememberManual({ blobId, vector, namespace? })` | Register pre-uploaded blob with pre-computed vector |
| `recallManual({ vector, limit?, namespace? })` | Search with pre-computed vector (returns blob IDs only) |
| `embed(text)` | Generate embedding vector (no storage) |

### All Response Shapes

```ts
interface RememberAcceptedResult {
  job_id: string;
  status: string;
}

interface RememberJobStatus {
  job_id: string;
  status: "pending" | "running" | "uploaded" | "done" | "failed" | "not_found";
  owner?: string;
  namespace?: string;
  blob_id?: string;
  error?: string;
}

interface RememberResult {
  id: string;
  job_id?: string;
  blob_id: string;
  owner: string;
  namespace: string;
}

interface RecallMemory {
  blob_id: string;
  text: string;
  distance: number;
}

interface RecallResult {
  results: RecallMemory[];
  total: number;
}

interface RecallOptions {
  limit?: number;
  topK?: number;
  namespace?: string;
  maxDistance?: number;
}

interface RememberBulkAcceptedResult {
  job_ids: string[];
  total: number;
  status: string;
}

interface AnalyzedFact {
  text: string;
  id: string;
  job_id?: string;
  blob_id?: string;
}

interface AnalyzeResult {
  job_ids: string[];
  facts: AnalyzedFact[];
  fact_count: number;
  status: string;
  owner: string;
}

interface RememberBulkStatusItem {
  job_id: string;
  status: "pending" | "running" | "uploaded" | "done" | "failed" | "not_found";
  blob_id?: string;
  error?: string;
}

interface RememberBulkStatusResult {
  results: RememberBulkStatusItem[];
}

interface RememberBulkItemResult {
  id: string;
  blob_id: string;
  status: "done" | "failed" | "timeout";
  namespace: string;
  error?: string;
}

interface RememberBulkResult {
  results: RememberBulkItemResult[];
  total: number;
  succeeded: number;
  failed: number;
}

interface AnalyzeWaitResult extends RememberBulkResult {
  facts: AnalyzedFact[];
  owner: string;
}

interface EmbedResult {
  vector: number[];
}

interface RestoreResult {
  restored: number;
  skipped: number;
  total: number;
  namespace: string;
  owner: string;
}

interface HealthResult {
  status: string;
  version: string;
  mode?: string;
  prompt_versions?: {
    extract: string;
    ask: string;
  };
  relayerVersion?: string;
  apiVersion?: string;
  minSupportedSdk?: {
    typescript: string;
    python: string;
    mcp: string;
  };
  featureFlags?: Record<string, boolean>;
  deprecations?: Array<{
    surface: string;
    deprecatedSince: string;
    removalApiVersion: string;
    guidance: string;
  }>;
  build?: {
    commit?: string;
    buildTimestamp?: string;
  };
}
```

`facts[].text` is the extracted fact text to render in UIs. `job_ids[]`
aligns with the accepted fact jobs; use `analyzeAndWait()` when the UI needs
those facts indexed before continuing.

### Recall Distance and Filtering

`recall()` returns the closest K memories by vector distance. There is no
default relevance threshold, so small namespaces may return weak filler results
because they are still the closest available matches.

Lower distance means more similar:

| Distance | Rough meaning |
|---|---|
| `< 0.25` | Duplicate or very close |
| `0.25 - 0.55` | Related |
| `0.55 - 0.7` | Weak/noisy |
| `>= 0.7` | Usually unrelated |

Use SDK-side filtering when you only want clearly relevant results:

```ts
const memories = await memwal.recall("what did I eat yesterday?", {
  topK: 10,
  namespace: "reading-tracker",
  maxDistance: 0.7,
});
```

Equivalent manual filtering:

```ts
const memories = await memwal.recall("what did I eat yesterday?", 10, "reading-tracker");
const relevant = memories.results.filter((memory) => memory.distance < 0.7);
```

---

## Configuration

### MemWalConfig

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `key` | `string` | Yes | — | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | — | MemWalAccount object ID on Sui |
| `serverUrl` | `string` | No | `https://relayer.memwal.ai` | Relayer URL |
| `namespace` | `string` | No | `"default"` | Default namespace for memory isolation |

### Managed Relayer Endpoints

| Network | Relayer URL |
|---|---|
| **Production** (mainnet) | `https://relayer.memwal.ai` |
| **Staging** (testnet) | `https://relayer.staging.memwal.ai` |

### Framework and Key Handling

Delegate private keys belong on the server only. In Next.js App Router, call
MemWal from server actions, route handlers, or other server-only modules that
read `MEMWAL_PRIVATE_KEY` from server env.

`"use server"` files can only export async functions; keep constants, schemas,
and reusable client builders in a separate server-only module.

```ts
// app/actions/memory.ts
"use server";

import { getMemWal } from "@/lib/memwal";

export async function savePreference(text: string) {
  const memwal = getMemWal();
  return memwal.rememberAndWait(text, "my-app", { timeoutMs: 30_000 });
}
```

```ts
// lib/memwal.ts
import "server-only";
import { MemWal } from "@mysten-incubation/memwal";

export function getMemWal() {
  return MemWal.create({
    key: process.env.MEMWAL_PRIVATE_KEY!,
    accountId: process.env.MEMWAL_ACCOUNT_ID!,
    serverUrl: process.env.MEMWAL_SERVER_URL ?? "https://relayer.memwal.ai",
    namespace: "my-app",
  });
}
```

Namespace strategy: `owner + namespace` is the isolation boundary. Use one
namespace per app by default, then split by user, team, or feature when a
single app needs separate memory spaces.

Relayer choice: use staging/testnet for learning and prototypes; use
production/mainnet for production data. Do not mix staging credentials with
mainnet relayer configs.

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
| `recall()` returns unrelated filler | Recall is top-K without a default relevance threshold; filter by `distance`, for example `distance < 0.7` |
| `401 Unauthorized` | Usually wrong `MEMWAL_PRIVATE_KEY`, key not registered on the account, account ID mismatch, or staging/mainnet mismatch. Check `.env.local` and dashboard credentials |
| SDK import errors | Run `pnpm add @mysten-incubation/memwal` — check Node.js ≥ 18 |
| Manual client errors | Install peer deps: `@mysten/sui @mysten/seal @mysten/walrus` |
| Direct Sui reads fail or examples look stale | Prefer `SuiGrpcClient` from `@mysten/sui/grpc`; JSON-RPC snippets using `SuiClient` / `getFullnodeUrl` may be stale |
| `forget` expectations are unclear | Current relayer `POST /api/forget` removes vector index rows so memories are unrecallable; Walrus blobs persist until epoch expiry |

---

## Links

- **Docs**: https://docs.memwal.ai
- **SDK on npm**: https://www.npmjs.com/package/@mysten-incubation/memwal
- **GitHub**: https://github.com/CommandOSSLabs/MemWal
- **Dashboard**: https://memwal.ai
- **llms.txt**: https://docs.memwal.ai/llms.txt
