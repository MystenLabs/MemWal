//! Admin and recovery handlers: GET /health, POST /api/ask, POST /api/restore.
//!
//! `ask` and `restore` both touch the full read path (search → download → decrypt).
//! `restore` additionally re-indexes from on-chain source-of-truth.

use axum::{extract::State, Extension, Json};
use std::sync::Arc;

use crate::services::llm_chat::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage,
};
use crate::storage::{seal, walrus};
use crate::types::*;

use super::{cleanup_expired_blob, truncate_str};

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
    let query_vector = state.embedder.embed(&body.question).await?;
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

/// POST /api/restore
///
/// Restore a namespace from Walrus:
/// 1. Get all blob_ids for owner+namespace from on-chain (source of truth)
/// 2. Download missing blobs from Walrus
/// 3. SEAL decrypt with delegate key
/// 4. Re-embed decrypted text
/// 5. Re-index without deleting existing entries
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
        let embedder = Arc::clone(&state.embedder);
        let blob_id = blob_id.clone();
        let text = text.clone();
        async move {
            match embedder.embed(&text).await {
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
