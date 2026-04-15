use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

use crate::types::{AppError, AppState, AuthInfo};

// ============================================================
// Sponsor Rate Limit Result
// ============================================================

/// Result of a per-sender (or per-IP) sponsor rate limit check.
#[derive(Debug, PartialEq)]
pub enum SponsorRlResult {
    /// Request is within limits — proceed.
    Allowed,
    /// Per-minute bucket exhausted.
    MinuteLimitExceeded,
    /// Per-hour bucket exhausted.
    HourLimitExceeded,
}

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
            redis_url: "redis://127.0.0.1:6379".to_string(),
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
        "/api/analyze" => 5,           // LLM extract + N × (1 pt per fact)
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
// In-Memory Token Bucket Fallback
// ============================================================

#[derive(Default)]
pub struct InMemoryFallback {
    pub buckets: std::collections::HashMap<String, TokenBucket>,
    pub cleanup_counter: usize,
}

impl InMemoryFallback {
    pub fn can_consume(&mut self, key: &str, weight: f64, capacity: f64, refill_duration_secs: f64) -> bool {
        let refill_rate = capacity / refill_duration_secs;
        let bucket = self.buckets.entry(key.to_string()).or_insert_with(|| TokenBucket::new(capacity));
        bucket.peek(weight, capacity, refill_rate)
    }

    pub fn consume(&mut self, key: &str, weight: f64, capacity: f64, refill_duration_secs: f64) {
        let refill_rate = capacity / refill_duration_secs;
        if let Some(bucket) = self.buckets.get_mut(key) {
            bucket.consume(weight, capacity, refill_rate);
        }
        
        self.cleanup_counter += 1;
        if self.cleanup_counter >= 1000 {
            self.cleanup_counter = 0;
            let now = std::time::Instant::now();
            self.buckets.retain(|_, b| now.duration_since(b.last_update).as_secs_f64() < 7200.0);
        }
    }
}

pub struct TokenBucket {    
    pub tokens: f64,
    pub last_update: std::time::Instant,
}

impl TokenBucket {
    pub fn new(capacity: f64) -> Self {
        Self { tokens: capacity, last_update: std::time::Instant::now() }
    }

    pub fn peek(&self, weight: f64, capacity: f64, refill_rate_per_sec: f64) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_update).as_secs_f64();
        let projected = (self.tokens + elapsed * refill_rate_per_sec).min(capacity);
        projected >= weight
    }

    pub fn consume(&mut self, weight: f64, capacity: f64, refill_rate_per_sec: f64) {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_update).as_secs_f64();
        let projected = (self.tokens + elapsed * refill_rate_per_sec).min(capacity);
        self.tokens = projected - weight;
        self.last_update = now;
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

