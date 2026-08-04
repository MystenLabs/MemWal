# Memory read API (WALM-295 + WALM-296), Phase 1

## Summary

Expose an authenticated, owner-scoped, cursor-based, read-only API so Console can enumerate a user's Walrus Memory data: namespaces, memories (metadata, including per-memory storage expiry), and connected agents. This spec covers both WALM-295 (owner-scoped listing) and WALM-296 (per-memory expiry) as a single implementation, because WALM-296 extends the exact same `memories` response WALM-295 creates — it cannot be built independently. `agents` ships in the same plan because it's the third endpoint WALM-295 itself scopes in one ticket (same Console release), not because it shares any storage with `namespaces`/`memories` — it has a fully separate implementation surface (live on-chain gRPC vs. Postgres) and can be built/reviewed as an independent slice within this plan.

Phase 1 is read-only visibility: no writes, no decryption, no extension/renewal, no new auth/token model.

## Scope

**In scope**
- `GET /v1/owners/{owner}/namespaces`
- `GET /v1/owners/{owner}/memories` (including `end_epoch` / `expires_at` per item)
- `GET /v1/owners/{owner}/agents`
- Cursor-based incremental listing (`updated_after`, `next_cursor`, `snapshot_version`) on all three endpoints
- A migration adding the columns needed to serve these endpoints from the existing `vector_entries` table
- An OpenAPI/contract document for all three endpoints, shared with Console (both WALM-295 and WALM-296 name this as an acceptance criterion)

**Out of scope**
- A new auth/token model (reuses the existing signature-verified auth already used by `/api/restore`) — see the Auth section for the open question this leaves
- Extend/renew of storage leases
- Decryption, content/preview, semantic search, writes
- Historical delegate-key event log (only current on-chain state is exposed)
- Per-namespace expiry rollup — WALM-296 lists this as optional "if cheap"; deferred because it needs an aggregate over `expires_at` not covered by the `(owner, namespace)` index, and namespaces already load-bear enough new work in Phase 1

## Architecture

The three endpoints are new Rust routes in `services/server/src/routes/`, not sidecar routes. The Node sidecar (`services/server/scripts/sidecar/`) has no precedent for GET+path-param routes and no owner-scoped auth (it only gates on a single shared bearer secret); the Rust server already has real owner identity via signature-verified auth (`Extension<AuthInfo>`, the same mechanism `/api/restore` uses).

