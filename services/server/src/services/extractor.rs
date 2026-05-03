//! Extractor service — turns raw text into a list of memorable facts via an LLM.
//!
//! The default production impl (`LlmExtractor`) calls an OpenAI-compatible
//! `/chat/completions` endpoint with a fixed system prompt. The prompt
//! currently lives as an inline `const`; in Phase 3 it moves to a versioned
//! text asset under `services/prompts/extract.txt` so it can change without
//! a code edit and so its version can be recorded in benchmark run artifacts.

use async_trait::async_trait;
use std::sync::Arc;

use crate::types::{AppError, Config};

use super::llm_chat::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage,
};

#[async_trait]
pub trait Extractor: Send + Sync {
    /// Extract memorable facts from the input text. Returns one string per
    /// fact, in the order the LLM produced them. An empty Vec means the LLM
    /// found no memorable content (the explicit "NONE" response is normalised
    /// to an empty list).
    async fn extract(&self, text: &str) -> Result<Vec<String>, AppError>;
}

// ============================================================
// LLM-backed implementation (default for production)
// ============================================================

/// Fact-extraction system prompt. Sourced from a versioned text asset so
/// changes don't require a Rust edit and the version can be recorded in
/// benchmark run artifacts. The asset is bundled into the binary at
/// compile time via `include_str!`.
const FACT_EXTRACTION_PROMPT: &str = include_str!("prompts/extract.txt");

/// Version ID for the extraction prompt. Bump on every meaningful prompt
/// change. Recorded by the benchmark harness so run results are
/// attributable to a specific prompt version.
#[allow(dead_code)]
pub const FACT_EXTRACTION_PROMPT_VERSION: &str = "extract.v1";

pub struct LlmExtractor {
    http_client: reqwest::Client,
    config: Arc<Config>,
}

impl LlmExtractor {
    pub fn new(http_client: reqwest::Client, config: Arc<Config>) -> Self {
        Self { http_client, config }
    }
}

#[async_trait]
impl Extractor for LlmExtractor {
    #[tracing::instrument(name = "extractor.extract", skip_all, fields(text_len = text.len()))]
    async fn extract(&self, text: &str) -> Result<Vec<String>, AppError> {
        let api_key = self.config.openai_api_key.as_ref().ok_or_else(|| {
            AppError::Internal("OPENAI_API_KEY required for fact extraction".into())
        })?;

        let url = format!("{}/chat/completions", self.config.openai_api_base);

        let resp = self.http_client
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
            })
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("LLM API request failed: {}", e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "LLM API error ({}): {}", status, body
            )));
        }

        let api_resp: ChatCompletionResponse = resp.json().await.map_err(|e| {
            AppError::Internal(format!("Failed to parse LLM response: {}", e))
        })?;

        let content = api_resp
            .choices
            .first()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        // Parse response: one fact per line, skip "NONE"
        if content == "NONE" || content.is_empty() {
            return Ok(vec![]);
        }

        let facts: Vec<String> = content
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && l != "NONE")
            .collect();

        Ok(facts)
    }
}
