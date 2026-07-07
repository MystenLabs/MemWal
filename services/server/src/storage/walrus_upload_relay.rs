//! Walrus Upload Relay HTTP client (WALM-184: Walrus write-path migration,
//! step 3 of 3 — upload). The relay accepts raw unencoded blob bytes for an
//! already-registered blob, pushes the encoded slivers to the storage node
//! committee itself, and returns a `ConfirmationCertificate` — the exact
//! signature/bitmap/message `certify_blob` needs
//! (`storage::walrus_tx::certify_blob_inputs`).
//!
//! Wire protocol cross-checked against
//! `crates/walrus-upload-relay/upload_relay_openapi.yaml` and the real
//! client implementation in `crates/walrus-sdk/src/upload_relay.rs` +
//! `crates/walrus-sdk/src/node_client/upload_relay_client.rs` in the walrus
//! repo — not reverse-engineered from the OpenAPI spec alone, since that
//! spec doesn't document the response body schema (only "200: success").
//!
//! `walrus-sdk`'s own `TipConfig`/`TipKind` types depend on
//! `sui_types::base_types::SuiAddress` (the full Sui monorepo — see the
//! module doc on `storage::sui_tx` for why that can't be a dependency of
//! this server), so `tip_config()` here parses the same JSON shape with
//! plain `serde_json::Value` navigation instead of importing those types —
//! cross-checked live: `GET https://upload-relay.testnet.walrus.space/v1/
//! tip-config` returned
//! `{"send_tip":{"address":"0x4b6a...","kind":{"const":105}}}` while
//! writing this, matching the `TipConfig::SendTip` shape below exactly.

use walrus_core::messages::ConfirmationCertificate;
use walrus_core::BlobId;

pub const BLOB_UPLOAD_RELAY_ROUTE: &str = "/v1/blob-upload-relay";
pub const TIP_CONFIG_ROUTE: &str = "/v1/tip-config";

#[derive(Debug)]
pub enum UploadRelayError {
    Http(String),
    /// The relay's response didn't match the expected shape.
    UnexpectedResponse(String),
    /// The relay rejected the upload (e.g. blob not registered, tip missing
    /// or wrong nonce) — response status + body, for the caller to inspect.
    /// Check `fetch_tip_config` beforehand and pay the tip (a separate,
    /// fund-moving Sui transaction) if `TipRequirement::SendTip` — paying
    /// it is not automated by this client (see `storage::sui_tx::
    /// execute_move_call`); an unpaid upload against a tip-requiring relay
    /// surfaces here as `Rejected`, not a distinct variant.
    Rejected { status: u16, body: String },
}

impl std::fmt::Display for UploadRelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(m) => write!(f, "upload relay HTTP error: {m}"),
            Self::UnexpectedResponse(m) => write!(f, "unexpected upload relay response: {m}"),
            Self::Rejected { status, body } => {
                write!(f, "upload relay rejected the request (status {status}): {body}")
            }
        }
    }
}

impl std::error::Error for UploadRelayError {}

/// Whether the relay requires a paid tip before accepting uploads, and how
/// much. `GET /v1/tip-config` — read-only, no funds moved by calling this.
#[derive(Debug, PartialEq)]
pub enum TipRequirement {
    NoTip,
    /// A tip must be sent to `address`. `const_amount` is populated for the
    /// `TipKind::Const` case (the only kind this client currently parses —
    /// `TipKind::Linear`, which scales with blob size, is not yet
    /// implemented and reports `const_amount: None`).
    SendTip { address: String, const_amount: Option<u64> },
}

/// Query the relay's tip configuration.
pub async fn fetch_tip_config(
    client: &reqwest::Client,
    relay_base_url: &str,
) -> Result<TipRequirement, UploadRelayError> {
    let url = format!("{}{}", relay_base_url.trim_end_matches('/'), TIP_CONFIG_ROUTE);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| UploadRelayError::Http(e.to_string()))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| UploadRelayError::Http(format!("invalid JSON: {e}")))?;

    if !status.is_success() {
        return Err(UploadRelayError::Rejected {
            status: status.as_u16(),
            body: body.to_string(),
        });
    }

    if body.as_str() == Some("no_tip") {
        return Ok(TipRequirement::NoTip);
    }
    let address = body
        .pointer("/send_tip/address")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            UploadRelayError::UnexpectedResponse(format!("tip-config response: {body}"))
        })?
        .to_string();
    let const_amount = body.pointer("/send_tip/kind/const").and_then(|v| v.as_u64());
    Ok(TipRequirement::SendTip { address, const_amount })
}

