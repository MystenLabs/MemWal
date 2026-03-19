# Choose Your Path

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
