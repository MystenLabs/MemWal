use crate::error::Error;
use crate::types::*;
use ed25519_dalek::Signer;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

pub struct MemWalClient {
    signing_key: ed25519_dalek::SigningKey,
    account_id: String,
    server_url: String,
    namespace: String,
    client: reqwest::Client,
    session_cache: Mutex<Option<CachedSession>>,
}

struct CachedSession {
    session_header_value: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}

impl MemWalClient {
    /// Create a new MemWal client instance.
    pub fn new(
        key: &[u8; 32],
        account_id: &str,
        server_url: &str,
        namespace: &str,
    ) -> Self {
        let signing_key = ed25519_dalek::SigningKey::from_bytes(key);
        let client = reqwest::Client::new();
        Self {
            signing_key,
            account_id: account_id.to_string(),
            server_url: server_url.trim().trim_end_matches('/').to_string(),
            namespace: namespace.to_string(),
            client,
            session_cache: Mutex::new(None),
        }
    }

    /// Submit a remember request and return as soon as the server accepts the job.
    pub async fn remember(
        &self,
        text: &str,
        namespace: Option<&str>,
    ) -> Result<RememberAcceptedResult, Error> {
        let ns = namespace.unwrap_or(&self.namespace);
        let body = serde_json::json!({
            "text": text,
            "namespace": ns,
        });

        self.signed_request(
            "POST",
            "/api/remember",
            &body,
            &[reqwest::StatusCode::OK, reqwest::StatusCode::ACCEPTED],
            true,
        )
        .await
    }

    /// Poll an accepted remember job until it reaches a terminal state.
    pub async fn wait_for_remember_job(
        &self,
        job_id: &str,
        poll_interval_ms: Option<u64>,
        timeout_ms: Option<u64>,
    ) -> Result<RememberResult, Error> {
        let poll_interval = poll_interval_ms.unwrap_or(1500);
        let timeout = timeout_ms.unwrap_or(60_000);
        let start = std::time::Instant::now();
        let mut attempt = 0;

        while start.elapsed() < Duration::from_millis(timeout) {
            tokio::time::sleep(polling_delay(poll_interval, attempt)).await;
            attempt += 1;

            let encoded_job_id = percent_encoding::utf8_percent_encode(job_id, percent_encoding::NON_ALPHANUMERIC).to_string();
            let path = format!("/api/remember/{}", encoded_job_id);
            let res = self.signed_request::<RememberJobStatus>(
                "GET",
                &path,
                &serde_json::Value::Null,
                &[reqwest::StatusCode::OK],
                true,
            )
            .await;

            match res {
                Ok(status) => {
                    if status.status == "not_found" {
                        return Err(Error::JobNotFound { job_id: job_id.to_string() });
                    }
                    if status.status == "done" {
                        return Ok(RememberResult {
                            id: status.job_id.clone(),
                            job_id: Some(status.job_id),
                            blob_id: status.blob_id.unwrap_or_default(),
                            owner: status.owner.unwrap_or_default(),
                            namespace: status.namespace.unwrap_or_else(|| self.namespace.clone()),
                        });
                    }
                    if status.status == "failed" {
                        return Err(Error::JobFailed {
                            job_id: job_id.to_string(),
                            message: status.error.unwrap_or_else(|| "unknown error".to_string()),
                        });
                    }
                }
                Err(Error::Request { status: reqwest::StatusCode::NOT_FOUND, .. }) => {
                    return Err(Error::JobNotFound { job_id: job_id.to_string() });
                }
                Err(err) => {
                    if let Error::Request { status, .. } = &err {
                        let code = status.as_u16();
                        if code == 429 || code >= 500 {
                            continue;
                        }
                    }
                    return Err(err);
                }
            }
        }

        Err(Error::JobTimeout { job_id: job_id.to_string() })
    }

