//! POST /api/analyze handler — LLM-driven fact extraction + ingestion.
//!
//! Also owns the `extract_facts_llm` helper and its `FACT_EXTRACTION_PROMPT`.
//! In Phase 2 these will move into `pipeline/ingest/extractor.rs`, with the
//! prompt becoming a versioned text asset under `pipeline/ingest/prompts/`.

use axum::{extract::State, Extension, Json};
use std::sync::Arc;

use crate::rate_limit;
use crate::storage::{seal, walrus};
use crate::types::*;

use super::{
    generate_embedding, truncate_str,
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage,
};

/// POST /api/analyze
///
/// AI fact extraction flow:
/// 1. Verify auth (middleware) → get owner
/// 2. Call LLM to extract memorable facts from text
/// 3. For each fact concurrently: embed + encrypt → Walrus upload → store
pub async fn analyze(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<AnalyzeRequest>,
) -> Result<Json<AnalyzeResponse>, AppError> {
    if body.text.is_empty() {
        return Err(AppError::BadRequest("Text cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!("analyze: text=\"{}...\" owner={} ns={}", truncate_str(&body.text, 50), owner, namespace);

    // Step 1: Extract facts using LLM
    let facts = extract_facts_llm(&state.http_client, &state.config, &body.text).await?;
    tracing::info!("  → Extracted {} facts", facts.len());

    if facts.is_empty() {
        return Ok(Json(AnalyzeResponse {
            facts: vec![],
            total: 0,
            owner: owner.clone(),
        }));
    }

    // Check storage quota before processing all facts
    let total_text_bytes: i64 = facts.iter().map(|f| f.as_bytes().len() as i64).sum();
    rate_limit::check_storage_quota(&state, owner, total_text_bytes).await?;

    // Step 2: Process all facts concurrently (embed + encrypt → upload → store)
    // Each fact gets its own key from the pool so sidecar can upload them in parallel
    // (different signer addresses bypass the per-signer serialization lock).
    let auth_pubkey_base = auth.public_key.clone();
    let tasks: Vec<_> = facts.iter().map(|fact_text| {
        let state = Arc::clone(&state);
        let owner = owner.clone();
        let fact_text = fact_text.clone();
        let auth_pubkey = auth_pubkey_base.clone();
        // Pick the next key in round-robin order at task construction time.
        // Convert to owned String *before* async move so we don't borrow-then-move `state`.
        let sui_key: Result<String, AppError> = state.key_pool.next()
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::Internal("No Sui keys configured (set SERVER_SUI_PRIVATE_KEYS or SERVER_SUI_PRIVATE_KEY)".into()));
        let namespace = namespace.clone();
        async move {
            let sui_key = sui_key?;
            // Embed + SEAL encrypt concurrently (independent operations)
            let embed_fut = generate_embedding(&state.http_client, &state.config, &fact_text);
            let encrypt_fut = seal::seal_encrypt(
                &state.http_client, &state.config.sidecar_url,
                fact_text.as_bytes(), &owner, &state.config.package_id,
            );
            let (vector_result, encrypted_result) = tokio::join!(embed_fut, encrypt_fut);
            let vector = vector_result?;
            let encrypted = encrypted_result?;

            // Upload to Walrus (via sidecar HTTP)
            let upload_result = walrus::upload_blob(
                &state.http_client, &state.config.sidecar_url,
                &encrypted, 50, &owner, &sui_key, &namespace, &state.config.package_id,
                Some(&auth_pubkey),
            ).await?;

            // Store in Vector DB with namespace
            let blob_size = encrypted.len() as i64;
            let id = uuid::Uuid::new_v4().to_string();
            state.db.insert_vector(&id, &owner, &namespace, &upload_result.blob_id, &vector, blob_size).await?;

            Ok::<AnalyzedFact, AppError>(AnalyzedFact {
                text: fact_text,
                id,
                blob_id: upload_result.blob_id,
            })
        }
    }).collect();

    let results = futures::future::join_all(tasks).await;

    // Collect successes, fail on first error (same semantics as sequential version)
    let mut stored_facts = Vec::with_capacity(results.len());
    for result in results {
        stored_facts.push(result?);
    }

    let total = stored_facts.len();
    tracing::info!("analyze complete: {} facts stored for owner={}", total, owner);

    Ok(Json(AnalyzeResponse {
        facts: stored_facts,
        total,
        owner: owner.clone(),
    }))
}

// ============================================================
// LLM Fact Extraction
// ============================================================

const FACT_EXTRACTION_PROMPT: &str = r#"You are a fact extraction system. Given a text or conversation, extract distinct factual statements about the user that are worth remembering for future interactions.

Rules:
- Extract personal preferences, habits, constraints, biographical info, and important facts
- Each fact should be a single, self-contained statement
- Skip greetings, small talk, and questions
- If the text contains no memorable facts, respond with NONE
- Return one fact per line, no numbering or bullets
- Be concise but specific

Examples:
Input: "I'm allergic to peanuts and I live in Hanoi. What's the weather like?"
Output:
User is allergic to peanuts
User lives in Hanoi

Input: "Hey, how are you?"
Output:
NONE"#;

/// Extract memorable facts from text using LLM
async fn extract_facts_llm(
    client: &reqwest::Client,
    config: &Config,
    text: &str,
) -> Result<Vec<String>, AppError> {
    let api_key = config.openai_api_key.as_ref().ok_or_else(|| {
        AppError::Internal("OPENAI_API_KEY required for fact extraction".into())
    })?;

    let url = format!("{}/chat/completions", config.openai_api_base);

    let resp = client
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
