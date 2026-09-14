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
/// width of the deterministic mock vector, and the fixed width of the
/// `vector_entries.embedding` pgvector column — client-supplied vectors
/// on the manual write path are validated against it.
pub const EMBEDDING_DIMS: usize = 1536;

/// 16384 = 8192 tokens × 2 chars/token under cl100k; do not use admin 64KiB.
///
/// A limit of [`EMBEDDING_MODEL`]'s context window, so it applies only when a
/// provider key is set. The key-less fallback hashes locally with no limit.
pub(crate) const MAX_EMBED_INPUT_BYTES: usize = 16384;

/// Whether a provider 400 complains about input length. Any other 400 (an
/// unknown model, a malformed request) is a server-side problem and must not
/// reach the caller as their input being too long.
fn is_context_length_error(body: &str) -> bool {
    let body = body.to_ascii_lowercase();
    [
        "context_length_exceeded",
        "maximum context length",
        "reduce the length",
        "too many tokens",
        "string too long",
    ]
    .iter()
    .any(|needle| body.contains(needle))
}

fn reject_oversized_embed_input(text: &str) -> Result<(), AppError> {
    if text.len() > MAX_EMBED_INPUT_BYTES {
        return Err(AppError::BadRequest(format!(
            "input is over the embedding input limit of {MAX_EMBED_INPUT_BYTES} bytes"
        )));
    }
    Ok(())
}

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
        embed_text(
            &self.http_client,
            self.config.openai_api_key.as_deref(),
            &self.config.openai_api_base,
            text,
        )
        .await
    }
}

