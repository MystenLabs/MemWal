//! `MemoryEngine` — persistence abstraction for memory blobs.
//!
//! Two implementations live alongside this module:
//!
//! - [`walrus_seal::WalrusSealEngine`] — production. Uploads prepared
//!   (SEAL-encrypted) bytes to Walrus, indexes the resulting `blob_id`
//!   + vector in Postgres. On fetch: Redis blob-cache lookup → Walrus
//!   download → SEAL decrypt (batched for `recall`), with reactive
//!   cleanup on Walrus 404s / permanent decrypt failures.
//! - [`plaintext::PlaintextEngine`] — benchmark mode. Stores the bytes
//!   directly in a Postgres `plaintext` column (added by migration 007),
//!   bypassing Walrus and SEAL entirely. **Not for production** — it
//!   defeats SEAL's confidentiality guarantee. Gated behind
//!   `Config::benchmark_mode`, off by default.
//!
//! Handlers and the `jobs.rs` workers depend on `Arc<dyn MemoryEngine>`
//! and are mode-blind. The engine is selected once at startup in
//! `main.rs` from `Config::benchmark_mode`.
//!
//! # Scope boundary
//!
//! The engine owns persistence of the *blob*: write prepared bytes,
//! read them back, clean up dangling index rows. It does NOT own:
//!
//! - **Encryption.** SEAL `seal_encrypt` stays in the request handler
//!   (`analyze`, `remember`) or is done client-side (`remember_manual`).
//!   The engine receives bytes that are already in their stored form —
//!   ciphertext in production, plaintext UTF-8 in benchmark mode. This
//!   preserves the invariant that plaintext never enters a job payload.
//! - **Vector similarity search.** That stays on `VectorDb::search_similar`,
//!   called directly from handlers. Search returns `(blob_id, distance)`;
//!   handlers pass those into `fetch_one` / `fetch_batch` to materialise
//!   the plaintext.
//! - **On-chain metadata + transfer.** The Walrus upload-relay sidecar
//!   handles blob registration; the per-wallet `set_metadata_batch` +
//!   transfer choreography stays in `jobs.rs`. The engine's `store_blob`
//!   only does the upload + the Postgres index row.
//! - **Embedding generation, quota enforcement, auth** — handlers /
//!   middleware, unchanged.

pub mod plaintext;
pub mod walrus_seal;

use async_trait::async_trait;

use crate::types::{AppError, AuthInfo};

pub use plaintext::PlaintextEngine;
pub use walrus_seal::WalrusSealEngine;

/// Opaque reference returned by `store_blob`. Handlers / workers store
/// this; the contents are engine-internal. Both implementations happen
/// to use a `blob_id` string today (production: the Walrus blob ID;
/// benchmark: a synthetic UUID that also keys the plaintext row).
#[derive(Debug, Clone)]
pub struct MemoryRef {
    /// Local Postgres row UUID — assigned by the engine on store.
    pub id: String,
    /// Engine-specific blob identifier. Production: real Walrus blob ID.
    /// Benchmark: synthetic UUID equal to `id`. Either way: opaque to
    /// callers, used as the lookup key for fetch.
    pub blob_id: String,
}

/// A hydrated memory — what `fetch_one` / `fetch_batch` return.
#[derive(Debug, Clone)]
pub struct HydratedMemory {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
}

/// Persistence abstraction. Two implementations live in this module
/// (`WalrusSealEngine`, `PlaintextEngine`). Mode is chosen at startup.
#[async_trait]
pub trait MemoryEngine: Send + Sync {
    /// Persist already-prepared bytes + vector and index the row.
    ///
    /// `bytes` are in stored form — production: SEAL ciphertext;
    /// benchmark: plaintext UTF-8. The engine uploads them (Walrus) or
    /// writes the plaintext column, then inserts the Postgres index row
    /// `(id, owner, namespace, blob_id, vector, blob_size)`. Quota
    /// accounting uses `bytes.len()`.
    ///
    /// `agent_public_key` is forwarded to the Walrus upload-relay so the
    /// blob is registered against the right agent key; benchmark mode
    /// ignores it. Used by `remember_manual` and the `jobs.rs` workers
    /// — the three current copies of the upload-then-index code.
    async fn store_blob(
        &self,
        owner: &str,
        namespace: &str,
        bytes: &[u8],
        vector: &[f32],
        agent_public_key: Option<&str>,
    ) -> Result<MemoryRef, AppError>;

    /// Resolve one search hit to its plaintext.
    ///
    /// Production: Redis blob-cache lookup → on miss, Walrus download +
    /// cache write-back → SEAL decrypt → UTF-8. Returns `Ok(None)` (not
    /// an error) when the blob is gone (Walrus 404 → reactive cleanup of
    /// the index row scoped to `owner`) or the decrypt permanently fails.
    /// Benchmark: reads the `plaintext` column, ignores `auth`.
    ///
    /// Used by `ask` and (Phase 1: left inline) `restore` per-hit, in
    /// concurrent fan-out by the caller.
    async fn fetch_one(
        &self,
        owner: &str,
        blob_id: &str,
        distance: f64,
        auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError>;

    /// Resolve many search hits to plaintext, batching the SEAL decrypt
    /// of cache-cold blobs (production: chunks of `seal_decrypt_batch`).
    ///
    /// Returns `(hydrated, dropped_count)` where `dropped_count` is the
    /// number of hits that couldn't be returned (download failure,
    /// permanent decrypt failure, invalid UTF-8) — surfaced to the
    /// client so "no matches" is distinguishable from "matches we
    /// couldn't return". Reactive cleanup on Walrus 404s / permanent
    /// decrypt failures, scoped to `owner`.
    ///
    /// Used by `recall`. Benchmark: per-id `plaintext` lookups, no
    /// batching needed.
    async fn fetch_batch(
        &self,
        owner: &str,
        hits: &[(String, f64)],
        auth: &AuthInfo,
    ) -> Result<(Vec<HydratedMemory>, usize), AppError>;
}
