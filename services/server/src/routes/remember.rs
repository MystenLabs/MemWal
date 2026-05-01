//! POST /api/remember and POST /api/remember/manual handlers.

use axum::{extract::State, Extension, Json};
use base64::Engine as _;
use std::sync::Arc;

use crate::rate_limit;
use crate::storage::{seal, walrus};
use crate::types::*;

use super::truncate_str;

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
    let embed_fut = state.embedder.embed(text);
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
        Some(&auth.public_key),
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
        Some(&auth.public_key),
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
