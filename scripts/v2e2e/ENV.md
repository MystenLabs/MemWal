# Local V2 spike env (not production)

Copy into gitignored `.env.v2e2e`. Relayer and Vite both read these.

Testnet objects: `scripts/v2e2e/STATE.md`.

```
SUI_NETWORK=testnet
MEMWAL_PACKAGE_ID=<v1 or leave staging>
MEMWAL_REGISTRY_ID=<v1>
MEMWAL_V2_PACKAGE_ID=0xdf67385f0842bcdd7234b73d9822f1b29f7d7991115c219a589118d8c5501dfc
MEMWAL_V2_REGISTRY_ID=0x0e04320f37466a449d7bf6980bf8dad22d563da41faf98a0aab8b82c802eff86
MEMWAL_V2_NAMESPACE_REGISTRY_ID=0x1d0a9f1bf04832387fa911cbb83e59c99332439d93e89e1e868f23f5a08cb995
MEMWAL_V2_NAMESPACES_ENABLED=true
MEMWAL_V2_WRITES_ENABLED=true
MEMWAL_V2_MANAGED_OYSTER=true
MEMWAL_V2_WRITER_ADDRESSES=<operator sui address from SERVER_SUI_PRIVATE_KEYS>
OYSTER_BASE_URL=http://127.0.0.1:3000/api/v1
OYSTER_API_KEY=<from local oysterd>
OYSTER_BUCKET=memwal

VITE_SUI_NETWORK=testnet
VITE_MEMWAL_V2_PACKAGE_ID=0xdf67385f0842bcdd7234b73d9822f1b29f7d7991115c219a589118d8c5501dfc
VITE_MEMWAL_V2_REGISTRY_ID=0x0e04320f37466a449d7bf6980bf8dad22d563da41faf98a0aab8b82c802eff86
VITE_MEMWAL_V2_NAMESPACE_REGISTRY_ID=0x1d0a9f1bf04832387fa911cbb83e59c99332439d93e89e1e868f23f5a08cb995
VITE_V2_NAMESPACES_ENABLED=true
VITE_MEMWAL_V2_WRITER_ADDRESSES=<same operator>
# Must match relayer SEAL_SERVER_CONFIGS JSON (objectId, weight, aggregatorUrl).
# Vite only exposes VITE_* — unprefixed SEAL_SERVER_CONFIGS is invisible to the app.
# A committee server needs aggregatorUrl; independent servers must omit it.
VITE_SEAL_SERVER_CONFIGS=<same JSON array as SEAL_SERVER_CONFIGS>
VITE_SEAL_THRESHOLD=<same as SEAL_THRESHOLD>
```

Never point `DATABASE_URL` at Railway production. Relayer Oyster client reads `OYSTER_BASE_URL` (must include `/api/v1`), not `OYSTER_URL`.

Live E2E notes (testnet):
- Enoki does not allowlist `namespace::write_fence`. Set `ENOKI_FALLBACK_TO_DIRECT_SIGN=true` so the writer key pays gas.
- Relayer Oyster PUT/GET uses a 300s client timeout (Walrus-backed oysterd is slow).
- Local oysterd with `SUI_RPC_URL`+Walrus objects can stall at `target_nodes=0`. Filesystem store (omit those env vars) is enough to prove PUT/GET + fence.
- Public Sui JSON-RPC is deprecated; dashboard namespace *listing* (`queryEvents`) may show `Failed to fetch` unless `VITE_SUI_RPC_URL` points at a still-working JSON-RPC.
