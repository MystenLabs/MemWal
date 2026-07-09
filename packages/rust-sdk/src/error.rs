//! Error types for the Walrus Memory SDK.

use thiserror::Error;

/// Result alias used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Errors returned by the [`crate::WalrusMemory`] client.
#[derive(Debug, Error)]
pub enum Error {
    /// The supplied delegate key was not a valid 32-byte Ed25519 seed.
    #[error("invalid delegate key: {0}")]
    InvalidKey(String),

    /// The configured server URL could not be used to build a request.
    #[error("invalid server url: {0}")]
    InvalidUrl(String),

    /// A transport-level failure (DNS, TLS, connection, timeout).
    #[error("http transport error: {0}")]
    Transport(#[from] reqwest::Error),

    /// Failed to (de)serialize a request or response body.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// The relayer rejected the signed request (HTTP 401).
    ///
    /// Usually means the delegate key is not registered as a delegate of the
    /// account on-chain, the clock is skewed (>5 min), or the nonce was reused.
    #[error("authentication rejected by relayer (401): {message}")]
    AuthRejected { message: String },

    /// The relayer requires a newer SDK (HTTP 426).
    #[error("relayer requires a newer SDK (426): {message}")]
    Incompatible { message: String },

    /// The relayer's `/version` endpoint could not be reached or parsed, or
    /// reported an API version this SDK doesn't support.
    #[error("compatibility check failed: {0}")]
    Compatibility(String),

    /// Building the SEAL session (ephemeral key, Sui personal-message
    /// signing, or relayer `/config` lookup) failed.
    #[error("seal session error: {0}")]
    SealSession(String),

    /// The relayer returned a non-success status with an `{ "error": ... }` body.
    #[error("relayer error (status {status}{}): {message}", code.as_deref().map(|c| format!(", code {c}")).unwrap_or_default())]
    Server {
        /// HTTP status code.
        status: u16,
        /// Optional machine-readable code parsed from the error body.
        code: Option<String>,
        /// Human-readable message parsed from the error body (truncated).
        message: String,
    },

    /// A polled remember job finished in the `failed` state.
    #[error("remember job {job_id} failed: {message}")]
    JobFailed { job_id: String, message: String },

    /// A polled remember job was not found (HTTP 404 / `not_found`).
    #[error("remember job {job_id} not found")]
    JobNotFound { job_id: String },

    /// Polling for a remember job exceeded the configured timeout.
    #[error("remember job {job_id} timed out after {timeout_ms} ms")]
    JobTimeout { job_id: String, timeout_ms: u64 },

    /// A call was made with invalid arguments before any request was sent.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
}
