# Detailed Explanations: Rate Limiting, Infrastructure & Deployment Findings

**Source Review:** `security-review/06-rate-limiting-and-infrastructure.md`
**Date:** 2026-04-02
**Commit:** 5bb1669

---

## 1.1 MEDIUM: TOCTOU Race in Rate Limit Check-Then-Record

### What it is

A Time-Of-Check-to-Time-Of-Use (TOCTOU) race condition exists in the rate limiting middleware. The system first checks whether a user is within their rate limit budget across all three windows (delegate-key, burst, sustained), and only after all three checks pass does it record the weighted entries. Because these are two separate, non-atomic operations against Redis, there is a window of time during which concurrent requests can all observe the same "under budget" state and all be allowed through.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 229-286

The three checks happen sequentially at lines 229, 249, and 268:

```rust
// --- Layer 1: Per-delegate-key (burst) ---   (line 229)
match check_window(&mut redis, &dk_key, dk_window_start).await {
    Ok(count) => {
        if count >= config.max_requests_per_delegate_key {
            // ... return 429
        }
    }
    Err(e) => {
        tracing::error!("redis rate limit check failed (dk): {}, allowing", e);
    }
}

// --- Layer 2: Per-account burst (1 min) ---   (line 249)
match check_window(&mut redis, &burst_key, burst_window_start).await {
    Ok(count) => {
        if count >= config.max_requests_per_minute {
            // ... return 429
        }
    }
    Err(e) => {
        tracing::error!("redis rate limit check failed (burst): {}, allowing", e);
    }
}

// --- Layer 3: Per-account sustained (1 hour) ---   (line 268)
match check_window(&mut redis, &hourly_key, hourly_window_start).await {
    // ... same pattern
}
```

Only after all three pass do the records get written at lines 284-286:

```rust
// --- All checks passed: record weighted entries in all 3 windows ---
record_in_window(&mut redis, &dk_key, now, weight, 120).await;       // line 284
record_in_window(&mut redis, &burst_key, now + 0.1, weight, 120).await;  // line 285
record_in_window(&mut redis, &hourly_key, now + 0.2, weight, 3700).await; // line 286
```

### How it could be exploited

1. Attacker identifies that `/api/analyze` has a weight of 10 (line 95) and the per-minute limit is 60 weighted requests.
2. Attacker sends 6 concurrent HTTP requests to `/api/analyze` simultaneously (e.g., using parallel HTTP connections).
3. All 6 requests enter the middleware at roughly the same time. Each calls `check_window` and sees `count=0` because none have recorded yet.
4. All 6 pass the `count >= 60` check (0 < 60).
5. All 6 proceed to `record_in_window`, each adding weight=10 entries.
6. The result: 60 weighted entries are recorded (6 x 10), consuming the entire minute budget in one burst.
7. The attacker can repeat this every minute, effectively getting 6x the intended throughput for expensive operations like LLM analysis.

### Impact

An attacker can bypass rate limits by a factor roughly proportional to the number of concurrent connections they can establish. For the most expensive endpoint (`/api/analyze`, weight=10), this means:
- Up to 6x the intended LLM + embedding + encryption + Walrus upload operations per minute.
- Significant cost amplification for the service operator (LLM API calls, Walrus storage fees, compute).
- Potential service degradation for other users due to resource exhaustion.

### Why the severity rating is correct

MEDIUM is appropriate because:
- The vulnerability requires concurrent requests from the same authenticated user, meaning the attacker must have valid credentials.
- The amplification factor is bounded by network/server concurrency (not unlimited).
- It does not lead to data breach or privilege escalation, only resource abuse.
- However, it directly undermines a security control (rate limiting) that protects against cost and availability attacks.

### Remediation

Replace the check-then-record pattern with an atomic Lua script that checks AND increments in a single Redis operation:

```rust
const RATE_LIMIT_LUA: &str = r#"
    -- Remove expired entries
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
    -- Get current count
    local count = redis.call('ZCARD', KEYS[1])
    -- Check if adding weight would exceed limit
    if count + tonumber(ARGV[4]) > tonumber(ARGV[3]) then
        return count
    end
    -- Record entries atomically
    for i = 0, tonumber(ARGV[4]) - 1 do
        local ts = tonumber(ARGV[2]) + i * 0.001
        redis.call('ZADD', KEYS[1], ts, tostring(ts))
    end
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
    return -1  -- indicates success
"#;
```

This ensures that the check and the increment happen atomically within Redis, eliminating the race window.

---

## 1.2 LOW: Non-Atomic Record Pipeline

### What it is

The `record_in_window` function builds a Redis pipeline containing multiple `ZADD` commands followed by an `EXPIRE` command, but unlike the `check_window` function, it does not wrap the pipeline in `.atomic()`. If the Redis connection fails partway through the pipeline, some `ZADD` commands may succeed while the `EXPIRE` command fails. This leaves a sorted set key in Redis with no TTL, meaning it will persist indefinitely and accumulate entries that never expire, eventually permanently rate-limiting the affected user.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 150-161

```rust
async fn record_in_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    now: f64,
    weight: i64,
    ttl_seconds: i64,
) {
    let mut pipe = redis::pipe();          // line 150: NOT atomic
    for i in 0..weight {
        let ts = now + i as f64 * 0.001;
        pipe.zadd(key, ts, format!("{}", ts));
    }
    pipe.expire(key, ttl_seconds);         // line 156: EXPIRE at end

    if let Err(e) = pipe.query_async::<()>(redis).await {
        tracing::warn!("rate limit: failed to record window for key {}: {}", key, e);
    }
}
```

Compare with `check_window` at lines 131-138 which correctly uses `.atomic()`:

