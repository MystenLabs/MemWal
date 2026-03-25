---
title: "API Reference"
---

See also:

- [Configuration](/reference/configuration)
- [Relayer API](/relayer/api-reference)

## `MemWal.create(config)`

```ts
MemWal.create(config: MemWalConfig): MemWal
```

Config:

| Property | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `key` | `string` | Yes | — | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | — | MemWalAccount object ID on Sui |
| `serverUrl` | `string` | No | `http://localhost:8000` | Relayer URL |
| `namespace` | `string` | No | `"default"` | Default namespace for memory isolation |

For the full config surface, see [Configuration](/reference/configuration).

## `MemWal` Methods

### `remember(text, namespace?): Promise<RememberResult>`

Store one memory through the relayer. The relayer handles embedding, SEAL encryption, Walrus upload, and vector indexing.

**Returns:**

```ts
{
  id: string;        // UUID for this entry
  blob_id: string;   // Walrus blob ID
  owner: string;     // Owner Sui address
  namespace: string; // Namespace used
}
```

### `recall(query, limit?, namespace?): Promise<RecallResult>`

Search for memories matching a natural language query, scoped to `owner + namespace`.

- `limit` defaults to `10`

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

### `analyze(text, namespace?): Promise<AnalyzeResult>`

Extract memorable facts from text using an LLM, then store each fact as a separate memory.

**Returns:**

```ts
{
  facts: Array<{
    text: string;     // Extracted fact
    id: string;       // UUID
    blob_id: string;  // Walrus blob ID
  }>;
  total: number;
  owner: string;
}
```

### `restore(namespace, limit?): Promise<RestoreResult>`

Rebuild missing indexed entries for one namespace from Walrus. Incremental — only re-indexes blobs that aren't already in the local database.

- `limit` defaults to `50`

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

Check relayer health. Does not require authentication.

**Returns:** `{ status: string, version: string }`

### `getPublicKeyHex(): Promise<string>`

Return the hex-encoded public key for the current delegate key.

### Lower-level methods

These exist on the `MemWal` class for advanced use cases:

| Method | Description |
|--------|-------------|
| `rememberManual({ blobId, vector, namespace? })` | Register a pre-uploaded blob ID with a pre-computed vector |
| `recallManual({ vector, limit?, namespace? })` | Search with a pre-computed query vector (returns blob IDs, no decryption) |
| `embed(text)` | Generate an embedding vector for text (no storage) |

## `MemWalManual`

```ts
import { MemWalManual } from "@mysten-incubation/memwal/manual";
```

See [MemWalManual usage](/sdk/usage/memwal-manual) for the full setup and flow details.

### `rememberManual(text, namespace?): Promise<RememberManualResult>`

Embed locally, SEAL encrypt locally, send encrypted payload + vector to relayer for Walrus upload and vector registration.

### `recallManual(query, limit?, namespace?): Promise<RecallManualResult>`

Embed locally, search via relayer, download from Walrus, SEAL decrypt locally. Returns decrypted text results.

### `restore(namespace, limit?): Promise<RestoreResult>`

Same as `MemWal.restore()` — delegates to the relayer.

### `isWalletMode: boolean`

Whether this client uses a connected wallet signer (vs. raw keypair).

### Config notes

- `suiNetwork` defaults to `mainnet`
- `sealKeyServers` lets the client override the built-in SEAL key server object IDs
- All `@mysten/*` peer dependencies are loaded dynamically — only needed if you use `MemWalManual`

## `withMemWal`

```ts
import { withMemWal } from "@mysten-incubation/memwal/ai";
```

Wraps a Vercel AI SDK model with automatic memory recall and save.

**Before generation:**
- Reads the last user message
- Runs `recall()` against MemWal
- Filters by minimum relevance (`minRelevance`, default `0.3`)
- Injects matching memories into the prompt as a system message

**After generation:**
- Optionally runs `analyze()` on the user message (fire-and-forget)
- Saves extracted facts asynchronously

**Options** (extends `MemWalConfig`):

| Option | Default | Description |
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

| Function | Description |
|----------|-------------|
| `generateDelegateKey()` | Generate a new Ed25519 keypair (returns `privateKey`, `publicKey`, `suiAddress`) |
| `createAccount(opts)` | Create a new MemWalAccount on-chain (one per Sui address) |
| `addDelegateKey(opts)` | Add a delegate key to an account (owner only) |
| `removeDelegateKey(opts)` | Remove a delegate key from an account (owner only) |

## Utility Functions

```ts
import { delegateKeyToSuiAddress, delegateKeyToPublicKey } from "@mysten-incubation/memwal";
```

| Function | Description |
|----------|-------------|
| `delegateKeyToSuiAddress(privateKeyHex)` | Derive the Sui address from a delegate private key |
| `delegateKeyToPublicKey(privateKeyHex)` | Get the 32-byte public key from a delegate private key |