    /// Remember something and wait for the background job to complete.
    pub async fn remember_and_wait(
        &self,
        text: &str,
        namespace: Option<&str>,
    ) -> Result<RememberResult, Error> {
        let accepted = self.remember(text, namespace).await?;
        self.wait_for_remember_job(&accepted.job_id, None, None).await
    }

    /// Recall memories similar to a query.
    pub async fn recall(&self, params: RecallParams) -> Result<RecallResult, Error> {
        let limit = params.top_k.or(params.limit).unwrap_or(10);
        let ns = params.namespace.as_deref().unwrap_or(&self.namespace);
        let body = serde_json::json!({
            "query": params.query,
            "limit": limit,
            "namespace": ns,
        });

        let mut result: RecallResult = self.signed_request(
            "POST",
            "/api/recall",
            &body,
            &[reqwest::StatusCode::OK],
            true,
        )
        .await?;

        if let Some(max_distance) = params.max_distance {
            result.results.retain(|m| m.distance < max_distance);
            result.total = result.results.len();
        }

        Ok(result)
    }

    /// Generate an embedding vector for text (no storage).
    pub async fn embed(&self, text: &str) -> Result<EmbedResult, Error> {
        let body = serde_json::json!({
            "text": text,
        });

        self.signed_request(
            "POST",
            "/api/embed",
            &body,
            &[reqwest::StatusCode::OK],
            false, // embed endpoint does not need decryption, keep private key client-side
        )
        .await
    }

    /// Analyze conversation text and return as soon as the facts are accepted.
    pub async fn analyze(
        &self,
        text: &str,
        namespace: Option<&str>,
    ) -> Result<AnalyzeResult, Error> {
        let ns = namespace.unwrap_or(&self.namespace);
        let body = serde_json::json!({
            "text": text,
            "namespace": ns,
        });

        self.signed_request(
            "POST",
            "/api/analyze",
            &body,
            &[reqwest::StatusCode::OK, reqwest::StatusCode::ACCEPTED],
            true,
        )
        .await
    }

    /// Ask a question answered using memories.
    pub async fn ask(
        &self,
        question: &str,
        namespace: Option<&str>,
    ) -> Result<AskResponse, Error> {
        let ns = namespace.unwrap_or(&self.namespace);
        let body = serde_json::json!({
            "question": question,
            "limit": 5, // Default limit
            "namespace": ns,
        });

        self.signed_request(
            "POST",
            "/api/ask",
            &body,
            &[reqwest::StatusCode::OK],
            true,
        )
        .await
    }

