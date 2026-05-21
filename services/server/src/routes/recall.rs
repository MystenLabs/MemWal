//! `/api/recall` + `/api/recall/manual` handlers, plus the recall
//! query-embedding cache (Redis, ENG-1405).
//!
//! `recall`: embed the query (cached) → vector search → hydrate the hits
//! through the storage engine (cache → Walrus → batched SEAL decrypt),
//! surfacing the count of dropped entries. `recall/manual`: client supplies
//! the query vector; the server returns `(blob_id, distance)[]` and the
//! client downloads + decrypts itself.

use axum::extract::State;
use axum::{Extension, Json};
use redis::AsyncCommands;
use sha2::Digest;
use std::sync::Arc;

use crate::types::*;

// ============================================================
// Recall query-embedding cache (Redis) — wraps the Embedder service
// ============================================================

fn recall_embedding_cache_key(config: &Config, query: &str) -> String {
    use crate::services::embedder::EMBEDDING_MODEL;
    let mut hasher = sha2::Sha256::new();
    hasher.update(config.openai_api_base.as_bytes());
    hasher.update(b"\0");
    hasher.update(EMBEDDING_MODEL.as_bytes());
    hasher.update(b"\0");
    hasher.update(query.as_bytes());
    format!("memwal:embedding:v1:{:x}", hasher.finalize())
}

/// Embed a recall query, with a Redis cache (ENG-1405) keyed on
/// api_base + model + query. Cache miss / disabled (ttl 0) falls through
/// to `state.embedder.embed`. Cache errors are best-effort (logged, ignored).
async fn generate_recall_embedding_cached(
    state: &AppState,
    query: &str,
) -> Result<Vec<f32>, AppError> {
    let ttl_secs = state.embedding_cache_ttl.as_secs();
    if ttl_secs == 0 {
        return state.embedder.embed(query).await;
    }

    let cache_key = recall_embedding_cache_key(&state.config, query);
    let mut redis = state.redis.clone();
    match redis.get::<_, Option<String>>(&cache_key).await {
        Ok(Some(payload)) => match serde_json::from_str::<Vec<f32>>(&payload) {
            Ok(vector) => return Ok(vector),
            Err(e) => tracing::warn!("embedding cache decode failed: {}", e),
        },
        Ok(None) => {}
        Err(e) => tracing::warn!("embedding cache get failed: {}", e),
    }

    let vector = state.embedder.embed(query).await?;
    match serde_json::to_string(&vector) {
        Ok(payload) => {
            let result: redis::RedisResult<()> = redis.set_ex(&cache_key, payload, ttl_secs).await;
            if let Err(e) = result {
                tracing::warn!("embedding cache set failed: {}", e);
            }
        }
        Err(e) => tracing::warn!("embedding cache encode failed: {}", e),
    }

    Ok(vector)
}

// ============================================================
// Handlers
// ============================================================

