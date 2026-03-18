# Installation and Setup

The relayer environment is configured through the Rust service and its environment variables.

## Required Environment Variables

From `services/server/.env.example`, the main settings are:

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

## Supporting Services

- PostgreSQL with pgvector
- Walrus publisher and aggregator
- Sui fullnode RPC
- embedding provider compatible with the configured API base

## Operational Notes

- the relayer exposes `/health` for service checks
- the API routes live under `/api/*`
- account lookup depends on the supporting indexer and database state
