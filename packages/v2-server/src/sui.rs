use serde::Deserialize;

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

    let response = http_client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e)))?;

    let rpc_response: RpcResponse = response
        .json()
        .await
        .map_err(|e| OnchainVerifyError::RpcError(format!("Failed to parse RPC response: {}", e)))?;

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
        let dk_fields = dk
            .get("fields")
            .or(Some(dk)); // fallback if no "fields" wrapper

        if let Some(stored_key) = dk_fields.and_then(|f| f.get("public_key")) {
            // Compare as arrays of numbers
            if let Some(stored_arr) = stored_key.as_array() {
                if *stored_arr == pk_as_numbers {
                    tracing::info!(
                        "delegate key verified onchain, owner: {}",
                        owner
                    );
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

    let registry_resp = http_client
        .post(rpc_url)
        .json(&registry_body)
        .send()
        .await
        .map_err(|e| OnchainVerifyError::RpcError(format!("Failed to fetch registry: {}", e)))?;

    let registry_json: serde_json::Value = registry_resp.json().await.map_err(|e| {
        OnchainVerifyError::RpcError(format!("Failed to parse registry response: {}", e))
    })?;

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

        let response = http_client
            .post(rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| OnchainVerifyError::RpcError(format!("HTTP request failed: {}", e)))?;

        let resp_json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| OnchainVerifyError::RpcError(format!("Failed to parse response: {}", e)))?;

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

            let field_resp = http_client
                .post(rpc_url)
                .json(&field_body)
                .send()
                .await
                .map_err(|e| {
                    OnchainVerifyError::RpcError(format!("Failed to fetch field: {}", e))
                })?;

            let field_json: serde_json::Value = field_resp.json().await.map_err(|e| {
                OnchainVerifyError::RpcError(format!("Failed to parse field response: {}", e))
            })?;

            // Extract the account ID from the dynamic field value
            let account_id = field_json
                .pointer("/result/data/content/fields/value")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            if account_id.is_empty() {
                continue;
            }

            // Fetch the actual MemWalAccount to check delegate_keys
            match verify_delegate_key_onchain(
                http_client,
                rpc_url,
                account_id,
                public_key_bytes,
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
}

impl std::fmt::Display for OnchainVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OnchainVerifyError::RpcError(msg) => write!(f, "Sui RPC error: {}", msg),
            OnchainVerifyError::KeyNotFound(msg) => write!(f, "Key not found: {}", msg),
        }
    }
}

impl std::error::Error for OnchainVerifyError {}