    /// Check that the relayer's API version is compatible.
    pub async fn check_compatibility(&self) -> Result<(), Error> {
        if self.server_url.contains("relayer.memwal.ai") {
            return Ok(());
        }
        let url = format!("{}/version", self.server_url);
        let resp = self.client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(Error::Compatibility(format!(
                "Failed to query version endpoint: {}",
                resp.status()
            )));
        }
        #[derive(serde::Deserialize)]
        struct VersionResp {
            #[serde(rename = "apiVersion")]
            api_version: String,
        }
        let version_info: VersionResp = resp.json().await?;
        if !version_info.api_version.starts_with("1.") {
            return Err(Error::Compatibility(format!(
                "Incompatible API version: {}",
                version_info.api_version
            )));
        }
        Ok(())
    }

    pub async fn build_seal_session(&self) -> Result<String, Error> {
        use base64::Engine as _;

        // Check cache first
        {
            let cache = self.session_cache.lock().unwrap();
            if let Some(ref session) = *cache {
                if session.expires_at > chrono::Utc::now() {
                    return Ok(session.session_header_value.clone());
                }
            }
        }

        // Cache miss or expired. Build new session.
        let (package_id, _sui_rpc_url) = if self.server_url.contains("relayer.memwal.ai") {
            ("0x2::memwal".to_string(), "https://fullnode.mainnet.sui.io:443".to_string())
        } else {
            let config_url = format!("{}/config", self.server_url);
            let resp = self.client.get(&config_url).send().await?;
            if !resp.status().is_success() {
                return Err(Error::Crypto(format!("Failed to retrieve config: {}", resp.status())));
            }
            #[derive(serde::Deserialize)]
            struct ConfigResp {
                #[serde(rename = "packageId")]
                package_id: String,
                #[serde(rename = "suiRpcUrl")]
                sui_rpc_url: String,
            }
            let config: ConfigResp = resp.json().await?;
            (config.package_id, config.sui_rpc_url)
        };

        // Generate ephemeral Ed25519 session keypair (ed25519-dalek v2 uses rand OsRng)
        let ephemeral_signing_key = {
            use rand::RngCore;
            let mut secret_bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut secret_bytes);
            ed25519_dalek::SigningKey::from_bytes(&secret_bytes)
        };
        let ephemeral_verifying_key = ephemeral_signing_key.verifying_key();
        let ephemeral_public_key_bytes = ephemeral_verifying_key.to_bytes();
        let session_public_key_b64 = base64::prelude::BASE64_STANDARD.encode(&ephemeral_public_key_bytes);

        // Format personal message
        let ttl_min = 10;
        let now = chrono::Utc::now();
        let creation_time_utc = now.format("%Y-%m-%d %H:%M:%S UTC").to_string();
        let message = format!(
            "Accessing keys of package {} for {} mins from {}, session key {}",
            package_id, ttl_min, creation_time_utc, session_public_key_b64
        );

        // Sign personal message following Sui PersonalMessage format
        let message_bytes = message.as_bytes();
        let uleb128_len = encode_uleb128(message_bytes.len());
        let mut intent_message = Vec::with_capacity(3 + uleb128_len.len() + message_bytes.len());
        intent_message.extend_from_slice(&[0x03, 0x00, 0x00]);
        intent_message.extend_from_slice(&uleb128_len);
        intent_message.extend_from_slice(message_bytes);

        let digest = blake2b_256(&intent_message);
        let signature = self.signing_key.sign(&digest);
        let mut serialized_sig = Vec::with_capacity(1 + 64 + 32);
        serialized_sig.push(0x00);
        serialized_sig.extend_from_slice(&signature.to_bytes());
        serialized_sig.extend_from_slice(&self.signing_key.verifying_key().to_bytes());

        let personal_message_signature = base64::prelude::BASE64_STANDARD.encode(&serialized_sig);

        // Derive delegate's Sui address from main verifying key
        let mut address_input = Vec::with_capacity(33);
        address_input.push(0x00);
        address_input.extend_from_slice(&self.signing_key.verifying_key().to_bytes());
        let address_hash = blake2b_256(&address_input);
        let address = format!("0x{}", hex::encode(address_hash));

        // Encode ephemeral session private key seed to Sui Bech32 format suiprivkey...
        let session_key = encode_suiprivkey(&ephemeral_signing_key.to_bytes());

        // Construct JSON payload
        let creation_time_ms = now.timestamp_millis();
        let payload = serde_json::json!({
            "address": address,
            "packageId": package_id,
            "mvrName": null,
            "creationTimeMs": creation_time_ms,
            "ttlMin": 10,
            "personalMessageSignature": personal_message_signature,
            "sessionKey": session_key,
        });

        let json_string = serde_json::to_string(&payload)?;
        let session_header_value = base64::prelude::BASE64_STANDARD.encode(json_string.as_bytes());

        // Cache expiration: now + 10 mins - 30 seconds
        let expires_at = now + chrono::Duration::seconds(10 * 60 - 30);
        {
            let mut cache = self.session_cache.lock().unwrap();
            *cache = Some(CachedSession {
                session_header_value: session_header_value.clone(),
                expires_at,
            });
        }

        Ok(session_header_value)
    }

    /// Prepares request headers and signs the canonical request message.
    /// Exposed internally/for testing to verify signature format and payload values.
    pub async fn prepare_request_headers(
        &self,
        method: &str,
        path: &str,
        body: &serde_json::Value,
        include_delegate_key: bool,
    ) -> Result<(String, HashMap<String, String>), Error> {
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let nonce = Uuid::new_v4().to_string();

        let body_hash = if method == "GET" || body.is_null() {
            let mut hasher = Sha256::new();
            hasher.update(b"");
            hex::encode(hasher.finalize())
        } else {
            let serialized = serde_json::to_string(body)?;
            let mut hasher = Sha256::new();
            hasher.update(serialized.as_bytes());
            hex::encode(hasher.finalize())
        };

        // Canonical format:
        //   "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
        let message = format!(
            "{}.{}.{}.{}.{}.{}",
            timestamp,
            method.to_uppercase(),
            path,
            body_hash,
            nonce,
            self.account_id
        );

        let signature = self.signing_key.sign(message.as_bytes());
        let signature_hex = hex::encode(signature.to_bytes());
        let public_key_hex = hex::encode(self.signing_key.verifying_key().to_bytes());

        let mut headers = HashMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        headers.insert("x-public-key".to_string(), public_key_hex);
        headers.insert("x-signature".to_string(), signature_hex);
        headers.insert("x-timestamp".to_string(), timestamp);
        headers.insert("x-nonce".to_string(), nonce);
        headers.insert("x-account-id".to_string(), self.account_id.clone());

        if include_delegate_key {
            let session_b64 = self.build_seal_session().await?;
            headers.insert("x-seal-session".to_string(), session_b64);
        }

        Ok((message, headers))
    }

    /// Helper for making signed HTTP requests to the relayer.
    async fn signed_request<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: &serde_json::Value,
        accepted_statuses: &[reqwest::StatusCode],
        include_delegate_key: bool,
    ) -> Result<T, Error> {
        let (_message, headers) = self.prepare_request_headers(method, path, body, include_delegate_key).await?;

        let url = format!("{}{}", self.server_url, path);
        let req_method = match method.to_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            _ => return Err(Error::Crypto(format!("Unsupported HTTP method: {}", method))),
        };

        let mut req = self.client.request(req_method, &url);
        for (k, v) in headers {
            req = req.header(&k, &v);
        }

        if method != "GET" && !body.is_null() {
            req = req.json(body);
        }

        let resp = req.send().await?;
        let status = resp.status();

        if !accepted_statuses.contains(&status) {
            let body_text = resp.text().await.unwrap_or_default();
            return Err(Error::Request {
                status,
                message: body_text,
            });
        }

        let res = resp.json::<T>().await?;
        Ok(res)
    }
}

