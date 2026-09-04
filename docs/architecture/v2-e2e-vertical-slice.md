# V2 FE→BE vertical slice (spike)

Branch: `henrynguyen/v2-e2e-testnet-spike`
Worktree: `/Users/ducnmm/Documents/commandoss/MemWal-v2e2e`
Not production. Do not merge as “implement entire V2”. Do not edit Linear. Do not touch the WALM-429 worktree.

Published testnet package (see `scripts/v2e2e/STATE.md`):

| What | ID |
|---|---|
| Package | `0xdf67385f0842bcdd7234b73d9822f1b29f7d7991115c219a589118d8c5501dfc` |
| AccountRegistry | `0x0e04320f37466a449d7bf6980bf8dad22d563da41faf98a0aab8b82c802eff86` |
| NamespaceRegistry | `0x1d0a9f1bf04832387fa911cbb83e59c99332439d93e89e1e868f23f5a08cb995` |
| Clock | `0x6` |

## Goal

Henry can locally, on this branch:

1. Open the dashboard against the testnet V2 package.
2. Create (or reuse) a V2 `MemWalAccount` and a delegate key.
3. Create a namespace (phase 1) then initialize the key with a **real** Seal-wrapped AES-256 DEK (phase 2).
4. Grant READ (or READ|WRITE) to another **wallet address** (`grant_access`), not a delegate-key share.
5. Playground / SDK `remember` stores ciphertext in **Memory-owned Oyster** and calls `namespace::write_fence`.
6. `recall` decrypts for a principal that `can_read`.
7. V1 paths keep working when V2 write flags are off.

## Frozen constraints (do not reinterpret)

Source of truth for Move: `services/contract/sources/namespace.move` on this branch. WALM-352 Web2 spec lives on `feat/walm-352-v2-web2:docs/architecture/v2-web2-architecture.md` — copy decisions D0–D14 except the D11 override below.

- Two-phase namespace: `create_namespace` (inactive) then `initialize_key` (Seal-wrapped DEK, on-chain blake2b256 commitment of the wrapped bytes). Seal ID includes the namespace object ID, so wrap cannot happen before create returns.
- Payloads: AES-256-GCM under a **namespace** DEK. One Seal-wrapped DEK per key version. Never Seal-the-payload on V2.
- Canonical Seal suffix: exactly 40 bytes `BCS(namespace_id) || BCS(key_version: u64 LE)`. Contract checks suffix only. `@mysten/seal` may prepend `BCS(package_id)`.
- `write_fence` is storage-agnostic. Contract checks `commitment.len() == 32`, current key version, `can_write(ctx.sender())`. Relayer binds the digest off chain.
- `grant_access` is wallet-to-wallet. READ/WRITE: any nonzero address except `@0x0` and the owner. SHARE: current account delegate only. Owner implicit bits are not stored in the Table.
- `revoke_access` always rotates. Out of this slice except a SDK wrapper.
- V2 memories call **only** `namespace::seal_approve` and `namespace::write_fence`. Never `account::seal_encrypt_fence` for a V2 envelope.
- Dual package: V1 stay default. Kill switch `MEMWAL_V2_WRITES_ENABLED` (default false).
- Phase 1 Console list/identity: do not build Console decrypt or ACL GET.
- Memory must **not** auto-extend Oyster/Walrus lifetime. No `oysterd extend`, no relayer cron to extend.

### D11 override (this slice)

WALM-352 D11 said one native Walrus `Blob` per memory. Product decision for this spike:

| `storage_mode` | Bytes live in | `write_fence` PTB |
|---|---|---|
| `managed_oyster` (default when V2 writes on) | Memory-owned Oyster pooled blob | fence-only PTB (no Blob transfer) |
| `self_hosted` | native Walrus Blob (today’s upload+transfer) | fence **in** the metadata+transfer PTB |

Do not call Oyster extend APIs. Do not add auto-renew.

### D1 commitment (keep)

```
DOMAIN = b"memwal.v2.write_commitment.v1"
preimage = DOMAIN || 0x00 || namespace_id[32] || BCS(key_version u64 LE) || blob_id_le[32] || blob_object_id[32] || ciphertext_digest[32]
commitment = blake2b256(preimage)
```

