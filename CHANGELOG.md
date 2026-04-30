# Changelog

All notable changes to the MemWal project will be documented in this file.

---

## [security/v1] — 2026-04-29

Security hardening across the Rust server and TypeScript sidecar.
Fixes 3 CRITICAL + 6 HIGH + 5 MEDIUM findings from internal code review.
No breaking changes to public API endpoints or SDK interface.

> **Hotfix c512036:** `cargo check` compile error fixed — `auth.rs` had a
> leftover `delegate_key` field reference after `types::AuthInfo` was cleaned up.

---

### Rust Server (`services/server`)

#### 1. Client private key no longer accepted over HTTP (CRITICAL → FIXED)

**File:** `src/auth.rs`

The `x-delegate-key` header — which sent the client's raw Sui private key on every
authenticated request — has been removed from the auth middleware. The server now uses
its own `SERVER_SUI_PRIVATE_KEY` for all SEAL decryption operations.

Removed from `AuthInfo`: the `delegate_key` field. Removed from `verify_signature`:
the header extraction and all downstream usage.

#### 2. Walrus upload key no longer sent over HTTP (CRITICAL → FIXED)

**Files:** `src/walrus.rs`, `src/routes.rs`, `src/types.rs`, `src/main.rs`

The Sui private key used for Walrus blob uploads was previously sent in every
`POST /walrus/upload` request body to the sidecar. The sidecar now loads its own
key pool from `SERVER_SUI_PRIVATE_KEYS` / `SERVER_SUI_PRIVATE_KEY` at startup and
manages round-robin selection internally.

- Removed `private_key` field from `WalrusUploadRequest`
- Removed `sui_private_key` parameter from `upload_blob()`
- Removed `KeyPool` from `AppState` / `Config` — key management is now sidecar-only
- All four upload call sites in `routes.rs` updated accordingly

#### 2. Sidecar secret header added to all sidecar calls (HIGH → FIXED)

**Files:** `src/seal.rs`, `src/walrus.rs`, `src/routes.rs`

`seal_decrypt` was calling the sidecar without the `x-sidecar-secret` header,
leaving SEAL decryption unprotected even when `SIDECAR_SECRET` was configured.
All sidecar calls (`seal_encrypt`, `seal_decrypt`, `upload_blob`) now send
`x-sidecar-secret` with every request.

#### 3. Atomic rate limiting via Redis Lua script (HIGH → FIXED)

**File:** `src/rate_limit.rs`

All three rate limit layers now use a single atomic Redis round-trip via a Lua script
(`RATE_LIMIT_LUA`). The previous check-then-record pattern had a TOCTOU race condition
under concurrent load.

#### 4. remember_batch added to rate limit weight table (HIGH → FIXED)

**File:** `src/rate_limit.rs`

`POST /api/remember/batch` (up to 100 items) was weighted the same as a single
`/api/remember` call. Now carries weight 50, accurately reflecting its resource cost.

#### 5. User-supplied limit param capped at 100 (HIGH → FIXED)

**File:** `src/routes.rs`

`recall`, `recall_manual`, `ask`, and `restore` handlers now apply `.min(100)` to
any user-supplied `limit` parameter before passing it to the database or downstream calls.

#### 6. reqwest::Client timeouts configured (HIGH → FIXED)

**File:** `src/main.rs`

The shared HTTP client now has explicit timeouts:
- Request timeout: 30 seconds
- Connection timeout: 10 seconds

Prevents external HTTP calls (embedding API, Sui RPC, sidecar) from hanging indefinitely.

#### 7. OPENAI_API_KEY missing now returns an error (MEDIUM → FIXED)

**File:** `src/routes.rs`

The silent mock-embedding fallback (deterministic SHA-256 hash vector) has been removed.
When `OPENAI_API_KEY` is absent, `generate_embedding` returns `AppError::Internal`.
Prevents semantically useless vectors from silently entering the vector database in production.

#### 8. CORS restricted to explicit origins (MEDIUM → FIXED)

**File:** `src/main.rs`

`CorsLayer::permissive()` replaced by env-driven CORS configuration. Set
`CORS_ORIGINS=https://your-app.com` to restrict to specific origins. If unset,
falls back to permissive with a startup warning.

