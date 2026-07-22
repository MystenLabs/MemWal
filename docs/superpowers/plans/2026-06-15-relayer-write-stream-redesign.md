## Relayer write-stream redesign implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Walrus upload concurrency budget from the TypeScript sidecar into the Rust relayer so write-stream overload cannot build unbounded sidecar queues.

**Architecture:** Add a `tokio::sync::Semaphore`-based `WriteStreamLimiter` to `AppState`. Handlers acquire a permit before starting prep work; wallet workers acquire a permit before calling `/walrus/upload`. The same permit pool caps total active writes. The sidecar keeps its existing upload limiter as a higher safety net.

**Tech Stack:** Rust, Axum, Tokio, Apalis, Prometheus, PostgreSQL, TypeScript/Express sidecar.

---

## File Structure

| File | Responsibility |
|---|---|
| `services/server/src/services/write_stream.rs` (create) | `WriteStreamLimiter`, permit guard, acquisition error, unit tests. |
| `services/server/src/services/mod.rs` (modify) | Export the new module and its public types. |
| `services/server/src/types.rs` (modify) | Add `write_stream_limiter` to `AppState`; add config fields for `WRITE_STREAM_MAX_CONCURRENCY` and `WRITE_STREAM_ACQUIRE_TIMEOUT_MS`. |
| `services/server/src/main.rs` (modify) | Construct and inject `WriteStreamLimiter` into `AppState`. |
| `services/server/src/observability.rs` (modify) | Register new Prometheus metrics for permit state and acquisition outcomes. |
| `services/server/src/routes/mod.rs` (modify) | Add small shared helper to translate a permit acquisition timeout into a `429` `AppError`. |
| `services/server/src/routes/remember.rs` (modify) | Gate `/api/remember`, `/api/remember/bulk`, `/api/remember/manual` with the limiter. |
| `services/server/src/routes/analyze.rs` (modify) | Gate `/api/analyze` production and benchmark paths with the limiter. |
| `services/server/src/jobs.rs` (modify) | Gate `execute_wallet_job` upload path with the limiter. |

---

### Task 1: Create `WriteStreamLimiter`

**Files:**
- Create: `services/server/src/services/write_stream.rs`
- Modify: `services/server/src/services/mod.rs`

- [ ] **Step 1: Write the failing unit-test file**

Create `services/server/src/services/write_stream.rs` with tests first:

