//! The async [`WalrusMemory`] client and its builder.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Client, Method};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::signing::{
    blake2b_256, canonical_message, encode_suiprivkey, encode_uleb128, sha256_hex, Signer,
};
use crate::types::*;

const DEFAULT_SERVER_URL: &str = "https://relayer.memory.walrus.xyz";
const DEFAULT_NAMESPACE: &str = "default";
const DEFAULT_HTTP_TIMEOUT_SECS: u64 = 60;
/// SEAL session lifetime; cached sessions are refreshed 30s before expiry.
const SEAL_SESSION_TTL_MIN: i64 = 10;

/// Builder for [`WalrusMemory`]. Obtain one via [`WalrusMemory::builder`].
#[derive(Debug, Clone)]
pub struct WalrusMemoryBuilder {
    key: String,
    account_id: String,
    server_url: Option<String>,
    namespace: Option<String>,
    env: Option<Env>,
    http: Option<Client>,
}

impl WalrusMemoryBuilder {
    /// Override the relayer base URL (takes precedence over [`Self::env`]).
    pub fn server_url(mut self, url: impl Into<String>) -> Self {
        self.server_url = Some(url.into());
        self
    }

    /// Select a relayer environment preset (used only when `server_url` is unset).
    pub fn env(mut self, env: Env) -> Self {
        self.env = Some(env);
        self
    }

    /// Set the default namespace (defaults to `"default"`).
    pub fn namespace(mut self, ns: impl Into<String>) -> Self {
        self.namespace = Some(ns.into());
        self
    }

    /// Provide a pre-configured `reqwest::Client` (e.g. with a proxy or custom
    /// timeout). If omitted, a client with a 60s timeout is created.
    pub fn http_client(mut self, client: Client) -> Self {
        self.http = Some(client);
        self
    }

    /// Validate the key and construct the client.
    pub fn build(self) -> Result<WalrusMemory> {
        let signer = Signer::from_hex_seed(&self.key)?;

        let server_url = self
            .server_url
            .or_else(|| self.env.map(|e| e.server_url().to_string()))
            .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
        let server_url = normalize_server_url(&server_url)?;

        let namespace = self
            .namespace
            .unwrap_or_else(|| DEFAULT_NAMESPACE.to_string());

        let http = match self.http {
            Some(c) => c,
            None => Client::builder()
                .timeout(Duration::from_secs(DEFAULT_HTTP_TIMEOUT_SECS))
                .build()?,
        };

        Ok(WalrusMemory {
            http,
            signer,
            account_id: self.account_id,
            server_url,
            namespace,
            session_cache: Arc::new(Mutex::new(None)),
            compatibility_checked: Arc::new(Mutex::new(false)),
        })
    }
}

/// Strip a single trailing slash and reject obviously malformed URLs.
fn normalize_server_url(url: &str) -> Result<String> {
    let trimmed = url.trim().trim_end_matches('/');
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(Error::InvalidUrl(format!(
            "server url must start with http:// or https:// (got {url:?})"
        )));
    }
    Ok(trimmed.to_string())
}

/// True when `server_url` is a known mainnet relayer domain (current
/// `memory.walrus.xyz` or the legacy pre-WALM-86 `memwal.ai`), in which case
/// [`WalrusMemory::build_seal_session`] can skip the `/config` round trip and
/// [`WalrusMemory::compatibility`] never needs to re-check.
fn is_known_mainnet_relayer(server_url: &str) -> bool {
    server_url.contains("relayer.memory.walrus.xyz") || server_url.contains("relayer.memwal.ai")
}

#[derive(Debug, Clone)]
struct CachedSession {
    session_header_value: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}

/// Async client for the Walrus Memory relayer.
///
/// Cloning is cheap: the `reqwest::Client`, delegate key, and cached SEAL
/// session are all reference-counted, so every clone shares the same session
/// cache and can be handed to independent tasks.
#[derive(Debug, Clone)]
pub struct WalrusMemory {
    http: Client,
    signer: Signer,
    account_id: String,
    server_url: String,
    namespace: String,
    session_cache: Arc<Mutex<Option<CachedSession>>>,
    compatibility_checked: Arc<Mutex<bool>>,
}

