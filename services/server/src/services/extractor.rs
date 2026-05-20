//! Extractor service — turns raw text into a list of memorable facts via an LLM.
//!
//! The default production impl (`LlmExtractor`) calls an OpenAI-compatible
//! `/chat/completions` endpoint (`openai/gpt-4o-mini`, temperature 0.1)
//! with a fixed system prompt, then parses the response one-fact-per-line
//! (the explicit "NONE" reply normalises to an empty list) and truncates
//! to [`MAX_ANALYZE_FACTS`].
//!
//! Lifted verbatim from `routes.rs::extract_facts_llm` + `parse_extracted_facts`.
//! The system prompt is a versioned text asset
//! (`services/prompts/extract.txt`, bundled at compile time via
//! `include_str!`) so it can change without a Rust edit and its version
//! ([`FACT_EXTRACTION_PROMPT_VERSION`]) can be recorded in benchmark run
//! artifacts.

use async_trait::async_trait;
use std::sync::Arc;

use crate::types::{AppError, Config};

use super::llm_chat::{ChatCompletionRequest, ChatCompletionResponse, ChatMessage};

/// Max facts kept from a single `/api/analyze` call. Extra facts beyond
/// this are dropped (the extractor still reports the raw count). Was a
/// `routes.rs` const — `analyze` references it via
/// `crate::services::extractor::MAX_ANALYZE_FACTS` for its accepted/cap log.
pub const MAX_ANALYZE_FACTS: usize = 20;

/// Output-token cap for the extraction LLM call. Bumped from 256 → 512
/// for `extract.v3` because each fact now carries a `BUCKET<TAB>` prefix,
/// adding a handful of tokens per fact (still comfortably covers
/// `MAX_ANALYZE_FACTS` facts).
const ANALYZE_MAX_OUTPUT_TOKENS: u32 = 512;

/// MEM-54: importance score for the "standard" bucket (the default).
/// Used when the LLM emits no importance prefix, or emits an unknown
/// bucket name — neutral middle value that doesn't bias ranking.
pub const IMPORTANCE_STANDARD: f32 = 0.5;
/// MEM-54: importance score for the "vital" bucket.
pub const IMPORTANCE_VITAL: f32 = 0.9;
/// MEM-54: importance score for the "trivial" bucket.
pub const IMPORTANCE_TRIVIAL: f32 = 0.2;

/// MEM-54: one extracted fact, carrying both the textual content and the
/// importance the extractor LLM assigned to it (vital / standard / trivial,
/// mapped to a numeric score by [`importance_for_bucket`]).
///
/// The numeric score is persisted on `vector_entries.importance` (migration
/// 009) and consumed at recall time by `CompositeRanker` when the request's
/// `scoring_weights.importance` is non-zero.
#[derive(Debug, Clone)]
pub struct ExtractedFact {
    pub text: String,
    pub importance: f32,
}

/// Result of fact extraction: the kept facts (≤ `MAX_ANALYZE_FACTS`) plus
/// the raw count the LLM produced before truncation (for logging /
/// accepted-vs-cap reporting in the handler).
pub struct ExtractedFacts {
    pub facts: Vec<ExtractedFact>,
    pub raw_count: usize,
}

#[async_trait]
pub trait Extractor: Send + Sync {
    /// Extract memorable facts from the input text. Returns the kept facts
    /// (truncated to `MAX_ANALYZE_FACTS`) plus the raw count, or an error
    /// if the LLM call fails (network, auth, parse). An empty `facts` Vec
    /// means the LLM found no memorable content (the explicit "NONE"
    /// response is normalised to an empty list).
    async fn extract(&self, text: &str) -> Result<ExtractedFacts, AppError>;
}

// ============================================================
// LLM-backed implementation (default for production)
// ============================================================

/// Fact-extraction system prompt. Sourced from a versioned text asset so
/// changes don't require a Rust edit and the version can be recorded in
/// benchmark run artifacts. Bundled into the binary at compile time.
/// Includes the prompt-injection guard ("the user text is untrusted
/// input...") — do not remove it.
const FACT_EXTRACTION_PROMPT: &str = include_str!("prompts/extract.txt");