```rust
//! Write-stream concurrency limiter.
//!
//! Owns the single in-process budget for active write operations
//! (prep + upload). Every memory item that will result in a sidecar
//! /walrus/upload call must acquire a permit before starting work and
//! release it when the active phase ends.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::time::error::Elapsed;

const DEFAULT_WRITE_STREAM_MAX_CONCURRENCY: usize = 8;
const MIN_WRITE_STREAM_MAX_CONCURRENCY: usize = 1;
const MAX_WRITE_STREAM_MAX_CONCURRENCY: usize = 100;

#[derive(Debug)]
pub enum AcquireError {
    Timeout,
    Closed,
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcquireError::Timeout => write!(f, "write stream concurrency limit reached"),
            AcquireError::Closed => write!(f, "write stream limiter closed"),
        }
    }
}

impl std::error::Error for AcquireError {}

/// Guard that releases one or more permits when dropped.
pub struct WriteStreamPermit {
    semaphore: Arc<Semaphore>,
    permits: usize,
}

impl Drop for WriteStreamPermit {
    fn drop(&mut self) {
        self.semaphore.add_permits(self.permits);
    }
}

/// In-process concurrency limiter for the write stream.
#[derive(Clone, Debug)]
pub struct WriteStreamLimiter {
    semaphore: Arc<Semaphore>,
    max_permits: usize,
}

impl WriteStreamLimiter {
    pub fn new(max_permits: usize) -> Self {
        let max_permits = max_permits
            .max(MIN_WRITE_STREAM_MAX_CONCURRENCY)
            .min(MAX_WRITE_STREAM_MAX_CONCURRENCY);
        Self {
            semaphore: Arc::new(Semaphore::new(max_permits)),
            max_permits,
        }
    }

    pub fn default_limiter() -> Self {
        Self::new(DEFAULT_WRITE_STREAM_MAX_CONCURRENCY)
    }

    pub fn max_permits(&self) -> usize {
        self.max_permits
    }

    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }

    /// Acquire a single permit, waiting up to `timeout`.
    pub async fn acquire(&self, timeout: Duration) -> Result<WriteStreamPermit, AcquireError> {
        self.acquire_many(1, timeout).await
    }

    /// Acquire `n` permits atomically with respect to this call, waiting up to `timeout`.
    /// The returned guard releases all `n` permits on drop.
    pub async fn acquire_many(
        &self,
        n: usize,
        timeout: Duration,
    ) -> Result<WriteStreamPermit, AcquireError> {
        if n == 0 {
            return Ok(WriteStreamPermit {
                semaphore: Arc::clone(&self.semaphore),
                permits: 0,
            });
        }
        let n = n.min(self.max_permits);
        let permit = tokio::time::timeout(timeout, self.semaphore.acquire_many(n as u32))
            .await
            .map_err(|_: Elapsed| AcquireError::Timeout)?
            .map_err(|_| AcquireError::Closed)?;
        permit.forget();
        Ok(WriteStreamPermit {
            semaphore: Arc::clone(&self.semaphore),
            permits: n,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_returns_permit_when_available() {
        let limiter = WriteStreamLimiter::new(1);
        let permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        assert_eq!(limiter.available_permits(), 0);
        drop(permit);
        assert_eq!(limiter.available_permits(), 1);
    }

    #[tokio::test]
    async fn acquire_times_out_when_exhausted() {
        let limiter = WriteStreamLimiter::new(1);
        let _permit = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        let err = limiter
            .acquire(Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(matches!(err, AcquireError::Timeout));
    }

    #[tokio::test]
    async fn acquire_many_returns_all_or_none() {
        let limiter = WriteStreamLimiter::new(3);
        let _p1 = limiter.acquire(Duration::from_secs(1)).await.unwrap();
        // asking for 3 when only 2 are free should time out
        let err = limiter
            .acquire_many(3, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(matches!(err, AcquireError::Timeout));
        assert_eq!(limiter.available_permits(), 2);
        let p23 = limiter.acquire_many(2, Duration::from_secs(1)).await.unwrap();
        assert_eq!(limiter.available_permits(), 0);
        drop(p23);
        assert_eq!(limiter.available_permits(), 2);
    }

    #[tokio::test]
    async fn zero_permits_noop() {
        let limiter = WriteStreamLimiter::new(1);
        let guard = limiter.acquire_many(0, Duration::from_secs(1)).await.unwrap();
        assert_eq!(guard.permits, 0);
        assert_eq!(limiter.available_permits(), 1);
    }

    #[tokio::test]
    async fn clamps_out_of_range_values() {
        let low = WriteStreamLimiter::new(0);
        assert_eq!(low.max_permits(), MIN_WRITE_STREAM_MAX_CONCURRENCY);
        let high = WriteStreamLimiter::new(10_000);
        assert_eq!(high.max_permits(), MAX_WRITE_STREAM_MAX_CONCURRENCY);
    }
}
```

- [ ] **Step 2: Run the tests to verify they compile and fail**

Run:

```bash
cd services/server
cargo test --lib services::write_stream -- --nocapture
```

Expected: compile succeeds, tests pass (this module is self-contained, so the first test run already passes).

- [ ] **Step 3: Export the module from `services/mod.rs`**

Modify `services/server/src/services/mod.rs`:

```rust
pub mod embedder;
pub mod extractor;
pub mod llm_chat;
pub mod ranker;
pub mod write_stream;

// Placeholder module — reserved namespace for the consolidator
pub mod consolidator;

pub use embedder::{Embedder, OpenAiEmbedder};
pub use extractor::{Extractor, LlmExtractor};
pub use ranker::{CompositeRanker, Ranker};
pub use write_stream::{WriteStreamLimiter, WriteStreamPermit, WriteStreamSnapshot};
```

- [ ] **Step 4: Run the tests again**

Run:

```bash
cd services/server
cargo test --lib services::write_stream -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/server/src/services/write_stream.rs services/server/src/services/mod.rs
git commit -m "feat(write-stream): add WriteStreamLimiter with unit tests"
```

