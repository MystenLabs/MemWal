use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use percent_encoding::percent_decode_str;
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    client_ip::canonical_client_ip,
    types::{AppError, AppState, AuthInfo},
};

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

    /// Bypass all request-rate buckets (per-key, per-account burst/sustained,
    /// sponsor IP+sender) when set. Storage quota and auth still apply.
    /// Off unless `RATE_LIMIT_DISABLED=1` (or `true`) is set; intended only
    /// for localhost benchmarks. Logs a loud warning at startup when on.
    pub bench_bypass_enabled: bool,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_requests_per_minute: 60,
            max_requests_per_hour: 500,
            max_requests_per_delegate_key: 30,
            max_storage_bytes: 1_073_741_824, // 1 GB
            redis_url: "redis://127.0.0.1:6379".to_string(),
            bench_bypass_enabled: false,
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

        // Accepted: "1" or "true" (case-insensitive). Anything else,
        // including unset, leaves the limiter active.
        if let Ok(val) = std::env::var("RATE_LIMIT_DISABLED") {
            config.bench_bypass_enabled = val == "1" || val.eq_ignore_ascii_case("true");
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
/// Endpoint weight normalization:
///   1. Percent-decode the path to neutralise URL-encoded variants
///      (e.g. `/api/anal%79ze` → `/api/analyze`).
///   2. Strip any trailing slash so `/api/analyze/` == `/api/analyze`.
///      Both transforms are applied before the match, so no variant can
///      slip through with a cost of 1 instead of its true weight.
fn endpoint_weight(path: &str) -> i64 {
    // Step 1 — percent-decode (e.g. "%2F" → "/", "%79" → "y")
    // Use lossy decoding: malformed sequences are replaced with U+FFFD
    // and will not match any known route, falling through to weight 1.
    let decoded = percent_decode_str(path).decode_utf8_lossy();

    // Step 2 — strip trailing slash
    let path = decoded.trim_end_matches('/');

    match path {
        "/api/analyze" => 5,         // LLM extract + N × (1 pt per fact)
        "/api/remember" => 5,        // embed + SEAL encrypt + Walrus upload
        "/api/remember/bulk" => 10,  // N × embed/encrypt/upload in one request
        "/api/remember/manual" => 3, // Walrus upload only (client did embed/encrypt)
        "/api/restore" => 3,         // download + decrypt + re-embed
        "/api/ask" => 2,             // recall + LLM
        _ => 1,                      // recall, recall/manual, etc.
    }
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
// Sliding Window Helpers — Atomic Lua Script
// ============================================================

/// Lua script that atomically:
///   1. Removes stale entries older than `window_start`.
///   2. Counts current entries in the window.
///   3. If count < limit: adds `weight` new timestamped entries and refreshes TTL.
///   4. Returns 1 (allowed) or 0 (denied).
///
/// This replaces the previous two-step check_window + record_in_window
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
local request_id   = ARGV[6]

-- 1. Prune entries outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- 2. Count remaining entries
local count = redis.call('ZCARD', key)

-- 3. Check and conditionally record
if count + weight > limit then
    return 0  -- denied
end

for i = 0, weight - 1 do
    -- ZSET members, unlike scores, must be unique. A timestamp-only member
    -- collapses concurrent requests that arrive in the same millisecond.
    local member = request_id .. ':' .. tostring(i)
    redis.call('ZADD', key, now, member)
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
/// Replaces the separate check_window + record_in_window calls.
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
    // The UUID keeps members distinct across concurrent requests, processes,
    // and replicas even when they share an identical millisecond timestamp.
    let request_id = Uuid::new_v4().to_string();
    let result: i64 = redis::Script::new(SLIDING_WINDOW_LUA)
        .key(key)
        .arg(window_start)
        .arg(now)
        .arg(limit)
        .arg(weight)
        .arg(ttl_seconds)
        .arg(request_id)
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
    pub fn can_consume(
        &mut self,
        key: &str,
        weight: f64,
        capacity: f64,
        refill_duration_secs: f64,
    ) -> bool {
        let refill_rate = capacity / refill_duration_secs;
        let bucket = self
            .buckets
            .entry(key.to_string())
            .or_insert_with(|| TokenBucket::new(capacity));
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
            self.buckets
                .retain(|_, b| now.duration_since(b.last_update).as_secs_f64() < 7200.0);
        }
    }
}

pub struct TokenBucket {
    pub tokens: f64,
    pub last_update: std::time::Instant,
}

