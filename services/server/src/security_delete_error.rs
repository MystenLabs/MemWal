use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{FromRequest, FromRequestParts, Json, Path, Query, Request};
use axum::http::{request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::types::AppError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SdCode {
    AuthChallengeExpired,
    AuthInvalidSignature,
    AuthTokenExpired,
    InvalidRequest,
    ActiveBatchLimit,
    BatchConflict,
    #[allow(dead_code)] // success uses the documented null-batch response, not IntoResponse
    NothingToDelete,
    BatchNotFound,
    BatchAlreadyResolved,
    BatchExpired,
    TxExecutionFailed,
    SponsorFundsUnavailable,
    InvalidSignature,
    RateLimited,
    RpcUnavailable,
    InternalError,
    FeatureDisabled,
}

#[derive(Debug)]
pub struct SdError {
    pub code: SdCode,
    pub message: String,
    pub details: Value,
}

impl SdError {
    pub fn new(code: SdCode, message: &str) -> Self {
        Self::with_details(code, message, json!({}))
    }

    pub fn with_details(code: SdCode, message: &str, details: Value) -> Self {
        Self {
            code,
            message: message.to_owned(),
            details,
        }
    }

    pub fn internal(source: AppError) -> Self {
        let trace_id = crate::observability::current_request_id()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        tracing::error!(trace_id = %trace_id, error = %source, "security-delete internal error");
        Self::with_details(
            SdCode::InternalError,
            "Internal server error",
            json!({"traceId": trace_id}),
        )
    }

    pub fn code_str(&self) -> &'static str {
        use SdCode::*;
        match self.code {
            AuthChallengeExpired => "AUTH_CHALLENGE_EXPIRED",
            AuthInvalidSignature => "AUTH_INVALID_SIGNATURE",
            AuthTokenExpired => "AUTH_TOKEN_EXPIRED",
            InvalidRequest => "INVALID_REQUEST",
            ActiveBatchLimit => "ACTIVE_BATCH_LIMIT",
            BatchConflict => "BATCH_CONFLICT",
            NothingToDelete => "NOTHING_TO_DELETE",
            BatchNotFound => "BATCH_NOT_FOUND",
            BatchAlreadyResolved => "BATCH_ALREADY_RESOLVED",
            BatchExpired => "BATCH_EXPIRED",
            TxExecutionFailed => "TX_EXECUTION_FAILED",
            SponsorFundsUnavailable => "SPONSOR_FUNDS_UNAVAILABLE",
            InvalidSignature => "INVALID_SIGNATURE",
            RateLimited => "RATE_LIMITED",
            RpcUnavailable => "RPC_UNAVAILABLE",
            InternalError => "INTERNAL_ERROR",
            FeatureDisabled => "FEATURE_DISABLED",
        }
    }

    pub fn action(&self) -> &'static str {
        use SdCode::*;
        match self.code {
            AuthChallengeExpired | AuthTokenExpired => "REAUTH",
            ActiveBatchLimit | BatchConflict | NothingToDelete | BatchNotFound
            | BatchAlreadyResolved => "REFETCH",
            BatchExpired | TxExecutionFailed => "RE_PREPARE",
            SponsorFundsUnavailable | RateLimited | RpcUnavailable | InternalError => "RETRY_AFTER",
            AuthInvalidSignature | InvalidRequest | InvalidSignature | FeatureDisabled => "NONE",
        }
    }

    pub fn http_status(&self) -> StatusCode {
        use SdCode::*;
        match self.code {
            AuthChallengeExpired | AuthInvalidSignature | AuthTokenExpired => {
                StatusCode::UNAUTHORIZED
            }
            InvalidRequest | InvalidSignature => StatusCode::BAD_REQUEST,
            ActiveBatchLimit | BatchConflict | BatchAlreadyResolved => StatusCode::CONFLICT,
            NothingToDelete => StatusCode::OK,
            BatchNotFound | FeatureDisabled => StatusCode::NOT_FOUND,
            BatchExpired => StatusCode::GONE,
            TxExecutionFailed => StatusCode::BAD_GATEWAY,
            SponsorFundsUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            RateLimited => StatusCode::TOO_MANY_REQUESTS,
            RpcUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            InternalError => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn retriable(&self) -> bool {
        matches!(
            self.code,
            SdCode::SponsorFundsUnavailable
                | SdCode::RateLimited
                | SdCode::RpcUnavailable
                | SdCode::InternalError
        )
    }

    pub fn to_body_json(&self) -> Value {
        json!({
            "error": {
                "code": self.code_str(),
                "retriable": self.retriable(),
                "action": self.action(),
                "message": self.message,
                "details": self.details,
            }
        })
    }
}

impl IntoResponse for SdError {
    fn into_response(self) -> Response {
        (self.http_status(), Json(self.to_body_json())).into_response()
    }
}

fn invalid_request() -> SdError {
    SdError::new(SdCode::InvalidRequest, "Invalid request")
}

pub struct SdJson<T>(pub T);

impl<S, T> FromRequest<S> for SdJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = SdError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|_rejection: JsonRejection| invalid_request())
    }
}

