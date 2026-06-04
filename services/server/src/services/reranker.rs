//! Cross-encoder reranker service — re-scores (query, candidate) pairs
//! jointly for a sharper relevance signal than the bi-encoder cosine the
//! retriever produces.
//!
//! Unlike the pointwise [`crate::services::ranker::CompositeRanker`] (which
//! scores each hit from its own `distance`/`recency`/`importance` with no
//! cross-hit term), a cross-encoder reads the query and each candidate's
//! **text** together through transformer attention and emits one relevance
//! score per pair. It is therefore a *read-side* stage that must run
//! **after** the candidate text is available (post-Walrus-fetch +
//! post-SEAL-decrypt in production) — it cannot run on embeddings alone.
//!
//! The default production impl ([`OpenRouterReranker`]) calls OpenRouter's
//! Cohere-style `/rerank` endpoint (`{base}/rerank`) with the same
//! `openai_api_key` + `openai_api_base` the embedder already uses — no new
//! vendor relationship or key. When no API key is configured it falls back
//! to a deterministic mock (identity order) so keyless dev / unit tests run
//! without network.
//!
//! The recall path uses a retrieve-wide → rerank → narrow pattern: pull a
//! candidate pool larger than the caller's limit, re-score it with the
//! cross-encoder, then truncate — so a fact ranked just below the cut can be
//! promoted into the visible window.

use async_trait::async_trait;
use std::sync::Arc;

use crate::types::{AppError, Config};

/// Default cross-encoder model (OpenRouter slug). Cohere Rerank 4 Fast —
/// lowest-latency tier, 33K context, $0.002/search. Overridable via
/// `RERANK_MODEL`.
pub const DEFAULT_RERANK_MODEL: &str = "cohere/rerank-4-fast";

/// Default candidate-pool size: how many top hits we retrieve (and, in
/// production, decrypt) to feed the reranker before narrowing to the
/// caller's `limit`. Must exceed `limit` for reranking to have anything to
/// promote into the visible window. Overridable via `RERANK_POOL_N`.
pub const DEFAULT_RERANK_POOL_N: usize = 30;

/// Server-wide configuration for the cross-encoder reranker.
///
/// Reranking is a pipeline-shape decision (it changes which candidates
/// survive to the reader, and forces decrypting a wider pool in
/// production), not a per-request preference — so it's configured
/// server-side via env vars and is **off by default**: when
/// `enabled == false` the recall path skips it and ordering + the search
/// width are byte-identical to today. See [`RerankConfig::from_env`].
#[derive(Debug, Clone)]
pub struct RerankConfig {
    /// Master switch. `false` ⇒ reranker never invoked; recall unchanged.
    /// `RERANK_ENABLED=true`.
    pub enabled: bool,
    /// OpenRouter model slug. `RERANK_MODEL` (default Rerank 4 Fast).
    pub model: String,
    /// Candidate pool to retrieve + rerank, then narrow to `limit`.
    /// `RERANK_POOL_N` (default 30, capped at 100 by the recall handler).
    pub pool_n: usize,
}

impl Default for RerankConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            model: DEFAULT_RERANK_MODEL.to_string(),
            pool_n: DEFAULT_RERANK_POOL_N,
        }
    }
}

impl RerankConfig {
    /// Build from environment, falling back to [`Default`] for unset/malformed
    /// vars. Lenient but LOUD on degrade (a typo'd bench-run env that silently
    /// disables reranking is the fastest way to misread a null result):
    ///
    /// - `RERANK_ENABLED` — `true`/`1`/`yes`/`on` ⇒ on; other ⇒ off (+warn).
    /// - `RERANK_MODEL` — any non-empty string; blank ⇒ default.
    /// - `RERANK_POOL_N` — positive integer; invalid ⇒ default (+warn).
    pub fn from_env() -> Self {
        let cfg = Self::resolve(
            std::env::var("RERANK_ENABLED").ok(),
            std::env::var("RERANK_MODEL").ok(),
            std::env::var("RERANK_POOL_N").ok(),
        );
        if cfg.enabled {
            tracing::info!(
                model = %cfg.model,
                pool_n = cfg.pool_n,
                "cross-encoder reranker ENABLED on recall path"
            );
        } else {
            tracing::info!("cross-encoder reranker DISABLED (recall ordering unchanged)");
        }
        cfg
    }

