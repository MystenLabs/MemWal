use base64::Engine as _;
use crate::types::AppError;

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    #[allow(dead_code)]
    pub object_id: Option<String>,
}

/// Upload an encrypted blob to Walrus via the native `walrus_rs` SDK.
///
/// ENG-1700: Replaces HTTP call to sidecar POST /walrus/upload.
/// Uses the Walrus Publisher HTTP API directly via `walrus_rs::store_blob`.
///
/// The `send_object_to` parameter transfers the resulting Blob object
/// to the owner address after certification.
#[allow(clippy::too_many_arguments)]
pub async fn upload_blob(
    walrus_client: &walrus_rs::WalrusClient,
    data: &[u8],
    epochs: u64,
    owner_address: &str,
) -> Result<UploadResult, AppError> {
    let result = walrus_client
        .store_blob(
            data.to_vec(),
            Some(epochs),
            None,  // deletable
            None,  // permanent
            Some(owner_address),  // send_object_to → transfers blob to owner
        )
        .await
        .map_err(|e| AppError::Internal(format!("Walrus upload failed: {}", e)))?;

    // Extract blob_id from either newly_created or already_certified
    let (blob_id, object_id) = if let Some(ref nc) = result.newly_created {
        (
            nc.blob_object.blob_id.clone(),
            Some(nc.blob_object.id.clone()),
        )
    } else if let Some(ref ac) = result.already_certified {
        (ac.blob_id.clone(), None)
    } else {
        return Err(AppError::Internal(
            "Walrus store_blob returned neither newly_created nor already_certified".into(),
        ));
    };

    tracing::info!(
        "walrus upload ok (native): blob_id={}, object_id={:?}, owner={}, {} bytes",
        blob_id,
        object_id,
        owner_address,
        data.len()
    );

    Ok(UploadResult { blob_id, object_id })
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
    let bytes = match tokio::time::timeout(std::time::Duration::from_secs(10), download_fut).await
    {
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

/// Query user's Walrus Blob objects from the Sui chain via JSON-RPC.
///
/// ENG-1700: Replaces sidecar POST /walrus/query-blobs with native Sui RPC.
/// Uses `suix_getOwnedObjects` (paginated) + `suix_getDynamicFieldObject`
/// for metadata, then filters by namespace/packageId.
pub async fn query_blobs_by_owner(
    client: &reqwest::Client,
    sui_rpc_url: &str,
    walrus_package_id: &str,
    owner_address: &str,
    namespace: Option<&str>,
    package_id: Option<&str>,
) -> Result<Vec<OnChainBlob>, AppError> {
    let blob_type = format!("{}::blob::Blob", walrus_package_id);
    let mut all_blobs: Vec<OnChainBlob> = Vec::new();
    let mut cursor: Option<String> = None;

    // Paginated query for all owned Blob objects
    loop {
        let mut params = serde_json::json!([
            owner_address,
            {
                "filter": { "StructType": blob_type },
                "options": { "showContent": true }
            }
        ]);
        if let Some(ref c) = cursor {
            params.as_array_mut().unwrap().push(serde_json::json!(c));
        }

        let rpc_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "suix_getOwnedObjects",
            "params": params
        });

        let resp = client
            .post(sui_rpc_url)
            .json(&rpc_req)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("Sui RPC getOwnedObjects failed: {}", e)))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("Sui RPC parse failed: {}", e)))?;

        if let Some(err) = body.get("error") {
            return Err(AppError::Internal(format!("Sui RPC error: {}", err)));
        }

        let result = body.get("result").ok_or_else(|| {
            AppError::Internal("Sui RPC missing result field".into())
        })?;

        let data = result.get("data").and_then(|d| d.as_array()).unwrap_or(&Vec::new()).clone();

        for obj in &data {
            let obj_data = match obj.get("data") {
                Some(d) => d,
                None => continue,
            };
            let object_id = obj_data
                .get("objectId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Extract blob_id from content fields
            let content = match obj_data.get("content") {
                Some(c) => c,
                None => continue,
            };
            let fields = match content.get("fields") {
                Some(f) => f,
                None => continue,
            };

            // blob_id is stored as a U256 string in the "blob_id" field
            let blob_id_str = fields
                .get("blob_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if blob_id_str.is_empty() {
                continue;
            }

            // Convert U256 string to base64url (little-endian 32 bytes)
            let blob_id = match u256_to_base64url(blob_id_str) {
                Some(id) => id,
                None => {
                    tracing::warn!("Failed to convert blob_id U256: {}", blob_id_str);
                    continue;
                }
            };

            // Fetch dynamic field metadata
            let metadata = fetch_blob_metadata(client, sui_rpc_url, &object_id).await;

            let ns = metadata
                .get("memwal_namespace")
                .and_then(|v| v.as_str())
                .unwrap_or("default")
                .to_string();
            let pkg = metadata
                .get("memwal_package_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Filter by namespace if specified
            if let Some(filter_ns) = namespace {
                if ns != filter_ns {
                    continue;
                }
            }
            // Filter by packageId if specified
            if let Some(filter_pkg) = package_id {
                if !pkg.is_empty() && pkg != filter_pkg {
                    continue;
                }
            }

            all_blobs.push(OnChainBlob {
                blob_id,
                object_id,
                namespace: ns,
                package_id: pkg,
            });
        }

        // Check for next page
        let has_next = result
            .get("hasNextPage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if has_next {
            cursor = result
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(String::from);
        } else {
            break;
        }
    }

    tracing::info!(
        "walrus query-blobs ok (native): {} blobs for owner={}, ns={:?}",
        all_blobs.len(),
        owner_address,
        namespace
    );

    Ok(all_blobs)
}

/// Fetch metadata dynamic field from a Blob object.
/// Returns a JSON map of metadata key-value pairs.
async fn fetch_blob_metadata(
    client: &reqwest::Client,
    sui_rpc_url: &str,
    object_id: &str,
) -> serde_json::Value {
    // Dynamic field key: b"metadata" = [109, 101, 116, 97, 100, 97, 116, 97]
    let rpc_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "suix_getDynamicFieldObject",
        "params": [
            object_id,
            {
                "type": "vector<u8>",
                "value": [109, 101, 116, 97, 100, 97, 116, 97]
            }
        ]
    });

    let resp = match client.post(sui_rpc_url).json(&rpc_req).send().await {
        Ok(r) => r,
        Err(_) => return serde_json::json!({}),
    };

    let body: serde_json::Value = match resp.json().await {
        Ok(b) => b,
        Err(_) => return serde_json::json!({}),
    };

    // Navigate: result.data.content.fields.value.fields
    body.pointer("/result/data/content/fields/value/fields")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Convert a U256 decimal string to base64url (little-endian 32 bytes, no padding).
fn u256_to_base64url(s: &str) -> Option<String> {
    // Parse as big integer, convert to 32-byte little-endian
    let n: num_bigint::BigUint = s.parse().ok()?;
    let mut bytes = n.to_bytes_le();
    // Pad to 32 bytes
    bytes.resize(32, 0);
    if bytes.len() > 32 {
        return None;
    }
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes))
}
