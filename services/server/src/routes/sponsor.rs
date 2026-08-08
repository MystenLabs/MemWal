//! `/sponsor` + `/sponsor/execute` proxy handlers.
//!
//! Thin authenticated proxies that forward Enoki-sponsor requests to the
//! internal sidecar, with input validation (Sui address / tx digest /
//! signature size / base64) and per-sender rate limiting. Upstream error
//! bodies are never echoed to the client — they're logged server-side and
//! masked to a generic message (`mask_upstream`).

use axum::body::Body;
use axum::extract::State;
use axum::response::Response;
use base64::Engine as _;
use sha2::{Digest as _, Sha256};
use std::sync::Arc;
use sui_sdk_types::{Command, TransactionKind};
use uuid::Uuid;

use crate::security_delete_error::SdCode;
use crate::types::*;

/// Sui transaction signatures are serialized as base64 bytes — native
/// schemes are 65/97 bytes, zkLogin signatures are variable-size payloads.
/// Upper bound to reject obviously oversized inputs before any work.
const MAX_SPONSORED_SIGNATURE_BYTES: usize = 2048;
const MAX_WALLET_AUTH_SIGNATURE_BYTES: usize = 8192;
const SPONSOR_AUTH_WINDOW_SECONDS: i64 = 300;
const SPONSOR_AUTH_NONCE_TTL_SECONDS: i64 = 600;
const PENDING_SPONSOR_TTL_SECONDS: i64 = 600;

const CONSUME_PENDING_SPONSOR_LUA: &str = r#"
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
if value ~= ARGV[1] then return -1 end
redis.call('DEL', KEYS[1])
return 1
"#;

fn mask_upstream(status: u16) -> (axum::http::StatusCode, &'static str) {
    match status {
        429 => (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "Sponsor service temporarily overloaded",
        ),
        401 | 403 => (
            axum::http::StatusCode::BAD_GATEWAY,
            "Sponsor service misconfigured",
        ),
        500..=599 => (axum::http::StatusCode::BAD_GATEWAY, "Sponsor service error"),
        _ => (
            axum::http::StatusCode::BAD_REQUEST,
            "Sponsor request rejected",
        ),
    }
}

fn json_error_response(status: axum::http::StatusCode, msg: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(serde_json::json!({ "error": msg }).to_string()))
        .unwrap()
}

/// Validate a Sui address: `0x` followed by exactly 64 hex characters.
pub(super) fn validate_sui_address(s: &str) -> bool {
    s.starts_with("0x") && s.len() == 66 && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Validate base64 and return decoded bytes, or None on failure.
pub(super) fn decode_base64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// Validate a Sui transaction digest: base58 alphabet, 43 or 44 characters.
pub(super) fn validate_digest(s: &str) -> bool {
    // Base58 of 32 bytes is normally 43-44 chars, but digests with leading
    // zero bytes encode shorter (~0.1% of real digests are 42) — accept the
    // full range a 32-byte value can produce.
    let len = s.len();
    if !(32..=44).contains(&len) {
        return false;
    }
    // Base58 alphabet excludes: 0, O, I, l
    s.chars().all(|c| {
        matches!(c,
            '1'..='9' | 'A'..='H' | 'J'..='N' | 'P'..='Z' | 'a'..='k' | 'm'..='z'
        )
    })
}

/// Sui transaction signatures are serialized as base64 bytes. Native schemes are
/// 65/97 bytes, while zkLogin signatures are variable-size serialized payloads.
pub(super) fn validate_sponsored_signature_len(len: usize) -> bool {
    (65..=MAX_SPONSORED_SIGNATURE_BYTES).contains(&len)
}

/// Forward a signed sponsored transaction to the sidecar's
/// `/sponsor/execute` and return the upstream status + body. Shared by the
/// `/sponsor/execute` proxy.
async fn call_sidecar_sponsor_execute(
    state: &AppState,
    digest: &str,
    signature: &str,
    verify_effects: bool,
) -> Result<(reqwest::StatusCode, axum::body::Bytes), AppError> {
    let forwarded = serde_json::json!({
        "digest": digest,
        "signature": signature,
        "verifyEffects": verify_effects,
    });

    let url = format!("{}/sponsor/execute", state.config.sidecar_url);
    let mut upstream_request = state
        .http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&forwarded);
    if let Some(secret) = state.config.sidecar_secret.as_deref() {
        upstream_request = upstream_request.header("authorization", format!("Bearer {}", secret));
    }
    let upstream_request = crate::observability::apply_request_id_header(upstream_request);
    let started = std::time::Instant::now();
    let resp = upstream_request.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sidecar",
            "sponsor_execute",
            "transport_error",
            started.elapsed(),
        );
        crate::observability::record_sidecar_failure("sponsor_execute", "transport_error");
        AppError::Internal(format!("Sponsor execute proxy failed: {}", e))
    })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sidecar",
        "sponsor_execute",
        &status_label,
        started.elapsed(),
    );

    let upstream_status = resp.status();
    let resp_body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor execute proxy read failed: {}", e)))?;
    Ok((upstream_status, resp_body))
}

