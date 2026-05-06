//! Walrus upload + on-chain query layer (ENG-1700).
//!
//! In-process replacement for the deleted Node sidecar:
//!   - Upload: PUT to a public Walrus publisher (`walrus_publisher.rs`)
//!     followed by a metadata-set + transfer PTB (`walrus_onchain.rs`).
//!   - Query: native Sui JSON-RPC `suix_getOwnedObjects` + dynamic-field
//!     reads, with the same numeric→base64url `blob_id` conversion the
//!     prior implementation used.
//!
//! `download_blob` is unchanged — it already used `walrus_rs` natively.

use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL, Engine};

use crate::enoki::EnokiClient;
use crate::types::{parse_enoki_fallback_to_direct_sign, AppError, KeyPool};
use crate::walrus_onchain::{self, ServerSigner};
use crate::walrus_publisher::{self, PublisherError};

// ============================================================
// Public types (unchanged shape)
// ============================================================

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    #[allow(dead_code)]
    pub object_id: Option<String>,
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

// ============================================================
// upload_blob — native publisher + on-chain PTB
// ============================================================

/// Upload an encrypted blob to Walrus and set on-chain metadata.
///
/// Pipeline:
///   1. Decode the chosen pool key into the server signer (Ed25519 + address).
///   2. PUT the blob to the Walrus publisher with `send_object_to=<server_addr>`
///      so the freshly minted `Blob` is owned by us (we need to mutate it).
///   3. Run the metadata-set + transfer PTB:
///        - `WALRUS_PKG::blob::insert_or_update_metadata_pair` ×4 (memwal_*)
///        - `transfer_objects([blob], owner_address)`
///   4. Return `UploadResult { blob_id, object_id }`.
#[allow(clippy::too_many_arguments)]
pub async fn upload_blob(
    client: &reqwest::Client,
    data: &[u8],
    epochs: u64,
    owner_address: &str,
    key_index: usize,
    namespace: &str,
    package_id: &str, // MemWal package ID (for memwal_package_id metadata value)
    agent_id: Option<&str>,
) -> Result<UploadResult, AppError> {
    // LOW-17 parity: cap epochs at 5 to prevent accidental large storage spend.
    let capped_epochs = epochs.min(5);

    // Resolve sui rpc + walrus upload endpoint + walrus package id from env.
    // We can't reach into AppState from here without a wider refactor, so
    // pull from env directly (matches the existing pattern in routes).
    let network = std::env::var("SUI_NETWORK").unwrap_or_else(|_| "mainnet".to_string());
    let sui_rpc_url = sui_rpc_url_from_network(&network);
    let upload_url = walrus_upload_url_from_env(&network);
    let walrus_pkg = walrus_onchain::resolve_walrus_package_id(&network);

    // Step 1: load signer from KeyPool via env (KeyPool itself is on AppState
    // and not available here without changing callers — match the existing
    // pattern used by routes which already passed `key_index`).
    let pool_keys = load_pool_keys_from_env();
    let priv_key = pool_keys
        .get(key_index)
        .ok_or_else(|| AppError::Internal(format!("KeyPool index {} out of bounds", key_index)))?;
    let signer = ServerSigner::from_suiprivkey(priv_key)
        .map_err(|e| AppError::Internal(format!("decode server private key: {}", e)))?;
    let server_address = signer.address_hex();

    // Step 2: publish to Walrus
    let published = walrus_publisher::upload_blob_via_publisher(
        client,
        &upload_url,
        data,
        capped_epochs,
        &server_address,
    )
    .await
    .map_err(map_publisher_error)?;

    let blob_object_id = match &published.object_id {
        Some(id) => id.clone(),
        None => {
            // alreadyCertified branch — already errored out above, but be defensive.
            return Err(AppError::Internal(
                "Walrus publisher did not return a Blob object id".into(),
            ));
        }
    };

    // Step 3: metadata-set + transfer PTB.
    //
    // When `ENOKI_API_KEY` is set we try Enoki sponsorship first, falling
    // back to direct-sign on error if `ENOKI_FALLBACK_TO_DIRECT_SIGN=true`
    // (default true). When the key is unset, the EnokiClient short-circuits
    // and we go straight to direct sign.
    let enoki_api_key = std::env::var("ENOKI_API_KEY").ok().filter(|s| !s.is_empty());
    let enoki_network = std::env::var("ENOKI_NETWORK").unwrap_or_else(|_| {
        std::env::var("SUI_NETWORK").unwrap_or_else(|_| "mainnet".into())
    });
    let enoki = EnokiClient::new(enoki_api_key, enoki_network);
    let enoki_fallback = parse_enoki_fallback_to_direct_sign(
        std::env::var("ENOKI_FALLBACK_TO_DIRECT_SIGN").ok(),
    );

    walrus_onchain::set_metadata_and_transfer(
        client,
        &sui_rpc_url,
        &signer,
        &blob_object_id,
        &walrus_pkg,
        namespace,
        owner_address, // target_owner: the user
        owner_address, // memwal_owner metadata value
        package_id,    // memwal_package_id metadata value
        agent_id,
        &enoki,
        enoki_fallback,
    )
    .await
    .map_err(|e| AppError::Internal(format!("Walrus metadata+transfer failed: {}", e)))?;

    tracing::info!(
        "walrus upload+chain ok: blob_id={}, object_id={}, owner={}, ns={}",
        published.blob_id,
        blob_object_id,
        owner_address,
        namespace,
    );

    Ok(UploadResult {
        blob_id: published.blob_id,
        object_id: Some(blob_object_id),
    })
}

