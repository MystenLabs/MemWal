# Security Code Review: MemWal Rust Server Authentication Module

**Date:** 2026-04-02
**Reviewer:** Independent security review
**Scope:** `services/server/src/auth.rs`, `services/server/src/types.rs`, `services/server/src/main.rs`, and supporting files (`sui.rs`, `rate_limit.rs`, `routes.rs`, `db.rs`)
**Commit:** 5bb1669

---

## 1. Authentication Flow Analysis

### 1.1 Signature Construction and Verification

The signed message format is: `"{timestamp}.{method}.{path}.{body_sha256}"`

**Step-by-step walkthrough:**

1. **Header extraction** (auth.rs:36-58) -- Three required headers (`x-public-key`, `x-signature`, `x-timestamp`) and two optional (`x-account-id`, `x-delegate-key`). All are extracted via `to_str().ok()` which silently rejects non-ASCII header values. This is correct behavior -- hex and numeric strings are always ASCII.

2. **Timestamp validation** (auth.rs:67-74) -- Parsed as `i64`, compared to server time with a +/-300 second window using `.abs()`. The use of `.abs()` on `i64` is technically susceptible to overflow if `timestamp` is `i64::MIN`, which would cause `.abs()` to panic in debug or wrap in release. However, this would require a maliciously crafted timestamp value that would be meaningless as a Unix timestamp.

3. **Key/signature decoding** (auth.rs:77-89) -- Hex-decoded, then validated for correct byte lengths (32 for public key, 64 for signature). `VerifyingKey::from_bytes` performs curve point validation, rejecting weak/invalid keys. This is correctly implemented.

4. **Message reconstruction** (auth.rs:92-103) -- `request.method().as_str()` returns the uppercase method string. `request.uri().path()` returns only the path component without query string. Body is consumed with a 1MB limit (auth.rs:98), SHA-256 hashed, and hex-encoded.

5. **Ed25519 verification** (auth.rs:106-111) -- Uses `ed25519_dalek::verify()` which is constant-time. Correctly implemented.

6. **Request reconstruction** (auth.rs:134) -- Body bytes are re-injected into the request after consumption. This preserves the body for downstream handlers.

### 1.2 Timing Checks

- **Window:** +/-300 seconds (5 minutes). This is generous but reasonable for clock skew. The bidirectional check prevents both replayed old requests and pre-signed future requests.
- **Clock source:** `chrono::Utc::now().timestamp()` -- uses system clock. No NTP validation. If the server clock drifts, the window shifts accordingly.

### 1.3 Replay Protection

**There is none.** No nonce, no request ID, no seen-signature tracking. Any captured signed request can be replayed unlimited times within the 5-minute window. This is confirmed and remains an issue (see Finding F-1).

---

## 2. Account Resolution Strategy

### Strategy 1: PostgreSQL Cache (auth.rs:152-173)

- Queries `delegate_key_cache` table by hex public key.
- On cache hit, **always** re-verifies on-chain via `verify_delegate_key_onchain`. This is a strong security property -- cached mappings are never trusted blindly.
- On stale cache (key removed on-chain), falls through to Strategy 2. The stale cache entry is **not** deleted -- it remains for the next request to re-check. This is a minor inefficiency, not a vulnerability.

### Strategy 2: On-Chain Registry Scan (auth.rs:176-192)

- Fetches the `AccountRegistry` object, enumerates all accounts via `suix_getDynamicFields`, and checks each account's delegate keys.
- This is O(N) in the number of registered accounts -- a scalability concern at high user counts but not a security issue.
- On success, caches the mapping. The `let _ =` on line 186 silently ignores cache write failures. This means a cache write failure causes repeated expensive registry scans but does not compromise security.

### Strategy 3: Header Hint / Config Fallback (auth.rs:195-211)

- Uses `x-account-id` header value or `MEMWAL_ACCOUNT_ID` env var.
- **Critically, still calls `verify_delegate_key_onchain`** (auth.rs:199-206). This means an attacker cannot forge account association by supplying a random `x-account-id` -- the delegate key must actually be registered in that account on-chain.
- On RPC failure, `verify_delegate_key_onchain` returns `Err`, which propagates as 401. The system fails closed.

