//! Enoki client — sponsored Sui transactions over plain HTTPS (ENG-1700).
//!
//! Replaces the deleted Node sidecar's `/sponsor` and `/sponsor/execute`
//! proxies with a direct `reqwest` client to `api.enoki.mystenlabs.com`.
//! Bearer-authed with `ENOKI_API_KEY`.
//!
//! Endpoints used:
//! - `POST /v1/transaction-blocks/sponsor`
//!     body: `{ network, transactionBlockKindBytes, sender, allowedAddresses?, allowedMoveCallTargets? }`
//!     200: `{ data: { bytes: base64, digest: base58 } }`
//! - `POST /v1/transaction-blocks/sponsor/{digest}`
//!     body: `{ signature: base64 }`
//!     200: `{ data: { digest: base58 } }`

use std::time::Duration;

const ENOKI_BASE_URL: &str = "https://api.enoki.mystenlabs.com";

#[derive(Debug, thiserror::Error)]
pub enum EnokiError {
    #[error("Enoki not configured (ENOKI_API_KEY unset)")]
    NotConfigured,
    #[error("Enoki auth failed (401)")]
    Auth,
    #[error("Enoki bad request: {0}")]
    BadRequest(String),
    #[error("Enoki rate-limited (429)")]
    RateLimit,
    #[error("Enoki server error ({status}): {body}")]
    Server { status: u16, body: String },
    #[error("Enoki network: {0}")]
    Network(String),
    #[error("Enoki decode: {0}")]
    Decode(String),
}

impl EnokiError {
    /// Map upstream Enoki error → HTTP status to return to our caller.
    /// Masks server internals (no upstream body forwarded for 5xx).
    pub fn to_status(&self) -> u16 {
        match self {
            EnokiError::NotConfigured => 503,
            EnokiError::RateLimit => 503,
            EnokiError::Auth => 502,
            EnokiError::BadRequest(_) => 400,
            EnokiError::Server { .. } => 502,
            EnokiError::Network(_) => 502,
            EnokiError::Decode(_) => 502,
        }
    }
}

/// Successful response from `POST /v1/transaction-blocks/sponsor`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SponsorResult {
    /// Sponsor-wrapped transaction bytes (base64).
    pub bytes: String,
    /// Transaction digest (base58, 43-44 chars).
    pub digest: String,
}

/// Successful response from `POST /v1/transaction-blocks/sponsor/{digest}`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExecuteResult {
    pub digest: String,
}

/// Wrapper Enoki uses for all responses: `{ "data": { ... } }`.
#[derive(Debug, serde::Deserialize)]
struct EnokiEnvelope<T> {
    data: T,
}

#[derive(Clone)]
pub struct EnokiClient {
    api_key: Option<String>,
    network: String,
    base_url: String,
    http: reqwest::Client,
}

impl EnokiClient {
    pub fn new(api_key: Option<String>, network: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client builder");
        Self {
            api_key,
            network,
            base_url: ENOKI_BASE_URL.to_string(),
            http,
        }
    }

    /// True when ENOKI_API_KEY is set. Caller can return 503 fast-path otherwise.
    pub fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    /// `POST /v1/transaction-blocks/sponsor`
    ///
    /// `tx_kind_bytes_b64` is the base64-encoded `TransactionKind` bytes
    /// produced by the client (no gas, no sender).
    ///
    /// `allowed_addresses` is a per-call dynamic allow-list. When non-empty,
    /// Enoki permits the listed addresses to receive `transfer_objects`
    /// recipients in the sponsored tx — necessary for multi-tenant flows
    /// where the recipient (a user wallet) is not pre-allow-listed at the
    /// API-key level. Pass `&[]` to omit the field entirely.
    pub async fn sponsor(
        &self,
        sender: &str,
        tx_kind_bytes_b64: &str,
        allowed_addresses: &[&str],
    ) -> Result<SponsorResult, EnokiError> {
        let api_key = self.api_key.as_deref().ok_or(EnokiError::NotConfigured)?;
        let url = format!("{}/v1/transaction-blocks/sponsor", self.base_url);

        let mut body = serde_json::json!({
            "network": self.network,
            "transactionBlockKindBytes": tx_kind_bytes_b64,
            "sender": sender,
        });
        if !allowed_addresses.is_empty() {
            body["allowedAddresses"] = serde_json::Value::Array(
                allowed_addresses
                    .iter()
                    .map(|s| serde_json::Value::String((*s).to_string()))
                    .collect(),
            );
        }

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| EnokiError::Network(e.to_string()))?;