impl WalrusMemory {
    /// Start building a client from a hex delegate key and account id.
    pub fn builder(key: impl Into<String>, account_id: impl Into<String>) -> WalrusMemoryBuilder {
        WalrusMemoryBuilder {
            key: key.into(),
            account_id: account_id.into(),
            server_url: None,
            namespace: None,
            env: None,
            http: None,
        }
    }

    /// Convenience constructor using all defaults
    /// (`server_url = https://relayer.memory.walrus.xyz`, `namespace = "default"`).
    pub fn create(key: impl Into<String>, account_id: impl Into<String>) -> Result<Self> {
        Self::builder(key, account_id).build()
    }

    /// The configured relayer base URL (trailing slash stripped).
    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    /// The default namespace.
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    /// Hex-encoded delegate public key.
    pub fn public_key_hex(&self) -> &str {
        self.signer.public_key_hex()
    }

    /// Zero the delegate key's seed material and drop the cached SEAL
    /// session. The client must not be used after calling this — it exists
    /// for callers holding key material in long-lived processes who want to
    /// scrub it from memory as soon as it's no longer needed (heap-dump
    /// hardening), mirroring the TypeScript SDK's `destroy()`.
    pub fn destroy(mut self) {
        self.signer.zeroize();
        *self.session_cache.lock().unwrap() = None;
    }

    fn ns<'a>(&'a self, ns: Option<&'a str>) -> &'a str {
        ns.unwrap_or(&self.namespace)
    }

    // ── core signed-request plumbing ───────────────────────────────────────