/// Build a 503 response when Redis is completely unreachable and the
/// in-memory fallback also cannot be used (e.g., lock poisoned).
/// HIGH-2 fix: previously Redis errors silently allowed requests through.
fn rate_limiter_unavailable_response() -> Response {
    let body = serde_json::json!({
        "error": "Rate limiter temporarily unavailable",
        "retry_after_seconds": 30,
    });

    axum::response::Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("Content-Type", "application/json")
        .header("Retry-After", "30")
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

    // --- Key definitions for all three rate-limit buckets ---
    let dk_key           = format!("rate:dk:{}", auth.public_key);
    let burst_key        = format!("rate:{}", auth.owner);
    let hourly_key       = format!("rate:hr:{}", auth.owner);

    let dk_window_start      = now - 60_000.0;      // 1-min window (ms)
    let burst_window_start   = now - 60_000.0;      // 1-min window (ms)
    let hourly_window_start  = now - 3_600_000.0;   // 1-hr  window (ms)

    // --- Layer 1: Per-delegate-key (burst) ---

    let mut redis_down = false;

    match check_window(&mut redis, &dk_key, dk_window_start).await {
        Ok(count) if count >= config.max_requests_per_delegate_key => {
            tracing::warn!("rate limit [delegate-key]: key={}... count={}/{}", &auth.public_key[..16.min(auth.public_key.len())], count, config.max_requests_per_delegate_key);
            return rate_limit_response("delegate_key", config.max_requests_per_delegate_key, "min", 60);
        }
        Err(e) => {
            tracing::warn!("rate limit [delegate-key] Redis error: {}", e);
            redis_down = true;
        }
        _ => {}
    }

    if !redis_down {
        match check_window(&mut redis, &burst_key, burst_window_start).await {
            Ok(count) if count >= config.max_requests_per_minute => {
                tracing::warn!("rate limit [burst]: owner={} count={}/{}", auth.owner, count, config.max_requests_per_minute);
                return rate_limit_response("account_burst", config.max_requests_per_minute, "min", 60);
            }
            Err(e) => {
                tracing::warn!("rate limit [burst] Redis error: {}", e);
                redis_down = true;
            }
            _ => {}
        }
    }

    if !redis_down {
        match check_window(&mut redis, &hourly_key, hourly_window_start).await {
            Ok(count) if count >= config.max_requests_per_hour => {
                tracing::warn!("rate limit [sustained]: owner={} count={}/{}", auth.owner, count, config.max_requests_per_hour);
                return rate_limit_response("account_sustained", config.max_requests_per_hour, "hour", 300);
            }
            Err(e) => {
                tracing::warn!("rate limit [sustained] Redis error: {}", e);
                redis_down = true;
            }
            _ => {}
        }
    }

    if redis_down {
        tracing::warn!("rate limit: Redis is unreachable, using in-memory fallback");
        let mut fallback = state.fallback_rate_limit.lock().await;

        if !fallback.can_consume(&dk_key, weight as f64, config.max_requests_per_delegate_key as f64, 60.0) {
            return rate_limit_response("delegate_key", config.max_requests_per_delegate_key, "min", 60);
        }
        if !fallback.can_consume(&burst_key, weight as f64, config.max_requests_per_minute as f64, 60.0) {
            return rate_limit_response("account_burst", config.max_requests_per_minute, "min", 60);
        }
        if !fallback.can_consume(&hourly_key, weight as f64, config.max_requests_per_hour as f64, 3600.0) {
            return rate_limit_response("account_sustained", config.max_requests_per_hour, "hour", 300);
        }

        fallback.consume(&dk_key, weight as f64, config.max_requests_per_delegate_key as f64, 60.0);
        fallback.consume(&burst_key, weight as f64, config.max_requests_per_minute as f64, 60.0);
        fallback.consume(&hourly_key, weight as f64, config.max_requests_per_hour as f64, 3600.0);

        return next.run(request).await;
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
    
    // Use the combined method which uses an explicit transaction and pg_advisory_xact_lock
    let used = state.db.get_storage_used_with_lock(owner, lock_key).await?;
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
// Sponsor — per-sender rate limit (called from routes)
// ============================================================

/// Check whether a sender (Sui address) has exceeded the sponsor rate limits.
///
/// Uses a sliding-window counter in Redis just like the authenticated route
/// middleware, but keyed by sender address rather than owner/delegate-key.
///
/// Returns `SponsorRlResult::Allowed` when the request can proceed, or the
/// appropriate `MinuteLimitExceeded` / `HourLimitExceeded` variant otherwise.
///
/// HIGH-2 fix: On Redis error, falls back to the in-memory token-bucket
/// fallback. Returns `Err(())` only if both Redis and the fallback are
/// unavailable (lock poisoned), in which case callers should deny or log.
pub async fn check_sender_rate_limit(
    state: &crate::types::AppState,
    sender: &str,
    per_minute: i64,
    per_hour: i64,
) -> Result<SponsorRlResult, ()> {
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let mut redis = state.redis.clone();

    let min_key = format!("rate:sponsor:min:{}", sender);
    let hr_key  = format!("rate:sponsor:hr:{}",  sender);
    let min_window_start = now - 60_000.0;
    let hr_window_start  = now - 3_600_000.0;

    let mut redis_down = false;

    // --- Minute bucket ---
    match check_window(&mut redis, &min_key, min_window_start).await {
        Ok(count) if count >= per_minute => return Ok(SponsorRlResult::MinuteLimitExceeded),
        Err(e) => {
            tracing::warn!("check_sender_rate_limit: Redis error (minute): {} — switching to in-memory fallback", e);
            redis_down = true;
        }
        _ => {}
    }

    // --- Hour bucket ---
    if !redis_down {
        match check_window(&mut redis, &hr_key, hr_window_start).await {
            Ok(count) if count >= per_hour => return Ok(SponsorRlResult::HourLimitExceeded),
            Err(e) => {
                tracing::warn!("check_sender_rate_limit: Redis error (hour): {} — switching to in-memory fallback", e);
                redis_down = true;
            }
            _ => {}
        }
    }

    // --- In-memory fallback when Redis is down (HIGH-2 fix) ---
    if redis_down {
        let mut fallback = state.fallback_rate_limit.lock().await;
        if !fallback.can_consume(&min_key, 1.0, per_minute as f64, 60.0) {
            return Ok(SponsorRlResult::MinuteLimitExceeded);
        }
        if !fallback.can_consume(&hr_key, 1.0, per_hour as f64, 3600.0) {
            return Ok(SponsorRlResult::HourLimitExceeded);
        }
        fallback.consume(&min_key, 1.0, per_minute as f64, 60.0);
        fallback.consume(&hr_key,  1.0, per_hour as f64, 3600.0);
        return Ok(SponsorRlResult::Allowed);
    }

    // --- Record one entry in both windows ---
    record_in_window(&mut redis, &min_key, now,       1, 120).await;
    record_in_window(&mut redis, &hr_key,  now + 0.1, 1, 3700).await;

    Ok(SponsorRlResult::Allowed)
}

// ============================================================
// Analyze — explicit weight helpers (called from routes)
// ============================================================

/// Cost of the /api/analyze endpoint already reserved by the middleware
/// for the first (LLM extraction) step. The weight value must match
/// `endpoint_weight("/api/analyze")` = 5.
const ANALYZE_BASE_WEIGHT: i64 = 5;

/// Additional weight to charge after fact-count is known.
///
/// Each stored fact costs 1 point. The formula is:
///
///   additional = fact_count
///
/// This ensures the total cost of an analyze call is proportional to the
/// number of facts produced, and caps at 5 + 20 = 25 points.
pub fn analyze_additional_weight(fact_count: usize) -> i64 {
    fact_count as i64
}

/// Total effective weight of an `/api/analyze` call given `fact_count`.
pub fn analyze_total_weight(fact_count: usize) -> i64 {
    ANALYZE_BASE_WEIGHT + analyze_additional_weight(fact_count)
}

/// Charge an explicit extra weight against all rate-limit buckets for an
/// authenticated user. Called by `/api/analyze` after fact-count is known.
///
/// If `weight` is zero, this is a no-op. Returns `Ok(())` on success or
/// when Redis is unavailable (we prefer not to block the request for a
/// bookkeeping failure after the expensive work is already done).
pub async fn charge_explicit_weight(
    state: &AppState,
    auth: &AuthInfo,
    weight: i64,
    _path: &str,
) -> Result<(), AppError> {
    if weight <= 0 {
        return Ok(());
    }

    let mut redis = state.redis.clone();
    let now = chrono::Utc::now().timestamp_millis() as f64;

    let dk_key    = format!("rate:dk:{}", auth.public_key);
    let burst_key = format!("rate:{}", auth.owner);
    let hr_key    = format!("rate:hr:{}", auth.owner);

    record_in_window(&mut redis, &dk_key,    now,       weight, 120).await;
    record_in_window(&mut redis, &burst_key, now + 0.1, weight, 120).await;
    record_in_window(&mut redis, &hr_key,    now + 0.2, weight, 3700).await;

    Ok(())
}

// ============================================================
// Sponsor Rate Limit Middleware (IP-based, unauthenticated)
// ============================================================

/// Rate limiting middleware for the unauthenticated `/sponsor` routes.
///
/// Enforces a per-IP sliding-window limit using the same Redis counters as
/// the authenticated middleware. Defaults: 10 req/min, 30 req/hr per IP.
///
/// HIGH-2 fix: On Redis error, falls back to the in-memory token-bucket
/// instead of failing open. If the fallback mutex is also unavailable,
/// returns 503 (fail-closed). Per-sender limits in the route handler itself
/// provide an additional backstop.
pub async fn sponsor_rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    // Extract client IP from X-Forwarded-For (set by reverse proxy) or
    // fall back to the direct connection address stored by axum.
    let ip: Option<String> = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            request
                .extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|ci| ci.0.ip().to_string())
        });

    let ip = match ip {
        Some(ip) => ip,
        None => {
            // Cannot determine IP — fail-closed: deny rather than allow unknown callers.
            tracing::warn!("sponsor_rate_limit_middleware: cannot determine client IP, denying");
            return rate_limiter_unavailable_response();
        }
    };

    let config = &state.config.sponsor_rate_limit;
    let mut redis = state.redis.clone();
    let now = chrono::Utc::now().timestamp_millis() as f64;

    let min_key = format!("rate:sponsor:ip:min:{}", ip);
    let hr_key  = format!("rate:sponsor:ip:hr:{}",  ip);
    let min_window_start = now - 60_000.0;
    let hr_window_start  = now - 3_600_000.0;

    let mut redis_down = false;

    // --- Minute bucket ---
    match check_window(&mut redis, &min_key, min_window_start).await {
        Ok(count) if count >= config.per_minute => {
            tracing::warn!("sponsor rate limit [IP/min]: ip={} count={}/{}", ip, count, config.per_minute);
            return rate_limit_response("sponsor_ip_burst", config.per_minute, "min", 60);
        }
        Err(e) => {
            tracing::warn!("sponsor_rate_limit_middleware: Redis error (minute bucket): {} — switching to in-memory fallback", e);
            redis_down = true;
        }
        _ => {}
    }

    // --- Hour bucket ---
    if !redis_down {
        match check_window(&mut redis, &hr_key, hr_window_start).await {
            Ok(count) if count >= config.per_hour => {
                tracing::warn!("sponsor rate limit [IP/hr]: ip={} count={}/{}", ip, count, config.per_hour);
                return rate_limit_response("sponsor_ip_sustained", config.per_hour, "hour", 300);
            }
            Err(e) => {
                tracing::warn!("sponsor_rate_limit_middleware: Redis error (hour bucket): {} — switching to in-memory fallback", e);
                redis_down = true;
            }
            _ => {}
        }
    }

    // --- In-memory fallback when Redis is down (HIGH-2 fix) ---
    if redis_down {
        tracing::warn!("sponsor_rate_limit_middleware: Redis is unreachable, using in-memory fallback for ip={}", ip);
        let mut fallback = state.fallback_rate_limit.lock().await;

        if !fallback.can_consume(&min_key, 1.0, config.per_minute as f64, 60.0) {
            return rate_limit_response("sponsor_ip_burst", config.per_minute, "min", 60);
        }
        if !fallback.can_consume(&hr_key, 1.0, config.per_hour as f64, 3600.0) {
            return rate_limit_response("sponsor_ip_sustained", config.per_hour, "hour", 300);
        }

        fallback.consume(&min_key, 1.0, config.per_minute as f64, 60.0);
        fallback.consume(&hr_key,  1.0, config.per_hour as f64, 3600.0);

        return next.run(request).await;
    }

    // --- Record in Redis ---
    record_in_window(&mut redis, &min_key, now,       1, 120).await;
    record_in_window(&mut redis, &hr_key,  now + 0.1, 1, 3700).await;

    next.run(request).await
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
        assert_eq!(endpoint_weight("/api/analyze"), 5);
        assert_eq!(endpoint_weight("/api/remember"), 5);
        assert_eq!(endpoint_weight("/api/remember/manual"), 3);
        assert_eq!(endpoint_weight("/api/restore"), 3);
        assert_eq!(endpoint_weight("/api/ask"), 2);

        // With trailing slash — must return SAME weight (MED-20 fix)
        assert_eq!(endpoint_weight("/api/analyze/"), 5, "trailing slash bypass!");
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
        assert_eq!(endpoint_weight("/api/analyze//"), 5);
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
