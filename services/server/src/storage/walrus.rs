use crate::types::{AppError, Config, WalrusUploadBackend};
use futures::stream::{FuturesUnordered, StreamExt};
use jsonwebtoken::{encode, EncodingKey, Header};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const WALRUS_PUBLISHER_TIMEOUT: Duration = Duration::from_secs(180);
const WALRUS_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15);

/// Result of a Walrus blob upload
pub struct UploadResult {
    /// Walrus content-addressed blob ID (base64url)
    pub blob_id: String,
    /// Sui object ID of the Blob object (hex, e.g. "0x...")
    #[allow(dead_code)]
    pub object_id: Option<String>,
}

#[derive(Debug)]
pub enum UploadBlobError {
    App(AppError),
}

impl std::fmt::Display for UploadBlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UploadBlobError::App(err) => write!(f, "{}", err),
        }
    }
}

impl std::error::Error for UploadBlobError {}

impl From<AppError> for UploadBlobError {
    fn from(err: AppError) -> Self {
        UploadBlobError::App(err)
    }
}

impl From<UploadBlobError> for AppError {
    fn from(err: UploadBlobError) -> Self {
        match err {
            UploadBlobError::App(err) => err,
        }
    }
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
    /// Walrus Memory package ID from on-chain metadata
    #[serde(rename = "packageId", default)]
    pub package_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublisherStoreResponse {
    newly_created: Option<PublisherNewlyCreated>,
    already_certified: Option<PublisherAlreadyCertified>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublisherNewlyCreated {
    blob_object: PublisherBlobObject,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublisherBlobObject {
    id: String,
    blob_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublisherAlreadyCertified {
    blob_id: String,
}

#[derive(serde::Serialize)]
struct PublisherJwtClaims<'a> {
    iat: i64,
    exp: i64,
    jti: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    send_object_to: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memwal_owner: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memwal_namespace: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memwal_package_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memwal_agent_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_id: Option<&'a str>,
    epochs: u32,
    size: u64,
}

/// Upload an encrypted blob to Walrus using the backend selected in Config.
///
/// `WALRUS_UPLOAD_BACKEND=publisher` uses a self-hosted Walrus publisher over
/// HTTP. Deprecated legacy backend values are mapped to the publisher path.
#[allow(clippy::too_many_arguments)]
pub async fn upload_blob_for_config(
    client: &reqwest::Client,
    config: &Config,
    data: &[u8],
    epochs: u64,
    owner_address: &str,
    key_index: usize,
    namespace: &str,
    package_id: &str,
    agent_id: Option<&str>,
    job_id: Option<&str>,
) -> Result<UploadResult, UploadBlobError> {
    match config.walrus_upload_backend {
        WalrusUploadBackend::Publisher => {
            upload_blob_via_publisher(
                client,
                config,
                data,
                epochs,
                owner_address,
                key_index,
                namespace,
                package_id,
                agent_id,
                job_id,
            )
            .await
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn upload_blob_via_publisher(
    client: &reqwest::Client,
    config: &Config,
    data: &[u8],
    epochs: u64,
    owner_address: &str,
    key_index: usize,
    namespace: &str,
    package_id: &str,
    agent_id: Option<&str>,
    job_id: Option<&str>,
) -> Result<UploadResult, UploadBlobError> {
    let url = build_publisher_store_url(
        &config.walrus_publisher_url,
        epochs,
        config.walrus_publisher_deletable,
        config
            .walrus_publisher_send_object_to_owner
            .then_some(owner_address),
    )?;

    let mut req = client
        .put(url.clone())
        .header("content-type", "application/octet-stream")
        .body(data.to_vec());

    if let Some(secret) = config.walrus_publisher_jwt_secret.as_deref() {
        let token = mint_publisher_jwt(
            secret,
            config.walrus_publisher_jwt_expiry_secs,
            epochs,
            data.len() as u64,
            config
                .walrus_publisher_send_object_to_owner
                .then_some(owner_address),
            owner_address,
            namespace,
            package_id,
            agent_id,
            job_id,
        )?;
        req = req.bearer_auth(token);
    }

    let req = crate::observability::apply_request_id_header(req);
    let started = std::time::Instant::now();
    let resp = req
        .timeout(WALRUS_PUBLISHER_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            let status = if e.is_timeout() {
                "timeout"
            } else {
                "transport_error"
            };
            crate::observability::observe_external(
                "walrus_publisher",
                "store_blob",
                status,
                started.elapsed(),
            );
            UploadBlobError::App(AppError::Internal(format!(
                "Walrus publisher upload request failed: {}",
                e
            )))
        })?;

    let status = resp.status();
    let status_label = status.as_u16().to_string();
    crate::observability::observe_external(
        "walrus_publisher",
        "store_blob",
        &status_label,
        started.elapsed(),
    );

    let body = resp.text().await.map_err(|e| {
        crate::observability::observe_external(
            "walrus_publisher",
            "store_blob",
            "body_error",
            started.elapsed(),
        );
        UploadBlobError::App(AppError::Internal(format!(
            "Failed to read Walrus publisher upload response: {}",
            e
        )))
    })?;

    if !status.is_success() {
        return Err(UploadBlobError::App(AppError::Internal(format!(
            "Walrus publisher upload failed with status {}: {}",
            status, body
        ))));
    }

    let result = parse_publisher_upload_response(&body)?;

    tracing::info!(
        "walrus upload via publisher ok: blob_id={}, object_id={:?}, owner={}, ns={}, key={}, package={}, agent_id={:?}, job_id={:?}",
        result.blob_id,
        result.object_id,
        owner_address,
        namespace,
        key_index,
        package_id,
        agent_id,
        job_id
    );

    Ok(result)
}

fn build_publisher_store_url(
    publisher_url: &str,
    epochs: u64,
    deletable: bool,
    send_object_to: Option<&str>,
) -> Result<reqwest::Url, UploadBlobError> {
    let base = format!("{}/v1/blobs", publisher_url.trim_end_matches('/'));
    let mut url = reqwest::Url::parse(&base).map_err(|e| {
        UploadBlobError::App(AppError::Internal(format!(
            "Invalid Walrus publisher URL: {}",
            e
        )))
    })?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("epochs", &epochs.to_string());
        if deletable {
            query.append_pair("deletable", "true");
        } else {
            query.append_pair("permanent", "true");
        }
        if let Some(owner) = send_object_to {
            query.append_pair("send_object_to", owner);
        }
    }
    Ok(url)
}

fn mint_publisher_jwt(
    secret: &str,
    expiry_secs: u64,
    epochs: u64,
    size: u64,
    send_object_to: Option<&str>,
    memwal_owner: &str,
    memwal_namespace: &str,
    memwal_package_id: &str,
    memwal_agent_id: Option<&str>,
    job_id: Option<&str>,
) -> Result<String, UploadBlobError> {
    let epochs = u32::try_from(epochs).map_err(|_| {
        UploadBlobError::App(AppError::Internal(format!(
            "Walrus publisher JWT epochs value is too large: {}",
            epochs
        )))
    })?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| {
            UploadBlobError::App(AppError::Internal(format!(
                "System clock is before UNIX_EPOCH: {}",
                e
            )))
        })?
        .as_secs() as i64;
    let expiry_secs = i64::try_from(expiry_secs).map_err(|_| {
        UploadBlobError::App(AppError::Internal(format!(
            "Walrus publisher JWT expiry is too large: {}",
            expiry_secs
        )))
    })?;
    let claims = PublisherJwtClaims {
        iat: now,
        exp: now + expiry_secs,
        jti: Uuid::new_v4().to_string(),
        send_object_to,
        memwal_owner: Some(memwal_owner),
        memwal_namespace: Some(memwal_namespace),
        memwal_package_id: Some(memwal_package_id),
        memwal_agent_id,
        job_id,
        epochs,
        size,
    };
    let secret = publisher_jwt_secret_bytes(secret)?;
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(&secret),
    )
    .map_err(|e| {
        UploadBlobError::App(AppError::Internal(format!(
            "Failed to mint Walrus publisher JWT: {}",
            e
        )))
    })
}

fn publisher_jwt_secret_bytes(secret: &str) -> Result<Vec<u8>, UploadBlobError> {
    let trimmed = secret.trim();
    if let Some(hex_secret) = trimmed.strip_prefix("0x") {
        return hex::decode(hex_secret).map_err(|e| {
            UploadBlobError::App(AppError::Internal(format!(
                "Invalid WALRUS_PUBLISHER_JWT_SECRET hex value: {}",
                e
            )))
        });
    }
    Ok(trimmed.as_bytes().to_vec())
}

fn parse_publisher_upload_response(body: &str) -> Result<UploadResult, UploadBlobError> {
    let parsed: PublisherStoreResponse = serde_json::from_str(body).map_err(|e| {
        UploadBlobError::App(AppError::Internal(format!(
            "Failed to parse Walrus publisher upload response: {}",
            e
        )))
    })?;

    if let Some(newly_created) = parsed.newly_created {
        return Ok(UploadResult {
            blob_id: newly_created.blob_object.blob_id,
            object_id: Some(newly_created.blob_object.id),
        });
    }

    if let Some(already_certified) = parsed.already_certified {
        return Ok(UploadResult {
            blob_id: already_certified.blob_id,
            object_id: None,
        });
    }

    Err(UploadBlobError::App(AppError::Internal(
        "Walrus publisher response did not contain newlyCreated or alreadyCertified".into(),
    )))
}

/// Download a blob from one or more Walrus aggregators.
///
/// The first URL is treated as primary. When more URLs are configured, cold
/// reads race the next candidate after `race_after`; the first successful 2xx
/// response wins. This supports low-latency proxy/CDN aggregators while keeping
/// the existing single-aggregator behavior when no extra URL is configured.
///
/// `skip_consistency_check` is intentionally caller-controlled because it
/// should only be enabled for trusted blobs written by Walrus Memory.
pub async fn download_blob_from_aggregators(
    client: &reqwest::Client,
    aggregator_urls: &[String],
    blob_id: &str,
    skip_consistency_check: bool,
    race_after: Duration,
) -> Result<Vec<u8>, AppError> {
    let aggregator_urls: Vec<String> = aggregator_urls
        .iter()
        .map(|url| url.trim())
        .filter(|url| !url.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    if aggregator_urls.is_empty() {
        return Err(AppError::Internal(
            "Walrus download failed: no aggregator URLs configured".into(),
        ));
    }

    if aggregator_urls.len() == 1 {
        return download_blob_from_aggregator(
            client,
            &aggregator_urls[0],
            blob_id,
            skip_consistency_check,
        )
        .await;
    }

    let mut tasks = FuturesUnordered::new();
    let mut errors: Vec<(String, AppError)> = Vec::new();
    let mut next_index = 0usize;

    tasks.push(download_blob_candidate(
        client.clone(),
        aggregator_urls[next_index].clone(),
        blob_id.to_string(),
        skip_consistency_check,
    ));
    next_index += 1;

    loop {
        if tasks.is_empty() {
            if next_index < aggregator_urls.len() {
                tasks.push(download_blob_candidate(
                    client.clone(),
                    aggregator_urls[next_index].clone(),
                    blob_id.to_string(),
                    skip_consistency_check,
                ));
                next_index += 1;
                continue;
            }
            break;
        }

        if next_index >= aggregator_urls.len() {
            match tasks.next().await {
                Some((_, Ok(bytes))) => return Ok(bytes),
                Some((url, Err(err))) => errors.push((url, err)),
                None => break,
            }
            continue;
        }

        if race_after.is_zero() {
            while next_index < aggregator_urls.len() {
                tasks.push(download_blob_candidate(
                    client.clone(),
                    aggregator_urls[next_index].clone(),
                    blob_id.to_string(),
                    skip_consistency_check,
                ));
                next_index += 1;
            }
            continue;
        }

        tokio::select! {
            result = tasks.next() => {
                match result {
                    Some((_, Ok(bytes))) => return Ok(bytes),
                    Some((url, Err(err))) => errors.push((url, err)),
                    None => {}
                }
            }
            _ = tokio::time::sleep(race_after) => {
                tasks.push(download_blob_candidate(
                    client.clone(),
                    aggregator_urls[next_index].clone(),
                    blob_id.to_string(),
                    skip_consistency_check,
                ));
                next_index += 1;
            }
        }
    }

    Err(aggregate_download_errors(blob_id, &errors))
}

async fn download_blob_candidate(
    client: reqwest::Client,
    aggregator_url: String,
    blob_id: String,
    skip_consistency_check: bool,
) -> (String, Result<Vec<u8>, AppError>) {
    let result =
        download_blob_from_aggregator(&client, &aggregator_url, &blob_id, skip_consistency_check)
            .await;
    (aggregator_url, result)
}

async fn download_blob_from_aggregator(
    client: &reqwest::Client,
    aggregator_url: &str,
    blob_id: &str,
    skip_consistency_check: bool,
) -> Result<Vec<u8>, AppError> {
    let started = std::time::Instant::now();
    let mut url = reqwest::Url::parse(aggregator_url)
        .and_then(|base| base.join(&format!("v1/blobs/{blob_id}")))
        .map_err(|e| AppError::Internal(format!("Invalid Walrus aggregator URL: {}", e)))?;
    if skip_consistency_check {
        url.query_pairs_mut()
            .append_pair("skip_consistency_check", "true");
    }

    let resp = client
        .get(url.clone())
        .timeout(WALRUS_DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            let status = if e.is_timeout() {
                "timeout"
            } else {
                "transport_error"
            };
            crate::observability::observe_external(
                "walrus",
                "download_blob",
                status,
                started.elapsed(),
            );
            AppError::Internal(format!(
                "Walrus download failed from {}: {}",
                aggregator_url, e
            ))
        })?;

    let status = resp.status();
    let status_label = status.as_u16().to_string();
    crate::observability::observe_external(
        "walrus",
        "download_blob",
        &status_label,
        started.elapsed(),
    );

    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::BlobNotFound(format!(
            "Blob {} expired or not found at {}",
            blob_id, aggregator_url
        )));
    }

    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Walrus download failed from {} with status {}: {}",
            aggregator_url, status, body
        )));
    }

    let bytes = resp.bytes().await.map_err(|e| {
        crate::observability::observe_external(
            "walrus",
            "download_blob",
            "body_error",
            started.elapsed(),
        );
        AppError::Internal(format!(
            "Failed to read Walrus blob {} from {}: {}",
            blob_id, aggregator_url, e
        ))
    })?;

    tracing::info!(
        "walrus download ok: blob_id={}, {} bytes, aggregator={}, skip_consistency_check={}",
        blob_id,
        bytes.len(),
        aggregator_url,
        skip_consistency_check
    );
    Ok(bytes.to_vec())
}

