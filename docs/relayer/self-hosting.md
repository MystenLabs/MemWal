---
title: "Self-Hosting"
---

Self-hosting means running your own relayer — either pointing at an existing MemWal package ID or deploying an entirely new MemWal instance with your own contract, database, and server wallet.

The public relayer provided by Mysten is a reference implementation. You can also build your own implementation that fits the protocol interface with custom logic. This guide covers how to run the reference implementation as your own self-hosted relayer.

## When to Self-Host

The most common reasons are removing the trust assumption on a third-party relayer or running your own MemWal instance entirely:

- **Control the trust boundary** — a self-hosted relayer keeps plaintext, encryption, and embedding under your own control
- **Run your own MemWal instance** — deploy your own contract with a separate package ID, SEAL encryption keys, and data isolation
- **Choose your own embedding provider** — use your own OpenAI-compatible API and credentials
- **Guarantee availability** — the public relayer is a beta service with no SLA

## What Runs

A self-hosted MemWal backend has:

| Component | Location | Description |
|-----------|----------|-------------|
| **Rust relayer** | `services/server` | Axum HTTP server — auth, routing, embedding, vector search |
| **TypeScript sidecar** | `services/server/scripts` | SEAL encrypt/decrypt, Walrus upload, blob query (uses `@mysten/seal` and `@mysten/walrus`) |
| **PostgreSQL + pgvector** | External | Vector storage, auth cache, indexer state |
| **Indexer** (recommended) | `services/indexer` | Polls Sui events, syncs account data into PostgreSQL |

The Rust relayer starts the TypeScript sidecar as a child process on boot. They communicate over HTTP (`localhost:9000` by default). If the sidecar fails to start within 15 seconds, the relayer exits.

## Quick Start

If you already have PostgreSQL + pgvector running:

```bash
cp services/server/.env.example services/server/.env
cd services/server/scripts && npm ci
cd ../ && cargo run
cd ../indexer && cargo run
```

Then check:

```bash
curl http://localhost:8000/health
```

## Environment Variables

### Required

- `DATABASE_URL`
- `MEMWAL_PACKAGE_ID`
- `MEMWAL_REGISTRY_ID`
- `SERVER_SUI_PRIVATE_KEY` or `SERVER_SUI_PRIVATE_KEYS`
- `SEAL_KEY_SERVERS` — comma-separated list of SEAL key server object IDs

### Recommended

- `OPENAI_API_KEY` — enables real embeddings (falls back to mock embeddings without it)
- `OPENAI_API_BASE` — point to an OpenAI-compatible provider like OpenRouter

### Defaults

- `PORT` defaults to `8000`
- `SIDECAR_URL` defaults to `http://localhost:9000`
- `SUI_NETWORK` defaults to `mainnet`
- `SUI_RPC_URL`, Walrus endpoints, and `WALRUS_PACKAGE_ID` fall back to network defaults based on `SUI_NETWORK`

### Server Keys

- `SERVER_SUI_PRIVATE_KEY` is the main server key
- `SERVER_SUI_PRIVATE_KEYS` is a comma-separated key pool for parallel Walrus uploads
- if both are set, the key pool takes priority for uploads

## Testnet Contract IDs

```env
SUI_NETWORK=testnet
MEMWAL_PACKAGE_ID=0x12b28adbe55c25341f08b8ad9ac69462aab917048c7cd5b736d951200090ee3f
MEMWAL_REGISTRY_ID=0xfb8a1d298e2a73bdab353da3fcb3b16f68ab7d1f392f3a5c4944c747c026fc05
```

For SEAL key server object IDs on testnet, see https://seal-docs.wal.app/Pricing.

<Note>
`VITE_MEMWAL_PACKAGE_ID` and `VITE_MEMWAL_REGISTRY_ID` are frontend env vars for the app or playground — not for the relayer.
</Note>

## Database Setup

The relayer requires PostgreSQL with the `pgvector` extension. The relayer runs migrations automatically on boot, creating these tables:

- `vector_entries` — 1536-dimensional embeddings with HNSW index for cosine similarity search
- `delegate_key_cache` — auth optimization (delegate key → account mapping)
- `accounts` — populated by the indexer (account → owner mapping)
- `indexer_state` — indexer cursor tracking

See [Database Sync](/indexer/database-sync) for the full schema.

## Operational Notes

- The server starts the sidecar automatically on boot — if sidecar startup fails, the relayer will exit
- DB migrations run automatically on boot (`pgvector` must already be installed as a PostgreSQL extension)
- Connection pool: 10 max connections (relayer), 3 max connections (indexer)
- `/health` is the basic service check, API routes live under `/api/*`
- The indexer is recommended for fast account lookup in production — without it, the relayer falls back to onchain registry scans
- Without `OPENAI_API_KEY`, the server uses deterministic mock embeddings (hash-based) — useful for local testing but not production

## Docker

- `services/server/Dockerfile` for the relayer
- `services/indexer/Dockerfile` for the indexer

## Read Next

- [Relayer API](/relayer/api-reference)