Note this diverges from WALM-295's technical-details suggestion to back the endpoints via the sidecar's `POST /walrus/query-blobs` and the `accounts(owner)` mapping: that path is a live, capped, in-memory-filtered on-chain scan (used by `restore` for a diff-against-local-DB use case), not true DB pagination, and would violate the "no full-table scans" / load-test acceptance criterion at list-endpoint scale. This spec instead reads `vector_entries` directly (the already-indexed local copy) via real keyset pagination, and only goes on-chain live for `agents` (delegate keys aren't in any local table today).

**Auth:** the `{owner}` path segment must equal the authenticated `auth.owner`. A request for someone else's owner address returns `403`. This satisfies the ticket's "authenticated, owner-scoped" requirement without building the separate token-model ticket.

**Open question:** WALM-295's Dependencies section says this endpoint "must be behind owner-scoped tokens before it ships to Console" — implying Console's calling context may not be able to produce the same signature-verified auth `/api/restore`'s caller does. Whether Console can actually perform this auth today, or whether shipping to Console still depends on the separate owner-scoped-token ticket despite this spec routing around it for now, needs to be confirmed with whoever owns that ticket before this ships past Phase 1 dev/testing.

## Response safety

Every response is built from an explicit field allowlist — never raw `vector_entries` columns wholesale. No response ever includes `embedding`, `plaintext`, or any other decrypted/key material column, satisfying WALM-295 AC3 ("no plaintext, ciphertext, or key material"). Allowlisted fields per endpoint are exactly those listed under Endpoint contracts below. A response-shape test asserts this allowlist and must fail if a new `vector_entries` column is added without an explicit allow/deny decision.

## Data model

New migration (next sequential number after `009_importance_signal.sql`: `010_memory_read_api.sql`) alters `vector_entries`. It must also be wired into the hand-written sequential migration chain in `services/server/src/storage/db.rs` (migrations here are not auto-discovered by filename — each one is an explicit `include_str!` + execute call) — adding the file alone does not make it run.

| Column | Type | Notes |
|---|---|---|
| `updated_at` | `TIMESTAMPTZ NOT NULL` | Does not exist today (only `created_at` does). Backfilled from `created_at` for existing rows (not `NOW()`) so cursoring isn't artificially reset at deploy time — see Cursor semantics below. |
| `end_epoch` | `INTEGER NULL` | Walrus epoch the storage lease ends at (WALM-296). Nullable until known. |
| `expires_at` | `TIMESTAMPTZ NULL` | Computed absolute expiry (WALM-296). |
| `expiry_synced_at` | `TIMESTAMPTZ NULL` | Bookkeeping for lazy refresh staleness. Never bumps `updated_at` — see Expiry section. |
| `agent_id` | `TEXT NULL` | Verified available at write-time: `auth.public_key` (`AuthInfo`, sourced from the `x-public-key` request header), already threaded through the remember/analyze job payloads as `agent_public_key` — but only used today to set on-chain Blob metadata, never passed into `insert_vector` (`services/server/src/jobs.rs`). Needs one hop of plumbing, not a new data source. Nullable/backfilled for pre-migration rows. |
| `package_id` | `TEXT NULL` | Verified available at write-time, but it's a single process-wide constant (`state.config.package_id`, from `MEMWAL_PACKAGE_ID`) — every row written by a given deployment gets the same value, it isn't really per-request data. Stored per-row anyway to match the ticket's field list and to future-proof a multi-package scenario; same one-hop plumbing as `agent_id`. |

**No DB trigger.** `vector_entries` has zero `UPDATE` statements anywhere in the codebase today (insert/delete only), and no other `updated_at` column in this codebase is trigger-maintained — every existing one (`remember_jobs`, `delete_blobs_tracking`) is bumped with an explicit `SET updated_at = NOW()` in the application code that performs the update. This spec follows that convention instead of introducing this codebase's first DB trigger: `updated_at` is set once at insert (and via the backfill above for existing rows) and is **not** touched by the expiry-refresh job's `UPDATE` — that job only ever sets `end_epoch`, `expires_at`, `expiry_synced_at`. This also avoids a real production risk: migrations in this codebase re-run unconditionally on every server boot with no version gate (`VectorDb::new()` in `db.rs`, called from `main.rs`), and Postgres has no `CREATE TRIGGER IF NOT EXISTS` — a bare trigger-creation statement would crash-loop the whole process on every redeploy after the first.

**Migration mechanics:** the `ADD COLUMN` statements and the new composite index must run as two separate execute calls, not one bundled multi-statement transaction (unlike e.g. `002_add_namespace.sql`, which safely bundles `ALTER TABLE` + `CREATE INDEX` because that index build is cheap on a young table). `sqlx::raw_sql(...).execute(&pool)` runs all statements in one string as a single implicit transaction, during which `ALTER TABLE`/`ADD COLUMN` holds an `ACCESS EXCLUSIVE` lock until commit — building the new composite index inside that same transaction would block reads (not just writes) on `vector_entries` for the full index-build duration, and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block at all. So: one execute call for the `ADD COLUMN ... IF NOT EXISTS` statements, and a second, separate execute call containing only `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vector_entries_owner_updated_id ON vector_entries (owner, updated_at, id);`. Both statements are idempotent (`IF NOT EXISTS`), matching every existing migration's convention and keeping this migration as safe under a multi-replica rolling deploy as 001–009 already are.

New composite index: `idx_vector_entries_owner_updated_id ON vector_entries (owner, updated_at, id)` for keyset pagination on `memories`.

`status` is **not** a stored column — it's derived at read time from `expires_at`: `expired` if `expires_at < now()`, else `active`. Rows where `expires_at` is still `NULL` (not yet synced) also report `active` — an intentional optimistic default pending first refresh, not an oversight.

`snapshot_version` is **not** computed from the database — it's a versioned constant in code, bumped manually whenever a backfill or semantic reset (schema change, epoch-formula change, etc.) requires Console to do a full reconcile, and returned on every response including `agents`. Because `updated_at` is backfilled from `created_at` (not reset to a single deploy-time value), shipping this migration itself does **not** require a snapshot_version bump.

`namespaces` has no dedicated table. It's derived with `GROUP BY namespace` on `vector_entries`, using the existing `idx_vector_entries_owner_ns` index (`002_add_namespace.sql`, on `(owner, namespace)`).

## Endpoint contracts

### `GET /v1/owners/{owner}/namespaces?updated_after=<cursor>&limit=100`

```sql
SELECT namespace, COUNT(*) AS memory_count, SUM(blob_size_bytes) AS storage_used, MAX(updated_at) AS updated_at
FROM vector_entries WHERE owner = $1 [AND updated_at > $cursor] GROUP BY namespace
ORDER BY namespace LIMIT $limit
```

Response: `{ namespaces: [{ id, name, memory_count, storage_used }], next_cursor, snapshot_version }`. `id` and `name` are both the raw `namespace` text value — there is no surrogate key.

### `GET /v1/owners/{owner}/memories?updated_after=<cursor>&limit=100`

Keyset pagination:

```sql
SELECT id, namespace, blob_id, blob_size_bytes, created_at, updated_at, agent_id, package_id, end_epoch, expires_at
FROM vector_entries
WHERE owner = $1 AND (updated_at, id) > ($cursor_updated_at, $cursor_id)
ORDER BY updated_at, id LIMIT $limit
```

`updated_after` is **not** a raw timestamp — clients must pass back the opaque `next_cursor` value verbatim (it base64-encodes the `(updated_at, id)` pair needed for correct tie-breaking when multiple rows share the same `updated_at`). `limit` defaults to 100 if omitted, is clamped to a maximum of 500 (matching the sidecar's existing `clamp(limit, 1, 500)` convention in `walrus-query.ts`), and returns `400` for non-positive or non-integer values.

Response item: `{ memory_id, namespace_id, blob_id, created_at, size, agent_id, package_id, status, end_epoch, expires_at }` (`namespace_id` is the raw namespace string, same as `namespaces`' `id`). Response envelope: `{ memories: [...], next_cursor, snapshot_version }`.

### `GET /v1/owners/{owner}/agents`

Live on-chain read of `MemWalAccount.delegate_keys` via the same Sui gRPC client the sidecar/Rust already use, mirroring `verify_delegate_key_onchain` in `services/server/src/storage/sui.rs` but returning the full array instead of looking up a single key. No indexer changes. Cached with the same short TTL pattern as `walrus_epoch()` (`Timed<...>`, `services/server/src/sui/client.rs`) rather than left uncached — `verify_delegate_key_onchain` itself has no caching today, but that function is called for single-key auth checks, not a page-load-triggered list; an uncached per-dashboard-load RPC call would compete with the same interactive-priority rate budget the recall path depends on. Response: `{ agents: [{ label, sui_address }], snapshot_version }`.

## Expiry (WALM-296): epoch → timestamp

Walrus epoch semantics, not Sui epoch semantics — `committee.epoch`, `epoch_duration`, and `first_epoch_start` here are Walrus protocol fields read off a Sui-hosted object, distinct from Sui's own network epoch (the codebase already keeps these as distinct newtypes, `WalrusEpoch`/`SuiEpoch`, specifically to prevent conflation).

No epoch-to-wall-clock conversion exists anywhere in the codebase today. `services/server/src/sui/client.rs::walrus_epoch()` already reads the Walrus system object's dynamic field to get `committee.epoch` (cached 30s via `Timed<WalrusEpoch>`). This spec extends that same parse to also read `epoch_duration` and `first_epoch_start` from the same object (no extra RPC call), giving:

```
expires_at = first_epoch_start + end_epoch * epoch_duration
```

**Initial population:** verified NOT populated at write-time today, but confirmed achievable with zero extra RPC calls. The sidecar's upload flow (`flow.getBlob()` in `services/server/scripts/sidecar/routes/walrus-upload.ts`) already fetches the full on-chain Blob object — including `storage.end_epoch` — in order to extract the object id, then discards the rest before responding. Getting `end_epoch` into `vector_entries` at write time needs: (1) the sidecar's upload response to include `endEpoch`; (2) Rust's `WalrusUploadResponse`/`UploadResult` (`services/server/src/storage/walrus.rs`) to add the field; (3) plumbing it through `execute_upload_and_transfer` → `insert_vector_and_mark_remember_done` → `VectorDb::insert_vector`, mirroring the same one-hop plumbing `agent_id`/`package_id` need. **Gap:** the `SetMetadataAndTransfer` recovery path (used when the initial upload succeeds but the transfer fails, `services/server/src/jobs.rs`) never re-fetches the blob object — it only carries forward `blob_id`/`vector`/`blob_size_bytes`/`importance` from the original job payload — so rows written via that recovery leg need either their own re-fetch or a fallback on-chain lookup to get `end_epoch`, or they fall through to the lazy-refresh path below like any other unsynced row.

A one-time backfill job additionally walks existing rows at rollout to populate `end_epoch`/`expires_at` for pre-existing memories, so WALM-296 AC1 ("items include `end_epoch` and `expires_at`") holds on day one rather than only for rows that happen to get read-triggered later. Until backfilled, `end_epoch`/`expires_at` are `null` in the response — a "not yet synced" state, not an error.

**Refresh strategy (Phase 1 MVP):** lazy-on-read, reusing the `tokio::spawn` + periodic-sweep pattern already established in `services/server/src/main.rs` (hourly `evict_expired_delegate_keys`, 60s `fail_stale_remember_jobs`) — not the `remember_jobs`/Apalis job-execution path, which is a status-bookkeeping table for pipeline jobs actually run by Apalis, not a general-purpose async task queue this work would naturally reuse. When `memories` is listed and a row's `expiry_synced_at` is missing or older than 24h, the already-known value is returned immediately (never blocks the response) and a refresh is scheduled. To avoid one refresh enqueued per row on the first post-deploy traversal of a large, all-`NULL` corpus (every pre-existing row starts unsynced), `expiry_synced_at` is stamped `NOW()` at *schedule* time, not at completion — so a row already scheduled within the last 24h is not re-scheduled by a subsequent read even if the refresh hasn't finished yet. A failed refresh is naturally retried on the next read after the 24h window, which is an acceptable degradation for Phase 1. The refresh `UPDATE` only ever touches `end_epoch`/`expires_at`/`expiry_synced_at`, never `updated_at` — otherwise routine expiry housekeeping would make unrelated rows reappear in Console's `updated_after` incremental sync.

**Accepted Phase 1 risk:** a refresh racing an on-chain `epoch_duration` change within the existing ~30s cache window can compute a stale value. WALM-296 AC2 only requires accuracy "within one epoch," which already absorbs this window — no additional cache-invalidation machinery is added for Phase 1.

## Error handling

Reuses the existing Rust `AppError` enum. New variant for owner/path mismatch → `403`. An empty list (owner with no memories/namespaces) is a valid `200`, not a `404`.

## Documentation

An OpenAPI/contract document covering all three endpoints (including WALM-296's `end_epoch`/`expires_at` fields) is written and shared with the Console team before/at ship — both WALM-295 and WALM-296 name this as an explicit acceptance criterion, and it's what unblocks the dependent "Console read-API client" ticket.

## Testing

- Cursor pagination edge cases: empty owner, exact page boundary, tie-breaking on `id` when `updated_at` collides.
- Full pagination round-trip: seed a large synthetic memory count for one owner, walk `next_cursor` to completion, assert the union of pages equals the full set exactly once (no gaps, no duplicates) — not just an `EXPLAIN ANALYZE` scan-type check.
- Namespace rollup aggregation correctness (`memory_count`, `storage_used`).
- Epoch → timestamp conversion, property-tested against real `epoch_duration`/`first_epoch_start` fixtures.
- `/agents`: empty `delegate_keys` array, gRPC/chain read failure/timeout handling, response shape parity with the existing single-key lookup it mirrors.
- Response-safety schema test per the allowlist in "Response safety" above.
- Load test per WALM-295's explicit acceptance criterion: `EXPLAIN ANALYZE` against both the new `(owner, updated_at, id)` index and the `(owner, namespace)` index used by `namespaces`, confirming no full-table scan for a large memory count.

## Open items carried into implementation planning

- `agent_id`/`package_id`/`end_epoch` write-time availability is now verified (see Data model and Expiry sections above) — no longer open. The one remaining piece: plumb `end_epoch` through the `SetMetadataAndTransfer` recovery path (`services/server/src/jobs.rs`), which doesn't re-fetch the blob object and so has no `end_epoch` to carry forward; decide during planning whether that path gets its own on-chain fallback fetch or simply relies on lazy refresh like any other unsynced row.
- Confirm whether Walrus `epoch_duration` has ever changed or can change. If it can, the linear `expires_at` formula silently mis-computes for any lease spanning a change boundary, and the 24h lazy refresh does not self-correct (it reapplies the same formula). This is a customer-facing correctness question (wrong expiry dates in Console) and should be resolved before WALM-296 ships, not left open indefinitely.
