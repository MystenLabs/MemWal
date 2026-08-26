---
title: API Reference
description: >-
  Complete API reference for the Walrus Memory SDK, including method signatures, config fields, and return types for MemWal, MemWalManual, withMemWal, account management, and utility functions.
keywords:
  - Walrus Memory
  - MemWal
  - API reference
  - method signatures
  - SDK methods
  - config
goal:
  description: Look up the exact method signature, parameter types, return type, and thrown errors for any Walrus Memory SDK method or config field before writing code that calls it.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - What are the method signatures for the Walrus Memory SDK?
  - What config options does MemWal.create accept?
  - What does the recall method return in Walrus Memory?
answer: >-
  The Walrus Memory SDK API includes MemWal (remember, recall, analyze, restore, health, rememberBulk, and more), MemWalManual (rememberManual, recallManual, restore), withMemWal (AI SDK middleware), account management utilities (createAccount, addDelegateKey, removeDelegateKey, generateDelegateKey), and utility functions for delegate key operations.
---

See also:

- [Configuration](/reference/configuration)
- [Relayer API](/relayer/api-reference)

## `MemWal.create(config)`

```ts
MemWal.create(config: MemWalConfig): MemWal
```

Config:

| **Property** | **Type** | **Required** | **Default** | **Notes** |
| --- | --- | --- | --- | --- |
| `key` | `string` | Yes | none | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | none | MemWalAccount object ID on Sui |
| `serverUrl` | `string` | No | `https://relayer.memory.walrus.xyz` | Relayer URL |
| `namespace` | `string` | No | `"default"` | Default namespace for memory isolation |

For the full config surface, see [Configuration](/reference/configuration).

## `MemWal` Methods

You can call these methods on any client that `MemWal.create()` returns.

### `remember(text, namespace?): Promise<RememberAcceptedResult>`

Submit one memory through the relayer. The method returns after the relayer creates a background job; embedding, Seal encryption, Walrus upload, and vector indexing continue asynchronously.

**Returns:**

{/* memwal:import packages/sdk/src/types.ts#RememberAcceptedResult */}
```ts
/** Result from remember() / rememberAsync() */
export interface RememberAcceptedResult {
    job_id: string;
    status: string;
}
```
{/* /memwal:import */}

### `rememberAndWait(text, namespace?, opts?): Promise<RememberResult>`

Submit one memory and poll until the background job completes.

**Returns:**

{/* memwal:import packages/sdk/src/types.ts#RememberResult */}
```ts
/** Result from rememberAndWait() / waitForRememberJob() */
export interface RememberResult {
    /** Stable server job_id used as the vector row id. */
    id: string;
    /** Async job id returned by remember(). */
    job_id?: string;
    blob_id: string;
    owner: string;
    namespace: string;
}
```
{/* /memwal:import */}

### `waitForRememberJob(jobId, opts?): Promise<RememberResult>`

Poll a previously accepted remember job until it reaches `done` or `failed`.

### `rememberBulk(items): Promise<RememberBulkAcceptedResult>`

Submit up to 20 memories in one request and return the accepted job IDs immediately.

**Returns:**

{/* memwal:import packages/sdk/src/types.ts#RememberBulkAcceptedResult */}
```ts
/** Result from rememberBulk() / rememberBulkAsync() */
export interface RememberBulkAcceptedResult {
    job_ids: string[];
    total: number;
    status: string;
}
```
{/* /memwal:import */}

### `rememberBulkAndWait(items, opts?): Promise<RememberBulkResult>`

Submit a bulk remember request and wait until every job reaches a terminal state.

### `recall(params): Promise<RecallResult>`

Search for memories matching a natural language query, scoped to `owner + namespace`.

- Preferred form: `recall({ query, limit?, topK?, namespace?, maxDistance? })`
- `limit` defaults to `10`; `topK` is an alias and wins when both are set
- Legacy positional forms still work: `recall(query)`, `recall(query, limit)`, `recall(query, limit, namespace)`, and `recall(query, options)`
- `maxDistance` filters weak matches client-side by dropping results where `distance >= maxDistance`

**Returns:**

```ts
{
  results: Array<{
    blob_id: string;   // Walrus blob ID
    text: string;      // Decrypted plaintext
    distance: number;  // Cosine distance (lower = more similar)
  }>;
  total: number;
}
```

`distance` is cosine distance, so lower values mean a closer match.

### `analyze(text, namespace?): Promise<AnalyzeResult>`

Extract memorable facts from text using an LLM, then return accepted background jobs for storing each fact.

**Returns:**

```ts
{
  job_ids: string[];
  facts: Array<{
    text: string;     // Extracted fact
    id: string;       // Same value as job_id
    job_id: string;   // Polling id
  }>;
  fact_count: number;
  status: string;     // Usually "pending"
  owner: string;
}
```

Use `analyzeAndWait(text, namespace?, opts?)` to wait for every extracted fact job to finish and return per-job storage results.

