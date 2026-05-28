//! HTTP route handlers, split by endpoint family (phase 4.2).
//!
//! Each submodule owns a related group of handlers:
//! - `remember` — `/api/remember`, `/api/remember/manual`, `/api/remember/bulk`
//!   (+ the async prep tasks and the summarize-for-embedding helpers)
//! - `recall` — `/api/recall`, `/api/recall/manual` (+ the recall-embedding cache)
//! - `analyze` — `/api/analyze` (fact extraction → store; sync bypass in benchmark mode)
//! - `admin` — `/api/ask`, `/api/forget`, `/api/stats`, `/api/restore`,
//!   `/health`, `/version`, `/config`
//! - `sponsor` — `/sponsor`, `/sponsor/execute` (Enoki proxy)
//!
//! Shared route-level helpers (`enqueue_wallet_job`, `truncate_str`,
//! `collect_bounded_results`, `cleanup_expired_blob`) live here in `mod.rs`.
//! Capability-level code (embedding, extraction, OpenAI chat wire types,
//! prompt assets) lives in `crate::services` per the Phase 2/3 refactor.

mod admin;
mod analyze;
mod recall;
mod remember;
mod sponsor;

// Re-export every handler so `main.rs` keeps using `routes::<name>`
// without having to know which submodule each handler lives in.
pub use admin::{ask, forget, get_config, health, restore, stats, version};
pub use analyze::analyze;
pub use recall::{recall, recall_manual};
pub use remember::{
    remember, remember_bulk, remember_bulk_status, remember_manual, remember_status,
};
pub use sponsor::{sponsor_execute_proxy, sponsor_proxy};

use futures::stream::{self, StreamExt};

use crate::jobs::{wallet_job_request, WalletJob, WalletOperation};
use crate::storage::db::VectorDb;
use crate::types::*;

use apalis::prelude::Storage as _;

// ============================================================
// Wallet-job enqueue (used by remember + analyze)
// ============================================================

/// Enqueue a WalletJob to the single Apalis wallet queue.
///
/// `wallet_index` is preserved in the job payload for audit/logging. Upload
/// workers select a fresh round-robin key at execution time so Apalis retries
/// can move to another wallet.
pub async fn enqueue_wallet_job(
    state: &AppState,
    wallet_index: usize,
    operation: WalletOperation,
) -> Result<usize, AppError> {
    let mut storage = state.wallet_storage.clone();
    storage
        .push_request(wallet_job_request(WalletJob {
            wallet_index,
            operation,
        }))
        .await
        .map_err(|e| AppError::Internal(format!("Failed to enqueue WalletJob: {}", e)))?;
    Ok(wallet_index)
}

// ============================================================
// String truncation helper (used in several `tracing::info!` lines)
// ============================================================

/// Truncate a string to at most `max_bytes` bytes without splitting a UTF-8
/// character.  Falls back to the nearest char boundary when `max_bytes` lands
/// inside a multi-byte sequence (e.g. emoji).
#[cfg(test)]
pub(super) fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ============================================================
// Bounded-concurrency task collection
// ============================================================

/// Run `tasks` with at most `concurrency` in flight, returning their
/// results in the original order.
pub(super) async fn collect_bounded_results<F, T, E>(
    tasks: Vec<F>,
    concurrency: usize,
) -> Vec<Result<T, E>>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    let mut indexed_results = stream::iter(tasks)
        .enumerate()
        .map(|(idx, task)| async move { (idx, task.await) })
        .buffer_unordered(concurrency)
        .collect::<Vec<_>>()
        .await;
    indexed_results.sort_by_key(|(idx, _)| *idx);
    indexed_results
        .into_iter()
        .map(|(_, result)| result)
        .collect()
}

// ============================================================
// Reactive expired-blob cleanup
// ============================================================