/// Parse and validate a /sponsor-shaped body — never echo back
/// client-supplied values in errors.
fn parse_sponsor_request(body: &[u8]) -> Result<(SponsorRequest, Vec<u8>), AppError> {
    let req: SponsorRequest = serde_json::from_slice(body)
        .map_err(|_| AppError::BadRequest("Invalid request body".into()))?;

    if !validate_sui_address(&req.sender) {
        return Err(AppError::BadRequest("Invalid sender address".into()));
    }

    let tx_bytes = decode_base64(&req.transaction_block_kind_bytes).ok_or_else(|| {
        AppError::BadRequest("transactionBlockKindBytes must be valid base64".into())
    })?;
    if tx_bytes.len() < 10 || tx_bytes.len() > 7000 {
        return Err(AppError::BadRequest(
            "transactionBlockKindBytes out of range".into(),
        ));
    }

    Ok((req, tx_bytes))
}

fn sponsor_authorization_message(
    sender: &str,
    transaction_kind_bytes: &[u8],
    timestamp: i64,
    nonce: &str,
) -> String {
    let transaction_kind_hash = hex::encode(Sha256::digest(transaction_kind_bytes));
    format!(
        "MemWal sponsor authorization\nsender: {sender}\ntransaction-kind-sha256: {transaction_kind_hash}\ntimestamp: {timestamp}\nnonce: {nonce}"
    )
}

fn validate_sponsor_transaction_kind(
    transaction_kind_bytes: &[u8],
    package_id: &str,
) -> Result<(), AppError> {
    let kind: TransactionKind = bcs::from_bytes(transaction_kind_bytes)
        .map_err(|_| AppError::BadRequest("Invalid transaction kind".into()))?;
    let TransactionKind::ProgrammableTransaction(programmable) = kind else {
        return Err(AppError::BadRequest(
            "Transaction kind is not permitted for sponsorship".into(),
        ));
    };
    let package = package_id
        .parse::<sui_sdk_types::Address>()
        .map_err(|_| AppError::Internal("Invalid configured MemWal package ID".into()))?;

    let permitted = programmable.commands.len() == 1
        && programmable.commands.iter().all(|command| match command {
            Command::MoveCall(call) => {
                call.package == package
                    && call.module.as_str() == "account"
                    && matches!(
                        call.function.as_str(),
                        "create_account" | "add_delegate_key" | "remove_delegate_key"
                    )
                    && call.type_arguments.is_empty()
            }
            _ => false,
        });
    if !permitted {
        return Err(AppError::BadRequest(
            "Transaction kind is not permitted for sponsorship".into(),
        ));
    }
    Ok(())
}

