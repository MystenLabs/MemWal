use base64::Engine as _;
use serde::Deserialize;
use sui_rpc::proto::sui::rpc::v2::{
    open_signature::Reference, open_signature_body::Type as SignatureType, FunctionDescriptor,
    GetPackageRequest, OpenSignature, OpenSignatureBody, Package,
};
use sui_sdk_types::Address;

/// Verify that a given public key is registered as a delegate key
/// in the onchain MemWalAccount object.
///
/// Routes through gRPC when `grpc_client` is provided (opt-in via
/// SUI_GRPC_URL, mirrors the sidecar's write-path migration — JSON-RPC
/// sunsets 2026-07-31, and testnet's public JSON-RPC endpoint already
/// returns 404 today), otherwise falls back to the original Sui JSON-RPC
/// `sui_getObject` call below. The gRPC client is built once at startup
/// (AppState) and cloned here — clones share the underlying tonic channel.
///
/// Returns `Ok(owner_address)` if the key is found, `Err` otherwise.
pub async fn verify_delegate_key_onchain(
    http_client: &reqwest::Client,
    rpc_url: &str,
    grpc_client: Option<&sui_rpc::Client>,
    account_object_id: &str,
    public_key_bytes: &[u8],
    expected_type_origin_package_id: &str,
) -> Result<String, OnchainVerifyError> {
    if let Some(grpc_client) = grpc_client {
        return verify_delegate_key_onchain_grpc(
            grpc_client.clone(),
            account_object_id,
            public_key_bytes,
            expected_type_origin_package_id,
        )
        .await;
    }

    // Build JSON-RPC request
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sui_getObject",
        "params": [
            account_object_id,
            { "showContent": true }
        ]
    });

    let request = http_client
        .post(rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body);
    let request = crate::observability::apply_request_id_header(request);
    let started = std::time::Instant::now();
    let response = request.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sui_rpc",
            "sui_getObject",
            "transport_error",
            started.elapsed(),
        );
        OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e))
    })?;
    let status_label = response.status().as_u16().to_string();
    crate::observability::observe_external(
        "sui_rpc",
        "sui_getObject",
        &status_label,
        started.elapsed(),
    );

    let rpc_response: RpcResponse = parse_json_rpc_response(response, "sui_getObject").await?;

    if let Some(error) = rpc_response.error {
        return Err(OnchainVerifyError::RpcError(format!(
            "RPC error {}: {}",
            error.code, error.message
        )));
    }

    let result = rpc_response
        .result
        .ok_or_else(|| OnchainVerifyError::RpcError("No result in RPC response".into()))?;

    let content = result
        .data
        .and_then(|d| d.content)
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no content".into()))?;

    // #398: reject foreign/lookalike objects — verify the Move type against the
    // configured immutable type-origin package id before trusting any field.
    ensure_memwal_account_type(
        content.object_type.as_deref(),
        expected_type_origin_package_id,
        account_object_id,
    )?;

    let fields = content
        .fields
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no fields".into()))?;

    // Extract owner address
    let owner = fields
        .get("owner")
        .and_then(|v| v.as_str())
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'owner' field".into()))?
        .to_string();

    // Block deactivated accounts.
    // The onchain MemWalAccount has an `active: bool` field.
    // If false, reject immediately — even if the delegate key is valid.
    let active = json_account_active(&fields)?;
    if !active {
        tracing::warn!(
            "account {} is deactivated — rejecting delegate key auth",
            account_object_id
        );
        return Err(OnchainVerifyError::AccountDeactivated(format!(
            "Account {} has been deactivated",
            account_object_id
        )));
    }

    // Extract delegate_keys array
    let delegate_keys = fields
        .get("delegate_keys")
        .and_then(|v| v.as_array())
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'delegate_keys' field".into()))?;

    // Convert our public key to the same format as stored onchain (Vec<u8> as JSON array)
    let pk_as_numbers: Vec<serde_json::Value> = public_key_bytes
        .iter()
        .map(|&b| serde_json::Value::Number(b.into()))
        .collect();

    // Search for matching delegate key
    for dk in delegate_keys {
        // Each delegate key is a struct with fields: { public_key, label, created_at }
        // The onchain representation has a "fields" wrapper
        let dk_fields = dk.get("fields").or(Some(dk)); // fallback if no "fields" wrapper

        if let Some(stored_key) = dk_fields.and_then(|f| f.get("public_key")) {
            // Compare as arrays of numbers
            if let Some(stored_arr) = stored_key.as_array() {
                if *stored_arr == pk_as_numbers {
                    tracing::info!("delegate key verified onchain, owner: {}", owner);
                    return Ok(owner);
                }
            }
        }
    }

    Err(OnchainVerifyError::KeyNotFound(format!(
        "Public key not found in {} delegate key(s) for account {}",
        delegate_keys.len(),
        account_object_id
    )))
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DelegateKeyInfo {
    pub sui_address: String,
    pub label: String,
    pub created_at: u64,
}

// ============================================================
// Delegate keys — short-TTL in-memory cache (`/agents`)
// ============================================================
//
// Mirrors `sui/client.rs`'s `Timed<WalrusEpoch>` pattern used by
// `walrus_epoch()` — a value + fetch timestamp, refreshed once stale —
// per the design spec: "Cached with the same short TTL pattern as
// walrus_epoch() ... rather than left uncached". This is deliberately
// NOT the DB-backed `delegate_key_cache` table (`storage/db.rs`): that
// table caches a single verified public-key -> account mapping on the
// hot per-request auth path; this caches the full delegate-key *list*
// per account for a page-load-triggered read (`GET /v1/owners/{owner}/agents`),
// which has no existing cache at all today.

/// Same window `walrus_epoch()` uses (`sui/client.rs::walrus_epoch`, 30s).
pub const DELEGATE_KEYS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Staleness threshold for the periodic `DelegateKeysCache` sweep run from
/// `main.rs`. `DELEGATE_KEYS_CACHE_TTL` above only gates whether a hit is
/// *trusted* on read — nothing ever removed the map slot itself, so every
/// `account_object_id` ever looked up via `list_delegate_keys_cached` stayed
/// resident in memory for the life of the process (unbounded growth).
///
/// 10 minutes = 20x the 30s trust TTL: generous headroom so a sweep never
/// evicts an entry that's still realistically in use, while still bounding
/// the map to "accounts read from in the last 10 minutes" instead of
/// "every account ever queried since boot".
pub const DELEGATE_KEYS_CACHE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

#[derive(Clone)]
pub struct TimedDelegateKeys {
    pub value: Vec<DelegateKeyInfo>,
    pub fetched_at: std::time::Instant,
}

/// Keyed by `account_object_id` so different accounts' delegate lists don't
/// collide. `AppState` owns one `Arc` of this (see `types.rs`), shared across
/// all `/agents` requests the same way `SuiClient`'s `Timed` caches are
/// shared via its own `Arc<RwLock<..>>` fields.
pub type DelegateKeysCache =
    std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<String, TimedDelegateKeys>>>;

pub fn new_delegate_keys_cache() -> DelegateKeysCache {
    std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()))
}

