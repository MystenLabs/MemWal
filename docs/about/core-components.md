# Core Components

MemWal is a stack, not a single package.

## SDK

There are three main SDK surfaces:

- `MemWal` from `@cmdoss/memwal` for the default relayer-backed flow
- `MemWalManual` from `@cmdoss/memwal/manual` for the manual client flow
- `withMemWal` from `@cmdoss/memwal/ai` for AI SDK middleware integration

For the default path, the main methods are:

- `remember(text, namespace?)`
- `recall(query, limit?, namespace?)`
- `analyze(text, namespace?)`
- `restore(namespace, limit?)`
- `health()`

## Relayer Backend

The relayer verifies signed requests and runs the main memory workflows.

The current Rust server exposes:

- `POST /api/remember`
- `POST /api/recall`
- `POST /api/remember/manual`
- `POST /api/recall/manual`
- `POST /api/analyze`
- `POST /api/ask`
- `POST /api/restore`
- `GET /health`

It also starts a TypeScript sidecar for SEAL and Walrus operations.

## Smart Contract

The onchain contract represents the MemWal account model, including ownership and delegate-key
authorization on Sui.

## Indexer

The indexer syncs account data into PostgreSQL so the backend can resolve owners and accounts faster.

## Walrus and SEAL

- Walrus stores encrypted memory blobs
- SEAL handles encryption and decryption
- Walrus metadata is also used during restore to discover blobs by owner and namespace

## PostgreSQL and pgvector

PostgreSQL is the coordination and search layer for:

- vector similarity search
- owner plus namespace lookup
- blob-to-vector mappings
- account and delegate caches
- indexer state
