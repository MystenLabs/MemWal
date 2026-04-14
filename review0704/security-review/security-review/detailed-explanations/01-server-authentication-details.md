# Detailed Explanations: MemWal Server Authentication Findings

**Source review:** `security-review/01-server-authentication.md`
**Commit:** 5bb1669
**Date:** 2026-04-02

---

## F-1: No Replay Protection

**Severity:** MEDIUM | **Confidence:** 10/10 | **Status:** Confirms Existing Audit Vuln 8

### What it is

The server authenticates requests using Ed25519 signatures over a message that includes a Unix timestamp, but there is no mechanism to prevent the same signed request from being submitted multiple times within the 5-minute validity window. The server does not track previously seen signatures, nonces, or request identifiers. Any valid signed request can be replayed verbatim by anyone who observes it on the network.

### Where in the code

**File:** `services/server/src/auth.rs`, lines 66-74

```rust
// Validate timestamp (5 minute window)
let timestamp: i64 = timestamp_str
    .parse()
    .map_err(|_| StatusCode::UNAUTHORIZED)?;
let now = chrono::Utc::now().timestamp();
if (now - timestamp).abs() > 300 {
    tracing::warn!("Request timestamp too old: {} (now: {})", timestamp, now);
    return Err(StatusCode::UNAUTHORIZED);
}
```

The signed message is constructed at lines 92-103:

```rust
let method = request.method().as_str().to_string();
let path = request.uri().path().to_string();
// ...
let body_hash = hex::encode(Sha256::digest(&body_bytes));
let message = format!("{}.{}.{}.{}", timestamp_str, method, path, body_hash);
```

The message format is `"{timestamp}.{method}.{path}.{body_sha256}"`. There is no nonce, request ID, or any other unique-per-request component. The only freshness guarantee is the 300-second timestamp window.

### How it could be exploited

1. An attacker positions themselves to observe network traffic between the client and the MemWal server (e.g., via a compromised reverse proxy, Wi-Fi sniffing on an unencrypted connection, or access to server logs that include request headers).
2. The attacker captures a complete HTTP request including the `x-public-key`, `x-signature`, `x-timestamp`, and body.
3. Within 5 minutes of the original timestamp, the attacker replays the exact same request to the server. The timestamp is still within the window, the signature is still valid over the same message, and the server has no record of having already processed this signature.
4. The attacker can repeat this as many times as they want within the 5-minute window.

For a `POST /api/remember` request, each replay would store a duplicate memory entry, consuming the victim's storage quota and Walrus storage fees. For `POST /api/analyze`, each replay triggers expensive LLM calls (cost weight 10). For `POST /api/recall`, each replay leaks the same data to whatever destination the attacker controls.

### Impact

- **Resource exhaustion:** Repeated `remember` or `analyze` calls consume storage quota, embedding API credits, and Walrus storage costs.
- **Data exfiltration amplification:** A single captured `recall` request can be replayed to retrieve data multiple times from different network locations.
- **Rate limit bypass (partial):** If Redis is down (F-9), the rate limiter fails open, so replayed requests face no throttling at all.

### Why the severity rating is correct

MEDIUM is appropriate because:
- The attack requires a network-level adversary who can observe traffic. In most deployments, TLS protects the transport, which significantly raises the bar.
- The 5-minute window bounds the replay window. An attacker cannot replay indefinitely.
- The rate limiter (when functional) provides partial mitigation by counting replayed requests against limits.
- However, the attack is trivially executable once traffic is observed, and the consequences (resource consumption, data leakage) are meaningful.

It is not HIGH because it requires a precondition (traffic observation) and has a bounded time window. It is not LOW because the impact is concrete and the mitigation (rate limiter) has its own vulnerabilities (F-9).

### Remediation

Add a nonce to the signed message and track seen nonces in Redis with a 5-minute TTL.

**Client-side change** -- add a random nonce to the signed message:

```
// Signed message format becomes:
// "{timestamp}.{nonce}.{method}.{path}.{body_sha256}"
let nonce = uuid::Uuid::new_v4().to_string();
```

**Server-side change in `auth.rs`:**

```rust
// Extract nonce header
let nonce = headers
    .get("x-nonce")
    .and_then(|v| v.to_str().ok())
    .map(String::from)
    .ok_or(StatusCode::UNAUTHORIZED)?;

// After signature verification succeeds, check nonce uniqueness:
let nonce_key = format!("nonce:{}", hex::encode(Sha256::digest(signature_hex.as_bytes())));
let mut redis = state.redis.clone();
let already_seen: bool = redis::cmd("SET")
    .arg(&nonce_key)
    .arg("1")
    .arg("NX")       // only set if not exists
    .arg("EX")
    .arg(310)         // TTL slightly longer than the 300s window
    .query_async(&mut redis)
    .await
    .map(|result: Option<String>| result.is_none())  // None means key already existed
    .unwrap_or(false); // fail closed: if Redis is down, reject

if already_seen {
    return Err(StatusCode::UNAUTHORIZED);
}
```

Alternatively, track signatures directly (the signature itself is unique per nonce/timestamp combination) to avoid requiring a new header, using the raw signature hex as the Redis key.

---

## F-2: Query String Not Signed

**Severity:** LOW | **Confidence:** 10/10 | **Status:** Confirms Existing Audit Vuln 9, downgraded from MEDIUM

### What it is