#### 9. Registry scan capped at 20 pages (MEDIUM → FIXED)

**File:** `src/sui.rs`

`find_account_by_delegate_key` now breaks after 20 pages (1,000 accounts maximum)
with a warning log, preventing unbounded on-chain scans from stalling auth middleware
on large registries.

#### 10. Full SHA-256 hash used for search cache keys (MEDIUM → FIXED)

**File:** `src/db.rs`

Cache keys previously used only the first 16 hex characters (64 bits) of the vector hash,
creating a 1-in-2^64 collision risk where different queries could return each other's
cached results. Now uses the full 64-character SHA-256 hex string.

---

### TypeScript Sidecar (`services/server/scripts/sidecar-server.ts`)

#### 11. Sidecar binds to 127.0.0.1 only (HIGH → FIXED)

The sidecar now listens on `127.0.0.1` instead of `0.0.0.0`, making it unreachable
from any external network interface.

#### 12. Shared secret authentication on all sidecar endpoints (HIGH → FIXED)

All non-health endpoints require the `x-sidecar-secret` header to match `SIDECAR_SECRET`.
A startup warning is printed if the secret is not configured.

#### 13. Request body size limited to 5MB (HIGH → FIXED)

`express.json({ limit: "5mb" })` prevents oversized payloads from reaching handler logic.

#### 14. Sidecar manages its own Sui key pool (CRITICAL → FIXED)

See item 1. The sidecar loads `SERVER_SUI_PRIVATE_KEYS` / `SERVER_SUI_PRIVATE_KEY` at
startup and selects keys internally via round-robin counter. Walrus upload requests no
longer carry a private key in the request body.

#### 15. SEAL key server verification enabled (CRITICAL → FIXED)

**File:** `scripts/sidecar-server.ts`

`SealClient` is initialized with `verifyKeyServers: true`, restoring the chain-of-trust
check that was previously disabled (`verifyKeyServers: false`).

#### 16. Input validation on all sidecar endpoints (MEDIUM → FIXED)

Added:
- `isValidSuiAddress()` — enforces `0x` prefix + 32-byte hex format
- `isValidSuiObjectId()` — enforces `0x` prefix + variable-length hex
- `/seal/encrypt`: validates `owner` and `packageId` format
- `/seal/decrypt`: validates `packageId` and `accountId` format
- `/seal/decrypt-batch`: caps `items` at 100; validates `packageId` and `accountId`
- `/walrus/upload`: validates `owner`, `packageId`, and `epochs` range (1–200)
- `/embed-batch`: caps `texts` at 100

---

## [optimization/v1] — 2026-04-28

Performance, scalability, and developer experience improvements across the entire stack.
No breaking changes to existing API endpoints or SDK public interface.

---

### Rust Server (`services/server`)

#### 1. Database — IVFFlat Index (migration 004)

**File:** `migrations/004_add_ivfflat_index.sql`, `src/db.rs`

Added an IVFFlat index on `vector_entries.embedding` using `vector_cosine_ops` with `lists = 100`.
IVFFlat is better suited for write-heavy workloads compared to the existing HNSW index.
Both indexes coexist — the PostgreSQL query planner selects the optimal one per query.

The migration is idempotent (`CREATE INDEX IF NOT EXISTS`) and safely rollbackable:
```sql
DROP INDEX IF EXISTS idx_vector_entries_embedding_ivfflat;
```

#### 2. Database — Connection Pool Increase

**File:** `src/db.rs`

Increased `PgPoolOptions::max_connections` from 10 to 20. This allows the server to handle
more concurrent requests without connection starvation, especially during batch operations
and parallel Walrus uploads.

#### 3. API — Batch Remember Endpoint

**File:** `src/routes.rs`, `src/types.rs`, `src/main.rs`

New endpoint: `POST /api/remember/batch`

Accepts an array of up to 100 items, each with `text` and optional `namespace`.
All items are processed concurrently (embed + SEAL encrypt + Walrus upload), then
all resulting vectors are inserted into the database in a single PostgreSQL transaction.

