//! Benchmark `MemoryEngine`: plaintext in Postgres.
//!
//! Bypasses Walrus and SEAL entirely — memories are stored in the
//! `vector_entries.plaintext` column (added by migration 007). **Not
//! for production**; gated behind `Config::benchmark_mode`, off by
//! default.
//!
//! Implementation (plus the `db.rs` plaintext helpers + migration 007)
//! lands in a later commit. This file currently holds only the type so
//! `engine/mod.rs` compiles as a standalone addition.

use async_trait::async_trait;

use crate::types::{AppError, AuthInfo};

use super::{HydratedMemory, MemoryEngine, MemoryRef};

/// Benchmark engine — stores plaintext directly in Postgres. No Walrus,
/// no SEAL, no Sui keys.
pub struct PlaintextEngine {
    // Holds only the DB handle — wired in the implementation commit.
}

#[async_trait]
impl MemoryEngine for PlaintextEngine {
    async fn store_blob(
        &self,
        _owner: &str,
        _namespace: &str,
        _bytes: &[u8],
        _vector: &[f32],
        _agent_public_key: Option<&str>,
    ) -> Result<MemoryRef, AppError> {
        todo!("PlaintextEngine::store_blob — implemented in a later commit")
    }

    async fn fetch_one(
        &self,
        _owner: &str,
        _blob_id: &str,
        _distance: f64,
        _auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError> {
        todo!("PlaintextEngine::fetch_one — implemented in a later commit")
    }

    async fn fetch_batch(
        &self,
        _owner: &str,
        _hits: &[(String, f64)],
        _auth: &AuthInfo,
    ) -> Result<(Vec<HydratedMemory>, usize), AppError> {
        todo!("PlaintextEngine::fetch_batch — implemented in a later commit")
    }
}