/// Cached wrapper around `list_delegate_keys_onchain`: returns the cached
/// list if it was fetched within `DELEGATE_KEYS_CACHE_TTL`, otherwise fetches
/// live and refreshes the cache. Keeps repeated `/agents` calls for the same
/// account within the TTL window from re-hitting the chain.
pub async fn list_delegate_keys_cached(
    cache: &DelegateKeysCache,
    http_client: &reqwest::Client,
    rpc_url: &str,
    grpc_client: Option<&sui_rpc::Client>,
    account_object_id: &str,
    expected_type_origin_package_id: &str,
) -> Result<Vec<DelegateKeyInfo>, OnchainVerifyError> {
    if let Some(cached) = cache
        .read()
        .await
        .get(account_object_id)
        .filter(|c| c.fetched_at.elapsed() < DELEGATE_KEYS_CACHE_TTL)
    {
        return Ok(cached.value.clone());
    }

    let keys = list_delegate_keys_onchain(
        http_client,
        rpc_url,
        grpc_client,
        account_object_id,
        expected_type_origin_package_id,
    )
    .await?;

    cache.write().await.insert(
        account_object_id.to_string(),
        TimedDelegateKeys {
            value: keys.clone(),
            fetched_at: std::time::Instant::now(),
        },
    );

    Ok(keys)
}

/// Parse the `delegate_keys` array out of a MemWalAccount's `fields` map.
/// Pure function — no I/O — so it's unit-testable without a live chain.
pub fn parse_delegate_keys(
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<DelegateKeyInfo>, OnchainVerifyError> {
    let delegate_keys = fields
        .get("delegate_keys")
        .and_then(|v| v.as_array())
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'delegate_keys' field".into()))?;

    let mut out = Vec::with_capacity(delegate_keys.len());
    for dk in delegate_keys {
        let dk_fields = dk.get("fields").or(Some(dk));
        let sui_address = dk_fields
            .and_then(|f| f.get("sui_address"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| OnchainVerifyError::RpcError("delegate key missing sui_address".into()))?
            .to_string();
        let label = dk_fields
            .and_then(|f| f.get("label"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let created_at = dk_fields
            .and_then(|f| f.get("created_at"))
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| {
                dk_fields
                    .and_then(|f| f.get("created_at"))
                    .and_then(|v| v.as_u64())
            })
            .unwrap_or(0);
        out.push(DelegateKeyInfo {
            sui_address,
            label,
            created_at,
        });
    }
    Ok(out)
}

/// List all delegate keys on a MemWalAccount object. JSON-RPC only (mirrors
/// verify_delegate_key_onchain's non-gRPC path) — the initial phase did not
/// need the gRPC variant since this endpoint is not on the hot signature-
/// verification path.
/// Routes through gRPC when `grpc_client` is provided, mirroring
/// `verify_delegate_key_onchain`'s same JSON-RPC-sunset rationale — this
/// was the one remaining `/agents`-only call site still hardcoded to
/// JSON-RPC after that migration.
pub async fn list_delegate_keys_onchain(
    http_client: &reqwest::Client,
    rpc_url: &str,
    grpc_client: Option<&sui_rpc::Client>,
    account_object_id: &str,
    expected_type_origin_package_id: &str,
) -> Result<Vec<DelegateKeyInfo>, OnchainVerifyError> {
    if let Some(grpc_client) = grpc_client {
        return list_delegate_keys_onchain_grpc(
            grpc_client.clone(),
            account_object_id,
            expected_type_origin_package_id,
        )
        .await;
    }

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sui_getObject",
        "params": [account_object_id, { "showContent": true }]
    });

    let request = http_client
        .post(rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body);
    let request = crate::observability::apply_request_id_header(request);
    // Mirror verify_delegate_key_onchain's instrumentation exactly so this
    // call is visible in the same `sui_rpc` external-call metrics instead
    // of being an invisible RPC cost.
    let started = std::time::Instant::now();
    let response = request.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sui_rpc",
            "sui_getObject",
            "transport_error",
            started.elapsed(),
        );
        OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e))
    })?;
    let status_label = response.status().as_u16().to_string();
    crate::observability::observe_external(
        "sui_rpc",
        "sui_getObject",
        &status_label,
        started.elapsed(),
    );

    let rpc_response: RpcResponse = parse_json_rpc_response(response, "sui_getObject").await?;
    if let Some(error) = rpc_response.error {
        return Err(OnchainVerifyError::RpcError(format!(
            "RPC error {}: {}",
            error.code, error.message
        )));
    }

    let result = rpc_response
        .result
        .ok_or_else(|| OnchainVerifyError::RpcError("No result in RPC response".into()))?;
    let content = result
        .data
        .and_then(|d| d.content)
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no content".into()))?;

    ensure_memwal_account_type(
        content.object_type.as_deref(),
        expected_type_origin_package_id,
        account_object_id,
    )?;

    let fields = content
        .fields
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no fields".into()))?;

    parse_delegate_keys(&fields)
}

// ── gRPC value helpers ──
// google.protobuf.Value (via prost-types) is a dynamic JSON-like tree, not
// serde_json::Value — these navigate it the same way `fields.get(...)` reads
// the parsed JSON-RPC content above, so the two code paths stay structurally
// parallel and easy to compare.
fn grpc_value_as_struct(v: &prost_types::Value) -> Option<&prost_types::Struct> {
    match &v.kind {
        Some(prost_types::value::Kind::StructValue(s)) => Some(s),
        _ => None,
    }
}

