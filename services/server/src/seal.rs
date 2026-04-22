use crate::types::{AppError, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

// ── Batch decrypt response types ────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct BatchDecryptItem {
    index: usize,
    #[serde(rename = "decryptedData")]
    decrypted_data: String,
}

#[derive(serde::Deserialize)]
struct BatchDecryptError {
    index: usize,
    error: String,
}

#[derive(serde::Deserialize)]
struct SealDecryptBatchResponse {
    results: Vec<BatchDecryptItem>,
    errors: Vec<BatchDecryptError>,
}

/// Request/response types for sidecar HTTP API
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SealEncryptRequest {
    data: String,
    owner: String,
    package_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealEncryptResponse {
    encrypted_data: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SealDecryptRequest {
    data: String,
    package_id: String,
    account_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealDecryptResponse {
    decrypted_data: String,
}

/// Encrypt plaintext using SEAL threshold encryption via HTTP sidecar.
///
/// Calls the long-lived sidecar server at `POST /seal/encrypt`.
/// The ciphertext is bound to the user's address via SEAL key ID.
///
/// Returns: SEAL encrypted bytes
pub async fn seal_encrypt(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    data: &[u8],
    owner_address: &str,
    package_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/seal/encrypt", sidecar_url);
    let data_b64 = BASE64.encode(data);

    let mut req = client
        .post(&url)
        .json(&SealEncryptRequest {
            data: data_b64,
            owner: owner_address.to_string(),
            package_id: package_id.to_string(),
        });
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(format!("Sidecar seal/encrypt request failed: {}. Is the sidecar running?", e))
        })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!("seal encrypt failed: {}", err.error)));
        }
        return Err(AppError::Internal(format!("seal encrypt failed: {}", body)));
    }

    let result: SealEncryptResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse seal/encrypt response: {}", e))
    })?;

    let encrypted_bytes = BASE64.decode(&result.encrypted_data).map_err(|e| {
        AppError::Internal(format!("Failed to decode encrypted base64: {}", e))
    })?;

    tracing::info!(
        "seal encrypt ok: {} bytes -> {} encrypted bytes",
        data.len(),
        encrypted_bytes.len()
    );

    Ok(encrypted_bytes)
}

/// Decrypt SEAL-encrypted data using a delegate keypair via HTTP sidecar.
///
/// Calls the long-lived sidecar server at `POST /seal/decrypt`.
/// The delegate keypair must be registered in the user's MemWalAccount
/// as a delegate key to be authorized for `seal_approve`.
///
/// Returns: decrypted plaintext bytes
pub async fn seal_decrypt(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_data: &[u8],
    private_key: &str,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/seal/decrypt", sidecar_url);
    let data_b64 = BASE64.encode(encrypted_data);

    let mut req = client
        .post(&url)
        .header("x-delegate-key", private_key)
        .json(&SealDecryptRequest {
            data: data_b64,
            package_id: package_id.to_string(),
            account_id: account_id.to_string(),
        });
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(format!("Sidecar seal/decrypt request failed: {}. Is the sidecar running?", e))
        })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!("seal decrypt failed: {}", err.error)));
        }
        return Err(AppError::Internal(format!("seal decrypt failed: {}", body)));
    }

    let result: SealDecryptResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse seal/decrypt response: {}", e))
    })?;

    let decrypted_bytes = BASE64.decode(&result.decrypted_data).map_err(|e| {
        AppError::Internal(format!("Failed to decode decrypted base64: {}", e))
    })?;

    tracing::info!(
        "seal decrypt ok: {} encrypted bytes -> {} decrypted bytes",
        encrypted_data.len(),
        decrypted_bytes.len()
    );

    Ok(decrypted_bytes)
}

/// Per-blob outcome of a batch SEAL decrypt call.
#[derive(Debug)]
pub enum DecryptOutcome {
    /// Successfully decrypted plaintext.
    Ok(Vec<u8>),
    /// Sidecar reported an error for this blob. `permanent` indicates
    /// whether the failure is final (e.g. "Not enough shares") and the row
    /// should be cleaned up rather than retried.
    Failed { error: String, permanent: bool },
    /// No response for this index (e.g. base64 decode error in our pipeline).
    Missing,
}