/// POST /api/recall
///
/// Full TEE flow:
/// 1. Verify auth (middleware) → get owner from delegate key onchain lookup
/// 2. Embed query → vector
/// 3. Search Vector DB → top-K {blobId}
/// 4. Download all blobs concurrently + SEAL decrypt each
/// 5. Return plaintext results
pub async fn recall(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RecallRequest>,
) -> Result<Json<RecallResponse>, AppError> {
    if body.query.is_empty() {
        return Err(AppError::BadRequest("Query cannot be empty".into()));
    }

    // Validate scoring_weights up front — fail fast on malformed input
    // (NaN, out-of-range, sub-floor half-life) BEFORE we spend an embed +
    // vector search + Walrus + SEAL round-trip just to 400 at the end.
    let weights = body.scoring_weights.clone().unwrap_or_default();
    weights.validate()?;

    // Owner is derived from delegate key via onchain verification (auth middleware)
    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!(
        query_len = body.query.len(),
        owner = %owner,
        namespace = %namespace,
        ranker_active = weights.is_ranker_active(),
        "recall request"
    );

    let t0 = std::time::Instant::now();
    let query_vector = generate_recall_embedding_cached(&state, &body.query).await?;
    let embed_ms = t0.elapsed().as_millis();

    // MED-3 fix: Cap limit to prevent unbounded DB scans / memory use.
    // Without this, an attacker could send limit=999999 to scan the entire DB.
    let limit = body.limit.min(100);
    let t1 = std::time::Instant::now();
    let hits = state
        .db
        .search_similar(&query_vector, owner, namespace, limit)
        .await?;
    let vsearch_ms = t1.elapsed().as_millis();
    let hit_count = hits.len();

    if hits.is_empty() {
        tracing::info!(
            "recall complete: 0 results (no vector hits) for owner={}",
            owner
        );
        return Ok(Json(RecallResponse {
            results: vec![],
            total: 0,
            dropped_count: 0,
        }));
    }

    // Hydrate the hits through the storage engine: blob cache -> Walrus
    // download -> batched SEAL decrypt -> UTF-8, with reactive cleanup on
    // Walrus 404 / permanent decrypt failure. The engine owns the
    // cache/decrypt-batch internals and derives the SEAL credential from
    // `auth`; per-blob timing breakdowns are visible in its tracing spans.
    let t2 = std::time::Instant::now();
    let hit_refs: Vec<(String, f64)> = hits
        .iter()
        .map(|h| (h.blob_id.clone(), h.distance))
        .collect();
    let (mut hydrated, dropped_count, timings) =
        state.engine.fetch_batch(owner, &hit_refs, &auth).await?;
    let fetch_ms = t2.elapsed().as_millis();

    // Zip `created_at` (recency signal) + `importance` (MEM-54) from the
    // SearchHits onto the HydratedMemory records so the ranker has both
    // signals it needs. Engines leave both fields as `None`; the recall
    // path populates them from the SearchHit it already has. See
    // `routes::zip_search_hit_fields_onto_hydrated`.
    super::zip_search_hit_fields_onto_hydrated(&mut hydrated, &hits);

    // Log when the ranker is opted in (non-default `scoring_weights`) so a
    // future "client X is seeing weird ordering" debugging session has a
    // breadcrumb. Default weights short-circuit and aren't logged — that's
    // every other request.
    if weights.is_ranker_active() {
        tracing::info!(
            owner = %owner,
            semantic = weights.semantic,
            recency = weights.recency,
            half_life_days = weights.recency_half_life_days,
            // MEM-54: include the importance weight in the breadcrumb so
            // ordering bug reports can be triaged against the full vector
            // of weights the client sent.
            importance = weights.importance,
            "recall: ranker active"
        );
    }

    // Composite re-rank. With default weights (semantic=1.0, recency=0.0)
    // this is a no-op and preserves the pgvector cosine order exactly —
    // pinned by the `default_weights_preserve_input_order` and
    // `recency_zero_is_short_circuit_no_reorder` tests in services::ranker.
    let ranked = state.ranker.rank(hydrated, &weights, chrono::Utc::now());

    let results: Vec<RecallResult> = ranked
        .into_iter()
        .map(|r| RecallResult {
            blob_id: r.memory.blob_id,
            text: r.memory.text,
            distance: r.memory.distance,
            // `score` is `Some` only when the ranker ran (recency > 0); the
            // `#[serde(skip_serializing_if = "Option::is_none")]` on the
            // type omits the field from the wire when default-weighted.
            score: r.score,
        })
        .collect();
    let total = results.len();

    // LOW-7: Surface the count of silently-dropped entries (download /
    // decrypt / UTF-8 failures) so clients can distinguish "no matches"
    // from "matches we couldn't return". Per-item errors are logged with
    // the blob_id inside the engine.
    if dropped_count > 0 {
        tracing::warn!(
            "recall: {} of {} matches dropped due to download/decrypt errors (owner={})",
            dropped_count,
            hit_count,
            owner
        );
    }
    // Per-stage `walrus=Xms seal=Xms` keeps parity with the pre-refactor
    // log line that combined the two stages into `fetch=Xms`. Benchmark
    // mode reports the entire Postgres-select fetch as `walrus_ms` and
    // leaves `seal_ms` at 0 — same shape, different mode.
    tracing::info!(
        "recall complete: {} results for owner={} embed={}ms vsearch={}ms walrus={}ms seal={}ms fetch={}ms total={}ms",
        total,
        owner,
        embed_ms,
        vsearch_ms,
        timings.walrus_ms,
        timings.seal_ms,
        fetch_ms,
        t0.elapsed().as_millis()
    );

    Ok(Json(RecallResponse {
        results,
        total,
        dropped_count,
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
        body.vector.len(),
        body.limit,
        owner,
        namespace
    );

    // Search Vector DB — return blob IDs + distances only
    // MED-3 fix: Cap limit on recall_manual as well
    let limit = body.limit.min(100);
    let hits = state
        .db
        .search_similar(&body.vector, owner, namespace, limit)
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

#[cfg(test)]
mod tests {
    // ── MED-3: Recall limit capped at 100 ───────────────────────────────

    #[test]
    fn recall_limit_capped_at_100() {
        fn cap_limit(limit: usize) -> usize {
            limit.min(100)
        }

        assert_eq!(cap_limit(999999), 100);
        assert_eq!(cap_limit(100), 100);
        assert_eq!(cap_limit(50), 50);
        assert_eq!(cap_limit(1), 1);
        assert_eq!(cap_limit(0), 0);
    }

    // ── LOW-7: RecallResponse dropped_count serialization ───────────────

    #[test]
    fn recall_response_includes_dropped_count_when_nonzero() {
        let resp = crate::types::RecallResponse {
            results: vec![],
            total: 0,
            dropped_count: 3,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["dropped_count"], 3);
    }

    #[test]
    fn recall_response_omits_dropped_count_when_zero() {
        let resp = crate::types::RecallResponse {
            results: vec![],
            total: 0,
            dropped_count: 0,
        };
        let json = serde_json::to_value(&resp).unwrap();
        // skip_serializing_if = "is_zero_usize" → field absent
        assert!(json.get("dropped_count").is_none());
    }
}