- `ciphertext_digest = blake2b256(envelope bytes)`
- Managed Oyster: `blob_id_le` = 32-byte little-endian content hash Oyster returns as base64url `blob_id` (same encoding as Walrus). `blob_object_id` = `pooled_blob_object_id` when present; **32 zero bytes** when Oyster’s filesystem backend leaves it null (local 0.14.2).
- Self-hosted: D1 as written in WALM-352 (native Blob object id + Walrus blob_id LE).

### Envelope (D3)

```
magic[8]     = b"MEMWALV2"
version u8   = 1
namespace_id = 32 bytes
key_version  = u64 LE
nonce        = 12 bytes
ct_len       = u32 LE
ciphertext   = AES-256-GCM(plaintext, key=DEK, nonce, aad)  // includes 16-byte tag
AAD          = b"MEMWALV2" || namespace_id || key_version_le
```

DEK bytes never persist in Redis/Postgres.

### Operator writer (D2+D4)

Relayer-mode remember is allowed only if **both**:

1. HTTP principal (`x-public-key` → Sui address) `can_write` on the namespace.
2. PTB sender ∈ `MEMWAL_V2_WRITER_ADDRESSES` and that address `can_write` (granted at initialize).

Grant READ|WRITE (no SHARE) to writer pool + this flow’s HTTP agent at `initialize_key` time (dashboard Tx4). Unwrap uses the user’s Seal session (`namespace::seal_approve` sender = user). Wrap does **not** call `seal_approve`.

## Out of this slice

Indexer V2 pipeline / hash chain (PR 1, 7). Console Read API fields (PR 10). Analyze `write_fence` (WALM-403). Python/MCP parity (PR 13). Observability PR 11. Auto-extend. Move ABI changes.

## Dual-run flags

`GET /version` `featureFlags` (runtime env, not compile-time):

| Flag | Env | Default |
|---|---|---|
| `runtime.v2Namespaces` | `MEMWAL_V2_NAMESPACES_ENABLED` | false |
| `runtime.v2WriteFence` | `MEMWAL_V2_WRITES_ENABLED` | false |
| `runtime.v2ManagedOyster` | `MEMWAL_V2_MANAGED_OYSTER` | true when writes on |

If a live V2 namespace owns a label, remember/recall must not fall through to V1 (`409 v2_writes_disabled` when writes off). D14.

## Env (relayer)

```
MEMWAL_V2_PACKAGE_ID
MEMWAL_V2_REGISTRY_ID
MEMWAL_V2_NAMESPACE_REGISTRY_ID
MEMWAL_V2_WRITER_ADDRESSES          # comma-separated operator Sui addresses
MEMWAL_V2_NAMESPACES_ENABLED
MEMWAL_V2_WRITES_ENABLED
MEMWAL_V2_MANAGED_OYSTER            # default true
OYSTER_BASE_URL                     # include /api/v1  e.g. http://127.0.0.1:3000/api/v1
OYSTER_API_KEY
OYSTER_BUCKET                       # default memwal
```

Dashboard:

```
VITE_MEMWAL_V2_PACKAGE_ID
VITE_MEMWAL_V2_REGISTRY_ID
VITE_MEMWAL_V2_NAMESPACE_REGISTRY_ID
VITE_V2_NAMESPACES_ENABLED
```

Local spike defaults (app config fallbacks when unset, testnet only) may use the STATE.md object ids. Production defaults stay V1 package ids.

## Workstreams (file ownership — do not cross)

### A — SDK (`packages/sdk/**` only)

New `packages/sdk/src/namespace.ts`, export from `account-entry.ts` (`@mysten-incubation/memwal/account`). Additive types in `types.ts`. Helper `namespaceSealKeyId` next to `u64ToLeHex` in `utils.ts`. Tests under `packages/sdk/test/namespace.test.mjs`.

Copy `account.ts` patterns: `buildTxContext`, `signAndExecute`, Clock `0x6`, extract created shared object id.

Public functions (names frozen for the FE):

