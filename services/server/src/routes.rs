use axum::{extract::State, Extension, Json};
use axum::body::Body;
use axum::response::Response;
use base64::Engine as _;
use std::sync::Arc;

use crate::seal;
use crate::walrus;
use crate::rate_limit;
use crate::types::*;
use crate::db::VectorDb;

/// Truncate a string to at most `max_bytes` bytes without splitting a UTF-8
/// character.  Falls back to the nearest char boundary when `max_bytes` lands
/// inside a multi-byte sequence (e.g. emoji).
fn truncate_str(s: &str, max_bytes: usize) -> &str {
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
async fn generate_embedding(
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
    let namespace = &body.namespace;
    tracing::info!("remember: text=\"{}...\" owner={} ns={}", truncate_str(text, 50), owner, namespace);

    // Check storage quota before processing
    let text_bytes = text.as_bytes().len() as i64;
    rate_limit::check_storage_quota(&state, owner, text_bytes).await?;

    // Step 1: Embed text + SEAL encrypt concurrently (they're independent)
    let embed_fut = generate_embedding(&state.http_client, &state.config, text);
    let encrypt_fut = seal::seal_encrypt(
        &state.http_client, &state.config.sidecar_url,
        text.as_bytes(), owner, &state.config.package_id,
    );
    let (vector_result, encrypted_result) = tokio::join!(embed_fut, encrypt_fut);
    let vector = vector_result?;
    let encrypted = encrypted_result?;

    // Step 2: Upload encrypted blob → Walrus (via sidecar)
    let sui_key = state.key_pool.next()
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Internal("No Sui keys configured (set SERVER_SUI_PRIVATE_KEYS or SERVER_SUI_PRIVATE_KEY)".into()))?;
    let upload_result = walrus::upload_blob(
        &state.http_client, &state.config.sidecar_url,
        &encrypted, 50, owner, &sui_key, namespace, &state.config.package_id,
    ).await?;
    let blob_id = upload_result.blob_id;

    // Step 3: Store {vector, blobId, namespace} in Vector DB
    let blob_size = encrypted.len() as i64;
    let id = uuid::Uuid::new_v4().to_string();
    state.db.insert_vector(&id, owner, namespace, &blob_id, &vector, blob_size).await?;

    tracing::info!(
        "remember complete: blob_id={}, owner={}, ns={}, dims={}",
        blob_id, owner, namespace, vector.len()
    );

    Ok(Json(RememberResponse {
        id,
        blob_id,
        owner: owner.clone(),
        namespace: namespace.clone(),
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
    let namespace = &body.namespace;
    tracing::info!("recall: query=\"{}...\" owner={} ns={}", truncate_str(&body.query, 50), owner, namespace);

    // Use delegate key from SDK for SEAL decryption (falls back to server key)
    let private_key = auth.delegate_key.as_deref()
        .or(state.config.sui_private_key.as_deref())
        .ok_or_else(|| {
            AppError::Internal("Delegate key or SERVER_SUI_PRIVATE_KEY required for SEAL decryption".into())
        })?;

    // Step 1: Embed query → vector
    let query_vector = generate_embedding(&state.http_client, &state.config, &body.query).await?;

    // Step 2: Search Vector DB
    let hits = state.db.search_similar(&query_vector, owner, namespace, body.limit).await?;

    // Step 3: Download + SEAL decrypt all results concurrently
    let db = &state.db;
    let tasks: Vec<_> = hits.iter().map(|hit| {
        let walrus_client = &state.walrus_client;
        let http_client = &state.http_client;
        let sidecar_url = state.config.sidecar_url.clone();
        let blob_id = hit.blob_id.clone();
        let distance = hit.distance;
        let private_key = private_key.to_string();
        let package_id = state.config.package_id.clone();
        let account_id = auth.account_id.clone();
        async move {
            // Download encrypted blob from Walrus (native Rust)
            let encrypted_data = match walrus::download_blob(walrus_client, &blob_id).await {
                Ok(data) => data,
                Err(AppError::BlobNotFound(msg)) => {
                    // Blob expired on Walrus — clean up from DB reactively
                    tracing::warn!("Blob expired, cleaning up: {}", msg);
                    cleanup_expired_blob(db, &blob_id).await;
                    return None;
                }
                Err(e) => {
                    tracing::warn!("Failed to download blob {}: {}", blob_id, e);
                    return None;
                }
            };
            // Decrypt using SEAL (via sidecar HTTP)
            match seal::seal_decrypt(http_client, &sidecar_url, &encrypted_data, &private_key, &package_id, &account_id).await {
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
                    let err_str = e.to_string();
                    let is_permanent = err_str.contains("Not enough shares")
                        || err_str.contains("decrypt failed");
                    if is_permanent {
                        tracing::warn!("SEAL decrypt permanently failed for blob {}, cleaning up: {}", blob_id, e);
                        cleanup_expired_blob(db, &blob_id).await;
                    } else {
                        tracing::warn!("Failed to SEAL decrypt blob {}: {}", blob_id, e);
                    }
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
/// Hybrid manual flow:
/// - Client has already done: embed (OpenRouter) + SEAL encrypt locally
/// - Client sends {encrypted_data (base64), vector}
/// - Server uploads encrypted bytes to Walrus via upload-relay sidecar → gets blob_id
/// - Server stores {blob_id, vector} in Vector DB
pub async fn remember_manual(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RememberManualRequest>,
) -> Result<Json<RememberManualResponse>, AppError> {
    if body.encrypted_data.is_empty() {
        return Err(AppError::BadRequest("encrypted_data cannot be empty".into()));
    }
    if body.vector.is_empty() {
        return Err(AppError::BadRequest("vector cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!(
        "remember_manual: vector_dims={} owner={} ns={}",
        body.vector.len(), owner, namespace
    );

    // Decode base64 → raw SEAL-encrypted bytes
    let encrypted_bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.encrypted_data)
        .map_err(|e| AppError::BadRequest(format!("encrypted_data is not valid base64: {}", e)))?;

    // Check storage quota before upload
    rate_limit::check_storage_quota(&state, owner, encrypted_bytes.len() as i64).await?;

    // Upload encrypted bytes to Walrus via sidecar (pool key pays gas)
    let sui_key = state.key_pool.next()
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Internal("No Sui keys configured (set SERVER_SUI_PRIVATE_KEYS or SERVER_SUI_PRIVATE_KEY)".into()))?;

    let upload = walrus::upload_blob(
        &state.http_client,
        &state.config.sidecar_url,
        &encrypted_bytes,
        50,
        owner,
        &sui_key,
        namespace,
        &state.config.package_id,
    )
    .await?;

    let blob_id = upload.blob_id;
    tracing::info!("remember_manual: walrus upload ok blob_id={}", blob_id);

    // Store {vector, blobId, namespace} in Vector DB
    let blob_size = encrypted_bytes.len() as i64;
    let id = uuid::Uuid::new_v4().to_string();
    state.db.insert_vector(&id, owner, namespace, &blob_id, &body.vector, blob_size).await?;

    tracing::info!("remember_manual complete: id={}, blob_id={}, ns={}", id, blob_id, namespace);

    Ok(Json(RememberManualResponse {
        id,
        blob_id,
        owner: owner.clone(),
        namespace: namespace.clone(),
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
    let namespace = &body.namespace;
    tracing::info!(
        "recall_manual: vector_dims={} limit={} owner={} ns={}",
        body.vector.len(), body.limit, owner, namespace
    );

    // Search Vector DB — return blob IDs + distances only
    let hits = state.db.search_similar(&body.vector, owner, namespace, body.limit).await?;
    let total = hits.len();

    tracing::info!("recall_manual complete: {} results for owner={} ns={}", total, owner, namespace);

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
    let tasks: Vec<_> = facts.iter().map(|fact_text| {
        let state = Arc::clone(&state);
        let owner = owner.clone();
        let fact_text = fact_text.clone();
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
    let namespace = &body.namespace;
    let limit = body.limit.unwrap_or(5);
    tracing::info!("ask: question=\"{}...\" owner={} ns={}", truncate_str(&body.question, 50), owner, namespace);

    // Step 1: Recall relevant memories
    let query_vector = generate_embedding(&state.http_client, &state.config, &body.question).await?;
    let hits = state.db.search_similar(&query_vector, owner, namespace, limit).await?;

    // Use delegate key from SDK for SEAL decryption (falls back to server key)
    let private_key = auth.delegate_key.as_deref()
        .or(state.config.sui_private_key.as_deref())
        .ok_or_else(|| {
            AppError::Internal("Delegate key or SERVER_SUI_PRIVATE_KEY required for SEAL decryption".into())
        })?;

    // Download + SEAL decrypt all memories concurrently
    let db = &state.db;
    let tasks: Vec<_> = hits.iter().map(|hit| {
        let walrus_client = &state.walrus_client;
        let http_client = &state.http_client;
        let sidecar_url = state.config.sidecar_url.clone();
        let blob_id = hit.blob_id.clone();
        let distance = hit.distance;
        let private_key = private_key.to_string();
        let package_id = state.config.package_id.clone();
        let account_id = auth.account_id.clone();
        async move {
            let encrypted_data = match walrus::download_blob(walrus_client, &blob_id).await {
                Ok(data) => data,
                Err(AppError::BlobNotFound(msg)) => {
                    // Blob expired on Walrus — clean up from DB reactively
                    tracing::warn!("Blob expired, cleaning up: {}", msg);
                    cleanup_expired_blob(db, &blob_id).await;
                    return None;
                }
                Err(e) => {
                    tracing::warn!("Download failed for {}: {}", blob_id, e);
                    return None;
                }
            };
            match seal::seal_decrypt(http_client, &sidecar_url, &encrypted_data, &private_key, &package_id, &account_id).await {
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

// ============================================================
// Expired Blob Cleanup
// ============================================================

/// Reactively delete an expired blob from the vector DB.
/// Called when Walrus returns 404 (blob expired / not found).
/// Errors are logged but not propagated — cleanup is best-effort.
async fn cleanup_expired_blob(db: &VectorDb, blob_id: &str) {
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

// ============================================================
// Restore Flow
// ============================================================

/// POST /api/restore
///
/// Restore a namespace from Walrus:
/// 1. Get all blob_ids for owner+namespace from DB
/// 2. Download each blob from Walrus
/// 3. SEAL decrypt with delegate key
/// 4. Re-embed decrypted text
/// 5. Clear old vector entries and re-index
pub async fn restore(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RestoreRequest>,
) -> Result<Json<RestoreResponse>, AppError> {
    if body.namespace.is_empty() {
        return Err(AppError::BadRequest("namespace cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    let limit = body.limit;
    tracing::info!("restore: owner={} ns={} limit={}", owner, namespace, limit);

    // Use delegate key for SEAL decryption
    let private_key = auth.delegate_key.as_deref()
        .or(state.config.sui_private_key.as_deref())
        .ok_or_else(|| {
            AppError::Internal("Delegate key or SERVER_SUI_PRIVATE_KEY required for restore".into())
        })?
        .to_string();

    // Step 1: Discover all blob_ids from on-chain (source of truth)
    tracing::info!("restore: querying chain for blobs owner={} ns={}", owner, namespace);
    let on_chain_blobs = walrus::query_blobs_by_owner(
        &state.http_client,
        &state.config.sidecar_url,
        owner,
        Some(namespace),
        Some(&state.config.package_id),
    ).await?;
    let all_blob_ids: Vec<String> = on_chain_blobs.iter().map(|b| b.blob_id.clone()).collect();
    let total = all_blob_ids.len();

    // Build blob_id → package_id lookup from on-chain metadata
    // Each blob may have been encrypted with a different package_id (e.g. after contract upgrades)
    let blob_package_ids: std::collections::HashMap<String, String> = on_chain_blobs.iter()
        .filter(|b| !b.package_id.is_empty())
        .map(|b| (b.blob_id.clone(), b.package_id.clone()))
        .collect();

    if total == 0 {
        return Ok(Json(RestoreResponse {
            restored: 0,
            skipped: 0,
            total: 0,
            namespace: namespace.clone(),
            owner: owner.clone(),
        }));
    }

    // Step 2: Check which blobs already exist in local DB → only restore missing ones
    let existing_blob_ids = state.db.get_blobs_by_namespace(owner, namespace).await?;
    let existing_set: std::collections::HashSet<&str> = existing_blob_ids.iter().map(|s| s.as_str()).collect();
    let all_missing: Vec<String> = all_blob_ids.iter()
        .filter(|id| !existing_set.contains(id.as_str()))
        .cloned()
        .collect();
    // Apply limit — take the most recent N missing blobs (last N from chain query)
    let missing_blob_ids: Vec<String> = if all_missing.len() > limit {
        all_missing[all_missing.len() - limit..].to_vec()
    } else {
        all_missing
    };
    let skipped = total - missing_blob_ids.len();
    tracing::info!(
        "restore: total={} on-chain, existing={}, missing={} (limited to {}) for ns={}",
        total, existing_blob_ids.len(), missing_blob_ids.len(), limit, namespace
    );

    if missing_blob_ids.is_empty() {
        return Ok(Json(RestoreResponse {
            restored: 0,
            skipped,
            total,
            namespace: namespace.clone(),
            owner: owner.clone(),
        }));
    }

    // Step 3: Download all missing blobs from Walrus concurrently
    let db = &state.db;
    let download_tasks: Vec<_> = missing_blob_ids.iter().map(|blob_id| {
        let walrus_client = &state.walrus_client;
        let blob_id = blob_id.clone();
        async move {
            match walrus::download_blob(walrus_client, &blob_id).await {
                Ok(data) => Some((blob_id, data)),
                Err(AppError::BlobNotFound(msg)) => {
                    tracing::warn!("restore: blob expired, skipping: {}", msg);
                    cleanup_expired_blob(db, &blob_id).await;
                    None
                }
                Err(e) => {
                    tracing::warn!("restore: download failed for {}: {}", blob_id, e);
                    None
                }
            }
        }
    }).collect();

    let downloaded: Vec<(String, Vec<u8>)> = futures::future::join_all(download_tasks)
        .await
        .into_iter()
        .flatten()
        .collect();

    // Preserve encrypted blob sizes so restored rows still contribute to storage quota.
    let blob_sizes: std::collections::HashMap<String, i64> = downloaded
        .iter()
        .map(|(blob_id, data)| (blob_id.clone(), data.len() as i64))
        .collect();

    if downloaded.is_empty() {
        return Ok(Json(RestoreResponse {
            restored: 0,
            skipped,
            total,
            namespace: namespace.clone(),
            owner: owner.clone(),
        }));
    }

    tracing::info!("restore: downloaded {}/{} blobs, decrypting (3 concurrent)...", downloaded.len(), missing_blob_ids.len());

    // Step 4: SEAL decrypt with bounded concurrency (3 at a time)
    // Use per-blob package_id from on-chain metadata, fall back to current server config
    use futures::stream::{self, StreamExt};
    let decrypt_results: Vec<Option<(String, String)>> = stream::iter(downloaded.into_iter())
        .map(|(blob_id, encrypted_data)| {
            let http_client = &state.http_client;
            let sidecar_url = state.config.sidecar_url.clone();
            let private_key = private_key.clone();
            // Use the package_id that was stored with this blob (supports contract upgrades)
            let package_id = blob_package_ids.get(&blob_id)
                .cloned()
                .unwrap_or_else(|| state.config.package_id.clone());
            let account_id = auth.account_id.clone();
            async move {
                match seal::seal_decrypt(
                    http_client, &sidecar_url, &encrypted_data,
                    &private_key, &package_id, &account_id,
                ).await {
                    Ok(plaintext) => {
                        match String::from_utf8(plaintext) {
                            Ok(text) => Some((blob_id, text)),
                            Err(e) => {
                                tracing::warn!("restore: invalid UTF-8 for {}: {}", blob_id, e);
                                None
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("restore: decrypt failed for {}: {}", blob_id, e);
                        None
                    }
                }
            }
        })
        .buffer_unordered(3)
        .collect()
        .await;

    let decrypted_texts: Vec<(String, String)> = decrypt_results.into_iter().flatten().collect();
    tracing::info!("restore: decrypted {}/{} blobs", decrypted_texts.len(), missing_blob_ids.len());

    // Step 5: Re-embed all decrypted texts concurrently
    let embed_tasks: Vec<_> = decrypted_texts.iter().map(|(blob_id, text)| {
        let http_client = &state.http_client;
        let config = state.config.clone();
        let blob_id = blob_id.clone();
        let text = text.clone();
        async move {
            match generate_embedding(http_client, &config, &text).await {
                Ok(vector) => Some((blob_id, vector)),
                Err(e) => {
                    tracing::warn!("restore: embedding failed for {}: {}", blob_id, e);
                    None
                }
            }
        }
    }).collect();

    let results: Vec<(String, Vec<f32>)> = futures::future::join_all(embed_tasks)
        .await
        .into_iter()
        .flatten()
        .collect();

    // Step 6: Insert only new entries (no delete!)
    let restored = results.len();
    for (blob_id, vector) in &results {
        let id = uuid::Uuid::new_v4().to_string();
        let blob_size = blob_sizes.get(blob_id).copied().unwrap_or_else(|| {
            tracing::warn!(
                "restore: missing blob size for {}, defaulting to 0 for quota tracking",
                blob_id
            );
            0
        });
        state.db
            .insert_vector(&id, owner, namespace, blob_id, vector, blob_size)
            .await?;
    }

    tracing::info!(
        "restore complete: restored={} skipped={} total={} owner={} ns={}",
        restored, skipped, total, owner, namespace
    );

    Ok(Json(RestoreResponse {
        restored,
        skipped,
        total,
        namespace: namespace.clone(),
        owner: owner.clone(),
    }))
}

// ============================================================
// Enoki Sponsor Proxy — forwards FE requests to internal sidecar
// ============================================================

/// POST /sponsor — proxy to sidecar POST /sponsor
pub async fn sponsor_proxy(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Response<Body>, AppError> {
    let url = format!("{}/sponsor", state.config.sidecar_url);
    let resp = state.http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor proxy failed: {}", e)))?;

    let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    let resp_body = resp.bytes().await
        .map_err(|e| AppError::Internal(format!("Sponsor proxy read failed: {}", e)))?;

    Ok(Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(resp_body))
        .unwrap())
}

/// POST /sponsor/execute — proxy to sidecar POST /sponsor/execute
pub async fn sponsor_execute_proxy(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Response<Body>, AppError> {
    let url = format!("{}/sponsor/execute", state.config.sidecar_url);
    let resp = state.http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor execute proxy failed: {}", e)))?;

    let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    let resp_body = resp.bytes().await
        .map_err(|e| AppError::Internal(format!("Sponsor execute proxy read failed: {}", e)))?;

    Ok(Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(resp_body))
        .unwrap())
}
