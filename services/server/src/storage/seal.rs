use crate::types::{AppError, AuthInfo};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use fastcrypto::ed25519::Ed25519KeyPair;
use fastcrypto::encoding::Bech32;
use fastcrypto::serde_helpers::ToFromByteArray;
use fastcrypto::traits::{KeyPair, Signer, ToFromBytes};
use seal_crypto::{EncryptedObject, EncryptionInput, IBEPublicKeys};
use seal_sdk::types::{Certificate, FetchKeyRequest, FetchKeyResponse};
use seal_sdk::{decrypt_seal_responses, genkey, seal_decrypt_object, signed_request, IBEPublicKey};
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sui_sdk_types::{
    Address, Argument, Command, Digest, Ed25519PublicKey as SuiEd25519PublicKey,
    Ed25519Signature as SuiEd25519Signature, Identifier, Input, MoveCall, ObjectReference,
    PersonalMessage, ProgrammableTransaction, SimpleSignature, UserSignature,
};

const SEAL_KEY_SERVER_TIMEOUT: Duration = Duration::from_secs(10);
const SUI_PRIVKEY_HRP: &str = "suiprivkey";
const SUI_ED25519_FLAG: u8 = 0x00;

static KEY_SERVERS: tokio::sync::OnceCell<Vec<KeyServerInfo>> = tokio::sync::OnceCell::const_new();

/// Credential used to authorize a SEAL decrypt request.
///
/// `Session` is an exported TS SDK `SessionKey`, base64-encoded as JSON.
/// `DelegateKey` is the legacy raw Ed25519 private key path retained for
/// older SDKs. Both paths are handled natively in Rust now.
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

#[derive(Clone, Debug)]
struct SealServerConfig {
    object_id: String,
    weight: usize,
    aggregator_url: Option<String>,
    api_key_name: Option<String>,
    api_key: Option<String>,
}

