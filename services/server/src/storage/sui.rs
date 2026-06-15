use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct OnchainAccountForMigration {
    pub active: bool,
    pub delegate_keys: Vec<OnchainDelegateKey>,
}

#[derive(Debug, Clone)]
pub struct OnchainDelegateKey {
    pub public_key_hex: String,
    pub label: String,
    pub perms: u8,
    pub created_at: u64,
}

/// Verify that a given public key is registered as a delegate key
/// in the onchain MemWalAccount object.
///
/// Uses Sui JSON-RPC `sui_getObject` to fetch the object and parse
/// its fields — no full `sui-sdk` dependency needed.
///
/// Returns `Ok(owner_address)` if the key is found, `Err` otherwise.
pub async fn verify_delegate_key_onchain(
    http_client: &reqwest::Client,
    rpc_url: &str,
    account_object_id: &str,
    public_key_bytes: &[u8],
) -> Result<String, OnchainVerifyError> {
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
    let active = fields
        .get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(true); // default to true for backward compat with old contract versions
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

/// Fetch the legacy Account object fields needed to mirror authentication into
/// the P2 account. Older V1 accounts did not carry `perms`; those delegates are
/// imported as READ|WRITE (3), matching the pre-P2 delegate behavior.
pub async fn fetch_account_for_migration(
    http_client: &reqwest::Client,
    rpc_url: &str,
    account_object_id: &str,
) -> Result<OnchainAccountForMigration, OnchainVerifyError> {
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
            "sui_getObject_migration_account",
            "transport_error",
            started.elapsed(),
        );
        OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e))
    })?;
    let status_label = response.status().as_u16().to_string();
    crate::observability::observe_external(
        "sui_rpc",
        "sui_getObject_migration_account",
        &status_label,
        started.elapsed(),
    );

    let rpc_response: RpcResponse =
        parse_json_rpc_response(response, "sui_getObject migration account").await?;

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
    let fields = content
        .fields
        .ok_or_else(|| OnchainVerifyError::RpcError("Object has no fields".into()))?;

    let active = fields
        .get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let delegate_values = fields
        .get("delegate_keys")
        .and_then(|v| v.as_array())
        .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'delegate_keys' field".into()))?;

    let mut delegate_keys = Vec::with_capacity(delegate_values.len());
    for dk in delegate_values {
        let Some(dk_fields) = dk.get("fields").or(Some(dk)) else {
            continue;
        };
        let Some(public_key) = dk_fields.get("public_key").and_then(json_u8_vector) else {
            tracing::warn!(
                account_id = %account_object_id,
                "skipping malformed legacy delegate key without public_key"
            );
            continue;
        };
        if public_key.len() != 32 {
            tracing::warn!(
                account_id = %account_object_id,
                len = public_key.len(),
                "skipping malformed legacy delegate key with invalid length"
            );
            continue;
        }

        let label = dk_fields
            .get("label")
            .and_then(json_string_from_value)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Migrated delegate".to_string());
        let created_at = dk_fields
            .get("created_at")
            .and_then(json_u64_from_value)
            .unwrap_or(0);
        let perms = dk_fields
            .get("perms")
            .and_then(json_u64_from_value)
            .and_then(|v| u8::try_from(v).ok())
            .unwrap_or(3);

        delegate_keys.push(OnchainDelegateKey {
            public_key_hex: hex::encode(public_key),
            label,
            perms,
            created_at,
        });
    }

    Ok(OnchainAccountForMigration {
        active,
        delegate_keys,
    })
}