/// The embedding call itself, taking only what it reads from `Config` so the
/// tests can drive it against a local stand-in provider.
async fn embed_text(
    http_client: &reqwest::Client,
    api_key: Option<&str>,
    api_base: &str,
    text: &str,
) -> Result<Vec<f32>, AppError> {
    match api_key {
        Some(api_key) => {
            // The limit is the model's context window, so it guards only the
            // branch that reaches a model (WALM-470).
            reject_oversized_embed_input(text)?;
            // Real embedding via OpenRouter/OpenAI-compatible API
            let url = format!("{}/embeddings", api_base);

            let started = std::time::Instant::now();
            let resp = http_client
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
                    crate::observability::observe_external(
                        "openai",
                        "embeddings",
                        "transport_error",
                        started.elapsed(),
                    );
                    AppError::Internal(format!("Embedding API request failed: {}", e))
                })?;
            let status_label = resp.status().as_u16().to_string();
            crate::observability::observe_external(
                "openai",
                "embeddings",
                &status_label,
                started.elapsed(),
            );

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                if crate::services::extractor::is_upstream_status_transient(status) {
                    return Err(AppError::UpstreamUnavailable(format!(
                        "Embedding API upstream error ({}): {}",
                        status, body
                    )));
                }
                if status == reqwest::StatusCode::BAD_REQUEST && is_context_length_error(&body) {
                    tracing::warn!(%status, body, "embedding API rejected the input length");
                    return Err(AppError::BadRequest(
                        "embedding input exceeds the model context limit".into(),
                    ));
                }
                return Err(AppError::Internal(format!(
                    "Embedding API error ({}): {}",
                    status, body
                )));
            }

            // same pattern as the extractor — capture body
            // as text first so we can (1) treat transport-level
            // failures as transient, and (2) detect OpenRouter
            // error envelopes wrapped in HTTP 200. Both route to
            // `AppError::UpstreamUnavailable` (HTTP 503) so the
            // SDK / harness retry policy can recover. See
            // `extractor::parse_openrouter_error_envelope`.
            let body = resp.text().await.map_err(|e| {
                AppError::UpstreamUnavailable(format!(
                    "Failed to read embedding response body: {}",
                    e
                ))
            })?;

            if let Some(envelope) =
                crate::services::extractor::parse_openrouter_error_envelope(&body)
            {
                return Err(AppError::UpstreamUnavailable(format!(
                    "OpenRouter upstream error (code={}): {}",
                    envelope.code, envelope.message
                )));
            }

            let api_resp: EmbeddingApiResponse = serde_json::from_str(&body).map_err(|e| {
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

#[cfg(test)]
mod tests {
    /// parity test — the embedder routes OpenRouter-error-envelope
    /// bodies to `AppError::UpstreamUnavailable` via the SHARED helper
    /// `extractor::parse_openrouter_error_envelope`. If a future refactor
    /// breaks the cross-module import or call site, this catches it at
    /// compile time + test time without needing to mock reqwest.
    ///
    /// The full unit coverage of the envelope-parser shape (whitespace
    /// padding, valid-completion non-matches, both-fields edge case,
    /// malformed-JSON fallthrough) lives in `extractor::tests`. Don't
    /// duplicate it here — duplicating only adds maintenance cost; the
    /// helper is the same function.
    #[test]
    fn embedder_uses_shared_openrouter_envelope_parser() {
        // Real failing body shape captured from the LME v2 bench
        // investigation (200 OK wrapping a 504-gateway-timeout error).
        let body = r#"{"error":{"message":"The operation was aborted","code":504}}"#;
        let envelope = crate::services::extractor::parse_openrouter_error_envelope(body)
            .expect("embedder must be able to detect the same envelope shape as the extractor");
        assert_eq!(envelope.code, 504);
        assert_eq!(envelope.message, "The operation was aborted");
    }

    fn assert_bad_request(result: Result<(), crate::types::AppError>, needle: &str) {
        match result {
            Err(crate::types::AppError::BadRequest(msg)) => {
                assert!(
                    msg.contains(needle),
                    "expected error mentioning {needle:?}, got: {msg}"
                );
            }
            other => panic!("expected BadRequest containing {needle:?}, got: {other:?}"),
        }
    }

    #[test]
    fn embed_input_at_byte_limit_is_accepted() {
        super::reject_oversized_embed_input(&"q".repeat(super::MAX_EMBED_INPUT_BYTES)).unwrap();
    }

    #[test]
    fn embed_input_over_byte_limit_is_bad_request() {
        assert_bad_request(
            super::reject_oversized_embed_input(&"q".repeat(16400)),
            "input is over the embedding input limit",
        );
        assert_bad_request(
            super::reject_oversized_embed_input(&"q".repeat(16385)),
            "input is over the embedding input limit",
        );
    }

    // ── WALM-470: size limit placement and upstream 400 mapping ──────

    /// Stand-in embeddings provider answering every `POST /embeddings` with
    /// `status` and `body`. Returns its base URL and a call counter.
    async fn stub_provider(
        status: u16,
        body: &'static str,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&calls);
        let app = axum::Router::new().route(
            "/embeddings",
            axum::routing::post(move || {
                let counter = std::sync::Arc::clone(&counter);
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    (axum::http::StatusCode::from_u16(status).unwrap(), body)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), calls)
    }

    // The key-less branch hashes locally and has no context window, so the
    // model's byte limit must not apply to it.
    #[tokio::test]
    async fn without_a_key_input_over_the_model_limit_still_embeds() {
        let text = "a".repeat(100 * 1024);
        let vector = super::embed_text(
            &reqwest::Client::new(),
            None,
            "http://unused.invalid",
            &text,
        )
        .await
        .expect("key-less embedding has no input limit");
        assert_eq!(vector.len(), super::EMBEDDING_DIMS);
    }

    #[tokio::test]
    async fn with_a_key_oversized_input_is_rejected_before_calling_the_provider() {
        let (base, calls) = stub_provider(200, r#"{"data":[{"embedding":[0.0]}]}"#).await;
        let text = "q".repeat(super::MAX_EMBED_INPUT_BYTES + 1);
        let result = super::embed_text(&reqwest::Client::new(), Some("key"), &base, &text).await;
        assert!(
            matches!(result, Err(crate::types::AppError::BadRequest(_))),
            "got {result:?}"
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_provider_400_about_input_length_is_the_callers_bad_request() {
        for body in [
            r#"{"error":{"code":"context_length_exceeded","message":"..."}}"#,
            r#"{"error":{"message":"This model's maximum context length is 8192 tokens"}}"#,
            r#"{"error":{"message":"Please reduce the length of the messages."}}"#,
            r#"{"error":{"message":"Too many tokens in input"}}"#,
            r#"{"error":{"message":"String too long. Expected a string with maximum length 8192"}}"#,
        ] {
            let (base, _) = stub_provider(400, body).await;
            let result = super::embed_text(&reqwest::Client::new(), Some("key"), &base, "q").await;
            assert!(
                matches!(result, Err(crate::types::AppError::BadRequest(_))),
                "{body} → {result:?}"
            );
        }
    }

    // A 400 that isn't about the input is our misconfiguration: reporting it
    // as "input too long" blames the caller and skips 5xx alerting.
    #[tokio::test]
    async fn any_other_provider_400_is_an_internal_error() {
        for body in [
            r#"{"error":{"message":"The model `text-embedding-9` does not exist"}}"#,
            r#"{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}"#,
            r#"{"error":{"message":"Unrecognized request argument supplied: dimensions"}}"#,
            "",
        ] {
            let (base, _) = stub_provider(400, body).await;
            let result = super::embed_text(&reqwest::Client::new(), Some("key"), &base, "q").await;
            assert!(
                matches!(result, Err(crate::types::AppError::Internal(_))),
                "{body} → {result:?}"
            );
        }
    }
}
