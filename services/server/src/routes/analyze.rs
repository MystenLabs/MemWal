//! `/api/analyze` — AI fact extraction → store.
//!
//! Production path (default): extract facts via the Extractor service,
//! then per fact concurrently embed + SEAL-encrypt, quota-check the total
//! ciphertext, and enqueue one `UploadAndTransfer` WalletJob per fact —
//! returns HTTP 202 with `status: "pending"` and the per-fact job ids.
//!
//! Benchmark-mode bypass (BENCHMARK_MODE on; off by default, not for
//! production): per fact, embed → `engine.store_blob(plaintext bytes)`
//! synchronously (the `PlaintextEngine` writes the `plaintext` column — no
//! SEAL, no Walrus, no Sui tx, no job row). The response carries the real
//! stored ids and `status: "done"`, so the benchmark harness can treat
//! `/api/analyze` as synchronous the way the SDK's analyze contract did
//! before ENG-1406.

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use base64::Engine as _;
use std::sync::Arc;

use crate::jobs::WalletOperation;
use crate::rate_limit;
use crate::services::extractor::MAX_ANALYZE_FACTS;
use crate::types::*;

use super::{collect_bounded_results, enqueue_wallet_job};

const ANALYZE_CONCURRENCY: usize = 5;

// LOW-6: /api/analyze does not benefit from larger inputs — it sends the
// full text to gpt-4o-mini for fact extraction in a single LLM call (no
// chunking like remember). Cap it at the previous /api/remember ceiling
// so a hostile client cannot burn ~1 MiB of LLM tokens for the same
// rate-limit weight as a tiny request.
const MAX_ANALYZE_TEXT_BYTES: usize = 64 * 1024;

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
) -> Result<(StatusCode, Json<AnalyzeAcceptedResponse>), AppError> {
    if body.text.is_empty() {
        return Err(AppError::BadRequest("Text cannot be empty".into()));
    }
    // LOW-6: Reject oversize plaintext before spending an LLM call.
    if body.text.len() > MAX_ANALYZE_TEXT_BYTES {
        return Err(AppError::BadRequest(format!(
            "Text exceeds maximum length of {} bytes",
            MAX_ANALYZE_TEXT_BYTES
        )));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!(
        text_len = body.text.len(),
        owner = %owner,
        namespace = %namespace,
        "analyze request"
    );

    // Step 1: Extract facts using the Extractor service (sync — fast, ~1-2s)
    let extracted = state.extractor.extract(&body.text).await?;
    let raw_fact_count = extracted.raw_count;
    let facts = extracted.facts;
    let reserved_additional_weight = rate_limit::analyze_additional_weight(facts.len());
    tracing::info!(
        "  → Extracted {} facts (accepted={} cap={})",
        raw_fact_count,
        facts.len(),
        MAX_ANALYZE_FACTS,
    );

    if facts.is_empty() {
        return Ok((
            StatusCode::ACCEPTED,
            Json(AnalyzeAcceptedResponse {
                job_ids: vec![],
                facts: vec![],
                fact_count: 0,
                status: "pending".to_string(),
                owner: owner.clone(),
            }),
        ));
    }

    rate_limit::charge_explicit_weight(&state, &auth, reserved_additional_weight, "/api/analyze")
        .await?;

    // ── Benchmark-mode bypass: synchronous ingestion ──────────────────────
    //
    // The production path below is async (encrypt → enqueue WalletJob →
    // worker uploads to Walrus → insert_vector → SDK polls job_id). The
    // benchmark harness expects `POST /api/analyze` to return when the
    // memories are stored and searchable, the way the SDK's synchronous
    // analyze contract worked before ENG-1406. In benchmark mode we honour
    // that: per fact, embed → engine.store_blob(plaintext bytes) (the
    // PlaintextEngine writes the `plaintext` column — no SEAL, no Walrus,
    // no Sui transaction, no job row), in parallel across facts. The
    // response carries the real stored ids and status "done".
    //
    // Production behaviour is untouched — this branch only runs when
    // BENCHMARK_MODE is on (which is off by default and not for production).
    if state.config.benchmark_mode {
        // Quota check on plaintext byte length (benchmark mode has no
        // ciphertext — plaintext is the closest analog).
        let total_plaintext_bytes: i64 = facts.iter().map(|f| f.as_bytes().len() as i64).sum();
        rate_limit::check_storage_quota(&state, owner, total_plaintext_bytes).await?;

        let store_tasks: Vec<_> = facts
            .iter()
            .map(|fact_text| {
                let state = Arc::clone(&state);
                let owner = owner.clone();
                let namespace = namespace.clone();
                let agent_pk = auth.public_key.clone();
                let fact_text = fact_text.clone();
                async move {
                    let vector = state.embedder.embed(&fact_text).await?;
                    let mref = state
                        .engine
                        .store_blob(
                            &owner,
                            &namespace,
                            fact_text.as_bytes(),
                            &vector,
                            Some(&agent_pk),
                        )
                        .await?;
                    Ok::<_, AppError>(AnalyzeAcceptedFact {
                        text: fact_text,
                        id: mref.id.clone(),
                        job_id: mref.id,
                    })
                }
            })
            .collect();

        let store_results = collect_bounded_results(store_tasks, ANALYZE_CONCURRENCY).await;
        let mut stored_facts: Vec<AnalyzeAcceptedFact> = Vec::with_capacity(store_results.len());
        for r in store_results {
            stored_facts.push(r?);
        }

        let fact_count = stored_facts.len();
        let job_ids: Vec<String> = stored_facts.iter().map(|f| f.id.clone()).collect();
        tracing::info!(
            "analyze (benchmark mode) complete: {} facts stored synchronously owner={} ns={}",
            fact_count,
            owner,
            namespace
        );

        return Ok((
            StatusCode::ACCEPTED,
            Json(AnalyzeAcceptedResponse {
                job_ids,
                facts: stored_facts,
                fact_count,
                // "done" (not "pending") — the memories are stored and
                // searchable by the time this response is sent. "done"
                // matches the existing remember_jobs status vocabulary
                // ("done" = stored, blob_id known), rather than coining a
                // new term for the benchmark-only case.
                status: "done".to_string(),
                owner: owner.clone(),
            }),
        ));
    }

    // Step 2: embed + SEAL encrypt all facts concurrently (no wallet needed yet).
    // This is the fast part (~300-500ms), done in the request handler so:
    //   - No plaintext stored in job payload
    //   - Exact ciphertext size known for quota check
    let auth_pubkey_base = auth.public_key.clone();
    let prep_tasks: Vec<_> = facts
        .iter()
        .map(|fact_text| {
            let state = Arc::clone(&state);
            let owner = owner.clone();
            let fact_text = fact_text.clone();
            async move {
                let embed_fut = state.embedder.embed(&fact_text);
                let encrypt_fut = crate::storage::seal::seal_encrypt(
                    &state.http_client,
                    &state.config.sidecar_url,
                    state.config.sidecar_secret.as_deref(),
                    fact_text.as_bytes(),
                    &owner,
                    &state.config.package_id,
                );
                let (vector_result, encrypted_result) = tokio::join!(embed_fut, encrypt_fut);
                Ok::<_, AppError>((fact_text, vector_result?, encrypted_result?))
            }
        })
        .collect();

    let prep_results = collect_bounded_results(prep_tasks, ANALYZE_CONCURRENCY).await;

    // Quota check on total ciphertext size
    let mut prepared: Vec<(String, Vec<f32>, Vec<u8>)> = Vec::with_capacity(prep_results.len());
    let mut total_encrypted_bytes: i64 = 0;
    for r in prep_results {
        let (fact_text, vector, encrypted) = r?;
        total_encrypted_bytes += encrypted.len() as i64;
        prepared.push((fact_text, vector, encrypted));
    }
    rate_limit::check_storage_quota(&state, owner, total_encrypted_bytes).await?;

    // Step 3: For each prepared fact — insert remember_jobs row + enqueue WalletJob.
    // Round-robin across wallet pool so facts upload in parallel.
    let mut job_ids: Vec<String> = Vec::with_capacity(prepared.len());
    let mut accepted_facts: Vec<AnalyzeAcceptedFact> = Vec::with_capacity(prepared.len());
    for (fact_text, vector, encrypted) in prepared {
        let job_id = uuid::Uuid::new_v4().to_string();

        // Insert status row
        sqlx::query(
            "INSERT INTO remember_jobs (id, owner, namespace, status) VALUES ($1, $2, $3, 'pending')",
        )
        .bind(&job_id)
        .bind(owner)
        .bind(namespace)
        .execute(state.db.pool())
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create analyze job row: {}", e)))?;

        // Pick next wallet slot (round-robin) and enqueue UploadAndTransfer
        let wallet_index = state
            .key_pool
            .next_index()
            .ok_or_else(|| AppError::Internal("No Sui keys configured".into()))?;
        let encrypted_b64 = base64::engine::general_purpose::STANDARD.encode(&encrypted);

        enqueue_wallet_job(
            &state,
            wallet_index,
            WalletOperation::UploadAndTransfer {
                encrypted_b64,
                vector,
                owner: owner.clone(),
                namespace: namespace.clone(),
                package_id: state.config.package_id.clone(),
                agent_public_key: Some(auth_pubkey_base.clone()),
                remember_job_id: Some(job_id.clone()),
                epochs: 50,
            },
        )
        .await
        .map_err(|e| AppError::Internal(format!("Failed to enqueue analyze job: {}", e)))?;

        tracing::info!(
            job_id = %job_id,
            wallet_index,
            fact_len = fact_text.len(),
            "analyze fact enqueued"
        );
        accepted_facts.push(AnalyzeAcceptedFact {
            text: fact_text,
            id: job_id.clone(),
            job_id: job_id.clone(),
        });
        job_ids.push(job_id);
    }

    let fact_count = job_ids.len();
    tracing::info!(
        "analyze accepted: {} facts enqueued owner={} ns={}",
        fact_count,
        owner,
        namespace
    );

    Ok((
        StatusCode::ACCEPTED,
        Json(AnalyzeAcceptedResponse {
            job_ids,
            facts: accepted_facts,
            fact_count,
            status: "pending".to_string(),
            owner: owner.clone(),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::{ANALYZE_CONCURRENCY, MAX_ANALYZE_TEXT_BYTES};
    use crate::routes::remember::MAX_REMEMBER_TEXT_BYTES;
    use crate::services::extractor::MAX_ANALYZE_FACTS;

    // ── LOW-6: Text size limit ──────────────────────────────────────────

    #[test]
    fn max_analyze_text_bytes_is_64kb() {
        assert_eq!(MAX_ANALYZE_TEXT_BYTES, 64 * 1024);
    }

    #[test]
    fn analyze_text_strictly_smaller_than_remember() {
        // Analyze does fact extraction in a single LLM call without
        // chunking, so its ceiling must stay below remember's.
        assert!(MAX_ANALYZE_TEXT_BYTES < MAX_REMEMBER_TEXT_BYTES);
    }

    // ── HIGH-3 / MED-5: Analyze concurrency + weight ────────────────────

    #[test]
    fn analyze_concurrency_constant_is_5() {
        assert_eq!(ANALYZE_CONCURRENCY, 5);
    }

    #[test]
    fn max_analyze_facts_constant_is_20() {
        assert_eq!(MAX_ANALYZE_FACTS, 20);
    }

    #[test]
    fn analyze_weight_proportional_to_facts() {
        use crate::rate_limit::{analyze_additional_weight, analyze_total_weight};
        // No facts → only base weight
        assert_eq!(analyze_total_weight(0), 5);
        // Max facts (20) → 5 + 20 = 25
        assert_eq!(analyze_total_weight(20), 25);
        // Additional weight is exactly fact_count
        assert_eq!(analyze_additional_weight(0), 0);
        assert_eq!(analyze_additional_weight(20), 20);
    }
}