/// Reactively delete an expired blob from the vector DB.
/// Called when Walrus returns 404 (blob expired / not found).
/// Errors are logged but not propagated — cleanup is best-effort.
///
/// `owner` is required so the DELETE is scoped to the caller's rows.
/// The DB layer enforces `WHERE blob_id = $1 AND owner = $2`, so an expired
/// blob discovered via one user's recall cannot delete another user's entry
/// even if blob_ids collided.
pub(super) async fn cleanup_expired_blob(db: &VectorDb, blob_id: &str, owner: &str) {
    match db.delete_by_blob_id(blob_id, owner).await {
        Ok(rows) => {
            tracing::info!(
                "reactive cleanup: deleted {} vector entries for expired blob_id={} owner={}",
                rows,
                blob_id,
                owner
            );
        }
        Err(e) => {
            tracing::error!(
                "reactive cleanup failed for blob_id={} owner={}: {}",
                blob_id,
                owner,
                e
            );
        }
    }
}

// ============================================================
// Ranker plumbing — zip created_at + importance from SearchHits onto
// HydratedMemory
// ============================================================

/// Zip the `created_at` timestamp **and** the `importance` score
/// from a slice of `SearchHit`s onto a mutable slice of `HydratedMemory`s
/// by `blob_id`. The storage engines deliberately leave both fields as
/// `None` (they don't fetch them as part of the cache → Walrus → SEAL
/// choreography); the recall handler already has both on the `SearchHit`
/// from `db.search_similar` and threads them onto the hydrated records
/// here so the composite ranker can use them for the recency / importance
/// signals.
///
/// Same pattern is used by both `/api/recall` and `/api/ask` — extracting
/// it here keeps the two call sites in sync.
///
/// Renamed from `zip_created_at_onto_hydrated` in once importance
/// joined the zip. Single function (rather than two separate ones) because
/// both fields come from the same `SearchHit` and we don't want to walk
/// the hits vector twice for what's a hot path.
pub(super) fn zip_search_hit_fields_onto_hydrated(
    hydrated: &mut [crate::engine::HydratedMemory],
    hits: &[SearchHit],
) {
    let by_blob: std::collections::HashMap<&str, (chrono::DateTime<chrono::Utc>, f32)> = hits
        .iter()
        .map(|h| (h.blob_id.as_str(), (h.created_at, h.importance)))
        .collect();
    for m in hydrated.iter_mut() {
        if let Some((ts, imp)) = by_blob.get(m.blob_id.as_str()).copied() {
            m.created_at = Some(ts);
            m.importance = Some(imp);
        } else {
            m.created_at = None;
            m.importance = None;
        }
    }
}

// ============================================================
// Adaptive recall-k
// ============================================================

pub(super) struct ResolvedRecallLimit {
    pub limit: usize,
    pub hint: Option<RecallLimitHint>,
}

/// Resolve the effective recall limit for a query.
///
/// Default behavior is intentionally unchanged: when neither `adaptive_k` nor
/// `limit_hint` is present, the caller's requested limit is only capped at 100.
/// Adaptive behavior is opt-in and bounded, so a bad classification cannot
/// scan an unbounded namespace.
pub(super) fn resolve_recall_limit(
    query: &str,
    requested_limit: usize,
    adaptive_k: bool,
    limit_hint: Option<RecallLimitHint>,
) -> ResolvedRecallLimit {
    const MAX_LIMIT: usize = 100;
    const LOOKUP_LIMIT: usize = 5;
    const COMPOSITION_LIMIT: usize = 20;
    const SURVEY_LIMIT: usize = 25;

    let requested = requested_limit.min(MAX_LIMIT);
    let hint = limit_hint.or_else(|| adaptive_k.then(|| classify_recall_intent(query)));

    let limit = match hint {
        None | Some(RecallLimitHint::Standard) => requested,
        Some(RecallLimitHint::Lookup) => LOOKUP_LIMIT.min(MAX_LIMIT),
        Some(RecallLimitHint::Composition) => requested.max(COMPOSITION_LIMIT).min(MAX_LIMIT),
        Some(RecallLimitHint::Survey) => requested.max(SURVEY_LIMIT).min(MAX_LIMIT),
    };

    ResolvedRecallLimit { limit, hint }
}