### Trust Assumptions

- **Sui RPC is trusted** to return accurate on-chain state. A compromised RPC node could lie about delegate key registration, allowing unauthorized access.
- **PostgreSQL cache is advisory** -- always re-verified. This is correct.
- **Registry scan is authoritative** -- but depends on the `MEMWAL_REGISTRY_ID` being correct.

---

## 3. Middleware Chain Analysis

### Ordering (main.rs:126-144)

```rust
let protected_routes = Router::new()
    .route("/api/remember", post(routes::remember))
    // ... more routes ...
    .layer(middleware::from_fn_with_state(state.clone(), rate_limit::rate_limit_middleware))
    .layer(middleware::from_fn_with_state(state.clone(), auth::verify_signature));
```

Axum's `.layer()` wraps from bottom-to-top, meaning the **last** `.layer()` call runs **first**. So:
1. `auth::verify_signature` runs first (outermost)
2. `rate_limit::rate_limit_middleware` runs second (inner)
3. Route handler runs last

This ordering is **correct** -- auth runs before rate limiting, so `AuthInfo` is available in request extensions when the rate limiter reads it.

### Protected vs Public Routes

**Protected** (require auth): `/api/remember`, `/api/recall`, `/api/remember/manual`, `/api/recall/manual`, `/api/analyze`, `/api/ask`, `/api/restore`

**Public** (no auth, no rate limiting): `/health`, `/sponsor`, `/sponsor/execute`

The sponsor endpoints being public and unrate-limited is a known issue (existing audit Vuln 2). Confirmed.

### Global Middleware

- `CorsLayer::permissive()` (main.rs:156) -- applies to ALL routes, both protected and public. Allows any origin with any headers.
- `TraceLayer` (main.rs:157) -- request tracing, no security impact.

---

## 4. Credential Handling

### 4.1 Delegate Private Key in HTTP Headers

**File:** auth.rs:61-64, types.rs:326

The `x-delegate-key` header carries the raw hex-encoded Ed25519 private key. This is stored in `AuthInfo.delegate_key` and passed through to route handlers. In `routes.rs:203-207`, it is used as the SEAL decryption key, or the server falls back to `SERVER_SUI_PRIVATE_KEY`.

The private key travels: SDK -> HTTP header -> auth middleware -> request extensions -> route handler -> sidecar HTTP request body. Every hop is a potential leak point.

### 4.2 Server SUI Private Keys

**File:** types.rs:112-124

`SERVER_SUI_PRIVATE_KEY` and `SERVER_SUI_PRIVATE_KEYS` are loaded from environment variables and stored in `Config` (in-memory, cloneable). The key pool (`KeyPool`) holds them as `Vec<String>`. These keys are sent to the sidecar in HTTP request bodies for Walrus uploads. They are never logged (good), but they traverse the sidecar HTTP boundary.

### 4.3 OpenAI API Key

Loaded from `OPENAI_API_KEY` env var, stored as `Option<String>` in `Config`. Used in `routes.rs:64` as a Bearer token. Never logged.

---

## 5. Edge Cases and Bypass Scenarios

### 5.1 Empty Body Handling

If a POST request has an empty body, `body_bytes` is empty, `body_hash` is the SHA-256 of empty bytes (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). This is deterministic and correct -- the signature still covers the empty body hash.

### 5.2 Path Normalization

`request.uri().path()` returns the raw path. No normalization is performed. If a reverse proxy normalizes paths differently (e.g., collapsing `//` to `/`, resolving `..`), the signed path may not match. This is unlikely to cause a bypass in practice since Axum routes are exact-match, but could cause legitimate requests to fail.

### 5.3 Method Case Sensitivity

`request.method().as_str()` returns uppercase (e.g., "POST"). The SDK also uses uppercase. No case-sensitivity issue.

### 5.4 Large Body DoS via Auth Middleware

The body is fully buffered in memory (auth.rs:98, 1MB limit). This is per-request and happens before any auth check completes, so an unauthenticated attacker can cause 1MB of memory allocation per concurrent request by sending garbage with valid-looking headers. The 1MB limit bounds this, and the timestamp check (which occurs before body consumption) provides no meaningful protection since an attacker can supply a valid-looking timestamp.