```rust
async fn check_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    window_start: f64,
) -> Result<i64, redis::RedisError> {
    let result: ((), i64) = redis::pipe()
        .atomic()                           // line 132: correctly atomic
        .zrembyscore(key, 0.0_f64, window_start)
        .zcard(key)
        .query_async(redis)
        .await?;
    Ok(result.1)
}
```

### How it could be exploited

1. A legitimate user makes a request to `/api/analyze` (weight=10).
2. The pipeline starts executing: 10 `ZADD` commands are sent to Redis.
3. A transient network issue or Redis restart occurs after the `ZADD` commands but before the `EXPIRE` command.
4. The sorted set key (e.g., `rate:dk:<pubkey>`) now contains entries but has no TTL.
5. The `check_window` function's `ZREMRANGEBYSCORE` will eventually clear old entries by score (timestamp), but only entries within the window. If the key has no TTL, it persists in Redis memory indefinitely.
6. Over time, if this happens repeatedly, the user accumulates phantom entries that artificially inflate their rate limit count.

### Impact

- A user could become permanently or semi-permanently rate-limited due to stale entries in Redis keys that never expire.
- Redis memory usage grows unboundedly for affected keys.
- This is a reliability/availability concern rather than a direct security exploit. An attacker cannot easily trigger this condition intentionally.

### Why the severity rating is correct

LOW is appropriate because:
- The condition requires a transient Redis failure at a specific moment, which is uncommon.
- The `ZREMRANGEBYSCORE` in `check_window` partially mitigates this by removing entries outside the window by score.
- The impact is denial-of-service to the affected user, not a bypass or data breach.
- The fix is trivial (one method call).

### Remediation

Add `.atomic()` to the pipeline in `record_in_window`:

```rust
let mut pipe = redis::pipe();
pipe.atomic();  // Add this line
for i in 0..weight {
    let ts = now + i as f64 * 0.001;
    pipe.zadd(key, ts, format!("{}", ts));
}
pipe.expire(key, ttl_seconds);
```

This wraps the pipeline in a Redis `MULTI`/`EXEC` transaction, ensuring all commands execute atomically.

---

## 1.3 MEDIUM: Endpoint Weight Exact Path Match Bypass

### What it is

The `endpoint_weight` function uses exact string matching to assign cost weights to API endpoints. Axum (the HTTP framework used by MemWal) does not normalize trailing slashes by default. This means a request to `/api/analyze/` (with trailing slash) or `/api/analyze?foo=bar` would not match the pattern `/api/analyze` and would fall through to the default weight of 1 instead of 10. An attacker can exploit this to make expensive operations consume only 1/10th of their intended rate limit budget.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 93-101

```rust
fn endpoint_weight(path: &str) -> i64 {
    match path {
        "/api/analyze" => 10,          // LLM extract + N x (embed + encrypt + upload)
        "/api/remember" => 5,          // embed + SEAL encrypt + Walrus upload
        "/api/remember/manual" => 3,   // Walrus upload only (client did embed/encrypt)
        "/api/restore" => 3,           // download + decrypt + re-embed
        "/api/ask" => 2,               // recall + LLM
        _ => 1,                        // recall, recall/manual, etc.
    }
}
```

The function is called at line 223 with the raw URI path:

```rust
let weight = endpoint_weight(request.uri().path());
```

### How it could be exploited

1. Attacker identifies that `/api/analyze` is weighted at 10 (the most expensive endpoint).
2. Attacker sends requests to `/api/analyze/` (with trailing slash) instead of `/api/analyze`.
3. If Axum still routes `/api/analyze/` to the analyze handler (depending on router configuration), the request is processed normally.
4. However, `request.uri().path()` returns `"/api/analyze/"` which does not match `"/api/analyze"` in the exact match.
5. The weight falls through to the default `_ => 1`.
6. The attacker now uses weight=1 instead of weight=10, effectively getting 10x the rate limit budget for the most expensive operation.
7. Similarly, URL-encoded variants like `/api/analyze%2F` or `/api/analyze?ignored=param` (though query strings are typically excluded from `path()`) could be tested.

### Impact

- An attacker can reduce the effective cost of expensive endpoints by up to 10x.
- This allows 10x more LLM calls, Walrus uploads, and encryption operations per rate limit window.
- Combined with the TOCTOU race (1.1), the amplification could be even greater.

### Why the severity rating is correct

MEDIUM is appropriate because:
- Exploitability depends on whether Axum routes the path variant to the same handler (trailing slash routing behavior varies by framework configuration).
- If exploitable, it directly undermines the cost-weighting system that protects against resource abuse.
- It does not grant unauthorized access but can cause significant financial impact through amplified resource consumption.

### Remediation

Normalize the path before matching, or use prefix matching:

```rust
fn endpoint_weight(path: &str) -> i64 {
    let normalized = path.trim_end_matches('/');
    match normalized {
        "/api/analyze" => 10,
        "/api/remember" => 5,
        "/api/remember/manual" => 3,
        "/api/restore" => 3,
        "/api/ask" => 2,
        _ => 1,
    }
}
```

A more robust approach is to attach weights as Axum route-level extensions, so the weight is determined by the matched route rather than the raw URL:

```rust
// In router setup:
.route("/api/analyze", post(analyze).layer(Extension(EndpointWeight(10))))
```

---

## 1.4 LOW: Negative or Zero Weight Allows Free Requests

### What it is

The `endpoint_weight` function returns an `i64`, which can represent negative numbers or zero. The `record_in_window` function uses a `for i in 0..weight` loop. If `weight` is 0, this loop executes zero times (recording nothing). If `weight` is negative, the range `0..-N` is empty in Rust, so the loop also executes zero times. This means a weight of 0 or negative would allow requests to pass rate limit checks without consuming any budget.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 93-101 (weight definition) and lines 150-155 (recording loop)