---

### Task 2: Wire `WriteStreamLimiter` into `AppState` and `Config`

**Files:**
- Modify: `services/server/src/types.rs`
- Modify: `services/server/src/main.rs`

- [ ] **Step 1: Add config fields and parsing**

In `services/server/src/types.rs`, add to the `Config` struct:

```rust
/// Maximum concurrent active write-stream operations (prep + upload).
pub write_stream_max_concurrency: usize,
/// How long a handler waits for a write-stream permit before returning 429.
pub write_stream_acquire_timeout: std::time::Duration,
```

Add helper functions near the other env-parsing helpers:

```rust
pub(crate) fn parse_write_stream_max_concurrency() -> usize {
    std::env::var("WRITE_STREAM_MAX_CONCURRENCY")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .map(|v| v.clamp(1, 100))
        .unwrap_or(8)
}

pub(crate) fn parse_write_stream_acquire_timeout() -> std::time::Duration {
    let millis = std::env::var("WRITE_STREAM_ACQUIRE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|v| v.clamp(100, 60_000))
        .unwrap_or(5_000);
    std::time::Duration::from_millis(millis)
}
```

In `Config::from_env()` (around line 300), add:

```rust
write_stream_max_concurrency: parse_write_stream_max_concurrency(),
write_stream_acquire_timeout: parse_write_stream_acquire_timeout(),
```

- [ ] **Step 2: Add `write_stream_limiter` to `AppState`**

In `services/server/src/types.rs`, add inside `AppState`:

```rust
/// In-process concurrency limiter for write operations.
pub write_stream_limiter: Arc<WriteStreamLimiter>,
```

- [ ] **Step 3: Import `WriteStreamLimiter` in `types.rs`**

At the top of `services/server/src/types.rs`, change:

```rust
use crate::services::{Embedder, Extractor, Ranker};
```

to:

```rust
use crate::services::{Embedder, Extractor, Ranker, WriteStreamLimiter};
```

- [ ] **Step 4: Construct the limiter in `main.rs`**

In `services/server/src/main.rs`, after the `config` is wrapped in `Arc` (around line 440), add:

```rust
let write_stream_limiter = Arc::new(WriteStreamLimiter::new(
    config.write_stream_max_concurrency,
));
tracing::info!(
    "  write stream limiter: max_concurrency={} acquire_timeout_ms={}",
    write_stream_limiter.max_permits(),
    config.write_stream_acquire_timeout.as_millis(),
);
```

Then add `write_stream_limiter` to the `AppState` initialization:

```rust
let state = Arc::new(AppState {
    db,
    config: Arc::clone(&config),
    http_client,
    key_pool,
    alerts,
    engine,
    embedder,
    extractor,
    ranker,
    redis,
    fallback_rate_limit: tokio::sync::Mutex::new(crate::rate_limit::InMemoryFallback::default()),
    remember_job_storage: remember_job_storage.clone(),
    wallet_storage: wallet_storage.clone(),
    bulk_job_storage: bulk_job_storage.clone(),
    blob_cache_ttl,
    blob_cache_max_bytes,
    embedding_cache_ttl,
    write_stream_limiter,
});
```

- [ ] **Step 5: Compile to verify wiring**

Run:

```bash
cd services/server
cargo check
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add services/server/src/types.rs services/server/src/main.rs
git commit -m "feat(write-stream): wire WriteStreamLimiter into AppState and Config"
```

---

### Task 3: Add Prometheus metrics for the limiter

**Files:**
- Modify: `services/server/src/observability.rs`

- [ ] **Step 1: Register static metrics**

Add near the other `LazyLock` metric definitions in `services/server/src/observability.rs`:

