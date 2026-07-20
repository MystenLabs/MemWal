---
title: Headless SDK Setup
description: "Initialize the Walrus Memory SDK in a server or agent runtime with no interactive or browser steps, loading credentials from the environment."
keywords: [headless, server, agent runtime, setup, MemWal.create, environment variables, delegate key, accountId, MemWalManual, SDK]
---

A server or agent runtime has no human to click through a wallet or paste a key at a prompt. This page shows how to initialize the Walrus Memory SDK entirely from configuration, so you can drop it into a backend service, a cron job, or an autonomous agent. For the full write-confirm-recall loop that builds on this setup, see [Agent Storage Loop](/sdk/agent-storage-loop).

## Generate credentials once

The SDK authenticates every request with an Ed25519 delegate key tied to a `MemWalAccount` object on Sui. Generate the account ID and delegate key once through the dashboard, then store them as secrets:

- **Mainnet:** [memory.walrus.xyz](https://memory.walrus.xyz)
- **Testnet:** [staging.memory.walrus.xyz](https://staging.memory.walrus.xyz)

This is the only step that involves a browser. Your runtime never opens one.

## Initialize from the environment

Load the credentials from environment variables and construct the client at startup. Call `health()` immediately so a bad key or an unreachable relayer fails at boot rather than on the first write:

```ts service.ts
import { MemWal } from "@mysten-incubation/memwal";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const memwal = MemWal.create({
  key: requireEnv("MEMWAL_PRIVATE_KEY"),
  accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
  // Mainnet relayer. Use https://relayer-staging.memory.walrus.xyz for Testnet.
  serverUrl: "https://relayer.memory.walrus.xyz",
  namespace: "service-memory",
});

// Fail fast at boot instead of on the first write mid-run.
await memwal.health();
```

The `MemWal.create` config takes four fields:

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string` | Yes | Ed25519 delegate private key in hex |
| `accountId` | `string` | Yes | `MemWalAccount` object ID on Sui |
| `serverUrl` | `string` | No | Relayer URL for your network. Pass it explicitly so the target network is unambiguous |
| `namespace` | `string` | No | Default namespace, falls back to `"default"` |

<Note>
The SDK reads the delegate key from the `key` config field, not from any specific environment variable. The examples in these docs use both `MEMWAL_PRIVATE_KEY` and `MEMWAL_KEY` as the variable name for that value. Pick one name and use it consistently across your project.
</Note>

<Warning>
Recall is scoped per **account plus namespace**. Never hardcode an account ID copied from docs or another project, and never share one delegate key across tenants that should not read each other's memories. Load every credential from the environment.
</Warning>

## When to use the manual client

The default `MemWal` client lets the relayer handle embedding and Seal encryption on your behalf, which is the right choice for most runtimes. Use `MemWalManual` only when the runtime must hold its own keys and keep plaintext entirely client-side. The manual client requires a few more fields, because it performs Seal encryption and signs Sui operations itself:

```ts
import { MemWalManual } from "@mysten-incubation/memwal/manual";

const manual = MemWalManual.create({
  key: requireEnv("MEMWAL_PRIVATE_KEY"),
  accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
  packageId: requireEnv("MEMWAL_PACKAGE_ID"),
  serverUrl: "https://relayer.memory.walrus.xyz",
  // The runtime signs Seal and Walrus operations with its own Sui key.
  suiPrivateKey: requireEnv("SUI_PRIVATE_KEY"),
  embeddingApiKey: requireEnv("OPENAI_API_KEY"),
  suiNetwork: "mainnet",
  namespace: "service-memory",
});
```

For the complete client-managed flow, see [MemWalManual](/sdk/usage/memwal-manual).

## References

- [Agent Storage Loop](/sdk/agent-storage-loop)
- [Walrus Memory client](/sdk/usage/memwal)
- [Public relayer](/relayer/public-relayer)
- [Environment Variables](/reference/environment-variables)
- [API Reference](/sdk/api-reference)
