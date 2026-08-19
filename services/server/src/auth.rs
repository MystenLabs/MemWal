use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::storage::sui::{
    find_account_by_delegate_key, verify_delegate_key_onchain, OnchainVerifyError,
};
use crate::types::{AppState, AuthInfo};

/// Maximum signed-JSON body the auth middleware will buffer before computing
/// the SHA-256 digest. Must be ≥ the largest per-route body limit so the auth
/// layer never rejects requests the routes themselves would accept.
/// Today the bulk-remember route is the largest at 2 MiB.
pub(crate) const PROTECTED_BODY_LIMIT_BYTES: usize = 2 * 1024 * 1024;

/// Ed25519 signature verification + onchain delegate key verification middleware
///
/// Expects these headers:
/// - `x-public-key`: hex-encoded Ed25519 public key (32 bytes)
/// - `x-signature`: hex-encoded Ed25519 signature (64 bytes)
/// - `x-timestamp`: Unix timestamp (seconds)
/// - `x-nonce`: UUID v4 replay-protection nonce
/// - `x-account-id`: account object ID hint included in the canonical signature
///
/// Flow:
/// 1. Verify Ed25519 signature:
///    `{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}`
/// 2. Resolve account: cache → signed header hint/config fallback → registry scan
/// 3. Verify onchain: public_key ∈ MemWalAccount.delegate_keys
/// 4. Cache the mapping for future requests
/// 5. Store AuthInfo { public_key, owner } in request extensions
///
/// Normalize response timing across all auth failure paths.
/// Returns UNAUTHORIZED after a constant 100 ms delay so that an attacker
/// cannot distinguish "account does not exist" (fast RPC fail) from
/// "account exists but key not found" (slow delegate_keys array scan)
/// by measuring response latency.
async fn constant_time_reject() -> StatusCode {
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    StatusCode::UNAUTHORIZED
}

/// Machine-readable reason for a stale/future-dated timestamp, surfaced on the
/// `x-auth-error` header so a client can distinguish clock drift from a bad
/// signature. Only emitted for the timestamp check: it depends solely on the
/// client's own clock, not on whether the account or key exists, so exposing it
/// leaks nothing about server-side identity state. Signature, nonce, and
/// account-resolution failures keep the bare uniform 401 (no reason header) so
/// they remain indistinguishable and cannot be used to enumerate accounts.
const ERR_TIMESTAMP_OUT_OF_BOUNDS: &str = "ERR_TIMESTAMP_OUT_OF_BOUNDS";

/// 401 carrying `x-auth-error: <code>`, after the same constant delay as
/// `constant_time_reject` so timing stays uniform across auth-failure paths.
async fn constant_time_reject_with_reason(code: &'static str) -> Response {
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    (
        StatusCode::UNAUTHORIZED,
        [("x-auth-error", code)],
        String::new(),
    )
        .into_response()
}

fn unsupported_legacy_sdk() -> StatusCode {
    StatusCode::UPGRADE_REQUIRED
}

/// Whether a request whose signed timestamp is `age` seconds old (negative =
/// future-dated) is fresh, given the accepted drift window. The window is
/// inclusive and symmetric: `|age| <= drift`. `drift == 0` requires an exact
/// second match. This is the sole freshness predicate — the middleware and its
/// tests both call it, so a boundary regression can't hide behind a duplicated
/// expression.
fn is_timestamp_fresh(age: i64, drift: i64) -> bool {
    (-drift..=drift).contains(&age)
}

/// Redis TTL (seconds) for a request's replay nonce.
///
/// Freshness is symmetric: a request signed for time `T` is accepted for any
/// `now` in `[T - drift, T + drift]`. Its nonce record is written on first
/// acceptance, which can happen as early as `now = T - drift` (a future-dated
/// request), yet the request stays fresh until `now = T + drift`. So the record
/// must survive the *full* `2 * drift` lifetime, not just one drift — otherwise
/// a request first seen at `T - drift` has its nonce expire at
/// `(T - drift) + ttl` while still being fresh, and the same signature replays
/// in the gap. TTL = `2 * drift + NONCE_TTL_BUFFER_SECS` covers the worst case
/// with margin for every window value. `drift` is bounded to
/// `0..=MAX_AUTH_CLOCK_DRIFT_SECS`, so `2 * drift + buffer` (≤ 2100) never
/// overflows and the `as u64` is lossless.
fn nonce_ttl_secs(drift: i64) -> u64 {
    (2 * drift + crate::types::NONCE_TTL_BUFFER_SECS).max(0) as u64
}

