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
| `EMBEDDING_API_KEY` | none | Separate API key for the embedding provider. Falls back to `OPENAI_API_KEY` when unset |
| `EMBEDDING_API_BASE` | none | Separate base URL for the embedding provider. Falls back to `OPENAI_API_BASE` when unset |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model identifier. Accepts any model supported by your embedding provider |
| `EMBEDDING_DIMENSIONS` | none | Request a specific output dimension from the embedding model (e.g. `1024` for Jina). Omitted from the API call when unset |
| `LLM_MODEL` | `openai/gpt-4o-mini` | LLM model used for fact extraction (`/api/analyze`) and retrieval-augmented chat (`/api/ask`) |
| `WALRUS_PACKAGE_ID` | network default | Override the Walrus on-chain package used by the sidecar |
| `WALRUS_UPLOAD_RELAY_URL` | network default | Override the Walrus upload relay used by the sidecar |
| `ENOKI_API_KEY` | none | Optional Enoki key for sponsored sidecar transactions |
| `ENOKI_NETWORK` | `mainnet` | Network used for Enoki-sponsored flows |

## Notes

- If both `SERVER_SUI_PRIVATE_KEYS` and `SERVER_SUI_PRIVATE_KEY` are set, the key pool takes priority for uploads.
- `OPENAI_API_KEY` and `OPENAI_API_BASE` control the LLM provider used for fact extraction and chat. They also serve as the embedding provider fallback when `EMBEDDING_API_KEY` / `EMBEDDING_API_BASE` are unset.
- Set `EMBEDDING_API_KEY`, `EMBEDDING_API_BASE`, and `EMBEDDING_MODEL` to use a dedicated embedding provider (e.g. Jina, Cohere) independently of the LLM provider.
- Without `OPENAI_API_KEY` (and without `EMBEDDING_API_KEY`), the server falls back to mock embeddings. That is useful for local testing, not for production.
- **Do not mix embedding dimensions across memories in the same namespace.** Cosine similarity queries require all vectors to have the same dimension. If you switch embedding providers, truncate `vector_entries` and run `ALTER TABLE vector_entries ALTER COLUMN embedding TYPE vector(<n>);` before restarting. The server logs a warning at boot if the schema dimension does not match `EMBEDDING_DIMENSIONS`.
- `SUI_NETWORK` drives the default RPC URL, Walrus endpoints, Walrus package ID, and upload relay selection.
- The sidecar `POST /walrus/upload` route defaults Walrus storage epochs by network: `50` on `testnet` (about 50 days) and `2` on `mainnet` (about 4 weeks), unless the request explicitly passes `epochs`.
- `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` are server env vars. Do not replace them with `VITE_*` app env vars.
- For network-specific `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` values, see [Contract Overview](/contract/overview).