    /// Pure resolution of the three env values, with loud `warn!`s on every
    /// degrade path. Separated from [`Self::from_env`] so it's testable
    /// without mutating process-global env.
    pub(crate) fn resolve(
        enabled_raw: Option<String>,
        model_raw: Option<String>,
        pool_n_raw: Option<String>,
    ) -> Self {
        let default = Self::default();

        let enabled = match enabled_raw {
            None => default.enabled,
            Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => true,
                "false" | "0" | "no" | "off" | "" => false,
                other => {
                    tracing::warn!(
                        value = %other,
                        "RERANK_ENABLED set to an unrecognized token — treating as OFF. \
                         Use true/1/yes/on or false/0/no/off."
                    );
                    false
                }
            },
        };

        let model = match model_raw {
            Some(m) if !m.trim().is_empty() => m.trim().to_string(),
            _ => default.model,
        };

        let pool_n = match pool_n_raw {
            None => default.pool_n,
            Some(raw) => match raw.trim().parse::<usize>() {
                Ok(n) if n > 0 => n,
                _ => {
                    tracing::warn!(
                        value = %raw,
                        default = default.pool_n,
                        "RERANK_POOL_N not a positive integer — using default."
                    );
                    default.pool_n
                }
            },
        };

        Self {
            enabled,
            model,
            pool_n,
        }
    }
}

/// One reranked candidate: the index into the *input* document list and the
/// cross-encoder's relevance score for it. Higher score = more relevant.
#[derive(Debug, Clone, Copy)]
pub struct RerankResult {
    /// Position of this candidate in the `documents` slice passed to `rerank`.
    pub index: usize,
    /// Cross-encoder relevance score (model-specific scale; only the
    /// *ordering* is contractual, not the absolute value).
    pub relevance_score: f64,
}

#[async_trait]
pub trait Reranker: Send + Sync {
    /// Score each `(query, document)` pair jointly and return the candidates
    /// as [`RerankResult`]s **sorted by relevance descending**. The returned
    /// `index` values point back into `documents`.
    ///
    /// Implementations must be lossless: every input index appears exactly
    /// once in the output (the caller relies on this to reorder its hit list
    /// without dropping or duplicating). A reranker that cannot score (no
    /// key, empty input) returns the identity order `0..documents.len()`.
    async fn rerank(
        &self,
        query: &str,
        documents: &[String],
    ) -> Result<Vec<RerankResult>, AppError>;
}

// ============================================================
// OpenRouter (Cohere-style /rerank) implementation + mock fallback
// ============================================================

pub struct OpenRouterReranker {
    http_client: reqwest::Client,
    config: Arc<Config>,
    model: String,
}

impl OpenRouterReranker {
    pub fn new(http_client: reqwest::Client, config: Arc<Config>, model: String) -> Self {
        Self {
            http_client,
            config,
            model,
        }
    }

    /// Identity order — `0..n` with neutral scores. Used as the mock
    /// (keyless) result and as the in-order fallback shape.
    fn identity(n: usize) -> Vec<RerankResult> {
        (0..n)
            .map(|index| RerankResult {
                index,
                relevance_score: 0.0,
            })
            .collect()
    }
}