#[derive(Clone, Debug)]
struct KeyServerInfo {
    object_id: Address,
    name: String,
    url: String,
    pk: IBEPublicKey,
    weight: usize,
    api_key_name: Option<String>,
    api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSealServerConfig {
    object_id: String,
    weight: Option<usize>,
    aggregator_url: Option<String>,
    api_key_name: Option<String>,
    api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedSessionKey {
    address: String,
    package_id: String,
    mvr_name: Option<String>,
    creation_time_ms: u64,
    ttl_min: u16,
    personal_message_signature: Option<String>,
    session_key: String,
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
        let lower = err.to_ascii_lowercase();
        if lower.contains("timeout")
            || lower.contains("fetch_keys failed")
            || lower.contains("too many failed fetch")
            || lower.contains("internal server")
            || lower.contains("temporarily unavailable")
            || lower.contains("rate limit")
            || lower.contains("429")
            || lower.contains("503")
        {
            return false;
        }

        err.contains("Not enough shares")
            || err.contains("InvalidCiphertext")
            || err.contains("InvalidPersonalMessageSignature")
            || err.contains("invalid personal message signature")
    }
}

/// Encrypt plaintext using native Rust SEAL primitives.
///
/// The ciphertext identity is the owner's Sui address, matching the old TS
/// `SealClient.encrypt({ id: owner })` path.
pub async fn seal_encrypt(
    client: &reqwest::Client,
    data: &[u8],
    owner_address: &str,
    package_id: &str,
    rpc_url: &str,
    network: &str,
) -> Result<Vec<u8>, AppError> {
    let started = std::time::Instant::now();
    let key_servers = get_key_servers(client, rpc_url, network).await?;
    let package = parse_address(package_id, "package_id")?;
    let owner = parse_address(owner_address, "owner")?;
    let threshold = configured_threshold(key_servers)?;

    let mut service_ids = Vec::new();
    let mut pks = Vec::new();
    for server in key_servers {
        for _ in 0..server.weight {
            service_ids.push(server.object_id);
            pks.push(server.pk);
        }
    }

    let (encrypted_object, _) = seal_crypto::seal_encrypt(
        package,
        owner.into_inner().to_vec(),
        service_ids,
        &IBEPublicKeys::BonehFranklinBLS12381(pks),
        threshold,
        EncryptionInput::Aes256Gcm {
            data: data.to_vec(),
            aad: None,
        },
    )
    .map_err(|e| AppError::Internal(format!("seal encrypt failed: {}", e)))?;

    let encrypted_bytes = bcs::to_bytes(&encrypted_object)
        .map_err(|e| AppError::Internal(format!("seal encrypt serialize failed: {}", e)))?;

    crate::observability::observe_external(
        "seal_rust",
        "encrypt",
        "ok",
        started.elapsed(),
    );
    tracing::info!(
        "seal encrypt ok: {} bytes -> {} encrypted bytes",
        data.len(),
        encrypted_bytes.len()
    );
    Ok(encrypted_bytes)
}

/// Decrypt a SEAL-encrypted object using a client SessionKey or legacy
/// delegate private key. The generated PTB calls `account::seal_approve`
/// against the caller's MemWal account object.
pub async fn seal_decrypt(
    client: &reqwest::Client,
    encrypted_data: &[u8],
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
    rpc_url: &str,
    network: &str,
) -> Result<Vec<u8>, AppError> {
    let encrypted_object = parse_encrypted_object(encrypted_data)?;
    let outcomes = decrypt_objects(
        client,
        vec![encrypted_object],
        credential,
        package_id,
        account_id,
        rpc_url,
        network,
    )
    .await?;

    match outcomes.into_iter().next() {
        Some(DecryptOutcome::Ok(bytes)) => Ok(bytes),
        Some(DecryptOutcome::Failed { error, .. }) => {
            Err(AppError::Internal(format!("seal decrypt failed: {}", error)))
        }
        _ => Err(AppError::Internal("seal decrypt failed: missing result".into())),
    }
}

/// Batch-decrypt multiple SEAL-encrypted blobs with one key fetch.
pub async fn seal_decrypt_batch(
    client: &reqwest::Client,
    encrypted_blobs: &[(String, Vec<u8>)],
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
    rpc_url: &str,
    network: &str,
) -> Result<Vec<DecryptOutcome>, AppError> {
    if encrypted_blobs.is_empty() {
        return Ok(vec![]);
    }

    let mut parsed = Vec::new();
    let mut out: Vec<DecryptOutcome> = (0..encrypted_blobs.len())
        .map(|_| DecryptOutcome::Missing)
        .collect();

    for (idx, (blob_id, bytes)) in encrypted_blobs.iter().enumerate() {
        match parse_encrypted_object(bytes) {
            Ok(object) => parsed.push((idx, object)),
            Err(err) => {
                tracing::warn!(
                    "seal decrypt-batch parse failed for blob {} (index {}): {}",
                    blob_id,
                    idx,
                    err
                );
                out[idx] = DecryptOutcome::Failed {
                    error: err.to_string(),
                    permanent: true,
                };
            }
        }
    }

    if parsed.is_empty() {
        return Ok(out);
    }

    let objects = parsed.iter().map(|(_, object)| object.clone()).collect();
    let decrypted = decrypt_objects(
        client, objects, credential, package_id, account_id, rpc_url, network,
    )
    .await?;

    for ((original_index, _), outcome) in parsed.into_iter().zip(decrypted) {
        if let DecryptOutcome::Failed { ref error, permanent } = outcome {
            let blob_id = encrypted_blobs
                .get(original_index)
                .map(|(id, _)| id.as_str())
                .unwrap_or("?");
            tracing::warn!(
                "seal decrypt-batch error for blob {} (index {}, permanent={}): {}",
                blob_id,
                original_index,
                permanent,
                error
            );
        }
        out[original_index] = outcome;
    }

    let ok = out
        .iter()
        .filter(|outcome| matches!(outcome, DecryptOutcome::Ok(_)))
        .count();
    let failed = out
        .iter()
        .filter(|outcome| matches!(outcome, DecryptOutcome::Failed { .. }))
        .count();
    tracing::info!(
        "seal decrypt-batch ok: {}/{} decrypted, {} errors",
        ok,
        encrypted_blobs.len(),
        failed
    );
    Ok(out)
}

async fn decrypt_objects(
    client: &reqwest::Client,
    encrypted_objects: Vec<EncryptedObject>,
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
    rpc_url: &str,
    network: &str,
) -> Result<Vec<DecryptOutcome>, AppError> {
    if encrypted_objects.is_empty() {
        return Ok(Vec::new());
    }

    let expected_package = parse_address(package_id, "package_id")?;
    for object in &encrypted_objects {
        if object.package_id != expected_package {
            return Err(AppError::Internal(format!(
                "seal package mismatch: ciphertext package {} != request package {}",
                object.package_id, expected_package
            )));
        }
    }

    let key_servers = get_key_servers(client, rpc_url, network).await?;
    let mut unique_ids = Vec::<Vec<u8>>::new();
    let mut seen = HashSet::<Vec<u8>>::new();
    let mut threshold = 1u8;
    for object in &encrypted_objects {
        if seen.insert(object.id.clone()) {
            unique_ids.push(object.id.clone());
        }
        threshold = threshold.max(object.threshold);
    }

    let account_ref = fetch_object_reference(client, rpc_url, account_id).await?;
    let ptb = build_seal_approve_ptb(expected_package, account_ref, &unique_ids)?;
    let session = credential.to_session(package_id)?;
    let (enc_secret, enc_pk, enc_vk) = genkey(&mut rand::thread_rng());
    let request_message = signed_request(&ptb, &enc_pk, &enc_vk);
    let request_signature = session.session_key.sign(&request_message);

    let request = FetchKeyRequest {
        ptb: BASE64.encode(
            bcs::to_bytes(&ptb)
                .map_err(|e| AppError::Internal(format!("seal PTB serialize failed: {}", e)))?,
        ),
        enc_key: enc_pk,
        enc_verification_key: enc_vk,
        request_signature,
        certificate: session.certificate,
    };

    let seal_responses = fetch_key_responses(client, key_servers, &request, threshold).await?;
    let server_pk_map: HashMap<Address, IBEPublicKey> = key_servers
        .iter()
        .map(|server| (server.object_id, server.pk))
        .collect();
    let cached_keys = decrypt_seal_responses(&enc_secret, &seal_responses, &server_pk_map)
        .map_err(|e| AppError::Internal(format!("seal key decrypt failed: {}", e)))?;

    let mut out = Vec::with_capacity(encrypted_objects.len());
    for object in &encrypted_objects {
        match seal_decrypt_object(object, &cached_keys, &server_pk_map) {
            Ok(bytes) => out.push(DecryptOutcome::Ok(bytes)),
            Err(err) => {
                let error = format!("decrypt failed: {}", err);
                out.push(DecryptOutcome::Failed {
                    permanent: DecryptOutcome::permanent_from_error(&error),
                    error,
                });
            }
        }
    }
    Ok(out)
}

struct NativeSession {
    session_key: Ed25519KeyPair,
    certificate: Certificate,
}

impl SealCredential {
    fn to_session(&self, package_id: &str) -> Result<NativeSession, AppError> {
        match self {
            SealCredential::Session(header) => import_session_key(header, package_id),
            SealCredential::DelegateKey(private_key) => create_legacy_session(private_key, package_id),
        }
    }
}

fn import_session_key(header: &str, package_id: &str) -> Result<NativeSession, AppError> {
    let exported_json = BASE64
        .decode(header)
        .map_err(|e| AppError::BadRequest(format!("Invalid x-seal-session base64: {}", e)))?;
    let exported: ExportedSessionKey = serde_json::from_slice(&exported_json)
        .map_err(|e| AppError::BadRequest(format!("Invalid x-seal-session JSON: {}", e)))?;

    if normalize_object_id(&exported.package_id)? != normalize_object_id(package_id)? {
        return Err(AppError::BadRequest(
            "x-seal-session packageId does not match request package".into(),
        ));
    }
    if session_expired(exported.creation_time_ms, exported.ttl_min) {
        return Err(AppError::BadRequest("x-seal-session is expired".into()));
    }

    let session_key = keypair_from_private_key(&exported.session_key)?;
    let signature = exported.personal_message_signature.ok_or_else(|| {
        AppError::BadRequest("x-seal-session missing personalMessageSignature".into())
    })?;

    let certificate = Certificate {
        user: parse_address(&exported.address, "session address")?,
        session_vk: session_key.public().clone(),
        creation_time: exported.creation_time_ms,
        ttl_min: exported.ttl_min,
        signature: UserSignature::from_base64(&signature).map_err(|e| {
            AppError::BadRequest(format!("Invalid x-seal-session signature: {}", e))
        })?,
        mvr_name: exported.mvr_name,
    };

    Ok(NativeSession {
        session_key,
        certificate,
    })
}

fn create_legacy_session(private_key: &str, package_id: &str) -> Result<NativeSession, AppError> {
    let user_key = keypair_from_private_key(private_key)?;
    let mut rng = rand::thread_rng();
    let session_key = Ed25519KeyPair::generate(&mut rng);
    let creation_time = now_ms();
    let ttl_min = 5u16;
    let message = seal_sdk::signed_message(
        package_id.to_string(),
        session_key.public(),
        creation_time,
        ttl_min,
    );
    let digest = PersonalMessage(Cow::Borrowed(message.as_bytes())).signing_digest();
    let signature = user_key.sign(&digest);
    let signature_bytes: [u8; 64] = signature
        .as_ref()
        .try_into()
        .map_err(|_| AppError::Internal("ed25519 signature length mismatch".into()))?;
    let public_key_bytes: [u8; 32] = user_key
        .public()
        .as_ref()
        .try_into()
        .map_err(|_| AppError::Internal("ed25519 public key length mismatch".into()))?;
    let sui_public_key = SuiEd25519PublicKey::new(public_key_bytes);

    let certificate = Certificate {
        user: sui_public_key.derive_address(),
        session_vk: session_key.public().clone(),
        creation_time,
        ttl_min,
        signature: UserSignature::Simple(SimpleSignature::Ed25519 {
            signature: SuiEd25519Signature::new(signature_bytes),
            public_key: sui_public_key,
        }),
        mvr_name: None,
    };

    Ok(NativeSession {
        session_key,
        certificate,
    })
}

fn keypair_from_private_key(value: &str) -> Result<Ed25519KeyPair, AppError> {
    let trimmed = value.trim();
    let secret = if trimmed.starts_with(SUI_PRIVKEY_HRP) {
        let decoded = Bech32::decode(trimmed, SUI_PRIVKEY_HRP)
            .map_err(|_| AppError::BadRequest("Invalid suiprivkey encoding".into()))?;
        if decoded.len() != 33 || decoded[0] != SUI_ED25519_FLAG {
            return Err(AppError::BadRequest(
                "Only Ed25519 suiprivkey credentials are supported".into(),
            ));
        }
        decoded[1..].to_vec()
    } else {
        if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(
                "private key must be suiprivkey bech32 or 64-char hex".into(),
            ));
        }
        hex::decode(trimmed)
            .map_err(|e| AppError::BadRequest(format!("Invalid private key hex: {}", e)))?
    };

    Ed25519KeyPair::from_bytes(&secret)
        .map_err(|e| AppError::BadRequest(format!("Invalid Ed25519 private key: {}", e)))
}

