# Installation and Setup

The relayer is configured through environment variables and starts its sidecar automatically.

## Main Environment Variables

- `PORT`
- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_API_BASE`
- `SUI_NETWORK`
- `SUI_RPC_URL`
- `WALRUS_PUBLISHER_URL`
- `WALRUS_AGGREGATOR_URL`
- `SERVER_SUI_PRIVATE_KEY`
- `SERVER_SUI_PRIVATE_KEYS`
- `SEAL_KEY_SERVERS`
- `MEMWAL_PACKAGE_ID`
- `MEMWAL_REGISTRY_ID`
- `WALRUS_PACKAGE_ID`
- `WALRUS_UPLOAD_RELAY_URL`
- `ENOKI_API_KEY`
- `ENOKI_NETWORK`
- `SIDECAR_URL`

## Defaults That Matter

- `PORT` defaults to `8000`
- `SIDECAR_URL` defaults to `http://localhost:9000`
- `SUI_RPC_URL` falls back to a network default based on `SUI_NETWORK`
- `SUI_NETWORK` now defaults to `mainnet`
- Walrus endpoints fall back to mainnet defaults if not overridden
- `WALRUS_PACKAGE_ID` and `WALRUS_UPLOAD_RELAY_URL` also follow `SUI_NETWORK` if not set

## Setup Checklist

1. create `services/server/.env`
2. set `DATABASE_URL`
3. set `OPENAI_API_KEY` and, if needed, `OPENAI_API_BASE`
4. set contract and network values
5. set `SEAL_KEY_SERVERS`
6. set Walrus endpoints
7. set one server key or a key pool
8. install `services/server/scripts` dependencies
9. run `cargo run` in `services/server`

## Contract IDs

For a testnet relayer setup, use:

```env
SUI_NETWORK=testnet
MEMWAL_PACKAGE_ID=0x12b28adbe55c25341f08b8ad9ac69462aab917048c7cd5b736d951200090ee3f
MEMWAL_REGISTRY_ID=0xfb8a1d298e2a73bdab353da3fcb3b16f68ab7d1f392f3a5c4944c747c026fc05
```

Notes:

- the relayer uses `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID`
- `MEMWAL_REGISTRY_ID` is still required by the current server config
- `VITE_MEMWAL_PACKAGE_ID` and `VITE_MEMWAL_REGISTRY_ID` are frontend env vars for the app or playground

## Embedding Provider

- `OPENAI_API_KEY` is the server-side key used for embedding and fact extraction
- `OPENAI_API_BASE` lets you point the relayer to an OpenAI-compatible provider such as OpenRouter
- when these are set, the relayer calls the provider directly during `remember`, `recall`, `analyze`,
  `ask`, and restore re-indexing
- without `OPENAI_API_KEY`, the relayer falls back to mock embeddings for local testing

## SEAL Key Servers

- `SEAL_KEY_SERVERS` is a comma-separated list of SEAL key server object IDs
- the sidecar uses this list for backend SEAL encrypt and decrypt operations
- the server no longer relies on hardcoded testnet key server IDs
- make sure the list matches the selected `SUI_NETWORK`
- for testnet setup, use https://seal-docs.wal.app/Pricing to find the current SEAL key server object IDs

## Notes On Keys

- `SERVER_SUI_PRIVATE_KEY` is the main server key
- `SERVER_SUI_PRIVATE_KEYS` is a comma-separated key pool for parallel Walrus uploads
- if both are set, the key pool takes priority for uploads

## Database Behavior

- the server connects to PostgreSQL on boot
- migrations in `services/server/migrations` run automatically
- `pgvector` must already be available in the database

## Sidecar Behavior

- the Rust server starts the TypeScript sidecar on boot
- the sidecar handles backend SEAL and Walrus operations
- if sidecar startup fails, the relayer will fail fast on boot

## Operational Notes

- `/health` is the basic service check
- API routes live under `/api/*`
- account lookup improves when the indexer is running
- `OPENAI_API_KEY` + `OPENAI_API_BASE` control which embedding API the relayer calls
- `SEAL_KEY_SERVERS` controls which SEAL key servers the sidecar trusts
- without `OPENAI_API_KEY`, the server can fall back to mock embeddings, but that is not the normal production path