Request:
```json
{
  "items": [
    { "text": "I'm allergic to peanuts", "namespace": "default" },
    { "text": "I live in Hanoi" }
  ]
}
```

Response:
```json
{
  "results": [
    { "id": "...", "blob_id": "...", "owner": "0x...", "namespace": "default" },
    { "id": "...", "blob_id": "...", "owner": "0x...", "namespace": "default" }
  ],
  "total": 2
}
```

Validation rules:
- Items array must not be empty
- Maximum 100 items per batch
- Each item must have non-empty text
- Storage quota checked before processing

#### 4. Caching — Redis-Backed Vector Search Cache

**File:** `src/db.rs`

New method: `VectorDb::search_cached()`

Caches vector search results in Redis with a 60-second TTL. This avoids repeated
expensive pgvector cosine distance computations for identical queries within a short window.

- **Cache key format:** `search:{owner}:{namespace}:{first 16 chars of SHA-256(vector bytes)}`
- **Applied to:** `/api/recall` and `/api/recall/manual` endpoints
- **Fallback:** If Redis is unavailable or returns an error, falls back silently to direct DB query
- **Invalidation:** Cache entries expire naturally after 60 seconds

#### 5. Sidecar — Batch Embedding Endpoint

**File:** `scripts/sidecar-server.ts` (sidecar), `src/routes.rs` (Rust)

New sidecar route: `POST /embed-batch`

Accepts an array of texts, calls the OpenAI-compatible embedding API in parallel using
`Promise.all`, and returns an array of embedding vectors with their original indices.

On the Rust side, `generate_embeddings_batch()` calls this endpoint and falls back to
sequential single-text embedding if the sidecar endpoint is unavailable or returns an error.

#### 6. Walrus — Batch Upload Function

**File:** `src/walrus.rs`

New function: `upload_batch()`

Accepts a `Vec<UploadItem>` and uploads all blobs to Walrus in parallel using
`futures::future::join_all`. Each item uses a different signing key from the pool
to avoid per-signer serialization locks. Returns `Vec<Result<UploadResult, AppError>>`
in the same order as input.

#### 7. Infrastructure — Graceful Shutdown

**File:** `src/main.rs`

Enhanced the shutdown handler to respond to both `Ctrl+C` (SIGINT) and `SIGTERM` signals.
On shutdown:
1. Stops accepting new HTTP connections (axum graceful shutdown)
2. Closes the PostgreSQL connection pool (`db.close()`)
3. Kills the TypeScript sidecar child process
4. Logs completion

On non-Unix platforms (Windows), only Ctrl+C is handled — SIGTERM is not available.

---

### TypeScript SDK (`packages/sdk`)

#### 8. Retry Logic with Exponential Backoff

**File:** `src/memwal.ts`

New private method: `signedRequestWithRetry()`

Automatically retries failed requests up to 3 times with exponential backoff (1s, 2s, 4s)
when encountering:
- HTTP 429 (rate limit)
- Network errors: `ECONNREFUSED`, `ECONNRESET`, `fetch failed`

Applied to **read-only** (idempotent) operations only:
- `recall()` — vector search + decrypt
- `recallManual()` — vector search only
- `embed()` — text embedding

**Not applied** to write operations (`remember()`, `analyze()`, `restore()`, `rememberManual()`)
to prevent duplicate side effects.

#### 9. Batch Remember Method

**File:** `src/memwal.ts`, `src/types.ts`, `src/index.ts`

New public method: `MemWal.rememberBatch(items: RememberBatchItem[])`

Corresponds to the server's `POST /api/remember/batch` endpoint. Accepts an array of
`{ text, namespace? }` objects and sends them in a single signed HTTP request.

```typescript
const result = await memwal.rememberBatch([
    { text: "I'm allergic to peanuts" },
    { text: "I live in Hanoi", namespace: "personal" },
]);
console.log(result.total); // 2
```

New exported types: `RememberBatchItem`, `RememberBatchResult`

#### 10. HTTP Connection Reuse

**File:** `src/client.ts` (new), `src/memwal.ts`, `src/index.ts`

New module: `client.ts` with `HttpClient` interface and `createHttpClient()` factory.