```rust
static WRITE_STREAM_PERMITS_TOTAL: LazyLock<IntGauge> = LazyLock::new(|| {
    prometheus::register_int_gauge!(
        "memwal_write_stream_permits_total",
        "Total configured write-stream permits."
    )
    .expect("register memwal_write_stream_permits_total")
});

static WRITE_STREAM_PERMITS_AVAILABLE: LazyLock<IntGauge> = LazyLock::new(|| {
    prometheus::register_int_gauge!(
        "memwal_write_stream_permits_available",
        "Currently available write-stream permits."
    )
    .expect("register memwal_write_stream_permits_available")
});

static WRITE_STREAM_WAITERS_TOTAL: LazyLock<IntGauge> = LazyLock::new(|| {
    prometheus::register_int_gauge!(
        "memwal_write_stream_waiters_total",
        "Tasks currently waiting for a write-stream permit."
    )
    .expect("register memwal_write_stream_waiters_total")
});

static WRITE_STREAM_ACQUIRED_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    prometheus::register_int_counter_vec!(
        "memwal_write_stream_acquired_total",
        "Write-stream permit acquisition outcomes.",
        &["result"]
    )
    .expect("register memwal_write_stream_acquired_total")
});

static WRITE_STREAM_REJECTED_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    prometheus::register_int_counter_vec!(
        "memwal_write_stream_rejected_total",
        "Requests rejected because the write stream is saturated.",
        &["route"]
    )
    .expect("register memwal_write_stream_rejected_total")
});
```

- [ ] **Step 2: Add observation helper**

Add a public helper function:

```rust
pub fn observe_write_stream_state(total: usize, available: usize, waiters: usize) {
    WRITE_STREAM_PERMITS_TOTAL.set(total as i64);
    WRITE_STREAM_PERMITS_AVAILABLE.set(available as i64);
    WRITE_STREAM_WAITERS_TOTAL.set(waiters as i64);
}

pub fn record_write_stream_acquired(result: &str) {
    WRITE_STREAM_ACQUIRED_TOTAL.with_label_values(&[result]).inc();
}

pub fn record_write_stream_rejected(route: &str) {
    WRITE_STREAM_REJECTED_TOTAL.with_label_values(&[route]).inc();
}
```

- [ ] **Step 3: Compile**

```bash
cd services/server
cargo check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add services/server/src/observability.rs
git commit -m "feat(write-stream): add Prometheus metrics for limiter state"
```

---

### Task 4: Add shared helper to translate permit timeout to `AppError`

**Files:**
- Modify: `services/server/src/routes/mod.rs`

- [ ] **Step 1: Add helper function**

At the end of `services/server/src/routes/mod.rs`, before the `#[cfg(test)]` block, add:

```rust
use crate::services::write_stream::AcquireError;

/// Convert a write-stream permit acquisition timeout into a 429 response.
pub(super) fn write_stream_saturated(route: &str) -> AppError {
    crate::observability::record_write_stream_rejected(route);
    AppError::RateLimited(
        "Write stream concurrency limit reached; retry after a short delay".into(),
    )
}
```

- [ ] **Step 2: Confirm `AppError::RateLimited` exists**

`services/server/src/types.rs` already has `AppError::RateLimited(String)`, which maps to HTTP 429. No new variant is needed.

- [ ] **Step 3: Compile**

```bash
cd services/server
cargo check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add services/server/src/routes/mod.rs services/server/src/types.rs
git commit -m "feat(write-stream): add saturated helper using RateLimited"
```

---

### Task 5: Gate `/api/remember` and `/api/remember/bulk`

**Files:**
- Modify: `services/server/src/routes/remember.rs`

- [ ] **Step 1: Modify `remember` handler**

In `services/server/src/routes/remember.rs`, in the `remember` handler (around line 616), after inserting the `remember_jobs` row and before calling `spawn_prepare_remember_job`, add permit acquisition:

```rust
// Acquire a write-stream permit before starting prep work.
let permit = match state
    .write_stream_limiter
    .acquire(state.config.write_stream_acquire_timeout)
    .await
{
    Ok(permit) => {
        crate::routes::record_write_stream_acquired_success();
        permit
    }
    Err(_) => {
        return Err(crate::routes::write_stream_saturated("/api/remember"));
    }
};

spawn_prepare_remember_job(
    Arc::clone(&state),
    job_id.clone(),
    text,
    owner_owned,
    namespace_owned,
    auth.public_key.clone(),
    permit,
);
```

- [ ] **Step 2: Update `spawn_prepare_remember_job` signature and release**

Change the function signature:

```rust
fn spawn_prepare_remember_job(
    state: Arc<AppState>,
    job_id: String,
    text: String,
    owner: String,
    namespace: String,
    agent_public_key: String,
    _permit: crate::services::write_stream::WriteStreamPermit,
) {
```

The permit drops when the spawned task finishes, which is after the wallet job is enqueued. This is intentional: prep work is gated, and the permit is released once prep hands off to durable queue.

- [ ] **Step 3: Modify `remember_bulk` handler**

In `remember_bulk`, after inserting all rows and before spawning prep, add:

```rust
let item_count = pending_items.len();
let permits = match state
    .write_stream_limiter
    .acquire_many(item_count, state.config.write_stream_acquire_timeout)
    .await
{
    Ok(permits) => {
        crate::routes::record_write_stream_acquired_success();
        permits
    }
    Err(_) => {
        return Err(crate::routes::write_stream_saturated("/api/remember/bulk"));
    }
};
```

Then pass the permits to `spawn_prepare_bulk_remember_job`:

```rust
spawn_prepare_bulk_remember_job(
    Arc::clone(&state),
    owner.clone(),
    auth.public_key.clone(),
    pending_items,
    permits,
);
```

- [ ] **Step 4: Update `spawn_prepare_bulk_remember_job` signature**

Change:

```rust
fn spawn_prepare_bulk_remember_job(
    state: Arc<AppState>,
    owner: String,
    agent_public_key: String,
    pending_items: Vec<PendingBulkRememberItem>,
    _permits: crate::services::write_stream::WriteStreamPermit,
) {
```

The permit guard is dropped when the prep task completes.

- [ ] **Step 5: Compile and run remember route tests**

```bash
cd services/server
cargo check
cargo test --lib routes::remember -- --nocapture
```

Expected: compile succeeds, existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/server/src/routes/remember.rs
git commit -m "feat(write-stream): gate remember and remember/bulk with limiter"
```

---

### Task 6: Gate `/api/remember/manual` and `/api/analyze`

**Files:**
- Modify: `services/server/src/routes/remember.rs`
- Modify: `services/server/src/routes/analyze.rs`

- [ ] **Step 1: Gate `remember_manual`**

In `remember_manual`, after validation and before calling `engine.store_blob`, add:

```rust
let _permit = match state
    .write_stream_limiter
    .acquire(state.config.write_stream_acquire_timeout)
    .await
{
    Ok(permit) => {
        crate::routes::record_write_stream_acquired_success();
        permit
    }
    Err(_) => {
        return Err(crate::routes::write_stream_saturated("/api/remember/manual"));
    }
};
```

The `_permit` variable is dropped at the end of the handler after the synchronous `store_blob` call completes.

- [ ] **Step 2: Gate `analyze` production path**

In `services/server/src/routes/analyze.rs`, after fact extraction and **before** inserting `remember_jobs` rows, add:

```rust
let fact_count = facts.len();
let _permits = match state
    .write_stream_limiter
    .acquire_many(fact_count, state.config.write_stream_acquire_timeout)
    .await
{
    Ok(permits) => {
        crate::routes::record_write_stream_acquired_success();
        permits
    }
    Err(_) => {
        return Err(crate::routes::write_stream_saturated("/api/analyze"));
    }
};
```

This is done before row insertion because analyze rows are created with `status='pending'` and the stale-job sweeper does not clean up pending rows. The permit guard is dropped after the prep/enqueue loop finishes.

- [ ] **Step 3: Gate `analyze` benchmark path**

In the benchmark-mode branch (around line 371), wrap each fact's synchronous `store_blob` with a permit. Replace the `store_tasks` map closure body:

```rust
async move {
    let vector = state.embedder.embed(&fact.text).await?;
    let _permit = state
        .write_stream_limiter
        .acquire(std::time::Duration::from_secs(60))
        .await
        .map_err(|_| {
            AppError::Internal("write stream limiter unavailable".into())
        })?;
    crate::routes::record_write_stream_acquired_success();
    let mref = state
        .engine
        .store_blob(
            &owner,
            &namespace,
            fact.text.as_bytes(),
            &vector,
            fact.importance,
            Some(&agent_pk),
        )
        .await?;
    Ok::<_, AppError>(AnalyzeAcceptedFact {
        text: fact.text,
        id: mref.id.clone(),
        job_id: mref.id,
    })
}
```

- [ ] **Step 4: Compile and run tests**

```bash
cd services/server
cargo check
cargo test --lib routes::analyze -- --nocapture
```

Expected: compile succeeds, existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/server/src/routes/remember.rs services/server/src/routes/analyze.rs
git commit -m "feat(write-stream): gate remember/manual and analyze with limiter"
```

