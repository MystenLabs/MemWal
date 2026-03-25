---
title: "Choose Your Path"
---

MemWal supports several integration modes depending on how much control you need. Pick the one that fits your use case.

<Tip>
These paths aren't mutually exclusive. You can combine them - for example, use the **Default SDK** with the **AI Middleware**, or start with the **Managed Relayer** and move to **Self-Hosting** later. They all share the same backend and data layer.
</Tip>

## 1. Default SDK

Use `@mysten-incubation/memwal` when you want the fastest working integration.

- relayer handles embedding, encryption, retrieval, and restore
- best starting point for most teams

Go to: [SDK Overview](/sdk/overview)

## 2. Managed Relayer

Use a hosted relayer, or deploy your own [self-hosted relayer](/relayer/self-hosting) with access to a wallet funded with WAL and SUI.

<Note>
Following endpoints are provided as public good by Walrus Foundation.
</Note>

| Network | Relayer URL |
| --- | --- |
| **Production** (mainnet) | `https://relayer.memwal.ai` |
| **Staging** (testnet) | `https://relayer.staging.memwal.ai` |

Go to: [Managed Relayer](/relayer/public-relayer)

## 3. Manual Client Flow

Use `@mysten-incubation/memwal/manual` when you want full client-side control over encryption and embeddings. Recommended for Web3-native users who want to minimize trust in the relayer - it never sees your plaintext data.

- client handles embeddings and SEAL encryption locally
- relayer only sees encrypted payloads and vectors

Go to: [SDK Usage](/sdk/usage)

## 4. AI Middleware

Use `@mysten-incubation/memwal/ai` when you already use the AI SDK and want recall plus auto-save behavior.

Go to: [AI Integration](/sdk/usage/with-memwal)

## 5. Self-Host the Relayer

Use this when you need full control over the trust boundary - your infrastructure, your credentials, no third party sees your data.

Go to: [Self-Hosting](/relayer/self-hosting)