fn grpc_value_as_str(v: &prost_types::Value) -> Option<&str> {
    match &v.kind {
        Some(prost_types::value::Kind::StringValue(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn grpc_value_as_bool(v: &prost_types::Value) -> Option<bool> {
    match &v.kind {
        Some(prost_types::value::Kind::BoolValue(b)) => Some(*b),
        _ => None,
    }
}

fn json_account_active(
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<bool, OnchainVerifyError> {
    fields
        .get("active")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing or malformed 'active' field".into()))
}

fn grpc_account_active(fields: &prost_types::Struct) -> Result<bool, OnchainVerifyError> {
    fields
        .fields
        .get("active")
        .and_then(grpc_value_as_bool)
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing or malformed 'active' field".into()))
}

fn grpc_value_as_list(v: &prost_types::Value) -> Option<&[prost_types::Value]> {
    match &v.kind {
        Some(prost_types::value::Kind::ListValue(l)) => Some(&l.values),
        _ => None,
    }
}

/// `created_at` (a Move `u64`) round-trips through gRPC's JSON-like
/// `google.protobuf.Value` the same way it does through JSON-RPC — usually
/// as a string (to avoid f64 precision loss), occasionally as a number —
/// so try both, mirroring `parse_delegate_keys`'s JSON-RPC dual-path.
fn grpc_value_as_u64(v: &prost_types::Value) -> Option<u64> {
    match &v.kind {
        Some(prost_types::value::Kind::StringValue(s)) => s.parse::<u64>().ok(),
        Some(prost_types::value::Kind::NumberValue(n)) => Some(*n as u64),
        _ => None,
    }
}

/// gRPC counterpart of `verify_delegate_key_onchain` above — same checks
/// (owner, active, delegate_keys membership), fetched via
/// LedgerService.GetObject instead of JSON-RPC's `sui_getObject`.
///
/// The gRPC `.json` object representation is flatter than JSON-RPC's
/// `.fields` shape and encodes delegate key `public_key` as base64 (not a
/// byte-array) — verified live against real testnet objects while migrating
/// the sidecar and web app to gRPC for this same JSON-RPC sunset.
async fn verify_delegate_key_onchain_grpc(
    mut client: sui_rpc::Client,
    account_object_id: &str,
    public_key_bytes: &[u8],
    expected_type_origin_package_id: &str,
) -> Result<String, OnchainVerifyError> {
    let address: sui_sdk_types::Address = account_object_id
        .parse()
        .map_err(|e| OnchainVerifyError::RpcError(format!("invalid object id: {}", e)))?;
    let mut request = sui_rpc::proto::sui::rpc::v2::GetObjectRequest::new(&address);
    request.read_mask = Some(prost_types::FieldMask {
        paths: vec!["json".to_string(), "object_type".to_string()],
    });

    let started = std::time::Instant::now();
    let response = client.ledger_client().get_object(request).await;
    let status_label = match &response {
        Ok(_) => "200".to_string(),
        Err(status) => status.code().to_string(),
    };
    crate::observability::observe_external(
        "sui_grpc",
        "GetObject",
        &status_label,
        started.elapsed(),
    );

    let object = response
        .map_err(|e| OnchainVerifyError::RpcError(format!("gRPC GetObject failed: {}", e)))?
        .into_inner()
        .object
        .ok_or_else(|| OnchainVerifyError::RpcError("gRPC response missing object".into()))?;

    // #398: verify the Move type before trusting any field (gRPC path).
    ensure_memwal_account_type(
        object.object_type.as_deref(),
        expected_type_origin_package_id,
        account_object_id,
    )?;

    let json = object
        .json
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no json content".into()))?;
    let fields = grpc_value_as_struct(&json)
        .ok_or_else(|| OnchainVerifyError::RpcError("Object json is not a struct".into()))?;

    let owner = fields
        .fields
        .get("owner")
        .and_then(grpc_value_as_str)
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'owner' field".into()))?
        .to_string();

    let active = grpc_account_active(fields)?;
    if !active {
        tracing::warn!(
            "account {} is deactivated — rejecting delegate key auth (gRPC)",
            account_object_id
        );
        return Err(OnchainVerifyError::AccountDeactivated(format!(
            "Account {} has been deactivated",
            account_object_id
        )));
    }

    let delegate_keys = fields
        .fields
        .get("delegate_keys")
        .and_then(grpc_value_as_list)
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'delegate_keys' field".into()))?;

    for dk in delegate_keys {
        let Some(dk_fields) = grpc_value_as_struct(dk) else {
            continue;
        };
        let Some(stored_b64) = dk_fields
            .fields
            .get("public_key")
            .and_then(grpc_value_as_str)
        else {
            continue;
        };
        let Ok(stored_bytes) = base64::engine::general_purpose::STANDARD.decode(stored_b64) else {
            continue;
        };
        if stored_bytes == public_key_bytes {
            tracing::info!("delegate key verified onchain (gRPC), owner: {}", owner);
            return Ok(owner);
        }
    }

    Err(OnchainVerifyError::KeyNotFound(format!(
        "Public key not found in {} delegate key(s) for account {} (gRPC)",
        delegate_keys.len(),
        account_object_id
    )))
}

/// gRPC counterpart of `list_delegate_keys_onchain`'s JSON-RPC body — same
/// shape as `verify_delegate_key_onchain_grpc` above (GetObject, type check,
/// struct navigation), but returns every delegate key rather than searching
/// for one match. Public key bytes are base64-encoded in the gRPC json
/// representation (unlike JSON-RPC's array-of-numbers), but `/agents`
/// doesn't need the key bytes at all — only `sui_address`/`label`/`created_at`.
async fn list_delegate_keys_onchain_grpc(
    mut client: sui_rpc::Client,
    account_object_id: &str,
    expected_type_origin_package_id: &str,
) -> Result<Vec<DelegateKeyInfo>, OnchainVerifyError> {
    let address: sui_sdk_types::Address = account_object_id
        .parse()
        .map_err(|e| OnchainVerifyError::RpcError(format!("invalid object id: {}", e)))?;
    let mut request = sui_rpc::proto::sui::rpc::v2::GetObjectRequest::new(&address);
    request.read_mask = Some(prost_types::FieldMask {
        paths: vec!["json".to_string(), "object_type".to_string()],
    });

    let started = std::time::Instant::now();
    let response = client.ledger_client().get_object(request).await;
    let status_label = match &response {
        Ok(_) => "200".to_string(),
        Err(status) => status.code().to_string(),
    };
    crate::observability::observe_external(
        "sui_grpc",
        "GetObject",
        &status_label,
        started.elapsed(),
    );

    let object = response
        .map_err(|e| OnchainVerifyError::RpcError(format!("gRPC GetObject failed: {}", e)))?
        .into_inner()
        .object
        .ok_or_else(|| OnchainVerifyError::RpcError("gRPC response missing object".into()))?;

    ensure_memwal_account_type(
        object.object_type.as_deref(),
        expected_type_origin_package_id,
        account_object_id,
    )?;

    let json = object
        .json
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no json content".into()))?;
    let fields = grpc_value_as_struct(&json)
        .ok_or_else(|| OnchainVerifyError::RpcError("Object json is not a struct".into()))?;

    let delegate_keys = fields
        .fields
        .get("delegate_keys")
        .and_then(grpc_value_as_list)
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'delegate_keys' field".into()))?;

    let mut out = Vec::with_capacity(delegate_keys.len());
    for dk in delegate_keys {
        let Some(dk_fields) = grpc_value_as_struct(dk) else {
            continue;
        };
        let sui_address = dk_fields
            .fields
            .get("sui_address")
            .and_then(grpc_value_as_str)
            .ok_or_else(|| OnchainVerifyError::RpcError("delegate key missing sui_address".into()))?
            .to_string();
        let label = dk_fields
            .fields
            .get("label")
            .and_then(grpc_value_as_str)
            .unwrap_or("")
            .to_string();
        let created_at = dk_fields
            .fields
            .get("created_at")
            .and_then(grpc_value_as_u64)
            .unwrap_or(0);
        out.push(DelegateKeyInfo {
            sui_address,
            label,
            created_at,
        });
    }

    Ok(out)
}

/// Scan the AccountRegistry to find which account holds a given delegate key.
///
/// Flow:
/// 1. Fetch the AccountRegistry object to get the Table's inner object ID
/// 2. Use `suix_getDynamicFields` on the Table's inner ID to enumerate accounts
/// 3. For each account, fetch it and check delegate_keys
///
/// The scan is capped at `max_pages` pages (50 accounts per page, one
/// `sui_getObject` per candidate account) so an unknown key can't walk the
/// entire registry — this runs from the auth middleware, before rate
/// limiting. Past the cap, `Err(ScanCapExceeded)` tells the caller the
/// client should send the x-account-id hint instead.
///
/// Returns `Ok((account_object_id, owner))` if found.
pub async fn find_account_by_delegate_key(
    http_client: &reqwest::Client,
    rpc_url: &str,
    registry_id: &str,
    public_key_bytes: &[u8],
    expected_type_origin_package_id: &str,
    max_pages: u32,
) -> Result<(String, String), OnchainVerifyError> {
    // Step 1: Fetch registry to get the Table's inner object ID
    let registry_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sui_getObject",
        "params": [registry_id, { "showContent": true }]
    });

    let request = http_client
        .post(rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&registry_body);
    let request = crate::observability::apply_request_id_header(request);
    let started = std::time::Instant::now();
    let registry_resp = request.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sui_rpc",
            "sui_getObject_registry",
            "transport_error",
            started.elapsed(),
        );
        OnchainVerifyError::RpcError(format!("Failed to fetch registry: {}", e))
    })?;
    let status_label = registry_resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sui_rpc",
        "sui_getObject_registry",
        &status_label,
        started.elapsed(),
    );

    let registry_json: serde_json::Value =
        parse_json_rpc_response(registry_resp, "sui_getObject registry").await?;

    // Extract Table inner ID: result.data.content.fields.accounts.fields.id.id
    let table_id = registry_json
        .pointer("/result/data/content/fields/accounts/fields/id/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            OnchainVerifyError::RpcError("Failed to extract accounts table ID from registry".into())
        })?
        .to_string();

    tracing::debug!("registry accounts table inner ID: {}", table_id);

    // Step 2: Scan dynamic fields on the Table's inner ID
    let mut cursor: Option<String> = None;
    let mut pages_scanned: u32 = 0;

    loop {
        if pages_scanned >= max_pages {
            return Err(OnchainVerifyError::ScanCapExceeded(format!(
                "registry scan stopped after {} pages (~{} accounts) without finding the \
                 delegate key; client must send the x-account-id header hint",
                max_pages,
                u64::from(max_pages) * 50
            )));
        }
        pages_scanned += 1;

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "suix_getDynamicFields",
            "params": [table_id, cursor, 50]
        });

        let request = http_client
            .post(rpc_url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .json(&body);
        let request = crate::observability::apply_request_id_header(request);
        let started = std::time::Instant::now();
        let response = request.send().await.map_err(|e| {
            crate::observability::observe_external(
                "sui_rpc",
                "suix_getDynamicFields",
                "transport_error",
                started.elapsed(),
            );
            OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e))
        })?;
        let status_label = response.status().as_u16().to_string();
        crate::observability::observe_external(
            "sui_rpc",
            "suix_getDynamicFields",
            &status_label,
            started.elapsed(),
        );

        let resp_json: serde_json::Value =
            parse_json_rpc_response(response, "suix_getDynamicFields").await?;

        if let Some(error) = resp_json.get("error") {
            return Err(OnchainVerifyError::RpcError(format!(
                "RPC error: {}",
                error
            )));
        }

        let result = resp_json
            .get("result")
            .ok_or_else(|| OnchainVerifyError::RpcError("No result in response".into()))?;

        let data = result
            .get("data")
            .and_then(|d| d.as_array())
            .ok_or_else(|| OnchainVerifyError::RpcError("No data array in response".into()))?;

        // Each entry is a dynamic field wrapping (address → ID)
        for field_info in data {
            let field_obj_id = field_info
                .get("objectId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    OnchainVerifyError::RpcError("Missing objectId in dynamic field".into())
                })?;

            // Fetch the dynamic field to get the account object ID
            let field_body = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sui_getObject",
                "params": [field_obj_id, { "showContent": true }]
            });

            let request = http_client
                .post(rpc_url)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .json(&field_body);
            let request = crate::observability::apply_request_id_header(request);
            let started = std::time::Instant::now();
            let field_resp = request.send().await.map_err(|e| {
                crate::observability::observe_external(
                    "sui_rpc",
                    "sui_getObject_dynamic_field",
                    "transport_error",
                    started.elapsed(),
                );
                OnchainVerifyError::RpcError(format!("Failed to fetch field: {}", e))
            })?;
            let status_label = field_resp.status().as_u16().to_string();
            crate::observability::observe_external(
                "sui_rpc",
                "sui_getObject_dynamic_field",
                &status_label,
                started.elapsed(),
            );

            let field_json: serde_json::Value =
                parse_json_rpc_response(field_resp, "sui_getObject dynamic field").await?;

            // Extract the account ID from the dynamic field value
            let account_id = field_json
                .pointer("/result/data/content/fields/value")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            if account_id.is_empty() {
                continue;
            }

            // Fetch the actual MemWalAccount to check delegate_keys.
            // Registry-scan fallback stays JSON-RPC-only for now: gRPC has no
            // single-key dynamic-field lookup (only paginated
            // ListDynamicFields), and this path only runs when the SDK sent
            // no x-account-id hint, which modern SDKs always do — see
            // Strategy 2 in resolve_account (auth.rs).
            match verify_delegate_key_onchain(
                http_client,
                rpc_url,
                None,
                account_id,
                public_key_bytes,
                expected_type_origin_package_id,
            )
            .await
            {
                Ok(owner) => {
                    tracing::info!(
                        "found account for delegate key via registry scan: {}",
                        account_id
                    );
                    return Ok((account_id.to_string(), owner));
                }
                Err(OnchainVerifyError::KeyNotFound(_)) => {
                    continue;
                }
                Err(e) => {
                    return Err(e);
                }
            }
        }

        // Check for next page
        let next_cursor = result
            .get("nextCursor")
            .and_then(|v| v.as_str())
            .map(String::from);
        let has_next = result
            .get("hasNextPage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !has_next || next_cursor.is_none() {
            break;
        }
        cursor = next_cursor;
    }

    Err(OnchainVerifyError::KeyNotFound(
        "Delegate key not found in any account in the registry".into(),
    ))
}