/// Resolve an owner address to its OLD-contract account object id via the
/// registry's `accounts: Table<address, ID>` — a direct dynamic-field lookup
/// (no scan). Used by the account-mirror to recover the legacy account id for
/// owners missing from the relayer's `accounts` cache. Returns `Ok(None)` when
/// the owner has no on-chain account.
pub async fn fetch_account_id_by_owner(
    http_client: &reqwest::Client,
    rpc_url: &str,
    registry_id: &str,
    owner: &str,
) -> Result<Option<String>, OnchainVerifyError> {
    // Step 1: registry -> accounts Table inner object id.
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
            "sui_getObject_registry_owner",
            "transport_error",
            started.elapsed(),
        );
        OnchainVerifyError::RpcError(format!("Failed to fetch registry: {}", e))
    })?;
    let status_label = registry_resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sui_rpc",
        "sui_getObject_registry_owner",
        &status_label,
        started.elapsed(),
    );
    let registry_json: serde_json::Value =
        parse_json_rpc_response(registry_resp, "sui_getObject registry (owner)").await?;
    let table_id = registry_json
        .pointer("/result/data/content/fields/accounts/fields/id/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            OnchainVerifyError::RpcError("Failed to extract accounts table ID from registry".into())
        })?
        .to_string();

    // Step 2: direct dynamic-field lookup keyed by the owner address.
    let field_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "suix_getDynamicFieldObject",
        "params": [table_id, { "type": "address", "value": owner }]
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
            "suix_getDynamicFieldObject_owner",
            "transport_error",
            started.elapsed(),
        );
        OnchainVerifyError::RpcError(format!("Failed to fetch owner field: {}", e))
    })?;
    let status_label = field_resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sui_rpc",
        "suix_getDynamicFieldObject_owner",
        &status_label,
        started.elapsed(),
    );
    let field_json: serde_json::Value =
        parse_json_rpc_response(field_resp, "suix_getDynamicFieldObject owner").await?;

    // A missing owner yields an RPC error (dynamic field not found) or null data.
    if field_json.pointer("/error").is_some() {
        return Ok(None);
    }
    let account_id = field_json
        .pointer("/result/data/content/fields/value")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(account_id)
}

/// Scan the AccountRegistry to find which account holds a given delegate key.
///
/// Flow:
/// 1. Fetch the AccountRegistry object to get the Table's inner object ID
/// 2. Use `suix_getDynamicFields` on the Table's inner ID to enumerate accounts
/// 3. For each account, fetch it and check delegate_keys
///
/// Returns `Ok((account_object_id, owner))` if found.
pub async fn find_account_by_delegate_key(
    http_client: &reqwest::Client,
    rpc_url: &str,
    registry_id: &str,
    public_key_bytes: &[u8],
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

    loop {
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

            // Fetch the actual MemWalAccount to check delegate_keys
            match verify_delegate_key_onchain(http_client, rpc_url, account_id, public_key_bytes)
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

/// Fetch `MemoryNamespace.wrapped_deks[key_version]` from the Move `Table`.
///
/// Sui JSON-RPC exposes `Table<K,V>` entries as dynamic fields under the table
/// object's inner id. The namespace object only carries that table id, so this
/// scans dynamic fields for the requested u32 key and fetches the value object.
pub async fn fetch_namespace_wrapped_dek(
    http_client: &reqwest::Client,
    rpc_url: &str,
    namespace_id: &str,
    key_version: u32,
) -> Result<Option<Vec<u8>>, OnchainVerifyError> {
    let ns_body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sui_getObject",
        "params": [namespace_id, { "showContent": true }]
    });

    let request = http_client
        .post(rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&ns_body);
    let request = crate::observability::apply_request_id_header(request);
    let started = std::time::Instant::now();
    let ns_resp = request.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sui_rpc",
            "sui_getObject_namespace",
            "transport_error",
            started.elapsed(),
        );
        OnchainVerifyError::RpcError(format!("Failed to fetch namespace: {}", e))
    })?;
    let status_label = ns_resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "sui_rpc",
        "sui_getObject_namespace",
        &status_label,
        started.elapsed(),
    );

    let ns_json: serde_json::Value =
        parse_json_rpc_response(ns_resp, "sui_getObject namespace").await?;
    let table_id = ns_json
        .pointer("/result/data/content/fields/wrapped_deks/fields/id/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            OnchainVerifyError::RpcError(
                "Failed to extract wrapped_deks table ID from namespace".into(),
            )
        })?
        .to_string();

    let mut cursor: Option<String> = None;
    loop {
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
                "suix_getDynamicFields_wrapped_deks",
                "transport_error",
                started.elapsed(),
            );
            OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e))
        })?;
        let status_label = response.status().as_u16().to_string();
        crate::observability::observe_external(
            "sui_rpc",
            "suix_getDynamicFields_wrapped_deks",
            &status_label,
            started.elapsed(),
        );

        let resp_json: serde_json::Value =
            parse_json_rpc_response(response, "suix_getDynamicFields wrapped_deks").await?;
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

        for field_info in data {
            let Some(name) = field_info.get("name") else {
                continue;
            };
            if !json_u32_eq(name, key_version) {
                continue;
            }

            let field_obj_id = field_info
                .get("objectId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    OnchainVerifyError::RpcError("Missing objectId in dynamic field".into())
                })?;
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
                    "sui_getObject_wrapped_dek_field",
                    "transport_error",
                    started.elapsed(),
                );
                OnchainVerifyError::RpcError(format!("Failed to fetch wrapped_dek field: {}", e))
            })?;
            let status_label = field_resp.status().as_u16().to_string();
            crate::observability::observe_external(
                "sui_rpc",
                "sui_getObject_wrapped_dek_field",
                &status_label,
                started.elapsed(),
            );

            let field_json: serde_json::Value =
                parse_json_rpc_response(field_resp, "sui_getObject wrapped_dek field").await?;
            let value = field_json
                .pointer("/result/data/content/fields/value")
                .ok_or_else(|| {
                    OnchainVerifyError::RpcError("Missing value in wrapped_dek field".into())
                })?;
            return json_u8_vector(value)
                .map(Some)
                .ok_or_else(|| OnchainVerifyError::RpcError("Malformed wrapped_dek value".into()));
        }

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

    Ok(None)
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

