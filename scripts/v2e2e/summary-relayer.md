# Relayer + sidecar V2 workstream

Commit: `feat(relayer): V2 oyster write_fence dual-run`

## Files

New:

- `services/server/migrations/010_v2_columns.sql`
- `services/server/src/storage/oyster.rs`
- `services/server/src/storage/v2.rs`
- `services/server/scripts/sidecar/v2-envelope.ts`
- `services/server/scripts/sidecar/routes/v2.ts`
- `services/server/scripts/__tests__/sidecar-v2-envelope.test.ts`
- `services/server/scripts/__tests__/sidecar-v2-write-fence.test.ts`

Edited (relayer/sidecar):

- `services/server/src/types.rs` — Config + `AppError::{Forbidden,Conflict}`
- `services/server/src/compatibility.rs` — runtime V2 feature flags from env
- `services/server/src/auth.rs` — dual V1/V2 type-origin verify; cache key `{package}:{pubkey}`
- `services/server/src/storage/{mod,db,seal,walrus}.rs`
- `services/server/src/engine/walrus_seal.rs` — oyster GET + envelope decrypt
- `services/server/src/jobs.rs` — `WalletOperation::V2WriteFence` + self-hosted V2 fence on upload
- `services/server/src/routes/{remember,recall,analyze}.rs`
- `services/server/src/main.rs`
- `services/server/scripts/sidecar/{app,blob-metadata,seal-ptb,routes/seal,routes/walrus-upload}.ts`
- `services/server/Cargo.toml` + `Cargo.lock` (`blake2`)
- `services/server/scripts/package.json` + `package-lock.json` (`@noble/hashes`)

`scripts/check-compatibility-contract.mjs` unchanged (does not assert exact `/version` flag keys).

## Env vars

| Env | Default |
|---|---|
| `MEMWAL_V2_PACKAGE_ID` | unset |
| `MEMWAL_V2_REGISTRY_ID` | unset |
| `MEMWAL_V2_NAMESPACE_REGISTRY_ID` | unset |
| `MEMWAL_V2_NAMESPACES_ENABLED` | false (`runtime.v2Namespaces`) |
| `MEMWAL_V2_WRITES_ENABLED` | false (`runtime.v2WriteFence`) |
| `MEMWAL_V2_MANAGED_OYSTER` | true (`runtime.v2ManagedOyster`) |
| `MEMWAL_V2_WRITER_ADDRESSES` | empty (comma-separated) |
| `OYSTER_BASE_URL` | unset (must include `/api/v1`) |
| `OYSTER_API_KEY` | unset |
| `OYSTER_BUCKET` | `memwal` |

## Remember branch

1. `POST /api/remember` live-reads `NamespaceRegistry` for `(account_id, label)`.
2. No live V2 namespace → existing V1 SEAL + Walrus `UploadAndTransfer`.
3. Live V2 + `MEMWAL_V2_WRITES_ENABLED=false` → **409** `{ code: "v2_writes_disabled" }` (D14, no V1 fallthrough).
4. Live V2 + writes on → HTTP principal `can_write` **and** a writer-pool address `can_write`.
5. Unwrap namespace DEK (`POST /seal/unwrap-dek`, `namespace::seal_approve`, user `x-seal-session`).
6. AES-256-GCM `MEMWALV2` envelope via sidecar.
7. **managed_oyster (default):** `PUT` Oyster `{namespace_object_id}/{job_id}` (method PUT, no extend). D1 commitment. Fence-only PTB `POST /sui/v2-write-fence`. Skip if `fence_tx_digest` already set (D9).
8. **self_hosted:** native Walrus upload+transfer PTB with `appendV2WriteFence` instead of `account::seal_encrypt_fence`. Sidecar fills D1 after certify.

`/api/analyze` never fences; live V2 label → 409. Bulk/manual remember reject V2 labels.

Recall: same D14 gate. Rows with `namespace_object_id` GET Oyster, unwrap DEK, decrypt envelope. V1 rows unchanged.

## Tests

- `cargo check -p memwal-server` — ok
- `cargo test -p memwal-server --lib` (new): oyster URL join, 40-byte seal suffix, D1 commitment, namespace key — pass
- `cargo test -p memwal-server --lib jobs::` — 42 pass
- `node --test --import tsx './__tests__/sidecar-v2-*.test.ts'` — 5 pass (envelope roundtrip, 40-byte suffix, write_fence arg order)
- existing `sidecar-seal-routes.test.ts` + `sidecar-seal-approve-ptb.test.ts` — 21 pass

## Deviations

- Bulk remember is V1-only (explicit 400 if a live V2 label is in the batch).
- Writer-pool **key index** is still round-robin; sidecar 403s if that signer is not in `MEMWAL_V2_WRITER_ADDRESSES`.
- Node `crypto.createHash('blake2b256')` is unavailable here; sidecar blake2b-256 uses `@noble/hashes`.
- Namespace registry lookup is gRPC `ListDynamicFields` on the Table (JSON-RPC `suix_getDynamicFieldObject` fallback). Not a single-key gRPC API in sui-rpc 0.3.1.
