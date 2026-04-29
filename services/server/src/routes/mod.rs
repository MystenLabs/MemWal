//! HTTP route handlers, split by endpoint family.
//!
//! Each submodule owns a related group of handlers. Shared helpers
//! (embedding generation, LLM chat, blob cleanup, string truncation,
//! and OpenAI request/response types) live here in `mod.rs` for now —
//! they will move into `pipeline/ingest/` modules in Phase 2 of the
//! refactor.

mod admin;
mod analyze;
mod recall;
mod remember;
mod sponsor;

// Re-export every handler so `main.rs` keeps using `routes::<name>`
// without having to know which submodule each handler lives in.
pub use admin::{ask, health, restore};
pub use analyze::analyze;
pub use recall::{recall, recall_manual};
pub use remember::{remember, remember_manual};
pub use sponsor::{sponsor_execute_proxy, sponsor_proxy};

use crate::storage::db::VectorDb;
use crate::types::{AppError, Config};

// ============================================================
// String truncation helper (used in several `tracing::info!` lines)
// ============================================================

/// Truncate a string to at most `max_bytes` bytes without splitting a UTF-8
/// character.  Falls back to the nearest char boundary when `max_bytes` lands
/// inside a multi-byte sequence (e.g. emoji).
pub(super) fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ============================================================
// Embedding — OpenRouter/OpenAI API (with mock fallback)
// ============================================================

/// OpenAI-compatible embedding request
#[derive(serde::Serialize)]
struct EmbeddingApiRequest {
    model: String,
    input: String,
}

/// OpenAI-compatible embedding response
#[derive(serde::Deserialize)]
struct EmbeddingApiResponse {
    data: Vec<EmbeddingData>,
}

#[derive(serde::Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

/// Generate an embedding vector from text.
/// Uses OpenRouter/OpenAI API when OPENAI_API_KEY is set, mock otherwise.
pub(super) async fn generate_embedding(
    client: &reqwest::Client,
    config: &Config,
    text: &str,
) -> Result<Vec<f32>, AppError> {
    match &config.openai_api_key {
        Some(api_key) => {
            // Real embedding via OpenRouter/OpenAI-compatible API
            let url = format!("{}/embeddings", config.openai_api_base);

            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&EmbeddingApiRequest {
                    model: "openai/text-embedding-3-small".to_string(),
                    input: text.to_string(),
                })
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("Embedding API request failed: {}", e)))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(AppError::Internal(format!(
                    "Embedding API error ({}): {}", status, body
                )));
            }

            let api_resp: EmbeddingApiResponse = resp.json().await.map_err(|e| {
                AppError::Internal(format!("Failed to parse embedding response: {}", e))
            })?;

            let vector = api_resp.data
                .into_iter()
                .next()
                .ok_or_else(|| AppError::Internal("Embedding API returned no data".into()))?
                .embedding;
            Ok(vector)
        }
        None => {
            // Mock embedding (deterministic hash-based)
            tracing::warn!("  → Using MOCK embedding (no OPENAI_API_KEY set)");
            use sha2::Digest;
            let hash = sha2::Sha256::digest(text.as_bytes());
            let mock_vector: Vec<f32> = hash
                .iter()
                .cycle()
                .take(1536)
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

// ============================================================
// Chat completion — OpenRouter/OpenAI shared types
// Used by `extract_facts_llm` (in analyze.rs) and `ask` (in admin.rs).
// ============================================================

/// Chat completion request for OpenRouter/OpenAI
#[derive(serde::Serialize)]
pub(super) struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
}

#[derive(serde::Serialize)]
pub(super) struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Chat completion response
#[derive(serde::Deserialize)]
pub(super) struct ChatCompletionResponse {
    pub choices: Vec<ChatChoice>,
}

#[derive(serde::Deserialize)]
pub(super) struct ChatChoice {
    pub message: ChatMessageResp,
}

#[derive(serde::Deserialize)]
pub(super) struct ChatMessageResp {
    pub content: String,
}

// ============================================================
// Reactive blob cleanup
// ============================================================

/// Reactively delete an expired blob from the vector DB.
/// Called when Walrus returns 404 (blob expired / not found).
/// Errors are logged but not propagated — cleanup is best-effort.
pub(super) async fn cleanup_expired_blob(db: &VectorDb, blob_id: &str) {
    match db.delete_by_blob_id(blob_id).await {
        Ok(rows) => {
            tracing::info!(
                "reactive cleanup: deleted {} vector entries for expired blob_id={}",
                rows, blob_id
            );
        }
        Err(e) => {
            tracing::error!(
                "reactive cleanup failed for blob_id={}: {}",
                blob_id, e
            );
        }
    }
}
