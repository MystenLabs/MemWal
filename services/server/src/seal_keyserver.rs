//! SEAL key-server HTTP transport + on-chain committee resolver.
//!
//! `seal-sdk` (the Mysten Rust crate) ships the cryptographic primitives
//! (`seal_encrypt`, `signed_request`, `decrypt_seal_responses`) but does NOT
//! ship an HTTP client for the threshold key-server endpoints. The TS SDK
//! (`@mysten/seal`) wraps `/v1/fetch_key` + `/v1/public_key` for free; we
//! reimplement that wrapper here.
//!
//! Replaces the TS sidecar-side machinery for:
//! - sidecar `POST /seal/encrypt` (TS `sealClient.encrypt`)
//! - sidecar `POST /seal/decrypt` (TS `sealClient.fetchKeys` + `decrypt`)
//! - sidecar `POST /seal/decrypt-batch` (TS batch decrypt loop)
//!
//! Module responsibilities:
//! 1. **Resolve key-server committee from chain**: given a list of
//!    `KeyServer` object IDs (Move type `seal::key_server::KeyServer`),
//!    fetch the V1 dynamic field at version `1u64` to extract `url` + `pk`
//!    (BLS12-381 G2 public key, 96 bytes). Cached per process.
//! 2. **Fan out `/v1/fetch_key` POST**: build one request body
//!    (`FetchKeyRequest::to_json_string()`) and send it to all servers in
//!    parallel with a 30s timeout. Collect successful `FetchKeyResponse`
//!    JSON bodies. Caller checks the threshold.
//!
//! All threshold aggregation + decryption happens in `crate::seal`.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crypto::ibe::PublicKey as IBEPublicKey;
use crypto::ObjectID;
use fastcrypto::serde_helpers::ToFromByteArray;
use once_cell::sync::Lazy;
use seal_sdk::FetchKeyResponse;
use std::str::FromStr;
use tokio::sync::Mutex;

// Re-use a single 30s reqwest client per process. The caller can also pass in
// the ambient `&reqwest::Client` if it has one (tests do this).
const FETCH_KEY_TIMEOUT: Duration = Duration::from_secs(30);
const SUI_RPC_TIMEOUT: Duration = Duration::from_secs(15);

/// V1 KeyServer expected `pk` length (BLS12-381 G2 compressed).
pub const IBE_PUBKEY_BYTES: usize = 96;

// Re-export via once_cell — `std::sync::LazyLock` is 1.80+ and the workspace
// pins to an older toolchain in CI; once_cell is already a transient dep.
#[allow(dead_code)]
type CommitteeCache = Mutex<HashMap<String, Arc<KeyServerInfo>>>;

static COMMITTEE_CACHE: Lazy<CommitteeCache> = Lazy::new(|| Mutex::new(HashMap::new()));

/// One SEAL key server endpoint, identified by its on-chain object ID.
#[derive(Clone)]
pub struct KeyServerInfo {
    /// On-chain key-server object ID (lowercase 0x-prefixed hex).
    pub object_id: ObjectID,
    /// Pretty name from the on-chain V1 KeyServer struct (used in logs only).
    pub name: String,
    /// Base URL (e.g. `https://seal-key-server-testnet-1.mystenlabs.com`).
    pub url: String,
    /// BLS12-381 G2 public key parsed from on-chain `pk` bytes.
    pub public_key: IBEPublicKey,
}

impl std::fmt::Debug for KeyServerInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyServerInfo")
            .field("object_id", &self.object_id.to_string())
            .field("name", &self.name)
            .field("url", &self.url)
            // public_key debug-prints as a long hex blob — keep it short
            .field("public_key", &"<G2Element>")
            .finish()
    }
}

/// Errors from key-server resolution + transport.
#[derive(Debug, thiserror::Error)]
pub enum KeyServerError {
    #[error("invalid key-server object id `{0}`: {1}")]
    InvalidObjectId(String, String),
    #[error("Sui RPC error fetching key server `{id}`: {message}")]
    Rpc { id: String, message: String },
    #[error("key server `{id}` returned no V1 dynamic field at version=1")]
    MissingV1Field { id: String },
    #[error("key server `{id}` V1 fields missing or malformed: {err}")]
    MalformedFields { id: String, err: String },
    #[error("key server `{id}` pk bytes invalid (got {got}, expected 96)")]
    InvalidPubkey { id: String, got: usize },
    #[error("key server `{0}` BLS12-381 G2 deserialize failed")]
    BlsDeserialize(String),
    #[error("key server `{0}` HTTP request failed: {1}")]
    Http(String, String),
    #[error("key server `{0}` HTTP {1}: {2}")]
    HttpStatus(String, u16, String),
    #[error("key server `{0}` returned malformed JSON body: {1}")]
    MalformedResponse(String, String),
}

// ============================================================
// Public API
// ============================================================

