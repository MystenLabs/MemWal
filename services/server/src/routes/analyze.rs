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

/// MEM-57: How many existing memories to pull as pre-extraction dedup
/// context for the extractor. Matches Mem0 v3's published pattern and the
/// default `recall_limit` the benchmark harness uses, so the dedup
/// context reflects what the user is most likely to ask about next.
///
/// Sized for the cost trade-off: each retrieved memory adds ~50-150ms
/// of latency (one extra `search_similar` + `fetch_batch` round-trip),
/// and roughly 50-100 tokens to the LLM input. K=10 keeps p95 latency
/// within the +50-150ms budget called out in the MEM-57 ticket.
const PRE_EXTRACTION_CONTEXT_LIMIT: usize = 10;

/// MEM-57 P0: per-leg timeouts on the pre-extraction context retrieval.
/// Set generously above measured p95 (embed ~150ms, search ~30ms warm /
/// 500ms cold, fetch ~50ms warm) so a healthy server is unaffected, but
/// tight enough to cap a stalled external dependency (OpenAI hiccup,
/// pgvector cold-namespace tail, sidecar 5xx). On expiry the leg's
/// fallback path fires — context goes empty, analyze continues. Total
/// pre-extraction worst case after timeouts: ~1.6s vs the observed
/// 30s benchmark outlier under no-timeout.
const EMBED_TIMEOUT_MS: u64 = 800;
const SEARCH_TIMEOUT_MS: u64 = 300;
const FETCH_TIMEOUT_MS: u64 = 500;

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

    // ── MEM-57: Pre-extraction dedup context (Mem0 v3 pattern) ────────
    //
    // Before the extractor LLM call, fetch the top-K nearest existing
    // memories for this input. The extractor sees them as
    // `<related_memories>` and uses the context to skip duplicates and
    // anchor borderline facts. This is the architectural fix for the
    // MEM-54 v3 LME `single_session_assistant` regression — gives the
    // LLM stronger signal for what is new vs already-known, so
    // borderline assistant content gets confidently extracted rather
    // than dropped under "be concise".
    //
    // Pre-extraction context is an *optimisation* — every recall-side
    // failure mode (embed, search, fetch) falls back to plain extraction
    // rather than failing the user's write. A user's write should not
    // depend on their own read working. Each per-leg failure logs a
    // `warn!` so production incidents are visible without breaking the
    // ingest path.
    //
    // Empty-namespace fast path (task #84): a cheap btree existence
    // check on `idx_vector_entries_owner_ns` skips the embed +
    // `search_similar` round-trip on first-ingest-into-a-namespace.
    // pgvector ≤0.7 HNSW with an `owner+namespace` filter does
    // post-filtering and can have a 100-500ms tail on cold namespaces
    // — the existence check eliminates that landmine, saves the embed
    // call ($, ~60-120ms p50), and degrades gracefully on its own
    // failure (treats "unknown" as "non-empty" → fall through to
    // full path, safer than skipping context erroneously).
    let pre_extract_t0 = std::time::Instant::now();
    let mut pre_extract_status = "ok";
    let mut pre_extract_embed_ms: u128 = 0;
    let mut pre_extract_search_ms: u128 = 0;
    let mut pre_extract_walrus_ms: u128 = 0;
    let mut pre_extract_seal_ms: u128 = 0;
    let mut pre_extract_dropped: usize = 0;

    let namespace_has_memories: bool = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM vector_entries WHERE owner = $1 AND namespace = $2 LIMIT 1",
    )
    .bind(owner)
    .bind(namespace)
    .fetch_optional(state.db.pool())
    .await
    .map(|r| r.is_some())
    .unwrap_or_else(|e| {
        tracing::warn!(
            error = %e,
            owner = %owner,
            namespace = %namespace,
            "analyze pre-extraction namespace-existence check failed; falling through to full path"
        );
        // Safer to *not* skip the recall when the existence check is
        // ambiguous — degrades to "task #83 behaviour", not "no context".
        true
    });

    let related_memories: Vec<crate::engine::HydratedMemory> = if !namespace_has_memories {
        pre_extract_status = "skipped_empty_namespace";
        Vec::new()
    } else {
        // Embed the input as a query. On embed failure, log + degrade —
        // do NOT propagate via `?`, even though the embed below uses the
        // same OpenAI endpoint as per-fact embeds (which DO propagate).
        // The distinction: per-fact embeds produce vectors that get
        // stored (data loss on failure); this one only feeds dedup
        // context (best-effort optimisation).
        // MEM-57 P0: each leg of the pre-extraction recall is wrapped in
        // a `tokio::time::timeout`. On expiry the corresponding status
        // (`embed_timeout`, `search_timeout`, `fetch_timeout`) is set
        // and the context falls back to empty — analyze continues with
        // plain extraction rather than blocking the user's write on a
        // stalled external dependency.
        let embed_t = std::time::Instant::now();
        let input_vector_opt = match tokio::time::timeout(
            std::time::Duration::from_millis(EMBED_TIMEOUT_MS),
            state.embedder.embed(&body.text),
        )
        .await
        {
            Ok(Ok(v)) => Some(v),
            Ok(Err(e)) => {
                tracing::warn!(
                    error = %e,
                    owner = %owner,
                    namespace = %namespace,
                    "analyze pre-extraction embed failed; falling back to plain extract"
                );
                pre_extract_status = "embed_failed";
                None
            }
            Err(_elapsed) => {
                tracing::warn!(
                    owner = %owner,
                    namespace = %namespace,
                    timeout_ms = EMBED_TIMEOUT_MS,
                    "analyze pre-extraction embed timed out; falling back to plain extract"
                );
                pre_extract_status = "embed_timeout";
                None
            }
        };
        pre_extract_embed_ms = embed_t.elapsed().as_millis();

        match input_vector_opt {
            None => Vec::new(),
            Some(input_vector) => {
                // Apply the blob-expiry filter here too: pre-extraction context
                // feeds the LLM, and surfacing a dead blob's row would either
                // waste a fetch on the 404 path or (worse) bias the extractor on
                // content that's about to vanish. Cached + fail-open.
                let current_epoch = super::recall::current_epoch_cached(&state).await;
                let search_t = std::time::Instant::now();
                let search_result = tokio::time::timeout(
                    std::time::Duration::from_millis(SEARCH_TIMEOUT_MS),
                    state.db.search_similar(
                        &input_vector,
                        owner,
                        namespace,
                        PRE_EXTRACTION_CONTEXT_LIMIT,
                        current_epoch,
                    ),
                )
                .await;
                pre_extract_search_ms = search_t.elapsed().as_millis();

                match search_result {
                    Ok(Ok(hits)) if hits.is_empty() => {
                        // Existence check said non-empty but search found
                        // 0 hits — possible if pgvector statistics are
                        // stale or the index hasn't caught up. Rare but
                        // not an error. Just no context this time.
                        Vec::new()
                    }
                    Ok(Ok(hits)) => {
                        let hit_refs: Vec<(String, f64)> = hits
                            .iter()
                            .map(|h| (h.blob_id.clone(), h.distance))
                            .collect();
                        // `fetch_batch` handles decrypt + cache + reactive
                        // cleanup on 404 / decrypt failure. Dropped hits
                        // just shrink the context; the extractor still
                        // works with whatever survives. On total failure
                        // (e.g. sidecar 5xx) or timeout, log and fall back.
                        match tokio::time::timeout(
                            std::time::Duration::from_millis(FETCH_TIMEOUT_MS),
                            state.engine.fetch_batch(owner, &hit_refs, &auth),
                        )
                        .await
                        {
                            Ok(Ok((hydrated, dropped, timings))) => {
                                pre_extract_walrus_ms = timings.walrus_ms;
                                pre_extract_seal_ms = timings.seal_ms;
                                pre_extract_dropped = dropped;
                                if dropped > 0 {
                                    // Some context memories failed to
                                    // decrypt — surface so we can see
                                    // mass-decrypt-rot in production.
                                    tracing::warn!(
                                        owner = %owner,
                                        namespace = %namespace,
                                        requested = hit_refs.len(),
                                        got = hydrated.len(),
                                        dropped,
                                        "analyze pre-extraction: some context memories dropped at decrypt"
                                    );
                                    pre_extract_status = "ok_with_dropped";
                                }
                                hydrated
                            }
                            Ok(Err(e)) => {
                                tracing::warn!(
                                    error = %e,
                                    owner = %owner,
                                    namespace = %namespace,
                                    "analyze pre-extraction fetch_batch failed; falling back to plain extract"
                                );
                                pre_extract_status = "fetch_failed";
                                Vec::new()
                            }
                            Err(_elapsed) => {
                                tracing::warn!(
                                    owner = %owner,
                                    namespace = %namespace,
                                    timeout_ms = FETCH_TIMEOUT_MS,
                                    "analyze pre-extraction fetch_batch timed out; falling back to plain extract"
                                );
                                pre_extract_status = "fetch_timeout";
                                Vec::new()
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(
                            error = %e,
                            owner = %owner,
                            namespace = %namespace,
                            "analyze pre-extraction search_similar failed; falling back to plain extract"
                        );
                        pre_extract_status = "search_failed";
                        Vec::new()
                    }
                    Err(_elapsed) => {
                        tracing::warn!(
                            owner = %owner,
                            namespace = %namespace,
                            timeout_ms = SEARCH_TIMEOUT_MS,
                            "analyze pre-extraction search_similar timed out; falling back to plain extract"
                        );
                        pre_extract_status = "search_timeout";
                        Vec::new()
                    }
                }
            }
        }
    };
    let related_texts: Vec<&str> = related_memories.iter().map(|m| m.text.as_str()).collect();
    let pre_extract_ms = pre_extract_t0.elapsed().as_millis();
    tracing::info!(
        owner = %owner,
        namespace = %namespace,
        related_count = related_texts.len(),
        requested = PRE_EXTRACTION_CONTEXT_LIMIT,
        dropped = pre_extract_dropped,
        pre_extract_ms = %pre_extract_ms,
        embed_ms = %pre_extract_embed_ms,
        search_ms = %pre_extract_search_ms,
        walrus_ms = %pre_extract_walrus_ms,
        seal_ms = %pre_extract_seal_ms,
        status = pre_extract_status,
        "analyze pre-extraction context retrieved"
    );

    // Step 1: Extract facts using the Extractor service (sync — fast, ~1-2s).
    // MEM-57: pass `related_memories` as dedup context. The LlmExtractor
    // short-circuits to plain `extract` on empty slice — no wasted tokens
    // when the namespace had no nearest hits.
    let extracted = state
        .extractor
        .extract_with_context(&body.text, &related_texts)
        .await?;
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
        let total_plaintext_bytes: i64 = facts.iter().map(|f| f.text.len() as i64).sum();
        rate_limit::check_storage_quota(&state, owner, total_plaintext_bytes).await?;

        let store_tasks: Vec<_> = facts
            .iter()
            .map(|fact| {
                let state = Arc::clone(&state);
                let owner = owner.clone();
                let namespace = namespace.clone();
                let agent_pk = auth.public_key.clone();
                let fact = fact.clone();
                async move {
                    let vector = state.embedder.embed(&fact.text).await?;
                    // MEM-54: importance is threaded through the engine
                    // (see store_blob signature in engine::MemoryEngine).
                    // The PlaintextEngine persists it on the new
                    // `vector_entries.importance` column; the ranker
                    // consumes it at recall time.
                    let mref = state
                        .engine
                        .store_blob(
                            &owner,
                            &namespace,
                            fact.text.as_bytes(),
                            &vector,
                            fact.importance,
                            Some(&agent_pk),
                        )
                        .await?;
                    Ok::<_, AppError>(AnalyzeAcceptedFact {
                        text: fact.text,
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
        .map(|fact| {
            let state = Arc::clone(&state);
            let owner = owner.clone();
            let fact = fact.clone();
            async move {
                let embed_fut = state.embedder.embed(&fact.text);
                let encrypt_fut = crate::storage::seal::seal_encrypt(
                    &state.http_client,
                    &state.config.sidecar_url,
                    state.config.sidecar_secret.as_deref(),
                    fact.text.as_bytes(),
                    &owner,
                    &state.config.package_id,
                );
                let (vector_result, encrypted_result) = tokio::join!(embed_fut, encrypt_fut);
                // MEM-54: carry `importance` through the prep tuple so
                // the job payload below can persist it alongside the
                // ciphertext + vector.
                Ok::<_, AppError>((
                    fact.text,
                    fact.importance,
                    vector_result?,
                    encrypted_result?,
                ))
            }
        })
        .collect();

    let prep_results = collect_bounded_results(prep_tasks, ANALYZE_CONCURRENCY).await;

    // Quota check on total ciphertext size
    let mut prepared: Vec<(String, f32, Vec<f32>, Vec<u8>)> =
        Vec::with_capacity(prep_results.len());
    let mut total_encrypted_bytes: i64 = 0;
    for r in prep_results {
        let (fact_text, importance, vector, encrypted) = r?;
        total_encrypted_bytes += encrypted.len() as i64;
        prepared.push((fact_text, importance, vector, encrypted));
    }
    rate_limit::check_storage_quota(&state, owner, total_encrypted_bytes).await?;

    // Step 3: For each prepared fact — insert remember_jobs row + enqueue WalletJob.
    // Round-robin across wallet pool so facts upload in parallel.
    let mut job_ids: Vec<String> = Vec::with_capacity(prepared.len());
    let mut accepted_facts: Vec<AnalyzeAcceptedFact> = Vec::with_capacity(prepared.len());
    for (fact_text, importance, vector, encrypted) in prepared {
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
                importance,
                owner: owner.clone(),
                namespace: namespace.clone(),
                package_id: state.config.package_id.clone(),
                agent_public_key: Some(auth_pubkey_base.clone()),
                remember_job_id: Some(job_id.clone()),
                epochs: state.config.walrus_storage_epochs,
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
