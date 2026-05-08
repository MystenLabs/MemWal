use crate::types::{AppError, AuthInfo, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

/// Credential used to authorize a SEAL decrypt request against the sidecar.
///
/// ENG-1697: `Session` (an exported `SessionKey`, built on the client) is
/// preferred. `DelegateKey` is the legacy path where the SDK transmits the
/// raw Ed25519 private key — retained temporarily so existing clients keep
/// working. At EOL the `DelegateKey` variant will be removed.
///
/// Owned so it can be cheaply cloned into async tasks.
#[derive(Debug, Clone)]
pub enum SealCredential {
    Session(String),
    DelegateKey(String),
}

impl SealCredential {
    /// Build the credential from an `AuthInfo`, preferring `seal_session`
    /// when present. Falls back to `delegate_key` (legacy), then to a
    /// server-side fallback private key (used when a route lacks a user
    /// context). Returns `None` if no credential is available.
    pub fn from_auth_or_fallback(
        auth: &AuthInfo,
        fallback_private_key: Option<&str>,
    ) -> Option<Self> {
        if let Some(s) = auth.seal_session.as_deref() {
            return Some(SealCredential::Session(s.to_string()));
        }
        if let Some(k) = auth.delegate_key.as_deref() {
            return Some(SealCredential::DelegateKey(k.to_string()));
        }
        fallback_private_key.map(|k| SealCredential::DelegateKey(k.to_string()))
    }
}

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

    let mut req = client.post(&url).json(&SealEncryptRequest {
        data: data_b64,
        owner: owner_address.to_string(),
        package_id: package_id.to_string(),
    });
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req.send().await.map_err(|e| {
        AppError::Internal(format!(
            "Sidecar seal/encrypt request failed: {}. Is the sidecar running?",
            e
        ))
    })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!(
                "seal encrypt failed: {}",
                err.error
            )));
        }
        return Err(AppError::Internal(format!("seal encrypt failed: {}", body)));
    }

    let result: SealEncryptResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to parse seal/encrypt response: {}", e)))?;

    let encrypted_bytes = BASE64
        .decode(&result.encrypted_data)
        .map_err(|e| AppError::Internal(format!("Failed to decode encrypted base64: {}", e)))?;

    tracing::info!(
        "seal encrypt ok: {} bytes -> {} encrypted bytes",
        data.len(),
        encrypted_bytes.len()
    );

    Ok(encrypted_bytes)
}

/// Decrypt SEAL-encrypted data via the sidecar.
///
/// Calls `POST /seal/decrypt` on the long-lived sidecar server. The
/// credential (ENG-1697) is either an exported SessionKey token or a
/// legacy delegate private key. The client must have authority for
/// `seal_approve` against the given `account_id`.
///
/// Returns: decrypted plaintext bytes.
pub async fn seal_decrypt(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_data: &[u8],
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{}/seal/decrypt", sidecar_url);
    let data_b64 = BASE64.encode(encrypted_data);

    let mut req = client.post(&url).json(&SealDecryptRequest {
        data: data_b64,
        package_id: package_id.to_string(),
        account_id: account_id.to_string(),
    });
    req = match credential {
        SealCredential::Session(s) => req.header("x-seal-session", s),
        SealCredential::DelegateKey(k) => req.header("x-delegate-key", k),
    };
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let resp = req.send().await.map_err(|e| {
        AppError::Internal(format!(
            "Sidecar seal/decrypt request failed: {}. Is the sidecar running?",
            e
        ))
    })?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!(
                "seal decrypt failed: {}",
                err.error
            )));
        }
        return Err(AppError::Internal(format!("seal decrypt failed: {}", body)));
    }

    let result: SealDecryptResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to parse seal/decrypt response: {}", e)))?;

    let decrypted_bytes = BASE64
        .decode(&result.decrypted_data)
        .map_err(|e| AppError::Internal(format!("Failed to decode decrypted base64: {}", e)))?;

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
    Ok(Vec<u8>),
    Failed { error: String, permanent: bool },
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
pub async fn seal_decrypt_batch(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    encrypted_blobs: &[(String, Vec<u8>)],
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<DecryptOutcome>, AppError> {
    if encrypted_blobs.is_empty() {
        return Ok(vec![]);
    }

    let url = format!("{}/seal/decrypt-batch", sidecar_url);
    let items: Vec<String> = encrypted_blobs
        .iter()
        .map(|(_, data)| BASE64.encode(data))
        .collect();
    let body = serde_json::json!({
        "items": items,
        "packageId": package_id,
        "accountId": account_id,
    });

    let mut req = client.post(&url).json(&body);
    req = match credential {
        SealCredential::Session(s) => req.header("x-seal-session", s),
        SealCredential::DelegateKey(k) => req.header("x-delegate-key", k),
    };
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }

    let resp = req.send().await.map_err(|e| {
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
        AppError::Internal(format!(
            "Failed to parse seal/decrypt-batch response: {}",
            e
        ))
    })?;

    let mut out: Vec<DecryptOutcome> = (0..encrypted_blobs.len())
        .map(|_| DecryptOutcome::Missing)
        .collect();

    for item in &batch_resp.results {
        if item.index >= out.len() {
            continue;
        }
        out[item.index] = match BASE64.decode(&item.decrypted_data) {
            Ok(bytes) => DecryptOutcome::Ok(bytes),
            Err(e) => DecryptOutcome::Failed {
                error: format!("base64 decode failed: {}", e),
                permanent: false,
            },
        };
    }

    for err in &batch_resp.errors {
        let blob_id = encrypted_blobs
            .get(err.index)
            .map(|(id, _)| id.as_str())
            .unwrap_or("?");
        let permanent = DecryptOutcome::permanent_from_error(&err.error);
        tracing::warn!(
            "seal decrypt-batch: sidecar error for blob {} (index {}, permanent={}): {}",
            blob_id,
            err.index,
            permanent,
            err.error
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
        batch_resp.errors.len()
    );

    Ok(out)
}