fn session_expired(creation_time_ms: u64, ttl_min: u16) -> bool {
    let ttl_ms = ttl_min as u64 * 60 * 1_000;
    creation_time_ms
        .saturating_add(ttl_ms)
        .saturating_sub(10_000)
        < now_ms()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_encrypted_object(bytes: &[u8]) -> Result<EncryptedObject, AppError> {
    bcs::from_bytes(bytes)
        .map_err(|e| AppError::Internal(format!("seal encrypted object parse failed: {}", e)))
}

fn build_seal_approve_ptb(
    package_id: Address,
    account_ref: ObjectReference,
    ids: &[Vec<u8>],
) -> Result<ProgrammableTransaction, AppError> {
    let mut inputs = Vec::with_capacity(ids.len() + 1);
    for id in ids {
        inputs.push(Input::Pure(
            bcs::to_bytes(id)
                .map_err(|e| AppError::Internal(format!("seal id serialize failed: {}", e)))?,
        ));
    }
    let account_index = inputs.len() as u16;
    inputs.push(Input::ImmutableOrOwned(account_ref));

    let module = Identifier::from_str("account")
        .map_err(|e| AppError::Internal(format!("invalid SEAL module identifier: {}", e)))?;
    let function = Identifier::from_str("seal_approve")
        .map_err(|e| AppError::Internal(format!("invalid SEAL function identifier: {}", e)))?;

    let commands = (0..ids.len())
        .map(|idx| {
            Command::MoveCall(MoveCall {
                package: package_id,
                module: module.clone(),
                function: function.clone(),
                type_arguments: vec![],
                arguments: vec![Argument::Input(idx as u16), Argument::Input(account_index)],
            })
        })
        .collect();

    Ok(ProgrammableTransaction { inputs, commands })
}

async fn fetch_key_responses(
    client: &reqwest::Client,
    key_servers: &[KeyServerInfo],
    request: &FetchKeyRequest,
    threshold: u8,
) -> Result<Vec<(Address, FetchKeyResponse)>, AppError> {
    let request_body = request
        .to_json_string()
        .map_err(|e| AppError::Internal(format!("seal fetch-key JSON failed: {}", e)))?;
    let mut responses = Vec::new();
    let mut completed_weight = 0usize;
    let required = threshold as usize;

    for server in key_servers {
        let mut req = client
            .post(format!("{}/v1/fetch_key", server.url.trim_end_matches('/')))
            .timeout(SEAL_KEY_SERVER_TIMEOUT)
            .header("Client-Sdk-Type", "rust")
            .header("Client-Sdk-Version", "memwal")
            .header("Content-Type", "application/json")
            .body(request_body.clone());
        if let (Some(name), Some(key)) = (&server.api_key_name, &server.api_key) {
            req = req.header(name, key);
        }

        let started = std::time::Instant::now();
        match crate::observability::apply_request_id_header(req).send().await {
            Ok(resp) if resp.status().is_success() => {
                crate::observability::observe_external(
                    "seal_key_server",
                    "fetch_key",
                    &resp.status().as_u16().to_string(),
                    started.elapsed(),
                );
                let parsed = resp.json::<FetchKeyResponse>().await.map_err(|e| {
                    AppError::Internal(format!(
                        "seal key server {} response parse failed: {}",
                        server.name, e
                    ))
                })?;
                responses.push((server.object_id, parsed));
                completed_weight += server.weight;
                if completed_weight >= required {
                    return Ok(responses);
                }
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                crate::observability::observe_external(
                    "seal_key_server",
                    "fetch_key",
                    &status.as_u16().to_string(),
                    started.elapsed(),
                );
                tracing::warn!(
                    "seal key server {} failed status={} body={}",
                    server.name,
                    status,
                    body_snippet(&body)
                );
            }
            Err(err) => {
                crate::observability::observe_external(
                    "seal_key_server",
                    "fetch_key",
                    "transport_error",
                    started.elapsed(),
                );
                tracing::warn!("seal key server {} request failed: {}", server.name, err);
            }
        }
    }

    Err(AppError::Internal(format!(
        "fetch_keys failed: got weight {} < threshold {}",
        completed_weight, required
    )))
}

async fn get_key_servers(
    client: &reqwest::Client,
    rpc_url: &str,
    network: &str,
) -> Result<&'static [KeyServerInfo], AppError> {
    let rpc_url = rpc_url.to_string();
    let network = network.to_string();
    KEY_SERVERS
        .get_or_try_init(|| async move {
            let configs = seal_server_configs(&network)?;
            let mut servers = Vec::with_capacity(configs.len());
            for config in configs {
                servers.push(fetch_key_server(client, &rpc_url, config).await?);
            }
            if servers.is_empty() {
                return Err(AppError::Internal(
                    "No SEAL key servers configured for this network".into(),
                ));
            }
            Ok(servers)
        })
        .await
        .map(|servers| servers.as_slice())
}

