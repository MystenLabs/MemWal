# Usage

This page lists the current public SDK surface in one place.

## Namespace Rules

- set a default namespace in `create(...)` when one app or tenant uses one boundary
- pass `namespace` per call when one client needs multiple boundaries
- if omitted, namespace falls back to client config, then to `"default"`

## `MemWal`

Use `MemWal` when you want the relayer to handle the main workflow.

### Create

```ts
const memwal = MemWal.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "chatbot-prod",
});
```

Config:

- `key`
- `serverUrl?`
- `namespace?`

### Main Methods

- `remember(text, namespace?)`: store text as memory
- `recall(query, limit?, namespace?)`: return decrypted matches
- `analyze(text, namespace?)`: extract facts and store them
- `restore(namespace, limit?)`: rebuild missing indexed entries for one namespace
- `health()`: check relayer health
- `getPublicKeyHex()`: return the current public key

### Lower-Level Methods

- `rememberManual({ blobId, vector, namespace? })`
- `recallManual({ vector, limit?, namespace? })`
- `embed(text)`

### Restore

```ts
const result = await memwal.restore("chatbot-prod", 50);
console.log(result);
```

Restore is:

- incremental
- namespace-scoped
- meant to repair PostgreSQL vector state from Walrus-backed memory

## `MemWalManual`

Use `MemWalManual` when the client must handle embeddings and local SEAL operations.

### Create

```ts
const manual = MemWalManual.create({
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  suiPrivateKey: process.env.SUI_PRIVATE_KEY!,
  embeddingApiKey: process.env.OPENAI_API_KEY!,
  packageId: process.env.MEMWAL_PACKAGE_ID!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  namespace: "chatbot-prod",
});
```

Key config fields:

- `key`
- `serverUrl?`
- `suiPrivateKey?` or `walletSigner?`
- `embeddingApiKey`
- `embeddingApiBase?`
- `embeddingModel?`
- `packageId`
- `accountId`
- `namespace?`

### Main Methods

- `rememberManual(text, namespace?)`: embed locally, encrypt locally, then send encrypted payload plus vector to the relayer
- `recallManual(query, limit?, namespace?)`: embed locally, search through the relayer, download blobs, and decrypt locally
- `restore(namespace, limit?)`: call the same relayer restore endpoint
- `isWalletMode`: tells you whether the client uses a connected wallet signer

## `withMemWal`

Use `withMemWal(model, options)` when your app already uses the AI SDK.

```ts
const model = withMemWal(openai("gpt-4o"), {
  key: process.env.MEMWAL_PRIVATE_KEY!,
  serverUrl: process.env.MEMWAL_SERVER_URL,
  namespace: "chatbot-prod",
});
```

Behavior:

- recall before generation
- inject memory context
- optional `analyze()` after generation

Options:

- `key`, `serverUrl?`, `namespace?`
- `maxMemories?`
- `autoSave?`
- `minRelevance?`
- `debug?`

## Recommended Paths

- `MemWal`: best default for most integrations
- `MemWalManual`: use when you need client-managed embeddings and local SEAL work
- `withMemWal`: use when you already run the AI SDK