fn json_u32_eq(value: &serde_json::Value, expected: u32) -> bool {
    let Some(found) = json_u64_from_value(value) else {
        return false;
    };
    found == u64::from(expected)
}

fn json_u64_from_value(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.parse::<u64>().ok(),
        serde_json::Value::Object(map) => map.get("value").and_then(json_u64_from_value),
        _ => None,
    }
}

fn json_u8_vector(value: &serde_json::Value) -> Option<Vec<u8>> {
    let arr = match value {
        serde_json::Value::Array(arr) => arr,
        serde_json::Value::Object(map) => map.get("value")?.as_array()?,
        _ => return None,
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let n = json_u64_from_value(item)?;
        let byte = u8::try_from(n).ok()?;
        out.push(byte);
    }
    Some(out)
}

fn json_string_from_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => map
            .get("value")
            .and_then(json_string_from_value)
            .or_else(|| map.get("fields").and_then(json_string_from_value)),
        _ => None,
    }
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
}

impl std::fmt::Display for OnchainVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OnchainVerifyError::RpcError(msg) => write!(f, "Sui RPC error: {}", msg),
            OnchainVerifyError::KeyNotFound(msg) => write!(f, "Key not found: {}", msg),
            OnchainVerifyError::AccountDeactivated(msg) => {
                write!(f, "Account deactivated: {}", msg)
            }
        }
    }
}

impl std::error::Error for OnchainVerifyError {}

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
    }

    // ── Deactivated account field parsing ────────────────────────

    #[test]
    fn test_active_field_parsed_correctly() {
        // Simulate the JSON field extraction the code does:
        // fields.get("active").and_then(|v| v.as_bool()).unwrap_or(true)

        // active: true → account is active
        let fields_active: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"active": true, "owner": "0xabc"}"#).unwrap();
        let active = fields_active
            .get("active")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        assert!(active);

        // active: false → account is deactivated
        let fields_inactive: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"active": false, "owner": "0xabc"}"#).unwrap();
        let inactive = fields_inactive
            .get("active")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        assert!(!inactive);

        // active field missing → defaults to true (backward compat)
        let fields_missing: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"owner": "0xabc"}"#).unwrap();
        let missing = fields_missing
            .get("active")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        assert!(missing, "missing 'active' field should default to true");

        // active field is a string (malformed) → defaults to true
        let fields_string: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"active": "false", "owner": "0xabc"}"#).unwrap();
        let string_val = fields_string
            .get("active")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        assert!(
            string_val,
            "string 'false' should not be treated as bool false"
        );
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
}