### `restore(namespace, limit?): Promise<RestoreResult>`

Rebuild missing indexed entries for one namespace from Walrus. This runs incrementally: it re-indexes only the blobs your local database does not already hold.

- `limit` defaults to `10`

**Returns:**

```ts
{
  restored: number;   // Entries newly indexed
  skipped: number;    // Entries already in DB
  total: number;      // Total blobs found on-chain
  namespace: string;
  owner: string;
}
```

### `health(): Promise<HealthResult>`

Check relayer health. You do not need authentication, so a successful response confirms only that the relayer answers, not that your `key` and `accountId` work. A signed call such as `remember()` or `recall()` can still fail with `401` immediately after a passing `health()`.

**Returns:** `{ status: string, version: string, relayerVersion?: string, apiVersion?: string, minSupportedSdk?: ... }`

### `compatibility(): Promise<RelayerVersionMetadata>`

Fetch and validate the relayer compatibility contract from `/version`. Protected SDK calls run this check before signing the first request and raise `MemWalCompatibilityError` when the SDK/relayer pair is unsupported.

### `getPublicKeyHex(): Promise<string>`

Return the hex-encoded public key for the current delegate key.

### Lower-level methods

These exist on the `MemWal` class for advanced use cases:

| **Method** | **Description** |
|--------|-------------|
| `rememberManual({ encryptedData, vector, namespace? })` | Send SEAL-encrypted bytes + a pre-computed vector; the relayer uploads to Walrus |
| `recallManual({ vector, limit?, namespace? })` | Search with a pre-computed query vector (returns blob IDs, no decryption) |
| `embed(text)` | Generate an embedding vector for text (no storage) |

## `MemWalManual`

```ts
import { MemWalManual } from "@mysten-incubation/memwal/manual";
```

See [MemWalManual usage](/sdk/usage/memwal-manual) for the full setup and flow details.

### `rememberManual(text, namespace?): Promise<RememberManualResult>`

Embed locally, Seal encrypt locally, then send the encrypted payload and vector to the relayer for Walrus upload and vector registration.

### `recallManual(query, limit?, namespace?): Promise<RecallManualResult>`

Embed locally, search through the relayer, download from Walrus, then Seal decrypt locally. Returns decrypted text results.

### `restore(namespace, limit?): Promise<RestoreResult>`

Same as `MemWal.restore()`, which delegates to the relayer.

### `isWalletMode: boolean`

Whether this client uses a connected wallet signer rather than a raw keypair.

### Config notes

- `suiNetwork` defaults to `mainnet`
- `sealServerConfigs` lets the client configure independent or committee Seal servers; committee entries require `aggregatorUrl`
- `sealKeyServers` remains supported as a legacy independent key server object ID override
- All `@mysten/*` peer dependencies load dynamically, so you need them only when you use `MemWalManual`

## `withMemWal`

```ts
import { withMemWal } from "@mysten-incubation/memwal/ai";
```

Wraps a Vercel AI SDK model with automatic memory recall and save.

**Before generation:**
- Reads the last user message
- Runs `recall()` against Walrus Memory
- Filters by minimum relevance (`minRelevance`, default `0.3`)
- Injects matching memories into the prompt as a system message

**After generation:**
- Optionally runs `analyze()` on the user message (fire-and-forget)
- Saves extracted facts asynchronously

**Options** (extends `MemWalConfig`):

| **Option** | **Default** | **Description** |
|--------|---------|-------------|
| `maxMemories` | `5` | Max memories to inject per request |
| `autoSave` | `true` | Auto-save new facts from conversation |
| `minRelevance` | `0.3` | Minimum similarity score (0–1) to include a memory |
| `debug` | `false` | Enable debug logging |

See [Configuration](/reference/configuration) for all options.

## Account Management

```ts
import {
  createAccount,
  addDelegateKey,
  removeDelegateKey,
  generateDelegateKey,
} from "@mysten-incubation/memwal/account";
```

| **Function** | **Description** |
|----------|-------------|
| `generateDelegateKey()` | Generate a new Ed25519 keypair (returns `privateKey`, `publicKey`, `suiAddress`) |
| `createAccount(opts)` | Create a new MemWalAccount onchain (one per Sui address) |
| `addDelegateKey(opts)` | Add a delegate key to an account (owner only) |
| `removeDelegateKey(opts)` | Remove a delegate key from an account (owner only) |

`addDelegateKey` and `removeDelegateKey` require the shared `registryId` alongside the package and account IDs.

## Utility Functions

```ts
import { delegateKeyToSuiAddress, delegateKeyToPublicKey } from "@mysten-incubation/memwal";
```

| **Function** | **Description** |
|----------|-------------|
| `delegateKeyToSuiAddress(privateKeyHex)` | Derive the Sui address from a delegate private key |
| `delegateKeyToPublicKey(privateKeyHex)` | Get the 32-byte public key from a delegate private key |
