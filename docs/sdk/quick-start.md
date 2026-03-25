---
title: "Quick Start"
description: "Install the MemWal SDK and store your first memory in under a minute."
---

The MemWal SDK gives your app persistent, encrypted memory — store, recall, and analyze context across sessions. It exposes three entry points:

| Entry point | Import | When to use |
| --- | --- | --- |
| `MemWal` | `@mysten-incubation/memwal` | **Recommended default** for most integrations — relayer handles embeddings, SEAL, and storage |
| `MemWalManual` | `@mysten-incubation/memwal/manual` | You need client-managed embeddings and local SEAL operations |
| `withMemWal` | `@mysten-incubation/memwal/ai` | You already use the Vercel AI SDK and want memory as middleware |

## Installation

<CodeGroup>

```bash npm
npm install @mysten-incubation/memwal
```

```bash pnpm
pnpm add @mysten-incubation/memwal
```

```bash yarn
yarn add @mysten-incubation/memwal
```

</CodeGroup>

For `MemWalManual`, you also need the optional peer dependencies:

<CodeGroup>

```bash npm
npm install @mysten/sui @mysten/seal @mysten/walrus
```

```bash pnpm
pnpm add @mysten/sui @mysten/seal @mysten/walrus
```

```bash yarn
yarn add @mysten/sui @mysten/seal @mysten/walrus
```

</CodeGroup>

For `withMemWal`, you also need:

<CodeGroup>

```bash npm
npm install ai zod
```

```bash pnpm
pnpm add ai zod
```

```bash yarn
yarn add ai zod
```

</CodeGroup>

## Configuration

`MemWal.create` takes a config object with the following fields:

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string` | Yes | Ed25519 private key in hex |
| `accountId` | `string` | Yes | MemWalAccount object ID on Sui |
| `serverUrl` | `string` | No | Relayer URL — use `https://relayer.memwal.ai` (mainnet) or `https://relayer.staging.memwal.ai` (testnet) for the [managed relayer](/relayer/public-relayer) |
| `namespace` | `string` | No | Default namespace — falls back to `"default"` |

## First Memory

```ts
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: "<your-ed25519-private-key>",
  accountId: "<your-memwal-account-id>",
  serverUrl: "https://your-relayer-url.com",
  namespace: "demo",
});

await memwal.health();
await memwal.remember("I live in Hanoi and prefer dark mode.");

const result = await memwal.recall("What do we know about this user?");
console.log(result.results);
```

## Next Steps

- [Usage](/sdk/usage) — all three clients in detail, namespace rules, and restore
- [API Reference](/sdk/api-reference) — full method signatures and config fields
