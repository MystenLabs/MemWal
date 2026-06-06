//! HyDE (Hypothetical Document Embeddings) query-enhancement service.
//!
//! Bi-encoder recall embeds the query and each stored fact independently and
//! compares by cosine. An *interrogative, speculative* query ("what might
//! John's degree be in?") and a *declarative* stored fact ("John has a degree
//! in political science") can land far apart in embedding space even when
//! they're about the same thing — so the retriever misses a fact that IS
//! stored. HyDE (Gao et al. 2022, arXiv:2212.10496) fixes this: instruct an
//! LLM to write a *hypothetical answer* to the query, then embed and search
//! with THAT instead of the query. The hypothetical answer lives in "fact
//! space", so it embeds close to the real stored fact.
//!
//! This is a *pre-embed* transform — it only changes which text the recall
//! handler embeds for the query; everything downstream (search, hydrate,
//! rank) is byte-identical. Default-off, env-gated.
//!
//! **Graceful degradation is a hard requirement.** HyDE is an enhancement,
//! never a dependency: on any generation failure (LLM error, empty output,
//! keyless) it returns the ORIGINAL query unchanged, so recall always
//! proceeds with at least the baseline behaviour.
//!
//! A pre-bench precondition probe on our own data showed HyDE rescues facts
//! the raw query missed on the single-fact categories (single_hop 13%→21%
//! recovery, 9:1 rescue:loss; open_domain + temporal also helped) while
//! leaving the reasoning-bound multi_hop category neutral (no regression).

use async_trait::async_trait;
use std::sync::Arc;

use crate::services::llm_chat::{ChatCompletionRequest, ChatCompletionResponse, ChatMessage};
use crate::types::{AppError, Config};

/// Default model for hypothetical-answer generation (OpenRouter slug). Same
/// cheap model the extractor + answer path use. Overridable via `HYDE_MODEL`.
pub const DEFAULT_HYDE_MODEL: &str = "openai/gpt-4o-mini";

/// Token cap for the hypothetical answer — it's a single short factual
/// sentence, not a full answer, so a small budget is enough and keeps the
/// added read-path latency/cost minimal.
const HYDE_MAX_OUTPUT_TOKENS: u32 = 80;

/// Per-request timeout for the HyDE generation call. HyDE sits *serially* in
/// front of the recall embed, so a hung OpenRouter would otherwise stall the
/// whole recall up to the shared client's 30s timeout. This caps that tail:
/// on timeout we fall back to the original query (graceful degradation), so a
/// slow upstream costs ~4s, not 30s. Measured cache-miss latency is ~1.5s, so
/// 4s leaves comfortable headroom for a slow-but-healthy generation.
const HYDE_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// The instruction that turns a query into a fact-shaped hypothetical answer.
/// Temp 0 (set on the request) keeps it deterministic so the recall
/// embedding cache — keyed on the original query — stays valid.
fn hyde_prompt(query: &str) -> String {
    format!(
        "Write a single short factual sentence that would be a plausible direct \
         ANSWER to the question below, stated declaratively as if it were a fact \
         on record. Do not hedge, do not ask a question, do not explain. Return \
         ONLY the sentence.\n\nQuestion: {query}"
    )
}

#[async_trait]
pub trait HydeGenerator: Send + Sync {
    /// Generate a hypothetical answer for `query` to embed in its place.
    /// MUST be infallible from the caller's perspective: any internal failure
    /// returns the original `query` unchanged (graceful degradation), so the
    /// returned `String` is always a usable search text.
    async fn hypothesize(&self, query: &str) -> String;
}

// ============================================================
// OpenRouter implementation (with graceful fallback to the query)
// ============================================================

pub struct OpenRouterHyde {
    http_client: reqwest::Client,
    config: Arc<Config>,
    model: String,
}

impl OpenRouterHyde {
    pub fn new(http_client: reqwest::Client, config: Arc<Config>, model: String) -> Self {
        Self {
            http_client,
            config,
            model,
        }
    }

    /// Inner fallible generation. The public `hypothesize` wraps this and maps
    /// any `Err`/empty to the original query, so recall never fails on HyDE.
    async fn try_generate(&self, query: &str) -> Result<String, AppError> {
        let api_key = self
            .config
            .openai_api_key
            .as_ref()
            .ok_or_else(|| AppError::Internal("no API key for HyDE".into()))?;

        let url = format!("{}/chat/completions", self.config.openai_api_base);
        let started = std::time::Instant::now();
        let resp = self
            .http_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&ChatCompletionRequest {
                model: self.model.clone(),
                messages: vec![ChatMessage {
                    role: "user".to_string(),
                    content: hyde_prompt(query),
                }],
                temperature: 0.0,
                max_tokens: HYDE_MAX_OUTPUT_TOKENS,
            })
            .timeout(HYDE_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                crate::observability::observe_external(
                    "openrouter",
                    "hyde",
                    "transport_error",
                    started.elapsed(),
                );
                AppError::Internal(format!("HyDE request failed: {}", e))
            })?;
        crate::observability::observe_external(
            "openrouter",
            "hyde",
            &resp.status().as_u16().to_string(),
            started.elapsed(),
        );

        if !resp.status().is_success() {
            let status = resp.status();
            return Err(AppError::Internal(format!("HyDE API error ({})", status)));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| AppError::Internal(format!("HyDE read body failed: {}", e)))?;
        // OpenRouter sometimes wraps an upstream 5xx in a 200 envelope; treat
        // it as a failure (→ fallback) rather than parsing garbage.
        if crate::services::extractor::parse_openrouter_error_envelope(&body).is_some() {
            return Err(AppError::Internal("HyDE upstream error envelope".into()));
        }
        let api_resp: ChatCompletionResponse = serde_json::from_str(&body)
            .map_err(|e| AppError::Internal(format!("HyDE parse failed: {}", e)))?;

        let text = api_resp
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .unwrap_or_default();
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(AppError::Internal("HyDE returned empty".into()));
        }
        Ok(text)
    }
}

