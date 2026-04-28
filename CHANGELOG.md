# Changelog

## [Unreleased] — optimization/v1

### Rust Server (`services/server`)

#### Database
- **Added** IVFFlat index on `vector_entries.embedding` column (migration 004) for improved write-heavy workload performance
- **Increased** database connection pool from 10 to 20 max connections
- **Added** batch insert method `insert_vectors_batch()` with single-transaction atomicity

#### API Endpoints
- **Added** `POST /api/remember/batch` — batch version of `/api/remember` that processes up to 100 items in a single transaction
- Input validation: max 100 items, no empty texts
- All DB inserts wrapped in one transaction for atomicity

#### Caching
- **Added** Redis-backed search cache (`search_cached()`) with 60-second TTL
  - Cache key format: `search:{owner}:{namespace}:{hash(vector)}`
  - Graceful fallback to direct DB query when Redis is unavailable
  - Applied to `/api/recall` and `/api/recall/manual` endpoints

#### Sidecar
- **Added** `POST /embed-batch` endpoint to sidecar for parallel batch text embedding via OpenAI API
- Rust server includes `generate_embeddings_batch()` with automatic fallback to sequential embedding

#### Walrus
- **Added** `upload_batch()` function for parallel blob uploads using the key pool

#### Infrastructure
- **Enhanced** graceful shutdown: handles both Ctrl+C and SIGTERM signals
  - Properly closes database connection pool on shutdown
  - Kills sidecar process on shutdown

### TypeScript SDK (`packages/sdk`)

- **Added** `signedRequestWithRetry()` — automatic retry with exponential backoff (1s, 2s, 4s) on HTTP 429 and network errors
  - Applied to read-only operations: `recall()`, `recallManual()`, `embed()`
  - Write operations (`remember()`, `analyze()`) use direct requests to avoid duplicates
- **Added** `rememberBatch(items)` method — batch remember matching the server batch endpoint
- **Added** `HttpClient` wrapper (`client.ts`) for connection reuse with keep-alive
  - Injected via optional `httpClient` config parameter (backwards compatible)
- **Added** `createHttpClient()` and `HttpClient` type exports

### Monorepo

- **Added** Turborepo configuration (`turbo.json`) with build pipeline caching
  - `build` depends on `^build` (topological order)
  - `test` depends on `build`
  - Added root `build`, `test`, `typecheck` scripts
- **Added** TypeScript `composite` option to SDK tsconfig for project references support
- **Added** GitHub Actions CI workflow (`.github/workflows/ci.yml`)
  - TypeScript: pnpm cache, build, typecheck
  - Rust: cargo cache (via `rust-cache`), check, clippy