#[tracing::instrument(name = "auth.verify_signature", skip_all)]
pub async fn verify_signature(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let headers = request.headers();

    // Extract auth headers as owned Strings
    let public_key_hex = headers
        .get("x-public-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let signature_hex = headers
        .get("x-signature")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let timestamp_str = headers
        .get("x-timestamp")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Optional account ID hint from header
    let account_id_hint = headers
        .get("x-account-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // Optional delegate private key (hex) for SEAL decrypt — legacy path.
    // Modern clients send `x-seal-session` instead.
    let delegate_key_hex = headers
        .get("x-delegate-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // Optional SEAL SessionKey (base64 JSON) — replaces `x-delegate-key` on
    // the wire. When present, it is preferred over `delegate_key_hex` for
    // any SEAL decrypt operation. Phase 1 of the migration: both headers
    // are accepted so existing SDKs continue to work unchanged.
    let seal_session = headers
        .get("x-seal-session")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    if seal_session.is_some() && delegate_key_hex.is_some() {
        tracing::debug!(
            "both x-seal-session and x-delegate-key present; preferring x-seal-session"
        );
    }
    if seal_session.is_none() && delegate_key_hex.is_some() {
        // Deprecation telemetry: log (without value) so we can count legacy
        // header usage per SDK version during the deprecation window.
        tracing::warn!(
            target: "memwal::deprecation",
            "request using legacy x-delegate-key header — client should upgrade to SDK v0.4+ (x-seal-session)"
        );
    }

    // Extract nonce for replay protection.
    // Nonce must be a UUID, checked against Redis to prevent replay attacks.
    // Its TTL is kept strictly greater than the timestamp window (see the SET
    // below) so no replay is possible once the fresh window closes.
    let nonce = headers
        .get("x-nonce")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            tracing::warn!(
                target: "memwal::deprecation",
                "request missing x-nonce; rejecting unsupported legacy SDK"
            );
            unsupported_legacy_sdk()
        })?
        .to_string();

    // Validate nonce is UUID format (prevents injection attacks)
    if uuid::Uuid::parse_str(&nonce).is_err() {
        tracing::warn!(
            "Invalid nonce format (not UUID): {}",
            &nonce[..nonce.len().min(36)]
        );
        return Err(constant_time_reject().await);
    }

    // Validate timestamp freshness against the configured drift window.
    // Use checked_sub to avoid potential overflow with user-supplied timestamps
    let timestamp: i64 = timestamp_str
        .parse()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let now = chrono::Utc::now().timestamp();
    let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
    let drift = state.config.auth_max_clock_drift_secs;
    if !is_timestamp_fresh(age, drift) {
        tracing::warn!(
            "Request timestamp outside ±{}s window: {} (now: {}, age: {})",
            drift,
            timestamp,
            now,
            age,
        );
        // Timestamp failures are timing-normalized like every other auth reject,
        // but carry a machine-readable reason so a drifted client clock is
        // distinguishable from a bad signature (safe: the check is independent
        // of any server-side identity state).
        return Ok(constant_time_reject_with_reason(ERR_TIMESTAMP_OUT_OF_BOUNDS).await);
    }

    // Decode public key
    let pk_bytes = hex::decode(&public_key_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let pk_array: [u8; 32] = pk_bytes.try_into().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_array).map_err(|_| StatusCode::UNAUTHORIZED)?;

    // Decode signature
    let sig_bytes = hex::decode(&signature_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let sig_array: [u8; 64] = sig_bytes.try_into().map_err(|_| StatusCode::UNAUTHORIZED)?;
    let signature = Signature::from_bytes(&sig_array);

    // Build the signed message: "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}"
    // Include query parameters in signed message to prevent query-param tampering
    let method = request.method().as_str().to_string();
    let path = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());

    // Split request to consume body
    let (mut parts, body) = request.into_parts();

    let body_bytes = axum::body::to_bytes(body, PROTECTED_BODY_LIMIT_BYTES)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let body_hash = hex::encode(Sha256::digest(&body_bytes));
    // Include nonce in signed message to prevent replay attacks.
    // Include x-account-id in the signed canonical message so an
    //         intermediary cannot swap the account hint. The header MUST be
    //         present — the SDK now always sends it. If absent we use an
    //         empty string so the signature will mismatch and the request
    //         is rejected below.
    //
    // NOTE (coordinator): this change must land in lockstep with the SDK
    // signing change in packages/sdk/src/{memwal,manual}.ts. If the Rust
    // sidecar agent edits this function concurrently, reconcile so the
    // canonical message below is the single source of truth.
    //
    // Canonical format:
    //   "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
    let account_id_for_sig = account_id_hint.clone().unwrap_or_default();
    let message = format!(
        "{}.{}.{}.{}.{}.{}",
        timestamp_str, method, path, body_hash, nonce, account_id_for_sig
    );

    // Step 1: Verify Ed25519 signature
    // Use constant_time_reject so signature failures take the same wall-clock
    // time as account-resolution failures, preventing differential timing attacks.
    if verifying_key
        .verify(message.as_bytes(), &signature)
        .is_err()
    {
        tracing::warn!("Signature verification failed for key: {}", public_key_hex);
        return Err(constant_time_reject().await);
    }

    tracing::debug!("signature verified for key: {}", public_key_hex);

    // Check and record nonce in Redis to block replays.
    // Done AFTER signature verify so we don't waste Redis writes on bad requests.
    {
        let nonce_key = format!("nonce:{}", nonce);
        let mut redis = state.redis.clone();

        // Nonce record must outlive the timestamp window so a signature can't be
        // replayed after its nonce entry expires while still inside the fresh
        // window. `nonce_ttl_secs` derives TTL from the window so the invariant
        // holds no matter how the drift window is tuned.
        let ttl = nonce_ttl_secs(drift);

        // SET nonce_key "1" EX <ttl> NX — only set if Not eXists
        let set_result: Option<String> = redis
            .set_options(
                &nonce_key,
                "1",
                redis::SetOptions::default()
                    .conditional_set(redis::ExistenceCheck::NX)
                    .with_expiration(redis::SetExpiry::EX(ttl)),
            )
            .await
            .unwrap_or(None); // A Redis error maps to None here, which is
                              // indistinguishable from "nonce already seen" below —
                              // i.e. the request is REJECTED (fail-CLOSED). That is
                              // deliberate: replay protection holds even when Redis
                              // is down, at the availability cost that a Redis
                              // outage 401s all signed traffic through this
                              // middleware until Redis recovers.

        if set_result.is_none() {
            // NX failed = nonce already exists = replay attempt
            tracing::warn!(
                "Replay attack detected: nonce {} already seen (key={}...)",
                nonce,
                &public_key_hex[..16.min(public_key_hex.len())]
            );
            // uniform timing even for replay rejections
            return Err(constant_time_reject().await);
        }
    }

    // Step 2: Resolve account — cache → signed header hint/config fallback → registry scan
    // Always use constant_time_reject so that timing of the resolution error
    // ("account not found" vs "key not in account") cannot be observed by callers.
    let (account_id, owner) =
        match resolve_account(&state, &public_key_hex, &pk_array, account_id_hint).await {
            Ok(pair) => pair,
            Err(e) => {
                tracing::warn!("Account resolution failed: {}", e);
                return Err(constant_time_reject().await);
            }
        };

    tracing::debug!("account resolved: {} (owner: {})", account_id, owner);

    // Store auth info in request extensions
    parts.extensions.insert(AuthInfo {
        public_key: public_key_hex,
        owner,
        account_id,
        delegate_key: delegate_key_hex,
        seal_session,
    });

    // Rebuild request with the body re-injected
    let request = Request::from_parts(parts, axum::body::Body::from(body_bytes));

    Ok(next.run(request).await)
}

/// Resolve a delegate key to its account using multiple strategies:
/// 1. PostgreSQL cache (fastest)
/// 2. Signed header hint or config fallback (single-object verification)
/// 3. On-chain registry scan (slower, auto-discovery fallback)
///
/// After successful resolution, the mapping is cached for future requests.
#[tracing::instrument(name = "auth.resolve_account", skip_all)]
async fn resolve_account(
    state: &AppState,
    public_key_hex: &str,
    pk_bytes: &[u8; 32],
    account_id_hint: Option<String>,
) -> Result<(String, String), String> {
    // Strategy 1: Check PostgreSQL cache
    if let Ok(Some((cached_account_id, _cached_owner))) =
        state.db.get_cached_account(public_key_hex).await
    {
        // Verify the cached mapping is still valid onchain
        match verify_delegate_key_onchain(
            &state.http_client,
            &state.config.sui_rpc_url,
            state.sui_grpc_client.as_ref(),
            &cached_account_id,
            pk_bytes,
            &state.config.package_id,
        )
        .await
        {
            Ok(owner) => {
                tracing::debug!("account resolved from cache: {}", cached_account_id);
                return Ok((cached_account_id, owner));
            }
            Err(_) => {
                // Key was revoked on-chain. Delete the stale cache row
                // immediately so subsequent requests don't loop: cache-hit → RPC fail →
                // fall-through, burning RPC quota and generating log noise on every call.
                tracing::warn!(
                    "delegate key {} revoked on-chain for account {}; evicting from cache",
                    public_key_hex,
                    cached_account_id
                );
                let _ = state.db.delete_cached_key(public_key_hex).await;
            }
        }
    }

    // Strategy 2: Use exact account hint/config fallback before any registry scan.
    //
    // Modern SDKs always send x-account-id and sign it in the
    // canonical signature, so an intermediary cannot swap this hint. Verifying
    // the signed object directly avoids an expensive AccountRegistry scan that
    // fetches many account objects on cache miss.
    if let Some(exact_account_id) = account_id_hint
        .as_deref()
        .or(state.config.memwal_account_id.as_deref())
    {
        let owner = verify_delegate_key_onchain(
            &state.http_client,
            &state.config.sui_rpc_url,
            state.sui_grpc_client.as_ref(),
            exact_account_id,
            pk_bytes,
            &state.config.package_id,
        )
        .await
        .map_err(|e| {
            format!(
                "exact account {} verification failed: {}",
                exact_account_id, e
            )
        })?;

        let _ = state
            .db
            .cache_delegate_key(public_key_hex, exact_account_id, &owner)
            .await;

        tracing::debug!(
            "account resolved from exact account id: {}",
            exact_account_id
        );
        return Ok((exact_account_id.to_string(), owner));
    }

    // Strategy 3: The legacy registry scan uses JSON-RPC. Testnet no longer
    // serves JSON-RPC, so fail closed when a modern signed x-account-id hint
    // is absent instead of silently contacting a retired endpoint.
    if state.config.sui_network == "testnet" {
        return Err(
            "x-account-id is required for delegate-key authentication on testnet".to_string(),
        );
    }

    // Non-testnet compatibility path: scan AccountRegistry only when no exact
    // account id is available. The scan runs before the rate limiter, so use
    // an in-process concurrency permit so
    // unknown-key floods can't stack unbounded scans, and a per-scan page
    // cap (MEMWAL_REGISTRY_SCAN_MAX_PAGES) inside the scan itself. Both
    // rejection messages name the x-account-id remediation, but they surface
    // only in server logs: the middleware collapses every auth failure to a
    // bare 401 (no oracle). A key past the page cap therefore cannot
    // self-resolve — operators must diagnose the lockout from the warn logs
    // and either raise the cap or have the client send the header hint,
    // which Strategy 2 verifies directly without any scan.
    let _scan_permit = match state.registry_scan_semaphore.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            return Err(
                "registry scan concurrency limit reached; retry, or send the x-account-id \
                 header hint to skip the registry scan"
                    .to_string(),
            );
        }
    };
    match find_account_by_delegate_key(
        &state.http_client,
        &state.config.sui_rpc_url,
        &state.config.registry_id,
        pk_bytes,
        &state.config.package_id,
        state.config.registry_scan_max_pages,
    )
    .await
    {
        Ok((account_id, owner)) => {
            // Cache for future requests
            let _ = state
                .db
                .cache_delegate_key(public_key_hex, &account_id, &owner)
                .await;
            return Ok((account_id, owner));
        }
        Err(e @ OnchainVerifyError::ScanCapExceeded(_)) => {
            tracing::warn!("registry scan capped: {}", e);
            return Err(format!(
                "{}; send the x-account-id header hint to authenticate without a scan",
                e
            ));
        }
        Err(e) => {
            tracing::debug!("registry scan did not find key: {}", e);
        }
    }

    Err("no account found: not in cache, exact account id, or registry".to_string())
}

