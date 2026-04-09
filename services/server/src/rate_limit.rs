use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use crate::types::{AppError, AppState, AuthInfo};

// ============================================================
// Rate Limit Configuration
// ============================================================

#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    // --- Per-account burst window ---
    /// Maximum weighted requests per minute per user (default: 60)
    pub max_requests_per_minute: i64,

    // --- Per-account sustained window ---
    /// Maximum weighted requests per hour per user (default: 500)
    pub max_requests_per_hour: i64,

    // --- Per-delegate-key window ---
    /// Maximum weighted requests per minute per delegate key (default: 30)
    pub max_requests_per_delegate_key: i64,

    // --- Storage quota ---
    /// Maximum storage per user in bytes (default: 1 GB)
    pub max_storage_bytes: i64,

    /// Redis URL (default: redis://localhost:6379)
    pub redis_url: String,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_requests_per_minute: 60,
            max_requests_per_hour: 500,
            max_requests_per_delegate_key: 30,
            max_storage_bytes: 1_073_741_824, // 1 GB
            redis_url: "redis://localhost:6379".to_string(),
        }
    }
}

impl RateLimitConfig {
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(val) = std::env::var("RATE_LIMIT_REQUESTS_PER_MINUTE") {
            if let Ok(n) = val.parse::<i64>() {
                config.max_requests_per_minute = n;
            }
        }

        if let Ok(val) = std::env::var("RATE_LIMIT_REQUESTS_PER_HOUR") {
            if let Ok(n) = val.parse::<i64>() {
                config.max_requests_per_hour = n;
            }
        }

        if let Ok(val) = std::env::var("RATE_LIMIT_DELEGATE_KEY_PER_MINUTE") {
            if let Ok(n) = val.parse::<i64>() {
                config.max_requests_per_delegate_key = n;
            }
        }

        if let Ok(val) = std::env::var("RATE_LIMIT_STORAGE_BYTES") {
            if let Ok(n) = val.parse::<i64>() {
                config.max_storage_bytes = n;
            }
        }

        if let Ok(val) = std::env::var("REDIS_URL") {
            config.redis_url = val;
        }

        config
    }
}

// ============================================================
// Cost Weights — per endpoint
// ============================================================

/// Get the cost weight for a given API path.
///
/// Expensive endpoints (embedding + encrypt + Walrus upload + LLM)
/// consume more of the rate limit budget than cheap read endpoints.
pub const ANALYZE_BASE_WEIGHT: i64 = 10;
const ANALYZE_PER_FACT_WEIGHT: i64 = 2;

pub fn endpoint_weight(path: &str) -> i64 {
    match path {
        "/api/analyze" => ANALYZE_BASE_WEIGHT, // LLM extract + N × (embed + encrypt + upload)
        "/api/remember" => 5,                  // embed + SEAL encrypt + Walrus upload
        "/api/remember/manual" => 3,           // Walrus upload only (client did embed/encrypt)
        "/api/restore" => 3,                   // download + decrypt + re-embed
        "/api/ask" => 2,                       // recall + LLM
        _ => 1,                                // recall, recall/manual, etc.
    }
}

pub fn analyze_total_weight(fact_count: usize) -> i64 {
    ANALYZE_BASE_WEIGHT.max((fact_count as i64) * ANALYZE_PER_FACT_WEIGHT)
}

pub fn analyze_additional_weight(fact_count: usize) -> i64 {
    (analyze_total_weight(fact_count) - ANALYZE_BASE_WEIGHT).max(0)
}

// ============================================================
// Redis Client
// ============================================================

/// Create a Redis multiplexed connection for shared use across the app.
pub async fn create_redis_client(
    redis_url: &str,
) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(redis_url)
        .map_err(|e| format!("Failed to create Redis client: {}", e))?;

    let conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Failed to connect to Redis: {}", e))?;

    Ok(conn)
}

// ============================================================
// Sliding Window Helpers
// ============================================================

/// Check the current count in a Redis sorted set sliding window.
/// Returns the count of entries within the window.
async fn check_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    window_start: f64,
) -> Result<i64, redis::RedisError> {
    let result: ((), i64) = redis::pipe()
        .atomic()
        .zrembyscore(key, 0.0_f64, window_start)
        .zcard(key)
        .query_async(redis)
        .await?;

    Ok(result.1)
}