/// Read `SEAL_KEY_SERVERS` from the environment as a comma-separated list of
/// hex object IDs. Empty entries are filtered. Empty list returns
/// `Vec::new()` — caller decides if that is fatal.
pub fn key_server_ids_from_env() -> Vec<String> {
    std::env::var("SEAL_KEY_SERVERS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// Read `SEAL_THRESHOLD` from env, default 2. Caller is responsible for
/// validating `threshold <= committee.len()`.
pub fn seal_threshold_from_env() -> u8 {
    std::env::var("SEAL_THRESHOLD")
        .ok()
        .and_then(|s| s.parse::<u8>().ok())
        .unwrap_or(2)
}

/// Resolve a list of `KeyServer` object IDs to fully populated
/// `KeyServerInfo` structs. Hits the per-process cache first; missing
/// entries are fetched from `sui_rpc_url` via `suix_getDynamicFieldObject`
/// (V1 dynamic field at `name = u64(1)`).
///
/// Order of the returned vec is the same as `key_server_ids`.
pub async fn resolve_committee(
    http: &reqwest::Client,
    sui_rpc_url: &str,
    key_server_ids: &[String],
) -> Result<Vec<Arc<KeyServerInfo>>, KeyServerError> {
    if key_server_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Snapshot what we already have to avoid holding the lock across awaits.
    let mut out: Vec<Option<Arc<KeyServerInfo>>> = Vec::with_capacity(key_server_ids.len());
    {
        let cache = COMMITTEE_CACHE.lock().await;
        for id in key_server_ids {
            out.push(cache.get(&id.to_lowercase()).cloned());
        }
    }

    // Fetch missing entries (sequentially — committees are tiny, 2-3 servers
    // typically, and this is a one-shot warm-up).
    for (idx, id) in key_server_ids.iter().enumerate() {
        if out[idx].is_some() {
            continue;
        }
        let info = fetch_key_server_info(http, sui_rpc_url, id).await?;
        let info_arc = Arc::new(info);
        {
            let mut cache = COMMITTEE_CACHE.lock().await;
            cache.insert(id.to_lowercase(), info_arc.clone());
        }
        out[idx] = Some(info_arc);
    }

    // All entries populated by now — unwrap is safe.
    Ok(out.into_iter().map(|o| o.expect("committee resolve filled all slots")).collect())
}

/// POST `body_json` to `{url}/v1/fetch_key`, parse the JSON body as
/// `FetchKeyResponse`. 30s timeout, applies SDK request headers expected by
/// the key server (matches seal-cli).
pub async fn fetch_key(
    http: &reqwest::Client,
    info: &KeyServerInfo,
    body_json: &str,
) -> Result<FetchKeyResponse, KeyServerError> {
    let url = format!("{}/v1/fetch_key", info.url.trim_end_matches('/'));
    let resp = http
        .post(&url)
        .timeout(FETCH_KEY_TIMEOUT)
        .header("Content-Type", "application/json")
        // SEAL key server validates Client-Sdk-Type/Version. Only "typescript" is
        // currently recognized; sending Type=rust gets HTTP 400 InvalidSDKVersion.
        // Until upstream adds rust support, mirror what `@mysten/seal` 1.1.1 sends.
        .header("Client-Sdk-Type", "typescript")
        .header("Client-Sdk-Version", "1.1.1")
        .header("Request-Id", uuid::Uuid::new_v4().to_string())
        .body(body_json.to_owned())
        .send()
        .await
        .map_err(|e| KeyServerError::Http(info.object_id.to_string(), e.to_string()))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        KeyServerError::Http(info.object_id.to_string(), format!("read body: {}", e))
    })?;
    if !status.is_success() {
        return Err(KeyServerError::HttpStatus(
            info.object_id.to_string(),
            status.as_u16(),
            body,
        ));
    }
    serde_json::from_str::<FetchKeyResponse>(&body).map_err(|e| {
        KeyServerError::MalformedResponse(info.object_id.to_string(), e.to_string())
    })
}

/// Wipe the on-chain key-server cache. Used by tests to ensure isolation.
#[cfg(test)]
pub async fn _clear_cache_for_tests() {
    COMMITTEE_CACHE.lock().await.clear();
}

// ============================================================
// Internals
// ============================================================