#[async_trait]
impl Reranker for OpenRouterReranker {
    #[tracing::instrument(name = "reranker.rerank", skip_all, fields(model = %self.model, n = documents.len()))]
    async fn rerank(
        &self,
        query: &str,
        documents: &[String],
    ) -> Result<Vec<RerankResult>, AppError> {
        // Nothing (or one thing) to reorder.
        if documents.len() < 2 {
            return Ok(Self::identity(documents.len()));
        }

        let api_key = match &self.config.openai_api_key {
            Some(k) => k,
            None => {
                // Keyless dev / tests — identity order, no network.
                tracing::warn!("  → Using MOCK reranker (no OPENAI_API_KEY set) — identity order");
                return Ok(Self::identity(documents.len()));
            }
        };

        let url = format!("{}/rerank", self.config.openai_api_base);

        let started = std::time::Instant::now();
        let resp = self
            .http_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&RerankApiRequest {
                model: self.model.clone(),
                query: query.to_string(),
                documents: documents.to_vec(),
                // Ask for every candidate back so the caller can do its own
                // truncation after merging with any other signals.
                top_n: documents.len(),
            })
            .send()
            .await
            .map_err(|e| {
                crate::observability::observe_external(
                    "openrouter",
                    "rerank",
                    "transport_error",
                    started.elapsed(),
                );
                AppError::Internal(format!("Rerank API request failed: {}", e))
            })?;
        let status_label = resp.status().as_u16().to_string();
        crate::observability::observe_external(
            "openrouter",
            "rerank",
            &status_label,
            started.elapsed(),
        );

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            // Same transient-vs-permanent split as the embedder/extractor:
            // 429 + 5xx → 503 (retryable), other 4xx → 500.
            if crate::services::extractor::is_upstream_status_transient(status) {
                return Err(AppError::UpstreamUnavailable(format!(
                    "Rerank API upstream error ({}): {}",
                    status, body
                )));
            }
            return Err(AppError::Internal(format!(
                "Rerank API error ({}): {}",
                status, body
            )));
        }

        // Capture body as text first so we can detect OpenRouter error
        // envelopes wrapped in HTTP 200 (same pattern as the embedder).
        let body = resp.text().await.map_err(|e| {
            AppError::UpstreamUnavailable(format!("Failed to read rerank response body: {}", e))
        })?;

        if let Some(envelope) = crate::services::extractor::parse_openrouter_error_envelope(&body) {
            return Err(AppError::UpstreamUnavailable(format!(
                "OpenRouter upstream error (code={}): {}",
                envelope.code, envelope.message
            )));
        }

        let api_resp: RerankApiResponse = serde_json::from_str(&body)
            .map_err(|e| AppError::Internal(format!("Failed to parse rerank response: {}", e)))?;

        // Map the API results to our shape and ensure the output is a lossless
        // permutation of the input indices. The API returns results sorted by
        // relevance; we defensively (a) drop any out-of-range index, and
        // (b) append any input index the API omitted (in original order) so
        // the caller always gets every candidate back exactly once.
        let n = documents.len();
        let mut seen = vec![false; n];
        let mut out: Vec<RerankResult> = Vec::with_capacity(n);
        for r in api_resp.results {
            if r.index < n && !seen[r.index] {
                seen[r.index] = true;
                out.push(RerankResult {
                    index: r.index,
                    relevance_score: r.relevance_score,
                });
            }
        }
        for (i, s) in seen.iter().enumerate() {
            if !*s {
                out.push(RerankResult {
                    index: i,
                    relevance_score: f64::NEG_INFINITY,
                });
            }
        }
        Ok(out)
    }
}

/// Reorder `items` by a rerank `order` (a slice of [`RerankResult`] whose
/// `index` fields point into `items`), moving each item exactly once and
/// appending any item the order omitted in its original position. Lossless:
/// the output is always a permutation of the input (same length, no drops,
/// no duplicates) regardless of a malformed `order`.
///
/// The optional `on_move` callback fires for each item as it's placed, with
/// the item and its `relevance_score`, so the caller can stamp the score
/// onto the moved item (the recall handler uses this to surface the
/// cross-encoder score). Extracted as a pure fn so the reorder + the
/// graceful-degradation shape are unit-testable without an `AppState`.
pub fn apply_rerank_order<T>(
    items: Vec<T>,
    order: &[RerankResult],
    mut on_move: impl FnMut(&mut T, f64),
) -> Vec<T> {
    let mut slots: Vec<Option<T>> = items.into_iter().map(Some).collect();
    let mut out: Vec<T> = Vec::with_capacity(slots.len());
    for rr in order {
        if let Some(mut item) = slots.get_mut(rr.index).and_then(Option::take) {
            on_move(&mut item, rr.relevance_score);
            out.push(item);
        }
    }
    // Drain any remaining (un-moved) slots in original order. On the
    // graceful-degradation path (`order` empty), this is the whole list →
    // the input order is preserved exactly.
    for slot in slots.iter_mut() {
        if let Some(item) = slot.take() {
            out.push(item);
        }
    }
    out
}

// ============================================================
// OpenRouter Cohere-style /rerank API types (private)
// ============================================================

#[derive(serde::Serialize)]
struct RerankApiRequest {
    model: String,
    query: String,
    documents: Vec<String>,
    top_n: usize,
}

#[derive(serde::Deserialize)]
struct RerankApiResponse {
    results: Vec<RerankApiResult>,
}

#[derive(serde::Deserialize)]
struct RerankApiResult {
    index: usize,
    relevance_score: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(api_key: Option<&str>) -> Arc<Config> {
        // Build a minimal Config for the keyless-path test. Only
        // `openai_api_key` / `openai_api_base` matter to the reranker; the
        // rest are placeholder values (Config has no Default).
        Arc::new(Config {
            port: 8000,
            database_url: "postgres://test".to_string(),
            sui_rpc_url: "http://localhost:9000".to_string(),
            sui_network: "testnet".to_string(),
            memwal_account_id: None,
            openai_api_key: api_key.map(String::from),
            openai_api_base: "http://localhost:9999/v1".to_string(),
            walrus_publisher_url: "http://localhost:9001".to_string(),
            walrus_aggregator_url: "http://localhost:9002".to_string(),
            walrus_storage_epochs: 3,
            walrus_aggregator_urls: vec!["http://localhost:9002".to_string()],
            walrus_skip_consistency_check: false,
            walrus_aggregator_race_after_ms: crate::types::DEFAULT_WALRUS_AGGREGATOR_RACE_AFTER_MS,
            sui_private_key: None,
            sui_private_keys: vec![],
            package_id: "0xpackage".to_string(),
            registry_id: "0xregistry".to_string(),
            sidecar_url: "http://localhost:9003".to_string(),
            sidecar_secret: None,
            rate_limit: crate::rate_limit::RateLimitConfig::default(),
            sponsor_rate_limit: crate::types::SponsorRateLimitConfig::default(),
            allowed_origins: String::new(),
            benchmark_mode: false,
        })
    }