In Node.js environments, connections are reused via the runtime's built-in keep-alive
(Node 19+ enables this by default). In browser environments, native `fetch` already
handles connection pooling.

The `MemWal` constructor now accepts an optional `httpClient` parameter for custom
HTTP client injection (e.g., for testing or proxy configurations). When omitted,
a default client is created automatically. Fully backwards compatible.

New exports: `createHttpClient`, `HttpClient`

---

### Monorepo & CI/CD

#### 11. Turborepo Build Caching

**File:** `turbo.json`, `package.json`

Added Turborepo configuration with a dependency-aware build pipeline:
- `build` depends on `^build` (topological order — SDK builds before apps)
- `test` depends on `build` (ensures built artifacts exist)
- `dev` tasks are uncached and persistent

New root scripts: `pnpm build`, `pnpm test`, `pnpm typecheck`

`.turbo/` added to `.gitignore`.

#### 12. TypeScript Project References

**File:** `packages/sdk/tsconfig.json`

Added `"composite": true` to enable TypeScript project references. This allows
incremental builds and lets downstream packages reference the SDK via `tsconfig`
`references` instead of relying solely on `pnpm` workspace resolution.

#### 13. GitHub Actions CI Workflow

**File:** `.github/workflows/ci.yml`

New CI pipeline triggered on push/PR to `dev` and `main`:

**TypeScript job:**
- pnpm store caching (via `actions/setup-node` cache)
- `pnpm install --frozen-lockfile`
- `pnpm exec turbo run build --filter=@mysten-incubation/memwal` (scoped SDK build)
- `pnpm exec turbo run typecheck --filter=@mysten-incubation/memwal`

**Rust job:**
- Cargo target caching (via `Swatinem/rust-cache`)
- `cargo check`
- `cargo clippy -- -D warnings`

Actions runtime set to Node.js 24 (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`)
to avoid deprecation warnings. Project uses Node.js 22 LTS.

#### 14. Chatbot — @types/react Upgrade

**File:** `apps/chatbot/package.json`

Upgraded `@types/react` from `^18` to `^19.2.14` and `@types/react-dom` from `^18` to `^19.2.3`.
The chatbot app uses React 19.0.1 (runtime) with Next.js 16, but the type definitions were
still on React 18 which lacks `useActionState`. This caused a build failure:
```
Module '"react"' has no exported member 'useActionState'.
```

#### 15. CI — Remove `npm install -g npm@latest` from Release Workflows

**Files:** `.github/workflows/release-sdk.yml`, `.github/workflows/release-oc-memwal.yml`

Removed the `npm install -g npm@latest` step from both release workflows. This step was
corrupting npm's own installation mid-upgrade — npm deletes its dependency `promise-retry`
before the rebuild phase finishes, causing `MODULE_NOT_FOUND` errors.

Node 22's bundled npm (10.x) already supports `--provenance` and OIDC trusted publishing
natively, so the self-upgrade was unnecessary.

#### 16. CI — Upgrade pnpm 9.12.3 → 10.0.0

**File:** `package.json`

Upgraded `packageManager` from `pnpm@9.12.3` to `pnpm@10.0.0` for Node 22 compatibility.
pnpm 9.x has compatibility issues with Node 22 in GitHub Actions CI runners, causing
`pnpm/action-setup@v4` to fail during dependency resolution. pnpm 10.x is the recommended
version for Node 22 LTS environments.

#### 17. Build Script — Turbo Filter for SDK

**File:** `package.json`

Changed `build:sdk` from `pnpm --filter @mysten-incubation/memwal build` to
`turbo run build --filter=@mysten-incubation/memwal`. The pnpm `--filter` flag does not
prevent turbo from resolving the full workspace dependency graph via `^build`.
Turbo's own `--filter=` properly scopes execution to the target package only.

Verified: `Tasks: 1 successful, 1 total` (previously 6 total).

---

### Backwards Compatibility

All changes are **additive only**:
- No existing API endpoints were modified (same request/response format)
- No existing SDK public methods were changed
- New endpoints: `POST /api/remember/batch`, sidecar `POST /embed-batch`
- New SDK method: `rememberBatch()`
- New optional config: `httpClient`
- All existing tests remain unaffected
