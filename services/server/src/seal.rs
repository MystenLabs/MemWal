/// ENG-1700: Native Rust SEAL encrypt/decrypt — replaces TS sidecar HTTP calls.
///
/// Encrypt is fully local (pure crypto, no network).
/// Decrypt requires HTTP calls to SEAL key servers to fetch user secret keys.

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use seal_crypto::{
    EncryptedObject, EncryptionInput, IBEPublicKeys, ObjectID,
};
use seal_sdk::{
    decrypt_seal_responses, seal_decrypt_object, seal_encrypt,
    types::FetchKeyResponse,
    ElGamalSecretKey, IBEPublicKey,
};

use crate::types::{AppError, AuthInfo};

/// Credential used to authorize a SEAL decrypt request.
///
/// ENG-1697: `Session` (an exported `SessionKey`, built on the client) is
/// preferred. `DelegateKey` is the legacy path where the SDK transmits the
/// raw Ed25519 private key — retained temporarily so existing clients keep
/// working. At EOL the `DelegateKey` variant will be removed.
#[derive(Debug, Clone)]
pub enum SealCredential {
    Session(String),
    DelegateKey(String),
}

impl SealCredential {
    /// Build the credential from an `AuthInfo`, preferring `seal_session`
    /// when present. Falls back to `delegate_key` (legacy), then to a
    /// server-side fallback private key. Returns `None` if no credential.
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

/// Cached SEAL key server info
pub struct SealKeyServer {
    pub object_id: ObjectID,
    /// Key server HTTP URL (e.g. "https://seal-ks-1.mysten.io")
    pub url: String,
    /// Cached IBE public key (fetched at startup)
    pub public_key: IBEPublicKey,
}

/// SEAL state initialized at startup and shared via AppState
pub struct SealState {
    pub key_servers: Vec<SealKeyServer>,
    pub threshold: u8,
    pub package_id: String,
}

impl SealState {
    /// Initialize SEAL state: fetch public keys from each key server.
    /// Called once at startup.
    pub async fn init(
        http_client: &reqwest::Client,
        key_server_object_ids: &[String],
        threshold: u8,
        package_id: &str,
        sui_network: &str,
    ) -> Result<Self, String> {
        if key_server_object_ids.is_empty() {
            return Err("SEAL_KEY_SERVERS is empty — SEAL operations will fail".to_string());
        }

        let mut key_servers = Vec::new();

        // Determine key server URLs from object IDs
        let base_urls = get_key_server_urls(sui_network, key_server_object_ids);

        for (object_id_str, url) in key_server_object_ids.iter().zip(base_urls.iter()) {
            let object_id = parse_object_id(object_id_str)
                .map_err(|e| format!("Invalid key server object ID '{}': {}", object_id_str, e))?;

            // Fetch public key from key server /v1/service endpoint
            let service_url = format!("{}/v1/service", url);
            let resp = http_client
                .get(&service_url)
                .send()
                .await
                .map_err(|e| format!("Failed to fetch key server {} service info: {}", url, e))?;

            if !resp.status().is_success() {
                return Err(format!(
                    "Key server {} returned {}: {}",
                    url,
                    resp.status(),
                    resp.text().await.unwrap_or_default()
                ));
            }

            let service_info: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse key server {} response: {}", url, e))?;

            // Parse IBE public key from service info
            let pk_hex = service_info
                .get("public_key")
                .or_else(|| service_info.get("pk"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("Key server {} missing public_key field", url))?;

            let pk_bytes = hex::decode(pk_hex)
                .map_err(|e| format!("Invalid public key hex from {}: {}", url, e))?;

            let public_key: IBEPublicKey = bcs::from_bytes(&pk_bytes)
                .map_err(|e| format!("Failed to deserialize IBE public key from {}: {}", url, e))?;

            key_servers.push(SealKeyServer {
                object_id,
                url: url.clone(),
                public_key,
            });
        }

        tracing::info!(
            "SEAL state initialized: {} key servers, threshold={}",
            key_servers.len(),
            threshold
        );

        Ok(Self {
            key_servers,
            threshold,
            package_id: package_id.to_string(),
        })
    }

    /// Get the public key map (ObjectID → IBEPublicKey) for crypto operations
    fn public_key_map(&self) -> HashMap<ObjectID, IBEPublicKey> {
        self.key_servers
            .iter()
            .map(|ks| (ks.object_id, ks.public_key))
            .collect()
    }

    /// Get the list of key server ObjectIDs
    fn key_server_ids(&self) -> Vec<ObjectID> {
        self.key_servers.iter().map(|ks| ks.object_id).collect()
    }

    /// Get the IBEPublicKeys for encryption
    fn ibe_public_keys(&self) -> IBEPublicKeys {
        IBEPublicKeys::BonehFranklinBLS12381(
            self.key_servers.iter().map(|ks| ks.public_key).collect(),
        )
    }
}

/// Encrypt plaintext using SEAL threshold encryption (local, pure crypto).
///
/// ENG-1700: Replaces HTTP call to sidecar POST /seal/encrypt.
/// This is ~1ms local crypto — no network needed.
pub fn native_seal_encrypt(
    seal_state: &SealState,
    data: &[u8],
    owner_address: &str,
) -> Result<Vec<u8>, AppError> {
    let package_id = parse_object_id(&seal_state.package_id)
        .map_err(|e| AppError::Internal(format!("Invalid package_id: {}", e)))?;

    let key_server_ids = seal_state.key_server_ids();
    let public_keys = seal_state.ibe_public_keys();

    // `id` is typically the owner address bytes — used as the IBE identity
    let id = hex::decode(owner_address.strip_prefix("0x").unwrap_or(owner_address))
        .map_err(|e| AppError::Internal(format!("Invalid owner address hex: {}", e)))?;

    let (encrypted_object, _derived_key) = seal_encrypt(
        package_id,
        id,
        key_server_ids,
        &public_keys,
        seal_state.threshold,
        EncryptionInput::Aes256Gcm {
            data: data.to_vec(),
            aad: None,
        },
    )
    .map_err(|e| AppError::Internal(format!("SEAL encrypt failed: {:?}", e)))?;

    let encrypted_bytes = bcs::to_bytes(&encrypted_object)
        .map_err(|e| AppError::Internal(format!("SEAL encrypt BCS serialize failed: {}", e)))?;

    tracing::info!(
        "seal encrypt ok (native): {} bytes -> {} encrypted bytes",
        data.len(),
        encrypted_bytes.len()
    );

    Ok(encrypted_bytes)
}

/// Decrypt SEAL-encrypted data using native Rust.
///
/// ENG-1700: Replaces HTTP call to sidecar POST /seal/decrypt.
///
/// Flow:
/// 1. Parse EncryptedObject from bytes
/// 2. Build seal_approve PTB (using Ed25519 keypair from credential)
/// 3. Create ElGamal keypair for session
/// 4. Build & sign Certificate (session token)
/// 5. HTTP POST to each key server's /v1/fetch_key endpoint
/// 6. Decrypt seal responses → get user secret keys
/// 7. Call seal_decrypt_object() locally
pub async fn native_seal_decrypt(
    http_client: &reqwest::Client,
    seal_state: &SealState,
    encrypted_data: &[u8],
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
    sui_rpc_url: &str,
) -> Result<Vec<u8>, AppError> {
    // Step 1: Parse encrypted object
    let encrypted_object: EncryptedObject = bcs::from_bytes(encrypted_data)
        .map_err(|e| AppError::Internal(format!("Failed to parse EncryptedObject: {}", e)))?;

    // Step 2: Route based on credential type
    match credential {
        SealCredential::Session(session_b64) => {
            decrypt_with_client_session(
                http_client,
                seal_state,
                encrypted_data,
                &encrypted_object,
                session_b64,
                package_id,
                account_id,
                sui_rpc_url,
            )
            .await
        }
        SealCredential::DelegateKey(_key_hex) => {
            // DelegateKey path requires constructing a full Certificate with
            // UserSignature (sui_sdk_types wallet signature), which is complex
            // to replicate server-side. Use x-seal-session instead.
            Err(AppError::Internal(
                "DelegateKey decrypt is not supported in native mode. \
                 Use x-seal-session header (SessionKey) instead."
                    .into(),
            ))
        }
    }
}

/// Decrypt using a client-provided SessionKey (x-seal-session header).
/// The session is a base64-encoded JSON export of SessionKey from the TS SDK.
async fn decrypt_with_client_session(
    http_client: &reqwest::Client,
    seal_state: &SealState,
    encrypted_data: &[u8],
    encrypted_object: &EncryptedObject,
    session_b64: &str,
    package_id: &str,
    account_id: &str,
    _sui_rpc_url: &str,
) -> Result<Vec<u8>, AppError> {
    // Decode the exported session
    let session_json = BASE64
        .decode(session_b64)
        .map_err(|e| AppError::Internal(format!("Invalid session base64: {}", e)))?;
    let session: serde_json::Value = serde_json::from_slice(&session_json)
        .map_err(|e| AppError::Internal(format!("Invalid session JSON: {}", e)))?;

    // Extract ElGamal secret key from the session (needed for decryption)
    let enc_secret_b64 = session
        .get("encSecret")
        .or_else(|| session.get("enc_secret"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("Session missing enc_secret".into()))?;

    let enc_secret_bytes = BASE64
        .decode(enc_secret_b64)
        .map_err(|e| AppError::Internal(format!("Invalid enc_secret base64: {}", e)))?;
    let enc_secret: ElGamalSecretKey = bcs::from_bytes(&enc_secret_bytes)
        .map_err(|e| AppError::Internal(format!("Failed to deserialize enc_secret: {}", e)))?;

    // Extract other session fields for key server request
    let enc_key_b64 = session
        .get("encKey")
        .or_else(|| session.get("enc_key"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("Session missing enc_key".into()))?;
    let enc_verification_b64 = session
        .get("encVerificationKey")
        .or_else(|| session.get("enc_verification_key"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("Session missing enc_verification_key".into()))?;
    let signature_b64 = session
        .get("signedMessage")
        .or_else(|| session.get("signature"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("Session missing signature".into()))?;

    // Build seal_approve PTB
    let ptb = build_seal_approve_ptb(package_id, &encrypted_object.id, account_id)?;
    let ptb_bytes = bcs::to_bytes(&ptb)
        .map_err(|e| AppError::Internal(format!("Failed to serialize PTB: {}", e)))?;

    // Build the request JSON to send to key servers
    let request_json = serde_json::json!({
        "ptb": BASE64.encode(&ptb_bytes),
        "enc_key": enc_key_b64,
        "enc_verification_key": enc_verification_b64,
        "signature": signature_b64,
        "certificate": session.get("certificate").cloned().unwrap_or(serde_json::Value::Null),
    });

    // Fetch keys from each key server
    let mut seal_responses: Vec<(ObjectID, FetchKeyResponse)> = Vec::new();

    for ks in &seal_state.key_servers {
        let url = format!("{}/v1/fetch_key", ks.url);

        let resp = http_client
            .post(&url)
            .json(&request_json)
            .send()
            .await
            .map_err(|e| {
                AppError::Internal(format!(
                    "SEAL key server {} fetch_key failed: {}",
                    ks.url, e
                ))
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!(
                "SEAL key server {} returned {}: {}",
                ks.url,
                status,
                body
            );
            continue;
        }

        let fetch_resp: FetchKeyResponse = resp.json().await.map_err(|e| {
            AppError::Internal(format!(
                "Failed to parse fetch_key response from {}: {}",
                ks.url, e
            ))
        })?;

        seal_responses.push((ks.object_id, fetch_resp));
    }

    if (seal_responses.len() as u8) < seal_state.threshold {
        return Err(AppError::Internal(format!(
            "Not enough key server responses: got {}, need {}",
            seal_responses.len(),
            seal_state.threshold
        )));
    }

    // Decrypt seal responses
    let server_pk_map = seal_state.public_key_map();
    let cached_keys = decrypt_seal_responses(&enc_secret, &seal_responses, &server_pk_map)
        .map_err(|e| AppError::Internal(format!("decrypt_seal_responses failed: {:?}", e)))?;

    // Decrypt the object
    let plaintext = seal_decrypt_object(encrypted_object, &cached_keys, &server_pk_map)
        .map_err(|e| AppError::Internal(format!("seal_decrypt_object failed: {:?}", e)))?;

    tracing::info!(
        "seal decrypt ok (native/session): {} encrypted bytes -> {} decrypted bytes",
        encrypted_data.len(),
        plaintext.len()
    );

    Ok(plaintext)
}

// ============================================================
// Helper functions
// ============================================================

fn parse_object_id(s: &str) -> Result<ObjectID, String> {
    let hex_str = s.strip_prefix("0x").unwrap_or(s);
    // Pad to 64 hex chars (32 bytes) if shorter
    let padded = format!("{:0>64}", hex_str);
    let bytes =
        hex::decode(&padded).map_err(|e| format!("Invalid hex: {}", e))?;
    if bytes.len() != 32 {
        return Err(format!("ObjectId must be 32 bytes, got {}", bytes.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(ObjectID::new(arr))
}

/// Build a ProgrammableTransaction for seal_approve.
/// This mirrors the TS: tx.moveCall({ target: `${packageId}::account::seal_approve`, args: [id_bytes, accountId] })
fn build_seal_approve_ptb(
    package_id: &str,
    id_bytes: &[u8],
    account_id: &str,
) -> Result<sui_sdk_types::ProgrammableTransaction, AppError> {
    use sui_sdk_types::*;

    let pkg = parse_object_id(package_id)
        .map_err(|e| AppError::Internal(format!("Invalid package_id: {}", e)))?;
    let account_obj_id = parse_object_id(account_id)
        .map_err(|e| AppError::Internal(format!("Invalid account_id: {}", e)))?;

    // Input 0: pure vector<u8> (id bytes, BCS-encoded)
    // Input 1: shared object (account_id) — use initial_shared_version=0,
    //          the key server re-resolves the actual version.
    let inputs = vec![
        Input::Pure(id_bytes.to_vec()),
        Input::Shared(SharedInput::new(
            Address::new(account_obj_id.into_inner()),
            0,
            Mutability::Mutable,
        )),
    ];

    let commands = vec![Command::MoveCall(MoveCall {
        package: Address::new(pkg.into_inner()),
        module: Identifier::new("account")
            .map_err(|e| AppError::Internal(format!("Invalid module name: {:?}", e)))?,
        function: Identifier::new("seal_approve")
            .map_err(|e| AppError::Internal(format!("Invalid function name: {:?}", e)))?,
        type_arguments: vec![],
        arguments: vec![Argument::Input(0), Argument::Input(1)],
    })];

    Ok(ProgrammableTransaction { inputs, commands })
}

/// Get key server URLs for the given network.
fn get_key_server_urls(network: &str, object_ids: &[String]) -> Vec<String> {
    if let Ok(urls) = std::env::var("SEAL_KEY_SERVER_URLS") {
        let parsed: Vec<String> = urls
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if parsed.len() == object_ids.len() {
            return parsed;
        }
        tracing::warn!(
            "SEAL_KEY_SERVER_URLS has {} entries but {} key servers configured, using defaults",
            parsed.len(),
            object_ids.len()
        );
    }

    match network {
        "testnet" => object_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("https://seal-ks-testnet-{}.mysten.io", i))
            .collect(),
        _ => object_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("https://seal-ks-{}.mysten.io", i))
            .collect(),
    }
}