// ============================================================
// Types for JSON-RPC response parsing
// ============================================================

async fn parse_json_rpc_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, OnchainVerifyError> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<missing>")
        .to_string();
    let bytes = response.bytes().await.map_err(|e| {
        OnchainVerifyError::RpcError(format!(
            "{}: failed to read RPC response body: {} (status={}, content-type={})",
            context, e, status, content_type
        ))
    })?;

    if !status.is_success() {
        return Err(OnchainVerifyError::RpcError(format!(
            "{}: RPC HTTP error status={}, content-type={}, body={}",
            context,
            status,
            content_type,
            body_snippet(&bytes),
        )));
    }

    serde_json::from_slice(&bytes).map_err(|e| {
        OnchainVerifyError::RpcError(format!(
            "{}: failed to parse RPC JSON: {} (status={}, content-type={}, body={})",
            context,
            e,
            status,
            content_type,
            body_snippet(&bytes),
        ))
    })
}

fn body_snippet(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 512;

    let text = String::from_utf8_lossy(bytes);
    let mut snippet: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        snippet.push_str("...");
    }
    snippet.replace('\n', "\\n").replace('\r', "\\r")
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
    result: Option<RpcResult>,
    error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct RpcResult {
    data: Option<ObjectData>,
}

#[derive(Debug, Deserialize)]
struct ObjectData {
    content: Option<ObjectContent>,
}

#[derive(Debug, Deserialize)]
struct ObjectContent {
    /// Move type string, e.g. `0x…::account::MemWalAccount`. Checked against
    /// the configured package before any field is trusted (#398).
    #[serde(rename = "type")]
    object_type: Option<String>,
    fields: Option<serde_json::Map<String, serde_json::Value>>,
}

// ============================================================
// Error types
// ============================================================

#[derive(Debug)]
pub enum OnchainVerifyError {
    RpcError(String),
    KeyNotFound(String),
    /// Returned when MemWalAccount.active == false.
    /// Prevents deactivated accounts from authenticating.
    AccountDeactivated(String),
    /// The named object is not `{package}::account::MemWalAccount` — a foreign
    /// or lookalike object was supplied. Blocks owner spoofing (#398).
    WrongObjectType(String),
    /// The registry fallback scan hit its page cap without finding the key
    /// (MEMWAL_REGISTRY_SCAN_MAX_PAGES). The client should send the
    /// x-account-id header hint so auth verifies the account directly.
    ScanCapExceeded(String),
}

