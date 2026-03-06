use crate::types::AppError;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    pub object_id: Option<String>,
}

/// Upload an encrypted blob to Walrus via the **Upload Relay**.
///
/// Calls the TS sidecar script (`scripts/walrus-upload.ts`) which uses
/// `@mysten/walrus` SDK with the multi-step writeBlobFlow:
///   1. Encode blob (Red Stuff encoding)
///   2. Register blob on Sui (server wallet signs)
///   3. Upload encoded data to upload-relay
///   4. Certify blob on Sui (server wallet signs)
///
/// The server wallet pays for gas + storage, and the blob is
/// transferred to `owner_address` after registration.
pub async fn upload_blob(
    data: &[u8],
    epochs: u64,
    owner_address: &str,
    sui_private_key: &str,
) -> Result<UploadResult, AppError> {
    let data_b64 = BASE64.encode(data);

    let scripts_dir = std::env::current_dir()
        .unwrap_or_default()
        .join("scripts");

    let output = tokio::process::Command::new("npx")
        .args([
            "tsx",
            "walrus-upload.ts",
            "--data",
            &data_b64,
            "--private-key",
            sui_private_key,
            "--owner",
            owner_address,
            "--epochs",
            &epochs.to_string(),
        ])
        .current_dir(&scripts_dir)
        .output()
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Failed to spawn walrus-upload.ts: {}. Is Node.js/npx installed?",
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Internal(format!(
            "walrus-upload.ts exited with {}: {}",
            output.status, stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RelayResult {
        blob_id: String,
        object_id: Option<String>,
    }

    let result: RelayResult = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Internal(format!(
            "Failed to parse walrus-upload.ts output: {}. Output: {}",
            e, stdout
        ))
    })?;

    tracing::info!(
        "walrus upload via relay ok: blob_id={}, object_id={:?}, owner={}",
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
pub async fn download_blob(
    walrus_client: &walrus_rs::WalrusClient,
    blob_id: &str,
) -> Result<Vec<u8>, AppError> {
    let bytes = walrus_client
        .read_blob_by_id(blob_id)
        .await
        .map_err(|e| AppError::Internal(format!("Walrus download failed: {}", e)))?;

    tracing::info!(
        "walrus download ok: blob_id={}, {} bytes",
        blob_id,
        bytes.len()
    );
    Ok(bytes)
}
