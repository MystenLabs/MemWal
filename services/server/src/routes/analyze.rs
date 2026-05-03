//! POST /api/analyze handler — LLM-driven fact extraction + ingestion.
//!
//! Extraction lives in `crate::services::extractor`. Persistence lives in
//! `crate::engine`. The handler orchestrates: extractor → per-fact (embed
//! + engine.store, in parallel across facts).

use axum::{extract::State, Extension, Json};
use std::sync::Arc;

use crate::engine::MemoryRecord;
use crate::rate_limit;
use crate::types::*;

use super::truncate_str;

/// POST /api/analyze
///
/// AI fact extraction flow:
/// 1. Verify auth (middleware) → get owner
/// 2. Call LLM to extract memorable facts from text
/// 3. For each fact concurrently: embed + engine.store
///    (engine.store handles SEAL encrypt + Walrus upload + DB insert
///    in production; plaintext + DB insert in benchmark mode)
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
    tracing::info!(
        "analyze: text=\"{}...\" owner={} ns={}",
        truncate_str(&body.text, 50),
        owner,
        namespace
    );

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

    // Step 2: Per-fact fan-out. Each fact: embed → engine.store.
    // Engine.store does its own internal parallelism for SEAL+upload
    // (production); benchmark engine is just a DB INSERT. Across facts,
    // we still parallelise via join_all so multiple facts ingest at once.
    let tasks: Vec<_> = facts
        .iter()
        .map(|fact_text| {
            let state = Arc::clone(&state);
            let owner = owner.clone();
            let namespace = namespace.clone();
            let auth = auth.clone();
            let fact_text = fact_text.clone();
            async move {
                let vector = state.embedder.embed(&fact_text).await?;

                let memory_ref = state
                    .engine
                    .store(
                        MemoryRecord {
                            owner: owner.clone(),
                            namespace: namespace.clone(),
                            text: fact_text.clone(),
                            vector,
                        },
                        &auth,
                    )
                    .await?;

                Ok::<AnalyzedFact, AppError>(AnalyzedFact {
                    text: fact_text,
                    id: memory_ref.id,
                    blob_id: memory_ref.blob_id,
                })
            }
        })
        .collect();

    let results = futures::future::join_all(tasks).await;

    // Collect successes, fail on first error (same semantics as pre-refactor)
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
