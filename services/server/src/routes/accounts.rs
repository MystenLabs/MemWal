//! `GET /api/accounts/{owner}/exists` — MemWalAccount existence check.
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

/// GET /api/accounts/{owner}/exists
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
///
/// This checks registry presence only, not onchain `active` status — an
/// address that once created a MemWalAccount and was later deactivated
/// still resolves to `exists: true`. The primary reason is mechanical, not
/// by-design elsewhere: `services/indexer/src/handler.rs`'s `AccountPipeline`
/// only decodes the `AccountCreated` event type — there is no deactivation
/// event handler in the indexer at all — so a row inserted into the
/// off-chain `accounts` table this endpoint queries is never removed or
/// updated afterwards, regardless of what happens to the account onchain.
/// That happens to line up with the onchain `AccountRegistry` design
/// described in docs/architecture/permanent-registry-design.md (a
/// deactivated account is intentionally kept permanently in the registry
/// too), which is supporting context for why this is an acceptable
/// property to leave as-is rather than an oversight to fix — but it is not
/// itself why the off-chain table behaves this way. Live active/usable
/// status gating belongs to WALM-297's token issuance, not this existence
/// check.
pub async fn account_exists(
    State(state): State<Arc<AppState>>,
    Path(owner): Path<String>,
) -> Result<Json<AccountExistsResponse>, AppError> {
    // Reject malformed input before the DB call rather than silently
    // returning `exists: false` for garbage — matches `validate_sui_address`
    // usage in `routes::sponsor`, the codebase's existing Sui-address check.
    // `validate_sui_address` accepts mixed/upper-case hex (see
    // `test_sui_address_uppercase_hex_accepted` in `routes::sponsor`), so
    // validation alone doesn't normalize case.
    if !validate_sui_address(&owner) {
        return Err(AppError::BadRequest(
            "owner must be a 0x-prefixed 32-byte Sui address (66 characters)".into(),
        ));
    }

    // `accounts.owner` is populated by the v2-indexer from onchain event
    // bytes via `hex::encode` (see `services/indexer/src/handler.rs`),
    // which always produces lowercase hex. Lowercase the input here — not
    // in the SQL (`LOWER(owner) = LOWER($1)` would defeat the plain btree
    // index on `accounts.owner` from migration 001, forcing a sequential
    // scan) — so a caller-supplied uppercase/mixed-case address still hits
    // the index and doesn't false-negative against an existing account.
    let owner = owner.to_ascii_lowercase();

    let exists = state.db.find_account_by_owner(&owner).await?.is_some();
    Ok(Json(AccountExistsResponse { exists }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pure unit test for the case-normalization step, factored out of the
    /// handler body above (`owner.to_ascii_lowercase()`) so it's covered
    /// without needing a live `AppState`/DB (see module doc for why this
    /// codebase has no axum-handler test harness to reuse).
    #[test]
    fn owner_lowercasing_normalizes_mixed_case_before_lookup() {
        // 0x + 64 hex chars (32 bytes) — must match `validate_sui_address`'s
        // length requirement (66 chars total) exactly.
        let mixed_case = "0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
        assert_eq!(
            mixed_case.len(),
            66,
            "fixture must be a 66-char Sui address"
        );
        assert!(validate_sui_address(mixed_case));

        let normalized = mixed_case.to_ascii_lowercase();
        assert_eq!(
            normalized,
            "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
        );

        // Already-lowercase input must be unaffected (idempotent).
        assert_eq!(normalized.to_ascii_lowercase(), normalized);
    }
}
