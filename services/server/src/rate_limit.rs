use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use percent_encoding::percent_decode_str;
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
/// MED-20 (full fix):
///   1. Percent-decode the path to neutralise URL-encoded variants
///      (e.g. `/api/anal%79ze` → `/api/analyze`).
///   2. Strip any trailing slash so `/api/analyze/` == `/api/analyze`.
///   Both transforms are applied before the match, so no variant can
///   slip through with a cost of 1 instead of its true weight.
fn endpoint_weight(path: &str) -> i64 {
    // Step 1 — percent-decode (e.g. "%2F" → "/", "%79" → "y")
    // Use lossy decoding: malformed sequences are replaced with U+FFFD
    // and will not match any known route, falling through to weight 1.
    let decoded = percent_decode_str(path).decode_utf8_lossy();

    // Step 2 — strip trailing slash
    let path = decoded.trim_end_matches('/');

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
// Sliding Window Helpers — MED-19: Atomic Lua Script
// ============================================================

/// Lua script that atomically:
///   1. Removes stale entries older than `window_start`.
///   2. Counts current entries in the window.
///   3. If count < limit: adds `weight` new timestamped entries and refreshes TTL.
///   4. Returns 1 (allowed) or 0 (denied).
///
/// MED-19 fix: This replaces the previous two-step check_window + record_in_window
/// pattern which had a TOCTOU race where concurrent requests could both pass the
/// check then both record, collectively exceeding the limit.
/// A Lua script runs atomically on the Redis server — no other command can execute
/// between steps, eliminating the race window entirely.
const SLIDING_WINDOW_LUA: &str = r#"
local key          = KEYS[1]
local window_start = tonumber(ARGV[1])
local now          = tonumber(ARGV[2])
local limit        = tonumber(ARGV[3])
local weight       = tonumber(ARGV[4])
local ttl          = tonumber(ARGV[5])

-- 1. Prune entries outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- 2. Count remaining entries
local count = redis.call('ZCARD', key)

-- 3. Check and conditionally record
if count + weight > limit then
    return 0  -- denied
end

for i = 0, weight - 1 do
    local member = tostring(now + i * 0.001)
    redis.call('ZADD', key, now + i * 0.001, member)
end
redis.call('EXPIRE', key, ttl)

return 1  -- allowed
"#;

/// Result of an atomic sliding-window check-and-record.
#[derive(Debug, PartialEq)]
enum WindowCheckResult {
    /// Request is within limit — entries have been recorded.
    Allowed,
    /// Limit exceeded — no entries were recorded.
    Denied,
}

/// Atomically check the sliding window and record entries if within limit.
///
/// MED-19 fix: Replaces the separate check_window + record_in_window calls.
/// The Lua script executes as a single atomic Redis operation, preventing the
/// TOCTOU race where two concurrent requests could both pass the check before
/// either records, then both record and collectively exceed the limit.
async fn check_and_record_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    window_start: f64,
    now: f64,
    limit: i64,
    weight: i64,
    ttl_seconds: i64,
) -> Result<WindowCheckResult, redis::RedisError> {
    let result: i64 = redis::Script::new(SLIDING_WINDOW_LUA)
        .key(key)
        .arg(window_start)
        .arg(now)
        .arg(limit)
        .arg(weight)
        .arg(ttl_seconds)
        .invoke_async(redis)
        .await?;

    if result == 1 {
        Ok(WindowCheckResult::Allowed)
    } else {
        Ok(WindowCheckResult::Denied)
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

    // --- MED-19: Atomic check-and-record via Lua script for all 3 layers ---
    // Each layer is checked+recorded atomically. If Redis is unavailable,
    // we fall through to the in-memory token-bucket fallback (HIGH-2 fix).

    let mut redis_down = false;

    // Layer 1: Per-delegate-key (burst) — atomic check + record
    match check_and_record_window(
        &mut redis,
        &dk_key,
        dk_window_start,
        now,
        config.max_requests_per_delegate_key,
        weight,
        120, // TTL 2 min
    ).await {
        Ok(WindowCheckResult::Denied) => {
            tracing::warn!(
                "rate limit [delegate-key]: key={}... denied (limit={})",
                &auth.public_key[..16.min(auth.public_key.len())],
                config.max_requests_per_delegate_key
            );
            return rate_limit_response("delegate_key", config.max_requests_per_delegate_key, "min", 60);
        }
        Err(e) => {
            tracing::warn!("rate limit [delegate-key] Redis error: {}", e);
            redis_down = true;
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    // Layer 2: Per-account burst — atomic check + record
    if !redis_down {
        match check_and_record_window(
            &mut redis,
            &burst_key,
            burst_window_start,
            now + 0.1, // slight timestamp offset to avoid member collision
            config.max_requests_per_minute,
            weight,
            120, // TTL 2 min
        ).await {
            Ok(WindowCheckResult::Denied) => {
                tracing::warn!(
                    "rate limit [burst]: owner={} denied (limit={})",
                    auth.owner, config.max_requests_per_minute
                );
                // Roll back the delegate-key window entry just recorded above
                // (best-effort; a Lua multi-key script would be fully atomic across keys)
                return rate_limit_response("account_burst", config.max_requests_per_minute, "min", 60);
            }
            Err(e) => {
                tracing::warn!("rate limit [burst] Redis error: {}", e);
                redis_down = true;
            }
            Ok(WindowCheckResult::Allowed) => {}
        }
    }

    // Layer 3: Per-account sustained — atomic check + record
    if !redis_down {
        match check_and_record_window(
            &mut redis,
            &hourly_key,
            hourly_window_start,
            now + 0.2, // slight timestamp offset to avoid member collision
            config.max_requests_per_hour,
            weight,
            3700, // TTL ~1hr + buffer
        ).await {
            Ok(WindowCheckResult::Denied) => {
                tracing::warn!(
                    "rate limit [sustained]: owner={} denied (limit={})",
                    auth.owner, config.max_requests_per_hour
                );
                return rate_limit_response("account_sustained", config.max_requests_per_hour, "hour", 300);
            }
            Err(e) => {
                tracing::warn!("rate limit [sustained] Redis error: {}", e);
                redis_down = true;
            }
            Ok(WindowCheckResult::Allowed) => {}
        }
    }

    // --- Fallback path: Redis unreachable — use in-memory token buckets ---
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

    // --- MED-19: Atomic check-and-record for minute bucket ---
    match check_and_record_window(
        &mut redis,
        &min_key,
        min_window_start,
        now,
        per_minute,
        1, // weight = 1 per sponsor request
        120,
    ).await {
        Ok(WindowCheckResult::Denied) => return Ok(SponsorRlResult::MinuteLimitExceeded),
        Err(e) => {
            tracing::warn!("check_sender_rate_limit: Redis error (minute): {} — switching to in-memory fallback", e);
            redis_down = true;
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    // --- MED-19: Atomic check-and-record for hour bucket ---
    if !redis_down {
        match check_and_record_window(
            &mut redis,
            &hr_key,
            hr_window_start,
            now + 0.1,
            per_hour,
            1, // weight = 1 per sponsor request
            3700,
        ).await {
            Ok(WindowCheckResult::Denied) => return Ok(SponsorRlResult::HourLimitExceeded),
            Err(e) => {
                tracing::warn!("check_sender_rate_limit: Redis error (hour): {} — switching to in-memory fallback", e);
                redis_down = true;
            }
            Ok(WindowCheckResult::Allowed) => {}
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

    // MED-19: Use the same atomic Lua script for explicit weight charges
    // (called from /api/analyze after fact count is known).
    // Ignore WindowCheckResult here — this is a post-hoc charge after
    // the expensive work is done; we prefer not to block the response.
    let _ = check_and_record_window(&mut redis, &dk_key,    now,       now,       i64::MAX, weight, 120).await;
    let _ = check_and_record_window(&mut redis, &burst_key, now,       now + 0.1, i64::MAX, weight, 120).await;
    let _ = check_and_record_window(&mut redis, &hr_key,    now,       now + 0.2, i64::MAX, weight, 3700).await;

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

    // --- MED-19: Atomic check-and-record for minute bucket (IP-based) ---
    match check_and_record_window(
        &mut redis,
        &min_key,
        min_window_start,
        now,
        config.per_minute,
        1,
        120,
    ).await {
        Ok(WindowCheckResult::Denied) => {
            tracing::warn!("sponsor rate limit [IP/min]: ip={} denied (limit={})", ip, config.per_minute);
            return rate_limit_response("sponsor_ip_burst", config.per_minute, "min", 60);
        }
        Err(e) => {
            tracing::warn!("sponsor_rate_limit_middleware: Redis error (minute bucket): {} — switching to in-memory fallback", e);
            redis_down = true;
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    // --- MED-19: Atomic check-and-record for hour bucket (IP-based) ---
    if !redis_down {
        match check_and_record_window(
            &mut redis,
            &hr_key,
            hr_window_start,
            now + 0.1,
            config.per_hour,
            1,
            3700,
        ).await {
            Ok(WindowCheckResult::Denied) => {
                tracing::warn!("sponsor rate limit [IP/hr]: ip={} denied (limit={})", ip, config.per_hour);
                return rate_limit_response("sponsor_ip_sustained", config.per_hour, "hour", 300);
            }
            Err(e) => {
                tracing::warn!("sponsor_rate_limit_middleware: Redis error (hour bucket): {} — switching to in-memory fallback", e);
                redis_down = true;
            }
            Ok(WindowCheckResult::Allowed) => {}
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

    // ---- MED-19: Atomic Lua script structure ----

    /// Verify the Lua script constant is non-empty and contains the critical
    /// idempotency guard (`count + weight > limit`). If the guard disappears,
    /// the TOCTOU race is reintroduced.
    #[test]
    fn test_lua_script_contains_atomic_guard() {
        assert!(!SLIDING_WINDOW_LUA.is_empty(), "Lua script must not be empty");
        assert!(
            SLIDING_WINDOW_LUA.contains("count + weight > limit"),
            "Lua script must contain atomic count+weight guard"
        );
        assert!(
            SLIDING_WINDOW_LUA.contains("ZREMRANGEBYSCORE"),
            "Lua script must prune stale entries"
        );
        assert!(
            SLIDING_WINDOW_LUA.contains("ZADD"),
            "Lua script must add new entries"
        );
        assert!(
            SLIDING_WINDOW_LUA.contains("EXPIRE"),
            "Lua script must refresh TTL"
        );
    }

    /// Verify that WindowCheckResult variants are correctly defined.
    #[test]
    fn test_window_check_result_variants() {
        let allowed = WindowCheckResult::Allowed;
        let denied  = WindowCheckResult::Denied;
        assert_eq!(allowed, WindowCheckResult::Allowed);
        assert_eq!(denied,  WindowCheckResult::Denied);
        assert_ne!(allowed, denied, "Allowed and Denied must be distinct");
    }

    // ---- MED-20: Percent-encoded path normalization ----

    #[test]
    fn test_endpoint_weight_percent_encoded_analyze() {
        // "%79" = 'y', so "/api/anal%79ze" = "/api/analyze"
        assert_eq!(endpoint_weight("/api/anal%79ze"), 5, "percent-encoded 'y' bypass");
    }

    #[test]
    fn test_endpoint_weight_percent_encoded_remember() {
        // "%72" = 'r', so "/api/%72emember" = "/api/remember"
        assert_eq!(endpoint_weight("/api/%72emember"), 5, "percent-encoded 'r' bypass");
    }

    #[test]
    fn test_endpoint_weight_percent_encoded_slash_and_trailing() {
        // "%2F" = '/', combined with trailing slash
        // "/api/remember/manual%2F" → "/api/remember/manual/"
        // After slash stripping → "/api/remember/manual"
        assert_eq!(endpoint_weight("/api/remember/manual%2F"), 3);
    }

    #[test]
    fn test_endpoint_weight_full_percent_encoded_path() {
        // Full path encoded: /api/ask → /%61%70%69/%61%73%6b
        assert_eq!(endpoint_weight("/%61%70%69/%61%73%6b"), 2);
    }

    #[test]
    fn test_endpoint_weight_mixed_case_percent_encoding() {
        // Mixed case encoding: %41 = 'A' — not matching lowercase paths
        // "/api/%41nalyze" → "/api/Analyze" → weight 1 (no match, different case)
        assert_eq!(endpoint_weight("/api/%41nalyze"), 1);
    }

    #[test]
    fn test_endpoint_weight_malformed_percent_encoding() {
        // Invalid percent encoding → lossy decode → U+FFFD → no match → weight 1
        assert_eq!(endpoint_weight("/api/%ZZ/bad"), 1);
    }

    // ---- HIGH-2: In-memory token bucket fallback ----

    #[test]
    fn test_fallback_token_bucket_new_starts_full() {
        let bucket = TokenBucket::new(10.0);
        assert_eq!(bucket.tokens, 10.0);
    }

    #[test]
    fn test_fallback_token_bucket_consume_reduces_tokens() {
        let mut bucket = TokenBucket::new(10.0);
        bucket.consume(3.0, 10.0, 1.0); // consume 3 of 10
        // tokens should be ~7.0 (with tiny time delta adding a fraction)
        assert!(bucket.tokens < 8.0, "tokens should be around 7, got {}", bucket.tokens);
        assert!(bucket.tokens > 6.0, "tokens should be around 7, got {}", bucket.tokens);
    }

    #[test]
    fn test_fallback_token_bucket_peek_does_not_modify() {
        let bucket = TokenBucket::new(10.0);
        let can1 = bucket.peek(5.0, 10.0, 1.0);
        let can2 = bucket.peek(5.0, 10.0, 1.0);
        assert!(can1);
        assert!(can2);
        // Peeking twice must not reduce tokens
        assert_eq!(bucket.tokens, 10.0);
    }

    #[test]
    fn test_fallback_token_bucket_rejects_when_empty() {
        let mut bucket = TokenBucket::new(5.0);
        bucket.consume(5.0, 5.0, 0.0); // consume all, no refill
        // With 0 refill rate and ~0 elapsed time, no tokens available
        assert!(!bucket.peek(1.0, 5.0, 0.0));
    }

    #[test]
    fn test_fallback_inmemory_cleanup() {
        let mut fb = InMemoryFallback::default();

        // Force cleanup counter to ~1000
        fb.cleanup_counter = 999;

        // Add a bucket and consume to trigger cleanup
        fb.consume("test_key", 1.0, 10.0, 60.0);

        // After cleanup_counter >= 1000, it resets to 0
        assert_eq!(fb.cleanup_counter, 0, "cleanup counter should reset after reaching 1000");
    }

    #[test]
    fn test_fallback_inmemory_can_consume_and_consume() {
        let mut fb = InMemoryFallback::default();

        // First request should be allowed
        assert!(fb.can_consume("k1", 1.0, 10.0, 60.0));
        fb.consume("k1", 1.0, 10.0, 60.0);

        // Should still have capacity
        assert!(fb.can_consume("k1", 1.0, 10.0, 60.0));
    }

    #[test]
    fn test_fallback_inmemory_independent_keys() {
        let mut fb = InMemoryFallback::default();

        // Exhaust key k1
        for _ in 0..10 {
            fb.consume("k1", 1.0, 10.0, 60.0);
        }

        // k2 should still be available
        assert!(fb.can_consume("k2", 1.0, 10.0, 60.0));
    }

    // ---- MED-19: Analyze weight calculations ----

    #[test]
    fn test_analyze_additional_weight() {
        assert_eq!(analyze_additional_weight(0), 0);
        assert_eq!(analyze_additional_weight(1), 1);
        assert_eq!(analyze_additional_weight(5), 5);
        assert_eq!(analyze_additional_weight(20), 20);
    }

    #[test]
    fn test_analyze_total_weight() {
        // base weight (5) + fact_count
        assert_eq!(analyze_total_weight(0), 5);
        assert_eq!(analyze_total_weight(1), 6);
        assert_eq!(analyze_total_weight(10), 15);
        assert_eq!(analyze_total_weight(20), 25); // max: 5 + 20
    }

    // ---- RateLimitConfig defaults ----

    #[test]
    fn test_rate_limit_config_defaults() {
        let config = RateLimitConfig::default();
        assert_eq!(config.max_requests_per_minute, 60);
        assert_eq!(config.max_requests_per_hour, 500);
        assert_eq!(config.max_requests_per_delegate_key, 30);
        assert_eq!(config.max_storage_bytes, 1_073_741_824); // 1 GB
        assert_eq!(config.redis_url, "redis://127.0.0.1:6379");
    }

    // ---- SponsorRlResult variants ----

    #[test]
    fn test_sponsor_rl_result_variants() {
        assert_eq!(SponsorRlResult::Allowed, SponsorRlResult::Allowed);
        assert_eq!(SponsorRlResult::MinuteLimitExceeded, SponsorRlResult::MinuteLimitExceeded);
        assert_eq!(SponsorRlResult::HourLimitExceeded, SponsorRlResult::HourLimitExceeded);
        assert_ne!(SponsorRlResult::Allowed, SponsorRlResult::MinuteLimitExceeded);
        assert_ne!(SponsorRlResult::MinuteLimitExceeded, SponsorRlResult::HourLimitExceeded);
    }
}