impl TokenBucket {
    pub fn new(capacity: f64) -> Self {
        Self {
            tokens: capacity,
            last_update: std::time::Instant::now(),
        }
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
    crate::observability::record_rate_limit_denial(layer);
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

/// Build a 503 response when Redis is completely unreachable and the
/// in-memory fallback also cannot be used (e.g., lock poisoned).
/// previously Redis errors silently allowed requests through.
fn rate_limiter_unavailable_response() -> Response {
    crate::observability::record_app_error("rate_limiter_unavailable");
    let body = serde_json::json!({
        "error": "Rate limiter temporarily unavailable",
        "retry_after_seconds": 30,
    });

    axum::response::Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("Content-Type", "application/json")
        .header("Retry-After", "30")
        .body(axum::body::Body::from(
            serde_json::to_string(&body).unwrap(),
        ))
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
/// Returns 503 Service Unavailable (fail-closed) if Redis
/// is unreachable — previously was fail-open (silently allowed all requests).
///
/// Normalizes trailing slash in path before cost weight lookup.
pub async fn rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    // RATE_LIMIT_DISABLED=1 — see RateLimitConfig::bench_bypass_enabled.
    if state.config.rate_limit.bench_bypass_enabled {
        return next.run(request).await;
    }

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

    // Determine cost weight based on endpoint; path is normalized inside endpoint_weight.
    let weight = endpoint_weight(request.uri().path());

    // --- Key definitions for all three rate-limit buckets ---
    let dk_key = format!("rate:dk:{}", auth.public_key);
    let burst_key = format!("rate:{}", auth.owner);
    let hourly_key = format!("rate:hr:{}", auth.owner);

    let dk_window_start = now - 60_000.0; // 1-min window (ms)
    let burst_window_start = now - 60_000.0; // 1-min window (ms)
    let hourly_window_start = now - 3_600_000.0; // 1-hr  window (ms)

    // --- Atomic check-and-record via Lua script for all 3 layers ---
    // Each layer is checked+recorded atomically. If Redis is unavailable,
    // we fall through to the in-memory token-bucket fallback.

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
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            tracing::warn!(
                "rate limit [delegate-key]: key={}... denied (limit={})",
                &auth.public_key[..16.min(auth.public_key.len())],
                config.max_requests_per_delegate_key
            );
            return rate_limit_response(
                "delegate_key",
                config.max_requests_per_delegate_key,
                "min",
                60,
            );
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
        )
        .await
        {
            Ok(WindowCheckResult::Denied) => {
                tracing::warn!(
                    "rate limit [burst]: owner={} denied (limit={})",
                    auth.owner,
                    config.max_requests_per_minute
                );
                // Roll back the delegate-key window entry just recorded above
                // (best-effort; a Lua multi-key script would be fully atomic across keys)
                return rate_limit_response(
                    "account_burst",
                    config.max_requests_per_minute,
                    "min",
                    60,
                );
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
        )
        .await
        {
            Ok(WindowCheckResult::Denied) => {
                tracing::warn!(
                    "rate limit [sustained]: owner={} denied (limit={})",
                    auth.owner,
                    config.max_requests_per_hour
                );
                return rate_limit_response(
                    "account_sustained",
                    config.max_requests_per_hour,
                    "hour",
                    300,
                );
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
        crate::observability::record_rate_limit_fallback("authenticated");
        let mut fallback = state.fallback_rate_limit.lock().await;

        if !fallback.can_consume(
            &dk_key,
            weight as f64,
            config.max_requests_per_delegate_key as f64,
            60.0,
        ) {
            return rate_limit_response(
                "delegate_key",
                config.max_requests_per_delegate_key,
                "min",
                60,
            );
        }
        if !fallback.can_consume(
            &burst_key,
            weight as f64,
            config.max_requests_per_minute as f64,
            60.0,
        ) {
            return rate_limit_response("account_burst", config.max_requests_per_minute, "min", 60);
        }
        if !fallback.can_consume(
            &hourly_key,
            weight as f64,
            config.max_requests_per_hour as f64,
            3600.0,
        ) {
            return rate_limit_response(
                "account_sustained",
                config.max_requests_per_hour,
                "hour",
                300,
            );
        }

        fallback.consume(
            &dk_key,
            weight as f64,
            config.max_requests_per_delegate_key as f64,
            60.0,
        );
        fallback.consume(
            &burst_key,
            weight as f64,
            config.max_requests_per_minute as f64,
            60.0,
        );
        fallback.consume(
            &hourly_key,
            weight as f64,
            config.max_requests_per_hour as f64,
            3600.0,
        );

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
/// Uses PostgreSQL advisory lock per-owner to prevent
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

    // Acquire a per-owner PostgreSQL advisory lock.
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

/// Compute a stable i64 hash of a string for use as PG advisory lock key.
/// Uses FNV-1a (no external dependency needed).
fn stable_hash_i64(s: &str) -> i64 {
    const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
    const FNV_PRIME: u64 = 1_099_511_628_211;

    let hash = s
        .bytes()
        .fold(FNV_OFFSET, |acc, b| acc.wrapping_mul(FNV_PRIME) ^ b as u64);

    // Fold into i64 range (XOR high and low 32 bits)
    ((hash >> 32) ^ (hash & 0xFFFF_FFFF)) as i64
}

// ============================================================
// Restore — owner-scoped call-frequency guard (GH #501 / WALM-299)
// ============================================================

/// Bound how often a single owner can call `/api/restore`.
///
/// `/api/restore` already rides the generic weighted account limiter
/// (`rate_limit_middleware`, weight 3), but that budget is shared across
/// every endpoint and flat regardless of per-call blob volume — it does not
/// specifically bound "attacker keeps transferring a fresh junk blob_id,
/// costing one new first-time-discovery download+decrypt per call". This is
/// a dedicated, owner-keyed guard on top, reusing the same atomic
/// sliding-window primitive the account limiter already uses.
///
/// Deliberately keyed only by `owner` + call frequency — this guard itself
/// does not inspect, record, or reason about who created/uploaded/relayed
/// any blob (see GH #501: Henry explicitly rejected an uploader/relayer
/// allowlist as *this* guard's fix direction). A separate mechanism,
/// `verifyBlobUploaderProvenance` in the sidecar's `walrus-query.ts`, does
/// check uploader provenance upstream of this — see that function's
/// doc-comment for why it exists independently of the decision made here.
///
/// Fails OPEN (logs a warning and allows the call) on a Redis error,
/// consistent with `rate_limit_middleware`'s graceful-degrade philosophy for
/// authenticated routes — `restore()` runs after auth, so an unreachable
/// Redis should not lock a legitimate user out of their own memories.
/// (Contrast with `sponsor_rate_limit_middleware`, which fails closed
/// because it guards the unauthenticated, deployment-wide sponsor budget.)
///
/// Shared "single-window, per-key" wrapper around `check_and_record_window`:
/// classifies the result, records the denial metric, logs, and fails open on
/// a Redis error. Factored out so a caller like
/// `check_restore_call_rate_limit` doesn't hand-copy the
/// check/log/fail-open boilerplate that already exists inline in
/// `rate_limit_middleware`'s per-account layer and in the global
/// sponsor/account limiters below.
async fn check_owner_window_limit(
    redis: &mut redis::aio::MultiplexedConnection,
    scope: &str,
    key: &str,
    window_start: f64,
    now: f64,
    limit: i64,
    weight: i64,
    ttl_seconds: i64,
    owner: &str,
    deny_message: impl FnOnce() -> String,
) -> Result<(), AppError> {
    match check_and_record_window(redis, key, window_start, now, limit, weight, ttl_seconds).await {
        Ok(WindowCheckResult::Denied) => {
            crate::observability::record_rate_limit_denial(scope);
            tracing::warn!(
                "rate limit [{}]: owner={} denied (limit={}/min)",
                scope,
                owner,
                limit
            );
            Err(AppError::RateLimited(deny_message()))
        }
        Ok(WindowCheckResult::Allowed) => Ok(()),
        Err(e) => {
            tracing::warn!("rate limit [{}] Redis error, failing open: {}", scope, e);
            Ok(())
        }
    }
}

/// `restore_requests_per_owner_per_minute == 0` disables the guard.
pub(crate) async fn check_restore_call_rate_limit(
    state: &crate::types::AppState,
    owner: &str,
) -> Result<(), AppError> {
    let limit = state.config.restore_requests_per_owner_per_minute;
    if limit == 0 {
        return Ok(());
    }

    let mut redis = state.redis.clone();
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let key = format!("rate:restore-call:{owner}");
    let window_start = now - 60_000.0; // 1-min window (ms)

    check_owner_window_limit(
        &mut redis,
        "restore_call",
        &key,
        window_start,
        now,
        limit as i64,
        1,   // weight = 1 per restore() call
        120, // TTL 2 min
        owner,
        || format!("restore called too frequently; limit is {} calls/min", limit),
    )
    .await
}

// ============================================================
// Sponsor — deployment-wide budget limit
// ============================================================

/// Check whether the deployment has exceeded its sponsor budget limits.
///
/// Uses a sliding-window counter in Redis just like the authenticated route
/// middleware, but keyed by fixed server-controlled identifiers. Unlike a
/// caller-supplied sender address, these keys cannot be rotated by an attacker.
///
/// Returns `SponsorRlResult::Allowed` when the request can proceed, or the
/// appropriate `MinuteLimitExceeded` / `HourLimitExceeded` variant otherwise.
///
/// Returns `Err(())` on Redis failure so callers can fail closed. A per-process
/// fallback would not enforce a deployment-wide cap across replicas.
pub async fn check_global_sponsor_rate_limit(
    state: &crate::types::AppState,
    per_minute: i64,
    per_hour: i64,
) -> Result<SponsorRlResult, ()> {
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let mut redis = state.redis.clone();

    let min_key = "rate:sponsor:global:min";
    let hr_key = "rate:sponsor:global:hr";
    let min_window_start = now - 60_000.0;
    let hr_window_start = now - 3_600_000.0;

    // --- Atomic check-and-record for minute bucket ---
    match check_and_record_window(
        &mut redis,
        &min_key,
        min_window_start,
        now,
        per_minute,
        1, // weight = 1 per sponsor request
        120,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            crate::observability::record_rate_limit_denial("sponsor_global_burst");
            return Ok(SponsorRlResult::MinuteLimitExceeded);
        }
        Err(e) => {
            tracing::error!(
                "check_global_sponsor_rate_limit: Redis error (minute): {}",
                e
            );
            return Err(());
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    // --- Atomic check-and-record for hour bucket ---
    match check_and_record_window(
        &mut redis,
        &hr_key,
        hr_window_start,
        now + 0.1,
        per_hour,
        1, // weight = 1 per sponsor request
        3700,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            crate::observability::record_rate_limit_denial("sponsor_global_sustained");
            return Ok(SponsorRlResult::HourLimitExceeded);
        }
        Err(e) => {
            tracing::error!("check_global_sponsor_rate_limit: Redis error (hour): {}", e);
            return Err(());
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    Ok(SponsorRlResult::Allowed)
}

// ============================================================
// Analyze — explicit weight helpers (called from routes)
// ============================================================

/// Cost of the /api/analyze endpoint already reserved by the middleware
/// for the first (LLM extraction) step. The weight value must match
/// `endpoint_weight("/api/analyze")` = 5.
#[allow(dead_code)]
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
#[allow(dead_code)]
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

    let dk_key = format!("rate:dk:{}", auth.public_key);
    let burst_key = format!("rate:{}", auth.owner);
    let hr_key = format!("rate:hr:{}", auth.owner);

    // Use the same atomic Lua script for explicit weight charges
    // (called from /api/analyze after fact count is known).
    // Ignore WindowCheckResult here — this is a post-hoc charge after
    // the expensive work is done; we prefer not to block the response.
    let _ = check_and_record_window(&mut redis, &dk_key, now, now, i64::MAX, weight, 120).await;
    let _ = check_and_record_window(
        &mut redis,
        &burst_key,
        now,
        now + 0.1,
        i64::MAX,
        weight,
        120,
    )
    .await;
    let _ =
        check_and_record_window(&mut redis, &hr_key, now, now + 0.2, i64::MAX, weight, 3700).await;

    Ok(())
}

// ============================================================
// Sponsor Rate Limit Middleware (IP-based, unauthenticated)
// ============================================================

/// Pre-authentication rate limiting middleware for the public `/sponsor` routes.
///
/// Enforces a per-IP sliding-window limit using the same Redis counters as
/// the authenticated middleware. Defaults: 10 req/min, 30 req/hr per IP.
///
/// Redis errors return 503. A local fallback cannot provide consistent abuse
/// protection across replicas, so the sponsor path intentionally fails closed.
pub async fn sponsor_rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    // RATE_LIMIT_DISABLED=1 — see RateLimitConfig::bench_bypass_enabled.
    // Covers the IP+sender sponsor bucket too so benches can hit /sponsor.
    if state.config.rate_limit.bench_bypass_enabled {
        return next.run(request).await;
    }

    // XFF is ignored by default. Only walk back through the explicitly
    // configured number of trusted proxy hops, using the same resolver as
    // the MCP proxy path.
    let ip = match request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| canonical_client_ip(request.headers(), ci.0, state.config.trusted_proxy_hops))
    {
        Some(ip) => ip.to_string(),
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
    let hr_key = format!("rate:sponsor:ip:hr:{}", ip);
    let min_window_start = now - 60_000.0;
    let hr_window_start = now - 3_600_000.0;

    // --- Atomic check-and-record for minute bucket (IP-based) ---
    match check_and_record_window(
        &mut redis,
        &min_key,
        min_window_start,
        now,
        config.per_minute,
        1,
        120,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            tracing::warn!(
                "sponsor rate limit [IP/min]: ip={} denied (limit={})",
                ip,
                config.per_minute
            );
            return rate_limit_response("sponsor_ip_burst", config.per_minute, "min", 60);
        }
        Err(e) => {
            tracing::error!(
                "sponsor_rate_limit_middleware: Redis error (minute bucket): {}",
                e
            );
            return rate_limiter_unavailable_response();
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    // --- Atomic check-and-record for hour bucket (IP-based) ---
    match check_and_record_window(
        &mut redis,
        &hr_key,
        hr_window_start,
        now + 0.1,
        config.per_hour,
        1,
        3700,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            tracing::warn!(
                "sponsor rate limit [IP/hr]: ip={} denied (limit={})",
                ip,
                config.per_hour
            );
            return rate_limit_response("sponsor_ip_sustained", config.per_hour, "hour", 300);
        }
        Err(e) => {
            tracing::error!(
                "sponsor_rate_limit_middleware: Redis error (hour bucket): {}",
                e
            );
            return rate_limiter_unavailable_response();
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    match check_global_sponsor_rate_limit(&state, config.global_per_minute, config.global_per_hour)
        .await
    {
        Ok(SponsorRlResult::MinuteLimitExceeded) => {
            return rate_limit_response(
                "sponsor_global_burst",
                config.global_per_minute,
                "min",
                60,
            );
        }
        Ok(SponsorRlResult::HourLimitExceeded) => {
            return rate_limit_response(
                "sponsor_global_sustained",
                config.global_per_hour,
                "hour",
                300,
            );
        }
        Ok(SponsorRlResult::Allowed) => {}
        Err(()) => return rate_limiter_unavailable_response(),
    }

    next.run(request).await
}

// ============================================================
// Accounts — deployment-wide budget limit
// ============================================================

/// Check whether the deployment has exceeded its accounts-exists budget
/// limits.
///
/// Uses a sliding-window counter in Redis just like
/// `check_global_sponsor_rate_limit`, but keyed by fixed server-controlled
/// identifiers so IP rotation cannot bypass an aggregate ceiling on this
/// anonymous, enumeration-risk endpoint.
///
/// Returns `Err(())` on Redis failure so callers can fail closed. A
/// per-process fallback would not enforce a deployment-wide cap across
/// replicas.
pub async fn check_global_accounts_rate_limit(
    state: &crate::types::AppState,
    per_minute: i64,
    per_hour: i64,
) -> Result<SponsorRlResult, ()> {
    let now = chrono::Utc::now().timestamp_millis() as f64;
    let mut redis = state.redis.clone();

    let min_key = "rate:accounts:global:min";
    let hr_key = "rate:accounts:global:hr";
    let min_window_start = now - 60_000.0;
    let hr_window_start = now - 3_600_000.0;

    // --- Atomic check-and-record for minute bucket ---
    match check_and_record_window(
        &mut redis,
        min_key,
        min_window_start,
        now,
        per_minute,
        1, // weight = 1 per accounts-exists request
        120,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            crate::observability::record_rate_limit_denial("accounts_global_burst");
            return Ok(SponsorRlResult::MinuteLimitExceeded);
        }
        Err(e) => {
            tracing::error!(
                "check_global_accounts_rate_limit: Redis error (minute): {}",
                e
            );
            return Err(());
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    // --- Atomic check-and-record for hour bucket ---
    match check_and_record_window(
        &mut redis,
        hr_key,
        hr_window_start,
        now + 0.1,
        per_hour,
        1, // weight = 1 per accounts-exists request
        3700,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            crate::observability::record_rate_limit_denial("accounts_global_sustained");
            return Ok(SponsorRlResult::HourLimitExceeded);
        }
        Err(e) => {
            tracing::error!(
                "check_global_accounts_rate_limit: Redis error (hour): {}",
                e
            );
            return Err(());
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    Ok(SponsorRlResult::Allowed)
}

// ============================================================
// Accounts Rate Limit Middleware (IP-based, unauthenticated)
// ============================================================

/// Pre-authentication rate limiting middleware for the public
/// `GET /api/accounts/{owner}/exists` route.
///
/// This is the only route in `public_routes` that reaches the DB pool
/// (`max_connections(10)`) — `/health`, `/version`, `/config`, `/metrics`
/// are all static/no-DB. Modeled directly on `sponsor_rate_limit_middleware`:
/// enforces a per-IP sliding-window limit via `AccountsRateLimitConfig`
/// (a dedicated, stricter budget than the general authenticated
/// `RateLimitConfig` this middleware used to reuse — see that config's doc
/// comment for the reasoning behind its numbers), plus a deployment-wide
/// global cap via `check_global_accounts_rate_limit` so IP rotation alone
/// cannot exceed an aggregate ceiling.
///
/// Redis errors return 503. A local fallback cannot provide consistent abuse
/// protection across replicas, so — like `sponsor_rate_limit_middleware` —
/// this path intentionally fails closed.
pub async fn accounts_rate_limit_middleware(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    // RATE_LIMIT_DISABLED=1 — see RateLimitConfig::bench_bypass_enabled.
    if state.config.rate_limit.bench_bypass_enabled {
        return next.run(request).await;
    }

    // XFF is ignored by default. Only walk back through the explicitly
    // configured number of trusted proxy hops, using the same resolver as
    // the sponsor and MCP proxy paths.
    let ip = match request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| canonical_client_ip(request.headers(), ci.0, state.config.trusted_proxy_hops))
    {
        Some(ip) => ip.to_string(),
        None => {
            // Cannot determine IP — fail-closed: deny rather than allow unknown callers.
            tracing::warn!("accounts_rate_limit_middleware: cannot determine client IP, denying");
            return rate_limiter_unavailable_response();
        }
    };

    let config = &state.config.accounts_rate_limit;
    let mut redis = state.redis.clone();
    let now = chrono::Utc::now().timestamp_millis() as f64;

    let min_key = format!("rate:accounts:ip:min:{}", ip);
    let hr_key = format!("rate:accounts:ip:hr:{}", ip);
    let min_window_start = now - 60_000.0;
    let hr_window_start = now - 3_600_000.0;

    // --- Atomic check-and-record for minute bucket (IP-based) ---
    match check_and_record_window(
        &mut redis,
        &min_key,
        min_window_start,
        now,
        config.per_minute,
        1,
        120,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            tracing::warn!(
                "accounts rate limit [IP/min]: ip={} denied (limit={})",
                ip,
                config.per_minute
            );
            return rate_limit_response("accounts_ip_burst", config.per_minute, "min", 60);
        }
        Err(e) => {
            tracing::error!(
                "accounts_rate_limit_middleware: Redis error (minute bucket): {}",
                e
            );
            return rate_limiter_unavailable_response();
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    // --- Atomic check-and-record for hour bucket (IP-based) ---
    match check_and_record_window(
        &mut redis,
        &hr_key,
        hr_window_start,
        now + 0.1,
        config.per_hour,
        1,
        3700,
    )
    .await
    {
        Ok(WindowCheckResult::Denied) => {
            tracing::warn!(
                "accounts rate limit [IP/hr]: ip={} denied (limit={})",
                ip,
                config.per_hour
            );
            return rate_limit_response("accounts_ip_sustained", config.per_hour, "hour", 300);
        }
        Err(e) => {
            tracing::error!(
                "accounts_rate_limit_middleware: Redis error (hour bucket): {}",
                e
            );
            return rate_limiter_unavailable_response();
        }
        Ok(WindowCheckResult::Allowed) => {}
    }

    match check_global_accounts_rate_limit(&state, config.global_per_minute, config.global_per_hour)
        .await
    {
        Ok(SponsorRlResult::MinuteLimitExceeded) => {
            return rate_limit_response(
                "accounts_global_burst",
                config.global_per_minute,
                "min",
                60,
            );
        }
        Ok(SponsorRlResult::HourLimitExceeded) => {
            return rate_limit_response(
                "accounts_global_sustained",
                config.global_per_hour,
                "hour",
                300,
            );
        }
        Ok(SponsorRlResult::Allowed) => {}
        Err(()) => return rate_limiter_unavailable_response(),
    }

    next.run(request).await
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Path normalization ----

    #[test]
    fn test_endpoint_weight_trailing_slash_normalized() {
        // Without trailing slash
        assert_eq!(endpoint_weight("/api/analyze"), 5);
        assert_eq!(endpoint_weight("/api/remember"), 5);
        assert_eq!(endpoint_weight("/api/remember/manual"), 3);
        assert_eq!(endpoint_weight("/api/restore"), 3);
        assert_eq!(endpoint_weight("/api/ask"), 2);

        // With trailing slash — must return SAME weight.
        assert_eq!(
            endpoint_weight("/api/analyze/"),
            5,
            "trailing slash bypass!"
        );
        assert_eq!(
            endpoint_weight("/api/remember/"),
            5,
            "trailing slash bypass!"
        );
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

    // ---- fail-closed response ----

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

    // ---- Atomic Lua script structure ----

    /// Verify the Lua script constant is non-empty and contains the critical
    /// idempotency guard (`count + weight > limit`). If the guard disappears,
    /// the TOCTOU race is reintroduced.
    #[test]
    fn test_lua_script_contains_atomic_guard() {
        assert!(
            !SLIDING_WINDOW_LUA.is_empty(),
            "Lua script must not be empty"
        );
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
        assert!(
            SLIDING_WINDOW_LUA.contains("request_id .. ':' .. tostring(i)"),
            "Lua script must use a unique request ID for every ZSET member"
        );
    }

    /// Regression test for same-millisecond concurrent requests. This talks to
    /// a real Redis instance because Redis ZSET member de-duplication and Lua
    /// atomicity cannot be faithfully covered by a mock.
    ///
    /// Run with:
    /// TEST_REDIS_URL=redis://127.0.0.1:6379 \
    ///   cargo test concurrent_same_millisecond_requests_respect_limit -- --ignored
    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL pointing to a real Redis instance"]
    async fn concurrent_same_millisecond_requests_respect_limit() {
        let redis_url = std::env::var("TEST_REDIS_URL")
            .expect("TEST_REDIS_URL must be set when running Redis integration tests");
        let client = redis::Client::open(redis_url).expect("valid TEST_REDIS_URL");
        let mut connection = client
            .get_multiplexed_async_connection()
            .await
            .expect("connect to test Redis");
        let key = format!("test:rate-limit:concurrent:{}", Uuid::new_v4());
        let _: i64 = redis::cmd("DEL")
            .arg(&key)
            .query_async(&mut connection)
            .await
            .expect("clear test key");

        const REQUESTS: usize = 32;
        const LIMIT: i64 = 10;
        let now = chrono::Utc::now().timestamp_millis() as f64;
        let barrier = Arc::new(tokio::sync::Barrier::new(REQUESTS + 1));
        let mut tasks = Vec::with_capacity(REQUESTS);

        for _ in 0..REQUESTS {
            let mut task_connection = connection.clone();
            let task_key = key.clone();
            let task_barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                task_barrier.wait().await;
                check_and_record_window(
                    &mut task_connection,
                    &task_key,
                    now - 60_000.0,
                    now,
                    LIMIT,
                    1,
                    120,
                )
                .await
            }));
        }

        barrier.wait().await;
        let mut allowed = 0;
        for task in tasks {
            if task
                .await
                .expect("rate-limit task panicked")
                .expect("Redis script failed")
                == WindowCheckResult::Allowed
            {
                allowed += 1;
            }
        }

        let cardinality: i64 = redis::cmd("ZCARD")
            .arg(&key)
            .query_async(&mut connection)
            .await
            .expect("read test bucket cardinality");
        let _: i64 = redis::cmd("DEL")
            .arg(&key)
            .query_async(&mut connection)
            .await
            .expect("clean test key");

        assert_eq!(allowed, LIMIT);
        assert_eq!(cardinality, LIMIT);
    }

    /// Regression test for `check_restore_call_rate_limit`'s underlying
    /// window (GH #501 / WALM-299 owner-scoped restore-call guard). Talks to
    /// a real Redis instance for the same reason as
    /// `concurrent_same_millisecond_requests_respect_limit`.
    ///
    /// `check_restore_call_rate_limit` itself takes `&AppState`, which
    /// nothing in this crate constructs outside of `main.rs` (it wires a DB
    /// pool, Sui clients, the memory engine, embedder, extractor, ranker,
    /// etc.). Standing one up here would test plumbing this fix didn't
    /// touch, so this test drives the exact `rate:restore-call:{owner}` key
    /// + 1-minute-window + weight-1 shape through `check_and_record_window`
    /// directly — the same primitive `check_restore_call_rate_limit` calls,
    /// with no logic of its own in between.
    ///
    /// Run with:
    /// TEST_REDIS_URL=redis://127.0.0.1:6379 \
    ///   cargo test restore_call_rate_limit_denies_past_the_owner_window -- --ignored
    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL pointing to a real Redis instance"]
    async fn restore_call_rate_limit_denies_past_the_owner_window() {
        let redis_url = std::env::var("TEST_REDIS_URL")
            .expect("TEST_REDIS_URL must be set when running Redis integration tests");
        let client = redis::Client::open(redis_url).expect("valid TEST_REDIS_URL");
        let mut connection = client
            .get_multiplexed_async_connection()
            .await
            .expect("connect to test Redis");

        const LIMIT: i64 = 10;
        let owner = format!("0xrestore-rl-owner-{}", Uuid::new_v4());
        let other_owner = format!("0xrestore-rl-other-{}", Uuid::new_v4());
        let key = format!("rate:restore-call:{owner}");
        let other_key = format!("rate:restore-call:{other_owner}");
        let now = chrono::Utc::now().timestamp_millis() as f64;
        let window_start = now - 60_000.0;

        // First LIMIT calls for `owner` are allowed, the LIMIT+1'th is denied.
        for i in 0..LIMIT {
            let result = check_and_record_window(
                &mut connection,
                &key,
                window_start,
                now + i as f64,
                LIMIT,
                1,
                120,
            )
            .await
            .expect("Redis script failed");
            assert_eq!(
                result,
                WindowCheckResult::Allowed,
                "call {} of {} should be allowed",
                i + 1,
                LIMIT
            );
        }
        let denied = check_and_record_window(
            &mut connection,
            &key,
            window_start,
            now + LIMIT as f64,
            LIMIT,
            1,
            120,
        )
        .await
        .expect("Redis script failed");
        assert_eq!(
            denied,
            WindowCheckResult::Denied,
            "call {} should be denied for a limit of {}",
            LIMIT + 1,
            LIMIT
        );

        // Key isolation: a distinct owner's window is unaffected by the
        // first owner having exhausted theirs.
        let other_allowed = check_and_record_window(
            &mut connection,
            &other_key,
            window_start,
            now,
            LIMIT,
            1,
            120,
        )
        .await
        .expect("Redis script failed");
        assert_eq!(
            other_allowed,
            WindowCheckResult::Allowed,
            "a distinct owner must not be affected by another owner's exhausted window"
        );

        let _: i64 = redis::cmd("DEL")
            .arg(&key)
            .arg(&other_key)
            .query_async(&mut connection)
            .await
            .expect("clean test keys");
    }

    /// Verify that WindowCheckResult variants are correctly defined.
    #[test]
    fn test_window_check_result_variants() {
        let allowed = WindowCheckResult::Allowed;
        let denied = WindowCheckResult::Denied;
        assert_eq!(allowed, WindowCheckResult::Allowed);
        assert_eq!(denied, WindowCheckResult::Denied);
        assert_ne!(allowed, denied, "Allowed and Denied must be distinct");
    }

    // ---- Percent-encoded path normalization ----

    #[test]
    fn test_endpoint_weight_percent_encoded_analyze() {
        // "%79" = 'y', so "/api/anal%79ze" = "/api/analyze"
        assert_eq!(
            endpoint_weight("/api/anal%79ze"),
            5,
            "percent-encoded 'y' bypass"
        );
    }

    #[test]
    fn test_endpoint_weight_percent_encoded_remember() {
        // "%72" = 'r', so "/api/%72emember" = "/api/remember"
        assert_eq!(
            endpoint_weight("/api/%72emember"),
            5,
            "percent-encoded 'r' bypass"
        );
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

    // ---- In-memory token bucket fallback ----

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
        assert!(
            bucket.tokens < 8.0,
            "tokens should be around 7, got {}",
            bucket.tokens
        );
        assert!(
            bucket.tokens > 6.0,
            "tokens should be around 7, got {}",
            bucket.tokens
        );
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
        let mut fb = InMemoryFallback {
            cleanup_counter: 999,
            ..Default::default()
        };

        // Add a bucket and consume to trigger cleanup
        fb.consume("test_key", 1.0, 10.0, 60.0);

        // After cleanup_counter >= 1000, it resets to 0
        assert_eq!(
            fb.cleanup_counter, 0,
            "cleanup counter should reset after reaching 1000"
        );
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

    // ---- Analyze weight calculations ----

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
        // Bench bypass MUST default to false — production safety net.
        assert!(!config.bench_bypass_enabled);
    }

    // ---- SponsorRlResult variants ----

    #[test]
    fn test_sponsor_rl_result_variants() {
        assert_eq!(SponsorRlResult::Allowed, SponsorRlResult::Allowed);
        assert_eq!(
            SponsorRlResult::MinuteLimitExceeded,
            SponsorRlResult::MinuteLimitExceeded
        );
        assert_eq!(
            SponsorRlResult::HourLimitExceeded,
            SponsorRlResult::HourLimitExceeded
        );
        assert_ne!(
            SponsorRlResult::Allowed,
            SponsorRlResult::MinuteLimitExceeded
        );
        assert_ne!(
            SponsorRlResult::MinuteLimitExceeded,
            SponsorRlResult::HourLimitExceeded
        );
    }
}