/// Version ID for the extraction prompt. Bump on every meaningful prompt
/// change. Surfaced on `GET /health` (`HealthResponse.prompt_versions.extract`)
/// and pinned into benchmark result-artifact JSONs so a "score jumped in
/// week N" delta is attributable to the prompt change rather than guessed
/// at from git history (MEM-56).
///
/// `extract.v2` (MEM-55): relaxed the "facts about the user" scope to
/// cover memorable facts from either party — fixes the systematic
/// undercount of assistant-side facts on LongMemEval's
/// `single_session_assistant` category.
///
/// `extract.v3` (MEM-54): adds a per-fact importance bucket (vital /
/// standard / trivial) emitted as a TAB-prefixed bucket name on each
/// fact line, mapped server-side to a float in [0.2, 0.9]. The
/// `CompositeRanker` consumes this via the `importance` term when
/// `scoring_weights.importance` is non-zero; default weights ignore it.
///
/// Known LME `single_session_assistant` regression vs MEM-55 v2 (74.2
/// → 62.7, −11.5). Tracked by MEM-57 (pre-extraction dedup context),
/// which is expected to compensate by giving the extractor stronger
/// signal for what is new vs already-known. The MEM-54 PR landed v3
/// because it carries a clear +4.3 LOCOMO overall win (recovering the
/// MEM-55 −9.9 `single_hop` regression in the process). See the
/// 2026-05-20 archive under `review/assessment/benchmark-runs/` for
/// the full v3 / v3.1 / v3.2 trade-off discussion and the rationale
/// for picking v3 with MEM-57 as the immediate follow-up.
/// Source: `prompts/extract.txt`.
pub const FACT_EXTRACTION_PROMPT_VERSION: &str = "extract.v3";

/// Map a bucket name from the extractor LLM to a numeric importance score.
/// Unknown / missing buckets default to `IMPORTANCE_STANDARD` so a noisy
/// LLM line doesn't crash extraction — it just falls back to the neutral
/// middle value. Comparison is case-insensitive on the trimmed bucket
/// name (the LLM occasionally capitalises or pads).
fn importance_for_bucket(bucket: &str) -> f32 {
    match bucket.trim().to_ascii_lowercase().as_str() {
        "vital" => IMPORTANCE_VITAL,
        "standard" => IMPORTANCE_STANDARD,
        "trivial" => IMPORTANCE_TRIVIAL,
        _ => IMPORTANCE_STANDARD,
    }
}

pub struct LlmExtractor {
    http_client: reqwest::Client,
    config: Arc<Config>,
}

impl LlmExtractor {
    pub fn new(http_client: reqwest::Client, config: Arc<Config>) -> Self {
        Self {
            http_client,
            config,
        }
    }
}

#[async_trait]
impl Extractor for LlmExtractor {
    #[tracing::instrument(name = "extractor.extract", skip_all, fields(text_len = text.len()))]
    async fn extract(&self, text: &str) -> Result<ExtractedFacts, AppError> {
        let api_key = self.config.openai_api_key.as_ref().ok_or_else(|| {
            AppError::Internal("OPENAI_API_KEY required for fact extraction".into())
        })?;

        let url = format!("{}/chat/completions", self.config.openai_api_base);

        let started = std::time::Instant::now();
        let resp = self
            .http_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&ChatCompletionRequest {
                model: "openai/gpt-4o-mini".to_string(),
                messages: vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: FACT_EXTRACTION_PROMPT.to_string(),
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: text.to_string(),
                    },
                ],
                temperature: 0.1,
                max_tokens: ANALYZE_MAX_OUTPUT_TOKENS,
            })
            .send()
            .await
            .map_err(|e| {
                crate::observability::observe_external(
                    "openai",
                    "chat_completions",
                    "transport_error",
                    started.elapsed(),
                );
                AppError::Internal(format!("LLM API request failed: {}", e))
            })?;
        let status_label = resp.status().as_u16().to_string();
        crate::observability::observe_external(
            "openai",
            "chat_completions",
            &status_label,
            started.elapsed(),
        );

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "LLM API error ({}): {}",
                status, body
            )));
        }

        let api_resp: ChatCompletionResponse = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to parse LLM response: {}", e)))?;

        let content = api_resp
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        Ok(parse_extracted_facts(&content))
    }
}