The signed message covers the URL path but not the query string. When constructing the message to verify, the server uses `request.uri().path()` which returns only the path component (e.g., `/api/recall`) and strips any query parameters (e.g., `?debug=true`). If a future endpoint reads query parameters, an attacker could modify them without invalidating the signature.

### Where in the code

**File:** `services/server/src/auth.rs`, line 93

```rust
let path = request.uri().path().to_string();
```

This value is then included in the signed message at line 103:

```rust
let message = format!("{}.{}.{}.{}", timestamp_str, method, path, body_hash);
```

The `path()` method on `axum::http::Uri` returns only the path component. For a request to `/api/recall?limit=100`, `path()` returns `/api/recall` -- the `?limit=100` portion is silently dropped from the signed material.

### How it could be exploited

1. Attacker intercepts a signed request to a hypothetical future endpoint that accepts query parameters, e.g., `GET /api/recall?namespace=work&limit=5`.
2. The attacker modifies the query string to `GET /api/recall?namespace=personal&limit=1000` without changing the signature.
3. The server verifies the signature against `"{timestamp}.GET./api/recall.{body_hash}"` -- which matches, because the query string was never part of the signed message.
4. The attacker retrieves data from a different namespace or with different parameters than the original signer intended.

### Impact

Currently zero. All existing protected routes are POST endpoints that use JSON request bodies, not query parameters. The body is covered by the signature (via SHA-256 hash). The risk is entirely forward-looking: if GET routes with query parameters are added to the protected router without updating the signing scheme, those parameters would be unsigned.

### Why the severity rating is correct

LOW is appropriate because:
- No current route is affected. All protected routes use POST with JSON bodies.
- The method is part of the signed message, so a POST signature cannot be reused for a GET request.
- This is a defense-in-depth gap, not an actively exploitable vulnerability.
- The original MEDIUM rating was too high given the lack of any current attack surface.

### Remediation

Replace `request.uri().path()` with the full path-and-query string.

**File:** `services/server/src/auth.rs`, line 93

Change:
```rust
let path = request.uri().path().to_string();
```

To:
```rust
let path = request.uri().path_and_query()
    .map(|pq| pq.as_str())
    .unwrap_or(request.uri().path())
    .to_string();
```

The SDK must also be updated to sign `path_and_query` instead of just `path`. This is a coordinated change between client and server.

---

## F-3: Delegate Private Key in HTTP Headers

**Severity:** HIGH | **Confidence:** 10/10 | **Status:** Confirms Existing Audit Vuln 1

### What it is

The client SDK sends the Ed25519 delegate private key in plaintext as an HTTP header (`x-delegate-key`) with every authenticated request. This private key is the cryptographic identity of the delegate -- it can sign transactions and decrypt SEAL-encrypted data. Transmitting it over HTTP means it is exposed at every network hop and stored in `AuthInfo` in server memory for the duration of request processing.

### Where in the code

**File:** `services/server/src/auth.rs`, lines 60-64 -- header extraction:

```rust
// Optional delegate private key (hex) for SEAL decrypt
let delegate_key_hex = headers
    .get("x-delegate-key")
    .and_then(|v| v.to_str().ok())
    .map(String::from);
```

**File:** `services/server/src/auth.rs`, lines 126-131 -- stored in `AuthInfo`:

```rust
parts.extensions.insert(AuthInfo {
    public_key: public_key_hex,
    owner,
    account_id,
    delegate_key: delegate_key_hex,
});
```

**File:** `services/server/src/types.rs`, lines 317-327 -- the `AuthInfo` struct:

```rust
#[derive(Debug, Clone)]
pub struct AuthInfo {
    #[allow(dead_code)]
    pub public_key: String,
    /// Owner address from the onchain MemWalAccount (set after onchain verification)
    pub owner: String,
    /// MemWalAccount object ID (set after onchain verification)
    pub account_id: String,
    /// Delegate private key (hex) — used for SEAL decrypt SessionKey
    pub delegate_key: Option<String>,
}
```

**File:** `services/server/src/routes.rs`, lines 203-206 -- used for SEAL decryption:

```rust
let private_key = auth.delegate_key.as_deref()
    .or(state.config.sui_private_key.as_deref())
    .ok_or_else(|| {
        AppError::Internal("Delegate key or SERVER_SUI_PRIVATE_KEY required for SEAL decryption".into())
    })?;
```

This pattern repeats at lines 636 and 802 in routes.rs for the `ask` and `restore` endpoints respectively.

### How it could be exploited