async fn authenticate_sponsor_request(
    state: &AppState,
    request: &SponsorRequest,
    transaction_kind_bytes: &[u8],
) -> Result<(), AppError> {
    let signature = request
        .auth_signature
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("Sponsor authorization required".into()))?;
    let timestamp = request
        .auth_timestamp
        .ok_or_else(|| AppError::Unauthorized("Sponsor authorization required".into()))?;
    let nonce = request
        .auth_nonce
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("Sponsor authorization required".into()))?;

    let now = chrono::Utc::now().timestamp();
    let age = now.checked_sub(timestamp).unwrap_or(i64::MAX);
    let valid_nonce = Uuid::parse_str(nonce)
        .ok()
        .is_some_and(|parsed| parsed.get_version_num() == 4);
    let signature_len = decode_base64(signature).map(|bytes| bytes.len());
    if !(-SPONSOR_AUTH_WINDOW_SECONDS..=SPONSOR_AUTH_WINDOW_SECONDS).contains(&age)
        || !valid_nonce
        || !signature_len.is_some_and(|len| (65..=MAX_WALLET_AUTH_SIGNATURE_BYTES).contains(&len))
    {
        return Err(AppError::Unauthorized(
            "Invalid sponsor authorization".into(),
        ));
    }

    // Reserve the nonce before remote signature verification. Invalid or
    // replayed attempts are burned, and Redis failure denies the request.
    let mut redis = state.redis.clone();
    let reserved: Option<String> = redis::cmd("SET")
        .arg(format!("sponsor:auth:nonce:{nonce}"))
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(SPONSOR_AUTH_NONCE_TTL_SECONDS)
        .query_async(&mut redis)
        .await
        .map_err(|error| {
            AppError::UpstreamUnavailable(format!("Sponsor auth Redis unavailable: {error}"))
        })?;
    if reserved.is_none() {
        return Err(AppError::Unauthorized(
            "Invalid sponsor authorization".into(),
        ));
    }

    let message =
        sponsor_authorization_message(&request.sender, transaction_kind_bytes, timestamp, nonce);
    state
        .security_delete_wallet_verifier
        .verify_personal(&request.sender, message.as_bytes(), signature)
        .await
        .map_err(|error| match error.code {
            SdCode::RpcUnavailable | SdCode::InternalError => AppError::UpstreamUnavailable(
                format!("Sponsor wallet verification unavailable: {}", error.message),
            ),
            _ => AppError::Unauthorized("Invalid sponsor authorization".into()),
        })
}

async fn record_pending_sponsor(
    state: &AppState,
    digest: &str,
    sender: &str,
) -> Result<(), AppError> {
    let mut redis = state.redis.clone();
    let recorded: Option<String> = redis::cmd("SET")
        .arg(format!("sponsor:pending:{digest}"))
        .arg(sender)
        .arg("NX")
        .arg("EX")
        .arg(PENDING_SPONSOR_TTL_SECONDS)
        .query_async(&mut redis)
        .await
        .map_err(|error| {
            AppError::UpstreamUnavailable(format!("Sponsor binding Redis unavailable: {error}"))
        })?;
    if recorded.is_none() {
        return Err(AppError::UpstreamUnavailable(
            "Sponsor digest binding collision".into(),
        ));
    }
    Ok(())
}

async fn consume_pending_sponsor(
    state: &AppState,
    digest: &str,
    sender: &str,
) -> Result<(), AppError> {
    let mut redis = state.redis.clone();
    let consumed: i64 = redis::Script::new(CONSUME_PENDING_SPONSOR_LUA)
        .key(format!("sponsor:pending:{digest}"))
        .arg(sender)
        .invoke_async(&mut redis)
        .await
        .map_err(|error| {
            AppError::UpstreamUnavailable(format!("Sponsor binding Redis unavailable: {error}"))
        })?;
    if consumed != 1 {
        return Err(AppError::Unauthorized(
            "Invalid or expired sponsor authorization".into(),
        ));
    }
    Ok(())
}