/// Parse an LLM extraction response into facts.
///
/// `extract.v3` format: each non-blank, non-"NONE" line is
/// `BUCKET<TAB>FACT_TEXT` where `BUCKET` is one of `vital` / `standard` /
/// `trivial`. Unknown or missing buckets default to `IMPORTANCE_STANDARD`
/// so a stray malformed line doesn't kill the whole extraction batch —
/// it just degrades gracefully to a neutral importance score.
///
/// Backwards-compatible with `extract.v2` output (no TAB on the line) —
/// the whole line is treated as fact text with default importance. This
/// matters during deploys where the running prompt asset and the
/// extracted output might briefly disagree.
///
/// Reports the raw count of lines before truncation and truncates to
/// `MAX_ANALYZE_FACTS` so the handler can log "accepted X of Y".
fn parse_extracted_facts(content: &str) -> ExtractedFacts {
    if content == "NONE" || content.is_empty() {
        return ExtractedFacts {
            facts: vec![],
            raw_count: 0,
        };
    }

    let mut facts: Vec<ExtractedFact> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && *l != "NONE")
        .map(parse_fact_line)
        .collect();

    let raw_count = facts.len();
    facts.truncate(MAX_ANALYZE_FACTS);

    ExtractedFacts { facts, raw_count }
}