impl std::fmt::Display for OnchainVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OnchainVerifyError::RpcError(msg) => write!(f, "Sui RPC error: {}", msg),
            OnchainVerifyError::KeyNotFound(msg) => write!(f, "Key not found: {}", msg),
            OnchainVerifyError::AccountDeactivated(msg) => {
                write!(f, "Account deactivated: {}", msg)
            }
            OnchainVerifyError::WrongObjectType(msg) => {
                write!(f, "Wrong object type: {}", msg)
            }
            OnchainVerifyError::ScanCapExceeded(msg) => {
                write!(f, "Registry scan cap exceeded: {}", msg)
            }
        }
    }
}

impl std::error::Error for OnchainVerifyError {}

impl OnchainVerifyError {
    /// True when the chain could not be consulted, as opposed to a definitive
    /// "this key is not registered / this account is dead" answer.
    ///
    /// HTTP signed auth and the MCP proxy must not treat these as a revoke:
    /// a Sui gRPC 429 is `RpcError`, and logging it as "revoked on-chain"
    /// produced intermittent empty 401s that the SDK mapped to memwal_login
    /// (WALM-429).
    pub fn is_unavailable(&self) -> bool {
        match self {
            Self::RpcError(_) | Self::ScanCapExceeded(_) => true,
            Self::KeyNotFound(_) | Self::AccountDeactivated(_) | Self::WrongObjectType(_) => false,
        }
    }
}

/// Reject any object whose Move type is not
/// `{type-origin-package}::account::MemWalAccount`. Sui preserves the original
/// publish/type-origin id across package upgrades, so this must never be the
/// current upgraded package object's id. The origin id comes from trusted
/// config, never from the object itself, so foreign lookalikes cannot
/// authenticate as an arbitrary owner (#398).
fn ensure_memwal_account_type(
    actual_type: Option<&str>,
    expected_type_origin_package_id: &str,
    account_object_id: &str,
) -> Result<(), OnchainVerifyError> {
    ensure_object_type(
        actual_type,
        expected_type_origin_package_id,
        "account",
        "MemWalAccount",
        account_object_id,
    )
}

fn ensure_object_type(
    actual_type: Option<&str>,
    expected_type_origin_package_id: &str,
    module: &str,
    struct_name: &str,
    object_id: &str,
) -> Result<(), OnchainVerifyError> {
    let expected = format!("{expected_type_origin_package_id}::{module}::{struct_name}");
    match actual_type {
        Some(t) if t == expected => Ok(()),
        other => Err(OnchainVerifyError::WrongObjectType(format!(
            "object {} has type {:?}, expected {} — foreign object rejected",
            object_id, other, expected
        ))),
    }
}

/// Boot-time invariant check for the package id used by the auth path. The
/// configured registry is a type-origin object: its Move type keeps the
/// original publish id across upgrades. Comparing that type to
/// MEMWAL_PACKAGE_ID makes the server refuse a natural but dangerous
/// misconfiguration where auth is pointed at an upgraded package object id.
pub async fn verify_registry_type_origin(
    http_client: &reqwest::Client,
    rpc_url: &str,
    grpc_client: Option<&sui_rpc::Client>,
    registry_id: &str,
    expected_type_origin_package_id: &str,
) -> Result<(), OnchainVerifyError> {
    let actual_type = if let Some(client) = grpc_client {
        let address: sui_sdk_types::Address = registry_id.parse().map_err(|error| {
            OnchainVerifyError::RpcError(format!("invalid registry id: {error}"))
        })?;
        let mut request = sui_rpc::proto::sui::rpc::v2::GetObjectRequest::new(&address);
        request.read_mask = Some(prost_types::FieldMask {
            paths: vec!["object_type".into()],
        });
        client
            .clone()
            .ledger_client()
            .get_object(request)
            .await
            .map_err(|error| {
                OnchainVerifyError::RpcError(format!(
                    "gRPC GetObject registry type-origin check failed: {error}"
                ))
            })?
            .into_inner()
            .object
            .and_then(|object| object.object_type)
    } else {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sui_getObject",
            "params": [registry_id, { "showType": true }]
        });
        let response = http_client
            .post(rpc_url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                OnchainVerifyError::RpcError(format!(
                    "registry type-origin check request failed: {error}"
                ))
            })?;
        let parsed: serde_json::Value =
            parse_json_rpc_response(response, "sui_getObject registry type-origin check").await?;
        parsed
            .pointer("/result/data/type")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
    };

    ensure_object_type(
        actual_type.as_deref(),
        expected_type_origin_package_id,
        "account",
        "AccountRegistry",
        registry_id,
    )
}

/// Fail closed at boot unless the configured executable SEAL policy is the
/// expected ABI from the immutable MemWal package lineage.
pub async fn verify_seal_policy_package(
    client: &sui_rpc::Client,
    immutable_package_id: &str,
    policy_package_id: &str,
) -> Result<(), OnchainVerifyError> {
    let immutable_id = parse_package_id("MEMWAL_PACKAGE_ID", immutable_package_id)?;
    let policy_id = parse_package_id("MEMWAL_SEAL_POLICY_PACKAGE_ID", policy_package_id)?;
    let package = client
        .clone()
        .package_client()
        .get_package(GetPackageRequest::new(&policy_id))
        .await
        .map_err(|error| {
            policy_error(format!(
                "gRPC GetPackage failed for {policy_package_id}: {error}"
            ))
        })?
        .into_inner()
        .package
        .ok_or_else(|| policy_error("gRPC GetPackage response is missing package"))?;

    validate_seal_policy_package(&package, immutable_id, policy_id)
}

fn parse_package_id(name: &str, value: &str) -> Result<Address, OnchainVerifyError> {
    value
        .parse()
        .map_err(|error| policy_error(format!("{name} is not a valid Sui address: {error}")))
}

fn policy_error(message: impl Into<String>) -> OnchainVerifyError {
    OnchainVerifyError::RpcError(format!(
        "SEAL policy package validation failed: {}",
        message.into()
    ))
}

fn validate_seal_policy_package(
    package: &Package,
    immutable_id: Address,
    policy_id: Address,
) -> Result<(), OnchainVerifyError> {
    let storage_id = package
        .storage_id
        .as_deref()
        .ok_or_else(|| policy_error("package is missing storage_id"))
        .and_then(|id| parse_package_id("GetPackage storage_id", id))?;
    if storage_id != policy_id {
        return Err(policy_error(format!(
            "storage_id {storage_id} does not match MEMWAL_SEAL_POLICY_PACKAGE_ID {policy_id}"
        )));
    }

    let original_id = package
        .original_id
        .as_deref()
        .ok_or_else(|| policy_error("package is missing original_id"))
        .and_then(|id| parse_package_id("GetPackage original_id", id))?;
    if original_id != immutable_id {
        return Err(policy_error(format!(
            "original_id {original_id} does not match MEMWAL_PACKAGE_ID {immutable_id}"
        )));
    }

    let seal_approve = package
        .modules
        .iter()
        .find(|module| module.name.as_deref() == Some("account"))
        .and_then(|module| {
            module
                .functions
                .iter()
                .find(|function| function.name.as_deref() == Some("seal_approve"))
        })
        .ok_or_else(|| policy_error("account::seal_approve is missing"))?;

    validate_seal_approve_abi(seal_approve, immutable_id)
}

