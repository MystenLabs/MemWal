use axum::{extract::State, Extension, Json};
use std::sync::Arc;

use crate::seal;
use crate::walrus;
use crate::types::*;

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
async fn generate_embedding(
    client: &reqwest::Client,
    config: &Config,
    text: &str,
) -> Result<Vec<f32>, AppError> {
    match &config.openai_api_key {
        Some(api_key) => {
            // Real embedding via OpenRouter/OpenAI-compatible API
            let url = format!("{}/embeddings", config.openai_api_base);
            tracing::debug!("  → Calling embedding API: {}", url);

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

            if api_resp.data.is_empty() {
                return Err(AppError::Internal("Embedding API returned no data".into()));
            }

            let vector = api_resp.data.into_iter().next().unwrap().embedding;
            tracing::info!("  → Real embedding: {} dimensions", vector.len());
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
// Routes
// ============================================================

/// POST /api/remember
///
/// Full TEE flow:
/// 1. Verify auth (middleware) → get owner from delegate key onchain lookup
/// 2. Embed text + Encrypt text concurrently (independent operations)
/// 3. Upload encrypted blob → Walrus → blobId
/// 4. Store {vector, blobId} in Vector DB
pub async fn remember(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RememberRequest>,
) -> Result<Json<RememberResponse>, AppError> {
    if body.text.is_empty() {
        return Err(AppError::BadRequest("Text cannot be empty".into()));
    }

    // Owner is derived from delegate key via onchain verification (auth middleware)
    let owner = &auth.owner;
    let text = &body.text;
    tracing::info!("remember: text=\"{}...\" owner={}", &text[..text.len().min(50)], owner);

    // Step 1: Embed text + SEAL encrypt concurrently (they're independent)
    let embed_fut = generate_embedding(&state.http_client, &state.config, text);
    let encrypt_fut = seal::seal_encrypt(
        &state.http_client, &state.config.sidecar_url,
        text.as_bytes(), owner, &state.config.package_id,
    );
    let (vector_result, encrypted_result) = tokio::join!(embed_fut, encrypt_fut);
    let vector = vector_result?;
    let encrypted = encrypted_result?;
    tracing::debug!("  → Embedding: {} dims, SEAL encrypted: {} bytes", vector.len(), encrypted.len());

    // Step 2: Upload encrypted blob → Walrus (via sidecar)
    let sui_key = state.config.sui_private_key.as_deref().ok_or_else(|| {
        AppError::Internal("SERVER_SUI_PRIVATE_KEY required for Walrus upload".into())
    })?;
    let upload_result = walrus::upload_blob(
        &state.http_client, &state.config.sidecar_url,
        &encrypted, 5, owner, sui_key,
    ).await?;
    let blob_id = upload_result.blob_id;
    tracing::debug!("  → Walrus upload: blobId={}, objectId={:?}", blob_id, upload_result.object_id);

    // Step 3: Store {vector, blobId} in Vector DB
    let id = uuid::Uuid::new_v4().to_string();
    state.db.insert_vector(&id, owner, &blob_id, &vector).await?;
    tracing::debug!("  → DB stored: id={}", id);

    tracing::info!(
        "remember complete: blob_id={}, owner={}, dims={}",
        blob_id, owner, vector.len()
    );

    Ok(Json(RememberResponse {
        id,
        blob_id,
        owner: owner.clone(),
    }))
}

/// POST /api/recall
///
/// Full TEE flow:
/// 1. Verify auth (middleware) → get owner from delegate key onchain lookup
/// 2. Embed query → vector
/// 3. Search Vector DB → top-K {blobId}
/// 4. Download + Decrypt all blobs concurrently (via sidecar HTTP)
/// 5. Return plaintext results
pub async fn recall(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RecallRequest>,
) -> Result<Json<RecallResponse>, AppError> {
    if body.query.is_empty() {
        return Err(AppError::BadRequest("Query cannot be empty".into()));
    }

    // Owner is derived from delegate key via onchain verification (auth middleware)
    let owner = &auth.owner;
    tracing::info!("recall: query=\"{}...\" owner={}", &body.query[..body.query.len().min(50)], owner);

    // Need admin private key for SEAL decryption
    let private_key = state.config.sui_private_key.as_deref().ok_or_else(|| {
        AppError::Internal("SERVER_SUI_PRIVATE_KEY required for SEAL decryption".into())
    })?;

    // Step 1: Embed query → vector
    let query_vector = generate_embedding(&state.http_client, &state.config, &body.query).await?;
    tracing::debug!("  → Query embedding: {} dimensions", query_vector.len());

    // Step 2: Search Vector DB
    let hits = state.db.search_similar(&query_vector, owner, body.limit).await?;
    tracing::debug!("  → Found {} matches", hits.len());

    // Step 3: Download + SEAL decrypt all results concurrently
    let tasks: Vec<_> = hits.iter().map(|hit| {
        let walrus_client = &state.walrus_client;
        let http_client = &state.http_client;
        let sidecar_url = state.config.sidecar_url.clone();
        let blob_id = hit.blob_id.clone();
        let distance = hit.distance;
        let private_key = private_key.to_string();
        let package_id = state.config.package_id.clone();
        let registry_id = state.config.registry_id.clone();
        async move {
            // Download encrypted blob from Walrus (native Rust)
            let encrypted_data = match walrus::download_blob(walrus_client, &blob_id).await {
                Ok(data) => data,
                Err(e) => {
                    tracing::warn!("Failed to download blob {}: {}", blob_id, e);
                    return None;
                }
            };
            // Decrypt using SEAL (via sidecar HTTP)
            match seal::seal_decrypt(http_client, &sidecar_url, &encrypted_data, &private_key, &package_id, &registry_id).await {
                Ok(plaintext) => {
                    match String::from_utf8(plaintext) {
                        Ok(text) => Some(RecallResult { blob_id, text, distance }),
                        Err(e) => {
                            tracing::warn!("Invalid UTF-8 in decrypted data: {}", e);
                            None
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to SEAL decrypt blob {}: {}", blob_id, e);
                    None
                }
            }
        }
    }).collect();

    let results: Vec<RecallResult> = futures::future::join_all(tasks)
        .await
        .into_iter()
        .flatten()
        .collect();

    let total = results.len();
    tracing::info!("recall complete: {} results for owner={}", total, owner);

    Ok(Json(RecallResponse { results, total }))
}



/// POST /api/remember/manual
///
/// Manual flow — user handles everything externally:
/// 1. SEAL encrypt (user's own wallet)
/// 2. Generate embedding vector (user's own model)
/// 3. Upload to Walrus (user's own relay)
/// Then sends {blob_id, vector} here for server to store.
pub async fn remember_manual(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RememberManualRequest>,
) -> Result<Json<RememberManualResponse>, AppError> {
    if body.blob_id.is_empty() {
        return Err(AppError::BadRequest("blob_id cannot be empty".into()));
    }
    if body.vector.is_empty() {
        return Err(AppError::BadRequest("vector cannot be empty".into()));
    }

    let owner = &auth.owner;
    tracing::info!(
        "remember_manual: blob_id={} vector_dims={} owner={}",
        body.blob_id, body.vector.len(), owner
    );

    // Store {vector, blobId} in Vector DB — that's it
    let id = uuid::Uuid::new_v4().to_string();
    state.db.insert_vector(&id, owner, &body.blob_id, &body.vector).await?;

    tracing::info!("remember_manual complete: id={}, blob_id={}", id, body.blob_id);

    Ok(Json(RememberManualResponse {
        id,
        blob_id: body.blob_id,
        owner: owner.clone(),
    }))
}

/// POST /api/recall/manual
///
/// Manual flow — user provides pre-computed query vector.
/// Server searches Vector DB and returns {blob_id, distance}[].
/// User downloads from Walrus + SEAL decrypts on their own.
pub async fn recall_manual(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RecallManualRequest>,
) -> Result<Json<RecallManualResponse>, AppError> {
    if body.vector.is_empty() {
        return Err(AppError::BadRequest("vector cannot be empty".into()));
    }

    let owner = &auth.owner;
    tracing::info!(
        "recall_manual: vector_dims={} limit={} owner={}",
        body.vector.len(), body.limit, owner
    );

    // Search Vector DB — return blob IDs + distances only
    let hits = state.db.search_similar(&body.vector, owner, body.limit).await?;
    let total = hits.len();

    tracing::info!("recall_manual complete: {} results for owner={}", total, owner);

    Ok(Json(RecallManualResponse {
        results: hits,
        total,
    }))
}

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
    tracing::info!("analyze: text=\"{}...\" owner={}", &body.text[..body.text.len().min(50)], owner);

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

    // Validate required key upfront before spawning tasks
    let sui_key = state.config.sui_private_key.as_deref().ok_or_else(|| {
        AppError::Internal("SERVER_SUI_PRIVATE_KEY required for Walrus upload".into())
    })?.to_string();

    // Step 2: Process all facts concurrently (embed + encrypt → upload → store)
    let tasks: Vec<_> = facts.iter().map(|fact_text| {
        let state = Arc::clone(&state);
        let owner = owner.clone();
        let fact_text = fact_text.clone();
        let sui_key = sui_key.clone();
        async move {
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
                &encrypted, 5, &owner, &sui_key,
            ).await?;

            // Store in Vector DB
            let id = uuid::Uuid::new_v4().to_string();
            state.db.insert_vector(&id, &owner, &upload_result.blob_id, &vector).await?;

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

/// Chat completion request for OpenRouter/OpenAI
#[derive(serde::Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
}

#[derive(serde::Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

/// Chat completion response
#[derive(serde::Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(serde::Deserialize)]
struct ChatChoice {
    message: ChatMessageResp,
}

#[derive(serde::Deserialize)]
struct ChatMessageResp {
    content: String,
}

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
    tracing::debug!("  → Calling LLM for fact extraction: {}", url);

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

/// GET /health
pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// POST /api/ask
///
/// Full AI-with-memory demo:
/// 1. Recall relevant memories for the question
/// 2. Inject memories into LLM system prompt
/// 3. Call LLM with user question + memory context
/// 4. Return answer + memories used
pub async fn ask(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<AskRequest>,
) -> Result<Json<AskResponse>, AppError> {
    if body.question.is_empty() {
        return Err(AppError::BadRequest("Question cannot be empty".into()));
    }

    let owner = &auth.owner;
    let limit = body.limit.unwrap_or(5);
    tracing::info!("ask: question=\"{}...\" owner={}", &body.question[..body.question.len().min(50)], owner);

    // Step 1: Recall relevant memories
    let query_vector = generate_embedding(&state.http_client, &state.config, &body.question).await?;
    let hits = state.db.search_similar(&query_vector, owner, limit).await?;

    // Need admin private key for SEAL decryption
    let private_key = state.config.sui_private_key.as_deref().ok_or_else(|| {
        AppError::Internal("SERVER_SUI_PRIVATE_KEY required for SEAL decryption".into())
    })?;

    // Download + SEAL decrypt all memories concurrently
    let tasks: Vec<_> = hits.iter().map(|hit| {
        let walrus_client = &state.walrus_client;
        let http_client = &state.http_client;
        let sidecar_url = state.config.sidecar_url.clone();
        let blob_id = hit.blob_id.clone();
        let distance = hit.distance;
        let private_key = private_key.to_string();
        let package_id = state.config.package_id.clone();
        let registry_id = state.config.registry_id.clone();
        async move {
            let encrypted_data = match walrus::download_blob(walrus_client, &blob_id).await {
                Ok(data) => data,
                Err(e) => {
                    tracing::warn!("Download failed for {}: {}", blob_id, e);
                    return None;
                }
            };
            match seal::seal_decrypt(http_client, &sidecar_url, &encrypted_data, &private_key, &package_id, &registry_id).await {
                Ok(plaintext) => {
                    match String::from_utf8(plaintext) {
                        Ok(text) => Some(RecallResult { blob_id, text, distance }),
                        Err(e) => {
                            tracing::warn!("Invalid UTF-8: {}", e);
                            None
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("SEAL decrypt failed for {}: {}", blob_id, e);
                    None
                }
            }
        }
    }).collect();

    let memories: Vec<RecallResult> = futures::future::join_all(tasks)
        .await
        .into_iter()
        .flatten()
        .collect();

    let memories_used = memories.len();
    tracing::info!("ask: {} memories found for context", memories_used);

    // Step 2: Build prompt with memory context
    let memory_context = if memories.is_empty() {
        "No memories found for this user yet.".to_string()
    } else {
        let lines: Vec<String> = memories.iter()
            .map(|m| format!("- {} (relevance: {:.2})", m.text, 1.0 - m.distance))
            .collect();
        format!("Known facts about this user:\n{}", lines.join("\n"))
    };

    let system_prompt = format!(
        "You are a helpful AI assistant with access to the user's personal memories stored in memwal. \
        Use the following context to provide personalized answers. If the memories don't contain relevant \
        information, say so honestly.\n\n{}", memory_context
    );

    // Step 3: Call LLM
    let api_key = state.config.openai_api_key.as_ref().ok_or_else(|| {
        AppError::Internal("OPENAI_API_KEY required for /api/ask".into())
    })?;
    let url = format!("{}/chat/completions", state.config.openai_api_base);

    let resp = state.http_client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&ChatCompletionRequest {
            model: "openai/gpt-4o-mini".to_string(),
            messages: vec![
                ChatMessage { role: "system".to_string(), content: system_prompt },
                ChatMessage { role: "user".to_string(), content: body.question.clone() },
            ],
            temperature: 0.7,
        })
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("LLM request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("LLM error ({}): {}", status, body_text)));
    }

    let api_resp: ChatCompletionResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse LLM response: {}", e))
    })?;

    let answer = api_resp.choices.first()
        .map(|c| c.message.content.trim().to_string())
        .unwrap_or_else(|| "No response from LLM".to_string());

    tracing::info!("ask complete: answer length={} chars", answer.len());

    Ok(Json(AskResponse { answer, memories_used, memories }))
}