    /// Send a signed request and return `(status, body_bytes)`. Only transport
    /// failures produce an `Err`; HTTP status interpretation is the caller's job.
    async fn send_raw(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        include_seal_session: bool,
    ) -> Result<(u16, Vec<u8>)> {
        let is_get = method == Method::GET;
        let body_str = if is_get {
            String::new()
        } else {
            serde_json::to_string(&body.cloned().unwrap_or_else(|| json!({})))?
        };
        let body_sha = sha256_hex(body_str.as_bytes());
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let nonce = Uuid::new_v4().to_string();
        let message = canonical_message(
            &timestamp,
            method.as_str(),
            path,
            &body_sha,
            &nonce,
            &self.account_id,
        );
        let signature = self.signer.sign_hex(message.as_bytes());

        let url = format!("{}{}", self.server_url, path);
        let mut req = self
            .http
            .request(method, &url)
            .header("x-public-key", self.signer.public_key_hex())
            .header("x-signature", signature)
            .header("x-timestamp", timestamp)
            .header("x-nonce", nonce)
            .header("x-account-id", &self.account_id);

        if !is_get {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body_str);
        }
        if include_seal_session {
            let session = self.build_seal_session().await?;
            req = req.header("x-seal-session", session);
        }

        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await?.to_vec();
        Ok((status, bytes))
    }

    /// Signed request that parses the body into `T` when the status is accepted.
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        accepted: &[u16],
        include_seal_session: bool,
    ) -> Result<T> {
        let (status, bytes) = self
            .send_raw(method, path, body.as_ref(), include_seal_session)
            .await?;
        decode(status, &bytes, accepted)
    }

    // ── remember ───────────────────────────────────────────────────────────

    /// Submit one memory. Returns immediately with a `job_id`; embedding,
    /// encryption, Walrus upload, and indexing continue in the background.
    pub async fn remember(&self, text: &str, namespace: Option<&str>) -> Result<RememberAccepted> {
        let body = json!({ "text": text, "namespace": self.ns(namespace) });
        self.request(Method::POST, "/api/remember", Some(body), &[200, 202], true)
            .await
    }

    /// Fetch the current status of a remember job.
    pub async fn get_remember_status(&self, job_id: &str) -> Result<RememberJobStatus> {
        let encoded =
            percent_encoding::utf8_percent_encode(job_id, percent_encoding::NON_ALPHANUMERIC);
        let path = format!("/api/remember/{encoded}");
        let (status, bytes) = self.send_raw(Method::GET, &path, None, true).await?;
        match status {
            200 => decode(status, &bytes, &[200]),
            404 => Ok(RememberJobStatus {
                job_id: job_id.to_string(),
                status: "not_found".to_string(),
                owner: None,
                namespace: None,
                blob_id: None,
                error: None,
            }),
            _ => Err(error_from_body(status, &bytes)),
        }
    }

    /// Poll a remember job until it reaches `done` (or fails / times out).
    pub async fn wait_for_remember_job(
        &self,
        job_id: &str,
        opts: WaitOptions,
    ) -> Result<RememberResult> {
        let start = Instant::now();
        let mut attempt: u32 = 0;
        loop {
            let st = self.get_remember_status(job_id).await?;
            match st.status.as_str() {
                "done" => {
                    return Ok(RememberResult {
                        id: st.job_id.clone(),
                        job_id: Some(st.job_id),
                        blob_id: st.blob_id.unwrap_or_default(),
                        owner: st.owner.unwrap_or_default(),
                        namespace: st.namespace.unwrap_or_else(|| self.namespace.clone()),
                    });
                }
                "failed" => {
                    return Err(Error::JobFailed {
                        job_id: job_id.to_string(),
                        message: st.error.unwrap_or_else(|| "job failed".to_string()),
                    });
                }
                "not_found" => {
                    return Err(Error::JobNotFound {
                        job_id: job_id.to_string(),
                    });
                }
                _ => {} // pending | running | uploaded → keep polling
            }
            if start.elapsed() >= Duration::from_millis(opts.timeout_ms) {
                return Err(Error::JobTimeout {
                    job_id: job_id.to_string(),
                    timeout_ms: opts.timeout_ms,
                });
            }
            tokio::time::sleep(backoff(opts.poll_interval_ms, attempt)).await;
            attempt = attempt.saturating_add(1);
        }
    }

    /// Submit a memory and wait for it to finish.
    pub async fn remember_and_wait(
        &self,
        text: &str,
        namespace: Option<&str>,
        opts: WaitOptions,
    ) -> Result<RememberResult> {
        let accepted = self.remember(text, namespace).await?;
        self.wait_for_remember_job(&accepted.job_id, opts).await
    }

    // ── recall / embed / analyze / ask / restore ───────────────────────────

    /// Semantic search over `owner + namespace`.
    pub async fn recall(&self, params: impl Into<RecallParams>) -> Result<RecallResult> {
        let params = params.into();
        if params.query.trim().is_empty() {
            return Err(Error::InvalidArgument("recall query is empty".into()));
        }
        let mut body = json!({
            "query": params.query,
            "limit": params.limit.unwrap_or(10),
            "namespace": params.namespace.as_deref().unwrap_or(&self.namespace),
        });
        if let Some(w) = &params.scoring_weights {
            body["scoring_weights"] = serde_json::to_value(w)?;
        }
        let mut result: RecallResult = self
            .request(Method::POST, "/api/recall", Some(body), &[200], true)
            .await?;
        // Client-side max_distance filter (mirrors the TS/Python SDKs).
        if let Some(md) = params.max_distance {
            result.results.retain(|m| m.distance < md);
            result.total = result.results.len() as u64;
        }
        Ok(result)
    }

    /// Generate an embedding vector for `text` without storing anything.
    ///
    /// Note: this calls `POST /api/embed`, which mirrors the TS/Python SDKs.
    /// Some relayer deployments embed internally and do not expose this route;
    /// against those it returns a 404 [`Error::Server`].
    pub async fn embed(&self, text: &str) -> Result<EmbedResult> {
        let body = json!({ "text": text });
        // No decryption needed — nothing is stored — so no SEAL session.
        self.request(Method::POST, "/api/embed", Some(body), &[200], false)
            .await
    }

    /// Extract memorable facts from `text` and enqueue a remember job per fact.
    pub async fn analyze(&self, text: &str, opts: AnalyzeOptions) -> Result<AnalyzeResult> {
        let mut body = json!({
            "text": text,
            "namespace": opts.namespace.as_deref().unwrap_or(&self.namespace),
        });
        if let Some(ts) = opts.occurred_at {
            body["occurred_at"] = json!(ts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
        self.request(Method::POST, "/api/analyze", Some(body), &[200, 202], true)
            .await
    }

    /// Analyze, then wait for every extracted-fact remember job to finish.
    pub async fn analyze_and_wait(
        &self,
        text: &str,
        opts: AnalyzeOptions,
        wait: WaitOptions,
    ) -> Result<AnalyzeWaitResult> {
        let ns = opts
            .namespace
            .clone()
            .unwrap_or_else(|| self.namespace.clone());
        let analyzed = self.analyze(text, opts).await?;
        let namespaces = vec![ns; analyzed.job_ids.len()];
        let bulk = self
            .wait_for_remember_jobs(&analyzed.job_ids, &namespaces, wait)
            .await?;
        Ok(AnalyzeWaitResult {
            facts: analyzed.facts,
            owner: analyzed.owner,
            results: bulk.results,
            total: bulk.total,
            succeeded: bulk.succeeded,
            failed: bulk.failed,
        })
    }

    /// Retrieval-augmented question answering over stored memories.
    pub async fn ask(
        &self,
        question: &str,
        limit: Option<u32>,
        namespace: Option<&str>,
    ) -> Result<AskResult> {
        if question.trim().is_empty() {
            return Err(Error::InvalidArgument("ask question is empty".into()));
        }
        let body = json!({
            "question": question,
            "limit": limit.unwrap_or(5),
            "namespace": self.ns(namespace),
        });
        self.request(Method::POST, "/api/ask", Some(body), &[200], true)
            .await
    }

    /// Rebuild the local index for a namespace from on-chain Walrus blobs.
    pub async fn restore(&self, namespace: &str, limit: Option<u32>) -> Result<RestoreResult> {
        if namespace.trim().is_empty() {
            return Err(Error::InvalidArgument("restore namespace is empty".into()));
        }
        let body = json!({ "namespace": namespace, "limit": limit.unwrap_or(10) });
        self.request(Method::POST, "/api/restore", Some(body), &[200], true)
            .await
    }

    // ── manual ──────────────────────────────────────────────────────────────

    /// Search with a pre-computed query vector. Returns blob ids + distances
    /// only (no server-side decryption, so no SEAL session is requested).
    pub async fn recall_manual(&self, opts: RecallManualOptions) -> Result<RecallManualResult> {
        if opts.vector.is_empty() {
            return Err(Error::InvalidArgument(
                "recall_manual vector is empty".into(),
            ));
        }
        let mut body = json!({
            "vector": opts.vector,
            "limit": opts.limit.unwrap_or(10),
            "namespace": opts.namespace.as_deref().unwrap_or(&self.namespace),
        });
        if let Some(w) = &opts.scoring_weights {
            body["scoring_weights"] = serde_json::to_value(w)?;
        }
        self.request(
            Method::POST,
            "/api/recall/manual",
            Some(body),
            &[200],
            false,
        )
        .await
    }

    /// Index a memory the caller has already embedded, SEAL-encrypted, and
    /// uploaded to Walrus themselves. No server-side decryption happens, so
    /// no SEAL session is requested.
    pub async fn remember_manual(
        &self,
        opts: RememberManualOptions,
    ) -> Result<RememberManualResult> {
        if opts.blob_id.trim().is_empty() {
            return Err(Error::InvalidArgument(
                "remember_manual blob_id is empty".into(),
            ));
        }
        if opts.vector.is_empty() {
            return Err(Error::InvalidArgument(
                "remember_manual vector is empty".into(),
            ));
        }
        let body = json!({
            "blob_id": opts.blob_id,
            "vector": opts.vector,
            "namespace": opts.namespace.as_deref().unwrap_or(&self.namespace),
        });
        self.request(
            Method::POST,
            "/api/remember/manual",
            Some(body),
            &[200, 201],
            false,
        )
        .await
    }

    // ── bulk ──────────────────────────────────────────────────────────────

    /// Submit up to 20 memories in one request.
    pub async fn remember_bulk(&self, items: &[RememberBulkItem]) -> Result<RememberBulkAccepted> {
        if items.is_empty() {
            return Err(Error::InvalidArgument(
                "remember_bulk items is empty".into(),
            ));
        }
        let wire: Vec<Value> = items
            .iter()
            .map(|i| json!({ "text": i.text, "namespace": i.namespace.as_deref().unwrap_or(&self.namespace) }))
            .collect();
        let body = json!({ "items": wire });
        self.request(
            Method::POST,
            "/api/remember/bulk",
            Some(body),
            &[200, 202],
            true,
        )
        .await
    }

    /// Fetch the status of a batch of remember jobs.
    pub async fn get_remember_bulk_status(
        &self,
        job_ids: &[String],
    ) -> Result<RememberBulkStatusResult> {
        if job_ids.is_empty() {
            return Err(Error::InvalidArgument("job_ids is empty".into()));
        }
        let body = json!({ "job_ids": job_ids });
        self.request(
            Method::POST,
            "/api/remember/bulk/status",
            Some(body),
            &[200],
            true,
        )
        .await
    }

    /// Poll a batch of remember jobs until all reach a terminal state.
    /// `namespaces` is index-aligned with `job_ids` (falls back to the client
    /// namespace when shorter/empty). Output order matches `job_ids`.
    pub async fn wait_for_remember_jobs(
        &self,
        job_ids: &[String],
        namespaces: &[String],
        opts: WaitOptions,
    ) -> Result<RememberBulkResult> {
        if job_ids.is_empty() {
            return Ok(RememberBulkResult {
                results: vec![],
                total: 0,
                succeeded: 0,
                failed: 0,
            });
        }
        let ns_for = |i: usize| -> String {
            namespaces
                .get(i)
                .cloned()
                .unwrap_or_else(|| self.namespace.clone())
        };

        let start = Instant::now();
        let mut attempt: u32 = 0;
        loop {
            let status = self.get_remember_bulk_status(job_ids).await?;
            let by_id: std::collections::HashMap<&str, &RememberBulkStatusItem> = status
                .results
                .iter()
                .map(|r| (r.job_id.as_str(), r))
                .collect();
            let all_terminal = job_ids.iter().all(|id| {
                matches!(
                    by_id.get(id.as_str()).map(|r| r.status.as_str()),
                    Some("done") | Some("failed") | Some("not_found")
                )
            });
            let timed_out = start.elapsed() >= Duration::from_millis(opts.timeout_ms);

            if all_terminal || timed_out {
                let mut results = Vec::with_capacity(job_ids.len());
                let (mut succeeded, mut failed) = (0u64, 0u64);
                for (i, id) in job_ids.iter().enumerate() {
                    let item = by_id.get(id.as_str());
                    let (status, blob_id, error) = match item.map(|r| r.status.as_str()) {
                        Some("done") => {
                            succeeded += 1;
                            ("done", item.and_then(|r| r.blob_id.clone()), None)
                        }
                        Some("failed") | Some("not_found") => {
                            failed += 1;
                            ("failed", None, item.and_then(|r| r.error.clone()))
                        }
                        _ => {
                            failed += 1;
                            ("timeout", None, None)
                        }
                    };
                    results.push(RememberBulkItemResult {
                        id: id.clone(),
                        blob_id,
                        status: status.to_string(),
                        namespace: ns_for(i),
                        error,
                    });
                }
                return Ok(RememberBulkResult {
                    total: results.len() as u64,
                    succeeded,
                    failed,
                    results,
                });
            }

            tokio::time::sleep(backoff(opts.poll_interval_ms, attempt)).await;
            attempt = attempt.saturating_add(1);
        }
    }

    /// Submit a bulk batch and wait for all jobs to finish.
    pub async fn remember_bulk_and_wait(
        &self,
        items: &[RememberBulkItem],
        opts: WaitOptions,
    ) -> Result<RememberBulkResult> {
        let accepted = self.remember_bulk(items).await?;
        let namespaces: Vec<String> = items
            .iter()
            .map(|i| {
                i.namespace
                    .clone()
                    .unwrap_or_else(|| self.namespace.clone())
            })
            .collect();
        self.wait_for_remember_jobs(&accepted.job_ids, &namespaces, opts)
            .await
    }

    // ── unauthenticated ────────────────────────────────────────────────────

    /// Relayer health (no authentication).
    pub async fn health(&self) -> Result<HealthResult> {
        let url = format!("{}/health", self.server_url);
        let (status, bytes) = self.unsigned_get(&url).await?;
        decode(status, &bytes, &[200])
    }

    /// Relayer version + compatibility metadata (no authentication).
    pub async fn version(&self) -> Result<VersionInfo> {
        let url = format!("{}/version", self.server_url);
        let (status, bytes) = self.unsigned_get(&url).await?;
        decode(status, &bytes, &[200])
    }

    async fn unsigned_get(&self, url: &str) -> Result<(u16, Vec<u8>)> {
        let resp = self.http.get(url).send().await?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await?.to_vec();
        Ok((status, bytes))
    }

    /// Check that the relayer's advertised API version is one this SDK
    /// supports. The check result is cached for the client's lifetime (the
    /// API version can't change mid-process), and skipped entirely against a
    /// known mainnet relayer domain.
    pub async fn compatibility(&self) -> Result<()> {
        if is_known_mainnet_relayer(&self.server_url) {
            return Ok(());
        }
        if *self.compatibility_checked.lock().unwrap() {
            return Ok(());
        }
        let info = self
            .version()
            .await
            .map_err(|e| Error::Compatibility(format!("failed to query /version: {e}")))?;
        if !info.api_version.starts_with("1.") {
            return Err(Error::Compatibility(format!(
                "incompatible relayer API version: {}",
                info.api_version
            )));
        }
        *self.compatibility_checked.lock().unwrap() = true;
        Ok(())
    }

    // ── SEAL session ────────────────────────────────────────────────────────

    /// Build (or return the cached) SEAL session header value: a base64 JSON
    /// envelope containing an ephemeral Ed25519 session key, signed by the
    /// delegate key as a Sui "personal message". The relayer uses this to
    /// derive SEAL decrypt keys without ever seeing the delegate private key
    /// itself. Cached for `SEAL_SESSION_TTL_MIN` minutes minus a 30s margin.
    async fn build_seal_session(&self) -> Result<String> {
        use base64::Engine as _;

        {
            let cache = self.session_cache.lock().unwrap();
            if let Some(session) = cache.as_ref() {
                if session.expires_at > chrono::Utc::now() {
                    return Ok(session.session_header_value.clone());
                }
            }
        }

        let package_id = if is_known_mainnet_relayer(&self.server_url) {
            "0x2::memwal".to_string()
        } else {
            #[derive(serde::Deserialize)]
            struct ConfigResp {
                #[serde(rename = "packageId")]
                package_id: String,
            }
            let url = format!("{}/config", self.server_url);
            let resp = self.http.get(&url).send().await?;
            if !resp.status().is_success() {
                return Err(Error::SealSession(format!(
                    "failed to fetch relayer /config: {}",
                    resp.status()
                )));
            }
            resp.json::<ConfigResp>().await?.package_id
        };

        // Ephemeral Ed25519 session keypair.
        let ephemeral_signing_key = {
            use rand::RngCore;
            let mut secret_bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut secret_bytes);
            ed25519_dalek::SigningKey::from_bytes(&secret_bytes)
        };
        let session_public_key_b64 = base64::prelude::BASE64_STANDARD
            .encode(ephemeral_signing_key.verifying_key().to_bytes());

        let now = chrono::Utc::now();
        let creation_time_utc = now.format("%Y-%m-%d %H:%M:%S UTC").to_string();
        let message = format!(
            "Accessing keys of package {package_id} for {SEAL_SESSION_TTL_MIN} mins from {creation_time_utc}, session key {session_public_key_b64}"
        );

        // Sui `PersonalMessage` intent-signing: 3-byte intent prefix + uleb128
        // length + message bytes, blake2b-256 hashed then Ed25519-signed.
        let message_bytes = message.as_bytes();
        let uleb128_len = encode_uleb128(message_bytes.len());
        let mut intent_message = Vec::with_capacity(3 + uleb128_len.len() + message_bytes.len());
        intent_message.extend_from_slice(&[0x03, 0x00, 0x00]);
        intent_message.extend_from_slice(&uleb128_len);
        intent_message.extend_from_slice(message_bytes);
        let digest = blake2b_256(&intent_message);

        let signature = self.signer.sign(&digest);
        let mut serialized_sig = Vec::with_capacity(1 + 64 + 32);
        serialized_sig.push(0x00); // Ed25519 signature-scheme flag
        serialized_sig.extend_from_slice(&signature.to_bytes());
        serialized_sig.extend_from_slice(&self.signer.verifying_key_bytes());
        let personal_message_signature = base64::prelude::BASE64_STANDARD.encode(serialized_sig);

        // Delegate's Sui address, derived from the main verifying key.
        let mut address_input = Vec::with_capacity(33);
        address_input.push(0x00);
        address_input.extend_from_slice(&self.signer.verifying_key_bytes());
        let address = format!("0x{}", hex::encode(blake2b_256(&address_input)));

        let session_key = encode_suiprivkey(&ephemeral_signing_key.to_bytes());
        let creation_time_ms = now.timestamp_millis();
        let payload = serde_json::json!({
            "address": address,
            "packageId": package_id,
            "mvrName": null,
            "creationTimeMs": creation_time_ms,
            "ttlMin": SEAL_SESSION_TTL_MIN,
            "personalMessageSignature": personal_message_signature,
            "sessionKey": session_key,
        });
        let session_header_value =
            base64::prelude::BASE64_STANDARD.encode(serde_json::to_string(&payload)?);

        let expires_at = now + chrono::Duration::seconds(SEAL_SESSION_TTL_MIN * 60 - 30);
        *self.session_cache.lock().unwrap() = Some(CachedSession {
            session_header_value: session_header_value.clone(),
            expires_at,
        });

        Ok(session_header_value)
    }
}