```rust
fn endpoint_weight(path: &str) -> i64 {     // i64 allows negative values
    match path {
        "/api/analyze" => 10,
        // ...
        _ => 1,
    }
}
```

```rust
async fn record_in_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    now: f64,
    weight: i64,           // i64 parameter
    ttl_seconds: i64,
) {
    let mut pipe = redis::pipe();
    for i in 0..weight {   // If weight <= 0, this loop body never executes
        let ts = now + i as f64 * 0.001;
        pipe.zadd(key, ts, format!("{}", ts));
    }
    pipe.expire(key, ttl_seconds);
    // ...
}
```

### How it could be exploited

Currently, this is **not directly exploitable** because all code paths in `endpoint_weight` return positive values (1-10). However:
1. A future developer adds a new endpoint and accidentally assigns weight 0.
2. Or a configuration-driven weight system is added that reads from environment variables, and an operator misconfigures a weight to 0 or -1.
3. Requests to that endpoint would be checked against the rate limit (and pass because their entries are never recorded) but would never consume any budget.
4. The user would effectively have unlimited requests for that endpoint.

### Impact

- No current exploit path exists; this is a defensive coding concern.
- If triggered by a future misconfiguration, it would completely bypass rate limiting for the affected endpoint.

### Why the severity rating is correct

LOW is appropriate because:
- There is no current exploitable path -- all weights are hardcoded positive values.
- It requires a developer or operator error to become exploitable.
- The fix is trivial and prevents a class of future bugs.

### Remediation

Change the type to `u32` or add a runtime assertion:

```rust
fn endpoint_weight(path: &str) -> u32 {
    match path {
        "/api/analyze" => 10,
        "/api/remember" => 5,
        "/api/remember/manual" => 3,
        "/api/restore" => 3,
        "/api/ask" => 2,
        _ => 1,
    }
}
```

Or add a debug assertion in `record_in_window`:

```rust
async fn record_in_window(/* ... */, weight: i64, /* ... */) {
    debug_assert!(weight >= 1, "weight must be positive, got {}", weight);
    // ...
}
```

---

## 2.1 HIGH: All Three Rate Limit Layers Fail Open (Confirms Vuln 4)

### What it is

When Redis is unavailable or returns an error, every rate limit check silently allows the request through. All three layers (delegate-key, burst, sustained) have identical error-handling logic: log a warning/error and proceed as if the check passed. Additionally, the `record_in_window` function also silently continues on failure, meaning even if some checks succeed, the recording of consumed budget may silently fail. This means that if Redis experiences any connectivity issues, rate limiting is completely disabled with no fallback.

### Where in the code

**File:** `services/server/src/rate_limit.rs`

Layer 1 fail-open at lines 240-242:

```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (dk): {}, allowing", e);
}
```

Layer 2 fail-open at lines 259-261:

```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (burst): {}, allowing", e);
}
```

Layer 3 fail-open at lines 278-280:

```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (sustained): {}, allowing", e);
}
```

Record failure at line 158:

```rust
if let Err(e) = pipe.query_async::<()>(redis).await {
    tracing::warn!("rate limit: failed to record window for key {}: {}", key, e);
}
```

### How it could be exploited

**Scenario 1 -- Redis crash:**
1. Attacker discovers that Redis is exposed on port 6379 without authentication (see finding 4.2).
2. Attacker connects to Redis and runs `SHUTDOWN NOSAVE` or `FLUSHALL`.
3. All subsequent rate limit checks fail with connection errors.
4. All three layers log warnings and allow every request through.
5. Attacker now has unlimited access to all endpoints with no rate limiting.

**Scenario 2 -- Intermittent failure:**
1. Redis experiences transient connectivity issues (network blip, memory pressure, etc.).
2. `check_window` succeeds (returns Ok with count=0 because the sorted set was just flushed or is on a reconnected instance).
3. `record_in_window` fails silently (line 158).
4. The request is allowed AND the budget is never consumed.
5. The next request also sees count=0 and is allowed.
6. All requests during the instability period pass without consuming budget.

**Scenario 3 -- Chain attack:**
1. Attacker combines Redis exposure (4.2) with fail-open behavior.
2. Attacker periodically sends `FLUSHALL` to Redis to clear all rate limit state.
3. Every user effectively has their rate limit counters reset to zero.
4. The attacker (and everyone else) can make unlimited requests.

### Impact

- Complete bypass of all rate limiting across all users and all endpoints.
- Unlimited LLM API calls at the service operator's expense.
- Unlimited Walrus storage uploads.
- Potential service degradation or outage due to uncontrolled load.
- Financial impact from unmetered API usage (LLM costs, storage costs).

### Why the severity rating is correct

HIGH is appropriate because:
- The fail-open behavior is 100% confirmed and deterministic (Confidence: 10/10).
- It affects all three rate limit layers simultaneously.
- When combined with the exposed Redis (4.2), an attacker can intentionally trigger the condition.
- The impact is complete bypass of a critical security control.
- It is not rated CRITICAL only because it requires either a Redis failure (natural or induced) and does not directly lead to data breach.

### Remediation

1. **Fail closed by default** -- return HTTP 503 when Redis is unreachable:

```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (dk): {}", e);
    return axum::response::Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("Content-Type", "application/json")
        .header("Retry-After", "30")
        .body(axum::body::Body::from(
            r#"{"error":"Service temporarily unavailable","reason":"rate_limiter_offline"}"#
        ))
        .unwrap();
}
```

2. **Implement an in-memory fallback** using a token bucket (e.g., `governor` crate) that activates when Redis is down:

```rust
// Fallback: use in-memory rate limiter when Redis fails
if let Some(limiter) = &state.fallback_limiter {
    if limiter.check_key(&auth.owner).is_err() {
        return rate_limit_response("fallback", 10, "min", 60);
    }
}
```

