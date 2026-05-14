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
use std::sync::Arc;

use crate::rate_limit;
use crate::types::*;

/// Sui transaction signatures are serialized as base64 bytes — native
/// schemes are 65/97 bytes, zkLogin signatures are variable-size payloads.
/// Upper bound to reject obviously oversized inputs before any work.
const MAX_SPONSORED_SIGNATURE_BYTES: usize = 2048;

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
fn validate_sui_address(s: &str) -> bool {
    s.starts_with("0x") && s.len() == 66 && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Validate base64 and return decoded bytes, or None on failure.
fn decode_base64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// Validate a Sui transaction digest: base58 alphabet, 43 or 44 characters.
fn validate_digest(s: &str) -> bool {
    let len = s.len();
    if len != 43 && len != 44 {
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
fn validate_sponsored_signature_len(len: usize) -> bool {
    (65..=MAX_SPONSORED_SIGNATURE_BYTES).contains(&len)
}

/// POST /sponsor — proxy to sidecar POST /sponsor
pub async fn sponsor_proxy(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Result<Response<Body>, AppError> {
    // Parse and validate — never echo back client-supplied values in errors.
    let req: SponsorRequest = serde_json::from_slice(&body)
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

    // Per-sender rate limit — second axis that a distributed IP attack cannot bypass.
    // Runs after validation so we only count well-formed requests against the sender.
    {
        let config = &state.config.sponsor_rate_limit;
        match rate_limit::check_sender_rate_limit(
            &state,
            &req.sender,
            config.per_minute,
            config.per_hour,
        )
        .await
        {
            Ok(rate_limit::SponsorRlResult::MinuteLimitExceeded) => {
                tracing::warn!(
                    "sponsor rate limit [sender/min]: sender={}...",
                    &req.sender[..16]
                );
                return Ok(json_error_response(
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    "Rate limit exceeded",
                ));
            }
            Ok(rate_limit::SponsorRlResult::HourLimitExceeded) => {
                tracing::warn!(
                    "sponsor rate limit [sender/hr]: sender={}...",
                    &req.sender[..16]
                );
                return Ok(json_error_response(
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    "Rate limit exceeded",
                ));
            }
            Ok(rate_limit::SponsorRlResult::Allowed) => {}
            Err(_) => {
                // HIGH-2: Redis and in-memory fallback both unavailable — deny to fail-closed.
                tracing::error!(
                    "sponsor sender rate limit unavailable for sponsor_proxy, denying request"
                );
                return Ok(json_error_response(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "Rate limiter temporarily unavailable",
                ));
            }
        }
    }

    // Re-serialise only validated fields before forwarding.
    let forwarded = serde_json::json!({
        "sender": req.sender,
        "transactionBlockKindBytes": req.transaction_block_kind_bytes,
    });

    let url = format!("{}/sponsor", state.config.sidecar_url);
    let mut req = state
        .http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&forwarded);
    if let Some(secret) = state.config.sidecar_secret.as_deref() {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor proxy failed: {}", e)))?;

    let upstream_status = resp.status();
    let resp_body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor proxy read failed: {}", e)))?;

    if upstream_status.is_success() {
        Ok(Response::builder()
            .status(axum::http::StatusCode::from_u16(upstream_status.as_u16()).unwrap())
            .header("Content-Type", "application/json")
            .body(Body::from(resp_body))
            .unwrap())
    } else {
        tracing::error!(
            "sponsor upstream error {}: {}",
            upstream_status,
            String::from_utf8_lossy(&resp_body)
        );
        let (masked_status, masked_msg) = mask_upstream(upstream_status.as_u16());
        Ok(json_error_response(masked_status, masked_msg))
    }
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

    let sig_bytes = decode_base64(&req.signature)
        .ok_or_else(|| AppError::BadRequest("signature must be valid base64".into()))?;
    if !validate_sponsored_signature_len(sig_bytes.len()) {
        return Err(AppError::BadRequest(
            "signature has unexpected length".into(),
        ));
    }

    // Per-sender rate limit — same axis as /sponsor.
    // `sender` is optional on this endpoint; when absent the per-IP limit (middleware) is the only gate.
    if let Some(ref sender) = req.sender {
        if !validate_sui_address(sender) {
            return Err(AppError::BadRequest("Invalid sender address".into()));
        }
        let config = &state.config.sponsor_rate_limit;
        match rate_limit::check_sender_rate_limit(
            &state,
            sender,
            config.per_minute,
            config.per_hour,
        )
        .await
        {
            Ok(rate_limit::SponsorRlResult::MinuteLimitExceeded) => {
                tracing::warn!(
                    "sponsor/execute rate limit [sender/min]: sender={}...",
                    &sender[..16]
                );
                return Ok(json_error_response(
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    "Rate limit exceeded",
                ));
            }
            Ok(rate_limit::SponsorRlResult::HourLimitExceeded) => {
                tracing::warn!(
                    "sponsor/execute rate limit [sender/hr]: sender={}...",
                    &sender[..16]
                );
                return Ok(json_error_response(
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    "Rate limit exceeded",
                ));
            }
            Ok(rate_limit::SponsorRlResult::Allowed) => {}
            Err(_) => {
                // HIGH-2: Redis and in-memory fallback both unavailable — deny to fail-closed.
                tracing::error!("sponsor/execute sender rate limit unavailable, denying request");
                return Ok(json_error_response(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "Rate limiter temporarily unavailable",
                ));
            }
        }
    }

    let forwarded = serde_json::json!({
        "digest": req.digest,
        "signature": req.signature,
    });

    let url = format!("{}/sponsor/execute", state.config.sidecar_url);
    let mut req = state
        .http_client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&forwarded);
    if let Some(secret) = state.config.sidecar_secret.as_deref() {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor execute proxy failed: {}", e)))?;

    let upstream_status = resp.status();
    let resp_body = resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("Sponsor execute proxy read failed: {}", e)))?;

    if upstream_status.is_success() {
        Ok(Response::builder()
            .status(axum::http::StatusCode::from_u16(upstream_status.as_u16()).unwrap())
            .header("Content-Type", "application/json")
            .body(Body::from(resp_body))
            .unwrap())
    } else {
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
    fn test_digest_too_short_42() {
        assert!(!validate_digest(&"1".repeat(42)));
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