fn classify_recall_intent(query: &str) -> RecallLimitHint {
    let q = query.to_ascii_lowercase();
    let words = q.split_whitespace().count();

    let has_any = |needles: &[&str]| needles.iter().any(|needle| q.contains(needle));

    if has_any(&[
        "everything",
        "all ",
        "list ",
        "overview",
        "summarize",
        "summary",
        "what do you know",
        "tell me about",
    ]) {
        return RecallLimitHint::Survey;
    }

    if has_any(&[
        "compare",
        "relationship",
        "after ",
        "before ",
        "between",
        "given ",
        "based on",
        "how did",
        "why did",
        "what changed",
        "timeline",
    ]) || q.matches(" and ").count() >= 2
    {
        return RecallLimitHint::Composition;
    }

    if words <= 10
        && has_any(&[
            "what is",
            "what's",
            "where is",
            "where did",
            "who is",
            "when is",
            "when did",
            "name",
            "favorite",
            "favourite",
        ])
    {
        return RecallLimitHint::Lookup;
    }

    RecallLimitHint::Standard
}

#[cfg(test)]
mod tests {
    use super::{collect_bounded_results, resolve_recall_limit, truncate_str};
    use crate::types::RecallLimitHint;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn bounded_collection_limits_concurrency() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let tasks: Vec<_> = (0..12)
            .map(|_| {
                let active = Arc::clone(&active);
                let peak = Arc::clone(&peak);
                async move {
                    let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now_active, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok::<usize, ()>(now_active)
                }
            })
            .collect();

        let results = collect_bounded_results(tasks, 5).await;
        assert_eq!(results.len(), 12);
        assert!(peak.load(Ordering::SeqCst) <= 5);
    }

    #[test]
    fn truncate_str_ascii() {
        assert_eq!(truncate_str("hello world", 5), "hello");
    }

    #[test]
    fn truncate_str_no_truncation_needed() {
        assert_eq!(truncate_str("hi", 100), "hi");
    }

    #[test]
    fn truncate_str_empty() {
        assert_eq!(truncate_str("", 10), "");
    }

    #[test]
    fn truncate_str_multibyte_char_boundary() {
        // "café" = 5 bytes (é = 2 bytes). Truncating at 4 bytes → "caf" (not mid-é)
        let s = "café";
        assert_eq!(s.len(), 5); // c=1, a=1, f=1, é=2
        let t = truncate_str(s, 4);
        assert_eq!(t, "caf"); // stops before the 2-byte é
    }

    #[test]
    fn truncate_str_emoji_boundary() {
        // "🦀hello" = 4 + 5 = 9 bytes. Truncating at 2 → "" (can't split 🦀)
        let s = "🦀hello";
        let t = truncate_str(s, 2);
        assert_eq!(t, ""); // can't include partial emoji
    }

    #[test]
    fn recall_limit_static_default_preserved() {
        let resolved = resolve_recall_limit("What is my name?", 10, false, None);
        assert_eq!(resolved.limit, 10);
        assert_eq!(resolved.hint, None);
    }

    #[test]
    fn recall_limit_hint_maps_to_bounded_k() {
        let lookup =
            resolve_recall_limit("What is my name?", 10, false, Some(RecallLimitHint::Lookup));
        assert_eq!(lookup.limit, 5);
        assert_eq!(lookup.hint, Some(RecallLimitHint::Lookup));

        let composition = resolve_recall_limit(
            "What changed after the move?",
            10,
            false,
            Some(RecallLimitHint::Composition),
        );
        assert_eq!(composition.limit, 20);
        assert_eq!(composition.hint, Some(RecallLimitHint::Composition));
    }

    #[test]
    fn recall_limit_adaptive_classifies_survey() {
        let resolved = resolve_recall_limit(
            "Tell me about everything you know about my work",
            10,
            true,
            None,
        );
        assert_eq!(resolved.limit, 25);
        assert_eq!(resolved.hint, Some(RecallLimitHint::Survey));
    }
}