3. **Add a circuit breaker** so that after N consecutive Redis failures, the system automatically switches to fail-closed or fallback mode without attempting Redis connections on every request.

---

## 2.2 MEDIUM: No Redis Connection Resilience

### What it is

The Redis client is created once at application startup as a `MultiplexedConnection`. There is no explicit configuration for connection timeouts, reconnection backoff, maximum retries, or connection pool health checks. If the connection drops after startup, the default behavior of the `redis` crate's multiplexed connection determines whether and how reconnection is attempted, with no application-level control.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 109-118

```rust
pub async fn create_redis_client(redis_url: &str) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(redis_url)
        .map_err(|e| format!("Failed to create Redis client: {}", e))?;

    let conn = client.get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Failed to connect to Redis: {}", e))?;

    Ok(conn)
}
```

### How it could be exploited

1. Redis restarts or becomes temporarily unreachable (maintenance, OOM kill, network partition).
2. The multiplexed connection may enter a degraded state.
3. Without explicit reconnection configuration, the connection may not recover gracefully or may take an unpredictable amount of time to reconnect.
4. During this period, all rate limit checks fail, triggering the fail-open behavior (2.1).
5. An attacker who can induce even brief Redis downtime (e.g., via exposed Redis port) gains a window of unlimited access.

### Impact

- Extended periods of rate limiting failure during Redis instability.
- No visibility into connection health (no health check metrics).
- Cascading with fail-open (2.1), any Redis connectivity issue becomes a rate limit bypass.

### Why the severity rating is correct

MEDIUM is appropriate because:
- The `redis` crate's `MultiplexedConnection` does have some built-in reconnection behavior, but it is not configurable at the application level.
- The impact is indirect -- it amplifies the fail-open vulnerability (2.1).
- It represents a resilience gap rather than a directly exploitable vulnerability.

### Remediation

Configure explicit connection parameters and implement health checks:

```rust
pub async fn create_redis_client(redis_url: &str) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(redis_url)
        .map_err(|e| format!("Failed to create Redis client: {}", e))?;

    let config = redis::aio::MultiplexedConnectionConfig {
        connection_timeout: std::time::Duration::from_secs(5),
        response_timeout: std::time::Duration::from_secs(2),
        ..Default::default()
    };

    let conn = client.get_multiplexed_async_connection_with_config(&config)
        .await
        .map_err(|e| format!("Failed to connect to Redis: {}", e))?;

    Ok(conn)
}
```

Consider using a connection pool (e.g., `deadpool-redis` or `bb8-redis`) with built-in health checks and configurable reconnection behavior.

---

## 3.1 MEDIUM: Storage Quota Check-Then-Write TOCTOU

### What it is

The storage quota check reads the current usage from PostgreSQL, compares it against the limit, and then the caller proceeds to upload and store data. Between the check and the eventual database INSERT, concurrent requests can all pass the quota check because they all observe the same baseline usage. This is a TOCTOU race condition similar to 1.1 but in the storage domain.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 299-328 (quota check function)

```rust
pub async fn check_storage_quota(
    state: &AppState,
    owner: &str,
    additional_bytes: i64,
) -> Result<(), AppError> {
    let max_bytes = state.config.rate_limit.max_storage_bytes;

    if max_bytes <= 0 {
        return Ok(());
    }

    let used = state.db.get_storage_used(owner).await?;   // line 311: READ current usage
    let projected = used + additional_bytes;

    if projected > max_bytes {                              // line 314: CHECK
        // ... return error
    }

    Ok(())  // line 327: ALLOW -- but nothing is reserved
}
```

**File:** `services/server/src/routes.rs`, line 139-140 (remember endpoint):

```rust
let text_bytes = text.as_bytes().len() as i64;
rate_limit::check_storage_quota(&state, owner, text_bytes).await?;
// ... then proceeds to embed, encrypt, upload, and INSERT into database
```

**File:** `services/server/src/routes.rs`, lines 417-418 (analyze endpoint):

```rust
let total_text_bytes: i64 = facts.iter().map(|f| f.as_bytes().len() as i64).sum();
rate_limit::check_storage_quota(&state, owner, total_text_bytes).await?;
// ... then processes all facts concurrently (line 423+)
```

### How it could be exploited

1. User has 900MB used out of a 1GB quota (100MB remaining).
2. User sends 5 concurrent `/api/remember` requests, each with 50MB of text.
3. All 5 requests call `check_storage_quota`. All 5 read `used = 900MB` from PostgreSQL.
4. All 5 calculate `projected = 900 + 50 = 950MB` which is under the 1GB limit.
5. All 5 pass the check and proceed to upload and store.
6. All 5 eventually INSERT into the database, resulting in 900 + 250 = 1150MB total usage.
7. The user has exceeded their 1GB quota by 150MB.

The `/api/analyze` endpoint is especially vulnerable because it processes multiple facts concurrently (line 423), meaning a single request with many facts can race against itself.

### Impact

- Users can exceed their storage quota by a factor proportional to the number of concurrent requests.
- For the `/api/analyze` endpoint, a single request extracting many facts processes them all concurrently, amplifying the race.
- Excess Walrus storage uploads incur costs that the operator must pay.
- Quota enforcement becomes advisory rather than mandatory.

### Why the severity rating is correct

MEDIUM is appropriate because:
- The race is real and exploitable with standard concurrent HTTP requests.
- The impact is storage quota bypass, leading to excess resource consumption and cost.
- It does not lead to data breach or privilege escalation.
- The overshoot is bounded by the number of concurrent requests times the upload size.

### Remediation

Use a PostgreSQL advisory lock per owner to serialize quota checks:

```rust
pub async fn check_storage_quota(
    state: &AppState,
    owner: &str,
    additional_bytes: i64,
) -> Result<(), AppError> {
    let max_bytes = state.config.rate_limit.max_storage_bytes;
    if max_bytes <= 0 {
        return Ok(());
    }

    // Acquire advisory lock for this owner (hash owner string to i64)
    let lock_key = crc32fast::hash(owner.as_bytes()) as i64;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(lock_key)
        .execute(&state.db.pool)
        .await?;

    let used = state.db.get_storage_used(owner).await?;
    let projected = used + additional_bytes;

    if projected > max_bytes {
        // Release lock before returning error
        sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(lock_key)
            .execute(&state.db.pool)
            .await?;
        return Err(AppError::QuotaExceeded(/* ... */));
    }

    // Release lock after reservation (or hold until INSERT completes)
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(lock_key)
        .execute(&state.db.pool)
        .await?;

    Ok(())
}
```

Alternatively, use a Redis-based reservation system: atomically reserve N bytes at check time, then confirm or release after the upload.

---

## 3.2 LOW: Quota Checked Against Text Size, Actual is Encrypted

### What it is

In the `/api/remember` endpoint, the storage quota is checked against the plaintext size of the text (`text.as_bytes().len()`), but the actual data stored on Walrus and tracked in the database is the SEAL-encrypted ciphertext, which is larger due to encryption overhead (nonce, authentication tag, padding). This means the quota check underestimates the actual storage consumed. The `/api/remember/manual` endpoint correctly checks against the encrypted data size.

### Where in the code

**File:** `services/server/src/routes.rs`, lines 139-140 (`/api/remember` endpoint):

```rust
let text_bytes = text.as_bytes().len() as i64;
rate_limit::check_storage_quota(&state, owner, text_bytes).await?;
```

**File:** `services/server/src/routes.rs`, line 314 (`/api/remember/manual` endpoint -- correct):

```rust
rate_limit::check_storage_quota(&state, owner, encrypted_bytes.len() as i64).await?;
```

**File:** `services/server/src/db.rs`, line 216 (what is actually tracked):

```sql
SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1
```

The `blob_size_bytes` column stores the size of the encrypted blob, not the plaintext.

### How it could be exploited

1. User has 990MB used out of a 1GB quota.
2. User submits a 9MB plaintext to `/api/remember`.
3. Quota check: `990 + 9 = 999MB < 1000MB` -- passes.
4. After SEAL encryption, the ciphertext is ~10-11MB (encryption adds overhead).
5. The blob is uploaded and stored; `blob_size_bytes` records 11MB.
6. Actual usage is now 1001MB, exceeding the 1GB quota.
7. The discrepancy accumulates over many uploads.

### Impact

- Users can slightly exceed their storage quota over time.
- The overshoot per request is bounded by the SEAL encryption overhead (typically a fixed number of bytes for nonce/tag plus potential padding).
- For large uploads the percentage overhead is small; for many small uploads it can be more significant proportionally.

### Why the severity rating is correct

LOW is appropriate because:
- The size discrepancy is relatively small (SEAL encryption overhead is typically tens to hundreds of bytes per operation).
- It does not allow a dramatic quota bypass -- just a slight overrun.
- The `/api/remember/manual` endpoint already demonstrates the correct approach.

### Remediation

Estimate the encryption overhead and add it to the pre-check:

```rust
// SEAL encryption adds approximately 76 bytes of overhead (nonce + tag + header)
const SEAL_ENCRYPTION_OVERHEAD: i64 = 128; // conservative estimate

let estimated_encrypted_size = text.as_bytes().len() as i64 + SEAL_ENCRYPTION_OVERHEAD;
rate_limit::check_storage_quota(&state, owner, estimated_encrypted_size).await?;
```

Or, restructure the flow to check quota after encryption but before upload.

---

## 3.3 LOW: Storage Quota Disabled by Zero Config

### What it is

Setting the environment variable `RATE_LIMIT_STORAGE_BYTES=0` causes `max_storage_bytes` to be 0, which makes the quota check return `Ok(())` immediately, effectively disabling all storage quota enforcement. While this may be intentional for development, it is undocumented and could be accidentally triggered in production by a misconfiguration.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 307-309

```rust
// 0 or negative means unlimited
if max_bytes <= 0 {
    return Ok(());
}
```

**File:** `services/server/src/rate_limit.rs`, lines 71-74 (config loading):

```rust
if let Ok(val) = std::env::var("RATE_LIMIT_STORAGE_BYTES") {
    if let Ok(n) = val.parse::<i64>() {
        config.max_storage_bytes = n;
    }
}
```

### How it could be exploited

1. An operator accidentally sets `RATE_LIMIT_STORAGE_BYTES=0` in a production environment variable configuration (e.g., confusing it with "use default" behavior).
2. All storage quota checks are bypassed.
3. Users can upload unlimited data to Walrus at the operator's expense.

### Impact

- Unlimited storage consumption if misconfigured.
- Potential for significant Walrus storage costs.
- The default value (1GB) is reasonable, so this only triggers with explicit misconfiguration.

### Why the severity rating is correct

LOW is appropriate because:
- It requires an operator misconfiguration to trigger.
- The default value (1GB) is safe.
- It is arguably a feature (disable quota for dev/testing), just needs documentation.

### Remediation

Add a startup log warning when quota is disabled:

```rust
if max_bytes <= 0 {
    tracing::warn!(
        "Storage quota is DISABLED (max_storage_bytes={}). \
         Set RATE_LIMIT_STORAGE_BYTES to a positive value to enable.",
        max_bytes
    );
    return Ok(());
}
```

Consider treating 0 as "use default" and requiring an explicit sentinel value (e.g., -1) to disable:

```rust
if max_bytes < 0 {
    return Ok(()); // Explicitly disabled
}
if max_bytes == 0 {
    // Use default
    let max_bytes = 1_073_741_824; // 1 GB
}
```

---

## 4.1 LOW: PostgreSQL Exposed with Hardcoded Credentials

