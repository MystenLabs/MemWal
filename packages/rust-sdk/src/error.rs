#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("HTTP client error: {0}")]
    HttpClient(#[from] reqwest::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Request error (status {status}): {message}")]
    Request {
        status: reqwest::StatusCode,
        message: String,
    },

    #[error("Job failed (job_id={job_id}): {message}")]
    JobFailed {
        job_id: String,
        message: String,
    },

    #[error("Job timed out: {job_id}")]
    JobTimeout {
        job_id: String,
    },

    #[error("Job not found: {job_id}")]
    JobNotFound {
        job_id: String,
    },

    #[error("Cryptography/signing error: {0}")]
    Crypto(String),

    #[error("Compatibility error: {0}")]
    Compatibility(String),
}
