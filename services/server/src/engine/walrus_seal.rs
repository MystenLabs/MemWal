//! Production `MemoryEngine`: Walrus upload + SEAL decrypt + Postgres index.
//!
//! Implementation lands in the next commit. This file currently holds
//! only the type so `engine/mod.rs` compiles as a standalone addition.

use async_trait::async_trait;

use crate::types::{AppError, AuthInfo};

use super::{HydratedMemory, MemoryEngine, MemoryRef};

/// Production engine — uploads prepared ciphertext to Walrus, indexes
/// the row in Postgres, serves reads through the Redis blob cache.
pub struct WalrusSealEngine {
    // Dependencies wired in the implementation commit.
}

#[async_trait]
impl MemoryEngine for WalrusSealEngine {
    async fn store_blob(
        &self,
        _owner: &str,
        _namespace: &str,
        _bytes: &[u8],
        _vector: &[f32],
        _agent_public_key: Option<&str>,
    ) -> Result<MemoryRef, AppError> {
        todo!("WalrusSealEngine::store_blob — implemented in the next commit")
    }

    async fn fetch_one(
        &self,
        _owner: &str,
        _blob_id: &str,
        _distance: f64,
        _auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError> {
        todo!("WalrusSealEngine::fetch_one — implemented in the next commit")
    }

    async fn fetch_batch(
        &self,
        _owner: &str,
        _hits: &[(String, f64)],
        _auth: &AuthInfo,
    ) -> Result<(Vec<HydratedMemory>, usize), AppError> {
        todo!("WalrusSealEngine::fetch_batch — implemented in the next commit")
    }
}
