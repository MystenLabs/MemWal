//! HTTP route handlers, split by endpoint family.
//!
//! Each submodule owns a related group of handlers. Shared route-level
//! helpers (`truncate_str`, `cleanup_expired_blob`) live here in `mod.rs`.
//! Capability-level code (embedding, extraction, OpenAI chat types) has
//! moved into `crate::services` per the Phase 2 refactor.

mod admin;
mod analyze;
mod recall;
mod remember;
mod sponsor;

// Re-export every handler so `main.rs` keeps using `routes::<name>`
// without having to know which submodule each handler lives in.
pub use admin::{ask, health, restore};
pub use analyze::analyze;
pub use recall::{recall, recall_manual};
pub use remember::{remember, remember_manual};
pub use sponsor::{sponsor_execute_proxy, sponsor_proxy};

use crate::storage::db::VectorDb;

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
// Reactive blob cleanup
// ============================================================

/// Reactively delete an expired blob from the vector DB.
/// Called when Walrus returns 404 (blob expired / not found).
/// Errors are logged but not propagated — cleanup is best-effort.
pub(super) async fn cleanup_expired_blob(db: &VectorDb, blob_id: &str) {
    match db.delete_by_blob_id(blob_id).await {
        Ok(rows) => {
            tracing::info!(
                "reactive cleanup: deleted {} vector entries for expired blob_id={}",
                rows, blob_id
            );
        }
        Err(e) => {
            tracing::error!(
                "reactive cleanup failed for blob_id={}: {}",
                blob_id, e
            );
        }
    }
}