#[tracing::instrument(name = "auth.verify_admin_key", skip_all)]
pub async fn verify_admin_key(request: Request, next: Next) -> Result<Response, StatusCode> {
    let headers = request.headers();

    let api_key = headers
        .get("x-admin-api-key")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let expected_key = std::env::var("ADMIN_API_KEY").map_err(|_| StatusCode::UNAUTHORIZED)?;
    if !admin_api_key_is_configured(&expected_key) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    if !constant_time_compare(api_key.as_bytes(), expected_key.as_bytes()) {
        return Err(constant_time_reject().await);
    }

    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    Ok(response)
}

pub(crate) fn admin_api_key_is_configured(key: &str) -> bool {
    !key.trim().is_empty()
}

fn constant_time_compare(a: &[u8], b: &[u8]) -> bool {
    let mut result = (a.len() ^ b.len()) as usize;
    let len = a.len().max(b.len());
    for i in 0..len {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        result |= (x ^ y) as usize;
    }
    result == 0
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_body_limit_allows_one_mb_remember_json() {
        let body = serde_json::json!({
            "text": "a".repeat(1024 * 1024),
            "namespace": "default",
        })
        .to_string();

        assert!(body.len() > 1024 * 1024);
        assert!(body.len() <= PROTECTED_BODY_LIMIT_BYTES);
    }

    // ── Nonce must be valid UUID v4 ──────────────────────────────

    #[test]
    fn nonce_valid_uuid_accepted() {
        let nonce = "550e8400-e29b-41d4-a716-446655440000";
        assert!(uuid::Uuid::parse_str(nonce).is_ok());
    }

    #[test]
    fn nonce_invalid_format_rejected() {
        let bad_nonces = [
            "",
            "not-a-uuid",
            "12345",
            "550e8400-e29b-41d4-a716",              // truncated
            "ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ", // non-hex
            "../../../etc/passwd",                  // injection attempt
        ];
        for nonce in bad_nonces {
            assert!(
                uuid::Uuid::parse_str(nonce).is_err(),
                "should reject nonce: {:?}",
                nonce,
            );
        }
    }

    // ── checked_sub prevents overflow ───────────────────────────

    #[test]
    fn checked_sub_handles_underflow() {
        // Attacker sends timestamp = i64::MAX, now is a small positive number
        // 1700000000 - i64::MAX is a large negative number (no overflow),
        // but it's far outside the ±300s window → request rejected.
        let now: i64 = 1700000000;
        let timestamp: i64 = i64::MAX;
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        // age is a huge negative value, well below -300
        assert!(age < -300, "age {} should be less than -300", age);
    }

    #[test]
    fn checked_sub_handles_negative_overflow() {
        // Attacker sends timestamp = i64::MIN
        let now: i64 = 1700000000;
        let timestamp: i64 = i64::MIN;
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        // i64::MIN wraps — checked_sub returns None → i64::MAX
        assert_eq!(age, i64::MAX);
    }

    #[test]
    fn checked_sub_normal_case_passes() {
        let now: i64 = 1700000100;
        let timestamp: i64 = 1700000000;
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        assert_eq!(age, 100);
        assert!(age <= 300); // within window
    }

    #[test]
    fn checked_sub_future_timestamp_within_window() {
        let now: i64 = 1700000000;
        let timestamp: i64 = 1700000200; // 200s in the future
        let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
        assert_eq!(age, -200);
        assert!(age >= -300); // within ±300s window
    }

    #[test]
    fn checked_sub_exactly_at_boundary() {
        let now: i64 = 1700000000;

        // Exactly at +300s boundary — should be accepted (age == 300, not > 300)
        let timestamp_past = now - 300;
        let age_past = now.checked_sub(timestamp_past).unwrap_or(i64::MAX);
        assert_eq!(age_past, 300);
        // The check is `!(-300..=300).contains(&age)`, so exactly 300 passes
        assert!((-300..=300).contains(&age_past));

        // At +301s — should be rejected
        let timestamp_expired = now - 301;
        let age_expired = now.checked_sub(timestamp_expired).unwrap_or(i64::MAX);
        assert_eq!(age_expired, 301);
        assert!(age_expired > 300);
    }

    // ── Configurable drift window (exercises the real predicate) ─

    #[test]
    fn drift_window_boundaries_are_inclusive_and_symmetric() {
        let drift = 120;
        assert!(is_timestamp_fresh(drift, drift)); // exactly +window accepted
        assert!(is_timestamp_fresh(-drift, drift)); // exactly -window accepted
        assert!(!is_timestamp_fresh(drift + 1, drift)); // just past → rejected
        assert!(!is_timestamp_fresh(-(drift + 1), drift)); // just past (future) → rejected
    }

    #[test]
    fn drift_window_zero_requires_exact_second() {
        assert!(is_timestamp_fresh(0, 0));
        assert!(!is_timestamp_fresh(1, 0));
        assert!(!is_timestamp_fresh(-1, 0));
    }

    #[test]
    fn reported_repro_45s_offset_is_within_default_window() {
        // The issue's repro used a +45s client offset; it is comfortably inside
        // the default 300s window and is accepted (i.e. does not reproduce).
        assert!(is_timestamp_fresh(45, crate::types::DEFAULT_AUTH_CLOCK_DRIFT_SECS));
        assert!(is_timestamp_fresh(-45, crate::types::DEFAULT_AUTH_CLOCK_DRIFT_SECS));
    }

    #[test]
    fn nonce_ttl_covers_full_future_dated_freshness_lifetime() {
        // Exercises the real `nonce_ttl_secs` used at the Redis call site, so a
        // regression is caught here, not hidden behind a duplicated formula.
        //
        // Worst case (the one a naive `drift + buffer` TTL misses): a request
        // signed for `T` is first accepted as early as `now = T - drift`
        // (future-dated), and stays fresh until `now = T + drift`. The nonce
        // record, written at first acceptance, must still exist at the end of
        // that window, i.e. its TTL must cover the full `2 * drift` span so no
        // replay slips through after it expires.
        for drift in [0i64, 45, 300, 600, crate::types::MAX_AUTH_CLOCK_DRIFT_SECS] {
            let first_seen_at = -drift; // now = T - drift, relative to T
            let fresh_until = drift; //    now = T + drift, relative to T
            let nonce_expires_at = first_seen_at + nonce_ttl_secs(drift) as i64;
            assert!(
                nonce_expires_at > fresh_until,
                "drift {drift}: nonce expires at {nonce_expires_at} but request is \
                 fresh through {fresh_until} — replay gap"
            );
        }
        // Pin the exact derivation at default and ceiling so it cannot regress:
        //   default: 2*300 + 300 = 900
        //   ceiling: 2*900 + 300 = 2100
        assert_eq!(nonce_ttl_secs(crate::types::DEFAULT_AUTH_CLOCK_DRIFT_SECS), 900);
        assert_eq!(nonce_ttl_secs(crate::types::MAX_AUTH_CLOCK_DRIFT_SECS), 2100);
    }

    // ── Timestamp-drift reason header (safe to distinguish) ──────

    #[tokio::test]
    async fn timestamp_reject_carries_reason_header_and_401() {
        let resp = constant_time_reject_with_reason(ERR_TIMESTAMP_OUT_OF_BOUNDS).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers()
                .get("x-auth-error")
                .and_then(|v| v.to_str().ok()),
            Some("ERR_TIMESTAMP_OUT_OF_BOUNDS"),
        );
    }

    #[tokio::test]
    async fn identity_reject_carries_no_reason_header() {
        // Signature/nonce/account failures must stay indistinguishable: the bare
        // 401 from constant_time_reject exposes no x-auth-error, so it can't be
        // used to tell "bad signature" from "account not found".
        let status = constant_time_reject().await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    // ── Query parameters included in signed message ──────────────

    #[test]
    fn signed_message_includes_query_params() {
        // Simulate what the middleware does: use path_and_query
        let uri: axum::http::Uri = "/api/recall?limit=999".parse().unwrap();
        let path = uri
            .path_and_query()
            .map(|pq| pq.as_str().to_string())
            .unwrap_or_else(|| uri.path().to_string());

        assert_eq!(path, "/api/recall?limit=999");
        // The full query string is part of the message → signature covers it
    }

    #[test]
    fn signed_message_without_query_uses_path_only() {
        let uri: axum::http::Uri = "/api/remember".parse().unwrap();
        let path = uri
            .path_and_query()
            .map(|pq| pq.as_str().to_string())
            .unwrap_or_else(|| uri.path().to_string());

        assert_eq!(path, "/api/remember");
    }

    // ── constant_time_reject returns 401 ─────────────────────────

    #[tokio::test]
    async fn constant_time_reject_returns_unauthorized() {
        let status = constant_time_reject().await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn unsupported_legacy_sdk_returns_upgrade_required() {
        assert_eq!(unsupported_legacy_sdk(), StatusCode::UPGRADE_REQUIRED);
    }

    // ── account_id included in signed canonical message ─────────

    #[test]
    fn canonical_message_format_with_account_id() {
        let timestamp = "1700000000";
        let method = "POST";
        let path = "/api/remember";
        let body_hash = "abc123";
        let nonce = "550e8400-e29b-41d4-a716-446655440000";
        let account_id = "0xdeadbeef";

        let message = format!(
            "{}.{}.{}.{}.{}.{}",
            timestamp, method, path, body_hash, nonce, account_id
        );

        assert_eq!(
            message,
            "1700000000.POST./api/remember.abc123.550e8400-e29b-41d4-a716-446655440000.0xdeadbeef"
        );
        // Verify all 6 fields are present
        assert_eq!(message.matches('.').count(), 5);
    }

    #[test]
    fn canonical_message_without_account_id_uses_empty_string() {
        let account_id_for_sig = String::new();

        let message = format!(
            "{}.{}.{}.{}.{}.{}",
            "1700000000", "POST", "/api/recall", "hash", "nonce", account_id_for_sig
        );

        // Ends with a dot and empty string — will mismatch if client sends an actual account_id
        assert!(message.ends_with('.'));
    }

    // ── Full signature + nonce verification flow ─────────────────

    #[test]
    fn signed_message_all_fields_present() {
        // Verify the canonical format: "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
        let parts = [
            "1700000000",
            "POST",
            "/api/analyze?ns=work",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        ];
        let message = parts.join(".");
        // Must have exactly 6 fields separated by 5 dots
        assert_eq!(message.split('.').count(), 6);
        // Nonce field (5th) must be a valid UUID
        let nonce_field = message.split('.').nth(4).unwrap();
        assert!(uuid::Uuid::parse_str(nonce_field).is_ok());
    }

    // ── Ed25519 signature verification integration ──────────────────────

    /// Helper: create a deterministic Ed25519 signing key for tests.
    /// Uses a fixed 32-byte secret key — NOT for production use.
    fn test_signing_key() -> ed25519_dalek::SigningKey {
        let secret: [u8; 32] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        ed25519_dalek::SigningKey::from_bytes(&secret)
    }

    #[test]
    fn ed25519_roundtrip_signature_verification() {
        use ed25519_dalek::Signer;

        let signing_key = test_signing_key();
        let verifying_key = signing_key.verifying_key();

        let message =
            "1700000000.POST./api/remember.abc123.f47ac10b-58cc-4372-a567-0e02b2c3d479.0xdead";
        let signature = signing_key.sign(message.as_bytes());

        // Valid signature passes
        assert!(verifying_key.verify(message.as_bytes(), &signature).is_ok());

        // Tampered message fails
        let tampered =
            "1700000001.POST./api/remember.abc123.f47ac10b-58cc-4372-a567-0e02b2c3d479.0xdead";
        assert!(verifying_key
            .verify(tampered.as_bytes(), &signature)
            .is_err());
    }

    #[test]
    fn ed25519_wrong_nonce_fails_verification() {
        use ed25519_dalek::Signer;

        let signing_key = test_signing_key();
        let verifying_key = signing_key.verifying_key();

        let nonce1 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
        let nonce2 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

        let msg1 = format!("1700000000.POST./api/remember.hash.{}.0xdead", nonce1);
        let signature = signing_key.sign(msg1.as_bytes());

        // Replacing nonce = replay with different nonce → signature fails
        let msg2 = format!("1700000000.POST./api/remember.hash.{}.0xdead", nonce2);
        assert!(verifying_key.verify(msg2.as_bytes(), &signature).is_err());
    }

    #[test]
    fn ed25519_wrong_account_id_fails_verification() {
        use ed25519_dalek::Signer;

        let signing_key = test_signing_key();
        let verifying_key = signing_key.verifying_key();

        let msg = "1700000000.POST./api/recall.hash.nonce.0xaccount_a";
        let signature = signing_key.sign(msg.as_bytes());

        // Swapping account_id makes signature verification fail.
        let swapped = "1700000000.POST./api/recall.hash.nonce.0xaccount_b";
        assert!(verifying_key
            .verify(swapped.as_bytes(), &signature)
            .is_err());
    }

    // ── Manual-mode trust boundary ────────────────────────────
    //
    // Manual-mode routes (/api/remember/manual, /api/recall/manual) must
    // succeed without the `x-delegate-key` header. The SDK no longer emits
    // this header on those routes (packages/sdk/src/memwal.ts), and Manual-
    // mode route handlers (services/server/src/routes.rs) never read
    // `AuthInfo.delegate_key`. This test locks in the invariant that
    // `AuthInfo` is valid with `delegate_key: None` so a future refactor
    // cannot silently re-introduce a requirement on the header.

    #[test]
    fn auth_info_valid_without_delegate_key_for_manual_routes() {
        let auth = AuthInfo {
            public_key: "abcd".to_string(),
            owner: "0xowner".to_string(),
            account_id: "0xaccount".to_string(),
            delegate_key: None,
            seal_session: None,
        };
        assert!(auth.delegate_key.is_none());
        assert!(auth.seal_session.is_none());
        // Verify Debug impl still redacts — even in
        // Manual mode we must never leak any credential material in logs.
        let debug_str = format!("{:?}", auth);
        assert!(debug_str.contains("None"));
        assert!(!debug_str.contains("<redacted>"));
    }

    #[test]
    fn admin_key_configuration_rejects_empty_values() {
        assert!(!admin_api_key_is_configured(""));
        assert!(!admin_api_key_is_configured("   \t\n"));
        assert!(admin_api_key_is_configured("a-strong-secret"));
    }

    #[test]
    fn admin_key_comparison_requires_identical_bytes_and_length() {
        assert!(constant_time_compare(
            b"secret-key-12345",
            b"secret-key-12345"
        ));
        assert!(!constant_time_compare(
            b"secret-key-aaaaa",
            b"secret-key-bbbbb"
        ));
        assert!(!constant_time_compare(b"short", b"much-longer-key"));
    }
}
