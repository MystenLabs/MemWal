---
title: "Operate Your Own Relayer"
---

Run your own relayer when you need your own backend, secrets, and rollout control.

## Use It When

- you want your own deployment environment
- you want your own database and credentials
- you want to control relayer upgrades and uptime
- you want the server to use your own embedding provider credentials

## What Runs

A self-hosted MemWal backend usually has:

- the Rust relayer in `services/server`
- the TypeScript sidecar in `services/server/scripts`
- PostgreSQL with pgvector
- optional but recommended: the indexer in `services/indexer`

## Local Run Flow

1. create a PostgreSQL database with `pgvector`
2. copy `services/server/.env.example` to `services/server/.env`
3. fill in the required env vars
4. install sidecar deps in `services/server/scripts`
5. run the Rust server from `services/server`
6. optionally run the indexer from `services/indexer`

## Quick Start

If you already have PostgreSQL + pgvector running, the shortest path is:

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

Use this quick start for local evaluation. For production operation, review the full env setup
and key configuration below.

## Testnet Contract IDs

If you want to run your own relayer on testnet, use these server env vars:

```env
SUI_NETWORK=testnet
MEMWAL_PACKAGE_ID=0x12b28adbe55c25341f08b8ad9ac69462aab917048c7cd5b736d951200090ee3f
MEMWAL_REGISTRY_ID=0xfb8a1d298e2a73bdab353da3fcb3b16f68ab7d1f392f3a5c4944c747c026fc05
```

Important:

- use `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` in `services/server/.env`
- `VITE_MEMWAL_PACKAGE_ID` and `VITE_MEMWAL_REGISTRY_ID` are for the app or playground, not for the relayer
- the current server config still requires `MEMWAL_REGISTRY_ID`

If you want the relayer to create real embeddings, set:

- `OPENAI_API_KEY`
- `OPENAI_API_BASE`

The relayer uses these values to call an OpenAI-compatible `/embeddings` API during `remember`,
`recall`, `analyze`, `ask`, and restore re-indexing.

You also need:

- `SEAL_KEY_SERVERS`

The sidecar uses this comma-separated list of object IDs for backend SEAL encrypt and decrypt.

## Commands

Install sidecar dependencies:

```bash
cd services/server/scripts
npm ci
```

Start the relayer:

```bash
cd services/server
cargo run
```

The server starts the sidecar automatically through `npx tsx sidecar-server.ts`.

Start the indexer:

```bash
cd services/indexer
cargo run
```

## What To Expect

- the relayer listens on `http://localhost:8000` by default
- the sidecar listens on `http://localhost:9000` by default
- the server runs DB migrations automatically on boot
- `/health` is the first endpoint to test

## Required For A Working Relayer

- `DATABASE_URL`
- `SUI_RPC_URL`
- `WALRUS_PUBLISHER_URL`
- `WALRUS_AGGREGATOR_URL`
- `MEMWAL_PACKAGE_ID`
- `MEMWAL_REGISTRY_ID`
- `SERVER_SUI_PRIVATE_KEY` or `SERVER_SUI_PRIVATE_KEYS`

## Recommended But Context-Dependent

- `OPENAI_API_KEY`: lets the relayer call your embedding provider for real embeddings
- `OPENAI_API_BASE`: use this when your provider is not the default OpenAI base URL
- `SEAL_KEY_SERVERS`: required for backend SEAL encrypt and decrypt
- indexer: recommended for fast account lookup, especially outside quick local testing

## Docker Path

If you want to deploy the relayer as a container, use:

- `services/server/Dockerfile` for the relayer
- `services/indexer/Dockerfile` for the indexer

## Read Next

- [Installation and Setup](/relayer/installation-and-setup)
- [Relayer API](/reference/relayer-api)