### What it is

The docker-compose.yml file exposes PostgreSQL on all network interfaces (`0.0.0.0:5432`) with hardcoded credentials (`POSTGRES_PASSWORD: memwal_secret`). Any host-reachable client can connect to the database with these well-known credentials and read, modify, or delete all application data.

### Where in the code

**File:** `services/server/docker-compose.yml`, lines 8-13

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: memwal-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: memwal
      POSTGRES_USER: memwal
      POSTGRES_PASSWORD: memwal_secret
    ports:
      - "5432:5432"
```

### How it could be exploited

1. Attacker scans the network and discovers port 5432 open on the host.
2. Attacker connects: `psql -h <host> -U memwal -d memwal` with password `memwal_secret`.
3. Attacker can:
   - Read all vector entries, including encrypted blob references and metadata.
   - Delete entries to disrupt service.
   - Modify entries to inject malicious data.
   - Read all user/owner information.
   - Drop tables to cause a denial of service.

### Impact

- Full database access: read, write, delete all application data.
- Exposure of user metadata and ownership information.
- Potential for data corruption or service disruption.

### Why the severity rating is correct

LOW (dev-only) is appropriate because:
- The docker-compose.yml is intended for local development.
- The finding is LOW in a dev context but would be HIGH if used in production.
- The credentials are not for production systems (they are clearly development defaults).
- However, the risk is that this configuration is accidentally used in production or on a shared network.

### Remediation

1. Bind to localhost only:

```yaml
ports:
  - "127.0.0.1:5432:5432"
```

2. Use environment variables or Docker secrets for credentials:

```yaml
environment:
  POSTGRES_DB: memwal
  POSTGRES_USER: memwal
  POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
secrets:
  pg_password:
    file: ./secrets/pg_password.txt
```

3. Add `.env` to `.gitignore` and use `env_file` directive:

```yaml
env_file:
  - .env  # not committed to git
```

---

## 4.2 LOW: Redis Exposed Without Authentication

### What it is

Redis is exposed on all network interfaces (`0.0.0.0:6379`) with no authentication configured. Any host-reachable client can connect and execute arbitrary Redis commands, including flushing all data, reading rate limit state, or shutting down the server.

### Where in the code

**File:** `services/server/docker-compose.yml`, lines 22-28

```yaml
  redis:
    image: redis:7-alpine
    container_name: memwal-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
```

No `command: redis-server --requirepass` directive is present.

### How it could be exploited

1. Attacker scans the network and discovers port 6379 open.
2. Attacker connects: `redis-cli -h <host>`.
3. Attacker runs `FLUSHALL` to clear all rate limit state.
4. Combined with fail-open behavior (2.1), all rate limiting is now disabled.
5. Attacker can also run `SHUTDOWN NOSAVE` to crash Redis entirely.
6. Attacker can use `CONFIG SET` to write arbitrary files to the container filesystem (a known Redis exploitation technique).

### Impact

- Complete rate limit bypass when combined with fail-open behavior (2.1).
- Denial of service via `SHUTDOWN`.
- Potential container compromise via Redis `CONFIG SET` file-write exploitation.

### Why the severity rating is correct

LOW (dev-only) is appropriate because:
- Like 4.1, this is a development configuration.
- The chain risk with 2.1 (fail-open) elevates the actual production risk significantly.
- In a production context, this would be HIGH due to the ability to disable all rate limiting.

### Remediation

1. Require authentication:

```yaml
  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    ports:
      - "127.0.0.1:6379:6379"
```

2. Update the Redis URL in the application to include the password:

```
REDIS_URL=redis://:${REDIS_PASSWORD}@localhost:6379
```

3. Disable dangerous commands in production:

```yaml
command: >
  redis-server
  --requirepass ${REDIS_PASSWORD}
  --rename-command FLUSHALL ""
  --rename-command SHUTDOWN ""
  --rename-command CONFIG ""
```

---

## 4.3 LOW: No Resource Limits on Containers

### What it is

Neither the PostgreSQL nor Redis container in docker-compose.yml has any resource constraints configured (`mem_limit`, `cpus`, `deploy.resources`). A runaway query, memory leak, or deliberate resource exhaustion attack can consume all available host memory and CPU, affecting all services on the host.

### Where in the code

**File:** `services/server/docker-compose.yml` (entire file)

Neither the `postgres` service (lines 4-20) nor the `redis` service (lines 22-34) includes any resource limit directives. There is no `deploy:` section, no `mem_limit:`, no `cpus:`, and no Redis `maxmemory` configuration.

### How it could be exploited

1. Attacker sends many large requests that cause PostgreSQL to perform expensive queries (e.g., large vector similarity searches across many entries).
2. PostgreSQL allocates memory for query results, consuming available host RAM.
3. Redis, also without limits, grows unboundedly if rate limit keys accumulate.
4. The host runs out of memory, and the OOM killer terminates one or more containers -- or the host itself becomes unresponsive.
5. Alternatively, an attacker with Redis access (4.2) can write large values to consume all memory.

### Impact

- Denial of service for all services on the host.
- Potential host instability or crash.
- In shared hosting environments, could affect other tenants.

### Why the severity rating is correct

LOW is appropriate because:
- This is a hardening concern, not a direct vulnerability.
- Exploitation requires either sustained malicious traffic or access to Redis/PostgreSQL directly.
- The impact is availability, not confidentiality or integrity.

### Remediation

Add resource limits to docker-compose.yml:

```yaml
services:
  postgres:
    # ...
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2.0'

  redis:
    # ...
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
```

---

## 4.4 LOW: No Network Isolation Between Services

### What it is

Both services (PostgreSQL and Redis) share the default Docker bridge network. There is no custom network configuration to isolate database services from each other or from potential other containers on the same host. In a more complex deployment, this means any container on the default network can reach both PostgreSQL and Redis directly.

### Where in the code

**File:** `services/server/docker-compose.yml` (entire file)

No `networks:` section is defined. Both services use the default Docker Compose network (`memwal_default`).

### How it could be exploited

1. A compromised or malicious container on the same Docker host joins the default bridge network.
2. That container can reach both `memwal-postgres:5432` and `memwal-redis:6379` by their service names.
3. Combined with the lack of authentication on Redis (4.2), the compromised container can flush rate limit data or shut down Redis.
4. Combined with hardcoded PostgreSQL credentials (4.1), it can access the database.

### Impact

- Lateral movement from any compromised container on the same network to MemWal's data stores.
- Reduced defense-in-depth.

### Why the severity rating is correct

LOW is appropriate because:
- This requires another compromised container on the same host, which is a prerequisite that raises the bar.
- For a development setup with only these two services, the risk is minimal.
- It is a defense-in-depth recommendation, not a directly exploitable vulnerability.

### Remediation

Define separate networks:

```yaml
services:
  postgres:
    # ...
    networks:
      - backend

  redis:
    # ...
    networks:
      - backend