fn configured_threshold(key_servers: &[KeyServerInfo]) -> Result<u8, AppError> {
    let total_weight: usize = key_servers.iter().map(|server| server.weight).sum();
    let default = total_weight.min(2).max(1);
    let threshold = std::env::var("SEAL_THRESHOLD")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(default);

    if threshold == 0 || threshold > total_weight || threshold > u8::MAX as usize {
        return Err(AppError::Internal(format!(
            "Invalid SEAL_THRESHOLD {}; total configured weight is {}",
            threshold, total_weight
        )));
    }
    Ok(threshold as u8)
}

fn seal_server_configs(network: &str) -> Result<Vec<SealServerConfig>, AppError> {
    if let Ok(raw) = std::env::var("SEAL_SERVER_CONFIGS") {
        let raw = raw.trim();
        if !raw.is_empty() {
            let parsed: Vec<RawSealServerConfig> = serde_json::from_str(raw).map_err(|e| {
                AppError::Internal(format!("SEAL_SERVER_CONFIGS must be valid JSON: {}", e))
            })?;
            return parsed
                .into_iter()
                .enumerate()
                .map(|(idx, raw)| normalize_seal_server_config(raw, idx))
                .collect();
        }
    }

    if let Ok(raw) = std::env::var("SEAL_KEY_SERVERS") {
        let configs = raw
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|object_id| SealServerConfig {
                object_id: object_id.to_string(),
                weight: 1,
                aggregator_url: None,
                api_key_name: None,
                api_key: None,
            })
            .collect::<Vec<_>>();
        if !configs.is_empty() {
            return Ok(configs);
        }
    }

    Ok(match network {
        "testnet" => vec![
            SealServerConfig {
                object_id: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75"
                    .to_string(),
                weight: 1,
                aggregator_url: None,
                api_key_name: None,
                api_key: None,
            },
            SealServerConfig {
                object_id: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
                    .to_string(),
                weight: 1,
                aggregator_url: None,
                api_key_name: None,
                api_key: None,
            },
        ],
        _ => vec![
            SealServerConfig {
                object_id: "0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6"
                    .to_string(),
                weight: 1,
                aggregator_url: None,
                api_key_name: None,
                api_key: None,
            },
            SealServerConfig {
                object_id: "0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10"
                    .to_string(),
                weight: 1,
                aggregator_url: None,
                api_key_name: None,
                api_key: None,
            },
        ],
    })
}