fn validate_seal_approve_abi(
    function: &FunctionDescriptor,
    immutable_id: Address,
) -> Result<(), OnchainVerifyError> {
    if function.is_entry != Some(true) {
        return Err(policy_error(
            "account::seal_approve is not an entry function",
        ));
    }
    if !function.type_parameters.is_empty() {
        return Err(policy_error(
            "account::seal_approve must not have type parameters",
        ));
    }
    if !function.returns.is_empty() {
        return Err(policy_error("account::seal_approve must not return values"));
    }
    if function.parameters != expected_seal_approve_parameters(immutable_id) {
        return Err(policy_error(
            "account::seal_approve parameters do not match the current v1-new ABI",
        ));
    }
    Ok(())
}

fn expected_seal_approve_parameters(immutable_id: Address) -> Vec<OpenSignature> {
    vec![
        signature(
            None,
            signature_body(
                SignatureType::Vector,
                None,
                vec![signature_body(SignatureType::U8, None, vec![])],
            ),
        ),
        datatype_signature(
            immutable_id,
            "account",
            "AccountRegistry",
            Reference::Immutable,
        ),
        datatype_signature(
            immutable_id,
            "account",
            "MemWalAccount",
            Reference::Immutable,
        ),
        datatype_signature(
            Address::TWO,
            "tx_context",
            "TxContext",
            Reference::Immutable,
        ),
    ]
}

fn datatype_signature(
    package: Address,
    module: &str,
    name: &str,
    reference: Reference,
) -> OpenSignature {
    signature(
        Some(reference as i32),
        signature_body(
            SignatureType::Datatype,
            Some(format!("{package}::{module}::{name}")),
            vec![],
        ),
    )
}

fn signature(reference: Option<i32>, body: OpenSignatureBody) -> OpenSignature {
    let mut signature = OpenSignature::default();
    signature.reference = reference;
    signature.body = Some(body);
    signature
}