### 5.5 Account Deactivation Not Checked in Auth Middleware

**This is a new finding not in the existing audit.**

The Move smart contract has an `active` field on `MemWalAccount` (account.move:67). The `seal_approve` function checks `active` (account.move:379). However, `verify_delegate_key_onchain` in `sui.rs` **does not check the `active` field**. It only checks whether the delegate key exists in `delegate_keys`.

This means a deactivated account can still authenticate to the API server. The owner called `deactivate_account()` expecting to freeze all access, but:
- API endpoints that don't involve SEAL (like `remember_manual`, `recall_manual`) continue to work normally.
- Endpoints involving SEAL decrypt will fail at the SEAL key server level (since `seal_approve` checks `active`), but the request still consumes rate limit budget, embedding API calls, and Walrus storage.

---

## 6. Specific Code-Level Findings

### F-1: No Replay Protection (Confirms Existing Audit Vuln 8)

- **Severity:** MEDIUM
- **Confidence:** 10/10
- **Affected Lines:** auth.rs:66-74 (timestamp only, no nonce)
- **Description:** The existing audit correctly identifies this. There is zero replay protection beyond the 5-minute timestamp window. The rate limiter provides some mitigation (replayed requests count against limits) unless Redis is down.
- **Remediation:** Add a nonce to the signed message. Track seen nonces in Redis with 5-minute TTL. Alternatively, include a monotonic counter that the server tracks per-key.

### F-2: Query String Not Signed (Confirms Existing Audit Vuln 9)

- **Severity:** LOW (downgraded from MEDIUM)
- **Confidence:** 10/10
- **Affected Lines:** auth.rs:93 (`request.uri().path()`)
- **Description:** The path excludes query parameters. Downgraded from MEDIUM to LOW because: (a) all current routes are POST with JSON bodies, (b) no current route reads query parameters, (c) even if GET routes are added, the method is part of the signed message so a POST signature cannot be reused for GET. The risk is purely forward-looking.
- **Remediation:** Use `request.uri().path_and_query().map(|pq| pq.as_str()).unwrap_or(request.uri().path())`.

### F-3: Delegate Private Key in HTTP Headers (Confirms Existing Audit Vuln 1)

- **Severity:** HIGH
- **Confidence:** 10/10
- **Affected Lines:** auth.rs:61-64, types.rs:326, SDK memwal.ts:314
- **Description:** Fully confirmed. The private key is sent in every request from the `MemWal` class (not `MemWalManual`). The key is stored in `AuthInfo` which is `Clone` (types.rs:317), meaning it can be cheaply copied and potentially logged or serialized.
- **Additional Observation:** The `AuthInfo` struct derives `Debug` (types.rs:317), meaning `{:?}` formatting will print the delegate key in full. Any `tracing::debug!` or `dbg!()` that formats an `AuthInfo` value leaks the key to logs. No current code path does this, but the `Debug` derive makes it easy to introduce accidentally.
- **Remediation:** Remove `x-delegate-key` from the `MemWal` SDK. If `AuthInfo` must hold sensitive data, use a wrapper type that redacts the key in `Debug` output.

### F-4: Account `active` Status Not Checked in Auth Middleware (NEW)

- **Severity:** MEDIUM
- **Confidence:** 9/10
- **Affected Lines:** sui.rs:59-98 (entire `verify_delegate_key_onchain` function -- no `active` check)
- **Description:** The `verify_delegate_key_onchain` function fetches the `MemWalAccount` object and checks delegate keys, but never reads or validates the `active` field. A deactivated account (`active: false`) passes server authentication. The Move contract checks `active` in `seal_approve` (line 379), providing a second check for SEAL operations, but non-SEAL operations (`remember_manual`, `recall_manual`) are completely unprotected.
- **Exploit Scenario:** Account owner deactivates their account to freeze a compromised delegate key. The attacker can still use the key to call `remember_manual` (write garbage data consuming storage quota) and `recall_manual` (read vector metadata and blob IDs). The `remember` endpoint partially works too -- embedding and Walrus upload succeed, but the attacker-uploaded blobs won't be decryptable (SEAL blocks it).
- **Remediation:** Add `active` field check in `verify_delegate_key_onchain`:
  ```rust
  let active = fields.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
  if !active {
      return Err(OnchainVerifyError::AccountDeactivated(...));
  }
  ```