/// Jitterless exponential backoff: `min(10s, base * 1.5^min(attempt, 6))`.
fn backoff(poll_interval_ms: u64, attempt: u32) -> Duration {
    let base = poll_interval_ms.max(100) as f64;
    let factor = 1.5_f64.powi(attempt.min(6) as i32);
    let delay = (base * factor).min(10_000.0);
    Duration::from_millis(delay as u64)
}

/// Decode an accepted response or map a non-accepted status to an [`Error`].
fn decode<T: DeserializeOwned>(status: u16, bytes: &[u8], accepted: &[u16]) -> Result<T> {
    if accepted.contains(&status) {
        Ok(serde_json::from_slice(bytes)?)
    } else {
        Err(error_from_body(status, bytes))
    }
}

/// Build a typed [`Error`] from a non-success response body (`{"error": ...}`).
fn error_from_body(status: u16, bytes: &[u8]) -> Error {
    let parsed: Option<Value> = serde_json::from_slice(bytes).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
        })
        .map(truncate)
        .unwrap_or_else(|| truncate(&String::from_utf8_lossy(bytes)));
    let code = parsed
        .as_ref()
        .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(String::from));

    match status {
        401 => Error::AuthRejected {
            message: if message.is_empty() {
                "delegate key not authorized for this account, clock skew (>5min), or replayed nonce".into()
            } else {
                message
            },
        },
        426 => Error::Incompatible { message },
        _ => Error::Server {
            status,
            code,
            message,
        },
    }
}

