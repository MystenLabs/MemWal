//! Memory-owned Oyster pooled-blob client.
//!
//! `OYSTER_BASE_URL` already includes `/api/v1`. Paths are joined onto that
//! prefix — never another `/api/v1`. PUT (not POST) stores raw bytes. This
//! client never calls extend / lifetime APIs.

use crate::types::AppError;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Deserialize;
use std::time::Duration;

/// Walrus-backed Oyster PUT encodes a 66MB unit; the shared relayer client
/// is 30s and times out before oysterd returns.
const OYSTER_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

fn oyster_http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(OYSTER_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| AppError::Internal(format!("oyster HTTP client: {e}")))
}

/// Encode `/` and other reserved bytes so `{namespace}/{job}` is one path segment.
const OYSTER_PATH_SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b'%');

#[derive(Debug, Clone, Deserialize)]
pub struct OysterStoreResponse {
    pub blob_id: String,
    #[serde(default)]
    pub pooled_blob_object_id: Option<String>,
    #[serde(default)]
    pub encoded_size: Option<i64>,
}

pub fn blob_object_key(namespace_object_id: &str, job_id: &str) -> String {
    format!("{namespace_object_id}/{job_id}")
}

pub fn join_oyster_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}

pub fn blob_url(base: &str, bucket: &str, key: &str) -> String {
    let bucket = utf8_percent_encode(bucket, OYSTER_PATH_SEGMENT);
    let key = utf8_percent_encode(key, OYSTER_PATH_SEGMENT);
    join_oyster_url(base, &format!("buckets/{bucket}/blobs/{key}"))
}

pub fn blob_by_id_url(base: &str, blob_id: &str) -> String {
    let blob_id = utf8_percent_encode(blob_id, OYSTER_PATH_SEGMENT);
    join_oyster_url(base, &format!("blobs/by-blob-id/{blob_id}"))
}

fn require_oyster_config<'a>(
    base_url: Option<&'a str>,
    api_key: Option<&'a str>,
) -> Result<(&'a str, &'a str), AppError> {
    let base = base_url.ok_or_else(|| {
        AppError::Internal("OYSTER_BASE_URL is required for V2 managed oyster writes".into())
    })?;
    let key = api_key.ok_or_else(|| {
        AppError::Internal("OYSTER_API_KEY is required for V2 managed oyster writes".into())
    })?;
    Ok((base, key))
}

/// PUT `{base}/buckets/{bucket}/blobs/{key}` with raw bytes.
pub async fn put_blob(
    client: &reqwest::Client,
    base_url: Option<&str>,
    api_key: Option<&str>,
    bucket: &str,
    key: &str,
    bytes: &[u8],
) -> Result<OysterStoreResponse, AppError> {
    let _ = client;
    let (base, api_key) = require_oyster_config(base_url, api_key)?;
    let url = blob_url(base, bucket, key);
    let started = std::time::Instant::now();
    let http = oyster_http_client()?;
    let resp = http
        .put(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| {
            crate::observability::observe_external(
                "oyster",
                "put_blob",
                "transport_error",
                started.elapsed(),
            );
            AppError::Internal(format!("Oyster PUT failed: {e}"))
        })?;
    let status = resp.status();
    crate::observability::observe_external(
        "oyster",
        "put_blob",
        &status.as_u16().to_string(),
        started.elapsed(),
    );
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Oyster PUT {} failed: {body}",
            status.as_u16()
        )));
    }
    resp.json().await.map_err(|e| {
        AppError::Internal(format!("Failed to parse Oyster PUT response: {e}"))
    })
}

/// GET `{base}/buckets/{bucket}/blobs/{key}` — raw envelope bytes.
pub async fn get_blob(
    client: &reqwest::Client,
    base_url: Option<&str>,
    api_key: Option<&str>,
    bucket: &str,
    key: &str,
) -> Result<Vec<u8>, AppError> {
    let base = base_url.ok_or_else(|| {
        AppError::Internal("OYSTER_BASE_URL is required for V2 oyster reads".into())
    })?;
    let url = blob_url(base, bucket, key);
    get_bytes(&oyster_http_client()?, url, api_key, "get_blob").await
}

/// GET `{base}/blobs/by-blob-id/{blob_id}` recall fallback.
pub async fn get_blob_by_id(
    client: &reqwest::Client,
    base_url: Option<&str>,
    api_key: Option<&str>,
    blob_id: &str,
) -> Result<Vec<u8>, AppError> {
    let base = base_url.ok_or_else(|| {
        AppError::Internal("OYSTER_BASE_URL is required for V2 oyster reads".into())
    })?;
    let url = blob_by_id_url(base, blob_id);
    get_bytes(&oyster_http_client()?, url, api_key, "get_blob_by_id").await
}

async fn get_bytes(
    client: &reqwest::Client,
    url: String,
    api_key: Option<&str>,
    op: &'static str,
) -> Result<Vec<u8>, AppError> {
    let started = std::time::Instant::now();
    let mut req = client.get(&url);
    if let Some(api_key) = api_key {
        req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"));
    }
    let resp = req.send().await.map_err(|e| {
        crate::observability::observe_external("oyster", op, "transport_error", started.elapsed());
        AppError::Internal(format!("Oyster GET failed: {e}"))
    })?;
    let status = resp.status();
    crate::observability::observe_external(
        "oyster",
        op,
        &status.as_u16().to_string(),
        started.elapsed(),
    );
    if status.as_u16() == 404 {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::BlobNotFound(format!(
            "Oyster blob not found: {body}"
        )));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Oyster GET {} failed: {body}",
            status.as_u16()
        )));
    }
    Ok(resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("Oyster GET body failed: {e}")))?
        .to_vec())
}

#[cfg(test)]
mod tests {
    use super::{blob_by_id_url, blob_object_key, blob_url, join_oyster_url};

    #[test]
    fn oyster_url_does_not_double_api_v1() {
        let base = "http://127.0.0.1:3000/api/v1";
        assert_eq!(
            join_oyster_url(base, "buckets/memwal/blobs/k"),
            "http://127.0.0.1:3000/api/v1/buckets/memwal/blobs/k"
        );
        assert_eq!(
            blob_url(base, "memwal", "ns/job"),
            "http://127.0.0.1:3000/api/v1/buckets/memwal/blobs/ns%2Fjob"
        );
        assert_eq!(
            blob_by_id_url(base, "xdmLE4twdasDCZaDCp8c2xqdf_B9q-05Q3928gvifJk"),
            "http://127.0.0.1:3000/api/v1/blobs/by-blob-id/xdmLE4twdasDCZaDCp8c2xqdf_B9q-05Q3928gvifJk"
        );
        assert!(
            !blob_url(base, "memwal", "k").contains("/api/v1/api/v1/"),
            "must not append a second /api/v1"
        );
    }

    #[test]
    fn oyster_key_is_namespace_slash_job() {
        assert_eq!(
            blob_object_key("0xabc", "job-1"),
            "0xabc/job-1"
        );
    }
}