### F-5: Config Fallback Account Resolution (Updates Existing Audit Vuln 13)

- **Severity:** LOW
- **Confidence:** 8/10
- **Affected Lines:** auth.rs:195-211
- **Description:** Confirms the existing audit's revised assessment. Strategy 3 always performs on-chain verification (auth.rs:199-206). The `x-account-id` header is a performance hint that reduces the search space from "scan all accounts" to "check this specific account." It cannot bypass authentication because `verify_delegate_key_onchain` will reject a key not registered in the specified account.
- **Remaining Concern:** The `x-account-id` header allows an attacker to probe whether a specific delegate key is registered in a specific account, revealing account membership information. This is minor information leakage -- the response is 401 either way, but timing differences between "key not found" and "account doesn't exist" could leak information.
- **Remediation:** Document `MEMWAL_ACCOUNT_ID` for single-tenant use only. Consider constant-time error responses.

### F-6: TOCTOU in Cache (Updates Existing Audit Vuln 16)

- **Severity:** LOW
- **Confidence:** 5/10
- **Affected Lines:** auth.rs:152-173
- **Description:** Confirms the existing audit's analysis. The cache hit path re-verifies on-chain every time, which is the strongest possible design. The TOCTOU window is between on-chain verification completing and the request handler finishing -- typically milliseconds. Additionally, SEAL provides a second authorization check for decrypt operations. The risk is minimal.

### F-7: Stale Cache Entries Not Evicted (NEW -- Informational)

- **Severity:** Informational
- **Confidence:** 8/10
- **Affected Lines:** auth.rs:168-172 (stale cache detection), db.rs:192-196 (UPSERT on conflict)
- **Description:** When Strategy 1 detects a stale cache entry (key was removed from account on-chain), it logs the staleness and falls through to Strategy 2, but never deletes the stale cache entry. On the next request, Strategy 1 will again hit the cache, find it stale, re-verify on-chain (which fails), and fall through again. This repeats indefinitely, causing an unnecessary RPC call on every request for a revoked key.
- **Impact:** Performance, not security. A revoked key that passes Strategy 1 but fails on-chain verification will still be rejected.
- **Remediation:** Delete the stale cache entry when on-chain verification fails.

### F-8: Rate Limiter Check-Then-Record Race Condition (NEW)

- **Severity:** LOW
- **Confidence:** 7/10
- **Affected Lines:** rate_limit.rs:229-286
- **Description:** The rate limiter performs a check (read) on all three windows, then records (write) entries in all three windows. These are separate Redis operations, not atomic. Under high concurrency, multiple requests from the same key can all pass the check phase before any of them record, allowing a burst that exceeds the configured limit.
- **Practical Impact:** Low. The overshoot is bounded by the number of concurrent in-flight requests for the same owner, which is constrained by TCP connection limits and server thread pool size.
- **Remediation:** Use a Redis Lua script to atomically check-and-increment.

### F-9: Rate Limiter Fails Open (Confirms Existing Audit Vuln 4)

- **Severity:** HIGH
- **Confidence:** 9/10
- **Affected Lines:** rate_limit.rs:240-242, 259-261, 278-280
- **Description:** Fully confirmed. All three rate limit checks log the error and allow the request through. The `allowing` in the log message confirms this is an intentional design choice, not a bug. However, it is a security-negative design choice.

### F-10: Debug Derive on AuthInfo Leaks Delegate Key (NEW)

- **Severity:** LOW
- **Confidence:** 8/10
- **Affected Lines:** types.rs:317 (`#[derive(Debug, Clone)]`)
- **Description:** `AuthInfo` derives `Debug`, which means `format!("{:?}", auth_info)` will print the `delegate_key: Some("hex_private_key_here")` field in full. While no current code path does this, it creates a latent risk.
- **Remediation:** Implement a manual `Debug` for `AuthInfo` that redacts the `delegate_key` field.