- `namespaceSealKeyId(namespaceId, keyVersion): Uint8Array` — 40 raw bytes.
- `wrapNamespaceDek({ packageId, namespaceId, keyVersion, dek, sealClient | sealServerConfigs, threshold })` — `@mysten/seal` encrypt of 32-byte DEK; `id` = hex of the 40-byte suffix (Seal may prefix package).
- `createNamespace({ packageId, namespaceRegistryId, accountRegistryId, accountId, label, walletSigner | suiPrivateKey, suiClient, suiNetwork })`
- `initializeKey({ …, namespaceId, wrappedDek: Uint8Array })`
- `grantAccess({ …, namespaceId, principal, canRead, canWrite, canShare })`
- `revokeAccess({ …, namespaceId, principal, newWrappedDek })` (wrapper only)
- `rotateKey({ …, namespaceId, newWrappedDek })` (wrapper only)
- `cancelUninitializedNamespace` — `public fun`, not `entry`; still PTB-callable.

`createNamespace` + `initializeKey` are **separate transactions**. Never batch with `createAccount`.

After `initializeKey`, the dashboard (not the SDK helper) also `grantAccess` READ|WRITE (no SHARE) to writer addresses and the HTTP agent. SDK may accept `writerAddresses?: string[]` on a convenience `provisionNamespace` **only if** it still submits initialize and grants as separate txs after create. Prefer keeping primitives separate.

Tests: seal-id golden (40 bytes, LE key_version); `createNamespace` PTB argument order; reject empty/too-long label in the client before send (contract also checks 1..=64).

### B — Relayer + sidecar (`services/server/**` only)

1. **Dual HTTP auth.** `x-account-id` resolves against V1 `MEMWAL_PACKAGE_ID` **or** V2 `MEMWAL_V2_PACKAGE_ID`. `verify_delegate_key_onchain` must use the matching type-origin package. Never upsert V2 accounts into V1 tables.
2. **Oyster client** `storage/oyster.rs` (or `oyster.ts` is wrong — stay Rust). HTTP:
   - `PUT {OYSTER_BASE_URL}/buckets/{bucket}/blobs/{key}` with raw body, `Authorization: Bearer {OYSTER_API_KEY}`. Must be PUT (curl `--data-binary` defaults POST and 405s).
   - `GET` same path; `GET {OYSTER_BASE_URL}/blobs/by-blob-id/{blob_id}` for recall fallback.
   - Parse JSON for `blob_id`, `pooled_blob_object_id` (nullable), `encoded_size`. Ignore missing `expires_at`.
   - Key layout: `{namespace_object_id}/{job_id}`.
   - **No extend / no PATCH lifetime.**
3. **Sidecar** `POST /seal/wrap-dek` and `POST /seal/unwrap-dek`:
   - Wrap: Seal.encrypt DEK under `namespace::` id. Does not call `seal_approve`.
   - Unwrap: SessionKey + PTB `namespace::seal_approve(id, ns_registry, account_registry, account, namespace)`.
   - `POST /seal/aes-gcm-encrypt` / `decrypt` **or** implement AES-GCM in Rust (`aes-gcm` crate). Prefer sidecar Node `crypto` to match “SEAL/crypto stays in TS sidecar” (`Cargo.toml` comment) unless adding the crate is cleaner for the engine. Envelope encode/decode must match D3 exactly. Golden vector test.
4. **Remember (flag on, managed oyster):**
   - Resolve label → live V2 namespace (live-read object). If live V2 and writes off → 409, do not V1.
   - HTTP `can_write` AND operator in writer pool.
   - Load `wrapped_dek` for current version (chain view). Unwrap with user session.
   - Build MEMWALV2 envelope. `ciphertext_digest`.
   - PUT Oyster. Compute D1. Persist `storage_mode=managed_oyster`, oyster key, blob_id, pooled_blob_object_id, commitment, key_version, namespace_object_id.
   - Operator-signed PTB: `namespace::write_fence` only. Persist `fence_tx_digest`. Never double-fence (if digest set, skip).
   - `insert_vector` with `namespace_object_id` set.
   - `/api/analyze` does **not** fence (WALM-403).
