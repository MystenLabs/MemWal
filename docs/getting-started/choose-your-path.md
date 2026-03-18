# Choose Your Path

## Path 1: Default SDK

Use `@cmdoss/memwal` when you want the fastest route to a working integration.
The relayer handles embedding, encryption, Walrus upload, retrieval, and restore.

Go to: [SDK Overview](/sdk/overview)

## Path 2: Public Relayer

Use this when you are evaluating MemWal during beta and do not want to run PostgreSQL,
Walrus, the Rust server, and the sidecar yourself yet.

Go to: [Public Relayer](/relayer/public-relayer)

## Path 3: Full Client-Side Manual Flow

Use `@cmdoss/memwal/manual` when you want the client to handle SEAL encryption,
Walrus downloads, and embedding calls directly.

Go to: [SDK Usage](/sdk/usage)

## Path 4: AI Middleware

Use `@cmdoss/memwal/ai` when you already have an AI SDK pipeline and want recall plus
auto-save behavior around generation.

Go to: [AI Integration](/sdk/ai-integration)

## Path 5: Self-Host the Relayer

Use this when you need tighter operational control or want your own deployment for the beta.

Go to: [Self-Hosting](/relayer/self-hosting)

## Recommended Order

For most teams, the best order is:

1. start with the default SDK
2. use a dedicated namespace
3. validate the public relayer path
4. move to self-hosting only when your product needs it