/// Resolve the Sui JSON-RPC fullnode URL for `network`. Mirrors the
/// per-network fallback used in the legacy sidecar (`getJsonRpcFullnodeUrl`).
fn sui_rpc_url_from_network(network: &str) -> String {
    if let Ok(v) = std::env::var("SUI_RPC_URL") {
        return v;
    }
    match network {
        "testnet" => "https://fullnode.testnet.sui.io:443".to_string(),
        "devnet" => "https://fullnode.devnet.sui.io:443".to_string(),
        _ => "https://fullnode.mainnet.sui.io:443".to_string(),
    }
}

/// Resolve the Walrus upload endpoint URL.
///
/// Reads `WALRUS_UPLOAD_RELAY_URL` env var, falling back to the per-network
/// upload-relay default — matches the legacy sidecar
/// (`scripts/sidecar-server.ts:65-69`) so Railway's dev/staging/mainnet env
/// values keep working without rename.
///
/// **NOTE — protocol gap (ENG-1700 follow-up):** the upload-relay default
/// URLs (`upload-relay.{net}.walrus.space`) speak the multi-step
/// register/upload/certify relay protocol used by `@mysten/walrus`. The
/// current implementation in `walrus_publisher.rs` only speaks the simpler
/// `PUT /v1/blobs` public-publisher protocol, so it will fail against the
/// default relay URL. Until the relay protocol is ported (Path A), set
/// `WALRUS_UPLOAD_RELAY_URL` to a `publisher.walrus-{net}.walrus.space`
/// endpoint instead.
fn walrus_upload_url_from_env(network: &str) -> String {
    if let Ok(v) = std::env::var("WALRUS_UPLOAD_RELAY_URL") {
        return v;
    }
    match network {
        "testnet" => "https://upload-relay.testnet.walrus.space".to_string(),
        _ => "https://upload-relay.mainnet.walrus.space".to_string(),
    }
}

fn load_pool_keys_from_env() -> Vec<String> {
    if let Ok(s) = std::env::var("SERVER_SUI_PRIVATE_KEYS") {
        let v: Vec<String> = s
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        if !v.is_empty() {
            return v;
        }
    }
    if let Ok(s) = std::env::var("SERVER_SUI_PRIVATE_KEY") {
        if !s.trim().is_empty() {
            return vec![s];
        }
    }
    Vec::new()
}

fn map_publisher_error(e: PublisherError) -> AppError {
    match e {
        PublisherError::AlreadyCertifiedNoObject => AppError::Internal(
            "Walrus already-certified branch: cannot transfer (no Blob object minted). \
             This should be unreachable for SEAL-encrypted blobs."
                .into(),
        ),
        other => AppError::Internal(format!("Walrus publisher: {}", other)),
    }
}

// ============================================================
// query_blobs_by_owner — native Sui RPC + dynamic-field reads
// ============================================================

