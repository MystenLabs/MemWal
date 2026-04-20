use axum::{extract::State, Extension, Json};
use axum::body::Body;
use axum::response::Response;
use base64::Engine as _;
use std::sync::Arc;

use crate::seal;
use crate::walrus;
use crate::rate_limit;
use crate::types::*;
use crate::db::{VectorDb, InsertMemoryMeta};

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

    // ── FAST-PATH DEDUP: check content hash BEFORE quota/embed/encrypt/upload ──
    // This avoids wasting compute + Walrus upload on exact duplicates,
    // and also avoids blocking duplicates with quota errors.
    let content_hash = {
        use sha2::Digest;
        let hash = sha2::Sha256::digest(text.as_bytes());
        hex::encode(hash)
    };

    if let Some((existing_id, existing_blob_id)) = state.db.find_by_content_hash_full(owner, namespace, &content_hash).await? {
        tracing::info!("remember: exact duplicate found (id={}), bumping access count", existing_id.id);
        state.db.touch_memory(&existing_id.id).await?;
        return Ok(Json(RememberResponse {
            id: existing_id.id,
            blob_id: existing_blob_id,
            owner: owner.clone(),
            namespace: namespace.clone(),
            memory_type: existing_id.memory_type,
            importance: existing_id.importance,
        }));
    }

    // Check storage quota AFTER dedup — duplicates don't incur new storage
    let text_bytes = text.as_bytes().len() as i64;
    rate_limit::check_storage_quota(&state, owner, text_bytes).await?;

    let memory_type_str = body.memory_type.as_ref().map(|t| t.to_string()).unwrap_or_else(|| "fact".to_string());
    let importance = body.importance.unwrap_or(0.5).clamp(0.0, 1.0);

    // Build metadata JSON from tags + user metadata
    let metadata = {
        let mut meta = body.metadata.unwrap_or_else(|| serde_json::json!({}));
        if let Some(tags) = &body.tags {
            if let Some(obj) = meta.as_object_mut() {
                obj.insert("tags".to_string(), serde_json::json!(tags));
            }
        }
        meta
    };

    let insert_meta = InsertMemoryMeta {
        memory_type: memory_type_str.clone(),
        importance,
        source: "user".to_string(),
        metadata,
        content_hash: Some(content_hash.clone()),
    };

    let (is_new, actual_id, actual_blob_id) = if state.config.benchmark_mode {
        // Benchmark mode: embed only, skip SEAL + Walrus, store plaintext.
        let vector = generate_embedding(&state.http_client, &state.config, text).await?;
        store_memory_plaintext(&state, owner, namespace, text, &vector, insert_meta).await?
    } else {
        // Production: Embed text + SEAL encrypt concurrently (independent), then upload.
        let embed_fut = generate_embedding(&state.http_client, &state.config, text);
        let encrypt_fut = seal::seal_encrypt(
            &state.http_client, &state.config.sidecar_url,
            text.as_bytes(), owner, &state.config.package_id,
        );
        let (vector_result, encrypted_result) = tokio::join!(embed_fut, encrypt_fut);
        let vector = vector_result?;
        let encrypted = encrypted_result?;
        let blob_size = encrypted.len() as i64;

        store_memory_with_transaction(
            &state,
            owner,
            namespace,
            &vector,
            &encrypted,
            blob_size,
            content_hash.clone(),
            insert_meta,
        ).await?
    };

    let mut response_memory_type = memory_type_str.clone();
    let mut response_importance = importance;
    if !is_new {
        tracing::warn!("remember: concurrent duplicate insert prevented, returning existing memory");
        if let Some((existing, _)) = state.db.find_by_content_hash_full(owner, namespace, &content_hash).await? {
            response_memory_type = existing.memory_type;
            response_importance = existing.importance;
        }
    }

    tracing::info!(
        "remember complete: is_new={}, id={}, blob_id={}, owner={}, ns={}, type={}, importance={:.2}",
        is_new, actual_id, actual_blob_id, owner, namespace, response_memory_type, response_importance
    );

    Ok(Json(RememberResponse {
        id: actual_id,
        blob_id: actual_blob_id,
        owner: owner.clone(),
        namespace: namespace.clone(),
        memory_type: response_memory_type,
        importance: response_importance,
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

    let owner = &auth.owner;
    let namespace = &body.namespace;
    let include_expired = body.include_expired.unwrap_or(false);
    tracing::info!("recall: query=\"{}...\" owner={} ns={}", truncate_str(&body.query, 50), owner, namespace);

    // Use delegate key from SDK for SEAL decryption (falls back to server key)
    let private_key = auth.delegate_key.as_deref()
        .or(state.config.sui_private_key.as_deref())
        .ok_or_else(|| {
            AppError::Internal("Delegate key or SERVER_SUI_PRIVATE_KEY required for SEAL decryption".into())
        })?;

    // Step 1: Embed query → vector
    let query_vector = generate_embedding(&state.http_client, &state.config, &body.query).await?;

    // Step 2: Search Vector DB with filtering
    let memory_types_ref = body.memory_types.as_deref();
    let search_limit = body.limit.saturating_mul(5).max(body.limit);
    let hits = state.db.search_similar_filtered(
        &query_vector, owner, namespace, search_limit,
        !include_expired,
        memory_types_ref.map(|v| v as &[String]),
        body.min_importance,
    ).await?;

    // Step 3: Download + SEAL decrypt all results concurrently
    let db = &state.db;
    let scoring = body.scoring_weights.unwrap_or_default();
    let hit_ids_by_blob: std::collections::HashMap<String, String> = hits
        .iter()
        .map(|hit| (hit.blob_id.clone(), hit.id.clone()))
        .collect();
    let benchmark_mode = state.config.benchmark_mode;
    let tasks: Vec<_> = hits.iter().map(|hit| {
        let walrus_client = &state.walrus_client;
        let http_client = &state.http_client;
        let sidecar_url = state.config.sidecar_url.clone();
        let blob_id = hit.blob_id.clone();
        let distance = hit.distance;
        let memory_type = hit.memory_type.clone();
        let importance = hit.importance;
        let created_at = hit.created_at.clone();
        let access_count = hit.access_count;
        let private_key = private_key.to_string();
        let package_id = state.config.package_id.clone();
        let account_id = auth.account_id.clone();
        let scoring = scoring.clone();
        async move {
            // Resolve plaintext: benchmark mode reads from DB, production downloads + decrypts.
            let text_opt: Option<String> = if benchmark_mode {
                match db.fetch_plaintext_by_blob_id(&blob_id).await {
                    Ok(Some(t)) => Some(t),
                    Ok(None) => {
                        tracing::warn!("Benchmark row missing plaintext: {}", blob_id);
                        None
                    }
                    Err(e) => {
                        tracing::warn!("Failed to fetch plaintext for {}: {}", blob_id, e);
                        None
                    }
                }
            } else {
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
                    Ok(plaintext) => match String::from_utf8(plaintext) {
                        Ok(t) => Some(t),
                        Err(e) => {
                            tracing::warn!("Invalid UTF-8 in decrypted data: {}", e);
                            None
                        }
                    },
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
            };

            if let Some(text) = text_opt {
                            // Compute composite score
                            let semantic_score = 1.0 - distance;
                            let importance_score = importance.unwrap_or(0.5) as f64;

                            // Recency decay: exponential decay based on days since creation
                            let recency_score = if let Some(ref ca) = created_at {
                                if let Ok(ts) = chrono::DateTime::parse_from_str(ca, "%Y-%m-%d %H:%M:%S%.f%z")
                                    .or_else(|_| chrono::DateTime::parse_from_rfc3339(ca))
                                {
                                    let days_old = (chrono::Utc::now() - ts.with_timezone(&chrono::Utc)).num_hours() as f64 / 24.0;
                                    0.95_f64.powf(days_old) // decay 5% per day
                                } else {
                                    0.5 // can't parse, assume medium
                                }
                            } else {
                                0.5
                            };

                            // Frequency score: normalized log of access count
                            let freq_score = {
                                let ac = access_count.unwrap_or(0).max(0) as f64;
                                (1.0 + ac).ln() / (1.0 + 100.0_f64).ln() // normalized to [0,1] with 100 max
                            };

                            let composite = (scoring.semantic as f64) * semantic_score
                                + (scoring.importance as f64) * importance_score
                                + (scoring.recency as f64) * recency_score
                                + (scoring.frequency as f64) * freq_score;

                            Some(RecallResult {
                                blob_id,
                                text,
                                distance,
                                score: Some(composite),
                                memory_type,
                                importance,
                                created_at,
                                access_count,
                            })
            } else {
                None
            }
        }
    }).collect();

    let mut results: Vec<RecallResult> = futures::future::join_all(tasks)
        .await
        .into_iter()
        .flatten()
        .collect();

    // Sort by composite score (descending) instead of just distance
    results.sort_by(|a, b| {
        b.score.unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(body.limit);

    // Touch only the memories that actually made it into the final response.
    let hit_ids: Vec<String> = results
        .iter()
        .filter_map(|result| hit_ids_by_blob.get(&result.blob_id).cloned())
        .collect();
    {
        let state = state.clone();
        tokio::spawn(async move {
            for id in hit_ids {
                if let Err(e) = state.db.touch_memory(&id).await {
                    tracing::debug!("fire-and-forget touch failed for {}: {}", id, e);
                }
            }
        });
    }

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
    if body.vector.is_empty() {
        return Err(AppError::BadRequest("vector cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!(
        "remember_manual: vector_dims={} owner={} ns={}",
        body.vector.len(), owner, namespace
    );

    let encrypted_data = body
        .encrypted_data
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let legacy_blob_id = body
        .blob_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if encrypted_data.is_some() && legacy_blob_id.is_some() {
        return Err(AppError::BadRequest(
            "Provide either encrypted_data or blob_id, not both".into(),
        ));
    }

    let (blob_id, blob_size) = if let Some(encoded) = encrypted_data {
        // New mode: client sends encrypted payload, server uploads to Walrus.
        let encrypted_bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| AppError::BadRequest(format!("encrypted_data is not valid base64: {}", e)))?;

        rate_limit::check_storage_quota(&state, owner, encrypted_bytes.len() as i64).await?;

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

        tracing::info!("remember_manual: walrus upload ok blob_id={}", upload.blob_id);
        (upload.blob_id, encrypted_bytes.len() as i64)
    } else if let Some(existing_blob_id) = legacy_blob_id {
        // Backward-compatible mode: client already uploaded the blob and only registers vector mapping.
        let encrypted_bytes = walrus::download_blob(&state.walrus_client, existing_blob_id).await?;
        let blob_size = encrypted_bytes.len() as i64;
        rate_limit::check_storage_quota(&state, owner, blob_size).await?;
        tracing::info!("remember_manual: using pre-uploaded blob_id={} (legacy mode)", existing_blob_id);
        (existing_blob_id.to_string(), blob_size)
    } else {
        return Err(AppError::BadRequest(
            "Either encrypted_data or blob_id must be provided".into(),
        ));
    };

    // Store {vector, blobId, namespace} in Vector DB
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
/// AI fact extraction + consolidation flow (mem0-inspired 3-stage pipeline):
/// 1. Verify auth (middleware) → get owner
/// 2. EXTRACT: Call LLM to extract structured facts (with type + importance)
/// 3. CONSOLIDATE: Batch all facts + existing memories → single LLM call with integer ID mapping
/// 4. STORE: Apply decisions (add new, supersede old, invalidate contradictions, bump access)
///
/// Key design choices (aligned with mem0):
/// - **Batch consolidation**: 1 LLM call for ALL facts (not per-fact) → cost efficient, cross-fact awareness
/// - **UUID→integer mapping**: Existing memory IDs mapped to "0","1","2" in LLM prompt to prevent hallucination
/// - **Content hash fast-path**: SHA-256 dedup before any LLM or network calls
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

    // ── Stage 1: EXTRACT ──
    let extracted = extract_structured_facts_llm(&state.http_client, &state.config, &body.text).await?;
    tracing::info!("  → Extracted {} facts", extracted.len());

    if extracted.is_empty() {
        return Ok(Json(AnalyzeResponse {
            facts: vec![],
            total: 0,
            owner: owner.clone(),
        }));
    }

    // NOTE: Quota check is deferred until after dedup — duplicates don't consume new storage.
    // See below after Stage 2 dedup.


    // ── Stage 2: FAST-PATH DEDUP + EMBED ──
    // For each fact: check content hash → if duplicate, bump access_count and skip
    // Otherwise embed the fact for vector search
    let mut non_dup_facts: Vec<(ExtractedFact, Vec<f32>, String)> = Vec::new(); // (fact, vector, content_hash)
    let mut dup_results: Vec<AnalyzedFact> = Vec::new();

    for fact in &extracted {
        let content_hash = {
            use sha2::Digest;
            let hash = sha2::Sha256::digest(fact.text.as_bytes());
            hex::encode(hash)
        };

        if let Some((existing_id, existing_blob_id)) = state.db.find_by_content_hash(owner, namespace, &content_hash).await? {
            tracing::info!("  → NOOP (exact duplicate): \"{}...\"", truncate_str(&fact.text, 40));
            state.db.touch_memory(&existing_id).await?;
            dup_results.push(AnalyzedFact {
                text: fact.text.clone(),
                id: existing_id,
                blob_id: existing_blob_id,
            });
        } else {
            let vector = generate_embedding(&state.http_client, &state.config, &fact.text).await?;
            non_dup_facts.push((fact.clone(), vector, content_hash));
        }
    }

    if non_dup_facts.is_empty() {
        // All facts were duplicates — return early (no quota consumed)

        tracing::info!("analyze: all {} facts are exact duplicates", extracted.len());
        let total = dup_results.len();
        return Ok(Json(AnalyzeResponse {
            facts: dup_results,
            total,
            owner: owner.clone(),
        }));
    }

    // Deferred quota check: only non-duplicate facts will consume new storage
    let new_text_bytes: i64 = non_dup_facts.iter().map(|(f, _, _)| f.text.as_bytes().len() as i64).sum();
    rate_limit::check_storage_quota(&state, owner, new_text_bytes).await?;

    // ── Stage 3: FIND SIMILAR EXISTING MEMORIES ──
    // For each non-dup fact, search for similar existing memories.
    // Collect all unique old memories (by ID) across all facts for batch processing.
    let mut all_similar_by_fact: Vec<Vec<crate::db::ExistingMemory>> = Vec::new();
    let mut unique_old_memories: std::collections::HashMap<String, String> = std::collections::HashMap::new(); // id → blob_id

    for (fact, vector, _hash) in &non_dup_facts {
        let similar = state.db.find_similar_existing(
            vector, owner, namespace, 0.25, 5, // Increased to 5 (aligned with mem0)
        ).await?;

        for sim in &similar {
            unique_old_memories.entry(sim.id.clone()).or_insert_with(|| sim.blob_id.clone());
        }
        tracing::debug!("  fact \"{}...\" has {} similar", truncate_str(&fact.text, 30), similar.len());
        all_similar_by_fact.push(similar);
    }

    tracing::info!("  → Found {} unique existing memories to compare", unique_old_memories.len());

    // ── Stage 4: BATCH DECRYPT OLD MEMORIES ──
    // Decrypt all unique old memories in one pass (deduped by blob_id to avoid double downloads)
    let mut decrypted_old_memories: std::collections::HashMap<String, String> = std::collections::HashMap::new(); // id → plaintext

    if !unique_old_memories.is_empty() {
        if state.config.benchmark_mode {
            // Benchmark: read plaintext directly from DB, no SEAL/Walrus involved.
            for (id, _blob_id) in &unique_old_memories {
                match state.db.fetch_plaintext(id).await {
                    Ok(Some(text)) => {
                        decrypted_old_memories.insert(id.clone(), text);
                    }
                    Ok(None) => {
                        tracing::warn!("Benchmark row {} has no plaintext", id);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to fetch plaintext for {}: {}", id, e);
                    }
                }
            }
            tracing::info!("  → Loaded {} old memories for batch consolidation (benchmark mode)", decrypted_old_memories.len());
        } else {
            let private_key_opt = auth.delegate_key.clone().or_else(|| state.config.sui_private_key.clone());
            if let Some(private_key) = private_key_opt {
                // Dedup by blob_id (multiple memory IDs can share the same blob_id)
                let mut blob_to_ids: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
                for (id, blob_id) in &unique_old_memories {
                    blob_to_ids.entry(blob_id.clone()).or_default().push(id.clone());
                }

                for (blob_id, ids) in &blob_to_ids {
                    if let Ok(encrypted) = walrus::download_blob(&state.walrus_client, blob_id).await {
                        if let Ok(plaintext_bytes) = seal::seal_decrypt(
                            &state.http_client, &state.config.sidecar_url, &encrypted,
                            &private_key, &state.config.package_id, &auth.account_id,
                        ).await {
                            if let Ok(text) = String::from_utf8(plaintext_bytes) {
                                for id in ids {
                                    decrypted_old_memories.insert(id.clone(), text.clone());
                                }
                            }
                        }
                    }
                }
                tracing::info!("  → Decrypted {} old memories for batch consolidation", decrypted_old_memories.len());
            } else {
                tracing::warn!("No decryption key available for consolidation, all facts will be ADD");
            }
        }
    }

    // ── Stage 5: BATCH LLM CONSOLIDATION (mem0-style) ──
    // Build a single prompt with all old memories (UUID→integer mapped) + all new facts
    // → 1 LLM call returns decisions for every new fact

    // Build integer→UUID mapping for old memories (prevents LLM hallucination)
    let old_memory_ids: Vec<String> = decrypted_old_memories.keys().cloned().collect();
    let mut int_to_uuid: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut old_memories_for_prompt: Vec<(String, String)> = Vec::new(); // (integer_id, text)
    for (idx, id) in old_memory_ids.iter().enumerate() {
        let int_id = idx.to_string();
        int_to_uuid.insert(int_id.clone(), id.clone());
        if let Some(text) = decrypted_old_memories.get(id) {
            old_memories_for_prompt.push((int_id, text.clone()));
        }
    }

    let new_facts_text: Vec<String> = non_dup_facts.iter().map(|(f, _, _)| f.text.clone()).collect();

    let batch_decisions = if !old_memories_for_prompt.is_empty() {
        match llm_batch_consolidation(
            &state.http_client, &state.config,
            &old_memories_for_prompt, &new_facts_text,
        ).await {
            Ok(decisions) => {
                // Map integer IDs back to real UUIDs
                decisions.into_iter().map(|mut d| {
                    d.target_id = d.target_id.and_then(|int_id| int_to_uuid.get(&int_id).cloned());
                    d
                }).collect::<Vec<_>>()
            }
            Err(e) => {
                tracing::warn!("Batch LLM consolidation failed: {}, falling back to all ADD", e);
                new_facts_text.iter().map(|t| LlmConsolidationDecision {
                    action: ConsolidationAction::Add,
                    target_id: None,
                    text: Some(t.clone()),
                }).collect()
            }
        }
    } else {
        // No old memories → all ADD
        new_facts_text.iter().map(|t| LlmConsolidationDecision {
            action: ConsolidationAction::Add,
            target_id: None,
            text: Some(t.clone()),
        }).collect()
    };

    tracing::info!("  → Batch consolidation returned {} decisions", batch_decisions.len());

    // ── Stage 6: APPLY ACTIONS (STORE) ──
    // Process each non-dup fact with its corresponding decision
    let mut stored_facts: Vec<AnalyzedFact> = dup_results; // Start with duplicates already processed

    for (idx, (fact, vector, content_hash)) in non_dup_facts.iter().enumerate() {
        let decision = batch_decisions.get(idx).cloned().unwrap_or(LlmConsolidationDecision {
            action: ConsolidationAction::Add,
            target_id: None,
            text: Some(fact.text.clone()),
        });

        tracing::info!("  fact[{}] \"{}...\" → {:?} (target: {:?})",
            idx, truncate_str(&fact.text, 30), decision.action, decision.target_id);

        match decision.action {
            ConsolidationAction::Noop => {
                if let Some(ref id) = decision.target_id {
                    let _ = state.db.touch_memory(id).await;
                }
                let (noop_id, noop_blob_id) = match decision.target_id.clone() {
                    Some(id) => {
                        let blob = unique_old_memories
                            .get(&id)
                            .cloned()
                            .unwrap_or_else(|| "(duplicate)".to_string());
                        (id, blob)
                    }
                    None => ("(noop)".to_string(), "(noop)".to_string()),
                };
                stored_facts.push(AnalyzedFact {
                    text: fact.text.clone(),
                    id: noop_id,
                    blob_id: noop_blob_id,
                });
            }
            ConsolidationAction::Delete => {
                if let Some(ref id) = decision.target_id {
                    let _ = state.db.soft_delete_memory(id).await;
                    tracing::info!("  → DELETE: invalidated {}", id);
                }
                stored_facts.push(AnalyzedFact {
                    text: fact.text.clone(),
                    id: "(deleted)".into(),
                    blob_id: "".to_string(),
                });
            }
            ConsolidationAction::Add | ConsolidationAction::Update => {
                let final_text = decision.text.as_deref().unwrap_or(&fact.text);

                // Re-embed if LLM changed the text (UPDATE with merged content)
                let final_vector = if final_text != fact.text {
                    generate_embedding(&state.http_client, &state.config, final_text).await?
                } else {
                    vector.clone()
                };

                let final_content_hash = if final_text != fact.text {
                    use sha2::Digest;
                    hex::encode(sha2::Sha256::digest(final_text.as_bytes()))
                } else {
                    content_hash.clone()
                };

                // In benchmark mode, skip SEAL — plaintext goes straight into the DB.
                let encrypt_result: Vec<u8> = if state.config.benchmark_mode {
                    Vec::new() // placeholder, unused in benchmark branch below
                } else {
                    seal::seal_encrypt(
                        &state.http_client, &state.config.sidecar_url,
                        final_text.as_bytes(), owner, &state.config.package_id,
                    ).await?
                };

                let blob_size = if state.config.benchmark_mode {
                    final_text.as_bytes().len() as i64
                } else {
                    encrypt_result.len() as i64
                };

                // Derive metadata from target if UPDATE, else default
                let meta = if decision.action == ConsolidationAction::Update {
                    if let Some(target_id) = &decision.target_id {
                        let existing_meta = all_similar_by_fact.get(idx)
                            .and_then(|similars| similars.iter().find(|m| m.id == *target_id));
                            
                        if let Some(m) = existing_meta {
                            InsertMemoryMeta {
                                memory_type: m.memory_type.clone().unwrap_or_else(|| fact.memory_type.clone()),
                                importance: m.importance.unwrap_or(fact.importance),
                                source: "extracted".to_string(),
                                metadata: serde_json::json!({}),
                                content_hash: Some(final_content_hash.clone()),
                            }
                        } else {
                            InsertMemoryMeta {
                                memory_type: fact.memory_type.clone(),
                                importance: fact.importance,
                                source: "extracted".to_string(),
                                metadata: serde_json::json!({}),
                                content_hash: Some(final_content_hash.clone()),
                            }
                        }
                    } else {
                        InsertMemoryMeta {
                            memory_type: fact.memory_type.clone(),
                            importance: fact.importance,
                            source: "extracted".to_string(),
                            metadata: serde_json::json!({}),
                            content_hash: Some(final_content_hash.clone()),
                        }
                    }
                } else {
                    InsertMemoryMeta {
                        memory_type: fact.memory_type.clone(),
                        importance: fact.importance,
                        source: "extracted".to_string(),
                        metadata: serde_json::json!({}),
                        content_hash: Some(final_content_hash.clone()),
                    }
                };

                // Store with enriched metadata — benchmark mode goes direct to DB,
                // production goes via reserve -> upload -> finalize transaction.
                let (_, actual_id, actual_blob_id) = if state.config.benchmark_mode {
                    store_memory_plaintext(&state, owner, namespace, final_text, &final_vector, meta).await?
                } else {
                    store_memory_with_transaction(
                        &state,
                        owner,
                        namespace,
                        &final_vector,
                        &encrypt_result,
                        blob_size,
                        final_content_hash.clone(),
                        meta,
                    ).await?
                };

                // If UPDATE, supersede the old memory
                if decision.action == ConsolidationAction::Update {
                    if let Some(target_id) = &decision.target_id {
                        if actual_id != *target_id {
                            tracing::info!("  → UPDATE: superseding {} with {}", target_id, actual_id);
                            state.db.supersede_memory(target_id, &actual_id).await?;
                        } else {
                            tracing::info!(
                                "  → UPDATE collapsed to existing memory {}, skipping self-supersede",
                                target_id
                            );
                        }
                    }
                } else {
                    tracing::info!("  → ADD: new memory \"{}...\"", truncate_str(final_text, 40));
                }

                stored_facts.push(AnalyzedFact {
                    text: fact.text.clone(),
                    id: actual_id,
                    blob_id: actual_blob_id,
                });
            }
        }
    }

    let total = stored_facts.len();
    tracing::info!("analyze complete: {} facts processed for owner={}", total, owner);

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
- If the text contains no memorable facts, respond with an empty JSON array []
- Be concise but specific

For each fact, return a JSON array of objects with:
- "text": the fact statement
- "type": one of "fact", "preference", "episodic", "procedural", "biographical"
- "importance": 0.0 to 1.0 (how critical this fact is for future interactions)

Examples:
Input: "I'm allergic to peanuts and I live in Hanoi. What's the weather like?"
Output:
[{"text": "User is allergic to peanuts", "type": "biographical", "importance": 0.9}, {"text": "User lives in Hanoi", "type": "biographical", "importance": 0.7}]

Input: "I prefer using TypeScript over JavaScript for all my projects"
Output:
[{"text": "User prefers TypeScript over JavaScript for all projects", "type": "preference", "importance": 0.6}]

Input: "Hey, how are you?"
Output:
[]"#;

/// A structured extracted fact from the LLM
#[derive(Debug, Clone, serde::Deserialize)]
struct ExtractedFact {
    text: String,
    #[serde(rename = "type", default = "default_fact_type")]
    memory_type: String,
    #[serde(default = "default_fact_importance")]
    importance: f32,
}

fn default_fact_type() -> String { "fact".to_string() }
fn default_fact_importance() -> f32 { 0.5 }

/// Extract structured facts from text using LLM (enhanced prompt with type + importance)
async fn extract_structured_facts_llm(
    client: &reqwest::Client,
    config: &Config,
    text: &str,
) -> Result<Vec<ExtractedFact>, AppError> {
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

    // Try to parse as JSON array of structured facts
    if content.is_empty() || content == "[]" {
        return Ok(vec![]);
    }

    // Strip markdown code fences if present
    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    match serde_json::from_str::<Vec<ExtractedFact>>(json_str) {
        Ok(facts) => Ok(facts),
        Err(e) => {
            tracing::warn!("Failed to parse structured facts JSON, falling back to line-based: {}", e);
            // Fallback: parse as one-fact-per-line (backward compatible)
            let facts: Vec<ExtractedFact> = content
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && l != "NONE")
                .map(|text| ExtractedFact {
                    text,
                    memory_type: "fact".to_string(),
                    importance: 0.5,
                })
                .collect();
            Ok(facts)
        }
    }
}

/// Legacy fact extraction (kept for backward compatibility, used by old callers)
#[allow(dead_code)]
async fn extract_facts_llm(
    client: &reqwest::Client,
    config: &Config,
    text: &str,
) -> Result<Vec<String>, AppError> {
    let facts = extract_structured_facts_llm(client, config, text).await?;
    Ok(facts.into_iter().map(|f| f.text).collect())
}

/// Batch LLM consolidation — mem0-style single-call approach.
///
/// Takes ALL old memories (with integer-mapped IDs) + ALL new facts, asks the LLM
/// to decide ADD/UPDATE/DELETE/NOOP for each new fact in a single call.
///
/// Key design choices:
/// - **Integer ID mapping**: Old memory IDs are "0","1","2"... to prevent UUID hallucination
/// - **Few-shot examples**: 4 detailed examples for ADD/UPDATE/DELETE/NOOP (from mem0's prompt)
/// - **Single call**: All facts processed together → LLM sees the big picture
async fn llm_batch_consolidation(
    client: &reqwest::Client,
    config: &Config,
    old_memories: &[(String, String)], // (integer_id, plaintext)
    new_facts: &[String],
) -> Result<Vec<LlmConsolidationDecision>, AppError> {
    if new_facts.is_empty() {
        return Ok(vec![]);
    }

    // Build old memory list for prompt
    let old_memory_str = if old_memories.is_empty() {
        "Current memory is empty.".to_string()
    } else {
        let entries: Vec<String> = old_memories.iter()
            .map(|(id, text)| format!("  {{\"id\": \"{}\", \"text\": \"{}\"}}", id, text.replace('"', "\\\"")))
            .collect();
        format!("[\n{}\n]", entries.join(",\n"))
    };

    // Build new facts list for prompt
    let new_facts_str: Vec<String> = new_facts.iter()
        .map(|f| format!("\"{}\"", f.replace('"', "\\\"")))
        .collect();
    let new_facts_json = format!("[{}]", new_facts_str.join(", "));

    let prompt = format!(
        r#"You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) ADD into the memory, (2) UPDATE the memory, (3) DELETE from the memory, and (4) NOOP (no change).

Compare newly retrieved facts with the existing memory. For each new fact, decide whether to:
- ADD: Add it to the memory as a new element (completely new information)
- UPDATE: Update an existing memory element (new fact corrects, expands, or enriches an existing one). Use the existing memory's ID.
- DELETE: Delete an existing memory element (new fact contradicts the old one). Use the existing memory's ID.
- NOOP: Make no change (the fact is already fully covered by existing memory). Use the existing memory's ID.

Guidelines:
1. ADD: If the new fact contains information not present in any existing memory.
2. UPDATE: If the new fact corrects, expands, or supersedes an existing memory. Keep the same target_id. The text should be the MERGED comprehensive version.
   - Example: old="User likes cricket" + new="Loves to play cricket with friends" → UPDATE with text="Loves to play cricket with friends"
   - Example: old="Likes cheese pizza" + new="Loves cheese pizza" → NOOP (same meaning, no update needed)
3. DELETE: If the new fact directly contradicts an existing memory.
   - Example: old="Loves cheese pizza" + new="Dislikes cheese pizza" → DELETE the old memory
4. NOOP: If the new fact is already fully captured by an existing memory.

IMPORTANT: For target_id, you MUST only use IDs from the existing memories listed below. Do NOT generate new IDs for UPDATE/DELETE/NOOP operations.

---

Existing Memories:
{}

New Facts:
{}

---

Return your response as a JSON object with a "memory" array. Each entry corresponds to one new fact, in the same order:

{{
  "memory": [
    {{
      "id": "<existing memory ID if UPDATE/DELETE/NOOP, or 'new' if ADD>",
      "text": "<finalized text to store (for ADD/UPDATE) or the fact text (for DELETE/NOOP)>",
      "event": "<ADD | UPDATE | DELETE | NOOP>",
      "old_memory": "<previous memory text, only for UPDATE>"
    }}
  ]
}}

Return ONLY valid JSON. No markdown fences, no extra text."#,
        old_memory_str, new_facts_json
    );

    let req = ChatCompletionRequest {
        model: "openai/gpt-4o-mini".to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: "You are a memory consolidation engine. Output ONLY valid JSON, no extra text.".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: prompt,
            },
        ],
        temperature: 0.1,
    };

    let url = format!("{}/chat/completions", config.openai_api_base);
    let mut builder = client.post(&url);
    if let Some(key) = &config.openai_api_key {
        builder = builder.bearer_auth(key);
    }

    let resp = builder.json(&req).send().await
        .map_err(|e| AppError::Internal(format!("OpenAI request error: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!("Batch consolidation API failed: {} - {}", status, body);
        return Err(AppError::Internal("OpenAI API failed".into()));
    }

    let completion: ChatCompletionResponse = resp.json().await
        .map_err(|e| AppError::Internal(format!("Failed to parse OpenAI JSON: {}", e)))?;

    let content = completion.choices.first()
        .map(|c| c.message.content.trim())
        .unwrap_or_default();

    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    tracing::debug!("Batch consolidation raw LLM response: {}", json_str);

    // Parse the batch response — mem0-style {"memory": [...]}
    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| AppError::Internal(format!("Failed to parse batch consolidation JSON: {}", e)))?;

    let memory_array = parsed.get("memory")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::Internal("Batch consolidation response missing 'memory' array".into()))?;

    let mut decisions: Vec<LlmConsolidationDecision> = Vec::new();
    for entry in memory_array {
        let event = entry.get("event")
            .and_then(|v| v.as_str())
            .unwrap_or("ADD")
            .to_uppercase();
        let text = entry.get("text")
            .and_then(|v| v.as_str())
            .map(String::from);
        let id = entry.get("id")
            .and_then(|v| v.as_str())
            .map(String::from);

        let action = match event.as_str() {
            "UPDATE" => ConsolidationAction::Update,
            "DELETE" => ConsolidationAction::Delete,
            "NOOP" | "NONE" => ConsolidationAction::Noop, // Accept both NOOP and NONE
            _ => ConsolidationAction::Add,
        };

        // For ADD events, target_id should be None (it might be "new" or a generated value)
        let target_id = match action {
            ConsolidationAction::Add => None,
            _ => id.filter(|s| s != "new" && !s.is_empty()),
        };

        decisions.push(LlmConsolidationDecision {
            action,
            target_id,
            text,
        });
    }

    // Truncate if LLM returned MORE decisions than facts (prevents spurious actions)
    decisions.truncate(new_facts.len());

    // If LLM returned fewer decisions than facts, pad with ADD
    while decisions.len() < new_facts.len() {
        let idx = decisions.len();
        decisions.push(LlmConsolidationDecision {
            action: ConsolidationAction::Add,
            target_id: None,
            text: Some(new_facts[idx].clone()),
        });
    }

    tracing::info!("Batch consolidation: {} decisions for {} facts", decisions.len(), new_facts.len());
    Ok(decisions)
}

/// Legacy per-fact consolidation — kept as internal fallback.
/// Prefer `llm_batch_consolidation` for new code.
#[allow(dead_code)]
async fn llm_decide_consolidation(
    client: &reqwest::Client,
    config: &Config,
    new_fact: &str,
    existing_memories: &[(String, String)], // (id, plaintext)
) -> Result<LlmConsolidationDecision, AppError> {
    if existing_memories.is_empty() {
        return Ok(LlmConsolidationDecision {
            action: ConsolidationAction::Add,
            target_id: None,
            text: Some(new_fact.to_string()),
        });
    }

    let mut old_memories_str = String::new();
    for (_i, (id, text)) in existing_memories.iter().enumerate() {
        old_memories_str.push_str(&format!("ID: {}\nMemory: {}\n---\n", id, text));
    }

    let prompt = format!(
        r#"You are an AI memory manager. Your task is to compare a new fact against existing memories and logically decide how to update the memory.
Format your choice exactly as a JSON object matching this schema:
{{
  "action": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "target_id": "the_existing_id_here" (or null if ADD),
  "text": "the finalized text to store" (or null if NOOP/DELETE)
}}

Existing Memories:
{}
New fact:
{}

Decision rules:
- NOOP: If the new fact brings absolutely no new information and everything is already covered.
- UPDATE: If the new fact corrects, expands, or supersedes an existing memory. Set target_id to the existing memory id, and text to the updated comprehensive memory.
- DELETE: If the new fact directly contradicts and invalidates the old one without replacing it.
- ADD: If the new fact is completely distinct and unrelated to the existing memories.
"#,
        old_memories_str, new_fact
    );

    let req = ChatCompletionRequest {
        model: "openai/gpt-4o-mini".to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: "You output JSON only. No markdown fences.".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: prompt,
            },
        ],
        temperature: 0.1,
    };

    let url = format!("{}/chat/completions", config.openai_api_base);
    let mut builder = client.post(&url);
    if let Some(key) = &config.openai_api_key {
        builder = builder.bearer_auth(key);
    }
    
    let resp = builder.json(&req).send().await
        .map_err(|e| AppError::Internal(format!("OpenAI request error: {}", e)))?;

    if !resp.status().is_success() {
        tracing::warn!("LLM Consolidation API failed: {} - {}", resp.status(), resp.text().await.unwrap_or_default());
        return Err(AppError::Internal("OpenAI API failed".into()));
    }

    let completion: ChatCompletionResponse = resp.json().await
        .map_err(|e| AppError::Internal(format!("Failed to parse OpenAI JSON: {}", e)))?;
        
    let content = completion.choices.first()
        .map(|c| c.message.content.trim())
        .unwrap_or_default();
        
    let json_str = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
        
    let decision: LlmConsolidationDecision = serde_json::from_str(json_str)
        .map_err(|e| AppError::Internal(format!("Failed to parse LLM consolidation decision: {}", e)))?;
        
    Ok(decision)
}

/// Reserve a memory row, upload the encrypted blob, then finalize the blob_id
/// inside the same transaction.
///
/// The reservation is committed only after the Walrus upload and blob_id update
/// succeed, which keeps duplicate content-hash writers serialized and avoids
/// orphan uploads when a duplicate request loses the race.
/// Benchmark-mode store: skips SEAL encryption + Walrus upload entirely.
/// Stores plaintext directly in the vector_entries row. Used only when
/// config.benchmark_mode is true.
///
/// The unique content_hash index still provides duplicate protection —
/// no advisory lock or transaction needed for this fast path.
async fn store_memory_plaintext(
    state: &Arc<AppState>,
    owner: &str,
    namespace: &str,
    plaintext: &str,
    vector: &[f32],
    meta: InsertMemoryMeta,
) -> Result<(bool, String, String), AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    state
        .db
        .insert_vector_plaintext(&id, owner, namespace, plaintext, vector, meta)
        .await
}