fn normalize_seal_server_config(
    raw: RawSealServerConfig,
    idx: usize,
) -> Result<SealServerConfig, AppError> {
    let object_id = non_empty(raw.object_id, "objectId", idx)?;
    let weight = raw.weight.unwrap_or(1);
    if weight == 0 {
        return Err(AppError::Internal(format!(
            "SEAL_SERVER_CONFIGS[{}].weight must be positive",
            idx
        )));
    }
    if (raw.api_key_name.is_some() && raw.api_key.is_none())
        || (raw.api_key_name.is_none() && raw.api_key.is_some())
    {
        return Err(AppError::Internal(format!(
            "SEAL_SERVER_CONFIGS[{}] must provide both apiKeyName and apiKey, or neither",
            idx
        )));
    }
    Ok(SealServerConfig {
        object_id,
        weight,
        aggregator_url: raw.aggregator_url,
        api_key_name: raw.api_key_name,
        api_key: raw.api_key,
    })
}

fn non_empty(value: String, field: &str, idx: usize) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Internal(format!(
            "SEAL_SERVER_CONFIGS[{}].{} must be non-empty",
            idx, field
        )));
    }
    Ok(trimmed.to_string())
}

async fn fetch_key_server(
    client: &reqwest::Client,
    rpc_url: &str,
    config: SealServerConfig,
) -> Result<KeyServerInfo, AppError> {
    let object_id = parse_address(&config.object_id, "key server objectId")?;
    let object = rpc_call(
        client,
        rpc_url,
        "sui_getObject",
        serde_json::json!([config.object_id, { "showContent": true }]),
    )
    .await?;
    let fields = object
        .pointer("/result/data/content/fields")
        .ok_or_else(|| AppError::Internal("SEAL key server object has no fields".into()))?;
    let first = json_u64(fields, "first_version")?;
    let last = json_u64(fields, "last_version")?;
    let version = if (first..=last).contains(&2) {
        2
    } else if (first..=last).contains(&1) {
        1
    } else {
        return Err(AppError::Internal(format!(
            "Unsupported SEAL key server version range {}..={} for {}",
            first, last, config.object_id
        )));
    };

    let dynamic = rpc_call(
        client,
        rpc_url,
        "suix_getDynamicFieldObject",
        serde_json::json!([config.object_id, { "type": "u64", "value": version.to_string() }]),
    )
    .await?;
    let value_fields = dynamic
        .pointer("/result/data/content/fields/value/fields")
        .ok_or_else(|| {
            AppError::Internal(format!(
                "SEAL key server {} missing version {} dynamic field",
                config.object_id, version
            ))
        })?;

    let name = value_fields
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&config.object_id)
        .to_string();
    let key_type = value_fields
        .get("key_type")
        .and_then(|v| v.as_u64())
        .unwrap_or(u64::MAX);
    if key_type != 0 {
        return Err(AppError::Internal(format!(
            "SEAL key server {} has unsupported key_type {}",
            config.object_id, key_type
        )));
    }
    let pk = parse_ibe_public_key(value_fields.get("pk").ok_or_else(|| {
        AppError::Internal(format!("SEAL key server {} missing pk", config.object_id))
    })?)?;

    let url = match version {
        1 => value_fields
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| {
                AppError::Internal(format!("SEAL key server {} missing url", config.object_id))
            })?,
        2 => parse_v2_key_server_url(value_fields, &config)?,
        _ => unreachable!(),
    };

    Ok(KeyServerInfo {
        object_id,
        name,
        url,
        pk,
        weight: config.weight,
        api_key_name: config.api_key_name,
        api_key: config.api_key,
    })
}

