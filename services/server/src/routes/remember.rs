//! POST /api/remember and POST /api/remember/manual handlers.

use axum::{extract::State, Extension, Json};
use base64::Engine as _;
use std::sync::Arc;

use crate::engine::MemoryRecord;
use crate::rate_limit;
use crate::storage::walrus;
use crate::types::*;

use super::truncate_str;

/// POST /api/remember
///
/// Server-managed flow — the engine handles SEAL encryption + Walrus upload
/// (production) or plaintext persistence (benchmark) internally:
/// 1. Verify auth (middleware) → owner derived from delegate key
/// 2. Embed text → vector
/// 3. Hand the record to the engine (it does the rest)
pub async fn remember(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RememberRequest>,
) -> Result<Json<RememberResponse>, AppError> {
    if body.text.is_empty() {
        return Err(AppError::BadRequest("Text cannot be empty".into()));
    }

    let owner = &auth.owner;
    let text = &body.text;
    let namespace = &body.namespace;
    tracing::info!(
        "remember: text=\"{}...\" owner={} ns={}",
        truncate_str(text, 50),
        owner,
        namespace
    );

    // Storage quota — uses plaintext byte length as an upfront approximation.
    // Production rows charge ciphertext bytes once stored (see engine impl);
    // benchmark rows charge plaintext bytes. Either way, this pre-check
    // protects against egregious oversize submissions.
    let text_bytes = text.as_bytes().len() as i64;
    rate_limit::check_storage_quota(&state, owner, text_bytes).await?;

    // Embed text — the engine will handle whatever persistence the
    // configured impl needs (encrypt+upload+insert, or plaintext insert).
    let vector = state.embedder.embed(text).await?;

    let memory_ref = state
        .engine
        .store(
            MemoryRecord {
                owner: owner.clone(),
                namespace: namespace.clone(),
                text: text.clone(),
                vector: vector.clone(),
            },
            &auth,
        )
        .await?;

    tracing::info!(
        "remember complete: blob_id={}, owner={}, ns={}, dims={}",
        memory_ref.blob_id,
        owner,
        namespace,
        vector.len()
    );

    Ok(Json(RememberResponse {
        id: memory_ref.id,
        blob_id: memory_ref.blob_id,
        owner: owner.clone(),
        namespace: namespace.clone(),
    }))
}

/// POST /api/remember/manual
///
/// Client-managed crypto path — the client has already done embed + SEAL
/// encrypt locally, and just wants the server to upload the ciphertext to
/// Walrus and index the vector. Structurally different from `remember`
/// (and the `MemoryEngine` abstraction): the engine owns crypto; this
/// endpoint is a pre-encrypted blob upload, not a memory persistence
/// flow. It bypasses the engine intentionally.
///
/// Not supported in benchmark mode (no Walrus to upload to). Returns
/// an error if invoked while `BENCHMARK_MODE=true`.
pub async fn remember_manual(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RememberManualRequest>,
) -> Result<Json<RememberManualResponse>, AppError> {
    if state.config.benchmark_mode {
        return Err(AppError::BadRequest(
            "/api/remember/manual is not supported in BENCHMARK_MODE (no Walrus uploads)".into(),
        ));
    }

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
        body.vector.len(),
        owner,
        namespace
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
    state
        .db
        .insert_vector(&id, owner, namespace, &blob_id, &body.vector, blob_size)
        .await?;

    tracing::info!(
        "remember_manual complete: id={}, blob_id={}, ns={}",
        id,
        blob_id,
        namespace
    );

    Ok(Json(RememberManualResponse {
        id,
        blob_id,
        owner: owner.clone(),
        namespace: namespace.clone(),
    }))
}