    fn docs(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("doc {i}")).collect()
    }

    #[tokio::test]
    async fn fewer_than_two_docs_is_identity() {
        let rr = OpenRouterReranker::new(
            reqwest::Client::new(),
            cfg(Some("sk-test")),
            DEFAULT_RERANK_MODEL.into(),
        );
        // 0 and 1 docs short-circuit before any network call.
        assert_eq!(rr.rerank("q", &docs(0)).await.unwrap().len(), 0);
        let one = rr.rerank("q", &docs(1)).await.unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].index, 0);
    }

    #[tokio::test]
    async fn keyless_falls_back_to_identity_order() {
        // No API key → mock path, identity order, no network, lossless.
        let rr = OpenRouterReranker::new(
            reqwest::Client::new(),
            cfg(None),
            DEFAULT_RERANK_MODEL.into(),
        );
        let out = rr.rerank("q", &docs(5)).await.unwrap();
        assert_eq!(out.len(), 5);
        assert_eq!(
            out.iter().map(|r| r.index).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn parse_response_maps_results_in_api_order() {
        // The API returns results sorted by relevance; our parse preserves
        // that order and the indices point back into the input.
        let body = r#"{"results":[
            {"index":2,"relevance_score":0.9},
            {"index":0,"relevance_score":0.4},
            {"index":1,"relevance_score":0.1}
        ]}"#;
        let parsed: RerankApiResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.results.len(), 3);
        assert_eq!(parsed.results[0].index, 2);
        assert!((parsed.results[0].relevance_score - 0.9).abs() < 1e-9);
    }

    #[test]
    fn parse_tolerates_openrouter_whitespace_padding() {
        // OpenRouter streams leading-whitespace keepalive padding before the
        // JSON body while the upstream rerank is in flight (observed live:
        // hundreds of bytes of spaces/newlines, then the object). serde_json
        // skips leading whitespace per the JSON spec, so our `from_str` parse
        // must tolerate it — otherwise every real call parse-errors and
        // silently falls back to composite order (the review's named risk).
        let padded = format!(
            "{}{}",
            " \n".repeat(300),
            r#"{"id":"x","model":"cohere/rerank-4-fast","results":[
                {"index":1,"relevance_score":0.8228},
                {"index":3,"relevance_score":0.8194}
            ],"usage":{"search_units":1,"cost":0.002}}"#
        );
        let parsed: RerankApiResponse =
            serde_json::from_str(&padded).expect("must parse padded OpenRouter body");
        assert_eq!(parsed.results.len(), 2);
        assert_eq!(parsed.results[0].index, 1);
        assert!((parsed.results[0].relevance_score - 0.8228).abs() < 1e-9);
    }

    #[test]
    fn losslessness_appends_omitted_indices() {
        // Simulate the merge logic directly: an API that returns only 2 of 4
        // indices must still yield all 4 (the 2 missing appended in order).
        let n = 4;
        let api_indices = [3usize, 1]; // API dropped 0 and 2
        let mut seen = vec![false; n];
        let mut out: Vec<usize> = Vec::new();
        for &idx in &api_indices {
            if idx < n && !seen[idx] {
                seen[idx] = true;
                out.push(idx);
            }
        }
        for (i, s) in seen.iter().enumerate() {
            if !*s {
                out.push(i);
            }
        }
        // 3,1 first (API order), then the omitted 0,2 in index order.
        assert_eq!(out, vec![3, 1, 0, 2]);
    }

    // ── apply_rerank_order (the recall reorder helper) ────────

    fn order(pairs: &[(usize, f64)]) -> Vec<RerankResult> {
        pairs
            .iter()
            .map(|&(index, relevance_score)| RerankResult {
                index,
                relevance_score,
            })
            .collect()
    }

    #[test]
    fn apply_order_reorders_and_stamps_scores() {
        // items tagged 'a'..'d'; rerank order promotes 'c' then 'a'.
        let items = vec!['a', 'b', 'c', 'd'];
        let ord = order(&[(2, 0.9), (0, 0.5), (3, 0.3), (1, 0.1)]);
        let mut stamped: Vec<(char, f64)> = Vec::new();
        let out = apply_rerank_order(items, &ord, |c, s| stamped.push((*c, s)));
        assert_eq!(out, vec!['c', 'a', 'd', 'b']);
        // on_move fired once per item, in output order, with its score.
        assert_eq!(
            stamped,
            vec![('c', 0.9), ('a', 0.5), ('d', 0.3), ('b', 0.1)]
        );
    }

    #[test]
    fn apply_order_empty_is_identity_graceful_degradation() {
        // The error-path shape: empty order → unchanged input order, no
        // scores stamped, lossless.
        let items = vec![10, 20, 30];
        let mut moved = 0;
        let out = apply_rerank_order(items, &[], |_, _| moved += 1);
        assert_eq!(out, vec![10, 20, 30]);
        assert_eq!(moved, 0);
    }

    #[test]
    fn apply_order_missing_indices_appended_in_order() {
        // order references only 2 of 4 → the other 2 appended in original
        // position. Lossless permutation.
        let items = vec!['a', 'b', 'c', 'd'];
        let ord = order(&[(3, 0.9), (1, 0.8)]);
        let out = apply_rerank_order(items, &ord, |_, _| {});
        assert_eq!(out, vec!['d', 'b', 'a', 'c']);
    }

    #[test]
    fn apply_order_out_of_range_and_dup_indices_are_lossless() {
        // A malformed order (index ≥ len, duplicate) must not panic or drop:
        // out length == in length, every original item present once.
        let items = vec!['a', 'b', 'c'];
        let ord = order(&[(9, 0.9), (1, 0.8), (1, 0.7)]); // 9 OOR, 1 dup
        let out = apply_rerank_order(items, &ord, |_, _| {});
        assert_eq!(out.len(), 3);
        let mut sorted = out.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec!['a', 'b', 'c']);
        // 'b' promoted (first valid), then 'a','c' appended in order.
        assert_eq!(out, vec!['b', 'a', 'c']);
    }

    // ── RerankConfig::resolve ─────────────────────────────────

    #[test]
    fn config_default_is_off() {
        let c = RerankConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.model, DEFAULT_RERANK_MODEL);
        assert_eq!(c.pool_n, DEFAULT_RERANK_POOL_N);
    }

    #[test]
    fn config_resolve_enabled_tokens() {
        for t in ["true", "1", "yes", "on", "TRUE", " On "] {
            assert!(
                RerankConfig::resolve(Some(t.into()), None, None).enabled,
                "{t}"
            );
        }
        for t in ["false", "0", "no", "off", ""] {
            assert!(
                !RerankConfig::resolve(Some(t.into()), None, None).enabled,
                "{t}"
            );
        }
        // typo footgun → off (not silently on)
        assert!(!RerankConfig::resolve(Some("tru".into()), None, None).enabled);
    }

    #[test]
    fn config_resolve_model_and_pool_n() {
        let c = RerankConfig::resolve(None, Some("cohere/rerank-4-pro".into()), Some("50".into()));
        assert_eq!(c.model, "cohere/rerank-4-pro");
        assert_eq!(c.pool_n, 50);
        // blank model → default; invalid pool_n → default
        let d = RerankConfig::resolve(None, Some("  ".into()), Some("0".into()));
        assert_eq!(d.model, DEFAULT_RERANK_MODEL);
        assert_eq!(d.pool_n, DEFAULT_RERANK_POOL_N);
        assert_eq!(
            RerankConfig::resolve(None, None, Some("x".into())).pool_n,
            DEFAULT_RERANK_POOL_N
        );
    }

    #[test]
    fn out_of_range_and_duplicate_indices_are_dropped() {
        // A malformed API result (index >= n, or a duplicate) must not panic
        // or double-count; the missing real indices get appended.
        let n = 3;
        let api = [(5usize, 0.9f64), (1, 0.8), (1, 0.7)]; // 5 OOR, 1 duplicated
        let mut seen = vec![false; n];
        let mut out: Vec<usize> = Vec::new();
        for &(idx, _) in &api {
            if idx < n && !seen[idx] {
                seen[idx] = true;
                out.push(idx);
            }
        }
        for (i, s) in seen.iter().enumerate() {
            if !*s {
                out.push(i);
            }
        }
        // only 1 survives from the API list; 0 and 2 appended.
        assert_eq!(out, vec![1, 0, 2]);
    }
}
