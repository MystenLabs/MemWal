//! POST /api/analyze handler — LLM-driven fact extraction + ingestion.
//!
//! Extraction now lives in `crate::services::extractor`. The handler
//! orchestrates: extractor → embedder + SEAL encrypt (parallel) → Walrus
//! upload → DB insert (per fact). The extraction prompt itself is still an
//! inline `const` inside `services/extractor.rs`; it moves to a versioned
//! text asset under `services/prompts/extract.txt` in Phase 3.

use axum::{extract::State, Extension, Json};
use std::sync::Arc;

use crate::rate_limit;
use crate::storage::{seal, walrus};
use crate::types::*;

use super::truncate_str;

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
    let facts = state.extractor.extract(&body.text).await?;
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
            let embed_fut = state.embedder.embed(&fact_text);
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