/// Forward a validated sponsor request to the sidecar's POST /sponsor.
async fn forward_sponsor(
    state: &AppState,
    req: &SponsorRequest,
) -> Result<Response<Body>, AppError> {
    // Re-serialise only validated fields before forwarding.
    let forwarded = serde_json::json!({
        "sender": req.sender,
        "transactionBlockKindBytes": req.transaction_block_kind_bytes,
    });

    let url = format!("{}/sponsor", state.config.sidecar_url);
    let mut upstream_request = state
        .http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&forwarded);
    if let Some(secret) = state.config.sidecar_secret.as_deref() {
        upstream_request = upstream_request.header("authorization", format!("Bearer {}", secret));
    }
    let upstream_request = crate::observability::apply_request_id_header(upstream_request);
    let started = std::time::Instant::now();
    let resp = upstream_request.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sidecar",
            "sponsor",
            "transport_error",
            started.elapsed(),
        );
        crate::observability::record_sidecar_failure("sponsor", "transport_error");
        AppError::Internal(format!("Sponsor proxy failed: {}", e))
    })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external("sidecar", "sponsor", &status_label, started.elapsed());

    let upstream_status = resp.status();
    let resp_body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor proxy read failed: {}", e)))?;

    if upstream_status.is_success() {
        let sponsored: serde_json::Value = serde_json::from_slice(&resp_body)
            .map_err(|_| AppError::Internal("Invalid sponsor upstream response".into()))?;
        let digest = sponsored
            .get("digest")
            .and_then(serde_json::Value::as_str)
            .filter(|digest| validate_digest(digest))
            .ok_or_else(|| AppError::Internal("Invalid sponsor upstream digest".into()))?;
        record_pending_sponsor(state, digest, &req.sender).await?;
        Ok(Response::builder()
            .status(axum::http::StatusCode::from_u16(upstream_status.as_u16()).unwrap())
            .header("Content-Type", "application/json")
            .body(Body::from(resp_body))
            .unwrap())
    } else {
        crate::observability::record_sidecar_failure("sponsor", "http_error");
        tracing::error!(
            "sponsor upstream error {}: {}",
            upstream_status,
            String::from_utf8_lossy(&resp_body)
        );
        let (masked_status, masked_msg) = mask_upstream(upstream_status.as_u16());
        Ok(json_error_response(masked_status, masked_msg))
    }
}