fn parse_v2_key_server_url(
    value_fields: &serde_json::Value,
    config: &SealServerConfig,
) -> Result<String, AppError> {
    let server_type = value_fields.get("server_type").ok_or_else(|| {
        AppError::Internal(format!(
            "SEAL key server {} missing server_type",
            config.object_id
        ))
    })?;
    if let Some(independent) = server_type.get("Independent").or_else(|| {
        server_type
            .get("fields")
            .and_then(|fields| fields.get("Independent"))
    }) {
        return independent
            .get("url")
            .or(Some(independent))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| {
                AppError::Internal(format!(
                    "SEAL key server {} independent server missing url",
                    config.object_id
                ))
            });
    }

    if server_type.get("Committee").is_some()
        || server_type
            .get("fields")
            .and_then(|fields| fields.get("Committee"))
            .is_some()
    {
        return config.aggregator_url.clone().ok_or_else(|| {
            AppError::Internal(format!(
                "Committee SEAL key server {} requires aggregatorUrl in SEAL_SERVER_CONFIGS",
                config.object_id
            ))
        });
    }

    Err(AppError::Internal(format!(
        "SEAL key server {} has unknown server_type shape",
        config.object_id
    )))
}

fn parse_ibe_public_key(value: &serde_json::Value) -> Result<IBEPublicKey, AppError> {
    let bytes = value
        .as_array()
        .ok_or_else(|| AppError::Internal("SEAL public key must be an array".into()))?
        .iter()
        .map(|v| {
            v.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or_else(|| AppError::Internal("SEAL public key has invalid byte".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let array: [u8; 96] = bytes
        .try_into()
        .map_err(|_| AppError::Internal("SEAL public key must be 96 bytes".into()))?;
    IBEPublicKey::from_byte_array(&array)
        .map_err(|e| AppError::Internal(format!("Invalid SEAL public key: {}", e)))
}

async fn fetch_object_reference(
    client: &reqwest::Client,
    rpc_url: &str,
    object_id: &str,
) -> Result<ObjectReference, AppError> {
    let object = rpc_call(
        client,
        rpc_url,
        "sui_getObject",
        serde_json::json!([object_id, {}]),
    )
    .await?;
    let data = object
        .get("result")
        .and_then(|v| v.get("data"))
        .ok_or_else(|| AppError::Internal(format!("Object {} not found", object_id)))?;
    let id = data
        .get("objectId")
        .and_then(|v| v.as_str())
        .unwrap_or(object_id);
    let version = data
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal(format!("Object {} missing version", object_id)))?
        .parse::<u64>()
        .map_err(|e| AppError::Internal(format!("Object {} invalid version: {}", object_id, e)))?;
    let digest = data
        .get("digest")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal(format!("Object {} missing digest", object_id)))?;

    Ok(ObjectReference::new(
        parse_address(id, "objectId")?,
        version,
        Digest::from_str(digest)
            .map_err(|e| AppError::Internal(format!("Object {} invalid digest: {}", object_id, e)))?,
    ))
}

async fn rpc_call(
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
    let request = client
        .post(rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body);
    let started = std::time::Instant::now();
    let response = crate::observability::apply_request_id_header(request)
        .send()
        .await
        .map_err(|e| {
            crate::observability::observe_external(
                "sui_rpc",
                method,
                "transport_error",
                started.elapsed(),
            );
            AppError::Internal(format!("Sui RPC {} request failed: {}", method, e))
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("Sui RPC {} read failed: {}", method, e)))?;
    crate::observability::observe_external(
        "sui_rpc",
        method,
        &status.as_u16().to_string(),
        started.elapsed(),
    );
    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "Sui RPC {} HTTP error {}: {}",
            method,
            status,
            body_snippet(&text)
        )));
    }
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        AppError::Internal(format!(
            "Sui RPC {} invalid JSON: {} body={}",
            method,
            e,
            body_snippet(&text)
        ))
    })?;
    if let Some(error) = json.get("error") {
        return Err(AppError::Internal(format!(
            "Sui RPC {} error: {}",
            method, error
        )));
    }
    Ok(json)
}

