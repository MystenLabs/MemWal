---
title: "Environment Variables"
---

Use this page when you run your own relayer.
For setup steps and deployment context, see [Self-Hosting](/relayer/self-hosting).

## Required

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. `pgvector` must already exist |
| `MEMWAL_PACKAGE_ID` | Sui package ID. See [Contract Overview](/contract/overview) |
| `MEMWAL_REGISTRY_ID` | Onchain registry object ID. See [Contract Overview](/contract/overview) |
| `SEAL_SERVER_CONFIGS` or `SEAL_KEY_SERVERS` | SEAL server config used by the sidecar for encrypt and decrypt. Prefer `SEAL_SERVER_CONFIGS` for committee servers |

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
| `SEAL_THRESHOLD` | `min(2, total configured weight)` | Required configured server weight for SEAL encrypt/decrypt |
| `ENOKI_API_KEY` | none | Optional Enoki key for sponsored sidecar transactions |
| `ENOKI_NETWORK` | `mainnet` | Network used for Enoki-sponsored flows |

## Notes

- If both `SERVER_SUI_PRIVATE_KEYS` and `SERVER_SUI_PRIVATE_KEY` are set, the key pool takes priority for uploads.
- `OPENAI_API_KEY` and `OPENAI_API_BASE` control the embedding and fact-extraction provider used by `remember`, `recall`, `analyze`, `ask`, and restore re-indexing.
- Without `OPENAI_API_KEY`, the server can fall back to mock embeddings. That is useful for local testing, not for normal production behavior.
- `SUI_NETWORK` drives the default RPC URL, Walrus endpoints, Walrus package ID, and upload relay selection.
- `SEAL_SERVER_CONFIGS` is a JSON array of `{ objectId, weight, aggregatorUrl?, apiKeyName?, apiKey? }`. Committee key server configs require `aggregatorUrl`.
- `SEAL_KEY_SERVERS` is the legacy comma-separated independent key server list. It is only used when `SEAL_SERVER_CONFIGS` is unset.
- If `SUI_NETWORK=testnet` and neither SEAL variable is set, the sidecar defaults to the official Mysten testnet committee config: `[{"objectId":"0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98","weight":1,"aggregatorUrl":"https://seal-aggregator-testnet.mystenlabs.com"}]`.
- Mainnet committee mode is supported through `SEAL_SERVER_CONFIGS`, but do not hardcode a mainnet default until Mysten publishes the object ID and aggregator URL.
- The sidecar `POST /walrus/upload` route defaults Walrus storage epochs by network and caps uploads at `5` epochs: effective defaults are `5` on `testnet` and `3` on `mainnet` unless the request explicitly passes a lower `epochs` value.
- `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` are server env vars. Do not replace them with `VITE_*` app env vars.
- For network-specific `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` values, see [Contract Overview](/contract/overview).
