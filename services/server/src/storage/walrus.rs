use crate::types::{AppError, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures::stream::{FuturesUnordered, StreamExt};
use std::time::Duration;

const SIDECAR_WALRUS_TIMEOUT: Duration = Duration::from_secs(300);
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

/// Request/response types for sidecar HTTP API
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WalrusUploadRequest {
    data: String,
    key_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_id: Option<String>,
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
    job_id: Option<&str>,
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
        job_id,
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
    job_id: Option<&str>,
    defer_transfer: bool,
) -> Result<UploadResult, UploadBlobError> {
    let url = format!("{}/walrus/upload", sidecar_url);
    let data_b64 = BASE64.encode(data);

    let mut req = client.post(&url).json(&WalrusUploadRequest {
        data: data_b64,
        key_index,
        job_id: job_id.map(|s| s.to_string()),
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
/// Convert a Walrus `blob_id` as read off-chain (a decimal-string U256) into
/// the base64url form Walrus aggregators expect. Mirrors
/// `blobIdFromRaw` in the old `scripts/sidecar/routes/walrus-query.ts`:
/// decimal U256 -> 32-byte big-endian -> reversed to little-endian -> base64url.
/// Values that aren't a >20-digit decimal string (already base64url, or a
/// small placeholder in tests) are passed through unchanged.
fn blob_id_from_raw(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    if raw.len() > 20 && raw.bytes().all(|b| b.is_ascii_digit()) {
        let le_bytes = decimal_str_to_le_bytes_32(raw)?;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        return Some(URL_SAFE_NO_PAD.encode(le_bytes));
    }
    Some(raw.to_string())
}

/// Grade-school long division: convert a base-10 digit string into 32
/// little-endian bytes (a U256). Returns `None` if the value doesn't fit
/// in 256 bits.
fn decimal_str_to_le_bytes_32(decimal: &str) -> Option<[u8; 32]> {
    let mut digits: Vec<u8> = decimal.bytes().map(|b| b - b'0').collect();
    let mut out = [0u8; 32];
    for byte_slot in out.iter_mut() {
        let mut remainder: u32 = 0;
        let mut next_digits = Vec::with_capacity(digits.len());
        for &d in &digits {
            let cur = remainder * 10 + d as u32;
            next_digits.push((cur / 256) as u8);
            remainder = cur % 256;
        }
        while next_digits.len() > 1 && next_digits[0] == 0 {
            next_digits.remove(0);
        }
        digits = next_digits;
        *byte_slot = remainder as u8;
    }
    if digits == [0] {
        Some(out)
    } else {
        None // didn't fit in 256 bits
    }
}

async fn sui_rpc_call(
    client: &reqwest::Client,
    rpc_url: &str,
    method: &'static str,
    params: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let started = std::time::Instant::now();
    let resp = client
        .post(rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            crate::observability::observe_external("sui_rpc", method, "transport_error", started.elapsed());
            AppError::Internal(format!("Sui RPC {} failed: {}", method, e))
        })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external("sui_rpc", method, &status_label, started.elapsed());

    let value: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Sui RPC {} returned invalid JSON: {}", method, e)))?;
    if let Some(error) = value.get("error") {
        return Err(AppError::Internal(format!("Sui RPC {} error: {}", method, error)));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| AppError::Internal(format!("Sui RPC {} response missing 'result'", method)))
}

/// Query the user's Walrus Blob objects directly from the Sui chain (native
/// Rust — no sidecar). Enables restore-from-zero: even if the local DB is
/// empty, we can discover all blob_ids by scanning the owner's on-chain
/// objects and reading the `memwal_namespace` dynamic-field metadata.
///
/// This is the direct-RPC equivalent of the old sidecar's
/// `POST /walrus/query-blobs` (see `scripts/sidecar/routes/walrus-query.ts`).
/// It uses the full-scan path (`suix_getOwnedObjects` + per-object dynamic
/// field lookup); the sidecar's "recent transactions" fast-path optimization
/// is not ported — this is a correctness-first baseline, not yet
/// latency-optimized for accounts with many blobs.
pub async fn query_blobs_by_owner(
    client: &reqwest::Client,
    rpc_url: &str,
    walrus_package_id: &str,
    owner_address: &str,
    namespace: Option<&str>,
    package_id: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<OnChainBlob>, AppError> {
    let blob_type = format!("{}::blob::Blob", walrus_package_id);
    let want = limit.unwrap_or(usize::MAX);

    let mut blobs = Vec::new();
    let mut cursor: serde_json::Value = serde_json::Value::Null;
    let mut scanned = 0usize;

    loop {
        let result = sui_rpc_call(
            client,
            rpc_url,
            "suix_getOwnedObjects",
            serde_json::json!([
                owner_address,
                {
                    "filter": { "StructType": blob_type },
                    "options": { "showContent": true }
                },
                cursor,
                50
            ]),
        )
        .await?;

        let data = result.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
        if data.is_empty() {
            break;
        }

        for entry in &data {
            scanned += 1;
            let obj = entry.get("data");
            let object_id = obj.and_then(|o| o.get("objectId")).and_then(|v| v.as_str());
            let fields = obj
                .and_then(|o| o.get("content"))
                .filter(|c| c.get("dataType").and_then(|d| d.as_str()) == Some("moveObject"))
                .and_then(|c| c.get("fields"));
            let (Some(object_id), Some(fields)) = (object_id, fields) else {
                continue;
            };
            let raw_blob_id = fields
                .get("blob_id")
                .or_else(|| fields.get("blobId"))
                .and_then(|v| v.as_str().map(String::from).or_else(|| v.as_u64().map(|n| n.to_string())));
            let Some(raw_blob_id) = raw_blob_id else {
                continue;
            };

            // Fetch the `memwal_*` metadata dynamic field attached to this blob.
            let (mut blob_namespace, mut blob_package_id) = ("default".to_string(), String::new());
            let metadata_name = serde_json::json!({
                "type": "vector<u8>",
                "value": "metadata".bytes().map(u32::from).collect::<Vec<_>>(),
            });
            if let Ok(dyn_field) = sui_rpc_call(
                client,
                rpc_url,
                "suix_getDynamicFieldObject",
                serde_json::json!([object_id, metadata_name]),
            )
            .await
            {
                let contents = dyn_field
                    .pointer("/data/content/fields/value/fields/metadata/fields/contents")
                    .and_then(|v| v.as_array());
                if let Some(contents) = contents {
                    for entry in contents {
                        let key = entry.pointer("/fields/key").and_then(|v| v.as_str());
                        let value = entry.pointer("/fields/value").and_then(|v| v.as_str());
                        match (key, value) {
                            (Some("memwal_namespace"), Some(v)) => blob_namespace = v.to_string(),
                            (Some("memwal_package_id"), Some(v)) => blob_package_id = v.to_string(),
                            _ => {}
                        }
                    }
                }
            }

            if let Some(ns) = namespace {
                if blob_namespace != ns {
                    continue;
                }
            }
            if let Some(pkg) = package_id {
                if blob_package_id != pkg {
                    continue;
                }
            }
            let Some(blob_id) = blob_id_from_raw(&raw_blob_id) else {
                continue;
            };
            blobs.push(OnChainBlob {
                blob_id,
                object_id: object_id.to_string(),
                namespace: blob_namespace,
                package_id: blob_package_id,
            });
            if blobs.len() >= want {
                break;
            }
        }

        if blobs.len() >= want {
            break;
        }
        let has_next = result.get("hasNextPage").and_then(|v| v.as_bool()).unwrap_or(false);
        let next_cursor = result.get("nextCursor").cloned();
        match (has_next, next_cursor) {
            (true, Some(c)) if !c.is_null() => cursor = c,
            _ => break,
        }
    }

    tracing::info!(
        "walrus query-blobs ok (native): {} blobs for owner={}, ns={:?} (scanned {} objects)",
        blobs.len(),
        owner_address,
        namespace,
        scanned
    );

    Ok(blobs)
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
    use super::{aggregate_download_errors, blob_id_from_raw};
    use crate::types::AppError;

    #[test]
    fn blob_id_from_raw_matches_reference_conversion() {
        // Cross-checked against the original TS `blobIdFromRaw`
        // (decimal U256 -> 32-byte big-endian hex -> reversed to
        // little-endian -> base64url) via an independent Python
        // implementation of the same algorithm.
        let raw = "123456789012345678901234567890123456789012345678901234";
        let expected = "8q-WftgSTQKWAybeSl3AgKZPG5D4SQEAAAAAAAAAAAA";
        assert_eq!(blob_id_from_raw(raw), Some(expected.to_string()));
    }

    #[test]
    fn blob_id_from_raw_passes_through_non_decimal_and_short_values() {
        // Already-encoded blob ids and short numeric placeholders (as used
        // in tests/mocks) are not decimal U256s — pass through unchanged.
        assert_eq!(
            blob_id_from_raw("abc123_-XYZ"),
            Some("abc123_-XYZ".to_string())
        );
        assert_eq!(blob_id_from_raw("12345"), Some("12345".to_string()));
        assert_eq!(blob_id_from_raw(""), None);
    }

    #[test]
    fn blob_id_from_raw_rejects_values_that_overflow_u256() {
        // 78 nines is far larger than 2^256 (~1.16e77) and must not silently
        // truncate.
        let too_big = "9".repeat(78);
        assert_eq!(blob_id_from_raw(&too_big), None);
    }

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
