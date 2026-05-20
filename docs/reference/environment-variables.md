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
| `SIDECAR_AUTH_TOKEN` | Shared secret for Rust-to-sidecar calls. The sidecar refuses to start without it |

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
| `RUST_LOG` | `memwal_server=info,tower_http=info` | Rust tracing filter for relayer logs |
| `LOG_FORMAT` | pretty text | Set to `json` for machine-parseable structured logs |
| `SIDECAR_URL` | `http://localhost:9000` | Sidecar HTTP endpoint |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `SUI_NETWORK` | `mainnet` | Picks the fallback RPC URL and network-driven service defaults |
| `SUI_RPC_URL` | network default | Override the Sui fullnode URL |
| `WALRUS_PUBLISHER_URL` | Walrus mainnet publisher | Override upload endpoint |
| `WALRUS_AGGREGATOR_URL` | Walrus mainnet aggregator | Override download endpoint |
| `WALRUS_AGGREGATOR_URLS` | none | Optional comma-separated extra aggregator/proxy endpoints for cold-read tail racing. `WALRUS_AGGREGATOR_URL` remains the primary |
| `WALRUS_AGGREGATOR_RACE_AFTER_MS` | `150` | Delay before launching the next configured aggregator on a cold read. `0` races all candidates immediately |
| `WALRUS_SKIP_CONSISTENCY_CHECK` | `false` | Appends `skip_consistency_check=true` to trusted MemWal cold reads. Keep disabled unless you accept the consistency tradeoff |
| `BLOB_CACHE_TTL_SECS` | `1209600` | Redis TTL for cached SEAL ciphertext by `blob_id`. `0` disables blob cache use |
| `BLOB_CACHE_MAX_BYTES` | `524288` | Maximum SEAL ciphertext bytes cached in Redis. Larger blobs stay Walrus-only; `0` disables blob cache use |
| `SERVER_SUI_PRIVATE_KEYS` | none | Comma-separated upload key pool. Takes priority over `SERVER_SUI_PRIVATE_KEY` for uploads |
| `MEMWAL_ACCOUNT_ID` | none | Optional account ID in server config |
| `WALRUS_PACKAGE_ID` | network default | Override the Walrus on-chain package used by the sidecar |
| `WALRUS_UPLOAD_RELAY_URL` | network default | Override the Walrus upload relay used by the sidecar |
| `SEAL_THRESHOLD` | `min(2, total configured weight)` | Required configured server weight for SEAL encrypt/decrypt |
| `ENOKI_API_KEY` | none | Optional Enoki key for sponsored sidecar transactions |
| `ENOKI_NETWORK` | `mainnet` | Network used for Enoki-sponsored flows |
| `ENOKI_FALLBACK_TO_DIRECT_SIGN` | `false` | If true, sidecar pays gas directly with the server wallet when Enoki sponsorship fails or is not configured |
| `MEMWAL_RELAYER_URL` | `http://127.0.0.1:$PORT` | Relayer URL passed from the Rust server to the sidecar for MCP tool calls |
| `MCP_MAX_TOTAL_SESSIONS` | `1000` | Maximum active MCP sessions across SSE and Streamable HTTP transports |
| `MCP_MAX_SESSIONS_PER_IP` | `16` | Maximum active MCP sessions from one source IP |
| `MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN` | `30` | Maximum new MCP sessions opened by one source IP per minute |

## Notes

- If both `SERVER_SUI_PRIVATE_KEYS` and `SERVER_SUI_PRIVATE_KEY` are set, the key pool takes priority for uploads. Upload jobs use the pool in round-robin order.
- Keep `ENOKI_FALLBACK_TO_DIRECT_SIGN=false` in production if the server wallet should not pay gas when sponsorship is missing, expired, or rejected.
- `OPENAI_API_KEY` and `OPENAI_API_BASE` control the embedding and fact-extraction provider used by `remember`, `recall`, `analyze`, `ask`, and restore re-indexing.
- `WALRUS_AGGREGATOR_URLS` is only used after the Redis ciphertext cache misses. Put low-latency cache/proxy endpoints first after the primary and keep 404/5xx cache TTLs short in your proxy.
- `WALRUS_SKIP_CONSISTENCY_CHECK=true` should only be used for trusted blobs written by the relayer. Restore keeps consistency checks enabled for on-chain-discovered blobs.
- Without `OPENAI_API_KEY`, the server can fall back to mock embeddings. That is useful for local testing, not for normal production behavior.
- `SUI_NETWORK` drives the default RPC URL, Walrus endpoints, Walrus package ID, and upload relay selection.
- `SEAL_SERVER_CONFIGS` is a JSON array of `{ objectId, weight, aggregatorUrl?, apiKeyName?, apiKey? }`. Committee key server configs require `aggregatorUrl`.
- `SEAL_KEY_SERVERS` is the legacy comma-separated independent key server list. It is only used when `SEAL_SERVER_CONFIGS` is unset.
- If neither SEAL variable is set, the sidecar uses built-in independent key server defaults for `SUI_NETWORK`: two testnet servers on `testnet`, and Overclock + Studio Mirai on `mainnet`.
- Committee mode is supported through `SEAL_SERVER_CONFIGS` when you need an aggregator-backed key server.
- The sidecar `POST /walrus/upload` route defaults Walrus storage epochs by network: `50` on `testnet` (about 50 days) and `2` on `mainnet` (about 4 weeks), unless the request explicitly passes `epochs`.
- `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` are server env vars. Do not replace them with `VITE_*` app env vars.
- For network-specific `MEMWAL_PACKAGE_ID` and `MEMWAL_REGISTRY_ID` values, see [Contract Overview](/contract/overview).
- `MEMWAL_RELAYER_URL` is only needed when the sidecar should call a different relayer URL than the Rust server's local port. The Rust server sets it automatically to `http://127.0.0.1:$PORT` for the managed sidecar when it starts.