---

### Task 7: Gate wallet worker upload path

**Files:**
- Modify: `services/server/src/jobs.rs`

- [ ] **Step 1: Acquire permit in `execute_upload_and_transfer`**

In `services/server/src/jobs.rs`, in `execute_upload_and_transfer`, after decoding the encrypted bytes and before the `upload_blob` call, add:

```rust
// Acquire a write-stream permit before hitting the sidecar. This ensures
// the sidecar upload queue cannot grow beyond the Rust-managed budget.
let _permit = match state
    .write_stream_limiter
    .acquire(std::time::Duration::from_secs(60))
    .await
{
    Ok(permit) => {
        crate::routes::record_write_stream_acquired_success();
        permit
    }
    Err(_) => {
        // Limiter closed or timeout — leave job in queue for retry.
        return Err(WalletJobError::Transient(
            "write stream permit unavailable; will retry".into(),
        )
        .into_apalis_error());
    }
};
```

- [ ] **Step 2: Ensure permit is released on all paths**

The `_permit` guard is dropped when `execute_upload_and_transfer` returns. Verify that all early returns in the function use `?` or explicit `return` that goes through the function scope exit. No extra code needed if the guard is declared in the function body.

- [ ] **Step 3: Compile and run tests**

```bash
cd services/server
cargo check
cargo test --lib jobs -- --nocapture
```

Expected: compile succeeds, tests pass.

- [ ] **Step 4: Commit**

```bash
git add services/server/src/jobs.rs
git commit -m "feat(write-stream): gate wallet worker upload with limiter"
```

---

### Task 8: Add snapshot method and wire metric emission

**Files:**
- Modify: `services/server/src/services/write_stream.rs`
- Modify: `services/server/src/main.rs`
- Modify: `services/server/src/routes/mod.rs`
- Modify: `services/server/src/jobs.rs`

To avoid a circular module dependency (`types` → `services/write_stream` → `observability` → `types`), the limiter itself does not call observability. Callers record acquisition outcomes, and a background task polls a snapshot for gauges.

- [ ] **Step 1: Track waiter count and add snapshot**

Add to `services/server/src/services/write_stream.rs`:

```rust
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Debug)]
pub struct WriteStreamLimiter {
    semaphore: Arc<Semaphore>,
    max_permits: usize,
    waiters: Arc<AtomicUsize>,
}

#[derive(Clone, Copy, Debug)]
pub struct WriteStreamSnapshot {
    pub total: usize,
    pub available: usize,
    pub waiters: usize,
}
```

Update constructors:

```rust
pub fn new(max_permits: usize) -> Self {
    let max_permits = max_permits
        .max(MIN_WRITE_STREAM_MAX_CONCURRENCY)
        .min(MAX_WRITE_STREAM_MAX_CONCURRENCY);
    Self {
        semaphore: Arc::new(Semaphore::new(max_permits)),
        max_permits,
        waiters: Arc::new(AtomicUsize::new(0)),
    }
}
```

Add method:

```rust
pub fn snapshot(&self) -> WriteStreamSnapshot {
    WriteStreamSnapshot {
        total: self.max_permits,
        available: self.semaphore.available_permits(),
        waiters: self.waiters.load(Ordering::Relaxed),
    }
}
```

- [ ] **Step 2: Update `acquire_many` to maintain waiter count**