/// Query user's Walrus Blob objects from the Sui chain.
///
/// Uses `suix_getOwnedObjects` with a `StructType` filter for
/// `WALRUS_PACKAGE_ID::blob::Blob`, paginates, then fetches the on-chain
/// metadata VecMap via `suix_getDynamicFieldObject` (key: b"metadata") for
/// each Blob. Filters by namespace / package_id client-side.
pub async fn query_blobs_by_owner(
    client: &reqwest::Client,
    owner_address: &str,
    namespace: Option<&str>,
    package_id: Option<&str>,
) -> Result<Vec<OnChainBlob>, AppError> {
    let network = std::env::var("SUI_NETWORK").unwrap_or_else(|_| "mainnet".to_string());
    let sui_rpc_url = sui_rpc_url_from_network(&network);
    let walrus_pkg = walrus_onchain::resolve_walrus_package_id(&network);
    let walrus_blob_type = format!("{}::blob::Blob", walrus_pkg);

    // ── 1. Paginate getOwnedObjects ─────────────────────────────────────
    #[derive(Debug, Clone)]
    struct RawBlob {
        object_id: String,
        raw_blob_id: Option<String>, // u256 as decimal string
    }

    let mut raw_objs: Vec<RawBlob> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = serde_json::json!([
            owner_address,
            {
                "filter": { "StructType": walrus_blob_type },
                "options": { "showContent": true }
            },
            cursor,
            50
        ]);
        let v = sui_rpc(client, &sui_rpc_url, "suix_getOwnedObjects", params).await?;
        let data = v
            .pointer("/result/data")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        for obj in data {
            // Path: data.content.dataType=="moveObject" && data.content.fields.blob_id
            let content = match obj.pointer("/data/content") {
                Some(c) => c,
                None => continue,
            };
            if content.get("dataType").and_then(|x| x.as_str()) != Some("moveObject") {
                continue;
            }
            let object_id = match obj.pointer("/data/objectId").and_then(|x| x.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let raw_blob_id = content
                .pointer("/fields/blob_id")
                .or_else(|| content.pointer("/fields/blobId"))
                .and_then(|x| x.as_str().map(String::from).or_else(|| x.as_u64().map(|n| n.to_string())));
            raw_objs.push(RawBlob {
                object_id,
                raw_blob_id,
            });
        }

        let has_next = v
            .pointer("/result/hasNextPage")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let next_cursor = v
            .pointer("/result/nextCursor")
            .and_then(|x| x.as_str())
            .map(String::from);
        if !has_next || next_cursor.is_none() {
            break;
        }
        cursor = next_cursor;
    }

    tracing::info!(
        "walrus query: found {} raw blob objects for owner={}",
        raw_objs.len(),
        owner_address,
    );

    // ── 2. Fetch metadata for each Blob (bounded concurrency) ──────────
    // The TS sidecar uses concurrency=5; we mirror that to avoid 429s.
    use futures::stream::{self, StreamExt};
    let metas: Vec<(RawBlob, BlobMeta)> = stream::iter(raw_objs.into_iter())
        .map(|obj| {
            let url = sui_rpc_url.clone();
            let client = client.clone();
            async move {
                let meta = fetch_blob_metadata(&client, &url, &obj.object_id).await;
                (obj, meta.unwrap_or_default())
            }
        })
        .buffer_unordered(5)
        .collect()
        .await;

    // ── 3. Filter + convert blob IDs ───────────────────────────────────
    let mut out: Vec<OnChainBlob> = Vec::new();
    for (obj, meta) in metas {
        if let Some(ns) = namespace {
            if meta.namespace != ns {
                continue;
            }
        }
        if let Some(pkg) = package_id {
            if meta.package_id != pkg {
                continue;
            }
        }
        let raw = match &obj.raw_blob_id {
            Some(s) => s.clone(),
            None => continue,
        };
        let blob_id = u256_decimal_to_base64url(&raw).unwrap_or(raw);
        out.push(OnChainBlob {
            blob_id,
            object_id: obj.object_id,
            namespace: if meta.namespace.is_empty() {
                "default".to_string()
            } else {
                meta.namespace
            },
            package_id: meta.package_id,
        });
    }

    tracing::info!(
        "walrus query: returning {} blobs for owner={} ns={:?}",
        out.len(),
        owner_address,
        namespace,
    );
    Ok(out)
}

#[derive(Debug, Default)]
struct BlobMeta {
    namespace: String,
    #[allow(dead_code)]
    owner: String,
    package_id: String,
    #[allow(dead_code)]
    agent_id: String,
}

/// Read the on-chain metadata VecMap for a single Blob via
/// `suix_getDynamicFieldObject` with key b"metadata".
async fn fetch_blob_metadata(
    client: &reqwest::Client,
    rpc_url: &str,
    object_id: &str,
) -> Result<BlobMeta, AppError> {
    // Field name: { type: "vector<u8>", value: bytes("metadata") }
    let metadata_bytes: Vec<u64> = "metadata".bytes().map(|b| b as u64).collect();
    let params = serde_json::json!([
        object_id,
        {
            "type": "vector<u8>",
            "value": metadata_bytes,
        }
    ]);
    let v = sui_rpc(client, rpc_url, "suix_getDynamicFieldObject", params).await?;

    // Navigate to the VecMap entries:
    //   result.data.content.fields.value.fields.metadata.fields.contents[]
    let contents = v
        .pointer("/result/data/content/fields/value/fields/metadata/fields/contents")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    let mut meta = BlobMeta::default();
    for entry in contents {
        let key = entry.pointer("/fields/key").and_then(|x| x.as_str()).unwrap_or("");
        let value = entry
            .pointer("/fields/value")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        match key {
            "memwal_namespace" => meta.namespace = value,
            "memwal_owner" => meta.owner = value,
            "memwal_package_id" => meta.package_id = value,
            "memwal_agent_id" => meta.agent_id = value,
            _ => {}
        }
    }
    Ok(meta)
}

