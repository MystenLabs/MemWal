use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::sui::{find_account_by_delegate_key, verify_delegate_key_onchain};
use crate::types::{AppState, AuthInfo};

/// Ed25519 signature verification + onchain delegate key verification middleware
///
/// Expects these headers:
/// - `x-public-key`: hex-encoded Ed25519 public key (32 bytes)
/// - `x-signature`: hex-encoded Ed25519 signature (64 bytes)
/// - `x-timestamp`: Unix timestamp (seconds)
/// - `x-account-id` (optional): account object ID hint (skips cache/registry lookup)
///
/// Flow:
/// 1. Verify Ed25519 signature: `{timestamp}.{method}.{path}.{body_sha256}`
/// 2. Resolve account: cache → indexed accounts → registry scan → header hint → config fallback
/// 3. Verify onchain: public_key ∈ MemWalAccount.delegate_keys
/// 4. Cache the mapping for future requests
/// 5. Store AuthInfo { public_key, owner } in request extensions
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

    // Optional delegate private key (hex) for SEAL decrypt
    let delegate_key_hex = headers
        .get("x-delegate-key")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // Validate timestamp (5 minute window)
    let timestamp: i64 = timestamp_str
        .parse()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let now = chrono::Utc::now().timestamp();
    if (now - timestamp).abs() > 300 {
        tracing::warn!("Request timestamp too old: {} (now: {})", timestamp, now);
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Decode public key
    let pk_bytes = hex::decode(&public_key_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let pk_array: [u8; 32] = pk_bytes
        .try_into()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_array).map_err(|_| StatusCode::UNAUTHORIZED)?;

    // Decode signature
    let sig_bytes = hex::decode(&signature_hex).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let signature = Signature::from_bytes(&sig_array);

    // Build the signed message: "{timestamp}.{method}.{path}.{body_sha256}"
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();

    // Split request to consume body
    let (mut parts, body) = request.into_parts();

    let body_bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let body_hash = hex::encode(Sha256::digest(&body_bytes));
    let message = format!("{}.{}.{}.{}", timestamp_str, method, path, body_hash);

    // Step 1: Verify Ed25519 signature
    verifying_key
        .verify(message.as_bytes(), &signature)
        .map_err(|e| {
            tracing::warn!("Signature verification failed: {}", e);
            StatusCode::UNAUTHORIZED
        })?;

    tracing::debug!("signature verified for key: {}", public_key_hex);

    // Step 2: Resolve account — cache → indexed accounts → registry scan → header hint → config fallback
    let (account_id, owner) = resolve_account(&state, &public_key_hex, &pk_array, account_id_hint)
        .await
        .map_err(|e| {
            tracing::warn!("Account resolution failed: {}", e);
            StatusCode::UNAUTHORIZED
        })?;

    tracing::debug!("account resolved: {} (owner: {})", account_id, owner);

    // Store auth info in request extensions
    parts.extensions.insert(AuthInfo {
        public_key: public_key_hex,
        owner,
        account_id,
        delegate_key: delegate_key_hex,
    });

    // Rebuild request with the body re-injected
    let request = Request::from_parts(parts, axum::body::Body::from(body_bytes));

    Ok(next.run(request).await)
}

/// Resolve a delegate key to its account using multiple strategies:
/// 1. PostgreSQL cache (fastest)
/// 2. On-chain registry scan (slower, but auto-discovers)
/// 3. Header hint or config fallback (manual)
///
/// After successful resolution, the mapping is cached for future requests.
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
            &cached_account_id,
            pk_bytes,
        )
        .await
        {
            Ok(owner) => {
                tracing::debug!("account resolved from cache: {}", cached_account_id);
                return Ok((cached_account_id, owner));
            }
            Err(_) => {
                // Cache is stale (key was removed), continue to other strategies
                tracing::debug!("cached account {} is stale, re-resolving", cached_account_id);
            }
        }
    }

    // Strategy 2: Scan AccountRegistry on-chain
    match find_account_by_delegate_key(
        &state.http_client,
        &state.config.sui_rpc_url,
        &state.config.registry_id,
        pk_bytes,
    )
    .await
    {
        Ok((account_id, owner)) => {
            // Cache for future requests
            let _ = state.db.cache_delegate_key(public_key_hex, &account_id, &owner).await;
            return Ok((account_id, owner));
        }
        Err(e) => {
            tracing::debug!("registry scan did not find key: {}", e);
        }
    }

    // Strategy 3: Use header hint or config fallback
    let fallback_account_id = account_id_hint
        .or_else(|| state.config.memwal_account_id.clone())
        .ok_or_else(|| "no account found: not in cache, registry, or header".to_string())?;

    let owner = verify_delegate_key_onchain(
        &state.http_client,
        &state.config.sui_rpc_url,
        &fallback_account_id,
        pk_bytes,
    )
    .await
    .map_err(|e| format!("fallback account {} verification failed: {}", fallback_account_id, e))?;

    // Cache for future requests
    let _ = state.db.cache_delegate_key(public_key_hex, &fallback_account_id, &owner).await;

    Ok((fallback_account_id, owner))
}
