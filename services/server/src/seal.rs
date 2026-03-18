use crate::types::{AppError, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

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
    private_key: String,
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
    data: &[u8],
    owner_address: &str,
    package_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/seal/encrypt", sidecar_url);
    let data_b64 = BASE64.encode(data);

    let resp = client
        .post(&url)
        .json(&SealEncryptRequest {
            data: data_b64,
            owner: owner_address.to_string(),
            package_id: package_id.to_string(),
        })
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
    encrypted_data: &[u8],
    private_key: &str,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/seal/decrypt", sidecar_url);
    let data_b64 = BASE64.encode(encrypted_data);

    let resp = client
        .post(&url)
        .json(&SealDecryptRequest {
            data: data_b64,
            private_key: private_key.to_string(),
            package_id: package_id.to_string(),
            account_id: account_id.to_string(),
        })
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



