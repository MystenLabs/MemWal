use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::sui::verify_delegate_key_onchain;
use crate::types::{AppState, AuthInfo};

/// Ed25519 signature verification + onchain delegate key verification middleware
///
/// Expects these headers:
/// - `x-public-key`: hex-encoded Ed25519 public key (32 bytes)
/// - `x-signature`: hex-encoded Ed25519 signature (64 bytes)
/// - `x-timestamp`: Unix timestamp (seconds)
///
/// Flow:
/// 1. Verify Ed25519 signature: `{timestamp}.{method}.{path}.{body_sha256}`
/// 2. Verify onchain: public_key ∈ MemWalAccount.delegate_keys
/// 3. Store AuthInfo { public_key, owner } in request extensions
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

    // Extract account object ID from header (multi-user support)
    let account_id = headers
        .get("x-account-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .or_else(|| state.config.memwal_account_id.clone())
        .ok_or_else(|| {
            tracing::warn!("Missing x-account-id header and no fallback configured");
            StatusCode::UNAUTHORIZED
        })?;

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

    tracing::debug!("✅ Signature verified for key: {}", public_key_hex);

    // Step 2: Verify onchain — check delegate_key ∈ MemWalAccount
    let owner = verify_delegate_key_onchain(
        &state.http_client,
        &state.config.sui_rpc_url,
        &account_id,
        &pk_array,
    )
    .await
    .map_err(|e| {
        tracing::warn!("Onchain verification failed for account {}: {}", account_id, e);
        StatusCode::UNAUTHORIZED
    })?;

    tracing::debug!("✅ Onchain verified! Owner: {}", owner);

    // Store auth info in request extensions
    parts.extensions.insert(AuthInfo {
        public_key: public_key_hex,
        owner,
    });

    // Rebuild request with the body re-injected
    let request = Request::from_parts(parts, axum::body::Body::from(body_bytes));

    Ok(next.run(request).await)
}
