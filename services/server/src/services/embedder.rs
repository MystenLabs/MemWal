//! Embedder service — turns text into a fixed-dimension vector for similarity search.
//!
//! The default production impl (`OpenAiEmbedder`) calls an OpenAI-compatible
//! `/embeddings` endpoint (OpenAI proper, OpenRouter, or any compatible
//! gateway) using `openai/text-embedding-3-small` (1536-dim). When no API
//! key is configured, it falls back to a deterministic hash-based mock so
//! dev environments can run without keys.
//!
//! Lifted verbatim from `routes.rs::generate_embedding` — same model,
//! same request shape, same mock fallback.

use async_trait::async_trait;
use std::sync::Arc;

use crate::types::{AppError, Config};

/// Embedding model used for both ingestion and recall-query embeddings.
/// Kept here (was a `routes.rs` const) — the recall query-embedding cache
/// key in `routes.rs` references it via `crate::services::embedder::EMBEDDING_MODEL`
/// so the cache key changes if the model changes.
pub const EMBEDDING_MODEL: &str = "openai/text-embedding-3-small";

/// Embedding vector dimensionality (text-embedding-3-small). Also the
/// width of the deterministic mock vector.
const EMBEDDING_DIMS: usize = 1536;

#[async_trait]
pub trait Embedder: Send + Sync {
    /// Embed a single text into a vector. Returns the vector or an error if
    /// the embedding API call fails (network, auth, parse).
    async fn embed(&self, text: &str) -> Result<Vec<f32>, AppError>;
}

// ============================================================
// OpenAI / OpenRouter implementation (with mock fallback)
// ============================================================

pub struct OpenAiEmbedder {
    http_client: reqwest::Client,
    config: Arc<Config>,
}

impl OpenAiEmbedder {
    pub fn new(http_client: reqwest::Client, config: Arc<Config>) -> Self {
        Self {
            http_client,
            config,
        }
    }
}

#[async_trait]
impl Embedder for OpenAiEmbedder {
    #[tracing::instrument(name = "embedder.embed", skip_all, fields(text_len = text.len()))]
    async fn embed(&self, text: &str) -> Result<Vec<f32>, AppError> {
        match &self.config.openai_api_key {
            Some(api_key) => {
                // Real embedding via OpenRouter/OpenAI-compatible API
                let url = format!("{}/embeddings", self.config.openai_api_base);

                let resp = self
                    .http_client
                    .post(&url)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .json(&EmbeddingApiRequest {
                        model: EMBEDDING_MODEL.to_string(),
                        input: text.to_string(),
                    })
                    .send()
                    .await
                    .map_err(|e| {
                        AppError::Internal(format!("Embedding API request failed: {}", e))
                    })?;

                if !resp.status().is_success() {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    return Err(AppError::Internal(format!(
                        "Embedding API error ({}): {}",
                        status, body
                    )));
                }

                let api_resp: EmbeddingApiResponse = resp.json().await.map_err(|e| {
                    AppError::Internal(format!("Failed to parse embedding response: {}", e))
                })?;

                let vector = api_resp
                    .data
                    .into_iter()
                    .next()
                    .ok_or_else(|| AppError::Internal("Embedding API returned no data".into()))?
                    .embedding;
                Ok(vector)
            }
            None => {
                // Mock embedding (deterministic hash-based) — for keyless dev
                tracing::warn!("  → Using MOCK embedding (no OPENAI_API_KEY set)");
                use sha2::Digest;
                let hash = sha2::Sha256::digest(text.as_bytes());
                let mock_vector: Vec<f32> = hash
                    .iter()
                    .cycle()
                    .take(EMBEDDING_DIMS)
                    .enumerate()
                    .map(|(i, &b)| {
                        let val = (b as f32 / 255.0) * 2.0 - 1.0;
                        val * (1.0 + (i as f32 * 0.001).sin())
                    })
                    .collect();
                Ok(mock_vector)
            }
        }
    }
}

// ============================================================
// OpenAI-compatible API types (private to this module)
// ============================================================

#[derive(serde::Serialize)]
struct EmbeddingApiRequest {
    model: String,
    input: String,
}

#[derive(serde::Deserialize)]
struct EmbeddingApiResponse {
    data: Vec<EmbeddingData>,
}

#[derive(serde::Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}