async fn store_memory_with_transaction(
    state: &Arc<AppState>,
    owner: &str,
    namespace: &str,
    vector: &[f32],
    encrypted: &[u8],
    blob_size: i64,
    content_hash: String,
    meta: InsertMemoryMeta,
) -> Result<(bool, String, String), AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let pending_blob_id = format!("pending:{}", id);
    let lock_key = format!("{}:{}:{}", owner, namespace, content_hash);

    let mut tx = state
        .db
        .pool()
        .begin()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to start memory insert tx: {}", e)))?;

    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(lock_key)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to lock content hash: {}", e)))?;

    let (is_new, actual_id, actual_blob_id) = state
        .db
        .insert_vector_enriched_tx(
            &mut tx,
            &id,
            owner,
            namespace,
            &pending_blob_id,
            vector,
            blob_size,
            meta,
        )
        .await?;

    if !is_new {
        tx.rollback()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to rollback duplicate insert tx: {}", e)))?;
        return Ok((false, actual_id, actual_blob_id));
    }

    let sui_key = state
        .key_pool
        .next()
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Internal("No Sui keys configured (set SERVER_SUI_PRIVATE_KEYS or SERVER_SUI_PRIVATE_KEY)".into()))?;

    let upload_result = walrus::upload_blob(
        &state.http_client,
        &state.config.sidecar_url,
        encrypted,
        50,
        owner,
        &sui_key,
        namespace,
        &state.config.package_id,
    )
    .await?;

    state
        .db
        .update_blob_id_tx(&mut tx, &actual_id, &upload_result.blob_id)
        .await?;

    tx.commit()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to commit memory insert tx: {}", e)))?;

    Ok((true, actual_id, upload_result.blob_id))
}

