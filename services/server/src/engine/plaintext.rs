//! Benchmark `MemoryEngine`: plaintext in Postgres.
//!
//! Bypasses SEAL encryption and Walrus upload entirely. Memories are
//! stored in the `vector_entries.plaintext` column (added by migration
//! 005) alongside their vectors. The `blob_id` is a synthetic UUID that
//! also serves as the row's primary key — the same UUID is used for
//! both the row `id` and the engine `blob_id`, so handlers that look
//! up by `blob_id` (the convention from production) keep working
//! unchanged.
//!
//! Ingest cost (per call): ~1 OpenAI embedding round-trip + 1 Postgres
//! INSERT. No SEAL, no Walrus, no Sui transactions. This is what makes
//! benchmark-mode runs orders of magnitude faster than production-mode.
//!
//! **Not for production.** Storing plaintext defeats SEAL's
//! confidentiality guarantee. Gated behind `Config::benchmark_mode`,
//! off by default.

use async_trait::async_trait;
use std::sync::Arc;

use crate::storage::db::VectorDb;
use crate::types::{AppError, AuthInfo};

use super::{HydratedMemory, MemoryEngine, MemoryRecord, MemoryRef};

/// Benchmark engine — only needs the DB. No SEAL, no Walrus, no Sui keys.
pub struct PlaintextEngine {
    db: Arc<VectorDb>,
}

impl PlaintextEngine {
    pub fn new(db: Arc<VectorDb>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl MemoryEngine for PlaintextEngine {
    async fn store(
        &self,
        record: MemoryRecord,
        _auth: &AuthInfo,
    ) -> Result<MemoryRef, AppError> {
        // Synthetic UUID — used both as the row id and the "blob_id"
        // handle handlers see. No real Walrus blob is ever uploaded.
        let id = uuid::Uuid::new_v4().to_string();
        let blob_id = id.clone();

        // Quota accounting uses the plaintext byte length. Production
        // would use ciphertext bytes, but benchmark mode has no
        // ciphertext — plaintext is the closest analog.
        let blob_size = record.text.as_bytes().len() as i64;

        self.db
            .insert_vector_plaintext(
                &id,
                &record.owner,
                &record.namespace,
                &blob_id,
                &record.vector,
                &record.text,
                blob_size,
            )
            .await?;

        Ok(MemoryRef { id, blob_id })
    }

    async fn fetch_one(
        &self,
        blob_id: &str,
        distance: f64,
        _auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError> {
        // Plaintext lookup by synthetic blob_id. Returns None if the row
        // exists but has no plaintext (would mean a production row leaked
        // into a benchmark run — shouldn't happen but handled gracefully).
        match self.db.fetch_plaintext_by_blob_id(blob_id).await {
            Ok(Some(text)) => Ok(Some(HydratedMemory {
                blob_id: blob_id.to_string(),
                text,
                distance,
            })),
            Ok(None) => {
                tracing::warn!(
                    "Benchmark fetch: row {} has NULL plaintext — production row in benchmark DB?",
                    blob_id
                );
                Ok(None)
            }
            Err(AppError::BlobNotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