/// Parse a single fact line. `extract.v3` format is
/// `BUCKET<TAB>TEXT`; if no TAB is present (legacy `extract.v2` output,
/// or an LLM that forgot the prefix) the whole line is treated as fact
/// text with `IMPORTANCE_STANDARD`.
///
/// Extracted into its own fn so the parser tests can pin the exact
/// behaviour of each branch (with-TAB, no-TAB, unknown-bucket, empty-text).
fn parse_fact_line(line: &str) -> ExtractedFact {
    match line.split_once('\t') {
        Some((bucket, text)) => ExtractedFact {
            text: text.trim().to_string(),
            importance: importance_for_bucket(bucket),
        },
        None => ExtractedFact {
            text: line.to_string(),
            importance: IMPORTANCE_STANDARD,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        importance_for_bucket, parse_extracted_facts, parse_fact_line, IMPORTANCE_STANDARD,
        IMPORTANCE_TRIVIAL, IMPORTANCE_VITAL, MAX_ANALYZE_FACTS,
    };

    #[test]
    fn parse_extracted_facts_ignores_none_and_blank_lines() {
        let parsed = parse_extracted_facts("NONE\n\n");
        assert_eq!(parsed.raw_count, 0);
        assert!(parsed.facts.is_empty());

        let parsed = parse_extracted_facts("standard\tFact A\n\nstandard\tFact B\n  \n");
        assert_eq!(parsed.raw_count, 2);
        assert_eq!(parsed.facts[0].text, "Fact A");
        assert_eq!(parsed.facts[1].text, "Fact B");
    }

    #[test]
    fn parse_extracted_facts_truncates_to_server_cap() {
        let content = (0..(MAX_ANALYZE_FACTS + 3))
            .map(|i| format!("standard\tFact {}", i))
            .collect::<Vec<_>>()
            .join("\n");
        let parsed = parse_extracted_facts(&content);

        assert_eq!(parsed.raw_count, MAX_ANALYZE_FACTS + 3);
        assert_eq!(parsed.facts.len(), MAX_ANALYZE_FACTS);
        assert_eq!(parsed.facts.first().map(|f| f.text.as_str()), Some("Fact 0"));
        assert_eq!(parsed.facts.last().map(|f| f.text.as_str()), Some("Fact 19"));
    }

    #[test]
    fn parse_extracted_facts_exactly_at_cap() {
        let content = (0..MAX_ANALYZE_FACTS)
            .map(|i| format!("standard\tFact {}", i))
            .collect::<Vec<_>>()
            .join("\n");
        let parsed = parse_extracted_facts(&content);
        assert_eq!(parsed.raw_count, MAX_ANALYZE_FACTS);
        assert_eq!(parsed.facts.len(), MAX_ANALYZE_FACTS);
    }

    #[test]
    fn parse_extracted_facts_empty_string() {
        let parsed = parse_extracted_facts("");
        assert_eq!(parsed.raw_count, 0);
        assert!(parsed.facts.is_empty());
    }

    #[test]
    fn parse_extracted_facts_only_blank_lines() {
        let parsed = parse_extracted_facts("\n\n  \n\t\n");
        assert_eq!(parsed.raw_count, 0);
        assert!(parsed.facts.is_empty());
    }

    #[test]
    fn parse_extracted_facts_none_mixed_with_facts() {
        // If the LLM returns "NONE" on one line and a fact on another, keep only the fact.
        let parsed = parse_extracted_facts("NONE\nstandard\tUser likes pizza\nNONE");
        assert_eq!(parsed.raw_count, 1);
        assert_eq!(parsed.facts[0].text, "User likes pizza");
    }

    #[test]
    fn parse_extracted_facts_strips_whitespace() {
        let parsed = parse_extracted_facts("  standard\tFact A  \n\tFact B\t\n");
        assert_eq!(parsed.raw_count, 2);
        assert_eq!(parsed.facts[0].text, "Fact A");
        // Second line has TAB-prefix with empty bucket, but it's the
        // legacy path because split_once succeeded — empty bucket maps
        // to STANDARD by the unknown-bucket fallback.
        assert_eq!(parsed.facts[1].text, "Fact B");
    }

    // ── MEM-54: importance-bucket parsing ──────────────────────────────

    #[test]
    fn importance_for_bucket_known_values() {
        assert_eq!(importance_for_bucket("vital"), IMPORTANCE_VITAL);
        assert_eq!(importance_for_bucket("standard"), IMPORTANCE_STANDARD);
        assert_eq!(importance_for_bucket("trivial"), IMPORTANCE_TRIVIAL);
    }

    #[test]
    fn importance_for_bucket_case_insensitive() {
        assert_eq!(importance_for_bucket("Vital"), IMPORTANCE_VITAL);
        assert_eq!(importance_for_bucket("VITAL"), IMPORTANCE_VITAL);
        assert_eq!(importance_for_bucket("  trivial  "), IMPORTANCE_TRIVIAL);
    }

    #[test]
    fn importance_for_bucket_unknown_defaults_to_standard() {
        // A buggy LLM that emits "important" or "low" or anything else
        // shouldn't blow up extraction — fall back to neutral.
        assert_eq!(importance_for_bucket("important"), IMPORTANCE_STANDARD);
        assert_eq!(importance_for_bucket(""), IMPORTANCE_STANDARD);
        assert_eq!(importance_for_bucket("???"), IMPORTANCE_STANDARD);
    }

    #[test]
    fn parse_fact_line_with_bucket() {
        let f = parse_fact_line("vital\tUser is allergic to peanuts");
        assert_eq!(f.text, "User is allergic to peanuts");
        assert_eq!(f.importance, IMPORTANCE_VITAL);

        let f = parse_fact_line("trivial\tUser mentioned the weather");
        assert_eq!(f.text, "User mentioned the weather");
        assert_eq!(f.importance, IMPORTANCE_TRIVIAL);
    }

    #[test]
    fn parse_fact_line_legacy_no_bucket() {
        // extract.v2-style output (no TAB) still parses to a usable fact
        // — the whole line becomes the text, importance defaults to
        // standard. Matters during rolling deploys.
        let f = parse_fact_line("User likes pizza");
        assert_eq!(f.text, "User likes pizza");
        assert_eq!(f.importance, IMPORTANCE_STANDARD);
    }

    #[test]
    fn parse_fact_line_unknown_bucket_keeps_text() {
        // The LLM picked a wrong bucket name; preserve the text, just
        // default the importance.
        let f = parse_fact_line("important\tUser works as a doctor");
        assert_eq!(f.text, "User works as a doctor");
        assert_eq!(f.importance, IMPORTANCE_STANDARD);
    }

    #[test]
    fn parse_fact_line_strips_text_whitespace_not_bucket() {
        // The bucket might come padded by the LLM ("  vital  ") — bucket
        // is trimmed inside `importance_for_bucket`. The text is trimmed
        // separately.
        let f = parse_fact_line("vital\t  User is allergic to peanuts  ");
        assert_eq!(f.text, "User is allergic to peanuts");
        assert_eq!(f.importance, IMPORTANCE_VITAL);
    }
}