/// Record weighted entries in a Redis sorted set sliding window.
/// Adds `weight` entries and sets TTL.
async fn record_in_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    now: f64,
    weight: i64,
    ttl_seconds: i64,
) {
    let mut pipe = redis::pipe();
    pipe.atomic();
    for i in 0..weight {
        // Use fractional offsets to create unique members
        let ts = now + i as f64 * 0.001;
        pipe.zadd(key, ts, format!("{}", ts));
    }
    pipe.expire(key, ttl_seconds);

    if let Err(e) = pipe.query_async::<()>(redis).await {
        tracing::warn!("rate limit: failed to record window for key {}: {}", key, e);
    }
}

#[derive(Debug, Clone)]
struct RateLimitKeys {
    delegate_key: String,
    burst_key: String,
    hourly_key: String,
}

fn build_keys(auth: &AuthInfo) -> RateLimitKeys {
    RateLimitKeys {
        delegate_key: format!("rate:dk:{}", auth.public_key),
        burst_key: format!("rate:{}", auth.owner),
        hourly_key: format!("rate:hr:{}", auth.owner),
    }
}

// ============================================================
// Rate Limit Response
// ============================================================

/// Build a 429 response with JSON body and Retry-After header.
fn rate_limit_response(layer: &str, limit: i64, window: &str, retry_after: u64) -> Response {
    let body = serde_json::json!({
        "error": "Rate limit exceeded",
        "layer": layer,
        "limit": format!("{} weighted-requests/{}", limit, window),
        "retry_after_seconds": retry_after,
    });

    axum::response::Response::builder()
        .status(StatusCode::TOO_MANY_REQUESTS)
        .header("Content-Type", "application/json")
        .header("Retry-After", retry_after.to_string())
        .body(axum::body::Body::from(
            serde_json::to_string(&body).unwrap(),
        ))
        .unwrap()
}

fn explicit_rate_limit_error(layer: &str, limit: i64, window: &str) -> AppError {
    AppError::RateLimited(format!(
        "Rate limit exceeded for {} (limit: {} weighted-requests/{})",
        layer, limit, window
    ))
}

async fn check_explicit_weight_inner(
    redis: &mut redis::aio::MultiplexedConnection,
    config: &RateLimitConfig,
    auth: &AuthInfo,
    weight: i64,
    path: &str,
    now: f64,
) -> Result<(), AppError> {
    if weight <= 0 {
        return Ok(());
    }

    let keys = build_keys(auth);
    let dk_window_start = now - 60_000.0;
    match check_window(redis, &keys.delegate_key, dk_window_start).await {
        Ok(count) => {
            if count + weight > config.max_requests_per_delegate_key {
                tracing::warn!(
                    "rate limit [delegate-key]: key={}... count={}/{} additional_weight={} path={}",
                    &auth.public_key[..16],
                    count,
                    config.max_requests_per_delegate_key,
                    weight,
                    path
                );
                return Err(explicit_rate_limit_error(
                    "delegate_key",
                    config.max_requests_per_delegate_key,
                    "min",
                ));
            }
        }
        Err(e) => {
            tracing::error!("redis rate limit check failed (dk): {}", e);
            return Err(AppError::Internal("Rate limiter unavailable".into()));
        }
    }

    let burst_window_start = now - 60_000.0;
    match check_window(redis, &keys.burst_key, burst_window_start).await {
        Ok(count) => {
            if count + weight > config.max_requests_per_minute {
                tracing::warn!(
                    "rate limit [burst]: owner={} count={}/{} additional_weight={} path={}",
                    auth.owner,
                    count,
                    config.max_requests_per_minute,
                    weight,
                    path
                );
                return Err(explicit_rate_limit_error(
                    "account_burst",
                    config.max_requests_per_minute,
                    "min",
                ));
            }
        }
        Err(e) => {
            tracing::error!("redis rate limit check failed (burst): {}", e);
            return Err(AppError::Internal("Rate limiter unavailable".into()));
        }
    }

    let hourly_window_start = now - 3_600_000.0;
    match check_window(redis, &keys.hourly_key, hourly_window_start).await {
        Ok(count) => {
            if count + weight > config.max_requests_per_hour {
                tracing::warn!(
                    "rate limit [sustained]: owner={} count={}/{} additional_weight={} path={}",
                    auth.owner,
                    count,
                    config.max_requests_per_hour,
                    weight,
                    path
                );
                return Err(explicit_rate_limit_error(
                    "account_sustained",
                    config.max_requests_per_hour,
                    "hour",
                ));
            }
        }
        Err(e) => {
            tracing::error!("redis rate limit check failed (sustained): {}", e);
            return Err(AppError::Internal("Rate limiter unavailable".into()));
        }
    }

    Ok(())
}

