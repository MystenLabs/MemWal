---
title: "Choose Your Path"
---

MemWal supports several integration modes depending on how much control you need. Pick the one that fits your use case.

<Tip>
These paths aren't mutually exclusive. You can combine them — for example, use the **Default SDK** with the **AI Middleware**, or start with the **Public Relayer** and move to **Self-Hosting** later. They all share the same backend and data layer.
</Tip>

## 1. Default SDK

Use `@cmdoss/memwal` when you want the fastest working integration.

- relayer handles embedding, encryption, retrieval, and restore
- best starting point for most teams

Go to: [SDK Overview](/sdk/overview)

## 2. Public Relayer

Use this when you want to evaluate MemWal without running the backend yourself.

Go to: [Public Relayer](/relayer/public-relayer)

## 3. Manual Client Flow

Use `@cmdoss/memwal/manual` when you want full client-side control over encryption and embeddings. Recommended for Web3-native users who want to minimize trust in the relayer — it never sees your plaintext data.

- client handles embeddings and SEAL encryption locally
- relayer only sees encrypted payloads and vectors

Go to: [SDK Usage](/sdk/usage)

## 4. AI Middleware

Use `@cmdoss/memwal/ai` when you already use the AI SDK and want recall plus auto-save behavior.

Go to: [AI Integration](/sdk/ai-integration)

## 5. Self-Host the Relayer

Use this when you need full control over the trust boundary — your infrastructure, your credentials, no third party sees your data.

Go to: [Self-Hosting](/relayer/self-hosting)
