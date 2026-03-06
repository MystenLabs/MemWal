use crate::types::AppError;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

/// Encrypt plaintext using SEAL threshold encryption via TS sidecar.
///
/// Calls `scripts/seal-encrypt.ts` which uses `@mysten/seal` SDK.
/// The ciphertext is bound to the user's address via SEAL key ID.
///
/// Returns: SEAL encrypted bytes
pub async fn seal_encrypt(
    data: &[u8],
    owner_address: &str,
    package_id: &str,
) -> Result<Vec<u8>, AppError> {
    let data_b64 = BASE64.encode(data);

    let scripts_dir = std::env::current_dir()
        .unwrap_or_default()
        .join("scripts");

    let output = tokio::process::Command::new("npx")
        .args([
            "tsx",
            "seal-encrypt.ts",
            "--data",
            &data_b64,
            "--owner",
            owner_address,
            "--package-id",
            package_id,
        ])
        .current_dir(&scripts_dir)
        .output()
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Failed to spawn seal-encrypt.ts: {}. Is Node.js/npx installed?",
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Internal(format!(
            "seal-encrypt.ts exited with {}: {}",
            output.status, stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON: { "encryptedData": "<base64>" }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SealEncryptResult {
        encrypted_data: String,
    }

    let result: SealEncryptResult = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Internal(format!(
            "Failed to parse seal-encrypt.ts output: {}. Output: {}",
            e, stdout
        ))
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

/// Decrypt SEAL-encrypted data using admin wallet via TS sidecar.
///
/// Calls `scripts/seal-decrypt.ts` which uses `@mysten/seal` SDK.
/// The admin wallet (TEE server) is authorized in the AccountRegistry
/// to decrypt any user's data via `seal_approve`.
///
/// Returns: decrypted plaintext bytes
pub async fn seal_decrypt(
    encrypted_data: &[u8],
    private_key: &str,
    package_id: &str,
    registry_id: &str,
) -> Result<Vec<u8>, AppError> {
    let data_b64 = BASE64.encode(encrypted_data);

    let scripts_dir = std::env::current_dir()
        .unwrap_or_default()
        .join("scripts");

    let output = tokio::process::Command::new("npx")
        .args([
            "tsx",
            "seal-decrypt.ts",
            "--data",
            &data_b64,
            "--private-key",
            private_key,
            "--package-id",
            package_id,
            "--registry-id",
            registry_id,
        ])
        .current_dir(&scripts_dir)
        .output()
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Failed to spawn seal-decrypt.ts: {}. Is Node.js/npx installed?",
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Internal(format!(
            "seal-decrypt.ts exited with {}: {}",
            output.status, stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON: { "decryptedData": "<base64>" }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SealDecryptResult {
        decrypted_data: String,
    }

    let result: SealDecryptResult = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Internal(format!(
            "Failed to parse seal-decrypt.ts output: {}. Output: {}",
            e, stdout
        ))
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
