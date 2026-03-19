# Environment Variables

Use this page when you run your own relayer.

## Required

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. `pgvector` must already exist |
| `MEMWAL_PACKAGE_ID` | Sui package ID |
| `MEMWAL_REGISTRY_ID` | Onchain registry object ID |

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
| `SUI_NETWORK` | `testnet` | Picks the fallback RPC URL |
| `SUI_RPC_URL` | network default | Override the Sui fullnode URL |
| `WALRUS_PUBLISHER_URL` | Walrus testnet publisher | Override upload endpoint |
| `WALRUS_AGGREGATOR_URL` | Walrus testnet aggregator | Override download endpoint |
| `SERVER_SUI_PRIVATE_KEYS` | none | Comma-separated upload key pool. Takes priority over `SERVER_SUI_PRIVATE_KEY` for uploads |
| `MEMWAL_ACCOUNT_ID` | none | Optional account ID in server config |

## Notes

- If both `SERVER_SUI_PRIVATE_KEYS` and `SERVER_SUI_PRIVATE_KEY` are set, the key pool takes priority for uploads.
- `OPENAI_API_KEY` and `OPENAI_API_BASE` are how a self-hosted relayer calls your embedding provider.
- The relayer uses them for `remember`, `recall`, `analyze`, `ask`, and restore re-indexing.
- Without `OPENAI_API_KEY`, the server can fall back to mock embeddings. That is useful for local testing, not for normal production behavior.
- The Rust server starts the TypeScript sidecar automatically.
- `/health` is the fastest way to confirm the relayer is up.