5. **Recall:** if row has `namespace_object_id`, require `can_read`; GET Oyster; unwrap DEK (session); AES-GCM decrypt. V1 rows unchanged.
6. **Migration** additive nullable columns on `vector_entries` / `remember_jobs`: `namespace_object_id`, `key_version`, `storage_mode`, `oyster_bucket`, `oyster_key`, `pooled_blob_object_id`, `ciphertext_digest`, `commitment`, `fence_tx_digest`. Next free number after `009_importance_signal.sql` is `010_v2_columns.sql` on this branch (do not invent 021 — this spike does not have 010–020).
7. **`/version` flags** from env. Update `scripts/check-compatibility-contract.mjs` only if it asserts the exact flag set — keep it green.
8. V1 remember/recall/jobs paths: no behavior change when flags false.

Oyster HTTP base already includes `/api/v1`. Do not append `/api/v1` twice (Console bug to avoid).

### C — Dashboard (`apps/app/**` only)

Reuse `Card`, `SecretValueInput`, `useSponsoredTransaction`, existing dashboard tokens. Do not restyle the app.

New `apps/app/src/components/NamespacesSection.tsx` mounted on `Dashboard.tsx` when `config.v2NamespacesEnabled`.

UX:

1. **Namespaces** list: live-read owned `MemoryNamespace` objects (query from owner txs / `NamespaceCreated` via Sui client; indexer not required). Show label, object id, `active`, `current_key_version`.
2. **Create namespace:** label input (1..64, same sanitize as delegate labels) → sponsored `createNamespace` → then generate 32-byte DEK → `wrapNamespaceDek` with `@mysten/seal` (app already depends on it) → sponsored `initializeKey` → sponsored `grantAccess` READ|WRITE to `config.v2WriterAddresses` (if any) and to the current session delegate’s Sui address. Separate txs. Show errors per step.
3. **Share:** principal address + checkboxes Read / Write (Share only if principal is a current delegate — otherwise disable + helper text). `grantAccess`.
4. **Granted principals:** not enumerable on chain. Show principals the user granted this session plus any they look up (`permissions(namespace, addr)` view via a dev-inspect / move call). Honest empty state: “ACL is not enumerable on chain; look up an address.”
5. **Playground:** namespace dropdown (V2 object label). When V2 selected, `MemWal` remember/recall use that label; relayer takes the V2 path. Keep V1 `default` working.

Config additive: V2 package/registry/namespace registry ids, `v2NamespacesEnabled`, `v2WriterAddresses` (comma env). Testnet fallbacks = STATE.md ids **only when** `VITE_SUI_NETWORK=testnet` and V2 env unset is too surprising — prefer explicit env; document in `scripts/v2e2e/ENV.md`.

Tests: vitest for seal-id helper and grant bit mapping. Do not add Playwright unless existing e2e harness makes it cheap.

## Git rules for implementers

- Cwd is this worktree. Isolation none. **Do not create another worktree.**
- **Do not** `git checkout` another branch.
- Commit **only your owned files**. Message:
  - SDK: `feat(sdk): V2 namespace PTBs and Seal wrap DEK`
  - Relayer: `feat(relayer): V2 oyster write_fence dual-run`
  - App: `feat(app): V2 namespace create and wallet grant`
- Retry commit 3 times on index.lock (sleep 2s).
- Do not `git push`. Do not amend others’ commits. Do not force-push.
- Comments: short, WHY only. No ticket IDs in new comments. No Linear.

## Verify

- SDK: `pnpm --filter @mysten-incubation/memwal test` and `typecheck`.
- Relayer: `cargo test -p memwal-server` scoped to new tests; `cargo check -p memwal-server`.
- App: `pnpm --filter @memwal/app test` and `typecheck`.
- Do not run against Railway production DB. Local Postgres / `.env.v2e2e` only.

## Provision sequence (D7)

Owner-signed, never one PTB:

1. `create_account` (V2, migration already finalized on this testnet package).
2. `add_delegate_key` (HTTP agent).
3. `create_namespace`.
4. `initialize_key` + `grant_access` READ|WRITE to writers and this HTTP agent.

## Seal wrap details

DEK = 32 random bytes (`crypto.getRandomValues`).

Seal `encrypt({ threshold, packageId: V2_PACKAGE, id: hex(namespaceSealKeyId(ns, 0n)), data: dek })`.

`initialize_key` takes the raw Seal encrypted object bytes (`vector<u8>`), max 16384.

Golden: `namespace_tests.move` `test_seal_id_golden_vectors_are_little_endian_bcs` — SDK test must match those bytes.
