use crate::types::{AppError, SidecarError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainTxResponse {
    pub digest: String,
    pub account_id: Option<String>,
    pub namespace_id: Option<String>,
}

async fn post_chain_route<T: serde::Serialize>(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    route: &str,
    body: &T,
) -> Result<ChainTxResponse, AppError> {
    let url = format!("{}/{}", sidecar_url, route.trim_start_matches('/'));
    let mut req = client.post(&url).json(body);
    if let Some(secret) = sidecar_secret {
        req = req.header("authorization", format!("Bearer {}", secret));
    }
    let req = crate::observability::apply_request_id_header(req);
    let started = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sidecar",
            "chain_route",
            "transport_error",
            started.elapsed(),
        );
        crate::observability::record_sidecar_failure("chain_route", "transport_error");
        AppError::Internal(format!("Sidecar {route} request failed: {e}"))
    })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external("sidecar", "chain_route", &status_label, started.elapsed());

    if !resp.status().is_success() {
        crate::observability::record_sidecar_failure("chain_route", "http_error");
        let body = resp.text().await.unwrap_or_default();
        if let Ok(err) = serde_json::from_str::<SidecarError>(&body) {
            return Err(AppError::Internal(format!("{route} failed: {}", err.error)));
        }
        return Err(AppError::Internal(format!("{route} failed: {body}")));
    }

    resp.json()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to parse {route} response: {e}")))
}

#[allow(clippy::too_many_arguments)]
pub async fn admin_import_account(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    key_index: usize,
    package_id: &str,
    migration_cap_id: &str,
    account_registry_id: &str,
    namespace_registry_id: &str,
    owner: &str,
    legacy_account_id: &str,
    namespace_name: &str,
    created_at: u64,
    active: bool,
) -> Result<ChainTxResponse, AppError> {
    let body = serde_json::json!({
        "keyIndex": key_index,
        "packageId": package_id,
        "migrationCapId": migration_cap_id,
        "accountRegistryId": account_registry_id,
        "namespaceRegistryId": namespace_registry_id,
        "owner": owner,
        "legacyAccountId": legacy_account_id,
        "namespaceName": namespace_name,
        "createdAt": created_at,
        "active": active,
    });
    post_chain_route(
        client,
        sidecar_url,
        sidecar_secret,
        "/chain/admin-import-account",
        &body,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn admin_create_namespace(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    key_index: usize,
    package_id: &str,
    migration_cap_id: &str,
    namespace_registry_id: &str,
    owner: &str,
    namespace_name: &str,
    created_at: u64,
) -> Result<ChainTxResponse, AppError> {
    let body = serde_json::json!({
        "keyIndex": key_index,
        "packageId": package_id,
        "migrationCapId": migration_cap_id,
        "namespaceRegistryId": namespace_registry_id,
        "owner": owner,
        "namespaceName": namespace_name,
        "createdAt": created_at,
    });
    post_chain_route(
        client,
        sidecar_url,
        sidecar_secret,
        "/chain/admin-create-namespace",
        &body,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn admin_add_delegate_key(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    key_index: usize,
    package_id: &str,
    migration_cap_id: &str,
    account_id: &str,
    public_key_hex: &str,
    label: &str,
    perms: u8,
    created_at: u64,
) -> Result<ChainTxResponse, AppError> {
    let body = serde_json::json!({
        "keyIndex": key_index,
        "packageId": package_id,
        "migrationCapId": migration_cap_id,
        "accountId": account_id,
        "publicKeyHex": public_key_hex,
        "label": label,
        "perms": perms,
        "createdAt": created_at,
    });
    post_chain_route(
        client,
        sidecar_url,
        sidecar_secret,
        "/chain/admin-add-delegate-key",
        &body,
    )
    .await
}

/// Add every delegate key in `delegates` to `account_id` in a SINGLE transaction
/// (one PTB with N `admin_add_delegate_key` move calls). Keeps the account-mirror
/// to 2 txns/owner regardless of delegate count (the cap is 20), instead of
/// 1 + N txns — which made high-delegate owners time out the HTTP gateway.
/// Caller must ensure `delegates` is non-empty.
#[allow(clippy::too_many_arguments)]
pub async fn admin_add_delegate_keys(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    key_index: usize,
    package_id: &str,
    migration_cap_id: &str,
    account_id: &str,
    delegates: &[crate::storage::sui::OnchainDelegateKey],
) -> Result<ChainTxResponse, AppError> {
    let delegates_json: Vec<serde_json::Value> = delegates
        .iter()
        .map(|d| {
            serde_json::json!({
                "publicKeyHex": d.public_key_hex,
                "label": d.label,
                "perms": d.perms,
                "createdAt": d.created_at,
            })
        })
        .collect();
    let body = serde_json::json!({
        "keyIndex": key_index,
        "packageId": package_id,
        "migrationCapId": migration_cap_id,
        "accountId": account_id,
        "delegates": delegates_json,
    });
    post_chain_route(
        client,
        sidecar_url,
        sidecar_secret,
        "/chain/admin-add-delegate-keys",
        &body,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn admin_set_wrapped_dek(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    key_index: usize,
    package_id: &str,
    migration_cap_id: &str,
    namespace_id: &str,
    key_version: u32,
    wrapped_dek: &[u8],
) -> Result<ChainTxResponse, AppError> {
    let body = serde_json::json!({
        "keyIndex": key_index,
        "packageId": package_id,
        "migrationCapId": migration_cap_id,
        "namespaceId": namespace_id,
        "keyVersion": key_version,
        "wrappedDekBase64": BASE64.encode(wrapped_dek),
    });
    post_chain_route(
        client,
        sidecar_url,
        sidecar_secret,
        "/chain/admin-set-wrapped-dek",
        &body,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn admin_record_memory(
    client: &reqwest::Client,
    sidecar_url: &str,
    sidecar_secret: Option<&str>,
    key_index: usize,
    package_id: &str,
    migration_cap_id: &str,
    namespace_id: &str,
    blob_id: &str,
    key_version: u32,
    storage_end_epoch: u32,
) -> Result<ChainTxResponse, AppError> {
    let body = serde_json::json!({
        "keyIndex": key_index,
        "packageId": package_id,
        "migrationCapId": migration_cap_id,
        "namespaceId": namespace_id,
        "blobId": blob_id,
        "keyVersion": key_version,
        "storageEndEpoch": storage_end_epoch,
    });
    post_chain_route(
        client,
        sidecar_url,
        sidecar_secret,
        "/chain/admin-record-memory",
        &body,
    )
    .await
}