1. **Network interception:** A reverse proxy, load balancer, CDN, or any TLS-terminating middlebox logs HTTP headers. The delegate private key appears in those logs as a plain hex string. An attacker with access to those logs (e.g., a compromised Nginx access log, a cloud provider's request tracing dashboard) obtains the private key.

2. **Server-side logging:** The `AuthInfo` struct derives `Debug` (see F-10). Any accidental `tracing::debug!("{:?}", auth_info)` or `dbg!(auth_info)` statement prints the full private key to logs. While no current code path does this, the `Clone` and `Debug` derives make it trivially easy to introduce.

3. **Memory dumps / core dumps:** The private key is held in-memory as a `String` (heap-allocated, not zeroed on drop) for the entire request lifecycle. A process core dump or memory inspection reveals the key.

4. **With the key, the attacker can:**
   - Sign new requests as the delegate (full API access to the victim's account).
   - Decrypt all SEAL-encrypted data belonging to the account.
   - Create SEAL session keys and decrypt historical encrypted blobs stored on Walrus.

### Impact

Complete compromise of the delegate identity. The attacker gains the ability to read all encrypted memories, write new memories, and impersonate the delegate for any API operation. This is equivalent to full account takeover for the scope of operations the delegate key is authorized to perform.

### Why the severity rating is correct

HIGH is appropriate because:
- Private key exposure is a fundamental cryptographic compromise. The key is the identity.
- The exposure surface is broad: every HTTP request carries the key, and every network hop and logging system is a potential leak point.
- The impact is severe: full read/write access to encrypted data and API operations.
- It is not CRITICAL only because: (a) the delegate key has limited scope compared to the account owner key, (b) TLS in transit mitigates network-level interception in well-configured deployments, and (c) the delegate key can be revoked on-chain by the account owner.

### Remediation

The architecture should be redesigned so the delegate private key never leaves the client.

**Short-term (reduce exposure):**

1. Implement a manual `Debug` trait on `AuthInfo` that redacts the delegate key (also addresses F-10):

```rust
impl std::fmt::Debug for AuthInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthInfo")
            .field("public_key", &self.public_key)
            .field("owner", &self.owner)
            .field("account_id", &self.account_id)
            .field("delegate_key", &self.delegate_key.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}
```

2. Use `secrecy::SecretString` instead of `Option<String>` to ensure the key is zeroed on drop and cannot be accidentally printed.

**Long-term (eliminate the exposure):**

Remove `x-delegate-key` from the HTTP protocol entirely. Instead:
- For SEAL decryption, use the server's own `SERVER_SUI_PRIVATE_KEY` (which is already a fallback).
- Or implement a challenge-response protocol where the server sends a SEAL session challenge and the client signs it locally, returning only the session key (not the private key).
- The `MemWalManual` SDK class already avoids sending the delegate key; this pattern should become the default.

---

## F-4: Account `active` Status Not Checked in Auth Middleware

**Severity:** MEDIUM | **Confidence:** 9/10 | **Status:** NEW

### What it is

The Move smart contract on Sui has an `active` boolean field on `MemWalAccount` objects. When an account owner calls `deactivate_account()`, this field is set to `false`, which is intended to freeze all access for all delegate keys on that account. The on-chain `seal_approve` function checks this field and rejects operations on inactive accounts. However, the server's `verify_delegate_key_onchain` function in `sui.rs` fetches the account object and checks delegate keys but **never reads the `active` field**. A deactivated account passes server-side authentication.

### Where in the code

**File:** `services/server/src/sui.rs`, lines 10-105 -- the `verify_delegate_key_onchain` function.

The function extracts `owner` and `delegate_keys` from the account object's fields:

```rust
// Extract owner address
let owner = fields
    .get("owner")
    .and_then(|v| v.as_str())
    .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'owner' field".into()))?
    .to_string();

// Extract delegate_keys array
let delegate_keys = fields
    .get("delegate_keys")
    .and_then(|v| v.as_array())
    .ok_or_else(|| OnchainVerifyError::RpcError("Missing 'delegate_keys' field".into()))?;
```

Note that the `fields` variable (a `serde_json::Map`) contains all account fields returned by the Sui RPC, including `active`. But the function never reads `fields.get("active")`. It only checks whether the public key exists in `delegate_keys` (lines 79-98) and returns `Ok(owner)` if found -- regardless of the account's active status.

### How it could be exploited

1. An account owner suspects their delegate key has been compromised.
2. The owner calls `deactivate_account()` on-chain, expecting all API access to stop immediately.
3. The attacker, still holding the compromised delegate key, continues making API calls.
4. The server's auth middleware calls `verify_delegate_key_onchain`, which fetches the account and finds the delegate key still present in `delegate_keys` (deactivation does not remove keys). The `active` field is `false`, but the server never checks it.
5. The attacker successfully authenticates and can:
   - Call `POST /api/remember/manual` to write garbage data, consuming the victim's storage quota.
   - Call `POST /api/recall/manual` to read vector metadata and blob IDs.
   - Call `POST /api/remember` to trigger embedding generation and Walrus uploads (the SEAL encryption will use a key that cannot later be decrypted via `seal_approve`, but the storage and compute costs are still incurred).
   - Call `POST /api/analyze` to consume expensive LLM API credits (cost weight 10).

Operations involving SEAL decryption (`recall`, `ask`, `restore`) will partially fail at the SEAL key server level (since `seal_approve` checks `active`), but the request still consumes rate limit budget, embedding API calls, and compute resources before reaching the SEAL step.

### Impact

- Account deactivation does not actually prevent API access, undermining the security model.
- An attacker with a compromised delegate key can continue to consume resources (storage, compute, LLM API credits) even after the owner has attempted to revoke access.
- Non-SEAL endpoints (`remember_manual`, `recall_manual`) work completely, allowing data writes and metadata reads on a deactivated account.

### Why the severity rating is correct

MEDIUM is appropriate because:
- The vulnerability breaks a documented security invariant (account deactivation should freeze access).
- The impact is meaningful: resource consumption and partial data access continue.
- However, SEAL-dependent operations (which are the most sensitive -- reading encrypted data) are still blocked by the on-chain `seal_approve` check.
- The owner can still remove the compromised delegate key on-chain (a separate operation from deactivation), which would cause auth to fail.
- It is not HIGH because the most critical operations (decrypting memories) are protected by SEAL's independent check.

### Remediation

Add an `active` field check in `verify_delegate_key_onchain` after extracting the fields.

**File:** `services/server/src/sui.rs`, after line 64 (after extracting `owner`):

```rust
// Check that the account is active
let active = fields
    .get("active")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
if !active {
    return Err(OnchainVerifyError::AccountDeactivated(format!(
        "Account {} is deactivated", account_object_id
    )));
}
```

Add the new error variant to `OnchainVerifyError`:

```rust
pub enum OnchainVerifyError {
    RpcError(String),
    KeyNotFound(String),
    AccountDeactivated(String),  // NEW
}
```

Update the `Display` impl accordingly:

```rust
OnchainVerifyError::AccountDeactivated(msg) => write!(f, "Account deactivated: {}", msg),
```

---

## F-5: Config Fallback Account Resolution

**Severity:** LOW | **Confidence:** 8/10 | **Status:** Confirms Existing Audit Vuln 13

### What it is

When the server cannot find a delegate key via the PostgreSQL cache (Strategy 1) or the on-chain registry scan (Strategy 2), it falls back to Strategy 3: using either the `x-account-id` HTTP header or the `MEMWAL_ACCOUNT_ID` environment variable to identify which account to check. This allows a client to supply an arbitrary account ID via the header, which the server will then query on-chain. While the server still verifies the delegate key on-chain (so it cannot be exploited for unauthorized access), it introduces minor information leakage and a performance concern.

### Where in the code

**File:** `services/server/src/auth.rs`, lines 194-211

```rust
// Strategy 3: Use header hint or config fallback
let fallback_account_id = account_id_hint
    .or_else(|| state.config.memwal_account_id.clone())
    .ok_or_else(|| "no account found: not in cache, registry, or header".to_string())?;

let owner = verify_delegate_key_onchain(
    &state.http_client,
    &state.config.sui_rpc_url,
    &fallback_account_id,
    pk_bytes,
)
.await
.map_err(|e| format!("fallback account {} verification failed: {}", fallback_account_id, e))?;

// Cache for future requests
let _ = state.db.cache_delegate_key(public_key_hex, &fallback_account_id, &owner).await;

Ok((fallback_account_id, owner))
```

The `account_id_hint` comes from the `x-account-id` header extracted at lines 54-58:

```rust
let account_id_hint = headers
    .get("x-account-id")
    .and_then(|v| v.to_str().ok())
    .map(String::from);
```

### How it could be exploited

1. An attacker sends a request with a valid delegate key signature but includes an `x-account-id` header pointing to a specific account they want to probe.
2. If Strategy 1 and Strategy 2 both fail (e.g., the key is newly created and not yet indexed), Strategy 3 uses the attacker-supplied account ID.
3. The server calls `verify_delegate_key_onchain` with the attacker-supplied account ID.
4. The response is always 401 (since the attacker's key is not actually registered in the target account), but **timing differences** between different failure modes could leak information:
   - "Account object does not exist" fails fast at the RPC level.
   - "Account exists but key not found" requires parsing the full delegate_keys array.
   - These timing differences reveal whether a given account ID is valid and how many delegate keys it has.

Additionally, in a multi-tenant deployment where `MEMWAL_ACCOUNT_ID` is set, all requests that fail Strategy 1 and 2 will check against a single hardcoded account. This is safe for single-tenant deployments but misleading in multi-tenant configurations.

### Impact

- Minor information leakage: an attacker can probe whether specific Sui object IDs are valid MemWalAccount objects.
- No authentication bypass: `verify_delegate_key_onchain` always verifies the key, so a fake `x-account-id` cannot grant access to an account where the key is not registered.
- Performance: an attacker can force the server to make RPC calls to arbitrary account IDs, though the rate limiter (pre-auth) does not apply since this happens within the auth middleware.

### Why the severity rating is correct

LOW is appropriate because:
- There is no authentication bypass. The on-chain verification is always performed.
- The information leakage (account existence) is minor -- account IDs on Sui are public on-chain data anyway.
- The practical exploitability is low in most deployment configurations.

### Remediation

1. Document that `MEMWAL_ACCOUNT_ID` should only be used in single-tenant deployments.
2. Consider making error responses constant-time to prevent timing-based account probing:

```rust
// Add a constant delay to all auth failures to prevent timing leaks
async fn constant_time_error() -> StatusCode {
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    StatusCode::UNAUTHORIZED
}
```

3. Consider removing the `x-account-id` header entirely once the registry scan (Strategy 2) is reliable, or rate-limit Strategy 3 attempts separately.

---

## F-6: TOCTOU in Cache

**Severity:** LOW | **Confidence:** 5/10 | **Status:** Confirms Existing Audit Vuln 16

### What it is

TOCTOU (Time-of-Check-to-Time-of-Use) refers to a race condition where the state of a resource changes between the time it is checked and the time it is used. In MemWal's auth flow, after the delegate key is verified on-chain, the request proceeds to the route handler. During the time between on-chain verification completing and the route handler finishing its work, the delegate key could be removed on-chain. The server would not know about this revocation until the next request triggers a new on-chain check.

### Where in the code

**File:** `services/server/src/auth.rs`, lines 152-173

```rust
// Strategy 1: Check PostgreSQL cache
if let Ok(Some((cached_account_id, _cached_owner))) =
    state.db.get_cached_account(public_key_hex).await
{
    // Verify the cached mapping is still valid onchain
    match verify_delegate_key_onchain(
        &state.http_client,
        &state.config.sui_rpc_url,
        &cached_account_id,
        pk_bytes,
    )
    .await
    {
        Ok(owner) => {
            tracing::debug!("account resolved from cache: {}", cached_account_id);
            return Ok((cached_account_id, owner));
        }
        Err(_) => {
            // Cache is stale (key was removed), continue to other strategies
            tracing::debug!("cached account {} is stale, re-resolving", cached_account_id);
        }
    }
}
```

The key design point is that Strategy 1 **always** re-verifies on-chain (line 156-162). The cache is only used as a performance hint to know which account ID to check, not as an authoritative source. This is the strongest possible design for a cache-based system.

The TOCTOU window is: after `verify_delegate_key_onchain` returns `Ok(owner)` at line 164, and before the route handler finishes executing. During this window (typically milliseconds to seconds), the key could be revoked on-chain.

### How it could be exploited

1. Attacker has a legitimate delegate key that is about to be revoked.
2. Attacker sends a request at the exact moment the account owner removes the delegate key on-chain.
3. The server's `verify_delegate_key_onchain` call races with the on-chain transaction. If the RPC node returns the pre-revocation state, the request is authorized.
4. The route handler executes with the now-revoked key's authorization.

For SEAL-dependent operations, there is a second check: the SEAL key server independently verifies the delegate key on-chain during decryption. This provides defense-in-depth that further narrows the TOCTOU window.

### Impact

- A single request may execute with a just-revoked key's authorization.
- The window is extremely narrow (milliseconds).
- SEAL operations have a second independent on-chain check, making exploitation of SEAL endpoints nearly impossible.
- Non-SEAL endpoints (`remember_manual`, `recall_manual`) are more exposed but the window is still very small.

### Why the severity rating is correct

LOW is appropriate because:
- The cache always re-verifies on-chain, which is the correct design. The TOCTOU is inherent to any distributed system where authorization state can change.
- The window is extremely narrow (sub-second).
- SEAL provides defense-in-depth for the most sensitive operations.
- Exploiting this requires precise timing coordination between the attacker's request and the owner's revocation transaction.
- Confidence is only 5/10 because this is more of a theoretical concern than a practical exploit.

### Remediation

This is inherent to any system that checks authorization at request time in a distributed environment. Full mitigation would require:

1. **Acceptable risk:** The current design is already near-optimal. Document the TOCTOU window as an accepted risk.
2. **Additional defense-in-depth:** For critical write operations, perform a second on-chain check immediately before the write completes (at the cost of an additional RPC call per request).
3. **Event-based revocation:** Subscribe to Sui on-chain events for key revocations and maintain a local revocation list that is checked synchronously. This reduces the window to event propagation latency.

---

## F-7: Stale Cache Entries Not Evicted

**Severity:** Informational | **Confidence:** 8/10 | **Status:** NEW

### What it is

When the auth middleware detects that a cached delegate key mapping is no longer valid on-chain (the key was removed from the account), it logs the staleness and falls through to Strategy 2 (registry scan). However, it never deletes the stale entry from the PostgreSQL `delegate_key_cache` table. On every subsequent request with the same (now-revoked) key, Strategy 1 will hit the cache, find the stale mapping, make an RPC call to verify it (which fails), log the staleness again, and fall through to Strategy 2 again. This cycle repeats indefinitely.

### Where in the code

**File:** `services/server/src/auth.rs`, lines 168-172 -- the stale cache detection path:

```rust
Err(_) => {
    // Cache is stale (key was removed), continue to other strategies
    tracing::debug!("cached account {} is stale, re-resolving", cached_account_id);
}
```

After this block, execution falls through to Strategy 2 with no cache eviction. The stale entry persists in the database.

The cache write uses an upsert pattern (from `services/server/src/db.rs`, lines 192-196):

```sql
INSERT INTO delegate_key_cache (public_key, account_id, owner)
VALUES ($1, $2, $3)
ON CONFLICT (public_key)
DO UPDATE SET account_id = $2, owner = $3, cached_at = NOW()
```

This means a stale entry will only be overwritten if the key is found in a *different* account during Strategy 2. If the key is fully revoked (not in any account), the stale entry remains forever.

### How it could be exploited

This is not exploitable for authentication bypass. The stale cache entry triggers an on-chain verification that fails, so the revoked key is still rejected (either by all three strategies failing, or by Strategy 2/3 also failing to find the key).

The impact is purely operational:
- Every request with a revoked key incurs an unnecessary RPC call to verify the stale cached account.
- Log noise from repeated "stale, re-resolving" messages.
- If many keys are revoked, the accumulated unnecessary RPC calls could increase latency and RPC costs.

### Impact

Performance only. No security impact. Revoked keys are still correctly rejected.

### Why the severity rating is correct

Informational is appropriate because there is zero security impact. The finding is about operational efficiency and code hygiene, not about any exploitable vulnerability.

### Remediation

Delete the stale cache entry when on-chain verification fails.

**File:** `services/server/src/auth.rs`, in the stale cache handler (around line 168):

```rust
Err(_) => {
    // Cache is stale (key was removed), evict it
    tracing::debug!("cached account {} is stale, evicting and re-resolving", cached_account_id);
    let _ = state.db.delete_cached_key(public_key_hex).await;
}
```

Add a new method to `VectorDb` in `db.rs`:

```rust
pub async fn delete_cached_key(&self, public_key_hex: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM delegate_key_cache WHERE public_key = $1")
        .bind(public_key_hex)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to delete stale cache: {}", e)))?;
    Ok(())
}
```

---

## F-8: Rate Limiter Check-Then-Record Race Condition

**Severity:** LOW | **Confidence:** 7/10 | **Status:** NEW

### What it is

The rate limiter performs all three limit checks (delegate-key burst, account burst, account sustained) as separate Redis read operations, and then records the request in all three windows as separate Redis write operations. These are not atomic. Under high concurrency, multiple requests from the same key can all pass the check phase before any of them execute the record phase, allowing a burst that exceeds the configured limit.

### Where in the code

**File:** `services/server/src/rate_limit.rs`, lines 229-286

The three check phases happen sequentially at lines 229, 249, and 268:

```rust
// --- Layer 1: Per-delegate-key (burst) ---
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

// --- Layer 2: Per-account burst (1 min) ---
match check_window(&mut redis, &burst_key, burst_window_start).await {
    // ... same pattern
}

// --- Layer 3: Per-account sustained (1 hour) ---
match check_window(&mut redis, &hourly_key, hourly_window_start).await {
    // ... same pattern
}
```

Then all three record operations happen at lines 284-286:

```rust
// --- All checks passed: record weighted entries in all 3 windows ---
record_in_window(&mut redis, &dk_key, now, weight, 120).await;
record_in_window(&mut redis, &burst_key, now + 0.1, weight, 120).await;
record_in_window(&mut redis, &hourly_key, now + 0.2, weight, 3700).await;
```

The `check_window` function (lines 126-139) uses a Redis pipeline to atomically remove expired entries and count remaining ones:

```rust
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
```

While each individual `check_window` call is atomic, the gap between checking and recording is not. If 10 concurrent requests all call `check_window` before any of them call `record_in_window`, all 10 see the same count and all 10 pass.

### How it could be exploited

1. Attacker sends N concurrent requests simultaneously (e.g., using HTTP/2 multiplexing or multiple TCP connections).
2. All N requests arrive at the rate limit middleware at approximately the same time.
3. All N requests execute `check_window` and see a count below the limit (e.g., count=25 with limit=30).
4. All N requests pass the check phase and proceed to `record_in_window`.
5. All N requests are recorded, pushing the actual count to 25+N, potentially far exceeding the limit of 30.

### Impact

The overshoot is bounded by the number of concurrent in-flight requests for the same owner. In practice, this is limited by:
- The server's thread pool size (Tokio runtime).
- TCP connection limits.
- The time it takes for each request to pass through auth middleware (which includes RPC calls).

A realistic overshoot might be 2-5x the limit during a coordinated burst. This is enough to cause some extra resource consumption but is unlikely to be a significant abuse vector on its own.

### Why the severity rating is correct

LOW is appropriate because:
- The overshoot is bounded by concurrency, not unbounded.
- Practical exploitation requires coordinated concurrent requests.
- The rate limiter is a defense-in-depth measure, not the primary security control.
- The impact (some extra requests processed) is minor compared to the effort required.

### Remediation

Use a Redis Lua script to atomically check-and-increment in a single round-trip.

```rust
async fn check_and_record_window(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    window_start: f64,
    now: f64,
    weight: i64,
    limit: i64,
    ttl_seconds: i64,
) -> Result<bool, redis::RedisError> {
    let script = redis::Script::new(r#"
        redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
        local count = redis.call('ZCARD', KEYS[1])
        if count >= tonumber(ARGV[4]) then
            return 0
        end
        for i = 0, tonumber(ARGV[3]) - 1 do
            local ts = tonumber(ARGV[2]) + i * 0.001
            redis.call('ZADD', KEYS[1], ts, tostring(ts))
        end
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
        return 1
    "#);

    let allowed: i64 = script
        .key(key)
        .arg(window_start)
        .arg(now)
        .arg(weight)
        .arg(limit)
        .arg(ttl_seconds)
        .invoke_async(redis)
        .await?;

    Ok(allowed == 1)
}
```

This ensures the check and record happen atomically within Redis, eliminating the race window.

---

## F-9: Rate Limiter Fails Open

**Severity:** HIGH | **Confidence:** 9/10 | **Status:** Confirms Existing Audit Vuln 4

### What it is

When Redis is unavailable or returns an error, all three rate limit checks log the error and allow the request through unconditionally. This is a deliberate design choice (the log messages say "allowing"), but it means that if Redis goes down -- whether through infrastructure failure, misconfiguration, or deliberate attack -- all rate limiting is completely disabled. The server operates with zero rate limiting until Redis recovers.

### Where in the code

**File:** `services/server/src/rate_limit.rs`

The pattern repeats identically for all three rate limit layers.

Lines 240-242 (delegate-key layer):
```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (dk): {}, allowing", e);
}
```

Lines 259-261 (account burst layer):
```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (burst): {}, allowing", e);
}
```

Lines 278-280 (account sustained layer):
```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (sustained): {}, allowing", e);
}
```

In all three cases, the `Err` arm does nothing -- it logs and falls through to the next check or to the final `record_in_window` calls. Since the `match` arms for `Ok` are the only ones that can return early with a 429 response, any `Err` path results in the request being allowed.

### How it could be exploited

**Scenario 1: Infrastructure failure**
1. Redis crashes, runs out of memory, or becomes unreachable due to a network partition.
2. All rate limit checks fail with connection errors.
3. All requests are allowed through without any rate limiting.
4. An attacker (or even normal traffic) can now send unlimited requests, consuming unbounded LLM API credits, storage, and compute.

**Scenario 2: Deliberate Redis DoS**
1. If the attacker can influence Redis availability (e.g., by exhausting Redis memory through other services sharing the same instance, or by causing network congestion to the Redis host), they can deliberately trigger the fail-open behavior.
2. Once rate limiting is disabled, the attacker floods expensive endpoints like `/api/analyze` (cost weight 10) to maximize damage.

**Scenario 3: Misconfiguration**
1. A deployment misconfigures `REDIS_URL` to point to a non-existent host.
2. The server starts successfully (Redis connection is created at startup, but the multiplexed connection may not immediately fail).
3. All rate limit checks fail silently, and the server runs indefinitely with no rate limiting.

### Impact

- Unlimited API access for all authenticated users (or attackers with valid credentials).
- Unbounded consumption of OpenAI API credits via `/api/analyze` and `/api/ask` endpoints.
- Unbounded Walrus storage consumption via `/api/remember` endpoints.
- Combined with F-1 (no replay protection), a single captured request can be replayed thousands of times per second with no throttling.

### Why the severity rating is correct

HIGH is appropriate because:
- Rate limiting is the primary defense against resource abuse for authenticated users.
- Failing open completely removes this defense, not just weakening it.
- The trigger condition (Redis failure) is realistic -- Redis is a single point of failure that can go down for many reasons.
- The impact is direct financial cost (LLM API credits, storage fees) and service degradation.
- It is not CRITICAL because: (a) authentication is still required, so only users with valid delegate keys can exploit this, and (b) the server's other resource limits (1MB body size, Walrus upload costs) provide some natural bounds.

### Remediation

Change the rate limiter to fail closed when Redis is unavailable.

**File:** `services/server/src/rate_limit.rs`

Replace all three `Err` arms with a fail-closed response:

```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (dk): {}, BLOCKING request", e);
    return rate_limit_response("system", 0, "min", 30);
}
```

Or, for a more nuanced approach, implement a local in-memory fallback rate limiter that activates when Redis is down:

```rust
Err(e) => {
    tracing::error!("redis rate limit check failed (dk): {}, using fallback", e);
    // Use a simple in-memory token bucket as fallback
    if !state.fallback_limiter.check(&auth.public_key) {
        return rate_limit_response("delegate_key_fallback",
            config.max_requests_per_delegate_key, "min", 60);
    }
}
```

At minimum, add a configuration option to control fail-open vs. fail-closed behavior:

```rust
// In RateLimitConfig:
pub fail_open: bool,  // default: false

// In the Err handler:
Err(e) => {
    tracing::error!("redis rate limit check failed: {}", e);
    if !config.fail_open {
        return rate_limit_response("system", 0, "min", 30);
    }
}
```

---

## F-10: Debug Derive on AuthInfo Leaks Delegate Key

**Severity:** LOW | **Confidence:** 8/10 | **Status:** NEW

### What it is

The `AuthInfo` struct derives the `Debug` trait, which means any code that formats it using `{:?}` or `{:#?}` (including `tracing::debug!`, `dbg!()`, error messages, or panic output) will print the `delegate_key` field in full, exposing the Ed25519 private key in plaintext in logs, console output, or error reports.

### Where in the code

**File:** `services/server/src/types.rs`, lines 317-327

```rust
#[derive(Debug, Clone)]
pub struct AuthInfo {
    #[allow(dead_code)]
    pub public_key: String,
    /// Owner address from the onchain MemWalAccount (set after onchain verification)
    pub owner: String,
    /// MemWalAccount object ID (set after onchain verification)
    pub account_id: String,
    /// Delegate private key (hex) — used for SEAL decrypt SessionKey
    pub delegate_key: Option<String>,
}
```

The auto-derived `Debug` implementation will produce output like:

```
AuthInfo { public_key: "ab12cd...", owner: "0x1234...", account_id: "0x5678...", delegate_key: Some("FULL_PRIVATE_KEY_HEX_HERE") }
```

While no current code path in the codebase formats `AuthInfo` with `Debug`, the derive makes it trivially easy to introduce such a leak accidentally. For example, a developer debugging an auth issue might add:

```rust
tracing::debug!("auth info: {:?}", auth);
```

This single line would expose every user's private key to whatever log aggregation system is in use.

### How it could be exploited

1. A developer adds a debug log statement that formats `AuthInfo` (a common and natural debugging pattern).
2. The log statement is deployed to production (possibly accidentally, or in a debug build).
3. Log entries containing full private keys are written to log files, sent to log aggregation services (e.g., Datadog, CloudWatch, Splunk), or displayed in monitoring dashboards.
4. Anyone with access to the logs (operations team, log aggregation service employees, attackers who compromise the logging infrastructure) obtains the private keys.

### Impact

- Potential mass exposure of delegate private keys through log systems.
- The impact is the same as F-3 (full delegate compromise) but through a different vector (logs vs. network).
- Log data is often retained for extended periods and may be accessible to a broader set of people than the server itself.

### Why the severity rating is correct

LOW is appropriate because:
- No current code path triggers this. The vulnerability is latent, not active.
- It requires a developer to introduce a new log statement that formats `AuthInfo`.
- However, the risk is real because `Debug` formatting is an extremely common Rust pattern, and the derive makes the dangerous formatting invisible.

It is not MEDIUM because it requires an additional code change to become exploitable.

### Remediation

Replace the derived `Debug` with a manual implementation that redacts the delegate key.

**File:** `services/server/src/types.rs`

Change:
```rust
#[derive(Debug, Clone)]
pub struct AuthInfo {
```

To:
```rust
#[derive(Clone)]
pub struct AuthInfo {
```

And add a manual `Debug` implementation:

```rust
impl std::fmt::Debug for AuthInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthInfo")
            .field("public_key", &self.public_key)
            .field("owner", &self.owner)
            .field("account_id", &self.account_id)
            .field("delegate_key", &self.delegate_key.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}
```

This ensures that even if a developer formats `AuthInfo` with `{:?}`, the output will be:

```
AuthInfo { public_key: "ab12cd...", owner: "0x1234...", account_id: "0x5678...", delegate_key: Some("[REDACTED]") }
```

For stronger protection, wrap the delegate key in a `secrecy::SecretString` type that zeros memory on drop and panics on `Debug` formatting.

---

## F-11: Integer Overflow in Timestamp Abs

**Severity:** Informational | **Confidence:** 6/10 | **Status:** NEW

### What it is

The timestamp validation code computes `(now - timestamp).abs()` where both values are `i64`. If an attacker supplies `timestamp = i64::MIN` (-9223372036854775808), the subtraction `now - timestamp` overflows the `i64` range. In Rust, this behavior differs between build modes: in debug mode, integer overflow panics (crashing the server for that request); in release mode, it wraps silently to a negative value whose `.abs()` also overflows.

### Where in the code

**File:** `services/server/src/auth.rs`, lines 67-74

```rust
let timestamp: i64 = timestamp_str
    .parse()
    .map_err(|_| StatusCode::UNAUTHORIZED)?;
let now = chrono::Utc::now().timestamp();
if (now - timestamp).abs() > 300 {
    tracing::warn!("Request timestamp too old: {} (now: {})", timestamp, now);
    return Err(StatusCode::UNAUTHORIZED);
}
```

The arithmetic:
- `now` is approximately 1,775,000,000 (current Unix timestamp in 2026).
- If `timestamp = i64::MIN = -9223372036854775808`
- Then `now - timestamp = 1775000000 - (-9223372036854775808) = 1775000000 + 9223372036854775808`
- This equals `9223372038629775808`, which exceeds `i64::MAX` (9223372036854775807) by `1,775,000,001`.

In debug mode: `now - timestamp` panics with "attempt to subtract with overflow".
In release mode: the subtraction wraps to approximately `-7223372035079775808` (a negative number). Calling `.abs()` on this value is still within `i64` range (it would produce a positive value), and the result would be greater than 300, so the check would correctly reject the request. However, if the wrapped value happened to be `i64::MIN`, `.abs()` would overflow again.

### How it could be exploited

1. Attacker sends a request with `x-timestamp: -9223372036854775808` (the string representation of `i64::MIN`).
2. The `parse::<i64>()` succeeds -- this is a valid i64 value.
3. In **debug mode**: the server panics on the subtraction, crashing the request handler. This is a per-request crash (the Tokio runtime catches the panic and continues serving other requests), but if triggered repeatedly, it generates noisy error logs and wastes server resources.
4. In **release mode**: the subtraction wraps, and the check most likely rejects the request with 401 (the wrapped value is almost certainly far from zero). The request is safely rejected, but through undefined arithmetic rather than intentional logic.

### Impact

- **Debug builds only:** Per-request panic (DoS of individual requests, not the server).
- **Release builds:** No practical impact. The request is rejected, just via wrapping arithmetic rather than correct arithmetic.
- This is purely a code quality issue. No authentication bypass is possible.

### Why the severity rating is correct

Informational is appropriate because:
- In release mode (production), there is no observable impact -- the request is rejected.
- In debug mode, the impact is a per-request panic, not a server crash.
- The trigger requires a deliberately malformed timestamp that has no legitimate use.
- The code works correctly for all realistic timestamp values.

### Remediation

Use saturating or checked arithmetic to avoid the overflow entirely.

**File:** `services/server/src/auth.rs`, line 71

Option 1 -- saturating arithmetic:
```rust
if now.saturating_sub(timestamp).unsigned_abs() > 300 {
```

Note: `saturating_sub` clamps at `i64::MIN`/`i64::MAX` instead of wrapping, and `unsigned_abs()` returns `u64`, which cannot overflow on `.abs()`.

Option 2 -- checked arithmetic with fallback:
```rust
let diff = now.checked_sub(timestamp)
    .map(|d| d.unsigned_abs())
    .unwrap_or(u64::MAX);
if diff > 300 {
```

Option 3 -- use `i128` for the computation:
```rust
if ((now as i128) - (timestamp as i128)).unsigned_abs() > 300 {
```

All three options produce correct results for all possible `i64` inputs and eliminate both the debug panic and the release wrapping behavior.
