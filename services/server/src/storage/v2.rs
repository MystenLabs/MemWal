//! V2 namespace resolution, D1 commitment, and write-path gates.

use crate::types::{AppError, AppState, AuthInfo, Config};
use base64::Engine as _;
use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use serde_json::Value;
use sui_rpc::proto::sui::rpc::v2::{GetObjectRequest, ListDynamicFieldsRequest};
use sui_sdk_types::{Address, Ed25519PublicKey};

type Blake2b256 = Blake2b<U32>;

#[derive(Clone)]
pub struct V2Rpc {
    pub http_client: reqwest::Client,
    pub sui_rpc_url: String,
    pub sui_grpc_client: Option<sui_rpc::Client>,
}

impl V2Rpc {
    pub fn from_state(state: &AppState) -> Self {
        Self {
            http_client: state.http_client.clone(),
            sui_rpc_url: state.config.sui_rpc_url.clone(),
            sui_grpc_client: state.sui_grpc_client.clone(),
        }
    }
}

const WRITE_COMMITMENT_DOMAIN: &[u8] = b"memwal.v2.write_commitment.v1";
const PERMISSION_WRITE: u8 = 2;
const PERMISSION_READ: u8 = 1;

#[derive(Debug, Clone)]
pub struct V2Namespace {
    pub object_id: String,
    pub account_id: String,
    pub owner: String,
    pub label: String,
    pub current_key_version: u64,
    pub wrapped_dek: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct V2StoredMeta {
    pub namespace_object_id: Option<String>,
    pub key_version: Option<i64>,
    pub storage_mode: Option<String>,
    pub oyster_bucket: Option<String>,
    pub oyster_key: Option<String>,
    pub pooled_blob_object_id: Option<String>,
    pub ciphertext_digest: Option<Vec<u8>>,
    pub commitment: Option<Vec<u8>>,
    pub fence_tx_digest: Option<String>,
}

pub fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2b256::new();
    hasher.update(data);
    hasher.finalize().into()
}

pub fn sui_address_from_ed25519_pubkey_hex(public_key_hex: &str) -> Result<String, AppError> {
    let bytes = hex::decode(public_key_hex)
        .map_err(|_| AppError::BadRequest("invalid x-public-key hex".into()))?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| AppError::BadRequest("x-public-key must be 32 bytes".into()))?;
    Ok(Ed25519PublicKey::new(array).derive_address().to_string())
}

pub fn parse_object_id32(id: &str) -> Result<[u8; 32], AppError> {
    let addr: Address = id
        .parse()
        .map_err(|_| AppError::Internal(format!("invalid object id {id}")))?;
    Ok(addr.into_inner())
}

fn uleb128(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
    out
}

/// `blake2b256(BCS(account_id) || BCS(label))` matching `namespace::namespace_key`.
pub fn namespace_registry_key(account_id: &str, label: &str) -> Result<[u8; 32], AppError> {
    let mut bytes = parse_object_id32(account_id)?.to_vec();
    bytes.extend(uleb128(label.len() as u64));
    bytes.extend(label.as_bytes());
    Ok(blake2b256(&bytes))
}

pub fn namespace_seal_id_suffix(namespace_id: &str, key_version: u64) -> Result<[u8; 40], AppError> {
    let mut id = [0u8; 40];
    id[..32].copy_from_slice(&parse_object_id32(namespace_id)?);
    id[32..].copy_from_slice(&key_version.to_le_bytes());
    Ok(id)
}

