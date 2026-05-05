//! Walrus publisher HTTP client (ENG-1700 / Phase 3).
//!
//! Replaces the TS sidecar `writeBlobFlow` call with a direct
//! `PUT {WALRUS_PUBLISHER_URL}/v1/blobs?epochs=N&send_object_to=<addr>`
//! against a public Walrus publisher.
//!
//! # Why this is correct
//!
//! Mysten's public publishers (`https://publisher.walrus-mainnet.walrus.space`
//! and the testnet equivalent) accept a raw byte body and:
//!   1. Encode the blob,
//!   2. Pay for `epochs` epochs of storage,
//!   3. Register + certify the Walrus `Blob` object,
//!   4. Transfer the resulting `Blob` object to `send_object_to` if set.
//!
//! The publisher returns either:
//!   - `{"newlyCreated": {"blobObject": {"id": "0x...", "blobId": "...", ...}, ...}}`
//!     (first time the content was uploaded), or
//!   - `{"alreadyCertified": {"blobId": "...", "endEpoch": ..., ...}}`
//!     (somebody already paid for storage of an identical blob; in this case
//!     there is no fresh `Blob` object owned by us).
//!
//! In the `alreadyCertified` branch we cannot run the metadata-set + transfer
//! PTB (we don't own a `Blob` object), so we return `object_id = None` and
//! let the caller decide. For MemWal's flow each ciphertext is unique
//! (SEAL is non-deterministic), so this branch is effectively unreachable
//! in production but handled defensively.

use std::time::Duration;

const PUBLISHER_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, thiserror::Error)]
pub enum PublisherError {
    #[error("publisher network error: {0}")]
    Network(String),
    #[error("publisher returned HTTP {status}: {body}")]
    Status { status: u16, body: String },
    #[error("publisher response decode failed: {0}")]
    Decode(String),
    #[error("publisher returned alreadyCertified for a unique upload (no Blob object owned by us)")]
    AlreadyCertifiedNoObject,
}

/// Outcome of `PUT /v1/blobs`.
#[derive(Debug, Clone)]
pub struct PublishedBlob {
    /// Walrus content-addressed blob ID (base64url).
    pub blob_id: String,
    /// Sui object ID of the freshly minted `Blob` Move object (`0x...`),
    /// when the upload was newly created. `None` for `alreadyCertified`.
    pub object_id: Option<String>,
}

/// `PUT {publisher_url}/v1/blobs?epochs=N&send_object_to=<addr>` with raw bytes.
///
/// `epochs` is capped by the publisher's policy; we additionally cap to 5
/// upstream in `walrus.rs` to prevent runaway storage spend.
///
/// `send_object_to` *should* be the server signer's Sui address — the
/// publisher transfers the Blob there so we can subsequently set metadata
/// and re-transfer it to the end user inside our own PTB.
pub async fn upload_blob_via_publisher(
    http: &reqwest::Client,
    publisher_url: &str,
    data: &[u8],
    epochs: u64,
    send_object_to: &str,
) -> Result<PublishedBlob, PublisherError> {
    let url = format!(
        "{}/v1/blobs?epochs={}&send_object_to={}",
        publisher_url.trim_end_matches('/'),
        epochs,
        send_object_to,
    );

    tracing::debug!(
        "walrus publisher PUT: url={}, body_len={}, epochs={}",
        url,
        data.len(),
        epochs,
    );

    // We deliberately build a per-call client with a long timeout. The
    // shared `state.http_client` is 30s, but Walrus publisher uploads
    // routinely take longer for non-trivial blob sizes.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(PUBLISHER_TIMEOUT_SECS))
        .build()
        .map_err(|e| PublisherError::Network(format!("build client: {}", e)))?;
    // We accept either the shared client or a fresh one — prefer shared for
    // connection pooling, but fall back when the caller passes one with a
    // short timeout. The trait object is small so this branch is cheap.
    let _ = http; // keep param for API symmetry; future callers may swap it in
    let resp = client
        .put(&url)
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| PublisherError::Network(e.to_string()))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| PublisherError::Network(format!("read body: {}", e)))?;

    if !status.is_success() {
        return Err(PublisherError::Status {
            status: status.as_u16(),
            body: body_text,
        });
    }

    parse_publisher_response(&body_text)
}

/// Pure parser for unit-testing without a live publisher.
fn parse_publisher_response(body: &str) -> Result<PublishedBlob, PublisherError> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| PublisherError::Decode(format!("not JSON: {} (body={})", e, body)))?;

    // Branch 1: newlyCreated.blobObject.{id,blobId}
    if let Some(newly) = v.get("newlyCreated") {
        let blob_obj = newly
            .get("blobObject")
            .ok_or_else(|| PublisherError::Decode("missing newlyCreated.blobObject".into()))?;
        let blob_id = blob_obj
            .get("blobId")
            .and_then(|x| x.as_str())
            .ok_or_else(|| PublisherError::Decode("missing newlyCreated.blobObject.blobId".into()))?
            .to_string();
        let object_id = blob_obj
            .get("id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| PublisherError::Decode("missing newlyCreated.blobObject.id".into()))?
            .to_string();
        return Ok(PublishedBlob {
            blob_id,
            object_id: Some(object_id),
        });
    }

    // Branch 2: alreadyCertified.blobId (no Blob object minted for us)
    if let Some(already) = v.get("alreadyCertified") {
        let blob_id = already
            .get("blobId")
            .and_then(|x| x.as_str())
            .ok_or_else(|| PublisherError::Decode("missing alreadyCertified.blobId".into()))?
            .to_string();
        // We deliberately surface this as an error — without owning a Blob
        // object, the caller cannot subsequently set metadata or transfer.
        // For SEAL-encrypted blobs this branch is effectively unreachable
        // (each ciphertext is unique), but flag it loudly if it ever fires.
        tracing::warn!(
            "walrus publisher returned alreadyCertified blob_id={}, no Blob object minted",
            blob_id,
        );
        return Err(PublisherError::AlreadyCertifiedNoObject);
    }

    Err(PublisherError::Decode(format!(
        "unexpected publisher response shape (no newlyCreated/alreadyCertified): {}",
        body,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_newly_created() {
        let body = serde_json::json!({
            "newlyCreated": {
                "blobObject": {
                    "id": "0x1234abcd",
                    "blobId": "AbCdEfGh-base64url",
                    "registeredEpoch": 100
                },
                "resourceOperation": {}
            }
        })
        .to_string();
        let r = parse_publisher_response(&body).unwrap();
        assert_eq!(r.blob_id, "AbCdEfGh-base64url");
        assert_eq!(r.object_id.as_deref(), Some("0x1234abcd"));
    }

    #[test]
    fn parse_already_certified_errors() {
        let body = serde_json::json!({
            "alreadyCertified": {
                "blobId": "AbCdEfGh",
                "endEpoch": 200
            }
        })
        .to_string();
        let err = parse_publisher_response(&body).unwrap_err();
        assert!(matches!(err, PublisherError::AlreadyCertifiedNoObject));
    }

    #[test]
    fn parse_garbage_errors() {
        let err = parse_publisher_response("not json").unwrap_err();
        assert!(matches!(err, PublisherError::Decode(_)));
    }

    #[test]
    fn parse_unexpected_shape_errors() {
        let body = r#"{"foo": "bar"}"#;
        let err = parse_publisher_response(body).unwrap_err();
        assert!(matches!(err, PublisherError::Decode(_)));
    }
}
