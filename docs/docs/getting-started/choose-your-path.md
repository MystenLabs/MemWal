# Choose Your Path

MemWal supports several integration modes depending on how much control you need. Pick the one that fits your use case.

:::tip
These paths aren't mutually exclusive. You can combine them — for example, use the **Default SDK** with the **AI Middleware**, or start with the **Public Relayer** and move to **Self-Hosting** later. They all share the same backend and data layer.
:::

## 1. Default SDK

Use `@cmdoss/memwal` when you want the fastest working integration.

- relayer handles embedding, encryption, retrieval, and restore
- best starting point for most teams

Go to: [SDK Overview](/sdk/overview)

## 2. Public Relayer

Use this when you want to evaluate MemWal without running the backend yourself.

Go to: [Public Relayer](/relayer/public-relayer)

## 3. Manual Client Flow

Use `@cmdoss/memwal/manual` when the client must handle embeddings and local SEAL operations.

- relayer still handles upload relay, registration, search, and restore

Go to: [SDK Usage](/sdk/usage)

## 4. AI Middleware

Use `@cmdoss/memwal/ai` when you already use the AI SDK and want recall plus auto-save behavior.

Go to: [AI Integration](/sdk/ai-integration)

## 5. Self-Host the Relayer

Use this when you need your own infra, credentials, and rollout control.

Go to: [Self-Hosting](/relayer/self-hosting)