fn truncate(s: &str) -> String {
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
    if cleaned.chars().count() > 300 {
        let head: String = cleaned.chars().take(300).collect();
        format!("{head}…")
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: &str = "0101010101010101010101010101010101010101010101010101010101010101";

    fn test_client() -> WalrusMemory {
        WalrusMemory::builder(SEED, "0xacct")
            .server_url("https://relayer.memory.walrus.xyz")
            .namespace("demo")
            .build()
            .unwrap()
    }

    #[test]
    fn is_known_mainnet_relayer_matches_current_and_legacy_domain() {
        assert!(is_known_mainnet_relayer(
            "https://relayer.memory.walrus.xyz"
        ));
        assert!(is_known_mainnet_relayer("https://relayer.memwal.ai"));
        assert!(!is_known_mainnet_relayer("https://relayer.dev.memwal.ai"));
        assert!(!is_known_mainnet_relayer("http://127.0.0.1:8000"));
    }

    #[tokio::test]
    async fn build_seal_session_produces_decodable_envelope() {
        use base64::Engine as _;

        let client = test_client();
        let session_b64 = client.build_seal_session().await.unwrap();
        let decoded = base64::prelude::BASE64_STANDARD
            .decode(&session_b64)
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&decoded).unwrap();

        assert!(payload["address"].is_string());
        assert_eq!(payload["packageId"], "0x2::memwal");
        assert_eq!(payload["ttlMin"], SEAL_SESSION_TTL_MIN);
        assert!(payload["personalMessageSignature"].is_string());
        assert!(payload["sessionKey"]
            .as_str()
            .unwrap()
            .starts_with("suiprivkey1"));
    }

    #[tokio::test]
    async fn build_seal_session_is_cached() {
        let client = test_client();
        let a = client.build_seal_session().await.unwrap();
        let b = client.build_seal_session().await.unwrap();
        assert_eq!(
            a, b,
            "second call within TTL should reuse the cached session"
        );
    }
}