### F-11: Integer Overflow in Timestamp Abs (NEW -- Informational)

- **Severity:** Informational
- **Confidence:** 6/10
- **Affected Lines:** auth.rs:71 (`(now - timestamp).abs()`)
- **Description:** If `timestamp` is `i64::MIN` and `now` is positive, `now - timestamp` overflows `i64` in release mode (wrapping), producing a negative result whose `.abs()` would also overflow. In practice, parsing `i64::MIN` from a string header value is possible, and `now` is ~1.7 billion, so `now - i64::MIN` would overflow.
- **Practical Impact:** In release mode, the overflow wraps to a value that would fail the `> 300` check, resulting in a 401. In debug mode, the server panics. Theoretical DoS vector in debug builds only.
- **Remediation:** Use `now.checked_sub(timestamp).map(|d| d.abs()).unwrap_or(i64::MAX) > 300` or use `i64::saturating_sub`.

---

## 7. Comparison with Existing Audit Findings

| Vuln | Original Severity | This Review | Change |
|------|-------------------|-------------|--------|
| Vuln 1 (Private key in headers) | HIGH | HIGH | Confirmed. Added Debug derive risk (F-10) |
| Vuln 8 (5-min replay window) | MEDIUM | MEDIUM | Confirmed |
| Vuln 9 (Query string not signed) | MEDIUM | LOW | Downgraded -- no current routes use query params |
| Vuln 13 (Config fallback) | LOW | LOW | Confirmed. Added timing side-channel observation |
| Vuln 16 (TOCTOU cache) | LOW | LOW | Confirmed. Added stale cache eviction note (F-7) |

---

## 8. Summary of All Findings

| ID | Finding | Severity | Confidence | New/Existing | Lines |
|----|---------|----------|------------|--------------|-------|
| F-1 | No replay protection | MEDIUM | 10/10 | Existing (Vuln 8) | auth.rs:66-74 |
| F-2 | Query string not signed | LOW | 10/10 | Existing (Vuln 9), downgraded | auth.rs:93 |
| F-3 | Delegate private key in headers | HIGH | 10/10 | Existing (Vuln 1) | auth.rs:61-64, types.rs:326 |
| F-4 | Account `active` not checked in auth | MEDIUM | 9/10 | **NEW** | sui.rs (entire verify function) |
| F-5 | Config fallback account resolution | LOW | 8/10 | Existing (Vuln 13) | auth.rs:195-211 |
| F-6 | TOCTOU in cache | LOW | 5/10 | Existing (Vuln 16) | auth.rs:152-173 |
| F-7 | Stale cache entries not evicted | Info | 8/10 | **NEW** | auth.rs:168-172 |
| F-8 | Rate limiter check-then-record race | LOW | 7/10 | **NEW** | rate_limit.rs:229-286 |
| F-9 | Rate limiter fails open | HIGH | 9/10 | Existing (Vuln 4) | rate_limit.rs:240-280 |
| F-10 | Debug derive leaks delegate key | LOW | 8/10 | **NEW** | types.rs:317 |
| F-11 | Integer overflow in timestamp abs | Info | 6/10 | **NEW** | auth.rs:71 |

---

## 9. Remediation Priority

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| P0 | F-3: Remove private key from headers | High (arch change) | Eliminates systemic credential exposure |
| P0 | F-9: Rate limiter fail-closed | Low | Prevents abuse when Redis is down |
| P1 | F-4: Check `active` field in auth | Low (few lines in sui.rs) | Honors account deactivation intent |
| P1 | F-1: Add replay protection | Medium | Prevents request replay attacks |
| P2 | F-10: Redact delegate key in Debug | Low | Prevents accidental key logging |
| P2 | F-2: Sign query string | Low | Defense-in-depth |
| P3 | F-8: Atomic rate limit check | Medium | Fixes minor race condition |
| P3 | F-7: Evict stale cache | Low | Performance improvement |
| P3 | F-11: Safe timestamp arithmetic | Low | Prevent theoretical debug panic |
