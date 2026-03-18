use crate::types::{AppError, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    #[allow(dead_code)]
    pub object_id: Option<String>,
}

/// Request/response types for sidecar HTTP API
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WalrusUploadRequest {
    data: String,
    private_key: String,
    owner: String,
    epochs: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalrusUploadResponse {
    blob_id: String,
    object_id: Option<String>,
}

/// Upload an encrypted blob to Walrus via the HTTP sidecar.
///
/// Calls the long-lived sidecar server at `POST /walrus/upload` which uses
/// `@mysten/walrus` SDK with the multi-step writeBlobFlow.
///
/// The server wallet pays for gas + storage, and the blob is
/// registered under the signer's address.
pub async fn upload_blob(
    client: &reqwest::Client,
    sidecar_url: &str,
    data: &[u8],
    epochs: u64,
    owner_address: &str,
    sui_private_key: &str,
) -> Result<UploadResult, AppError> {
    let url = format!("{}/walrus/upload", sidecar_url);
    let data_b64 = BASE64.encode(data);

    let resp = client
        .post(&url)
        .json(&WalrusUploadRequest {
            data: data_b64,
            private_key: sui_private_key.to_string(),
            owner: owner_address.to_string(),
            epochs,
        })
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(format!("Sidecar walrus/upload request failed: {}. Is the sidecar running?", e))
        })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!("walrus upload failed: {}", err.error)));
        }
        return Err(AppError::Internal(format!("walrus upload failed: {}", body)));
    }

    let result: WalrusUploadResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse walrus/upload response: {}", e))
    })?;

    tracing::info!(
        "walrus upload via sidecar ok: blob_id={}, object_id={:?}, owner={}",
        result.blob_id,
        result.object_id,
        owner_address
    );

    Ok(UploadResult {
        blob_id: result.blob_id,
        object_id: result.object_id,
    })
}

/// Download a blob from Walrus via the walrus_rs SDK (Aggregator HTTP API).
/// Note: this is already native Rust — no sidecar needed.
///
/// Returns `AppError::BlobNotFound` when the blob has expired or doesn't exist
/// (HTTP 404 from the aggregator). Callers can use this to trigger DB cleanup.
pub async fn download_blob(
    walrus_client: &walrus_rs::WalrusClient,
    blob_id: &str,
) -> Result<Vec<u8>, AppError> {
    let bytes = walrus_client
        .read_blob_by_id(blob_id)
        .await
        .map_err(|e| {
            let err_str = e.to_string();
            // Detect expired / missing blobs (walrus_rs surfaces HTTP 404 as error string)
            let is_not_found = err_str.contains("404")
                || err_str.to_lowercase().contains("not found")
                || err_str.to_lowercase().contains("blob not found");
            if is_not_found {
                AppError::BlobNotFound(format!("Blob {} expired or not found: {}", blob_id, err_str))
            } else {
                AppError::Internal(format!("Walrus download failed: {}", err_str))
            }
        })?;

    tracing::info!(
        "walrus download ok: blob_id={}, {} bytes",
        blob_id,
        bytes.len()
    );
    Ok(bytes)
}
