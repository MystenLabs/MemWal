use crate::types::AppError;

const WALRUS_TESTNET_AGGREGATOR: &str = "https://aggregator.walrus-testnet.walrus.space";
const WALRUS_TESTNET_PUBLISHER: &str = "https://publisher.walrus-testnet.walrus.space";

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    /// Only available for newly created blobs
    pub object_id: Option<String>,
}

/// Upload an encrypted blob to Walrus via the Publisher HTTP API.
///
/// Returns the blob ID and (if newly created) the Sui object ID.
/// The blob object is transferred to `owner_address` via `send_object_to`.
pub async fn upload_blob(
    client: &reqwest::Client,
    data: &[u8],
    epochs: u32,
    owner_address: &str,
) -> Result<UploadResult, AppError> {
    let url = format!(
        "{}/v1/blobs?epochs={}&send_object_to={}",
        WALRUS_TESTNET_PUBLISHER, epochs, owner_address
    );

    let response = client
        .put(&url)
        .header("Content-Type", "application/octet-stream")
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Walrus upload failed: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        return Err(AppError::Internal(format!(
            "Walrus upload HTTP {}: {}",
            status, body
        )));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Walrus response parse error: {}", e)))?;

    // Response can be either:
    // { "newlyCreated": { "blobObject": { "id": "0x...", "blobId": "..." } } }
    // { "alreadyCertified": { "blobId": "..." } }

    if let Some(newly_created) = body.get("newlyCreated") {
        let blob_object = newly_created.get("blobObject").ok_or_else(|| {
            AppError::Internal("newlyCreated missing blobObject".into())
        })?;

        let blob_id = blob_object
            .get("blobId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Internal("blobObject missing blobId".into()))?;

        let object_id = blob_object
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        tracing::info!(
            "📦 Walrus upload OK (new): blobId={}, objectId={}, owner={}",
            blob_id,
            object_id.as_deref().unwrap_or("?"),
            owner_address
        );

        if let Some(ref oid) = object_id {
            tracing::info!(
                "  → Blob object {} transferred to user {}",
                oid, owner_address
            );
        }

        Ok(UploadResult {
            blob_id: blob_id.to_string(),
            object_id,
        })
    } else if let Some(already_certified) = body.get("alreadyCertified") {
        let blob_id = already_certified
            .get("blobId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Internal("alreadyCertified missing blobId".into()))?;

        tracing::info!("📦 Walrus upload OK (existing): blobId={}", blob_id);

        Ok(UploadResult {
            blob_id: blob_id.to_string(),
            object_id: None, // Already certified, no new object created
        })
    } else {
        Err(AppError::Internal(format!(
            "Walrus response unknown format: {}",
            serde_json::to_string_pretty(&body).unwrap_or_default()
        )))
    }
}

/// Download a blob from Walrus via the Aggregator HTTP API.
///
/// Returns the raw bytes of the blob.
pub async fn download_blob(
    client: &reqwest::Client,
    blob_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/v1/blobs/{}", WALRUS_TESTNET_AGGREGATOR, blob_id);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Walrus download failed: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        return Err(AppError::Internal(format!(
            "Walrus download HTTP {}: {}",
            status, body
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("Walrus download read error: {}", e)))?;

    tracing::info!(
        "📥 Walrus download OK: blobId={}, {} bytes",
        blob_id,
        bytes.len()
    );
    Ok(bytes.to_vec())
}