pub async fn check_explicit_weight(
    state: &AppState,
    auth: &AuthInfo,
    weight: i64,
    path: &str,
) -> Result<(), AppError> {
    let mut redis = state.redis.clone();
    let now = chrono::Utc::now().timestamp_millis() as f64;
    check_explicit_weight_inner(
        &mut redis,
        &state.config.rate_limit,
        auth,
        weight,
        path,
        now,
    )
    .await
}

pub async fn record_explicit_weight(
    state: &AppState,
    auth: &AuthInfo,
    weight: i64,
) -> Result<(), AppError> {
    if weight <= 0 {
        return Ok(());
    }

    let mut redis = state.redis.clone();
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let keys = build_keys(auth);
    record_in_window(&mut redis, &keys.delegate_key, now, weight, 120).await;
    record_in_window(&mut redis, &keys.burst_key, now + 0.1, weight, 120).await;
    record_in_window(&mut redis, &keys.hourly_key, now + 0.2, weight, 3700).await;
    Ok(())
}

pub async fn charge_explicit_weight(
    state: &AppState,
    auth: &AuthInfo,
    weight: i64,
    path: &str,
) -> Result<(), AppError> {
    check_explicit_weight(state, auth, weight, path).await?;
    record_explicit_weight(state, auth, weight).await
}

// ============================================================
// Rate Limit Middleware
// ============================================================

/// Multi-layer rate limiting middleware for authenticated routes.
///
/// Checks 3 layers (all must pass):
/// 1. Per-delegate-key: 30 weighted-req/min (prevents compromised key abuse)
/// 2. Per-account burst: 60 weighted-req/min (prevents spam)
/// 3. Per-account sustained: 500 weighted-req/hour (prevents slow-burn)
///
/// Endpoints are cost-weighted:
///   analyze=10, remember=5, remember/manual=3, restore=3, ask=2, recall=1
///
/// Returns 429 Too Many Requests with JSON body if any layer exceeds its limit.
pub async fn rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    // Extract auth info (set by auth middleware)
    let auth_info = request
        .extensions()
        .get::<crate::types::AuthInfo>()
        .cloned();

    let auth = match auth_info {
        Some(a) => a,
        None => {
            // No auth info = not an authenticated route, skip rate limiting
            return next.run(request).await;
        }
    };

    let config = &state.config.rate_limit;
    let mut redis = state.redis.clone();
    let now = chrono::Utc::now().timestamp_millis() as f64;

    // Determine cost weight based on endpoint
    let weight = endpoint_weight(request.uri().path());

    // --- Layer 1: Per-delegate-key (burst) ---
    let dk_key = format!("rate:dk:{}", auth.public_key);
    let dk_window_start = now - 60_000.0; // 1 min window

    match check_window(&mut redis, &dk_key, dk_window_start).await {
        Ok(count) => {
            if count >= config.max_requests_per_delegate_key {
                tracing::warn!(
                    "rate limit [delegate-key]: key={}... count={}/{} weight={} path={}",
                    &auth.public_key[..16],
                    count,
                    config.max_requests_per_delegate_key,
                    weight,
                    request.uri().path()
                );
                return rate_limit_response(
                    "delegate_key",
                    config.max_requests_per_delegate_key,
                    "min",
                    60,
                );
            }
        }
        Err(e) => {
            tracing::error!("redis rate limit check failed (dk): {}", e);
            return axum::response::Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .header("Content-Type", "application/json")
                .body(axum::body::Body::from(
                    r#"{"error":"Rate limiter unavailable"}"#,
                ))
                .unwrap();
        }
    }

    // --- Layer 2: Per-account burst (1 min) ---
    let burst_key = format!("rate:{}", auth.owner);
    let burst_window_start = now - 60_000.0;

    match check_window(&mut redis, &burst_key, burst_window_start).await {
        Ok(count) => {
            if count >= config.max_requests_per_minute {
                tracing::warn!(
                    "rate limit [burst]: owner={} count={}/{} weight={} path={}",
                    auth.owner,
                    count,
                    config.max_requests_per_minute,
                    weight,
                    request.uri().path()
                );
                return rate_limit_response(
                    "account_burst",
                    config.max_requests_per_minute,
                    "min",
                    60,
                );
            }
        }
        Err(e) => {
            tracing::error!("redis rate limit check failed (burst): {}", e);
            return axum::response::Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .header("Content-Type", "application/json")
                .body(axum::body::Body::from(
                    r#"{"error":"Rate limiter unavailable"}"#,
                ))
                .unwrap();
        }
    }

    // --- Layer 3: Per-account sustained (1 hour) ---
    let hourly_key = format!("rate:hr:{}", auth.owner);
    let hourly_window_start = now - 3_600_000.0;

    match check_window(&mut redis, &hourly_key, hourly_window_start).await {
        Ok(count) => {
            if count >= config.max_requests_per_hour {
                tracing::warn!(
                    "rate limit [sustained]: owner={} count={}/{} weight={} path={}",
                    auth.owner,
                    count,
                    config.max_requests_per_hour,
                    weight,
                    request.uri().path()
                );
                return rate_limit_response(
                    "account_sustained",
                    config.max_requests_per_hour,
                    "hour",
                    300,
                );
            }
        }
        Err(e) => {
            tracing::error!("redis rate limit check failed (sustained): {}", e);
            return axum::response::Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .header("Content-Type", "application/json")
                .body(axum::body::Body::from(
                    r#"{"error":"Rate limiter unavailable"}"#,
                ))
                .unwrap();
        }
    }

    // --- All checks passed: record weighted entries in all 3 windows ---
    record_in_window(&mut redis, &dk_key, now, weight, 120).await; // TTL 2min
    record_in_window(&mut redis, &burst_key, now + 0.1, weight, 120).await; // offset to avoid collision
    record_in_window(&mut redis, &hourly_key, now + 0.2, weight, 3700).await; // TTL ~1hr+buffer

    next.run(request).await
}