// ============================================================
// Memory Management Routes
// ============================================================

/// POST /api/stats
///
/// Get memory statistics for an owner/namespace
pub async fn stats(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<StatsRequest>,
) -> Result<Json<StatsResponse>, AppError> {
    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!("stats: owner={} ns={}", owner, namespace);

    let memory_stats = state.db.get_memory_stats(owner, namespace).await?;

    Ok(Json(StatsResponse {
        total: memory_stats.total,
        by_type: memory_stats.by_type,
        avg_importance: memory_stats.avg_importance,
        oldest_memory: memory_stats.oldest_memory,
        newest_memory: memory_stats.newest_memory,
        total_access_count: memory_stats.total_access_count,
        storage_bytes: memory_stats.storage_bytes,
        owner: owner.clone(),
        namespace: namespace.clone(),
    }))
}

/// POST /api/forget
///
/// Selectively invalidate memories matching a semantic query.
/// Uses soft-deletion (sets valid_until timestamp, doesn't delete from Walrus).
pub async fn forget(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<ForgetRequest>,
) -> Result<Json<ForgetResponse>, AppError> {
    if body.query.is_empty() {
        return Err(AppError::BadRequest("Query cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!("forget: query=\"{}...\" owner={} ns={}", truncate_str(&body.query, 50), owner, namespace);

    // Embed the query
    let query_vector = generate_embedding(&state.http_client, &state.config, &body.query).await?;

    // Find similar memories above threshold
    // Validate threshold in [0, 1] range
    let threshold = body.threshold.clamp(0.0, 1.0);
    // Convert similarity threshold to distance threshold:
    // similarity = 1.0 - cosine_distance, so distance_threshold = 1.0 - similarity_threshold
    let distance_threshold = 1.0 - threshold;
    let similar = state.db.find_similar_existing(
        &query_vector, owner, namespace, distance_threshold, body.limit,
    ).await?;

    // Soft-delete each match
    let mut forgotten = 0;
    for memory in &similar {
        state.db.soft_delete_memory(&memory.id).await?;
        forgotten += 1;
        tracing::info!("  → forgot memory {} (d={:.3})", memory.id, memory.distance);
    }

    tracing::info!("forget complete: {} memories invalidated for owner={}", forgotten, owner);

    Ok(Json(ForgetResponse {
        forgotten,
        owner: owner.clone(),
        namespace: namespace.clone(),
    }))
}

/// POST /api/consolidate
///
/// Trigger manual memory consolidation for a namespace.
/// Downloads all active memories, decrypts them via SEAL,
/// runs batch LLM consolidation, applies merge/delete/update actions.
pub async fn consolidate(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<ConsolidateRequest>,
) -> Result<Json<ConsolidateResponse>, AppError> {
    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!("consolidate: owner={} ns={} limit={}", owner, namespace, body.limit);

    // Get decryption key
    let private_key = auth.delegate_key.as_deref()
        .or(state.config.sui_private_key.as_deref())
        .ok_or_else(|| {
            AppError::Internal("Delegate key or SERVER_SUI_PRIVATE_KEY required for consolidation".into())
        })?;

    // Step 1: Get all active memories
    let memories = state.db.get_active_memories(owner, namespace, body.limit).await?;
    if memories.len() < 2 {
        tracing::info!("consolidate: fewer than 2 memories, nothing to consolidate");
        return Ok(Json(ConsolidateResponse {
            processed: memories.len(),
            added: 0, updated: 0, deleted: 0, unchanged: memories.len(),
            owner: owner.clone(),
            namespace: namespace.clone(),
        }));
    }

    tracing::info!("  → {} active memories to consolidate", memories.len());

    // Step 2: Decrypt all memories (dedup by blob_id)
    let mut blob_to_ids: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for mem in &memories {
        blob_to_ids.entry(mem.blob_id.clone()).or_default().push(mem.id.clone());
    }

    let mut decrypted: std::collections::HashMap<String, String> = std::collections::HashMap::new(); // id → plaintext
    for (blob_id, ids) in &blob_to_ids {
        if let Ok(encrypted) = walrus::download_blob(&state.walrus_client, blob_id).await {
            if let Ok(plaintext_bytes) = seal::seal_decrypt(
                &state.http_client, &state.config.sidecar_url, &encrypted,
                private_key, &state.config.package_id, &auth.account_id,
            ).await {
                if let Ok(text) = String::from_utf8(plaintext_bytes) {
                    for id in ids {
                        decrypted.insert(id.clone(), text.clone());
                    }
                }
            }
        }
    }

    tracing::info!("  → Decrypted {} memories for consolidation", decrypted.len());

    if decrypted.len() < 2 {
        return Ok(Json(ConsolidateResponse {
            processed: memories.len(),
            added: 0, updated: 0, deleted: 0, unchanged: memories.len(),
            owner: owner.clone(),
            namespace: namespace.clone(),
        }));
    }

    // Step 3: Build integer→UUID mapping + prompt for batch LLM consolidation
    // Also build id→metadata lookup so we can inherit memory_type/importance
    let id_to_meta: std::collections::HashMap<String, (String, f32, i64)> = memories.iter()
        .map(|m| (
            m.id.clone(),
            (
                m.memory_type.clone().unwrap_or_else(|| "fact".to_string()),
                m.importance.unwrap_or(0.5),
                m.blob_size_bytes,
            ),
        ))
        .collect();

    // Calculate majority type and average importance from context for ADD branch defaults
    let (context_type, context_importance) = if memories.is_empty() {
        ("fact".to_string(), 0.5)
    } else {
        let mut type_counts = std::collections::HashMap::new();
        let mut total_imp = 0.0;
        for m in &memories {
            *type_counts.entry(m.memory_type.clone().unwrap_or_else(|| "fact".to_string())).or_insert(0) += 1;
            total_imp += m.importance.unwrap_or(0.5);
        }
        let mode_type = type_counts.into_iter().max_by_key(|&(_, count)| count).map(|(t, _)| t).unwrap_or_else(|| "fact".to_string());
        let avg_imp = total_imp / (memories.len() as f32);
        (mode_type, avg_imp)
    };

    let memory_ids: Vec<String> = decrypted.keys().cloned().collect();
    let mut int_to_uuid: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut memories_for_prompt: Vec<(String, String)> = Vec::new(); // (integer_id, text)
    for (idx, id) in memory_ids.iter().enumerate() {
        let int_id = idx.to_string();
        int_to_uuid.insert(int_id.clone(), id.clone());
        if let Some(text) = decrypted.get(id) {
            memories_for_prompt.push((int_id, text.clone()));
        }
    }

    // Step 4: Ask LLM to find duplicates and conflicts among existing memories
    let all_texts: Vec<String> = memories_for_prompt.iter().map(|(_, t)| t.clone()).collect();
    let batch_decisions = match llm_batch_consolidation(
        &state.http_client, &state.config,
        &memories_for_prompt, &all_texts,
    ).await {
        Ok(decisions) => {
            decisions.into_iter().map(|mut d| {
                d.target_id = d.target_id.and_then(|int_id| int_to_uuid.get(&int_id).cloned());
                d
            }).collect::<Vec<_>>()
        }
        Err(e) => {
            tracing::warn!("Consolidation LLM failed: {}, returning unchanged", e);
            return Ok(Json(ConsolidateResponse {
                processed: memories.len(),
                added: 0, updated: 0, deleted: 0, unchanged: memories.len(),
                owner: owner.clone(),
                namespace: namespace.clone(),
            }));
        }
    };

    // Step 5: Apply decisions (truncated to match input count for safety)
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut deleted = 0usize;
    let mut unchanged = 0usize;

    for decision in &batch_decisions {
        match decision.action {
            ConsolidationAction::Noop => {
                unchanged += 1;
                if let Some(ref id) = decision.target_id {
                    let _ = state.db.touch_memory(id).await;
                }
            }
            ConsolidationAction::Delete => {
                if let Some(ref id) = decision.target_id {
                    let _ = state.db.soft_delete_memory(id).await;
                    deleted += 1;
                }
            }
            ConsolidationAction::Update => {
                if let Some(ref target_id) = decision.target_id {
                    if let Some(ref new_text) = decision.text {
                        // Inherit memory_type, importance, and old blob size from the original memory
                        let (orig_type, orig_importance, old_blob_size) = id_to_meta.get(target_id)
                            .cloned()
                            .unwrap_or_else(|| ("fact".to_string(), 0.5, 0));

                        let encrypt_result: Vec<u8> = if state.config.benchmark_mode {
                            Vec::new() // unused in benchmark branch below
                        } else {
                            match seal::seal_encrypt(
                                &state.http_client, &state.config.sidecar_url,
                                new_text.as_bytes(), owner, &state.config.package_id,
                            ).await {
                                Ok(v) => v,
                                Err(e) => {
                                    tracing::warn!(
                                        "consolidate UPDATE skipped for {}: SEAL encrypt failed: {}",
                                        target_id, e
                                    );
                                    unchanged += 1;
                                    continue;
                                }
                            }
                        };

                        // Net-neutral quota check uses encrypted bytes (same unit as blob_size_bytes).
                        let new_blob_size = if state.config.benchmark_mode {
                            new_text.as_bytes().len() as i64
                        } else {
                            encrypt_result.len() as i64
                        };
                        let size_delta = new_blob_size - old_blob_size;
                        if size_delta > 0 {
                            if let Err(e) = rate_limit::check_storage_quota(&state, owner, size_delta).await {
                                tracing::warn!(
                                    "consolidate UPDATE skipped for {}: quota check failed: {}",
                                    target_id, e
                                );
                                unchanged += 1;
                                continue;
                            }
                        }

                        // Create new memory with merged text
                        let vector = match generate_embedding(&state.http_client, &state.config, new_text).await {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::warn!(
                                    "consolidate UPDATE skipped for {}: embedding failed: {}",
                                    target_id, e
                                );
                                unchanged += 1;
                                continue;
                            }
                        };
                        let content_hash = {
                            use sha2::Digest;
                            hex::encode(sha2::Sha256::digest(new_text.as_bytes()))
                        };
                        
                        let store_meta = InsertMemoryMeta {
                            memory_type: orig_type,
                            importance: orig_importance,
                            source: "system".to_string(),
                            metadata: serde_json::json!({}),
                            content_hash: Some(content_hash.clone()),
                        };
                        let store_res = if state.config.benchmark_mode {
                            store_memory_plaintext(&state, owner, namespace, new_text, &vector, store_meta).await
                        } else {
                            store_memory_with_transaction(
                                &state,
                                owner,
                                namespace,
                                &vector,
                                &encrypt_result,
                                encrypt_result.len() as i64,
                                content_hash.clone(),
                                store_meta,
                            ).await
                        };
                        let (_, actual_id, _) = match store_res {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::warn!(
                                    "consolidate UPDATE skipped for {}: DB insert failed: {}",
                                    target_id, e
                                );
                                unchanged += 1;
                                continue;
                            }
                        };

                        if actual_id != *target_id {
                            // Update the supersede pointer to the actual new ID AFTER successful insert.
                            // This prevents data loss if upload/insert fails.
                            if let Err(e) = state.db.supersede_memory(target_id, &actual_id).await {
                                tracing::warn!(
                                    "consolidate UPDATE skipped for {}: supersede failed: {}",
                                    target_id, e
                                );
                                unchanged += 1;
                                continue;
                            }
                            updated += 1;
                        } else {
                            tracing::info!(
                                "  → UPDATE collapsed to existing memory {}, skipping self-supersede",
                                target_id
                            );
                            unchanged += 1;
                        }
                    }
                }
            }
            ConsolidationAction::Add => {
                if let Some(ref new_text) = decision.text {
                    let encrypt_result: Vec<u8> = if state.config.benchmark_mode {
                        Vec::new()
                    } else {
                        match seal::seal_encrypt(
                            &state.http_client, &state.config.sidecar_url,
                            new_text.as_bytes(), owner, &state.config.package_id,
                        ).await {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::warn!("consolidate ADD skipped: SEAL encrypt failed: {}", e);
                                unchanged += 1;
                                continue;
                            }
                        }
                    };

                    let quota_bytes = if state.config.benchmark_mode {
                        new_text.as_bytes().len() as i64
                    } else {
                        encrypt_result.len() as i64
                    };

                    // Quota check uses encrypted bytes (same unit as persisted blob_size_bytes).
                    if let Err(e) = rate_limit::check_storage_quota(&state, owner, quota_bytes).await {
                        tracing::warn!("consolidate ADD skipped: quota check failed: {}", e);
                        unchanged += 1;
                        continue;
                    }

                    let vector = match generate_embedding(&state.http_client, &state.config, new_text).await {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::warn!("consolidate ADD skipped: embedding failed: {}", e);
                            unchanged += 1;
                            continue;
                        }
                    };
                    let content_hash = {
                        use sha2::Digest;
                        hex::encode(sha2::Sha256::digest(new_text.as_bytes()))
                    };
                    let store_meta = InsertMemoryMeta {
                        memory_type: context_type.clone(),
                        importance: context_importance,
                        source: "system".to_string(),
                        metadata: serde_json::json!({}),
                        content_hash: Some(content_hash.clone()),
                    };
                    let store_res = if state.config.benchmark_mode {
                        store_memory_plaintext(&state, owner, namespace, new_text, &vector, store_meta).await
                    } else {
                        store_memory_with_transaction(
                            &state,
                            owner,
                            namespace,
                            &vector,
                            &encrypt_result,
                            encrypt_result.len() as i64,
                            content_hash.clone(),
                            store_meta,
                        ).await
                    };
                    if let Err(e) = store_res {
                        tracing::warn!("consolidate ADD skipped: DB insert failed: {}", e);
                        unchanged += 1;
                        continue;
                    }
                    added += 1;
                }
            }
        }
    }

    tracing::info!("consolidate complete: added={}, updated={}, deleted={}, unchanged={}", added, updated, deleted, unchanged);

    Ok(Json(ConsolidateResponse {
        processed: memories.len(),
        added,
        updated,
        deleted,
        unchanged,
        owner: owner.clone(),
        namespace: namespace.clone(),
    }))
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
                        Ok(text) => Some(RecallResult {
                                blob_id,
                                text,
                                distance,
                                score: None,
                                memory_type: None,
                                importance: None,
                                created_at: None,
                                access_count: None,
                            }),
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
