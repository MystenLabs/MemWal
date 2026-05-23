use crate::types::{AppError, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures::stream::{FuturesUnordered, StreamExt};
use std::time::Duration;

const SIDECAR_WALRUS_TIMEOUT: Duration = Duration::from_secs(180);
const WALRUS_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15);

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    #[allow(dead_code)]
    pub object_id: Option<String>,
}

#[derive(Debug)]
pub enum UploadBlobError {
    App(AppError),
    MetadataTransferFailed {
        blob_id: String,
        object_id: String,
        message: String,
    },
}

impl std::fmt::Display for UploadBlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UploadBlobError::App(err) => write!(f, "{}", err),
            UploadBlobError::MetadataTransferFailed { message, .. } => write!(f, "{}", message),
        }
    }
}

impl std::error::Error for UploadBlobError {}

impl From<AppError> for UploadBlobError {
    fn from(err: AppError) -> Self {
        UploadBlobError::App(err)
    }
}

impl From<UploadBlobError> for AppError {
    fn from(err: UploadBlobError) -> Self {
        match err {
            UploadBlobError::App(err) => err,
            UploadBlobError::MetadataTransferFailed { message, .. } => AppError::Internal(message),
        }
    }
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
    /// Walrus Memory package ID from on-chain metadata
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalrusUploadErrorResponse {
    error: String,
    blob_id: Option<String>,
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
) -> Result<UploadResult, UploadBlobError> {
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
) -> Result<UploadResult, UploadBlobError> {
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
    let req = crate::observability::apply_request_id_header(req);
    let started = std::time::Instant::now();
    let resp = req
        .timeout(SIDECAR_WALRUS_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            crate::observability::observe_external(
                "sidecar",
                "walrus_upload",
                "transport_error",
                started.elapsed(),
            );
            crate::observability::record_sidecar_failure("walrus_upload", "transport_error");
            UploadBlobError::App(AppError::Internal(format!(
                "Sidecar walrus/upload request failed: {}",
                e
            )))
        })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sidecar",
        "walrus_upload",
        &status_label,
        started.elapsed(),
    );

    if !resp.status().is_success() {
        crate::observability::record_sidecar_failure("walrus_upload", "http_error");
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<WalrusUploadErrorResponse>(&body) {
            if err.transfer_status.as_deref() == Some("failed") {
                if let (Some(blob_id), Some(object_id)) = (err.blob_id, err.object_id) {
                    return Err(UploadBlobError::MetadataTransferFailed {
                        blob_id,
                        object_id,
                        message: err.error,
                    });
                }
            }
            return Err(UploadBlobError::App(AppError::Internal(format!(
                "walrus upload failed: {}",
                err.error
            ))));
        }
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(UploadBlobError::App(AppError::Internal(format!(
                "walrus upload failed: {}",
                err.error
            ))));
        }
        return Err(UploadBlobError::App(AppError::Internal(format!(
            "walrus upload failed: {}",
            body
        ))));
    }

    let result: WalrusUploadResponse = resp.json().await.map_err(|e| {
        UploadBlobError::App(AppError::Internal(format!(
            "Failed to parse walrus/upload response: {}",
            e
        )))
    })?;
    if result.transfer_status.as_deref() == Some("failed") {
        if let Some(object_id) = result.object_id.clone() {
            return Err(UploadBlobError::MetadataTransferFailed {
                blob_id: result.blob_id.clone(),
                object_id,
                message: "walrus upload completed but metadata/transfer failed".into(),
            });
        }
        return Err(UploadBlobError::App(AppError::Internal(
            "walrus upload completed but metadata/transfer failed".into(),
        )));
    }
    if defer_transfer && result.object_id.is_none() {
        return Err(UploadBlobError::App(AppError::Internal(
            "walrus deferred upload returned no object_id".into(),
        )));
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
    let req = crate::observability::apply_request_id_header(req);

    let started = std::time::Instant::now();
    let resp = req
        .timeout(SIDECAR_WALRUS_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            crate::observability::observe_external(
                "sidecar",
                "walrus_set_metadata_batch",
                "transport_error",
                started.elapsed(),
            );
            crate::observability::record_sidecar_failure(
                "walrus_set_metadata_batch",
                "transport_error",
            );
            AppError::Internal(format!(
                "Sidecar walrus/set-metadata-batch request failed: {}",
                e
            ))
        })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sidecar",
        "walrus_set_metadata_batch",
        &status_label,
        started.elapsed(),
    );
    if !resp.status().is_success() {
        crate::observability::record_sidecar_failure("walrus_set_metadata_batch", "http_error");
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
    limit: Option<usize>,
) -> Result<Vec<OnChainBlob>, AppError> {
    let url = format!("{}/walrus/query-blobs", sidecar_url);

    let mut body = serde_json::json!({ "owner": owner_address });
    if let Some(ns) = namespace {
        body["namespace"] = serde_json::json!(ns);
    }
    if let Some(pkg) = package_id {
        body["packageId"] = serde_json::json!(pkg);
    }
    if let Some(limit) = limit {
        body["limit"] = serde_json::json!(limit);
    }

    let mut req = client.post(&url).json(&body);
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let req = crate::observability::apply_request_id_header(req);
    let started = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sidecar",
            "walrus_query_blobs",
            "transport_error",
            started.elapsed(),
        );
        crate::observability::record_sidecar_failure("walrus_query_blobs", "transport_error");
        AppError::Internal(format!("Sidecar walrus/query-blobs failed: {}", e))
    })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sidecar",
        "walrus_query_blobs",
        &status_label,
        started.elapsed(),
    );

    if !resp.status().is_success() {
        crate::observability::record_sidecar_failure("walrus_query_blobs", "http_error");
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

/// Download a blob from one or more Walrus aggregators.
///
/// The first URL is treated as primary. When more URLs are configured, cold
/// reads race the next candidate after `race_after`; the first successful 2xx
/// response wins. This supports low-latency proxy/CDN aggregators while keeping
/// the existing single-aggregator behavior when no extra URL is configured.
///
/// `skip_consistency_check` is intentionally caller-controlled because it
/// should only be enabled for trusted blobs written by Walrus Memory.
pub async fn download_blob_from_aggregators(
    client: &reqwest::Client,
    aggregator_urls: &[String],
    blob_id: &str,
    skip_consistency_check: bool,
    race_after: Duration,
) -> Result<Vec<u8>, AppError> {
    let aggregator_urls: Vec<String> = aggregator_urls
        .iter()
        .map(|url| url.trim())
        .filter(|url| !url.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    if aggregator_urls.is_empty() {
        return Err(AppError::Internal(
            "Walrus download failed: no aggregator URLs configured".into(),
        ));
    }

    if aggregator_urls.len() == 1 {
        return download_blob_from_aggregator(
            client,
            &aggregator_urls[0],
            blob_id,
            skip_consistency_check,
        )
        .await;
    }

    let mut tasks = FuturesUnordered::new();
    let mut errors: Vec<(String, AppError)> = Vec::new();
    let mut next_index = 0usize;

    tasks.push(download_blob_candidate(
        client.clone(),
        aggregator_urls[next_index].clone(),
        blob_id.to_string(),
        skip_consistency_check,
    ));
    next_index += 1;

    loop {
        if tasks.is_empty() {
            if next_index < aggregator_urls.len() {
                tasks.push(download_blob_candidate(
                    client.clone(),
                    aggregator_urls[next_index].clone(),
                    blob_id.to_string(),
                    skip_consistency_check,
                ));
                next_index += 1;
                continue;
            }
            break;
        }

        if next_index >= aggregator_urls.len() {
            match tasks.next().await {
                Some((_, Ok(bytes))) => return Ok(bytes),
                Some((url, Err(err))) => errors.push((url, err)),
                None => break,
            }
            continue;
        }

        if race_after.is_zero() {
            while next_index < aggregator_urls.len() {
                tasks.push(download_blob_candidate(
                    client.clone(),
                    aggregator_urls[next_index].clone(),
                    blob_id.to_string(),
                    skip_consistency_check,
                ));
                next_index += 1;
            }
            continue;
        }

        tokio::select! {
            result = tasks.next() => {
                match result {
                    Some((_, Ok(bytes))) => return Ok(bytes),
                    Some((url, Err(err))) => errors.push((url, err)),
                    None => {}
                }
            }
            _ = tokio::time::sleep(race_after) => {
                tasks.push(download_blob_candidate(
                    client.clone(),
                    aggregator_urls[next_index].clone(),
                    blob_id.to_string(),
                    skip_consistency_check,
                ));
                next_index += 1;
            }
        }
    }

    Err(aggregate_download_errors(blob_id, &errors))
}

async fn download_blob_candidate(
    client: reqwest::Client,
    aggregator_url: String,
    blob_id: String,
    skip_consistency_check: bool,
) -> (String, Result<Vec<u8>, AppError>) {
    let result =
        download_blob_from_aggregator(&client, &aggregator_url, &blob_id, skip_consistency_check)
            .await;
    (aggregator_url, result)
}

async fn download_blob_from_aggregator(
    client: &reqwest::Client,
    aggregator_url: &str,
    blob_id: &str,
    skip_consistency_check: bool,
) -> Result<Vec<u8>, AppError> {
    let started = std::time::Instant::now();
    let mut url = reqwest::Url::parse(aggregator_url)
        .and_then(|base| base.join(&format!("v1/blobs/{blob_id}")))
        .map_err(|e| AppError::Internal(format!("Invalid Walrus aggregator URL: {}", e)))?;
    if skip_consistency_check {
        url.query_pairs_mut()
            .append_pair("skip_consistency_check", "true");
    }

    let resp = client
        .get(url.clone())
        .timeout(WALRUS_DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            let status = if e.is_timeout() {
                "timeout"
            } else {
                "transport_error"
            };
            crate::observability::observe_external(
                "walrus",
                "download_blob",
                status,
                started.elapsed(),
            );
            AppError::Internal(format!(
                "Walrus download failed from {}: {}",
                aggregator_url, e
            ))
        })?;

    let status = resp.status();
    let status_label = status.as_u16().to_string();
    crate::observability::observe_external(
        "walrus",
        "download_blob",
        &status_label,
        started.elapsed(),
    );

    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::BlobNotFound(format!(
            "Blob {} expired or not found at {}",
            blob_id, aggregator_url
        )));
    }

    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Walrus download failed from {} with status {}: {}",
            aggregator_url, status, body
        )));
    }

    let bytes = resp.bytes().await.map_err(|e| {
        crate::observability::observe_external(
            "walrus",
            "download_blob",
            "body_error",
            started.elapsed(),
        );
        AppError::Internal(format!(
            "Failed to read Walrus blob {} from {}: {}",
            blob_id, aggregator_url, e
        ))
    })?;

    tracing::info!(
        "walrus download ok: blob_id={}, {} bytes, aggregator={}, skip_consistency_check={}",
        blob_id,
        bytes.len(),
        aggregator_url,
        skip_consistency_check
    );
    Ok(bytes.to_vec())
}

