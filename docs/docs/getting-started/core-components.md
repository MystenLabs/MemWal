# Core Components

MemWal is a stack, not a single package.

## SDK

- `MemWal`: default relayer-backed client
- `MemWalManual`: manual client flow
- `withMemWal`: AI middleware

Main `MemWal` methods:

- `remember(text, namespace?)`
- `recall(query, limit?, namespace?)`
- `analyze(text, namespace?)`
- `restore(namespace, limit?)`
- `health()`

## Relayer

The relayer verifies signed requests and runs the main workflows.

Routes:

- `POST /api/remember`
- `POST /api/recall`
- `POST /api/remember/manual`
- `POST /api/recall/manual`
- `POST /api/analyze`
- `POST /api/ask`
- `POST /api/restore`
- `GET /health`

## Contract

- owner and delegate-key model on Sui

## Indexer

- syncs account data into PostgreSQL
- helps the backend resolve owners and accounts faster

## Storage and Search

- Walrus stores encrypted blobs
- SEAL supports encryption and decryption flows
- PostgreSQL + pgvector stores searchable vector metadata