/// Fetch the V1 KeyServer object from chain via JSON-RPC. We use
/// `suix_getDynamicFieldObject` with the U64 dynamic field name `1` (V1
/// version per `seal::key_server::KeyServer`).
async fn fetch_key_server_info(
    http: &reqwest::Client,
    sui_rpc_url: &str,
    object_id_str: &str,
) -> Result<KeyServerInfo, KeyServerError> {
    let object_id = ObjectID::from_str(object_id_str).map_err(|e| {
        KeyServerError::InvalidObjectId(object_id_str.to_string(), e.to_string())
    })?;

    // suix_getDynamicFieldObject(parent_id, { type: "u64", value: "1" })
    // The Move name is `u64(1)`, encoded by JSON-RPC convention as a string.
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "suix_getDynamicFieldObject",
        "params": [
            object_id_str,
            { "type": "u64", "value": "1" },
        ],
    });

    let resp = http
        .post(sui_rpc_url)
        .timeout(SUI_RPC_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|e| KeyServerError::Rpc {
            id: object_id_str.to_string(),
            message: e.to_string(),
        })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| KeyServerError::Rpc {
        id: object_id_str.to_string(),
        message: format!("read body: {}", e),
    })?;
    if !status.is_success() {
        return Err(KeyServerError::Rpc {
            id: object_id_str.to_string(),
            message: format!("HTTP {}: {}", status, text),
        });
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| KeyServerError::Rpc {
        id: object_id_str.to_string(),
        message: format!("JSON parse: {} (body={})", e, text),
    })?;

    if let Some(err) = v.get("error") {
        return Err(KeyServerError::Rpc {
            id: object_id_str.to_string(),
            message: format!("RPC error: {}", err),
        });
    }

    // Path: result.data.content.fields.value.fields { url, name, pk }
    let fields = v
        .pointer("/result/data/content/fields")
        .ok_or_else(|| KeyServerError::MissingV1Field {
            id: object_id_str.to_string(),
        })?;
    // Some Sui RPC responses nest the V1 struct under `value.fields`; others
    // expose it directly. Try the nested location first, fall back to the
    // top-level fields object.
    let inner = fields
        .pointer("/value/fields")
        .or(Some(fields))
        .ok_or_else(|| KeyServerError::MalformedFields {
            id: object_id_str.to_string(),
            err: "no value.fields".into(),
        })?;

    let url = inner
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| KeyServerError::MalformedFields {
            id: object_id_str.to_string(),
            err: "missing 'url'".into(),
        })?
        .to_string();

    let name = inner
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    // `pk` is serialized as a JSON array of u8 numbers when fetched from the
    // Sui JSON-RPC. Tolerate both array form (list of numbers) and the rare
    // hex-string fallback used by some custom RPCs.
    let pk_bytes: Vec<u8> = match inner.get("pk") {
        Some(serde_json::Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for n in arr {
                let byte = n.as_u64().and_then(|n| u8::try_from(n).ok()).ok_or_else(|| {
                    KeyServerError::MalformedFields {
                        id: object_id_str.to_string(),
                        err: format!("bad pk byte: {}", n),
                    }
                })?;
                out.push(byte);
            }
            out
        }
        Some(serde_json::Value::String(s)) => {
            // Tolerate optional 0x-prefix.
            let s = s.strip_prefix("0x").unwrap_or(s);
            hex::decode(s).map_err(|e| KeyServerError::MalformedFields {
                id: object_id_str.to_string(),
                err: format!("pk hex decode: {}", e),
            })?
        }
        _ => {
            return Err(KeyServerError::MalformedFields {
                id: object_id_str.to_string(),
                err: "missing or invalid 'pk' field".into(),
            });
        }
    };

    if pk_bytes.len() != IBE_PUBKEY_BYTES {
        return Err(KeyServerError::InvalidPubkey {
            id: object_id_str.to_string(),
            got: pk_bytes.len(),
        });
    }
    let mut pk_arr = [0u8; IBE_PUBKEY_BYTES];
    pk_arr.copy_from_slice(&pk_bytes);
    let public_key = IBEPublicKey::from_byte_array(&pk_arr)
        .map_err(|_| KeyServerError::BlsDeserialize(object_id_str.to_string()))?;

    tracing::info!(
        "seal_keyserver: resolved {} ({}) → {}",
        object_id_str,
        name,
        url
    );

    Ok(KeyServerInfo {
        object_id,
        name,
        url,
        public_key,
    })
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Env-var tests share process state. We serialize them through a Mutex
    // so `cargo test`'s default parallel run doesn't make them race with
    // each other (e.g. SEAL_KEY_SERVERS being unset in one test while
    // another reads it). std::sync::Mutex is sufficient — these tests are
    // synchronous.
    use std::sync::Mutex;
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn key_server_ids_from_env_parses_csv() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("SEAL_KEY_SERVERS", "0xabc, 0xdef ,0x123");
        let ids = key_server_ids_from_env();
        std::env::remove_var("SEAL_KEY_SERVERS");
        assert_eq!(ids, vec!["0xabc", "0xdef", "0x123"]);
    }

    #[test]
    fn key_server_ids_from_env_handles_empty() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("SEAL_KEY_SERVERS");
        assert!(key_server_ids_from_env().is_empty());
        std::env::set_var("SEAL_KEY_SERVERS", "");
        let after = key_server_ids_from_env();
        std::env::remove_var("SEAL_KEY_SERVERS");
        assert!(after.is_empty());
    }

    #[test]
    fn seal_threshold_default_is_2() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("SEAL_THRESHOLD");
        assert_eq!(seal_threshold_from_env(), 2);
    }

    #[test]
    fn seal_threshold_parses_env() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var("SEAL_THRESHOLD", "3");
        assert_eq!(seal_threshold_from_env(), 3);
        std::env::set_var("SEAL_THRESHOLD", "garbage");
        // Falls back to default on parse error.
        assert_eq!(seal_threshold_from_env(), 2);
        std::env::remove_var("SEAL_THRESHOLD");
    }

    #[tokio::test]
    async fn resolve_committee_empty_returns_empty() {
        let http = reqwest::Client::new();
        let out = resolve_committee(&http, "https://example.invalid", &[]).await.unwrap();
        assert!(out.is_empty());
    }
}
