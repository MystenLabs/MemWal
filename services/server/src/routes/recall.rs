//! POST /api/recall and POST /api/recall/manual handlers.

use axum::{extract::State, Extension, Json};
use std::sync::Arc;

use crate::storage::{seal, walrus};
use crate::types::*;

use super::{cleanup_expired_blob, truncate_str};

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
    let query_vector = state.embedder.embed(&body.query).await?;

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