networks:
  backend:
    driver: bridge
    internal: true  # No external access
```

For production, use `internal: true` to prevent containers from reaching the internet, and create separate networks for different trust boundaries.

---

## 5.1 MEDIUM: Container Runs as Root (Confirms Vuln 11)

### What it is

The Dockerfile does not include a `USER` directive, meaning the Rust server binary and any child processes (including the Node.js sidecar) run as `root` inside the container. If an attacker achieves code execution within the container (e.g., through a vulnerability in the server, the sidecar, or a dependency), they have root privileges, which makes container escape significantly easier.

### Where in the code

**File:** `services/server/Dockerfile` (entire file, 55 lines)

The file contains no `USER` directive anywhere. The final command runs as root:

```dockerfile
# Line 55
CMD ["./memwal-server"]
```

The sidecar scripts are also copied and run as root:

```dockerfile
# Lines 41-43
COPY scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm ci --omit=dev
COPY scripts/*.ts ./scripts/
```

### How it could be exploited

1. An attacker discovers a remote code execution vulnerability in the Rust server (e.g., via a parsing bug or dependency vulnerability).
2. The attacker executes code inside the container as `root`.
3. As root, the attacker can:
   - Read all files in the container (including any secrets mounted at runtime).
   - Modify the running binary or sidecar scripts.
   - Attempt container escape via kernel exploits (which typically require root or specific capabilities).
   - Access the Docker socket if mounted.
   - Install tools for further reconnaissance.

### Impact

- Elevated privileges make container escape more feasible.
- Root access within the container allows reading all mounted secrets and environment variables.
- Compromised container can be used as a pivot point for attacking other services.

### Why the severity rating is correct

MEDIUM is appropriate because:
- Running as root is a well-known container security anti-pattern.
- It does not directly lead to compromise but significantly amplifies the impact of any code execution vulnerability.
- The fix is trivial (3 lines in Dockerfile).
- It is standard practice in all container hardening guidelines (CIS Benchmark, Docker Best Practices).

### Remediation

Add a non-root user to the Dockerfile before the `CMD` directive:

```dockerfile
# After COPY commands, before CMD
RUN groupadd --system appgroup && \
    useradd --system --gid appgroup --no-create-home appuser && \
    chown -R appuser:appgroup /app

USER appuser

CMD ["./memwal-server"]
```

---

## 5.2 MEDIUM: curl Pipe to bash in Dockerfile (Supply Chain)

### What it is

The Dockerfile installs Node.js by fetching a remote setup script via `curl` and piping it directly to `bash`. This is a supply chain risk because the script at `https://deb.nodesource.com/setup_22.x` could be compromised at any time (by an attacker who gains access to NodeSource's infrastructure, via a DNS hijack, or via a CDN compromise), and the Dockerfile would execute arbitrary malicious code during the build.

### Where in the code

**File:** `services/server/Dockerfile`, line 31

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libssl3 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
```

The `curl -fsSL https://deb.nodesource.com/setup_22.x | bash -` pattern downloads and immediately executes a remote script with no integrity verification.

### How it could be exploited

1. An attacker compromises NodeSource's CDN or DNS.
2. The script at `setup_22.x` is replaced with a malicious version that:
   - Adds a backdoor to the container image.
   - Exfiltrates build secrets or source code.
   - Installs a cryptocurrency miner.
   - Modifies the Node.js binary to intercept sidecar communications.
3. The next Docker build fetches the compromised script and executes it as root.
4. All subsequently deployed containers contain the backdoor.

### Impact

- Complete supply chain compromise of the container image.
- Any code can be injected during build time.
- The build runs as root, so the injected code has unrestricted access.
- Difficult to detect because the script URL is legitimate-looking.

### Why the severity rating is correct

MEDIUM is appropriate because:
- The attack requires compromising a third-party infrastructure (NodeSource), which is a significant prerequisite.
- The `curl | bash` pattern is widely recognized as a security anti-pattern.
- The impact of a successful supply chain attack would be severe (full container compromise).
- The rating balances the high impact against the relatively low probability.

### Remediation

Use a multi-stage build with the official Node.js image:

```dockerfile
# Stage for Node.js
FROM node:22-bookworm-slim AS node

# Stage 2: Runtime
FROM debian:bookworm-slim AS runtime

# Copy Node.js from official image (no curl | bash)
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/bin/npm /usr/local/bin/npm
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

# ... rest of Dockerfile
```

Or download the script, verify its checksum, then execute:

```dockerfile
RUN curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/setup_node.sh \
    && echo "<expected_sha256>  /tmp/setup_node.sh" | sha256sum -c - \
    && bash /tmp/setup_node.sh \
    && rm /tmp/setup_node.sh
```

---

## 5.3 LOW: No Image Pinning by Digest

### What it is

The Dockerfile uses mutable image tags (`rust:1.85-bookworm` and `debian:bookworm-slim`) rather than immutable digests. Mutable tags can be updated to point to different images at any time. If a base image is compromised or silently updated with breaking changes, the Dockerfile will use the new image on the next build without any warning.

### Where in the code

**File:** `services/server/Dockerfile`, lines 7 and 24

```dockerfile
FROM rust:1.85-bookworm AS builder      # line 7
```

```dockerfile
FROM debian:bookworm-slim AS runtime    # line 24
```

### How it could be exploited

1. An attacker compromises the Docker Hub account for the `debian` or `rust` images (or Docker Hub infrastructure itself).
2. The tag `bookworm-slim` is updated to point to a malicious image containing a backdoor.
3. The next `docker build` pulls the compromised image.
4. The built container contains the backdoor.

Alternatively, a non-malicious but breaking update to the base image could introduce unexpected behavior or vulnerabilities.

### Impact

- Potential supply chain compromise if base images are tampered with.
- Non-reproducible builds -- building the same Dockerfile at different times may produce different images.
- Difficult to audit what exact base image was used for a given deployment.

### Why the severity rating is correct

LOW is appropriate because:
- Compromising official Docker Hub images is extremely difficult (though it has happened).
- The Rust version tag (`1.85`) provides some specificity beyond just `latest`.
- This is a best-practice hardening recommendation.

### Remediation

Pin images by digest:

```dockerfile
FROM rust:1.85-bookworm@sha256:abc123... AS builder
FROM debian:bookworm-slim@sha256:def456... AS runtime
```

To find the current digest:

```bash
docker pull rust:1.85-bookworm
docker inspect --format='{{index .RepoDigests 0}}' rust:1.85-bookworm
```

---

## 5.4 INFO: EXPOSE Only Documents Port 8000

### What it is

The Dockerfile's `EXPOSE` directive only documents port 8000 (the Rust server port). The Node.js sidecar listens on port 9000 by default (set via `ENV SIDECAR_PORT=9000`), but this port is not documented via `EXPOSE`. Note that `EXPOSE` is purely documentation in Docker -- it does not actually publish or restrict ports. This is actually a positive finding: not exposing port 9000 reduces the chance of accidentally mapping the sidecar to the host.

### Where in the code

**File:** `services/server/Dockerfile`, lines 49-53

```dockerfile
ENV PORT=8000
ENV SIDECAR_PORT=9000
ENV SIDECAR_URL=http://localhost:9000
ENV SIDECAR_SCRIPTS_DIR=/app/scripts
EXPOSE ${PORT}
```

Only `${PORT}` (8000) is exposed. `${SIDECAR_PORT}` (9000) is not.

### How it could be exploited

This is not exploitable. It is an informational observation. The sidecar is an internal component that should only be accessed from within the container (via `localhost:9000`). Not exposing it is the correct behavior.

### Impact

None. This is a positive observation.

### Why the severity rating is correct

INFORMATIONAL is correct because this is not a vulnerability. It documents an observation about the Dockerfile configuration that is actually security-positive (reducing the attack surface by not advertising the sidecar port).

### Remediation

No action required. Optionally, add a comment to the Dockerfile explaining why port 9000 is intentionally not exposed:

```dockerfile
# Only expose the public API port. Sidecar (port 9000) is container-internal only.
EXPOSE ${PORT}
```

---

## 7.1 LOW: Database Credentials in Committed docker-compose.yml

### What it is

The PostgreSQL password `memwal_secret` is hardcoded directly in the `docker-compose.yml` file, which is committed to the git repository. Anyone with access to the repository (including public access if the repo is open-source) can see these credentials. If the same docker-compose.yml is used in any environment with network-accessible PostgreSQL, the credentials are known.

### Where in the code

**File:** `services/server/docker-compose.yml`, lines 9-11

```yaml
environment:
  POSTGRES_DB: memwal
  POSTGRES_USER: memwal
  POSTGRES_PASSWORD: memwal_secret
```

### How it could be exploited

1. Attacker views the repository (public or after gaining repository access).
2. Attacker identifies the hardcoded password `memwal_secret`.
3. If the docker-compose.yml is used in a staging or production environment (or if a developer runs it on a network-accessible machine), the attacker connects: `psql -h <host> -U memwal -d memwal -W` with password `memwal_secret`.
4. Attacker has full database access.

This is compounded by finding 4.1 (PostgreSQL exposed on `0.0.0.0:5432`).

### Impact

- Known database credentials available to anyone who can read the repository.
- If combined with network exposure (4.1), provides direct database access.
- Risk of credential reuse -- developers may copy these credentials to other environments.

### Why the severity rating is correct

LOW (dev) / MEDIUM (if copied for prod) is appropriate because:
- The docker-compose.yml is clearly a development configuration.
- The password is an obviously non-production value (`memwal_secret`).
- However, the pattern of committing credentials normalizes insecure practices and creates risk of accidental production use.
- Git history means the credentials persist even if later changed.

### Remediation

1. Move credentials to a `.env` file that is not committed:

```yaml
# docker-compose.yml
environment:
  POSTGRES_DB: memwal
  POSTGRES_USER: memwal
  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
```

```bash
# .env (add to .gitignore)
POSTGRES_PASSWORD=memwal_secret
```

2. Add `.env` to `.gitignore`:

```
# .gitignore
.env
```

3. Provide a `.env.example` file with placeholder values:

```bash
# .env.example (committed to git)
POSTGRES_PASSWORD=change_me_in_production
```

4. For production, use Docker secrets:

```yaml
services:
  postgres:
    secrets:
      - pg_password
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password

secrets:
  pg_password:
    external: true
```
