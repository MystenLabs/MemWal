use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use crate::types::{AppError, AppState};

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
///
/// MED-20: Normalize trailing slash before matching to prevent bypass.
fn endpoint_weight(path: &str) -> i64 {
    // MED-20 fix: strip trailing slash so "/api/analyze/" == "/api/analyze"
    let path = path.trim_end_matches('/');
    match path {
        "/api/analyze" => 10,          // LLM extract + N × (embed + encrypt + upload)
        "/api/remember" => 5,          // embed + SEAL encrypt + Walrus upload
        "/api/remember/manual" => 3,   // Walrus upload only (client did embed/encrypt)
        "/api/restore" => 3,           // download + decrypt + re-embed
        "/api/ask" => 2,               // recall + LLM
        _ => 1,                        // recall, recall/manual, etc.
    }
}

// ============================================================
// Redis Client
// ============================================================

/// Create a Redis multiplexed connection for shared use across the app.
pub async fn create_redis_client(redis_url: &str) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(redis_url)
        .map_err(|e| format!("Failed to create Redis client: {}", e))?;

    let conn = client.get_multiplexed_async_connection()
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
///
/// MED-19 fix: uses `.atomic()` (MULTI/EXEC) so the zadd+expire
/// sequence is atomic — no partial write if connection drops mid-way.
async fn record_in_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    now: f64,
    weight: i64,
    ttl_seconds: i64,
) {
    let mut pipe = redis::pipe();
    pipe.atomic(); // MED-19: wrap in MULTI/EXEC
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
        .body(axum::body::Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap()
}

/// Build a 503 response indicating the rate limiter backend is down.
///
/// MED-19 fix: fail-closed — when Redis is unavailable we DENY
/// rather than silently allow (fail-open). Returns 503 with
/// Retry-After header so clients know to back off.
fn rate_limiter_unavailable_response() -> Response {
    let body = serde_json::json!({
        "error": "Rate limiter temporarily unavailable",
        "retry_after_seconds": 5,
    });

    axum::response::Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("Content-Type", "application/json")
        .header("Retry-After", "5")
        .body(axum::body::Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap()
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
///
/// MED-19 fix: Returns 503 Service Unavailable (fail-closed) if Redis
/// is unreachable — previously was fail-open (silently allowed all requests).
///
/// MED-20 fix: Normalizes trailing slash in path before cost weight lookup.
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

    // Determine cost weight based on endpoint (MED-20: path is normalized inside endpoint_weight)
    let weight = endpoint_weight(request.uri().path());

    // --- Layer 1: Per-delegate-key (burst) ---
    let dk_key = format!("rate:dk:{}", auth.public_key);
    let dk_window_start = now - 60_000.0; // 1 min window

    match check_window(&mut redis, &dk_key, dk_window_start).await {
        Ok(count) => {
            if count >= config.max_requests_per_delegate_key {
                tracing::warn!(
                    "rate limit [delegate-key]: key={}... count={}/{} weight={} path={}",
                    &auth.public_key[..16.min(auth.public_key.len())], count,
                    config.max_requests_per_delegate_key, weight, request.uri().path()
                );
                return rate_limit_response("delegate_key", config.max_requests_per_delegate_key, "min", 60);
            }
        }
        Err(e) => {
            // MED-19 fix: fail-closed — Redis error means DENY, not allow
            tracing::error!("rate limit [delegate-key] Redis error: {} — failing closed (503)", e);
            return rate_limiter_unavailable_response();
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
                    auth.owner, count, config.max_requests_per_minute, weight, request.uri().path()
                );
                return rate_limit_response("account_burst", config.max_requests_per_minute, "min", 60);
            }
        }
        Err(e) => {
            // MED-19 fix: fail-closed
            tracing::error!("rate limit [burst] Redis error: {} — failing closed (503)", e);
            return rate_limiter_unavailable_response();
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
                    auth.owner, count, config.max_requests_per_hour, weight, request.uri().path()
                );
                return rate_limit_response("account_sustained", config.max_requests_per_hour, "hour", 300);
            }
        }
        Err(e) => {
            // MED-19 fix: fail-closed
            tracing::error!("rate limit [sustained] Redis error: {} — failing closed (503)", e);
            return rate_limiter_unavailable_response();
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
///
/// MED-21 fix: Uses PostgreSQL advisory lock per-owner to prevent
/// TOCTOU race where concurrent requests all pass quota check then
/// all write, collectively exceeding the limit.
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

    // MED-21 fix: Acquire a per-owner PostgreSQL advisory lock.
    // This serializes concurrent quota checks for the same owner,
    // preventing TOCTOU race conditions.
    // We use a stable hash of the owner string as the lock key.
    let lock_key = stable_hash_i64(owner);
    state.db.acquire_advisory_lock(lock_key).await?;

    let used = state.db.get_storage_used(owner).await?;
    let projected = used + additional_bytes;

    if projected > max_bytes {
        let used_mb = used as f64 / 1_048_576.0;
        let max_mb = max_bytes as f64 / 1_048_576.0;
        tracing::warn!(
            "storage quota exceeded: owner={} used={:.1}MB + {:.1}MB > max={:.1}MB",
            owner, used_mb, additional_bytes as f64 / 1_048_576.0, max_mb
        );
        return Err(AppError::QuotaExceeded(format!(
            "Storage quota exceeded: {:.1}MB used of {:.1}MB allowed",
            used_mb, max_mb
        )));
    }

    Ok(())
}