#[async_trait]
impl HydeGenerator for OpenRouterHyde {
    #[tracing::instrument(name = "hyde.hypothesize", skip_all, fields(model = %self.model, query_len = query.len()))]
    async fn hypothesize(&self, query: &str) -> String {
        match self.try_generate(query).await {
            Ok(hypothetical) => hypothetical,
            Err(e) => {
                // Graceful degradation: HyDE is an enhancement, never a hard
                // dependency. Embed the original query instead — recall still
                // proceeds with baseline behaviour. Logged so a high fallback
                // rate is observable via the warn-rate.
                tracing::warn!(error = %e, "HyDE generation failed — falling back to the original query");
                query.to_string()
            }
        }
    }
}

// ============================================================
// Config
// ============================================================

/// Server-wide HyDE configuration. Env-driven, **off by default** — when
/// `enabled == false` the recall handler embeds the raw query exactly as
/// today (byte-identical). See [`HydeConfig::from_env`].
#[derive(Debug, Clone)]
pub struct HydeConfig {
    /// Master switch. `false` ⇒ HyDE never invoked; recall unchanged.
    /// `HYDE_ENABLED=true`.
    pub enabled: bool,
    /// OpenRouter model slug for hypothetical-answer generation.
    /// `HYDE_MODEL` (default gpt-4o-mini).
    pub model: String,
}

impl Default for HydeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            model: DEFAULT_HYDE_MODEL.to_string(),
        }
    }
}

impl HydeConfig {
    /// Build from environment, falling back to [`Default`] for unset/malformed
    /// vars, LOUD on degrade (a typo'd bench-run env that silently disables
    /// HyDE is the fastest way to misread a null result).
    pub fn from_env() -> Self {
        let cfg = Self::resolve(
            std::env::var("HYDE_ENABLED").ok(),
            std::env::var("HYDE_MODEL").ok(),
        );
        if cfg.enabled {
            tracing::info!(model = %cfg.model, "HyDE query enhancement ENABLED on recall path");
        } else {
            tracing::info!("HyDE query enhancement DISABLED (recall query embedded as-is)");
        }
        cfg
    }

    /// Pure resolution of the env values, with a warn on an unrecognized
    /// `HYDE_ENABLED` token. Separated so it's testable without mutating
    /// process-global env.
    pub(crate) fn resolve(enabled_raw: Option<String>, model_raw: Option<String>) -> Self {
        let default = Self::default();
        let enabled = match enabled_raw {
            None => default.enabled,
            Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => true,
                "false" | "0" | "no" | "off" | "" => false,
                other => {
                    tracing::warn!(
                        value = %other,
                        "HYDE_ENABLED set to an unrecognized token — treating as OFF. \
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
        Self { enabled, model }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(api_key: Option<&str>) -> Arc<Config> {
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

    #[tokio::test]
    async fn keyless_falls_back_to_original_query() {
        // No API key → try_generate errors → hypothesize returns the query
        // unchanged. Graceful degradation: recall never breaks on HyDE.
        let h = OpenRouterHyde::new(reqwest::Client::new(), cfg(None), DEFAULT_HYDE_MODEL.into());
        assert_eq!(
            h.hypothesize("what pets does Sarah have?").await,
            "what pets does Sarah have?"
        );
    }

    #[tokio::test]
    async fn unreachable_endpoint_falls_back_to_original_query() {
        // A configured-but-unreachable endpoint → transport error → fallback
        // to the original query (never a panic, never an error to the caller).
        let h = OpenRouterHyde::new(
            reqwest::Client::new(),
            cfg(Some("sk-test")),
            DEFAULT_HYDE_MODEL.into(),
        );
        let q = "is Sarah's dog older than her cat?";
        assert_eq!(h.hypothesize(q).await, q);
    }

    #[test]
    fn prompt_contains_query_and_asks_for_a_declarative_sentence() {
        let p = hyde_prompt("what console does Nate own?");
        assert!(p.contains("what console does Nate own?"));
        assert!(p.to_lowercase().contains("answer"));
        assert!(p.to_lowercase().contains("only"));
    }

    #[test]
    fn config_default_is_off() {
        let c = HydeConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.model, DEFAULT_HYDE_MODEL);
    }

    #[test]
    fn config_resolve_tokens_and_model() {
        for t in ["true", "1", "yes", "on", " On "] {
            assert!(HydeConfig::resolve(Some(t.into()), None).enabled, "{t}");
        }
        for t in ["false", "0", "no", "off", ""] {
            assert!(!HydeConfig::resolve(Some(t.into()), None).enabled, "{t}");
        }
        // typo → off (not silently on)
        assert!(!HydeConfig::resolve(Some("tru".into()), None).enabled);
        // model override + blank → default
        assert_eq!(
            HydeConfig::resolve(None, Some("openai/gpt-4o".into())).model,
            "openai/gpt-4o"
        );
        assert_eq!(
            HydeConfig::resolve(None, Some("  ".into())).model,
            DEFAULT_HYDE_MODEL
        );
    }
}
