//! `MemoryEngine` — persistence abstraction for memory records.
//!
//! Two implementations live alongside this module:
//!
//! - [`walrus_seal::WalrusSealEngine`] — production. SEAL-encrypts each
//!   record, uploads to Walrus, indexes the resulting `blob_id` + vector
//!   in Postgres. Reactive cleanup on Walrus 404s.
//! - [`plaintext::PlaintextEngine`] — benchmark mode. Stores plaintext
//!   directly in Postgres alongside the vector. Bypasses SEAL/Walrus
//!   entirely for fast benchmark runs. **Not for production** — it
//!   defeats SEAL's confidentiality guarantee.
//!
//! Handlers depend on `Arc<dyn MemoryEngine>` and are mode-blind. The
//! engine is selected once at startup in `main.rs` based on
//! `Config::benchmark_mode`.
//!
//! # Scope boundary
//!
//! The engine owns persistence: write bytes, read them back, mark
//! superseded. It does NOT own:
//!
//! - Vector similarity search — that stays on `VectorDb::search_similar`,
//!   called directly from handlers. Search returns `SearchHit { blob_id,
//!   distance }`; handlers turn `blob_id` into `MemoryRef` and pass it
//!   to `engine.fetch_batch` to materialise the plaintext.
//! - Embedding generation — that's the [`Embedder`](crate::services::Embedder)
//!   service.
//! - Quota enforcement — that's the rate-limit middleware.
//! - Auth — middleware.

pub mod plaintext;
pub mod walrus_seal;

use async_trait::async_trait;

use crate::types::{AppError, AuthInfo};

pub use plaintext::PlaintextEngine;
pub use walrus_seal::WalrusSealEngine;

/// A logical memory record as it flows between handlers and the engine.
///
/// Handlers populate this from the HTTP request + the freshly-computed
/// vector + auth-derived owner; the engine encapsulates whatever
/// persistence the configured impl prefers (Walrus blob upload,
/// plaintext column, ...).
pub struct MemoryRecord {
    pub owner: String,
    pub namespace: String,
    pub text: String,
    pub vector: Vec<f32>,
}

/// Opaque reference returned by `engine.store` and consumed by `engine.fetch*`.
///
/// The contents are engine-internal — handlers don't introspect. Both
/// implementations happen to use a `blob_id` string today (production:
/// the Walrus blob ID; benchmark: a synthetic UUID that keys the
/// plaintext row). Future engines could carry richer payloads.
#[derive(Debug, Clone)]
pub struct MemoryRef {
    /// Local Postgres row UUID — assigned by the engine on store.
    pub id: String,
    /// Engine-specific blob identifier. Production: real Walrus blob ID.
    /// Benchmark: synthetic UUID matching `id`. Either way: opaque to
    /// handlers, used as the lookup key for fetch.
    pub blob_id: String,
}

/// A hydrated memory — what `engine.fetch_batch` returns.
pub struct HydratedMemory {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
}

/// Persistence abstraction. Two implementations live in this module
/// (`WalrusSealEngine`, `PlaintextEngine`). Mode is chosen at startup.
#[async_trait]
pub trait MemoryEngine: Send + Sync {
    /// Persist a single memory record. Returns a `MemoryRef` that handlers
    /// pass back into `fetch*` later. The reference must round-trip cleanly
    /// — given a `MemoryRef` returned by this engine, `fetch` must return
    /// a record with the same plaintext.
    async fn store(
        &self,
        record: MemoryRecord,
        auth: &AuthInfo,
    ) -> Result<MemoryRef, AppError>;

    /// Resolve a single search hit to its plaintext. Used by `recall` /
    /// `ask` per-hit, in concurrent fan-out.
    ///
    /// `auth` is required because production fetch needs the delegate
    /// private key for SEAL decrypt; benchmark fetch ignores it.
    async fn fetch_one(
        &self,
        blob_id: &str,
        distance: f64,
        auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError>;
}