/// Compute a stable i64 hash of a string for use as PG advisory lock key.
/// Uses FNV-1a (no external dependency needed).
fn stable_hash_i64(s: &str) -> i64 {
    const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
    const FNV_PRIME: u64 = 1_099_511_628_211;

    let hash = s.bytes().fold(FNV_OFFSET, |acc, b| {
        acc.wrapping_mul(FNV_PRIME) ^ b as u64
    });

    // Fold into i64 range (XOR high and low 32 bits)
    ((hash >> 32) ^ (hash & 0xFFFF_FFFF)) as i64
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- MED-20: Path normalization ----

    #[test]
    fn test_endpoint_weight_trailing_slash_normalized() {
        // Without trailing slash
        assert_eq!(endpoint_weight("/api/analyze"), 10);
        assert_eq!(endpoint_weight("/api/remember"), 5);
        assert_eq!(endpoint_weight("/api/remember/manual"), 3);
        assert_eq!(endpoint_weight("/api/restore"), 3);
        assert_eq!(endpoint_weight("/api/ask"), 2);

        // With trailing slash — must return SAME weight (MED-20 fix)
        assert_eq!(endpoint_weight("/api/analyze/"), 10, "trailing slash bypass!");
        assert_eq!(endpoint_weight("/api/remember/"), 5, "trailing slash bypass!");
        assert_eq!(endpoint_weight("/api/ask/"), 2, "trailing slash bypass!");

        // Unknown path → weight 1
        assert_eq!(endpoint_weight("/api/recall"), 1);
        assert_eq!(endpoint_weight("/health"), 1);
        assert_eq!(endpoint_weight("/unknown/path/"), 1);
    }

    #[test]
    fn test_endpoint_weight_no_regression() {
        // Double trailing slash should also normalize
        assert_eq!(endpoint_weight("/api/analyze//"), 10);
    }

    // ---- stable_hash_i64 ----

    #[test]
    fn test_stable_hash_i64_deterministic() {
        let owner = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        let h1 = stable_hash_i64(owner);
        let h2 = stable_hash_i64(owner);
        assert_eq!(h1, h2, "hash must be deterministic");
    }

    #[test]
    fn test_stable_hash_i64_different_owners() {
        let h1 = stable_hash_i64("owner_a");
        let h2 = stable_hash_i64("owner_b");
        assert_ne!(h1, h2, "different owners must produce different lock keys");
    }

    #[test]
    fn test_stable_hash_i64_empty() {
        // Should not panic on empty string
        let h = stable_hash_i64("");
        let _ = h; // just verify no panic
    }

    // ---- MED-19: fail-closed response ----

    #[test]
    fn test_rate_limiter_unavailable_response_is_503() {
        let resp = rate_limiter_unavailable_response();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        // Verify Retry-After header is present
        assert!(resp.headers().contains_key("retry-after"));
    }

    #[test]
    fn test_rate_limit_response_is_429() {
        let resp = rate_limit_response("account_burst", 60, "min", 60);
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(resp.headers().contains_key("retry-after"));
    }
}