pub struct SdQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for SdQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = SdError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|_rejection: QueryRejection| invalid_request())
    }
}

pub struct SdBatchId(pub Uuid);

impl<S> FromRequestParts<S> for SdBatchId
where
    S: Send + Sync,
{
    type Rejection = SdError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Path(raw) = Path::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_rejection: PathRejection| invalid_request())?;
        Uuid::parse_str(&raw)
            .map(Self)
            .map_err(|_| invalid_request())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct TestBody {
        #[allow(dead_code)]
        value: String,
    }

    #[test]
    fn security_delete_error_every_code_maps_to_contract() {
        use SdCode::*;
        let cases = [
            (AuthChallengeExpired, 401, "REAUTH", false),
            (AuthInvalidSignature, 401, "NONE", false),
            (AuthTokenExpired, 401, "REAUTH", false),
            (InvalidRequest, 400, "NONE", false),
            (ActiveBatchLimit, 409, "REFETCH", false),
            (BatchConflict, 409, "REFETCH", false),
            (NothingToDelete, 200, "REFETCH", false),
            (BatchNotFound, 404, "REFETCH", false),
            (BatchAlreadyResolved, 409, "REFETCH", false),
            (BatchExpired, 410, "RE_PREPARE", false),
            (TxExecutionFailed, 502, "RE_PREPARE", false),
            (SponsorFundsUnavailable, 503, "RETRY_AFTER", true),
            (InvalidSignature, 400, "NONE", false),
            (RateLimited, 429, "RETRY_AFTER", true),
            (RpcUnavailable, 503, "RETRY_AFTER", true),
            (InternalError, 500, "RETRY_AFTER", true),
            (FeatureDisabled, 404, "NONE", false),
        ];
        for (code, status, action, retriable) in cases {
            let error = SdError::new(code, "message");
            assert_eq!(error.http_status().as_u16(), status);
            assert_eq!(error.action(), action);
            assert_eq!(error.retriable(), retriable);
        }
    }

    #[test]
    fn security_delete_error_envelope_shape_is_stable() {
        let body = SdError::with_details(
            SdCode::BatchConflict,
            "Conflict",
            json!({"conflictingBlobIds": ["b1"]}),
        )
        .to_body_json();
        assert_eq!(body["error"]["code"], "BATCH_CONFLICT");
        assert_eq!(body["error"]["action"], "REFETCH");
        assert_eq!(body["error"]["retriable"], false);
    }

    #[tokio::test]
    async fn security_delete_error_json_rejections_are_closed() {
        let malformed = HttpRequest::builder()
            .header("content-type", "application/json")
            .body(Body::from("{"))
            .unwrap();
        let error = match SdJson::<TestBody>::from_request(malformed, &()).await {
            Ok(_) => panic!("malformed JSON unexpectedly accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, SdCode::InvalidRequest);

        let oversized = HttpRequest::builder()
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"value":"{}"}}"#,
                "x".repeat(3 * 1024 * 1024)
            )))
            .unwrap();
        let error = match SdJson::<TestBody>::from_request(oversized, &()).await {
            Ok(_) => panic!("oversized JSON unexpectedly accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, SdCode::InvalidRequest);
    }
}
