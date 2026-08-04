//! `GET /api/accounts/:owner/exists` — MemWalAccount existence check.
//!
//! Backs WALM-298's "MemWalAccount existence-check primitive" acceptance
//! criterion for the Console team's backend: given a Sui address, tells the
//! caller whether that address owns a MemWalAccount, without requiring
//! Console to hold a delegate key or run its own onchain scan.

use axum::extract::{Path, State};
use axum::Json;
use std::sync::Arc;

use crate::routes::sponsor::validate_sui_address;
use crate::types::*;

/// GET /api/accounts/:owner/exists
///
/// Public, unauthenticated by design: the underlying `AccountRegistry` is
/// itself a public onchain Sui object, so anyone can already determine
/// whether an address owns a MemWalAccount via a direct RPC scan (see
/// docs/indexer/purpose.md's "onchain registry scan" fallback). This
/// endpoint is a convenience/performance wrapper around the indexer's
/// already-public data (populated from onchain `AccountCreated` events),
/// not a new information disclosure — so it deliberately does not require
/// Console-specific auth. Do not add auth here without re-checking that
/// reasoning first.
///
/// Response is intentionally minimal (`{ "exists": bool }`): the internal
/// `account_id` is not returned, since Console doesn't need it per
/// WALM-298's acceptance criteria and leaking it would needlessly widen
/// the API's surface for future churn.
pub async fn account_exists(
    State(state): State<Arc<AppState>>,
    Path(owner): Path<String>,
) -> Result<Json<AccountExistsResponse>, AppError> {
    // Reject malformed input before the DB call rather than silently
    // returning `exists: false` for garbage — matches `validate_sui_address`
    // usage in `routes::sponsor`, the codebase's existing Sui-address check.
    if !validate_sui_address(&owner) {
        return Err(AppError::BadRequest(
            "owner must be a 0x-prefixed 32-byte Sui address (66 characters)".into(),
        ));
    }

    let exists = state.db.find_account_by_owner(&owner).await?.is_some();
    Ok(Json(AccountExistsResponse { exists }))
}