/// Convert a U256 decimal string (as Walrus stores `blob_id` on-chain) into
/// a base64url-no-pad string:
///
///   BigInt(decimal) → 64-char hex (zero-padded BE) → bytes BE → reverse to LE
///   → base64url-no-pad.
fn u256_decimal_to_base64url(decimal: &str) -> Option<String> {
    if decimal.is_empty() || !decimal.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // Use `num` semantics manually since we don't depend on num-bigint.
    // Convert via BigUint-via-byte-arithmetic: parse base-10 into a 32-byte
    // big-endian buffer.
    let mut be = [0u8; 32];
    let mut started = false;
    let mut digit_count = 0usize;
    for ch in decimal.chars() {
        let d = ch.to_digit(10)? as u8;
        // be := be * 10 + d (with overflow → None if >32 bytes)
        let mut carry: u16 = d as u16;
        for byte in be.iter_mut().rev() {
            let prod = (*byte as u16) * 10 + carry;
            *byte = (prod & 0xff) as u8;
            carry = prod >> 8;
        }
        if carry != 0 {
            return None; // overflow > 256 bits
        }
        digit_count += 1;
        if d != 0 {
            started = true;
        }
        // Keep iterating; mirror TS behaviour which doesn't truncate leading zeros.
        let _ = started;
    }
    if digit_count == 0 {
        return None;
    }
    // Reverse to little-endian.
    let mut le = be;
    le.reverse();
    Some(BASE64_URL.encode(le))
}

async fn sui_rpc(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let resp = client
        .post(url)
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Sui RPC {} failed: {}", method, e)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("Sui RPC {} read body: {}", method, e)))?;
    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "Sui RPC {} HTTP {}: {}",
            method, status, text
        )));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        AppError::Internal(format!("Sui RPC {} JSON parse: {} (body={})", method, e, text))
    })?;
    if v.get("error").is_some() {
        return Err(AppError::Internal(format!(
            "Sui RPC {} returned error: {}",
            method,
            v.get("error").unwrap()
        )));
    }
    Ok(v)
}

// ============================================================
// download_blob — unchanged (already native via walrus_rs)
// ============================================================

/// Download a blob from Walrus via the walrus_rs SDK (Aggregator HTTP API).
///
/// Returns `AppError::BlobNotFound` when the blob has expired or doesn't exist
/// (HTTP 404 from the aggregator). Callers can use this to trigger DB cleanup.
pub async fn download_blob(
    walrus_client: &walrus_rs::WalrusClient,
    blob_id: &str,
) -> Result<Vec<u8>, AppError> {
    let download_fut = walrus_client.read_blob_by_id(blob_id);
    let bytes = match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        download_fut,
    )
    .await
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

// Keep `KeyPool` import alive even though we currently re-derive keys via env
// inside `upload_blob`. Removing the import would break a future refactor that
// threads `&AppState` here.
#[allow(dead_code)]
fn _keep_key_pool_in_use(_p: &KeyPool) {}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u256_to_base64url_roundtrip_zero() {
        // 0 → 32 bytes of zero → base64url of 32 zero bytes.
        let s = u256_decimal_to_base64url("0").unwrap();
        // 32 bytes → 43 base64url chars (no padding).
        assert_eq!(s.len(), 43);
        assert!(s.chars().all(|c| c == 'A'));
    }

    #[test]
    fn u256_to_base64url_one() {
        // 1 (BE: 31 zero bytes + 0x01) → reversed (LE) starts with 0x01.
        let s = u256_decimal_to_base64url("1").unwrap();
        // First byte is 0x01 — first base64url char encodes 6 bits of 0x01.
        // 0x01 in 6-bit group => 0b000000_010000xx, i.e. char = 'A' for first 6 bits = 0.
        // Easier check: decode and verify the bytes.
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s)
            .unwrap();
        assert_eq!(bytes.len(), 32);
        assert_eq!(bytes[0], 0x01);
        assert!(bytes[1..].iter().all(|&b| b == 0));
    }

    #[test]
    fn u256_to_base64url_overflow_returns_none() {
        // Too large: 2^256 = 115792089237316195423570985008687907853269984665640564039457584007913129639936
        let too_big = "115792089237316195423570985008687907853269984665640564039457584007913129639936";
        assert!(u256_decimal_to_base64url(too_big).is_none());
    }

    #[test]
    fn u256_to_base64url_rejects_non_digits() {
        assert!(u256_decimal_to_base64url("0xabc").is_none());
        assert!(u256_decimal_to_base64url("123abc").is_none());
        assert!(u256_decimal_to_base64url("").is_none());
    }
}