pub fn decode_walrus_blob_id_le(blob_id: &str) -> Result<[u8; 32], AppError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(blob_id.trim())
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(blob_id.trim()))
        .map_err(|e| AppError::Internal(format!("invalid oyster/walrus blob_id: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| AppError::Internal("oyster blob_id must decode to 32 bytes".into()))
}

pub fn write_commitment_v1(
    namespace_id: &str,
    key_version: u64,
    blob_id: &str,
    pooled_blob_object_id: Option<&str>,
    envelope: &[u8],
) -> Result<[u8; 32], AppError> {
    let ciphertext_digest = blake2b256(envelope);
    let blob_object = match pooled_blob_object_id {
        Some(id) if !id.is_empty() => parse_object_id32(id)?,
        _ => [0u8; 32],
    };
    let mut preimage = Vec::with_capacity(WRITE_COMMITMENT_DOMAIN.len() + 1 + 32 * 4 + 8);
    preimage.extend_from_slice(WRITE_COMMITMENT_DOMAIN);
    preimage.push(0x00);
    preimage.extend_from_slice(&parse_object_id32(namespace_id)?);
    preimage.extend_from_slice(&key_version.to_le_bytes());
    preimage.extend_from_slice(&decode_walrus_blob_id_le(blob_id)?);
    preimage.extend_from_slice(&blob_object);
    preimage.extend_from_slice(&ciphertext_digest);
    Ok(blake2b256(&preimage))
}

pub fn writer_in_pool(config: &Config, address: &str) -> bool {
    let Ok(addr) = address.parse::<Address>() else {
        return false;
    };
    let canonical = addr.to_string();
    config
        .memwal_v2_writer_addresses
        .iter()
        .any(|w| w.eq_ignore_ascii_case(&canonical))
}

pub fn v2_writes_disabled() -> AppError {
    AppError::Conflict {
        code: "v2_writes_disabled".into(),
        message: "v2 writes are disabled for this namespace".into(),
    }
}

/// Live V2 namespace for this account+label, or `None` to keep the V1 path.
pub async fn resolve_live_v2_namespace(
    state: &AppState,
    account_id: &str,
    label: &str,
) -> Result<Option<V2Namespace>, AppError> {
    if !state.config.v2_chain_configured() {
        return Ok(None);
    }
    let package_id = state.config.memwal_v2_package_id.as_deref().unwrap();
    let ns_registry = state
        .config
        .memwal_v2_namespace_registry_id
        .as_deref()
        .unwrap();
    let key = namespace_registry_key(account_id, label)?;
    let rpc = V2Rpc::from_state(state);
    let Some(namespace_id) =
        lookup_registry_namespace(&rpc, ns_registry, &key, package_id).await?
    else {
        return Ok(None);
    };
    load_live_namespace(&rpc, &namespace_id, account_id, label, package_id).await
}

async fn lookup_registry_namespace(
    rpc: &V2Rpc,
    registry_id: &str,
    key: &[u8; 32],
    package_id: &str,
) -> Result<Option<String>, AppError> {
    let registry = get_object_json(rpc, registry_id).await?;
    let object_type = registry
        .get("object_type")
        .and_then(Value::as_str)
        .or_else(|| registry.pointer("/type").and_then(Value::as_str));
    ensure_type(
        object_type,
        package_id,
        "namespace",
        "NamespaceRegistry",
        registry_id,
    )?;
    let json = object_move_json(&registry)?;
    let table_id = table_uid(json, "namespaces").ok_or_else(|| {
        AppError::Internal("V2 NamespaceRegistry is missing namespaces table id".into())
    })?;
    lookup_table_id_value(rpc, &table_id, TableKey::Bytes32(*key)).await
}

async fn load_live_namespace(
    rpc: &V2Rpc,
    namespace_id: &str,
    account_id: &str,
    label: &str,
    package_id: &str,
) -> Result<Option<V2Namespace>, AppError> {
    let object = get_object_json(rpc, namespace_id).await?;
    let object_type = object
        .get("object_type")
        .and_then(Value::as_str)
        .or_else(|| object.pointer("/type").and_then(Value::as_str));
    ensure_type(
        object_type,
        package_id,
        "namespace",
        "MemoryNamespace",
        namespace_id,
    )?;
    let json = object_move_json(&object)?;
    let ns_account = json_address(json, "account_id").unwrap_or_default();
    let ns_label = json
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let owner = json_address(json, "owner").unwrap_or_default();
    let active = json.get("active").and_then(Value::as_bool).unwrap_or(false);
    let destroyed = json
        .get("destroyed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let key_initialized = json
        .get("key_initialized")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let current_key_version = json_u64(json, "current_key_version").unwrap_or(0);
    if !active || destroyed || !key_initialized {
        return Ok(None);
    }
    if !addresses_equal(&ns_account, account_id) || ns_label != label {
        return Ok(None);
    }
    let kv_table = table_uid(json, "key_versions").ok_or_else(|| {
        AppError::Internal("V2 MemoryNamespace is missing key_versions table".into())
    })?;
    let wrapped_dek = lookup_wrapped_dek(rpc, &kv_table, current_key_version)
        .await?
        .ok_or_else(|| AppError::Internal("V2 namespace current wrapped DEK is missing".into()))?;
    Ok(Some(V2Namespace {
        object_id: canonical_id(namespace_id)?,
        account_id: canonical_id(&ns_account)?,
        owner: canonical_id(&owner)?,
        label: ns_label,
        current_key_version,
        wrapped_dek,
    }))
}

pub async fn namespace_has_permission(
    state: &AppState,
    namespace: &V2Namespace,
    principal: &str,
    write: bool,
) -> Result<bool, AppError> {
    if addresses_equal(&namespace.owner, principal) {
        return Ok(true);
    }
    let rpc = V2Rpc::from_state(state);
    namespace_has_permission_rpc(&rpc, namespace, principal, write).await
}

pub async fn namespace_has_permission_rpc(
    rpc: &V2Rpc,
    namespace: &V2Namespace,
    principal: &str,
    write: bool,
) -> Result<bool, AppError> {
    if addresses_equal(&namespace.owner, principal) {
        return Ok(true);
    }
    let object = get_object_json(rpc, &namespace.object_id).await?;
    let json = object_move_json(&object)?;
    let table_id = match table_uid(json, "permissions") {
        Some(id) => id,
        None => return Ok(false),
    };
    let principal_bytes = parse_object_id32(principal)?;
    let Some(bits) = lookup_table_u8(rpc, &table_id, principal_bytes).await? else {
        return Ok(false);
    };
    let need = if write {
        PERMISSION_READ | PERMISSION_WRITE
    } else {
        PERMISSION_READ
    };
    Ok(bits & need == need)
}

pub async fn fetch_wrapped_dek(
    rpc: &V2Rpc,
    namespace_id: &str,
    key_version: u64,
    package_id: &str,
) -> Result<Vec<u8>, AppError> {
    let object = get_object_json(rpc, namespace_id).await?;
    ensure_type(
        object
            .get("object_type")
            .and_then(Value::as_str)
            .or_else(|| object.pointer("/type").and_then(Value::as_str)),
        package_id,
        "namespace",
        "MemoryNamespace",
        namespace_id,
    )?;
    let json = object_move_json(&object)?;
    let kv_table = table_uid(json, "key_versions").ok_or_else(|| {
        AppError::Internal("V2 MemoryNamespace is missing key_versions table".into())
    })?;
    lookup_wrapped_dek(rpc, &kv_table, key_version)
        .await?
        .ok_or_else(|| AppError::Internal("V2 wrapped DEK not found".into()))
}

pub async fn gate_v2_label(
    state: &AppState,
    auth: &AuthInfo,
    label: &str,
) -> Result<Option<V2Namespace>, AppError> {
    let Some(ns) = resolve_live_v2_namespace(state, &auth.account_id, label).await? else {
        return Ok(None);
    };
    if !state.config.memwal_v2_writes_enabled {
        return Err(v2_writes_disabled());
    }
    Ok(Some(ns))
}

pub async fn authorize_v2_write(
    state: &AppState,
    auth: &AuthInfo,
    namespace: &V2Namespace,
) -> Result<String, AppError> {
    let principal = sui_address_from_ed25519_pubkey_hex(&auth.public_key)?;
    if !namespace_has_permission(state, namespace, &principal, true).await? {
        return Err(AppError::Forbidden(
            "HTTP principal cannot write this V2 namespace".into(),
        ));
    }
    if state.config.memwal_v2_writer_addresses.is_empty() {
        return Err(AppError::Forbidden(
            "MEMWAL_V2_WRITER_ADDRESSES is empty".into(),
        ));
    }
    for writer in &state.config.memwal_v2_writer_addresses {
        if namespace_has_permission(state, namespace, writer, true).await? {
            return Ok(writer.clone());
        }
    }
    Err(AppError::Forbidden(
        "no writer-pool address has WRITE on this V2 namespace".into(),
    ))
}

enum TableKey {
    Bytes32([u8; 32]),
    U64(u64),
}

fn table_name_bytes(key: &TableKey) -> Vec<u8> {
    match key {
        TableKey::Bytes32(bytes) => {
            let mut out = uleb128(32);
            out.extend_from_slice(bytes);
            out
        }
        TableKey::U64(v) => v.to_le_bytes().to_vec(),
    }
}

fn name_matches(name_bcs: &[u8], key: &TableKey) -> bool {
    match key {
        TableKey::Bytes32(bytes) => {
            name_bcs == bytes.as_slice() || {
                let mut encoded = uleb128(32);
                encoded.extend_from_slice(bytes);
                name_bcs == encoded.as_slice()
            }
        }
        TableKey::U64(v) => name_bcs == v.to_le_bytes().as_slice(),
    }
}

async fn lookup_table_id_value(
    rpc: &V2Rpc,
    table_id: &str,
    key: TableKey,
) -> Result<Option<String>, AppError> {
    if let Some(grpc) = rpc.sui_grpc_client.clone() {
        if let Some(id) = list_table_id_grpc(grpc, table_id, &key).await? {
            return Ok(Some(id));
        }
        return Ok(None);
    }
    lookup_dynamic_field_json_rpc(
        rpc,
        table_id,
        match &key {
            TableKey::Bytes32(bytes) => (
                "vector<u8>",
                Value::Array(bytes.iter().map(|b| Value::from(*b)).collect()),
            ),
            TableKey::U64(v) => ("u64", Value::String(v.to_string())),
        },
    )
    .await
}

async fn lookup_wrapped_dek(
    rpc: &V2Rpc,
    table_id: &str,
    key_version: u64,
) -> Result<Option<Vec<u8>>, AppError> {
    if let Some(grpc) = rpc.sui_grpc_client.clone() {
        return list_wrapped_dek_grpc(grpc, table_id, key_version).await;
    }
    let value = lookup_dynamic_field_json_rpc(
        rpc,
        table_id,
        ("u64", Value::String(key_version.to_string())),
    )
    .await?;
    Ok(value.and_then(|v| decode_wrapped_dek_from_value(&serde_json::json!({ "value": v }))))
}

async fn lookup_table_u8(
    rpc: &V2Rpc,
    table_id: &str,
    principal: [u8; 32],
) -> Result<Option<u8>, AppError> {
    if let Some(grpc) = rpc.sui_grpc_client.clone() {
        return list_table_u8_grpc(grpc, table_id, principal).await;
    }
    let hex = format!("0x{}", hex::encode(principal));
    let value =
        lookup_dynamic_field_json_rpc(rpc, table_id, ("address", Value::String(hex))).await?;
    Ok(value.and_then(|s| s.parse().ok()))
}

async fn list_table_id_grpc(
    mut client: sui_rpc::Client,
    table_id: &str,
    key: &TableKey,
) -> Result<Option<String>, AppError> {
    let want = table_name_bytes(key);
    let mut page_token: Option<Vec<u8>> = None;
    loop {
        let mut request = ListDynamicFieldsRequest::default();
        request.parent = Some(table_id.to_string());
        request.page_size = Some(50);
        request.page_token = page_token.clone().map(Into::into);
        request.read_mask = Some(prost_types::FieldMask {
            paths: vec![
                "name".into(),
                "value".into(),
                "field_object.json".into(),
            ],
        });
        let response = client
            .state_client()
            .list_dynamic_fields(request)
            .await
            .map_err(|e| AppError::Internal(format!("ListDynamicFields failed: {e}")))?
            .into_inner();
        for field in response.dynamic_fields {
            let Some(name) = field.name.as_ref().and_then(|b| b.value.as_ref()) else {
                continue;
            };
            if !name_matches(name.as_ref(), key) && name.as_ref() != want.as_slice() {
                continue;
            }
            if let Some(id) = field
                .value
                .as_ref()
                .and_then(|b| b.value.as_ref())
                .and_then(|bytes| id_from_bcs(bytes.as_ref()))
            {
                return Ok(Some(id));
            }
            if let Some(json) = field.field_object.as_ref().and_then(|o| o.json.as_ref()) {
                if let Some(id) = id_from_json_value(json) {
                    return Ok(Some(id));
                }
            }
        }
        match response.next_page_token {
            Some(token) if !token.is_empty() => page_token = Some(token.to_vec()),
            _ => break,
        }
    }
    Ok(None)
}

async fn list_wrapped_dek_grpc(
    mut client: sui_rpc::Client,
    table_id: &str,
    key_version: u64,
) -> Result<Option<Vec<u8>>, AppError> {
    let key = TableKey::U64(key_version);
    let mut page_token: Option<Vec<u8>> = None;
    loop {
        let mut request = ListDynamicFieldsRequest::default();
        request.parent = Some(table_id.to_string());
        request.page_size = Some(50);
        request.page_token = page_token.clone().map(Into::into);
        request.read_mask = Some(prost_types::FieldMask {
            paths: vec!["name".into(), "field_object.json".into()],
        });
        let response = client
            .state_client()
            .list_dynamic_fields(request)
            .await
            .map_err(|e| AppError::Internal(format!("ListDynamicFields failed: {e}")))?
            .into_inner();
        for field in response.dynamic_fields {
            let Some(name) = field.name.as_ref().and_then(|b| b.value.as_ref()) else {
                continue;
            };
            if !name_matches(name.as_ref(), &key) {
                continue;
            }
            if let Some(json) = field.field_object.as_ref().and_then(|o| o.json.as_ref()) {
                if let Some(dek) = decode_wrapped_dek_from_prost(json) {
                    return Ok(Some(dek));
                }
            }
        }
        match response.next_page_token {
            Some(token) if !token.is_empty() => page_token = Some(token.to_vec()),
            _ => break,
        }
    }
    Ok(None)
}

async fn list_table_u8_grpc(
    mut client: sui_rpc::Client,
    table_id: &str,
    principal: [u8; 32],
) -> Result<Option<u8>, AppError> {
    let key = TableKey::Bytes32(principal);
    let mut page_token: Option<Vec<u8>> = None;
    loop {
        let mut request = ListDynamicFieldsRequest::default();
        request.parent = Some(table_id.to_string());
        request.page_size = Some(50);
        request.page_token = page_token.clone().map(Into::into);
        request.read_mask = Some(prost_types::FieldMask {
            paths: vec!["name".into(), "value".into(), "field_object.json".into()],
        });
        let response = client
            .state_client()
            .list_dynamic_fields(request)
            .await
            .map_err(|e| AppError::Internal(format!("ListDynamicFields failed: {e}")))?
            .into_inner();
        for field in response.dynamic_fields {
            let Some(name) = field.name.as_ref().and_then(|b| b.value.as_ref()) else {
                continue;
            };
            if !name_matches(name.as_ref(), &key) {
                continue;
            }
            if let Some(value) = field.value.as_ref().and_then(|b| b.value.as_ref()) {
                if let Some(first) = value.as_ref().first() {
                    return Ok(Some(*first));
                }
            }
            if let Some(json) = field.field_object.as_ref().and_then(|o| o.json.as_ref()) {
                if let Some(n) = json_u8_from_prost(json) {
                    return Ok(Some(n));
                }
            }
        }
        match response.next_page_token {
            Some(token) if !token.is_empty() => page_token = Some(token.to_vec()),
            _ => break,
        }
    }
    Ok(None)
}

async fn get_object_json(rpc: &V2Rpc, object_id: &str) -> Result<Value, AppError> {
    if let Some(grpc) = rpc.sui_grpc_client.clone() {
        return get_object_json_grpc(grpc, object_id).await;
    }
    get_object_json_rpc(&rpc.http_client, &rpc.sui_rpc_url, object_id).await
}

async fn get_object_json_grpc(
    mut client: sui_rpc::Client,
    object_id: &str,
) -> Result<Value, AppError> {
    let address: Address = object_id
        .parse()
        .map_err(|e| AppError::Internal(format!("invalid object id: {e}")))?;
    let mut request = GetObjectRequest::new(&address);
    request.read_mask = Some(prost_types::FieldMask {
        paths: vec!["json".into(), "object_type".into()],
    });
    let object = client
        .ledger_client()
        .get_object(request)
        .await
        .map_err(|e| AppError::Internal(format!("gRPC GetObject failed: {e}")))?
        .into_inner()
        .object
        .ok_or_else(|| AppError::Internal("gRPC GetObject missing object".into()))?;
    let mut map = serde_json::Map::new();
    if let Some(ty) = object.object_type.clone() {
        map.insert("object_type".into(), Value::String(ty.clone()));
        map.insert("type".into(), Value::String(ty));
    }
    if let Some(json) = object.json {
        map.insert("json".into(), prost_to_json(&json));
    }
    Ok(Value::Object(map))
}

async fn get_object_json_rpc(
    http: &reqwest::Client,
    rpc_url: &str,
    object_id: &str,
) -> Result<Value, AppError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sui_getObject",
        "params": [object_id, { "showContent": true, "showType": true }]
    });
    let resp: Value = http
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("sui_getObject failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("sui_getObject parse failed: {e}")))?;
    Ok(resp)
}

async fn lookup_dynamic_field_json_rpc(
    rpc: &V2Rpc,
    parent: &str,
    name: (&str, Value),
) -> Result<Option<String>, AppError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "suix_getDynamicFieldObject",
        "params": [parent, { "type": name.0, "value": name.1 }]
    });
    let resp: Value = rpc
        .http_client
        .post(&rpc.sui_rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("suix_getDynamicFieldObject failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("suix_getDynamicFieldObject parse failed: {e}")))?;
    if resp.get("error").is_some() {
        return Ok(None);
    }
    if let Some(id) = resp
        .pointer("/result/data/content/fields/value")
        .and_then(Value::as_str)
    {
        return Ok(Some(id.to_string()));
    }
    Ok(None)
}

fn object_move_json(object: &Value) -> Result<&Value, AppError> {
    object
        .get("json")
        .or_else(|| object.pointer("/result/data/content/fields"))
        .or_else(|| object.get("fields"))
        .ok_or_else(|| AppError::Internal("object has no Move json".into()))
}

fn table_uid(json: &Value, field: &str) -> Option<String> {
    let table = json.get(field)?;
    table
        .pointer("/id/id")
        .and_then(Value::as_str)
        .or_else(|| table.pointer("/id").and_then(Value::as_str))
        .or_else(|| table.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn json_address(json: &Value, field: &str) -> Option<String> {
    json.get(field).and_then(|v| {
        v.as_str()
            .map(ToOwned::to_owned)
            .or_else(|| v.get("id").and_then(Value::as_str).map(ToOwned::to_owned))
            .or_else(|| {
                v.pointer("/id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
    })
}

fn json_u64(json: &Value, field: &str) -> Option<u64> {
    json.get(field).and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    })
}

fn ensure_type(
    actual: Option<&str>,
    package_id: &str,
    module: &str,
    name: &str,
    object_id: &str,
) -> Result<(), AppError> {
    let Some(actual) = actual else {
        return Err(AppError::Internal(format!(
            "object {object_id} has no type"
        )));
    };
    let parts: Vec<&str> = actual.split("::").collect();
    if parts.len() != 3 {
        return Err(AppError::Internal(format!(
            "object {object_id} has unexpected type {actual}"
        )));
    }
    let expected_pkg = canonical_id(package_id)?;
    let actual_pkg = canonical_id(parts[0]).unwrap_or_else(|_| parts[0].to_string());
    if actual_pkg != expected_pkg || parts[1] != module || parts[2] != name {
        return Err(AppError::Internal(format!(
            "object {object_id} has type {actual}, expected {expected_pkg}::{module}::{name}"
        )));
    }
    Ok(())
}

fn canonical_id(id: &str) -> Result<String, AppError> {
    id.parse::<Address>()
        .map(|a| a.to_string())
        .map_err(|_| AppError::Internal(format!("invalid id {id}")))
}

fn addresses_equal(a: &str, b: &str) -> bool {
    match (a.parse::<Address>(), b.parse::<Address>()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.eq_ignore_ascii_case(b),
    }
}

fn id_from_bcs(bytes: &[u8]) -> Option<String> {
    if bytes.len() == 32 {
        return Some(format!("0x{}", hex::encode(bytes)));
    }
    None
}

fn id_from_json_value(json: &prost_types::Value) -> Option<String> {
    match &json.kind {
        Some(prost_types::value::Kind::StringValue(s)) => Some(s.clone()),
        Some(prost_types::value::Kind::StructValue(s)) => s
            .fields
            .get("value")
            .and_then(|v| match &v.kind {
                Some(prost_types::value::Kind::StringValue(s)) => Some(s.clone()),
                _ => None,
            })
            .or_else(|| {
                s.fields.get("id").and_then(|v| match &v.kind {
                    Some(prost_types::value::Kind::StringValue(s)) => Some(s.clone()),
                    _ => None,
                })
            }),
        _ => None,
    }
}

fn decode_wrapped_dek_from_prost(json: &prost_types::Value) -> Option<Vec<u8>> {
    let s = match &json.kind {
        Some(prost_types::value::Kind::StructValue(s)) => s,
        _ => return None,
    };
    let value = s.fields.get("value").unwrap_or(json);
    let inner = match &value.kind {
        Some(prost_types::value::Kind::StructValue(s)) => s,
        _ => s,
    };
    let dek = inner.fields.get("wrapped_dek")?;
    bytes_from_prost(dek)
}

fn decode_wrapped_dek_from_value(json: &Value) -> Option<Vec<u8>> {
    json.pointer("/value/wrapped_dek")
        .or_else(|| json.get("wrapped_dek"))
        .and_then(bytes_from_json)
}

fn bytes_from_json(v: &Value) -> Option<Vec<u8>> {
    if let Some(s) = v.as_str() {
        return base64::engine::general_purpose::STANDARD
            .decode(s)
            .ok()
            .or_else(|| hex::decode(s.trim_start_matches("0x")).ok());
    }
    v.as_array().map(|arr| {
        arr.iter()
            .filter_map(|n| n.as_u64().map(|b| b as u8))
            .collect()
    })
}

fn bytes_from_prost(v: &prost_types::Value) -> Option<Vec<u8>> {
    match &v.kind {
        Some(prost_types::value::Kind::StringValue(s)) => base64::engine::general_purpose::STANDARD
            .decode(s)
            .ok()
            .or_else(|| hex::decode(s.trim_start_matches("0x")).ok()),
        Some(prost_types::value::Kind::ListValue(list)) => Some(
            list.values
                .iter()
                .filter_map(|n| match &n.kind {
                    Some(prost_types::value::Kind::NumberValue(n)) => Some(*n as u8),
                    Some(prost_types::value::Kind::StringValue(s)) => s.parse().ok(),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

fn json_u8_from_prost(json: &prost_types::Value) -> Option<u8> {
    let s = match &json.kind {
        Some(prost_types::value::Kind::StructValue(s)) => s,
        _ => return None,
    };
    let value = s.fields.get("value")?;
    match &value.kind {
        Some(prost_types::value::Kind::NumberValue(n)) => Some(*n as u8),
        Some(prost_types::value::Kind::StringValue(s)) => s.parse().ok(),
        _ => None,
    }
}

fn prost_to_json(v: &prost_types::Value) -> Value {
    match &v.kind {
        Some(prost_types::value::Kind::NullValue(_)) | None => Value::Null,
        Some(prost_types::value::Kind::NumberValue(n)) => {
            serde_json::Number::from_f64(*n)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }
        Some(prost_types::value::Kind::StringValue(s)) => Value::String(s.clone()),
        Some(prost_types::value::Kind::BoolValue(b)) => Value::Bool(*b),
        Some(prost_types::value::Kind::StructValue(s)) => Value::Object(
            s.fields
                .iter()
                .map(|(k, v)| (k.clone(), prost_to_json(v)))
                .collect(),
        ),
        Some(prost_types::value::Kind::ListValue(l)) => {
            Value::Array(l.values.iter().map(prost_to_json).collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        blake2b256, decode_walrus_blob_id_le, namespace_registry_key, namespace_seal_id_suffix,
        write_commitment_v1,
    };

    #[test]
    fn seal_suffix_is_40_bytes_little_endian() {
        let ns = format!("0x{}", "00".repeat(30) + "cafe");
        let suffix = namespace_seal_id_suffix(&ns, 1).unwrap();
        assert_eq!(suffix.len(), 40);
        assert_eq!(&suffix[32..], &[1, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&suffix[30..32], &[0xca, 0xfe]);
    }

    #[test]
    fn namespace_key_hashes_account_and_label() {
        let account = format!("0x{}", "ab".repeat(32));
        let a = namespace_registry_key(&account, "e2e-testnet").unwrap();
        let b = namespace_registry_key(&account, "other").unwrap();
        assert_ne!(a, b);
        assert_eq!(a, namespace_registry_key(&account, "e2e-testnet").unwrap());
    }

    #[test]
    fn d1_commitment_is_32_bytes_and_stable() {
        let ns = format!("0x{}", "11".repeat(32));
        let blob = decode_walrus_blob_id_le("xdmLE4twdasDCZaDCp8c2xqdf_B9q-05Q3928gvifJk").unwrap();
        assert_eq!(blob.len(), 32);
        let envelope = b"MEMWALV2-test";
        let c1 = write_commitment_v1(&ns, 0, "xdmLE4twdasDCZaDCp8c2xqdf_B9q-05Q3928gvifJk", None, envelope)
            .unwrap();
        let c2 = write_commitment_v1(&ns, 0, "xdmLE4twdasDCZaDCp8c2xqdf_B9q-05Q3928gvifJk", None, envelope)
            .unwrap();
        assert_eq!(c1, c2);
        assert_eq!(c1.len(), 32);
        let c3 = write_commitment_v1(
            &ns,
            0,
            "xdmLE4twdasDCZaDCp8c2xqdf_B9q-05Q3928gvifJk",
            Some(&format!("0x{}", "22".repeat(32))),
            envelope,
        )
        .unwrap();
        assert_ne!(c1, c3);
        assert_eq!(blake2b256(envelope).len(), 32);
    }
}
