# Changelog

All notable changes to the MemWal project will be documented in this file.

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

#### 15. Build Script — Turbo Filter for SDK

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
