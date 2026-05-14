use crate::types::{AppError, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::time::Duration;

const SIDECAR_WALRUS_TIMEOUT: Duration = Duration::from_secs(180);

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    #[allow(dead_code)]
    pub object_id: Option<String>,
}

/// A blob discovered from on-chain query
#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct OnChainBlob {
    /// Walrus blob ID
    #[serde(rename = "blobId")]
    pub blob_id: String,
    /// Sui object ID
    #[serde(rename = "objectId")]
    pub object_id: String,
    /// Namespace from on-chain metadata
    pub namespace: String,
    /// MemWal package ID from on-chain metadata
    #[serde(rename = "packageId", default)]
    pub package_id: String,
}

/// Response from sidecar query-blobs endpoint
#[derive(Debug, serde::Deserialize)]
struct QueryBlobsResponse {
    blobs: Vec<OnChainBlob>,
    total: usize,
}

/// Request/response types for sidecar HTTP API
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WalrusUploadRequest {
    data: String,
    key_index: usize,
    owner: String,
    namespace: String,
    package_id: String,
    epochs: u64,
    defer_transfer: bool,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalrusUploadResponse {
    blob_id: String,
    object_id: Option<String>,
    #[serde(default)]
    transfer_status: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMetadataBatchEntry {
    pub blob_object_id: String,
    pub namespace: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetMetadataBatchRequest {
    blobs: Vec<SetMetadataBatchEntry>,
    owner: String,
    package_id: String,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    key_index: usize,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetMetadataBatchResponse {
    transferred: usize,
}

/// Upload an encrypted blob to Walrus via the HTTP sidecar.
///
/// Calls the long-lived sidecar server at `POST /walrus/upload` which uses
/// `@mysten/walrus` SDK with the multi-step writeBlobFlow.
///
/// The server wallet pays for gas + storage. After certify, the blob object
/// is transferred to `owner_address`. Namespace + owner are stored as
/// on-chain metadata attributes for discoverability.
#[allow(clippy::too_many_arguments)]
pub async fn upload_blob(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    data: &[u8],
    epochs: u64,
    owner_address: &str,
    key_index: usize,
    namespace: &str,
    package_id: &str,
    agent_id: Option<&str>,
) -> Result<UploadResult, AppError> {
    upload_blob_inner(
        client,
        sidecar_url,
        sidecar_secret,
        data,
        epochs,
        owner_address,
        key_index,
        namespace,
        package_id,
        agent_id,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn upload_blob_inner(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    data: &[u8],
    epochs: u64,
    owner_address: &str,
    key_index: usize,
    namespace: &str,
    package_id: &str,
    agent_id: Option<&str>,
    defer_transfer: bool,
) -> Result<UploadResult, AppError> {
    let url = format!("{}/walrus/upload", sidecar_url);
    let data_b64 = BASE64.encode(data);

    let mut req = client.post(&url).json(&WalrusUploadRequest {
        data: data_b64,
        key_index,
        owner: owner_address.to_string(),
        namespace: namespace.to_string(),
        package_id: package_id.to_string(),
        epochs,
        defer_transfer,
        agent_id: agent_id.map(|s| s.to_string()),
    });
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .timeout(SIDECAR_WALRUS_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sidecar walrus/upload request failed: {}", e)))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!(
                "walrus upload failed: {}",
                err.error
            )));
        }
        return Err(AppError::Internal(format!(
            "walrus upload failed: {}",
            body
        )));
    }

    let result: WalrusUploadResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse walrus/upload response: {}", e))
    })?;
    if result.transfer_status.as_deref() == Some("failed") {
        return Err(AppError::Internal(
            "walrus upload completed but metadata/transfer failed".into(),
        ));
    }
    if defer_transfer && result.object_id.is_none() {
        return Err(AppError::Internal(
            "walrus deferred upload returned no object_id".into(),
        ));
    }

    tracing::info!(
        "walrus upload via sidecar ok: blob_id={}, object_id={:?}, transfer_status={:?}, owner={}, ns={}",
        result.blob_id,
        result.object_id,
        result.transfer_status,
        owner_address,
        namespace
    );

    Ok(UploadResult {
        blob_id: result.blob_id,
        object_id: result.object_id,
    })
}

pub async fn set_metadata_batch(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    key_index: usize,
    owner_address: &str,
    package_id: &str,
    agent_id: Option<&str>,
    blobs: Vec<SetMetadataBatchEntry>,
) -> Result<usize, AppError> {
    let url = format!("{}/walrus/set-metadata-batch", sidecar_url);
    let mut req = client.post(&url).json(&SetMetadataBatchRequest {
        blobs,
        owner: owner_address.to_string(),
        package_id: package_id.to_string(),
        agent_id: agent_id.map(|s| s.to_string()),
        key_index,
    });
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }

    let resp = req
        .timeout(SIDECAR_WALRUS_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Sidecar walrus/set-metadata-batch request failed: {}",
                e
            ))
        })?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!(
                "walrus set-metadata-batch failed: {}",
                err.error
            )));
        }
        return Err(AppError::Internal(format!(
            "walrus set-metadata-batch failed: {}",
            body
        )));
    }

    let result: SetMetadataBatchResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!(
            "Failed to parse walrus/set-metadata-batch response: {}",
            e
        ))
    })?;
    Ok(result.transferred)
}

/// Query user's Walrus Blob objects from the Sui chain via sidecar.
///
/// This enables restore-from-zero: even if the local DB is empty,
/// we can discover all blob_ids by querying the user's on-chain objects
/// and reading the `memwal_namespace` metadata attribute.
pub async fn query_blobs_by_owner(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    owner_address: &str,
    namespace: Option<&str>,
    package_id: Option<&str>,
) -> Result<Vec<OnChainBlob>, AppError> {
    let url = format!("{}/walrus/query-blobs", sidecar_url);

    let mut body = serde_json::json!({ "owner": owner_address });
    if let Some(ns) = namespace {
        body["namespace"] = serde_json::json!(ns);
    }
    if let Some(pkg) = package_id {
        body["packageId"] = serde_json::json!(pkg);
    }

    let mut req = client.post(&url).json(&body);
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sidecar walrus/query-blobs failed: {}", e)))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "walrus query-blobs failed: {}",
            body
        )));
    }

    let result: QueryBlobsResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to parse query-blobs response: {}", e)))?;

    tracing::info!(
        "walrus query-blobs ok: {} blobs for owner={}, ns={:?}",
        result.total,
        owner_address,
        namespace
    );

    Ok(result.blobs)
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
    // Timeout to avoid hanging on broken/slow blobs (Walrus 500s can take 60s+)
    let download_fut = walrus_client.read_blob_by_id(blob_id);
    let bytes = match tokio::time::timeout(std::time::Duration::from_secs(15), download_fut).await {
        Ok(Ok(data)) => data,
        Ok(Err(e)) => {
            let err_str = e.to_string();
            let is_not_found = err_str.contains("404")
                || err_str.to_lowercase().contains("not found")
                || err_str.to_lowercase().contains("blob not found");
            if is_not_found {
                return Err(AppError::BlobNotFound(format!(
                    "Blob {} expired or not found: {}",
                    blob_id, err_str
                )));
            } else {
                return Err(AppError::Internal(format!(
                    "Walrus download failed: {}",
                    err_str
                )));
            }
        }
        Err(_) => {
            return Err(AppError::Internal(format!(
                "Walrus download timed out after 10s for blob {}",
                blob_id
            )));
        }
    };

    tracing::info!(
        "walrus download ok: blob_id={}, {} bytes",
        blob_id,
        bytes.len()
    );
    Ok(bytes)
}