impl DecryptOutcome {
    fn permanent_from_error(err: &str) -> bool {
        err.contains("Not enough shares")
            || err.contains("decrypt failed")
            || err.contains("InvalidCiphertext")
            || err.contains("InvalidPersonalMessageSignature")
    }
}

/// Batch-decrypt multiple SEAL-encrypted blobs in a single sidecar HTTP call.
///
/// Uses `POST /seal/decrypt-batch` which creates ONE `SessionKey` and ONE
/// `fetchKeys` call for all blobs, instead of N separate `seal_decrypt` calls.
///
/// # Arguments
/// * `encrypted_blobs` — slice of `(blob_id, encrypted_bytes)` pairs.
///   The `blob_id` is carried through for logging only; the sidecar doesn't use it.
///
/// # Returns
/// Same-length `Vec<DecryptOutcome>` so callers can distinguish transient
/// failures from permanent ones (the latter trigger DB cleanup of the row).
pub async fn seal_decrypt_batch(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_blobs: &[(String, Vec<u8>)],   // (blob_id, ciphertext)
    private_key: &str,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<DecryptOutcome>, AppError> {
    if encrypted_blobs.is_empty() {
        return Ok(vec![]);
    }

    let url = format!("{}/seal/decrypt-batch", sidecar_url);

    // Build items array: base64-encoded ciphertexts indexed 0..N
    let items: Vec<String> = encrypted_blobs
        .iter()
        .map(|(_, data)| BASE64.encode(data))
        .collect();

    let body = serde_json::json!({
        "items":     items,
        "packageId": package_id,
        "accountId": account_id,
    });

    let mut req = client
        .post(&url)
        .header("x-delegate-key", private_key)
        .json(&body);
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Sidecar seal/decrypt-batch request failed: {}. Is the sidecar running?",
                e
            ))
        })?;

    if !resp.status().is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body_text) {
            return Err(AppError::Internal(format!(
                "seal decrypt-batch failed: {}",
                err.error
            )));
        }
        return Err(AppError::Internal(format!(
            "seal decrypt-batch failed: {}",
            body_text
        )));
    }

    let batch_resp: SealDecryptBatchResponse = resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse seal/decrypt-batch response: {}", e))
    })?;

    // Initialise all positions as Missing; fill in successes and per-item errors.
    let mut out: Vec<DecryptOutcome> = (0..encrypted_blobs.len())
        .map(|_| DecryptOutcome::Missing)
        .collect();

    for item in &batch_resp.results {
        if item.index >= out.len() {
            continue; // shouldn't happen
        }
        match BASE64.decode(&item.decrypted_data) {
            Ok(bytes) => out[item.index] = DecryptOutcome::Ok(bytes),
            Err(e) => {
                tracing::warn!(
                    "seal decrypt-batch: base64 decode failed for index {}: {}",
                    item.index, e
                );
                out[item.index] = DecryptOutcome::Failed {
                    error: format!("base64 decode failed: {}", e),
                    // Plaintext was decrypted — this is a sidecar bug, not a
                    // permanent ciphertext fault. Don't cleanup.
                    permanent: false,
                };
            }
        }
    }

    // Map per-item errors from the sidecar onto the outcome vec
    for err in &batch_resp.errors {
        let blob_id = encrypted_blobs
            .get(err.index)
            .map(|(id, _)| id.as_str())
            .unwrap_or("?");
        let permanent = DecryptOutcome::permanent_from_error(&err.error);
        tracing::warn!(
            "seal decrypt-batch: sidecar error for blob {} (index {}, permanent={}): {}",
            blob_id, err.index, permanent, err.error
        );
        if err.index < out.len() {
            out[err.index] = DecryptOutcome::Failed {
                error: err.error.clone(),
                permanent,
            };
        }
    }

    tracing::info!(
        "seal decrypt-batch ok: {}/{} decrypted, {} errors",
        batch_resp.results.len(),
        encrypted_blobs.len(),
        batch_resp.errors.len(),
    );

    Ok(out)
}