fn signature_body(
    signature_type: SignatureType,
    type_name: Option<String>,
    type_parameters: Vec<OpenSignatureBody>,
) -> OpenSignatureBody {
    let mut body = OpenSignatureBody::default();
    body.r#type = Some(signature_type as i32);
    body.type_name = type_name;
    body.type_parameter_instantiation = type_parameters;
    body
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- AccountDeactivated error variant ----

    #[test]
    fn test_account_deactivated_display() {
        let err =
            OnchainVerifyError::AccountDeactivated("Account 0xabc has been deactivated".into());
        assert!(err.to_string().contains("deactivated"));
    }

    #[test]
    fn test_key_not_found_display() {
        let err = OnchainVerifyError::KeyNotFound("Key not in 3 delegate key(s)".into());
        assert!(err.to_string().contains("Key not found"));
    }

    #[test]
    fn test_rpc_error_display() {
        let err = OnchainVerifyError::RpcError("HTTP request failed".into());
        assert!(err.to_string().contains("Sui RPC error"));
    }

    #[test]
    fn test_error_variants_are_distinct() {
        // Confirm AccountDeactivated is separate from KeyNotFound
        // (different auth failure modes → different handling in resolve_account)
        let deactivated = OnchainVerifyError::AccountDeactivated("msg".into());
        let not_found = OnchainVerifyError::KeyNotFound("msg".into());
        // Both are Err variants but must match differently:
        assert!(matches!(
            deactivated,
            OnchainVerifyError::AccountDeactivated(_)
        ));
        assert!(matches!(not_found, OnchainVerifyError::KeyNotFound(_)));
        assert!(!deactivated.is_unavailable());
        assert!(!not_found.is_unavailable());
        assert!(OnchainVerifyError::RpcError("429".into()).is_unavailable());
        assert!(OnchainVerifyError::ScanCapExceeded("cap".into()).is_unavailable());
        assert!(!OnchainVerifyError::WrongObjectType("type".into()).is_unavailable());
    }

    // ── Deactivated account field parsing ────────────────────────

    #[test]
    fn json_active_field_fails_closed() {
        let fields = |json| serde_json::from_str(json).unwrap();

        assert!(json_account_active(&fields(r#"{"active":true}"#)).unwrap());
        assert!(!json_account_active(&fields(r#"{"active":false}"#)).unwrap());
        assert!(json_account_active(&fields(r#"{}"#)).is_err());
        assert!(json_account_active(&fields(r#"{"active":"false"}"#)).is_err());
    }

    #[test]
    fn grpc_active_field_fails_closed() {
        use prost_types::value::Kind;

        let fields = |kind: Option<Kind>| prost_types::Struct {
            fields: kind
                .map(|kind| {
                    (
                        "active".to_string(),
                        prost_types::Value { kind: Some(kind) },
                    )
                })
                .into_iter()
                .collect(),
        };

        assert!(grpc_account_active(&fields(Some(Kind::BoolValue(true)))).unwrap());
        assert!(!grpc_account_active(&fields(Some(Kind::BoolValue(false)))).unwrap());
        assert!(grpc_account_active(&fields(None)).is_err());
        assert!(grpc_account_active(&fields(Some(Kind::StringValue("false".into())))).is_err());
    }

    // ── Delegate key matching — public key as JSON array ────────────────

    #[test]
    fn test_public_key_to_json_array_conversion() {
        // Test the exact conversion done in verify_delegate_key_onchain
        let pk_bytes: [u8; 32] = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27, 28, 29, 30, 31, 32,
        ];

        let pk_as_numbers: Vec<serde_json::Value> = pk_bytes
            .iter()
            .map(|&b| serde_json::Value::Number(b.into()))
            .collect();

        assert_eq!(pk_as_numbers.len(), 32);
        assert_eq!(pk_as_numbers[0], serde_json::json!(1));
        assert_eq!(pk_as_numbers[31], serde_json::json!(32));
    }

    #[test]
    fn test_delegate_key_matching_in_struct() {
        // Simulate array comparison used in the verification loop
        let pk_bytes: &[u8] = &[10, 20, 30];
        let pk_as_numbers: Vec<serde_json::Value> = pk_bytes
            .iter()
            .map(|&b| serde_json::Value::Number(b.into()))
            .collect();

        // Matching stored key
        let stored_key = serde_json::json!([10, 20, 30]);
        let stored_arr = stored_key.as_array().unwrap();
        assert_eq!(*stored_arr, pk_as_numbers, "matching key should be Equal");

        // Non-matching stored key
        let wrong_key = serde_json::json!([10, 20, 31]);
        let wrong_arr = wrong_key.as_array().unwrap();
        assert_ne!(*wrong_arr, pk_as_numbers, "different key should NOT match");
    }

    // ── parse_delegate_keys (Task 7 — pure JSON parsing, no I/O) ────────

    #[test]
    fn parse_delegate_keys_extracts_all_fields() {
        let fields: serde_json::Map<String, serde_json::Value> = serde_json::json!({
            "owner": "0xowner",
            "active": true,
            "delegate_keys": [
                {
                    "fields": {
                        "public_key": [1, 2, 3],
                        "sui_address": "0xdelegate1",
                        "label": "cli",
                        "created_at": "1700000000000"
                    }
                },
                {
                    "fields": {
                        "public_key": [4, 5, 6],
                        "sui_address": "0xdelegate2",
                        "label": "mobile",
                        "created_at": "1700000001000"
                    }
                }
            ]
        })
        .as_object()
        .unwrap()
        .clone();

        let parsed = parse_delegate_keys(&fields).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].label, "cli");
        assert_eq!(parsed[0].sui_address, "0xdelegate1");
        assert_eq!(parsed[0].created_at, 1700000000000);
        assert_eq!(parsed[1].label, "mobile");
    }

    // ── list_delegate_keys_cached (short-TTL cache) ─────────────────────
    //
    // No mock-HTTP crate exists in this codebase's dependency tree, so these
    // tests prove the cache-hit / TTL-expiry branches without a live chain
    // call: they point at an unreachable RPC URL and rely on the fact that a
    // cache HIT returns before ever attempting the HTTP request (so it
    // succeeds despite the bad URL), while a cache MISS/expiry falls through
    // to the real request path (so it fails against the bad URL). This
    // exercises the exact branch the fix depends on.

    fn unreachable_rpc_url() -> &'static str {
        // Port 1 is a reserved/unassigned TCP port — connection is refused
        // immediately rather than hanging, so the test stays fast.
        "http://127.0.0.1:1/"
    }

    fn sample_delegate_keys() -> Vec<DelegateKeyInfo> {
        vec![DelegateKeyInfo {
            sui_address: "0xdelegate1".to_string(),
            label: "cli".to_string(),
            created_at: 1_700_000_000,
        }]
    }

    #[tokio::test]
    async fn list_delegate_keys_cached_returns_cached_value_within_ttl() {
        let cache = new_delegate_keys_cache();
        let account_id = "0xaccount-fresh";
        cache.write().await.insert(
            account_id.to_string(),
            TimedDelegateKeys {
                value: sample_delegate_keys(),
                fetched_at: std::time::Instant::now(),
            },
        );

        let client = reqwest::Client::new();
        let result = list_delegate_keys_cached(
            &cache,
            &client,
            unreachable_rpc_url(),
            None,
            account_id,
            "0xpkg",
        )
        .await;

        assert!(
            result.is_ok(),
            "a fresh cache entry must be served without attempting the RPC call, got {:?}",
            result.err()
        );
        assert_eq!(result.unwrap(), sample_delegate_keys());
    }

    #[tokio::test]
    async fn list_delegate_keys_cached_refetches_after_ttl_expiry() {
        let cache = new_delegate_keys_cache();
        let account_id = "0xaccount-stale";
        cache.write().await.insert(
            account_id.to_string(),
            TimedDelegateKeys {
                value: sample_delegate_keys(),
                fetched_at: std::time::Instant::now()
                    - DELEGATE_KEYS_CACHE_TTL
                    - std::time::Duration::from_secs(1),
            },
        );

        let client = reqwest::Client::new();
        let result = list_delegate_keys_cached(
            &cache,
            &client,
            unreachable_rpc_url(),
            None,
            account_id,
            "0xpkg",
        )
        .await;

        assert!(
            result.is_err(),
            "an expired cache entry must trigger a real re-fetch attempt, which should fail \
             against the unreachable RPC URL used in this test — got Ok, meaning the stale \
             entry was served instead"
        );
    }

    #[tokio::test]
    async fn list_delegate_keys_cached_misses_for_unknown_account() {
        let cache = new_delegate_keys_cache();
        let client = reqwest::Client::new();
        let result = list_delegate_keys_cached(
            &cache,
            &client,
            unreachable_rpc_url(),
            None,
            "0xnever-cached",
            "0xpkg",
        )
        .await;

        assert!(
            result.is_err(),
            "no cache entry exists yet, so this must attempt (and fail) the real RPC call"
        );
    }

    // ── DelegateKeysCache periodic sweep (nothing else ever removed a map
    //    slot — only the TTL above gated trust-on-hit) ───────────────────
    //
    // The sweep itself is a `tokio::spawn` + `interval` loop in `main.rs`
    // (not unit-testable in isolation without booting the binary), but its
    // core logic is exactly this `retain` predicate. This test locks that
    // predicate down against the two failure modes that would silently
    // reintroduce the leak: evicting entries that are still within
    // `DELEGATE_KEYS_CACHE_MAX_AGE`, or failing to evict ones that aren't.
    #[tokio::test]
    async fn delegate_keys_cache_sweep_predicate_evicts_only_stale_entries() {
        let cache = new_delegate_keys_cache();
        cache.write().await.insert(
            "0xstale".to_string(),
            TimedDelegateKeys {
                value: vec![],
                fetched_at: std::time::Instant::now()
                    - DELEGATE_KEYS_CACHE_MAX_AGE
                    - std::time::Duration::from_secs(1),
            },
        );
        cache.write().await.insert(
            "0xfresh".to_string(),
            TimedDelegateKeys {
                value: vec![],
                fetched_at: std::time::Instant::now(),
            },
        );

        // Mirrors main.rs's `delegate_cache_sweep` task body verbatim.
        cache
            .write()
            .await
            .retain(|_, v| v.fetched_at.elapsed() < DELEGATE_KEYS_CACHE_MAX_AGE);

        let remaining = cache.read().await;
        assert!(
            !remaining.contains_key("0xstale"),
            "entry older than DELEGATE_KEYS_CACHE_MAX_AGE must be evicted"
        );
        assert!(
            remaining.contains_key("0xfresh"),
            "entry younger than DELEGATE_KEYS_CACHE_MAX_AGE must survive the sweep"
        );
    }

    #[test]
    fn test_delegate_key_in_fields_wrapper() {
        // Test the delegate key extraction with the "fields" wrapper pattern
        let dk_json = serde_json::json!({
            "fields": {
                "public_key": [1, 2, 3],
                "label": "test-key",
                "created_at": "123456"
            }
        });

        let dk_fields = dk_json.get("fields").or(Some(&dk_json));
        let stored_key = dk_fields.and_then(|f| f.get("public_key"));
        assert!(stored_key.is_some());
        assert_eq!(
            stored_key.unwrap().as_array().unwrap(),
            &vec![
                serde_json::json!(1),
                serde_json::json!(2),
                serde_json::json!(3),
            ]
        );
    }

    #[test]
    fn test_delegate_key_without_fields_wrapper() {
        // Test the fallback when there's no "fields" wrapper
        let dk_json = serde_json::json!({
            "public_key": [4, 5, 6],
            "label": "test-key"
        });

        let dk_fields = dk_json.get("fields").or(Some(&dk_json));
        let stored_key = dk_fields.and_then(|f| f.get("public_key"));
        assert!(stored_key.is_some());
        assert_eq!(
            stored_key.unwrap().as_array().unwrap(),
            &vec![
                serde_json::json!(4),
                serde_json::json!(5),
                serde_json::json!(6),
            ]
        );
    }

    // ── OnchainVerifyError: Display correctness ─────────────────────────

    #[test]
    fn test_account_deactivated_display_includes_account_id() {
        let err =
            OnchainVerifyError::AccountDeactivated("Account 0xabc has been deactivated".into());
        let display = err.to_string();
        assert!(display.contains("deactivated"));
        assert!(display.contains("0xabc"));
    }

    #[test]
    fn test_error_is_std_error() {
        // Verify OnchainVerifyError implements std::error::Error
        let err: Box<dyn std::error::Error> =
            Box::new(OnchainVerifyError::AccountDeactivated("test".into()));
        assert!(err.to_string().contains("deactivated"));
    }

    // ── #398: object Move-type check ────────────────────────────────────────
    #[test]
    fn test_ensure_memwal_account_type() {
        let original_type_origin_pkg = "0xabc";
        let upgraded_current_pkg = "0xdef";
        // After an upgrade the object still carries the original type-origin
        // package id, so pinning that immutable id keeps auth working.
        assert!(ensure_memwal_account_type(
            Some("0xabc::account::MemWalAccount"),
            original_type_origin_pkg,
            "0xobj"
        )
        .is_ok());
        // A foreign lookalike (same field names, different type) — the #398
        // spoofing object — is rejected.
        assert!(matches!(
            ensure_memwal_account_type(
                Some("0xdef::fake_account::FakeAccount"),
                original_type_origin_pkg,
                "0xobj"
            ),
            Err(OnchainVerifyError::WrongObjectType(_))
        ));
        // Mistakenly configuring the upgraded/current package id rejects the
        // genuine object's original type, making the configuration error clear.
        assert!(matches!(
            ensure_memwal_account_type(
                Some("0xabc::account::MemWalAccount"),
                upgraded_current_pkg,
                "0xobj"
            ),
            Err(OnchainVerifyError::WrongObjectType(_))
        ));
        // Missing type — rejected.
        assert!(matches!(
            ensure_memwal_account_type(None, original_type_origin_pkg, "0xobj"),
            Err(OnchainVerifyError::WrongObjectType(_))
        ));
    }

    #[test]
    fn test_registry_type_origin_rejects_upgraded_package_id() {
        let origin = "0xabc";
        let actual = "0xabc::account::AccountRegistry";
        assert!(ensure_object_type(
            Some(actual),
            origin,
            "account",
            "AccountRegistry",
            "0xregistry",
        )
        .is_ok());

        let error = ensure_object_type(
            Some(actual),
            "0xupgraded",
            "account",
            "AccountRegistry",
            "0xregistry",
        )
        .expect_err("upgraded package id must fail closed");
        assert!(error
            .to_string()
            .contains("0xupgraded::account::AccountRegistry"));
    }

    fn seal_policy_package_fixture() -> (Package, Address, Address) {
        let immutable_id: Address = "0xabc".parse().unwrap();
        let policy_id: Address = "0xdef".parse().unwrap();

        let mut seal_approve = FunctionDescriptor::default();
        seal_approve.name = Some("seal_approve".into());
        seal_approve.is_entry = Some(true);
        seal_approve.parameters = expected_seal_approve_parameters(immutable_id);

        let mut account = sui_rpc::proto::sui::rpc::v2::Module::default();
        account.name = Some("account".into());
        account.functions = vec![seal_approve];

        let mut package = Package::default();
        package.storage_id = Some(policy_id.to_string());
        package.original_id = Some(immutable_id.to_string());
        package.modules = vec![account];
        (package, immutable_id, policy_id)
    }

    #[test]
    fn seal_policy_package_accepts_exact_v1_new_abi() {
        let (package, immutable_id, policy_id) = seal_policy_package_fixture();
        validate_seal_policy_package(&package, immutable_id, policy_id).unwrap();
    }

    #[test]
    fn seal_policy_package_rejects_storage_or_lineage_mismatch() {
        let (package, immutable_id, policy_id) = seal_policy_package_fixture();

        let mut wrong_storage = package.clone();
        wrong_storage.storage_id = Some(Address::TWO.to_string());
        assert!(
            validate_seal_policy_package(&wrong_storage, immutable_id, policy_id)
                .unwrap_err()
                .to_string()
                .contains("storage_id")
        );

        let mut wrong_lineage = package;
        wrong_lineage.original_id = Some(Address::THREE.to_string());
        assert!(
            validate_seal_policy_package(&wrong_lineage, immutable_id, policy_id)
                .unwrap_err()
                .to_string()
                .contains("original_id")
        );
    }

    #[test]
    fn seal_policy_package_rejects_entry_or_parameter_drift() {
        let (package, immutable_id, policy_id) = seal_policy_package_fixture();

        let mut not_entry = package.clone();
        not_entry.modules[0].functions[0].is_entry = Some(false);
        assert!(
            validate_seal_policy_package(&not_entry, immutable_id, policy_id)
                .unwrap_err()
                .to_string()
                .contains("not an entry")
        );

        let mut generic = package.clone();
        generic.modules[0].functions[0]
            .type_parameters
            .push(Default::default());
        assert!(validate_seal_policy_package(&generic, immutable_id, policy_id).is_err());

        let mut returns_value = package.clone();
        returns_value.modules[0].functions[0]
            .returns
            .push(Default::default());
        assert!(validate_seal_policy_package(&returns_value, immutable_id, policy_id).is_err());

        let mut wrong_parameters = package;
        wrong_parameters.modules[0].functions[0].parameters[3].reference =
            Some(Reference::Mutable as i32);
        assert!(
            validate_seal_policy_package(&wrong_parameters, immutable_id, policy_id)
                .unwrap_err()
                .to_string()
                .contains("current v1-new ABI")
        );
    }

    #[test]
    fn seal_policy_package_rejects_invalid_configured_ids() {
        assert!(parse_package_id("MEMWAL_PACKAGE_ID", "not-an-address").is_err());
        assert!(parse_package_id("MEMWAL_SEAL_POLICY_PACKAGE_ID", "0xnothex").is_err());
    }

    // ── gRPC path: live network tests (real testnet, no mocking) ─────────
    // `cargo test -- --ignored` to run. Not part of the default suite since
    // it needs real network access — but this is exactly how the equivalent
    // gRPC shape bugs were caught on the TS side during this same migration
    // (guessing from docs got the shape wrong twice; live testing didn't).

    #[tokio::test]
    #[ignore]
    async fn test_verify_delegate_key_onchain_grpc_real_account() {
        // Real MemWalAccount on testnet with a known delegate_keys entry,
        // confirmed live while migrating the sidecar/web app to gRPC for
        // this same JSON-RPC sunset.
        let account_id = "0xfba86e31b07ce36748ffe46de494bd4a2fa0058a5851ec4006141abcc5498fe2";
        let wrong_key = [0u8; 32];
        // The account is defined by the V1 testnet package; pass it so the type
        // check passes and we reach the (wrong) key check.
        let expected_pkg = "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6";

        let client = sui_rpc::Client::new("https://fullnode.testnet.sui.io").unwrap();
        let result =
            verify_delegate_key_onchain_grpc(client, account_id, &wrong_key, expected_pkg).await;

        // The account genuinely exists and gRPC parses it correctly — a
        // non-matching key must fail with KeyNotFound, not RpcError. Getting
        // RpcError here means the gRPC request/response shape is wrong, not
        // that the key is missing.
        match result {
            Err(OnchainVerifyError::KeyNotFound(_)) => {}
            other => {
                panic!("expected KeyNotFound for a real account with a wrong key, got: {other:?}")
            }
        }
    }

    #[tokio::test]
    #[ignore]
    async fn test_verify_delegate_key_onchain_grpc_missing_object() {
        // Object that doesn't exist onchain — must surface as an error, not panic.
        let fake_id = "0x0000000000000000000000000000000000000000000000000000000000000001";
        let client = sui_rpc::Client::new("https://fullnode.testnet.sui.io").unwrap();
        let result = verify_delegate_key_onchain_grpc(
            client,
            fake_id,
            &[0u8; 32],
            "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6",
        )
        .await;
        assert!(result.is_err());
    }
}
