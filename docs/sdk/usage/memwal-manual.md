---
title: "MemWalManual"
description: "Client-managed embeddings and local SEAL operations."
---

Use when the client must handle embedding calls and local SEAL operations. The relayer still handles
upload relay, registration, search, and restore.

```ts
import { MemWalManual } from "@mysten/memwal/manual";

const manual = MemWalManual.create({
  key: "<your-ed25519-private-key>",
  serverUrl: "https://your-relayer-url.com",
  suiPrivateKey: "<your-sui-private-key>",
  embeddingApiKey: "<your-openai-api-key>",
  packageId: "<memwal-package-id>",
  accountId: "<memwal-account-id>",
  namespace: "chatbot-prod",
});
```

## Core Methods

```ts
// Embed locally, encrypt locally, relay encrypted payload + vector
await manual.rememberManual("User prefers dark mode.");

// Embed locally, search via relayer, download and decrypt locally
const result = await manual.recallManual("What do we know?", 5);

// Same relayer restore endpoint
await manual.restore("chatbot-prod", 50);

// Check if using a connected wallet signer
console.log(manual.isWalletMode);
```

## Config Notes

- `suiNetwork` defaults to `mainnet`
- `sealKeyServers` lets the client override the built-in SEAL key server object IDs
- Walrus publisher, aggregator, and upload relay defaults follow `suiNetwork`
- Use `walletSigner` instead of `suiPrivateKey` when integrating with a connected wallet