/// Upload an already-registered blob's raw (unencoded) bytes to the relay
/// and return the confirmation certificate `certify_blob` needs.
///
/// `blob_id` must be the same value already passed to `register_blob`
/// (`storage::walrus_encode::BlobMetadata::blob_id`). Does not handle tips —
/// call `fetch_tip_config` first; if it returns `SendTip`, the caller must
/// pay it (a separate, fund-moving Sui transaction) and pass the resulting
/// `tx_id`/`nonce` — not yet plumbed through this function's signature,
/// since no caller needs it yet (see module doc: not wired into any route).
pub async fn upload_blob(
    client: &reqwest::Client,
    relay_base_url: &str,
    blob_id: [u8; 32],
    blob_bytes: &[u8],
) -> Result<ConfirmationCertificate, UploadRelayError> {
    let blob_id = BlobId(blob_id);
    let url = format!(
        "{}{}?blob_id={}",
        relay_base_url.trim_end_matches('/'),
        BLOB_UPLOAD_RELAY_ROUTE,
        blob_id, // Display impl is base64url, URL_SAFE_NO_PAD — exactly what the relay expects as a query param.
    );

    let resp = client
        .post(&url)
        .header("Content-Type", "application/octet-stream")
        .body(blob_bytes.to_vec())
        .send()
        .await
        .map_err(|e| UploadRelayError::Http(e.to_string()))?;
    let status = resp.status();
    let body_bytes = resp
        .bytes()
        .await
        .map_err(|e| UploadRelayError::Http(format!("failed to read response body: {e}")))?;

    if !status.is_success() {
        return Err(UploadRelayError::Rejected {
            status: status.as_u16(),
            body: String::from_utf8_lossy(&body_bytes).into_owned(),
        });
    }

    #[derive(serde::Deserialize)]
    struct ResponseType {
        blob_id: BlobId,
        confirmation_certificate: ConfirmationCertificate,
    }

    let parsed: ResponseType = serde_json::from_slice(&body_bytes).map_err(|e| {
        UploadRelayError::UnexpectedResponse(format!(
            "failed to parse relay response: {e} (body: {})",
            String::from_utf8_lossy(&body_bytes)
        ))
    })?;

    if parsed.blob_id != blob_id {
        return Err(UploadRelayError::UnexpectedResponse(format!(
            "relay returned blob_id {} but expected {blob_id}",
            parsed.blob_id
        )));
    }

    Ok(parsed.confirmation_certificate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "hits the live public Walrus testnet upload relay — run explicitly with `cargo test -- --ignored`"]
    async fn fetch_tip_config_reads_the_real_testnet_relay() {
        // Live read-only check (GET request, no funds moved) against
        // Mysten's public testnet upload relay. Confirms this module's JSON
        // parsing matches the real response shape, not just the one sample
        // response captured by hand while writing this file.
        let client = reqwest::Client::new();
        let tip = fetch_tip_config(&client, "https://upload-relay.testnet.walrus.space")
            .await
            .unwrap();
        match tip {
            TipRequirement::SendTip { address, const_amount } => {
                assert!(address.starts_with("0x"));
                assert!(const_amount.is_some());
            }
            TipRequirement::NoTip => {
                // The relay could stop requiring a tip in the future; either
                // outcome is a valid, successfully-parsed response.
            }
        }
    }

    #[tokio::test]
    #[ignore = "hits the live public Walrus testnet upload relay — run explicitly with `cargo test -- --ignored`"]
    async fn upload_blob_without_paying_tip_is_rejected_cleanly() {
        // The testnet relay requires a tip (confirmed live via
        // fetch_tip_config), so an unpaid upload attempt must be rejected
        // by the relay, not silently accepted or panic this client. No
        // funds are moved by this call either way — it's just an HTTP POST
        // with no prior payment, which the relay's own tip-verification
        // logic rejects server-side.
        let client = reqwest::Client::new();
        let result = upload_blob(
            &client,
            "https://upload-relay.testnet.walrus.space",
            [0u8; 32],
            b"test blob that was never registered or paid for",
        )
        .await;
        assert!(matches!(result, Err(UploadRelayError::Rejected { .. })));
    }
}