```rust
pub async fn acquire_many(
    &self,
    n: usize,
    timeout: Duration,
) -> Result<WriteStreamPermit, AcquireError> {
    if n == 0 {
        return Ok(WriteStreamPermit {
            semaphore: Arc::clone(&self.semaphore),
            permits: 0,
        });
    }
    let n = n.min(self.max_permits);
    self.waiters.fetch_add(1, Ordering::Relaxed);
    let result = tokio::time::timeout(timeout, self.semaphore.acquire_many(n as u32))
        .await
        .map_err(|_: Elapsed| AcquireError::Timeout)
        .and_then(|res| res.map_err(|_| AcquireError::Closed));
    self.waiters.fetch_sub(1, Ordering::Relaxed);
    match result {
        Ok(permit) => {
            permit.forget();
            Ok(WriteStreamPermit {
                semaphore: Arc::clone(&self.semaphore),
                permits: n,
            })
        }
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 3: Record acquisition outcomes in route helper**

Update `write_stream_saturated` in `services/server/src/routes/mod.rs`:

```rust
pub(super) fn write_stream_saturated(route: &str) -> AppError {
    crate::observability::record_write_stream_rejected(route);
    crate::observability::record_write_stream_acquired("timeout");
    AppError::RateLimited(
        "Write stream concurrency limit reached; retry after a short delay".into(),
    )
}
```

Add a success-recording helper:

```rust
pub(super) fn record_write_stream_acquired_success() {
    crate::observability::record_write_stream_acquired("success");
}
```

- [ ] **Step 4: Record success in callers**

In `services/server/src/routes/remember.rs`, after each successful acquisition:

```rust
crate::routes::record_write_stream_acquired_success();
```

Same in `services/server/src/routes/analyze.rs` and `services/server/src/jobs.rs`.

- [ ] **Step 5: Add background snapshot task in `main.rs`**

After `AppState` is constructed, spawn:

```rust
{
    let state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            let snap = state.write_stream_limiter.snapshot();
            crate::observability::observe_write_stream_state(
                snap.total,
                snap.available,
                snap.waiters,
            );
        }
    });
}
```

- [ ] **Step 6: Compile and test**

```bash
cd services/server
cargo check
cargo test --lib services::write_stream -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/server/src/services/write_stream.rs services/server/src/main.rs services/server/src/routes/mod.rs services/server/src/routes/remember.rs services/server/src/routes/analyze.rs services/server/src/jobs.rs
git commit -m "feat(write-stream): emit limiter state and acquisition metrics"
```

---

### Task 9: Update sidecar safety-net configuration

**Files:**
- Modify: `services/server/scripts/sidecar/config.ts`

- [ ] **Step 1: Change sidecar default so it is a higher safety net**

In `services/server/scripts/sidecar/config.ts`, change:

```typescript
export const WALRUS_UPLOAD_MAX_CONCURRENCY = parsePositiveIntEnv(
    "WALRUS_UPLOAD_MAX_CONCURRENCY",
    Math.max(1, SERVER_SUI_PRIVATE_KEYS.length || 1),
    1,
    100,
);
```

to:

```typescript
export const WALRUS_UPLOAD_MAX_CONCURRENCY = parsePositiveIntEnv(
    "WALRUS_UPLOAD_MAX_CONCURRENCY",
    Math.max(12, SERVER_SUI_PRIVATE_KEYS.length || 1),
    1,
    100,
);
```

This keeps the sidecar ceiling above the Rust default of 8 so it only fires as defense-in-depth.

- [ ] **Step 2: Compile sidecar TypeScript**

```bash
cd services/server/scripts
npx tsc --noEmit sidecar/config.ts
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add services/server/scripts/sidecar/config.ts
git commit -m "feat(sidecar): raise default upload concurrency safety net"
```

---

### Task 10: Add integration test for saturation behavior

**Files:**
- Modify: `services/server/src/routes/remember.rs` (add tests at the bottom)

- [ ] **Step 1: Add a helper to create a test limiter**

If not already possible, add a `#[cfg(test)]` helper in `services/server/src/services/write_stream.rs`:

```rust
#[cfg(test)]
impl WriteStreamLimiter {
    pub fn test_new(max_permits: usize) -> Self {
        Self::new(max_permits)
    }
}
```

- [ ] **Step 2: Add saturation unit test in `remember.rs` tests**

At the bottom of `services/server/src/routes/remember.rs` `mod tests`, add a test that exercises the limiter directly (since full handler integration tests need running DB/sidecar):