        let status = resp.status();
        let resp_text = resp
            .text()
            .await
            .map_err(|e| EnokiError::Network(format!("read body: {}", e)))?;

        if status.is_success() {
            let env: EnokiEnvelope<SponsorResult> = serde_json::from_str(&resp_text)
                .map_err(|e| EnokiError::Decode(format!("sponsor envelope: {}", e)))?;
            return Ok(env.data);
        }

        Err(map_status_error(status.as_u16(), resp_text))
    }

    /// `POST /v1/transaction-blocks/sponsor/{digest}`
    ///
    /// `signature_b64` is the user's signature over the bytes returned by
    /// `sponsor()`. Digest is percent-encoded into the URL path to prevent
    /// path-traversal-like injection.
    pub async fn sponsor_execute(
        &self,
        digest: &str,
        signature_b64: &str,
    ) -> Result<ExecuteResult, EnokiError> {
        let api_key = self.api_key.as_deref().ok_or(EnokiError::NotConfigured)?;
        // PATH_SEGMENT encoding handles slashes, but digests are base58 so they
        // contain only alphanumerics — encoding is purely defense-in-depth.
        let digest_enc = percent_encoding::utf8_percent_encode(
            digest,
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        let url = format!("{}/v1/transaction-blocks/sponsor/{}", self.base_url, digest_enc);

        let body = serde_json::json!({ "signature": signature_b64 });

        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| EnokiError::Network(e.to_string()))?;

        let status = resp.status();
        let resp_text = resp
            .text()
            .await
            .map_err(|e| EnokiError::Network(format!("read body: {}", e)))?;

        if status.is_success() {
            let env: EnokiEnvelope<ExecuteResult> = serde_json::from_str(&resp_text)
                .map_err(|e| EnokiError::Decode(format!("execute envelope: {}", e)))?;
            return Ok(env.data);
        }

        Err(map_status_error(status.as_u16(), resp_text))
    }
}

fn map_status_error(status: u16, body: String) -> EnokiError {
    match status {
        401 | 403 => EnokiError::Auth,
        429 => EnokiError::RateLimit,
        400..=499 => EnokiError::BadRequest(body),
        500..=599 => EnokiError::Server { status, body },
        _ => EnokiError::Server { status, body },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enoki_error_status_mapping() {
        assert_eq!(EnokiError::NotConfigured.to_status(), 503);
        assert_eq!(EnokiError::RateLimit.to_status(), 503);
        assert_eq!(EnokiError::Auth.to_status(), 502);
        assert_eq!(EnokiError::BadRequest("x".into()).to_status(), 400);
        assert_eq!(
            EnokiError::Server {
                status: 500,
                body: "x".into()
            }
            .to_status(),
            502
        );
        assert_eq!(EnokiError::Network("x".into()).to_status(), 502);
    }

    #[test]
    fn map_status_error_buckets() {
        assert!(matches!(map_status_error(429, "x".into()), EnokiError::RateLimit));
        assert!(matches!(map_status_error(401, "x".into()), EnokiError::Auth));
        assert!(matches!(map_status_error(403, "x".into()), EnokiError::Auth));
        assert!(matches!(
            map_status_error(400, "x".into()),
            EnokiError::BadRequest(_)
        ));
        assert!(matches!(
            map_status_error(500, "x".into()),
            EnokiError::Server { .. }
        ));
        assert!(matches!(
            map_status_error(503, "x".into()),
            EnokiError::Server { .. }
        ));
    }

    #[test]
    fn client_is_configured() {
        let c = EnokiClient::new(None, "mainnet".into());
        assert!(!c.is_configured());

        let c = EnokiClient::new(Some("k".into()), "mainnet".into());
        assert!(c.is_configured());
    }
}
