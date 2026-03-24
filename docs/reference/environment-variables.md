---
title: "Environment Variables"
---

Use this page when you run your own relayer.

## Required

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. `pgvector` must already exist |
| `MEMWAL_PACKAGE_ID` | Sui package ID |
| `MEMWAL_REGISTRY_ID` | Onchain registry object ID |
| `SEAL_KEY_SERVERS` | Comma-separated SEAL key server object IDs used by the sidecar for encrypt and decrypt |

## Usually Required

These are not all enforced at boot, but most real deployments need them.

| Variable | Notes |
| --- | --- |
| `SERVER_SUI_PRIVATE_KEY` | Primary server key for backend decrypt and Walrus actions |
| `OPENAI_API_KEY` | Server-side key used to call the embedding and fact-extraction provider |

## Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8000` | Relayer port |
| `SIDECAR_URL` | `http://localhost:9000` | Sidecar HTTP endpoint |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `SUI_NETWORK` | `mainnet` | Picks the fallback RPC URL and network-driven service defaults |
| `SUI_RPC_URL` | network default | Override the Sui fullnode URL |
| `WALRUS_PUBLISHER_URL` | Walrus mainnet publisher | Override upload endpoint |
| `WALRUS_AGGREGATOR_URL` | Walrus mainnet aggregator | Override download endpoint |
| `SERVER_SUI_PRIVATE_KEYS` | none | Comma-separated upload key pool. Takes priority over `SERVER_SUI_PRIVATE_KEY` for uploads |
| `MEMWAL_ACCOUNT_ID` | none | Optional account ID in server config |
| `WALRUS_PACKAGE_ID` | network default | Override the Walrus on-chain package used by the sidecar |
| `WALRUS_UPLOAD_RELAY_URL` | network default | Override the Walrus upload relay used by the sidecar |
| `ENOKI_API_KEY` | none | Optional Enoki key for sponsored sidecar transactions |
| `ENOKI_NETWORK` | `mainnet` | Network used for Enoki-sponsored flows |

## Notes

- If both `SERVER_SUI_PRIVATE_KEYS` and `SERVER_SUI_PRIVATE_KEY` are set, the key pool takes priority for uploads.
- `OPENAI_API_KEY` and `OPENAI_API_BASE` are how a self-hosted relayer calls your embedding provider.
- The relayer uses them for `remember`, `recall`, `analyze`, `ask`, and restore re-indexing.
- `SEAL_KEY_SERVERS` is required for the sidecar SEAL encrypt and decrypt path.
- `SUI_NETWORK` now drives the default RPC URL, Walrus endpoints, Walrus package ID, and upload relay selection.
- `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` are server env vars. Do not replace them with `VITE_*` app env vars.
- For testnet, use `MEMWAL_PACKAGE_ID=0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6` and `MEMWAL_REGISTRY_ID=0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437`.
- Without `OPENAI_API_KEY`, the server can fall back to mock embeddings. That is useful for local testing, not for normal production behavior.
- The Rust server starts the TypeScript sidecar automatically.
- `/health` is the fastest way to confirm the relayer is up.
