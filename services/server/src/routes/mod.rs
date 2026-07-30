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
pub mod security_delete;
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

/// Temporary response for every endpoint that can create a new Walrus memory.
///
/// Keep this at the routing boundary so paused requests cannot start request
/// validation, extraction, database writes, or background upload jobs.
pub const UPLOADS_PAUSED_MESSAGE: &str =
    "New uploads to Walrus Memory are paused while we conduct a security upgrade";

pub async fn uploads_paused() -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        axum::Json(serde_json::json!({ "error": UPLOADS_PAUSED_MESSAGE })),
    )
}

/// Reject a namespace whose byte length exceeds `max_bytes` before any paid
/// work (embed / encrypt / upload) runs.
///
/// `vector_entries` carries a composite B-tree index on `(owner, namespace)`;
/// a namespace past the index-entry byte limit makes the final insert fail
/// *after* the memory was already embedded, encrypted, and uploaded — so the
/// request must be rejected up front, at every write handler, not discovered
/// downstream. The bound is a byte count (`len()` on a `str` is UTF-8 bytes),
/// matching the on-disk index-row constraint. `max_bytes` is caller-supplied
/// (`config.max_namespace_bytes`) so the cap has a single source of truth.
///
/// Length only: the namespace reaches storage exclusively as a bound SQL
/// parameter, so there is no injection surface a character check would close.
/// An empty namespace has length 0 and passes (handlers treat empty as the
/// default namespace).
pub fn validate_namespace(namespace: &str, max_bytes: usize) -> Result<(), AppError> {
    if namespace.len() > max_bytes {
        return Err(AppError::BadRequest(format!(
            "namespace exceeds maximum length of {} bytes",
            max_bytes
        )));
    }
    Ok(())
}

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
            congestion_requeues: 0,
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

#[cfg(test)]
mod uploads_paused_tests {
    use super::*;

    #[tokio::test]
    async fn returns_security_upgrade_message_with_service_unavailable_status() {
        let (status, axum::Json(body)) = uploads_paused().await;

        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            serde_json::json!({
                "error": "New uploads to Walrus Memory are paused while we conduct a security upgrade"
            })
        );
    }
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

#[cfg(test)]
mod tests {
    use super::{collect_bounded_results, truncate_str, validate_namespace};
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
    fn validate_namespace_accepts_at_and_below_cap() {
        // Exactly the cap passes (boundary); below passes; empty passes.
        assert!(validate_namespace("", 512).is_ok());
        assert!(validate_namespace("default", 512).is_ok());
        assert!(validate_namespace(&"a".repeat(512), 512).is_ok());
    }

    #[test]
    fn validate_namespace_rejects_over_cap() {
        // cap+1 fails (off-by-one guard); a pathological namespace fails hard.
        assert!(validate_namespace(&"a".repeat(513), 512).is_err());
        assert!(validate_namespace(&"x".repeat(2 * 1024 * 1024), 512).is_err());
    }

    #[test]
    fn validate_namespace_allows_real_data_characters() {
        // Real production namespaces use `:` (timestamps), `@`, space, `#`.
        // There is no charset check, so these must all pass under the cap.
        for ns in [
            "2026-07-30T12:34:56Z",
            "user@example.com",
            "some namespace with spaces",
            "tag#1",
        ] {
            assert!(
                validate_namespace(ns, 512).is_ok(),
                "expected ok for real-data namespace: {ns}"
            );
        }
    }

    #[test]
    fn validate_namespace_counts_bytes_not_chars() {
        // The cap is a byte bound (matches the on-disk index-row limit), so a
        // multi-byte namespace is measured in UTF-8 bytes: "é" is 2 bytes.
        let ns = "é".repeat(300); // 600 bytes, 300 chars
        assert_eq!(ns.len(), 600);
        assert!(validate_namespace(&ns, 512).is_err()); // 600 > 512
        assert!(validate_namespace(&ns, 700).is_ok()); // 600 <= 700
    }
}
