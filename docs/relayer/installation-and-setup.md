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
- `MEMWAL_PACKAGE_ID`
- `MEMWAL_REGISTRY_ID`
- `SIDECAR_URL`

## Defaults That Matter

- `PORT` defaults to `8000`
- `SIDECAR_URL` defaults to `http://localhost:9000`
- `SUI_RPC_URL` falls back to a network default based on `SUI_NETWORK`
- Walrus endpoints fall back to testnet defaults if not overridden

## Setup Checklist

1. create `services/server/.env`
2. set `DATABASE_URL`
3. set `OPENAI_API_KEY` and, if needed, `OPENAI_API_BASE`
4. set contract and network values
5. set Walrus endpoints
6. set one server key or a key pool
7. install `services/server/scripts` dependencies
8. run `cargo run` in `services/server`

## Embedding Provider

- `OPENAI_API_KEY` is the server-side key used for embedding and fact extraction
- `OPENAI_API_BASE` lets you point the relayer to an OpenAI-compatible provider such as OpenRouter
- when these are set, the relayer calls the provider directly during `remember`, `recall`, `analyze`,
  `ask`, and restore re-indexing
- without `OPENAI_API_KEY`, the relayer falls back to mock embeddings for local testing

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
- without `OPENAI_API_KEY`, the server can fall back to mock embeddings, but that is not the normal production path