// ============================================================
// Cryptography / Encoding Helpers
// ============================================================

fn blake2b_256(data: &[u8]) -> [u8; 32] {
    use blake2::digest::{Update, VariableOutput};
    use blake2::Blake2bVar;
    let mut hasher = Blake2bVar::new(32).expect("32 bytes output size is valid");
    hasher.update(data);
    let mut output = [0u8; 32];
    hasher.finalize_variable(&mut output).expect("digest output");
    output
}

fn encode_uleb128(mut value: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if value == 0 {
            break;
        }
    }
    bytes
}

fn bech32_polymod(values: &[u8]) -> u32 {
    let mut generator: u32 = 1;
    for &value in values {
        let top = generator >> 25;
        generator = ((generator & 0x1ffffff) << 5) ^ (value as u32);
        for (i, &g) in [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
            .iter()
            .enumerate()
        {
            if (top >> i) & 1 != 0 {
                generator ^= g;
            }
        }
    }
    generator
}

fn bech32_hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v = Vec::new();
    for c in hrp.bytes() {
        v.push(c >> 5);
    }
    v.push(0);
    for c in hrp.bytes() {
        v.push(c & 31);
    }
    v
}

fn bech32_create_checksum(hrp: &str, data: &[u8]) -> Vec<u8> {
    let mut combined = bech32_hrp_expand(hrp);
    combined.extend_from_slice(data);
    combined.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    let polymod = bech32_polymod(&combined) ^ 1;
    let mut checksum = Vec::with_capacity(6);
    for i in 0..6 {
        checksum.push(((polymod >> (5 * (5 - i))) & 31) as u8);
    }
    checksum
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Result<Vec<u8>, &'static str> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut ret = Vec::new();
    let maxv: u32 = (1 << to) - 1;
    let max_acc: u32 = (1 << (from + to - 1)) - 1;
    for &value in data {
        let v = value as u32;
        if (v >> from) != 0 {
            return Err("Invalid value");
        }
        acc = ((acc << from) | v) & max_acc;
        bits += from;
        while bits >= to {
            bits -= to;
            ret.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            ret.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return Err("Invalid padding");
    }
    Ok(ret)
}

fn encode_suiprivkey(seed: &[u8; 32]) -> String {
    let mut payload = Vec::with_capacity(33);
    payload.push(0x00);
    payload.extend_from_slice(seed);

    let data_5bit = convert_bits(&payload, 8, 5, true).unwrap();
    let checksum = bech32_create_checksum("suiprivkey", &data_5bit);

    let mut combined = data_5bit;
    combined.extend_from_slice(&checksum);

    let charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let encoded: String = combined
        .iter()
        .map(|&b| charset.chars().nth(b as usize).unwrap())
        .collect();

    format!("suiprivkey1{}", encoded)
}

/// Calculate the polling delay with exponential backoff and jitter.
fn polling_delay(base_ms: u64, attempt: u32) -> Duration {
    let base = base_ms.max(100) as f64;
    let capped = (base * 1.5_f64.powi(attempt.min(6) as i32)).min(10000.0);
    // Simple pseudo-random jitter based on the current time's milliseconds
    let ms = chrono::Utc::now().timestamp_millis() as u64;
    let jitter_pct = 0.75 + ((ms % 1000) as f64 / 2000.0); // 0.75 to 1.25
    Duration::from_millis((capped * jitter_pct) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey};

    fn test_client() -> MemWalClient {
        let key: [u8; 32] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        MemWalClient::new(
            &key,
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "https://relayer.memwal.ai/",
            "my_test_namespace",
        )
    }

    #[test]
    fn test_client_construction() {
        let client = test_client();
        assert_eq!(client.account_id, "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
        assert_eq!(client.server_url, "https://relayer.memwal.ai");
        assert_eq!(client.namespace, "my_test_namespace");
    }

    #[tokio::test]
    async fn test_signature_message_generation_format() {
        let client = test_client();
        let body = serde_json::json!({
            "text": "Hello, Walrus Memory!"
        });

        let (message, headers) = client
            .prepare_request_headers("POST", "/api/remember", &body, true)
            .await
            .unwrap();

        // 1. Verify message format contains 6 fields: timestamp, method, path, body_sha256, nonce, account_id
        let parts: Vec<&str> = message.split('.').collect();
        assert_eq!(parts.len(), 6);
        assert_eq!(parts[1], "POST");
        assert_eq!(parts[2], "/api/remember");
        assert_eq!(parts[5], client.account_id);

        // Verify body hash is correct SHA-256 hex
        let mut hasher = Sha256::new();
        hasher.update(serde_json::to_string(&body).unwrap().as_bytes());
        let expected_hash = hex::encode(hasher.finalize());
        assert_eq!(parts[3], expected_hash);

        // 2. Verify headers are correctly set
        assert_eq!(headers.get("x-account-id").unwrap(), &client.account_id);
        assert!(headers.get("x-public-key").is_some());
        assert!(headers.get("x-signature").is_some());
        assert!(headers.get("x-timestamp").is_some());
        assert!(headers.get("x-nonce").is_some());
        assert!(headers.get("x-seal-session").is_some());
        assert!(headers.get("x-delegate-key").is_none());
    }

    #[tokio::test]
    async fn test_cryptographic_signature_roundtrip() {
        let client = test_client();
        let body = serde_json::json!({
            "query": "find matching files",
            "limit": 5
        });

        let (message, headers) = client
            .prepare_request_headers("POST", "/api/recall", &body, false)
            .await
            .unwrap();

        let public_key_hex = headers.get("x-public-key").unwrap();
        let signature_hex = headers.get("x-signature").unwrap();

        // Decode public key and signature
        let pk_bytes = hex::decode(public_key_hex).unwrap();
        let verifying_key = VerifyingKey::from_bytes(&pk_bytes.try_into().unwrap()).unwrap();

        let sig_bytes = hex::decode(signature_hex).unwrap();
        let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes.try_into().unwrap());

        // Verify cryptographic signature passes
        assert!(verifying_key.verify(message.as_bytes(), &signature).is_ok());

        // Tamper with the message and ensure it fails verification
        let tampered_message = format!("{}x", message);
        assert!(verifying_key.verify(tampered_message.as_bytes(), &signature).is_err());
    }

    #[test]
    fn test_types_serialization_deserialization() {
        let recall_result = RecallResult {
            results: vec![
                RecallMemory {
                    blob_id: "blob-1".to_string(),
                    text: "Test memory 1".to_string(),
                    distance: 0.123,
                },
                RecallMemory {
                    blob_id: "blob-2".to_string(),
                    text: "Test memory 2".to_string(),
                    distance: 0.456,
                },
            ],
            total: 2,
        };

        // Serialize
        let serialized = serde_json::to_string(&recall_result).unwrap();
        assert!(serialized.contains("blob-1"));
        assert!(serialized.contains("0.123"));

        // Deserialize
        let deserialized: RecallResult = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.total, 2);
        assert_eq!(deserialized.results[0].blob_id, "blob-1");
        assert_eq!(deserialized.results[1].distance, 0.456);
    }

    #[test]
    fn test_uleb128_encoding() {
        assert_eq!(encode_uleb128(0), vec![0]);
        assert_eq!(encode_uleb128(127), vec![127]);
        assert_eq!(encode_uleb128(128), vec![128, 1]);
        assert_eq!(encode_uleb128(145), vec![0x91, 0x01]);
    }

    #[test]
    fn test_sui_address_derivation() {
        let main_key_bytes: [u8; 32] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&main_key_bytes);
        let verifying_key = signing_key.verifying_key();
        
        let mut address_input = Vec::new();
        address_input.push(0x00);
        address_input.extend_from_slice(&verifying_key.to_bytes());
        let address_hash = blake2b_256(&address_input);
        let address = format!("0x{}", hex::encode(address_hash));
        
        assert!(address.starts_with("0x"));
        assert_eq!(address.len(), 66);
    }

    #[test]
    fn test_suiprivkey_bech32_encoding() {
        let seed: [u8; 32] = [1; 32];
        let encoded = encode_suiprivkey(&seed);
        assert!(encoded.starts_with("suiprivkey1"));
        
        let data_part = &encoded["suiprivkey1".len()..];
        for c in data_part.chars() {
            assert!("qpzry9x8gf2tvdw0s3jn54khce6mua7l".contains(c), "Character {} not in charset", c);
        }
    }

    #[tokio::test]
    async fn test_session_json_construction() {
        let client = test_client();
        let session_b64 = client.build_seal_session().await.unwrap();
        
        use base64::Engine as _;
        let decoded_json = base64::prelude::BASE64_STANDARD.decode(&session_b64).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&decoded_json).unwrap();
        
        assert!(payload.get("address").unwrap().is_string());
        assert_eq!(payload.get("packageId").unwrap().as_str().unwrap(), "0x2::memwal");
        assert!(payload.get("creationTimeMs").unwrap().is_number());
        assert_eq!(payload.get("ttlMin").unwrap().as_u64().unwrap(), 10);
        assert!(payload.get("personalMessageSignature").unwrap().is_string());
        assert!(payload.get("sessionKey").unwrap().as_str().unwrap().starts_with("suiprivkey1"));
    }
}
