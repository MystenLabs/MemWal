//! Benchmark `MemoryEngine`: plaintext in Postgres.
//!
//! Bypasses Walrus and SEAL entirely. Memories are stored in the
//! `vector_entries.plaintext` column (added by migration 008) alongside
//! their vectors. The `blob_id` is a synthetic UUID equal to the row
//! `id`, so handlers that look up by `blob_id` (the production
//! convention) keep working unchanged.
//!
//! Ingest cost (per `store_blob`): one Postgres INSERT — no SEAL, no
//! Walrus, no Sui transactions. That's what makes benchmark-mode runs
//! orders of magnitude faster than production-mode, and is the whole
//! point of separating AI-quality benchmarking from blockchain ops.
//!
//! **Not for production.** Storing plaintext defeats SEAL's
//! confidentiality guarantee. Gated behind `Config::benchmark_mode`,
//! off by default.

use async_trait::async_trait;
use std::sync::Arc;

use crate::storage::db::VectorDb;
use crate::types::{AppError, AuthInfo};

use super::{HydratedMemory, MemoryEngine, MemoryRef};

/// Benchmark engine — stores plaintext directly in Postgres. No Walrus,
/// no SEAL, no Sui keys; only the DB handle.
pub struct PlaintextEngine {
    db: Arc<VectorDb>,
}

impl PlaintextEngine {
    pub fn new(db: Arc<VectorDb>) -> Self {
        Self { db }
    }

    /// Resolve a synthetic blob_id to its plaintext, wrapping it as a
    /// `HydratedMemory`. Shared by `fetch_one` and `fetch_batch`.
    /// Returns `Ok(None)` for a missing row or a NULL plaintext (a
    /// production row leaked into a benchmark DB — logged, handled).
    async fn hydrate(
        &self,
        blob_id: &str,
        distance: f64,
    ) -> Result<Option<HydratedMemory>, AppError> {
        match self.db.fetch_plaintext_by_blob_id(blob_id).await {
            Ok(Some(text)) => Ok(Some(HydratedMemory {
                blob_id: blob_id.to_string(),
                text,
                distance,
            })),
            Ok(None) => {
                tracing::warn!(
                    "benchmark fetch: row {} missing or has NULL plaintext — production row in benchmark DB?",
                    blob_id
                );
                Ok(None)
            }
            Err(AppError::BlobNotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[async_trait]
impl MemoryEngine for PlaintextEngine {
    #[tracing::instrument(
        name = "engine.plaintext.store_blob",
        skip_all,
        fields(owner = %owner, namespace = %namespace, bytes = bytes.len())
    )]
    async fn store_blob(
        &self,
        owner: &str,
        namespace: &str,
        bytes: &[u8],
        vector: &[f32],
        _agent_public_key: Option<&str>,
    ) -> Result<MemoryRef, AppError> {
        // In benchmark mode the "prepared bytes" are plaintext UTF-8 —
        // the handler/client skipped SEAL encrypt. Treat them as such.
        let text = String::from_utf8(bytes.to_vec()).map_err(|e| {
            AppError::BadRequest(format!("benchmark store_blob: bytes not UTF-8: {}", e))
        })?;

        // Synthetic UUID — used both as the row id and the blob_id handle
        // handlers see. No real Walrus blob is ever uploaded.
        let id = uuid::Uuid::new_v4().to_string();
        let blob_id = id.clone();

        // Quota accounting uses the plaintext byte length (production
        // would use ciphertext bytes; benchmark mode has no ciphertext).
        let blob_size = bytes.len() as i64;

        self.db
            .insert_vector_plaintext(&id, owner, namespace, &blob_id, vector, &text, blob_size)
            .await?;

        Ok(MemoryRef { id, blob_id })
    }

    #[tracing::instrument(
        name = "engine.plaintext.fetch_one",
        skip_all,
        fields(blob_id = %blob_id)
    )]
    async fn fetch_one(
        &self,
        _owner: &str,
        blob_id: &str,
        distance: f64,
        _auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError> {
        self.hydrate(blob_id, distance).await
    }

    #[tracing::instrument(
        name = "engine.plaintext.fetch_batch",
        skip_all,
        fields(hits = hits.len())
    )]
    async fn fetch_batch(
        &self,
        _owner: &str,
        hits: &[(String, f64)],
        _auth: &AuthInfo,
    ) -> Result<(Vec<HydratedMemory>, usize), AppError> {
        let mut results = Vec::with_capacity(hits.len());
        let mut dropped = 0usize;
        for (blob_id, distance) in hits {
            match self.hydrate(blob_id, *distance).await? {
                Some(m) => results.push(m),
                None => dropped += 1,
            }
        }
        Ok((results, dropped))
    }
}