fn json_u64(fields: &serde_json::Value, name: &str) -> Result<u64, AppError> {
    fields
        .get(name)
        .and_then(|v| v.as_str().or_else(|| v.as_u64().map(|_| "")))
        .and_then(|s| {
            if s.is_empty() {
                fields.get(name).and_then(|v| v.as_u64())
            } else {
                s.parse::<u64>().ok()
            }
        })
        .ok_or_else(|| AppError::Internal(format!("SEAL key server missing {}", name)))
}

fn parse_address(value: &str, label: &str) -> Result<Address, AppError> {
    Address::from_str(value)
        .map_err(|e| AppError::Internal(format!("Invalid {} address {}: {}", label, value, e)))
}

fn normalize_object_id(value: &str) -> Result<String, AppError> {
    Ok(parse_address(value, "objectId")?.to_string())
}

fn body_snippet(text: &str) -> String {
    const MAX_CHARS: usize = 512;
    let mut snippet: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        snippet.push_str("...");
    }
    snippet.replace('\n', "\\n").replace('\r', "\\r")
}

#[cfg(test)]
mod tests {
    use super::{keypair_from_private_key, DecryptOutcome};
    use fastcrypto::encoding::Bech32;

    #[test]
    fn classifies_seal_timeouts_as_transient() {
        for msg in [
            "fetch_keys failed: TimeoutError: The operation was aborted due to timeout",
            "decrypt failed: TimeoutError: The operation was aborted due to timeout",
            "seal decrypt-batch failed: Internal server error",
            "TooManyFailedFetchKeyRequestsError",
        ] {
            assert!(
                !DecryptOutcome::permanent_from_error(msg),
                "expected transient: {}",
                msg
            );
        }
    }

    #[test]
    fn classifies_clear_seal_auth_or_ciphertext_errors_as_permanent() {
        for msg in [
            "Not enough shares",
            "InvalidCiphertext",
            "InvalidPersonalMessageSignature",
        ] {
            assert!(
                DecryptOutcome::permanent_from_error(msg),
                "expected permanent: {}",
                msg
            );
        }
    }

    #[test]
    fn parses_ed25519_suiprivkey() {
        let mut encoded = vec![0x00];
        encoded.extend([7u8; 32]);
        let bech32 = Bech32::encode(encoded, "suiprivkey").unwrap();
        assert!(keypair_from_private_key(&bech32).is_ok());
    }
}