```rust
#[tokio::test]
async fn write_stream_limiter_blocks_beyond_capacity() {
    use std::time::Duration;
    use crate::services::write_stream::WriteStreamLimiter;

    let limiter = WriteStreamLimiter::test_new(2);
    let p1 = limiter.acquire(Duration::from_millis(10)).await.unwrap();
    let p2 = limiter.acquire(Duration::from_millis(10)).await.unwrap();
    let timeout = limiter.acquire(Duration::from_millis(10)).await.unwrap_err();
    assert!(matches!(timeout, crate::services::write_stream::AcquireError::Timeout));
    drop(p1);
    drop(p2);
}
```

- [ ] **Step 3: Run tests**

```bash
cd services/server
cargo test --lib routes::remember::tests::write_stream_limiter_blocks_beyond_capacity -- --nocapture
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/server/src/routes/remember.rs services/server/src/services/write_stream.rs
git commit -m "test(write-stream): add saturation unit test"
```

---

### Task 11: Full test suite and lint

**Files:**
- All modified files

- [ ] **Step 1: Run Rust tests**

```bash
cd services/server
cargo test --lib
```

Expected: all tests pass.

- [ ] **Step 2: Run clippy**

```bash
cd services/server
cargo clippy --all-targets -- -D warnings
```

Expected: no warnings. Fix any clippy lints that appear (likely around unused imports or the `_permit` naming).

- [ ] **Step 3: Run sidecar TypeScript tests**

```bash
cd services/server/scripts
npm test
```

Expected: existing tests pass (the sidecar behavior did not change functionally).

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore(write-stream): clippy fixes and test cleanup"
```

---

### Task 12: Documentation updates

**Files:**
- Modify: `docs/relayer/self-hosting.md`
- Modify: `docs/relayer/observability.md`

- [ ] **Step 1: Document new environment variables**

In `docs/relayer/self-hosting.md`, add a section:

```markdown
### Write-stream concurrency

| Variable | Default | Description |
|---|---|---|
| `WRITE_STREAM_MAX_CONCURRENCY` | `8` | Maximum concurrent active write operations (prep + upload) |
| `WRITE_STREAM_ACQUIRE_TIMEOUT_MS` | `5000` | Handler wait for a write slot before returning `429` |

Tune `WRITE_STREAM_MAX_CONCURRENCY` down to reduce sidecar pressure, or up to increase throughput when the sidecar has headroom. Keep it below `WALRUS_UPLOAD_MAX_CONCURRENCY` so the sidecar safety net remains meaningful.
```

- [ ] **Step 2: Document new metrics**

In `docs/relayer/observability.md`, add to the metrics table:

```markdown
| `memwal_write_stream_permits_total` | none | Configured permit ceiling |
| `memwal_write_stream_permits_available` | none | Permits currently free |
| `memwal_write_stream_waiters_total` | none | Tasks waiting for a permit |
| `memwal_write_stream_acquired_total` | `result` | Permit acquisition outcomes |
| `memwal_write_stream_rejected_total` | `route` | Requests rejected with `429` |
```

- [ ] **Step 3: Commit**

```bash
git add docs/relayer/self-hosting.md docs/relayer/observability.md
git commit -m "docs(relayer): document write-stream limiter config and metrics"
```

---

## Self-Review

- [ ] **Spec coverage:**
  - `WriteStreamLimiter` created → Task 1.
  - `AppState` and `Config` wiring → Task 2.
  - Metrics → Task 3 and Task 8.
  - `/api/remember` gated → Task 5.
  - `/api/remember/bulk` gated → Task 5.
  - `/api/remember/manual` gated → Task 6.
  - `/api/analyze` gated → Task 6.
  - Wallet worker upload gated → Task 7.
  - Sidecar safety net retained → Task 9.
  - Tests → Task 10 and Task 11.
  - Docs → Task 12.
- [ ] **Placeholder scan:** No TBD/TODO/"implement later".
- [ ] **Type consistency:** `WriteStreamLimiter::acquire` and `acquire_many` are used consistently across all call sites.
- [ ] **Known follow-ups not in this plan:** distributed limiter for multi-instance deployments (future work in spec).