/// POST /sponsor — proxy to sidecar POST /sponsor
pub async fn sponsor_proxy(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Response<Body>, AppError> {
    let (req, transaction_kind_bytes) = parse_sponsor_request(&body)?;
    validate_sponsor_transaction_kind(&transaction_kind_bytes, &state.config.package_id)?;
    authenticate_sponsor_request(&state, &req, &transaction_kind_bytes).await?;

    forward_sponsor(&state, &req).await
}

/// POST /sponsor/execute — proxy to sidecar POST /sponsor/execute
pub async fn sponsor_execute_proxy(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Response<Body>, AppError> {
    let req: SponsorExecuteRequest = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("Invalid request body".into()))?;

    if !validate_digest(&req.digest) {
        return Err(AppError::BadRequest("Invalid digest".into()));
    }

    let sender = req
        .sender
        .as_deref()
        .filter(|sender| validate_sui_address(sender))
        .ok_or_else(|| AppError::Unauthorized("Sponsor authorization required".into()))?;

    let sig_bytes = decode_base64(&req.signature)
        .ok_or_else(|| AppError::BadRequest("signature must be valid base64".into()))?;
    if !validate_sponsored_signature_len(sig_bytes.len()) {
        return Err(AppError::BadRequest(
            "signature has unexpected length".into(),
        ));
    }

    consume_pending_sponsor(&state, &req.digest, sender).await?;

    let (upstream_status, resp_body) =
        call_sidecar_sponsor_execute(&state, &req.digest, &req.signature, false).await?;

    if upstream_status.is_success() {
        Ok(Response::builder()
            .status(axum::http::StatusCode::from_u16(upstream_status.as_u16()).unwrap())
            .header("Content-Type", "application/json")
            .body(Body::from(resp_body))
            .unwrap())
    } else {
        crate::observability::record_sidecar_failure("sponsor_execute", "http_error");
        tracing::error!(
            "sponsor/execute upstream error {}: {}",
            upstream_status,
            String::from_utf8_lossy(&resp_body)
        );
        let (masked_status, masked_msg) = mask_upstream(upstream_status.as_u16());
        Ok(json_error_response(masked_status, masked_msg))
    }
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod more_tests {
    use super::*;

    fn move_call_kind(package: &str, module: &str, function: &str) -> Vec<u8> {
        let kind =
            TransactionKind::ProgrammableTransaction(sui_sdk_types::ProgrammableTransaction {
                inputs: vec![],
                commands: vec![Command::MoveCall(sui_sdk_types::MoveCall {
                    package: package.parse().unwrap(),
                    module: module.parse().unwrap(),
                    function: function.parse().unwrap(),
                    type_arguments: vec![],
                    arguments: vec![],
                })],
            });
        bcs::to_bytes(&kind).unwrap()
    }

    #[test]
    fn sponsor_authorization_message_matches_sdk_contract() {
        assert_eq!(
            sponsor_authorization_message(
                "0xabc",
                &[1, 2, 3],
                1_700_000_000,
                "00000000-0000-4000-8000-000000000000",
            ),
            "MemWal sponsor authorization\n\
sender: 0xabc\n\
transaction-kind-sha256: 039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81\n\
timestamp: 1700000000\n\
nonce: 00000000-0000-4000-8000-000000000000"
        );
    }

    #[test]
    fn sponsor_allowlist_only_accepts_one_memwal_account_call() {
        let package = format!("0x{}", "a".repeat(64));
        for function in ["create_account", "add_delegate_key", "remove_delegate_key"] {
            let bytes = move_call_kind(&package, "account", function);
            validate_sponsor_transaction_kind(&bytes, &package).unwrap();
        }

        let foreign_package = format!("0x{}", "b".repeat(64));
        let foreign = move_call_kind(&foreign_package, "account", "create_account");
        assert!(validate_sponsor_transaction_kind(&foreign, &package).is_err());

        let wrong_function = move_call_kind(&package, "account", "arbitrary_call");
        assert!(validate_sponsor_transaction_kind(&wrong_function, &package).is_err());

        let wrong_module = move_call_kind(&package, "coin", "transfer");
        assert!(validate_sponsor_transaction_kind(&wrong_module, &package).is_err());
    }

    // ---- validate_sui_address ----

    #[test]
    fn test_sui_address_valid() {
        assert!(validate_sui_address(
            "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
        ));
    }

    #[test]
    fn test_sui_address_all_zeros() {
        assert!(validate_sui_address(
            "0x0000000000000000000000000000000000000000000000000000000000000000"
        ));
    }

    #[test]
    fn test_sui_address_uppercase_hex_accepted() {
        assert!(validate_sui_address(&format!("0x{}", "A".repeat(64))));
    }

    #[test]
    fn test_sui_address_missing_0x_prefix() {
        assert!(!validate_sui_address(&"a".repeat(64)));
    }

    #[test]
    fn test_sui_address_too_short() {
        assert!(!validate_sui_address("0xBAD"));
    }

    #[test]
    fn test_sui_address_too_long() {
        assert!(!validate_sui_address(&format!("0x{}", "a".repeat(65))));
    }

    #[test]
    fn test_sui_address_non_hex_char() {
        // 'z' is not a hex digit
        let bad = format!("0x{}z{}", "a".repeat(32), "b".repeat(31));
        assert!(!validate_sui_address(&bad));
    }

    #[test]
    fn test_sui_address_empty() {
        assert!(!validate_sui_address(""));
    }

    // ---- validate_digest ----

    #[test]
    fn test_digest_valid_43_chars() {
        assert!(validate_digest(&"1".repeat(43)));
    }

    #[test]
    fn test_digest_valid_44_chars() {
        assert!(validate_digest(&"1".repeat(44)));
    }

    #[test]
    fn test_digest_valid_42_chars_leading_zero_encoding() {
        // 32-byte digests with leading zero bytes encode shorter than 43.
        assert!(validate_digest(&"1".repeat(42)));
    }

    #[test]
    fn test_digest_too_short_31() {
        assert!(!validate_digest(&"1".repeat(31)));
    }

    #[test]
    fn test_digest_too_long_45() {
        assert!(!validate_digest(&"1".repeat(45)));
    }

    #[test]
    fn test_digest_invalid_char_zero() {
        // '0' is excluded from base58
        let mut d: Vec<char> = "1".repeat(43).chars().collect();
        d[10] = '0';
        assert!(!validate_digest(&d.into_iter().collect::<String>()));
    }

    #[test]
    fn test_digest_invalid_char_capital_o() {
        let mut d: Vec<char> = "1".repeat(43).chars().collect();
        d[5] = 'O';
        assert!(!validate_digest(&d.into_iter().collect::<String>()));
    }

    #[test]
    fn test_digest_invalid_char_capital_i() {
        let mut d: Vec<char> = "1".repeat(43).chars().collect();
        d[0] = 'I';
        assert!(!validate_digest(&d.into_iter().collect::<String>()));
    }

    #[test]
    fn test_digest_invalid_char_lowercase_l() {
        let mut d: Vec<char> = "1".repeat(43).chars().collect();
        d[20] = 'l';
        assert!(!validate_digest(&d.into_iter().collect::<String>()));
    }

    #[test]
    fn test_digest_empty() {
        assert!(!validate_digest(""));
    }

    // ---- validate_sponsored_signature_len ----

    #[test]
    fn test_sponsored_signature_len_accepts_native_and_zklogin_sizes() {
        assert!(validate_sponsored_signature_len(65));
        assert!(validate_sponsored_signature_len(97));
        assert!(validate_sponsored_signature_len(512));
        assert!(validate_sponsored_signature_len(
            MAX_SPONSORED_SIGNATURE_BYTES
        ));
    }

    #[test]
    fn test_sponsored_signature_len_rejects_out_of_bounds() {
        assert!(!validate_sponsored_signature_len(64));
        assert!(!validate_sponsored_signature_len(
            MAX_SPONSORED_SIGNATURE_BYTES + 1
        ));
    }

    // ---- decode_base64 ----

    #[test]
    fn test_base64_valid_decodes() {
        let result = decode_base64("AAAAAAAAAAAAAAAA"); // 12 zero bytes
        assert!(result.is_some());
        assert_eq!(result.unwrap().len(), 12);
    }

    #[test]
    fn test_base64_invalid_returns_none() {
        assert!(decode_base64("not!!valid##base64").is_none());
    }

    #[test]
    fn test_base64_empty_decodes_to_empty() {
        let result = decode_base64("").unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_base64_exactly_10_bytes() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 10]);
        let decoded = decode_base64(&encoded).unwrap();
        assert_eq!(decoded.len(), 10);
    }

    #[test]
    fn test_base64_7000_bytes_passes_size_check() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 7000]);
        let decoded = decode_base64(&encoded).unwrap();
        assert_eq!(decoded.len(), 7000);
        assert!(decoded.len() >= 10 && decoded.len() <= 7000);
    }

    #[test]
    fn test_base64_7001_bytes_fails_size_check() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 7001]);
        let decoded = decode_base64(&encoded).unwrap();
        assert!(decoded.len() > 7000); // caller must reject this
    }

    // ---- mask_upstream — must never leak internal details ----

    #[test]
    fn test_mask_upstream_429_to_503() {
        let (status, msg) = mask_upstream(429);
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(msg, "Sponsor service temporarily overloaded");
    }

    #[test]
    fn test_mask_upstream_401_to_502() {
        let (status, msg) = mask_upstream(401);
        assert_eq!(status, axum::http::StatusCode::BAD_GATEWAY);
        assert_eq!(msg, "Sponsor service misconfigured");
    }

    #[test]
    fn test_mask_upstream_403_to_502() {
        let (status, msg) = mask_upstream(403);
        assert_eq!(status, axum::http::StatusCode::BAD_GATEWAY);
        assert_eq!(msg, "Sponsor service misconfigured");
    }

    #[test]
    fn test_mask_upstream_500_to_502() {
        let (status, msg) = mask_upstream(500);
        assert_eq!(status, axum::http::StatusCode::BAD_GATEWAY);
        assert_eq!(msg, "Sponsor service error");
    }

    #[test]
    fn test_mask_upstream_503_to_502() {
        let (status, msg) = mask_upstream(503);
        assert_eq!(status, axum::http::StatusCode::BAD_GATEWAY);
        assert_eq!(msg, "Sponsor service error");
    }

    #[test]
    fn test_mask_upstream_404_to_400() {
        let (status, msg) = mask_upstream(404);
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(msg, "Sponsor request rejected");
    }

    #[test]
    fn test_mask_upstream_returns_static_strings_only() {
        // Verify no dynamic content leaks through for any common error code
        for code in [400u16, 401, 403, 404, 422, 429, 500, 502, 503] {
            let (_, msg) = mask_upstream(code);
            assert!(!msg.is_empty(), "mask must always return a message");
            // Message must not look like it came from serde_json / reqwest
            assert!(!msg.contains("Error"), "raw error strings must not leak");
        }
    }
}