// ============================================================
// Storage Quota Check (called from routes, not middleware)
// ============================================================

/// Check if a user has enough storage quota for a new blob.
///
/// Storage tracking still uses PostgreSQL (it's per-row in vector_entries).
/// Returns `Ok(())` if within quota, `Err(AppError::QuotaExceeded)` if not.
pub async fn check_storage_quota(
    state: &AppState,
    owner: &str,
    additional_bytes: i64,
) -> Result<(), AppError> {
    let max_bytes = state.config.rate_limit.max_storage_bytes;

    // 0 or negative means unlimited
    if max_bytes <= 0 {
        return Ok(());
    }

    let used = state.db.get_storage_used(owner).await?;
    let projected = used + additional_bytes;

    if projected > max_bytes {
        let used_mb = used as f64 / 1_048_576.0;
        let max_mb = max_bytes as f64 / 1_048_576.0;
        tracing::warn!(
            "storage quota exceeded: owner={} used={:.1}MB + {:.1}MB > max={:.1}MB",
            owner,
            used_mb,
            additional_bytes as f64 / 1_048_576.0,
            max_mb
        );
        return Err(AppError::QuotaExceeded(format!(
            "Storage quota exceeded: {:.1}MB used of {:.1}MB allowed",
            used_mb, max_mb
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{analyze_additional_weight, analyze_total_weight, ANALYZE_BASE_WEIGHT};

    #[test]
    fn analyze_weight_never_drops_below_base() {
        assert_eq!(analyze_total_weight(0), ANALYZE_BASE_WEIGHT);
        assert_eq!(analyze_total_weight(1), ANALYZE_BASE_WEIGHT);
        assert_eq!(analyze_additional_weight(0), 0);
        assert_eq!(analyze_additional_weight(1), 0);
    }

    #[test]
    fn analyze_weight_scales_with_fact_count() {
        assert_eq!(analyze_total_weight(5), ANALYZE_BASE_WEIGHT);
        assert_eq!(analyze_total_weight(6), 12);
        assert_eq!(analyze_additional_weight(6), 2);
        assert_eq!(analyze_additional_weight(20), 30);
    }
}