fn aggregate_download_errors(blob_id: &str, errors: &[(String, AppError)]) -> AppError {
    if !errors.is_empty()
        && errors
            .iter()
            .all(|(_, err)| matches!(err, AppError::BlobNotFound(_)))
    {
        return AppError::BlobNotFound(format!(
            "Blob {} expired or not found across {} Walrus aggregators",
            blob_id,
            errors.len()
        ));
    }

    let summary = errors
        .iter()
        .map(|(url, err)| format!("{}: {}", url, err))
        .collect::<Vec<_>>()
        .join("; ");
    AppError::Internal(format!(
        "Walrus download failed for blob {} across {} aggregators: {}",
        blob_id,
        errors.len(),
        summary
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_download_errors, build_publisher_store_url, parse_publisher_upload_response,
        publisher_jwt_secret_bytes,
    };
    use crate::types::AppError;

    #[test]
    fn aggregate_download_errors_preserves_not_found_cleanup_signal() {
        let errors = vec![
            (
                "https://a.example".to_string(),
                AppError::BlobNotFound("404".into()),
            ),
            (
                "https://b.example".to_string(),
                AppError::BlobNotFound("404".into()),
            ),
        ];

        assert!(matches!(
            aggregate_download_errors("blob", &errors),
            AppError::BlobNotFound(_)
        ));
    }

    #[test]
    fn aggregate_download_errors_keeps_transient_errors_internal() {
        let errors = vec![
            (
                "https://a.example".to_string(),
                AppError::BlobNotFound("404".into()),
            ),
            (
                "https://b.example".to_string(),
                AppError::Internal("timeout".into()),
            ),
        ];

        assert!(matches!(
            aggregate_download_errors("blob", &errors),
            AppError::Internal(_)
        ));
    }

    #[test]
    fn publisher_store_url_includes_upload_constraints() {
        let url =
            build_publisher_store_url("https://publisher.example.com/", 3, true, Some("0xabc"))
                .expect("valid publisher url");

        assert_eq!(
            url.as_str(),
            "https://publisher.example.com/v1/blobs?epochs=3&deletable=true&send_object_to=0xabc"
        );
    }

    #[test]
    fn publisher_response_parses_newly_created() {
        let response = r#"{
            "newlyCreated": {
                "blobObject": {
                    "id": "0xobject",
                    "blobId": "blob-id"
                }
            }
        }"#;

        let parsed = parse_publisher_upload_response(response).expect("publisher response");

        assert_eq!(parsed.blob_id, "blob-id");
        assert_eq!(parsed.object_id.as_deref(), Some("0xobject"));
    }

    #[test]
    fn publisher_response_parses_already_certified() {
        let response = r#"{
            "alreadyCertified": {
                "blobId": "blob-id",
                "endEpoch": 35
            }
        }"#;

        let parsed = parse_publisher_upload_response(response).expect("publisher response");

        assert_eq!(parsed.blob_id, "blob-id");
        assert!(parsed.object_id.is_none());
    }

    #[test]
    fn publisher_jwt_secret_accepts_hex_and_raw() {
        assert_eq!(
            publisher_jwt_secret_bytes("0x68656c6c6f").expect("hex secret"),
            b"hello"
        );
        assert_eq!(
            publisher_jwt_secret_bytes("raw-secret").expect("raw secret"),
            b"raw-secret"
        );
    }
}