fn aggregate_download_errors(blob_id: &str, errors: &[(String, AppError)]) -> AppError {
    if !errors.is_empty()
        && errors
            .iter()
            .all(|(_, err)| matches!(err, AppError::BlobNotFound(_)))
    {
        return AppError::BlobNotFound(format!(
            "Blob {} expired or not found across {} Walrus aggregators",
            blob_id,
            errors.len()
        ));
    }

    let summary = errors
        .iter()
        .map(|(url, err)| format!("{}: {}", url, err))
        .collect::<Vec<_>>()
        .join("; ");
    AppError::Internal(format!(
        "Walrus download failed for blob {} across {} aggregators: {}",
        blob_id,
        errors.len(),
        summary
    ))
}

#[cfg(test)]
mod tests {
    use super::aggregate_download_errors;
    use crate::types::AppError;

    #[test]
    fn aggregate_download_errors_preserves_not_found_cleanup_signal() {
        let errors = vec![
            (
                "https://a.example".to_string(),
                AppError::BlobNotFound("404".into()),
            ),
            (
                "https://b.example".to_string(),
                AppError::BlobNotFound("404".into()),
            ),
        ];

        assert!(matches!(
            aggregate_download_errors("blob", &errors),
            AppError::BlobNotFound(_)
        ));
    }

    #[test]
    fn aggregate_download_errors_keeps_transient_errors_internal() {
        let errors = vec![
            (
                "https://a.example".to_string(),
                AppError::BlobNotFound("404".into()),
            ),
            (
                "https://b.example".to_string(),
                AppError::Internal("timeout".into()),
            ),
        ];

        assert!(matches!(
            aggregate_download_errors("blob", &errors),
            AppError::Internal(_)
        ));
    }
}
