//! POST /api/recall and POST /api/recall/manual handlers.

use axum::{extract::State, Extension, Json};
use std::sync::Arc;

use crate::engine::HydratedMemory;
use crate::types::*;

use super::truncate_str;

/// POST /api/recall
///
/// Flow (engine-mediated for fetch):
/// 1. Verify auth (middleware) → owner derived from delegate key
/// 2. Embed query → vector
/// 3. Search Vector DB → top-K SearchHit { blob_id, distance }
/// 4. Concurrently call `engine.fetch_one(blob_id, distance, &auth)` per hit
///    — production engine downloads + SEAL decrypts; benchmark engine
///    reads plaintext directly from Postgres
/// 5. Filter out None hits (expired blobs, decrypt failures), return the rest
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
    tracing::info!(
        "recall: query=\"{}...\" owner={} ns={}",
        truncate_str(&body.query, 50),
        owner,
        namespace
    );

    // Step 1: Embed query → vector
    let query_vector = state.embedder.embed(&body.query).await?;

    // Step 2: Search Vector DB (returns blob_ids + distances; no plaintext)
    let hits = state
        .db
        .search_similar(&query_vector, owner, namespace, body.limit)
        .await?;

    // Step 3: Hydrate each hit through the engine, in parallel.
    // The engine returns Option<HydratedMemory> per hit — None means the
    // blob expired or decrypt failed (already logged + cleaned up
    // internally by the engine's reactive cleanup).
    let tasks: Vec<_> = hits
        .iter()
        .map(|hit| {
            let engine = Arc::clone(&state.engine);
            let auth = auth.clone();
            let blob_id = hit.blob_id.clone();
            let distance = hit.distance;
            async move {
                match engine.fetch_one(&blob_id, distance, &auth).await {
                    Ok(opt) => opt,
                    Err(e) => {
                        tracing::warn!("recall fetch failed for {}: {}", blob_id, e);
                        None
                    }
                }
            }
        })
        .collect();

    let hydrated: Vec<HydratedMemory> = futures::future::join_all(tasks)
        .await
        .into_iter()
        .flatten()
        .collect();

    let total = hydrated.len();
    tracing::info!("recall complete: {} results for owner={}", total, owner);

    let results: Vec<RecallResult> = hydrated
        .into_iter()
        .map(|h| RecallResult {
            blob_id: h.blob_id,
            text: h.text,
            distance: h.distance,
        })
        .collect();

    Ok(Json(RecallResponse { results, total }))
}

/// POST /api/recall/manual
///
/// Manual flow — user provides pre-computed query vector.
/// Server searches Vector DB and returns {blob_id, distance}[].
/// User downloads from Walrus + SEAL decrypts on their own.
///
/// Bypasses the engine intentionally: the manual contract is "search
/// only, client fetches" — there's no server-side fetch step to abstract.
pub async fn recall_manual(
    State(state): State<Arc<AppState>>,
    Extension(_auth): Extension<AuthInfo>,
    Json(body): Json<RecallManualRequest>,
) -> Result<Json<RecallManualResponse>, AppError> {
    if body.vector.is_empty() {
        return Err(AppError::BadRequest("vector cannot be empty".into()));
    }

    let owner = &_auth.owner;
    let namespace = &body.namespace;
    tracing::info!(
        "recall_manual: vector_dims={} limit={} owner={} ns={}",
        body.vector.len(),
        body.limit,
        owner,
        namespace
    );

    // Search Vector DB — return blob IDs + distances only
    let hits = state
        .db
        .search_similar(&body.vector, owner, namespace, body.limit)
        .await?;
    let total = hits.len();

    tracing::info!(
        "recall_manual complete: {} results for owner={} ns={}",
        total,
        owner,
        namespace
    );

    Ok(Json(RecallManualResponse {
        results: hits,
        total,
    }))
}
