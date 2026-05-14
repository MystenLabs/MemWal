//! HTTP route handlers, split by endpoint family (ENG-1747 phase 4.2).
//!
//! Each submodule owns a related group of handlers:
//! - `remember` — `/api/remember`, `/api/remember/manual`, `/api/remember/bulk`
//!   (+ the async prep tasks and the summarize-for-embedding helpers)
//! - `recall` — `/api/recall`, `/api/recall/manual` (+ the recall-embedding cache)
//! - `analyze` — `/api/analyze` (fact extraction → store; sync bypass in benchmark mode)
//! - `admin` — `/api/ask`, `/api/forget`, `/api/stats`, `/api/restore`, `/health`, `/config`
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
pub use admin::{ask, forget, get_config, health, restore, stats};
pub use analyze::analyze;
pub use recall::{recall, recall_manual};
pub use remember::{
    remember, remember_bulk, remember_bulk_status, remember_manual, remember_status,
};
pub use sponsor::{sponsor_execute_proxy, sponsor_proxy};

use futures::stream::{self, StreamExt};

use crate::jobs::{WalletJob, WalletOperation};
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
        .push(WalletJob {
            wallet_index,
            operation,
        })
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
/// LOW-10: `owner` is required so the DELETE is scoped to the caller's rows.
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

#[cfg(test)]
mod tests {
    use super::{collect_bounded_results, truncate_str};
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
}
