# MemWal Rust Server Security Code Review: Routes & Data Layer

**Date:** 2026-04-02
**Scope:** Route handlers (`routes.rs`), database layer (`db.rs`), SEAL integration (`seal.rs`), Walrus integration (`walrus.rs`), type definitions (`types.rs`)
**Commit:** 5bb1669
**Reviewer:** Code-level review of Rust server

---

## 1. Route Handler Analysis

### 1.1 POST /api/remember (routes.rs:123-178)

**Authorization:** Requires auth middleware (Ed25519 signature + on-chain delegate key verification). Owner derived from `auth.owner` -- cannot be forged.

**Input Validation:**
- Line 128: Checks `body.text.is_empty()` -- good.
- No maximum length validation on `body.text`. The only bound is the 1MB body limit enforced by `axum::body::to_bytes(body, 1024 * 1024)` in auth.rs:98.
- `body.namespace` defaults to `"default"` (types.rs:149) but has no length or character validation.

**Data Flow:** text -> embed + encrypt concurrently -> upload to Walrus -> store vector+blob_id in DB. All steps use server-side credentials. Owner is auth-derived. Sound design.

**Finding R-1: No text length cap beyond body limit**
- **Severity:** LOW | **Confidence:** 7/10
- **Lines:** routes.rs:128-129
- **Detail:** A 1MB text triggers a full OpenAI embedding call on ~250K tokens of text, which will likely fail or be extremely expensive. The embedding model (`text-embedding-3-small`) has an 8191 token limit. Exceeding it will cause an API error, but only after the concurrent SEAL encryption has already been initiated and potentially completed, wasting compute.
- **Remediation:** Add a text length cap (e.g., 32KB) before the concurrent operations begin.

### 1.2 POST /api/recall (routes.rs:188-278)

**Authorization:** Auth middleware required. Owner scoped.

**Input Validation:**
- Line 193: Empty query check -- good.
- `body.limit` defaults to 10 (types.rs:163) but has **no upper bound**. Any `usize` value is accepted.

**Data Flow:** query -> embed -> vector search (owner+namespace scoped) -> download+decrypt all results concurrently -> return plaintext.

**Finding R-2: Unbounded concurrent blob downloads in recall**
- **Severity:** MEDIUM | **Confidence:** 8/10
- **Lines:** routes.rs:213, routes.rs:217-266
- **Detail:** `body.limit` is passed directly to `search_similar` as a SQL `LIMIT` clause (via db.rs:95). A request with `limit: 10000` would return up to 10,000 blob_ids, then the handler spawns 10,000 concurrent download+decrypt tasks (line 217-266, using `futures::future::join_all`). Each task involves a Walrus HTTP download (10s timeout) and a sidecar SEAL decrypt call. This can overwhelm the server, Walrus aggregator, and sidecar.
- **Note:** This is distinct from the existing audit's Vuln 12 which focused on restore. Recall has the same unbounded pattern.
- **Remediation:** Cap `body.limit` at a maximum (e.g., 100) at the handler level before passing to DB.

**Finding R-3: Silent failure masks data loss in recall**
- **Severity:** LOW | **Confidence:** 7/10
- **Lines:** routes.rs:228-265
- **Detail:** When a blob download or decrypt fails, the result is silently `None` (filtered out). The response `total` field (line 274) counts only successes. The client has no way to know that some results were silently dropped due to errors, expired blobs, or SEAL failures.
- **Remediation:** Return a `skipped` or `errors` count alongside `total`.

### 1.3 POST /api/remember/manual (routes.rs:289-349)

**Authorization:** Auth middleware required.

**Input Validation:**
- Lines 294-299: Checks for empty `encrypted_data` and empty `vector`.
- No validation of vector dimensions (existing audit Vuln 15 -- confirmed, pgvector enforces at DB layer).
- No maximum size on `encrypted_data` base64 string beyond the 1MB body limit.

### 1.4 POST /api/recall/manual (routes.rs:357-383)

**Authorization:** Auth middleware required.

This is the safest endpoint -- returns only blob_ids and distances, no decryption. Data is properly owner+namespace scoped.

### 1.5 POST /api/analyze (routes.rs:391-480)

**Authorization:** Auth middleware required.

**Finding R-5: LLM prompt injection via user text**
- **Severity:** MEDIUM | **Confidence:** 8/10
- **Lines:** routes.rs:553-563
- **Detail:** User-supplied `body.text` is injected directly into the LLM `user` message (line 559-562) alongside the system prompt `FACT_EXTRACTION_PROMPT` (line 516-534). An attacker can craft text that overrides the system prompt instructions, causing the LLM to:
  1. Return an arbitrarily large number of "facts" -- each fact triggers a full remember cycle (embed + encrypt + Walrus upload), amplifying the cost by N.
  2. Return fabricated facts that poison the user's own memory store.
- **Remediation:** Cap the number of extracted facts (e.g., max 20). Add a `max_facts` parameter or hardcode a ceiling.

**Finding R-6: No cap on number of extracted facts**
- **Severity:** MEDIUM | **Confidence:** 9/10
- **Lines:** routes.rs:593-597
- **Detail:** The LLM response is parsed as one-fact-per-line with no maximum. A manipulated or misbehaving LLM response returning 1000 lines would trigger 1000 concurrent (embed + encrypt + upload + DB insert) operations. Each fact gets its own round-robin key from the pool (line 429), and all facts are processed via `join_all` (line 464) with no concurrency limit.
- **Remediation:** Add `facts.truncate(MAX_FACTS)` after parsing (e.g., 20). Also consider using `buffer_unordered(N)` instead of `join_all` for bounded concurrency.

### 1.6 POST /api/ask (routes.rs:617-749)

**Authorization:** Auth middleware required.

**Finding R-7: Decrypted memories injected into LLM prompt without sanitization**
- **Severity:** LOW | **Confidence:** 6/10
- **Lines:** routes.rs:695-708
- **Detail:** Recalled memory text is injected into the LLM system prompt (lines 698-702). If previously stored memories contain prompt injection payloads, they could manipulate the LLM's response. This is an indirect prompt injection pattern. However, since memories are owner-scoped, the attacker would need to have stored malicious memories in their own account.
- **Remediation:** Consider prefixing each memory with a delimiter and instructing the LLM to treat them as data, not instructions.

### 1.7 POST /api/restore (routes.rs:787-1004)

**Authorization:** Auth middleware required.

- `body.limit` defaults to 50 but is unbounded (existing audit Vuln 12 -- confirmed).
- **Positive:** Uses `buffer_unordered(3)` for SEAL decryption (line 946), which is good bounded concurrency. However, blob downloads (line 869-886) use `join_all` without bounding.

**Finding R-9: Restore downloads are unbounded concurrency**
- **Severity:** MEDIUM | **Confidence:** 8/10
- **Lines:** routes.rs:869-886, 888-892
- **Detail:** While the limit on `missing_blob_ids` applies, with a large limit value (e.g., 999999), all missing blobs are downloaded concurrently via `join_all`. The SEAL decryption step is properly bounded at 3 concurrent (line 946), but the download step has no concurrency bound.
- **Remediation:** Use `buffer_unordered(10)` for downloads as well.

### 1.8 POST /sponsor and POST /sponsor/execute (routes.rs:1011-1060)

**Authorization:** NONE -- public endpoints. Confirmed as per existing audit Vuln 2.

**Finding R-10: Raw body passthrough to sidecar without validation**
- **Severity:** HIGH | **Confidence:** 9/10
- **Lines:** routes.rs:1013, 1019, 1039, 1046
- **Detail:** The sponsor proxy accepts raw `Bytes` and forwards them directly to the sidecar with no validation. The `Content-Type: application/json` header is hardcoded but the body content is not parsed or validated. This means:
  1. Any arbitrary JSON (or even non-JSON) is forwarded to the sidecar's Enoki sponsor endpoint.
  2. There is no body size limit on these endpoints since they don't go through the auth middleware (which enforces 1MB).
  3. Combined with missing authentication, this is a high-severity issue.

**Finding R-11: No body size limit on sponsor endpoints**
- **Severity:** MEDIUM | **Confidence:** 8/10
- **Lines:** routes.rs:1013, 1039
- **Detail:** The `body: axum::body::Bytes` extractor on public routes does not pass through the auth middleware where the 1MB limit is enforced. Axum's default extractor limit for `Bytes` is 2MB, but this is still exploitable for memory pressure attacks against an unauthenticated endpoint.
- **Remediation:** Add an explicit `axum::extract::DefaultBodyLimit::max(16_384)` layer to the public routes.

---

## 2. SQL Injection Analysis

All queries in `db.rs` use **parameterized queries** via sqlx's `$1, $2, ...` bind parameters.

| Method | Lines | Parameters | Status |
|--------|-------|-----------|--------|
| `insert_vector` | 56-68 | 6 binds ($1-$6) | **SAFE** |
| `search_similar` | 85-98 | 4 binds ($1-$4) | **SAFE** |
| `get_blobs_by_namespace` | 114-124 | 2 binds ($1-$2) | **SAFE** |
| `delete_by_namespace` | 134-146 | 2 binds ($1-$2) | **SAFE** |
| `delete_by_blob_id` | 151-162 | 1 bind ($1) | **SAFE** |
| `get_cached_account` | 174-181 | 1 bind ($1) | **SAFE** |
| `cache_delegate_key` | 192-207 | 3 binds ($1-$3) | **SAFE** |
| `get_storage_used` | 215-224 | 1 bind ($1) | **SAFE** |
| `find_account_by_owner` | 237-246 | 1 bind ($1) | **SAFE** |

**Migrations** (lines 21-37) use `sqlx::raw_sql` with `include_str!` -- static SQL files compiled into the binary. Not user-controllable. **SAFE**.

**No SQL injection vulnerabilities found. Confirmed positive finding from existing audit.**

---

## 3. SSRF Risk Analysis

All outbound HTTP calls use URLs derived from server-side configuration (environment variables), not user input:

| Call | URL Source | User-Controlled? |
|------|-----------|-----------------|
| Embedding API | `config.openai_api_base` (env var) | No |
| SEAL encrypt/decrypt | `config.sidecar_url` (env var) | No |
| Walrus upload/query | `config.sidecar_url` (env var) | No |
| Walrus download | `config.walrus_aggregator_url` (env var) | No |
| LLM chat completion | `config.openai_api_base` (env var) | No |
| Sponsor proxy | `config.sidecar_url` (env var) | No |
| Auth - Sui RPC | `config.sui_rpc_url` (env var) | No |

**No SSRF vulnerabilities. Confirmed positive finding from existing audit.**

---

## 4. Error Handling Analysis

**Finding R-12: Internal error messages leak infrastructure details (confirms existing Vuln 10)**
- **Severity:** MEDIUM | **Confidence:** 9/10
- **Lines:** types.rs:362-377

The `IntoResponse` implementation for `AppError` returns the full internal error message to clients:

```rust
AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
```

Specific leakage points:

| Location | What Leaks |
|----------|-----------|
| db.rs:18 | Database connection string details |
| seal.rs:60-61 | Sidecar URL and connectivity status |
| seal.rs:68 | Raw sidecar error response bodies |
| walrus.rs:98 | Raw sidecar error response bodies |
| routes.rs:77 | Embedding API status code and response body |
| routes.rs:574 | LLM API status code and response body |
| routes.rs:735 | LLM API error with status code |
| routes.rs:1022 | Sponsor proxy error details |

**Remediation:** For `AppError::Internal`, log the detailed message server-side and return a generic "Internal server error" to the client. Consider adding a request ID for correlation.

---

## 5. Resource Exhaustion Analysis

**Finding R-13: Analyze endpoint is a cost amplifier with no fact count limit**
- **Severity:** HIGH | **Confidence:** 9/10
- **Lines:** routes.rs:391-480, 593-597, 423-462
- **Detail:** A single `/api/analyze` request triggers:
  1. One LLM call for fact extraction
  2. For each extracted fact (unbounded N): one embedding API call + one SEAL encryption + one Walrus upload + one DB insert
  3. All N facts are processed concurrently via `join_all` (line 464)
  
  With prompt injection (Finding R-5), an attacker can cause the LLM to output hundreds of facts. The rate limit weight for analyze is 10, meaning 6 analyze requests per minute (60/10). But each request could generate 100+ facts, meaning 600+ Walrus uploads per minute from a single user.
  
  **The rate limit weight is a constant 10 regardless of how many facts are extracted.** This makes the rate limit ineffective for bounding actual resource consumption.

**Finding R-14: No timeout on LLM API calls**
- **Severity:** LOW | **Confidence:** 7/10
- **Lines:** routes.rs:547-568, 716-730
- **Detail:** The `reqwest::Client` used for LLM calls has no configured timeout (main.rs:61 creates a default client). A slow or hanging LLM response could block the handler indefinitely. The Walrus download has a 10s timeout (walrus.rs:178-179), but LLM calls do not.
- **Remediation:** Configure a timeout on `reqwest::Client::builder().timeout(Duration::from_secs(30))`.

---

## 6. Data Isolation Analysis

All database queries that access user data are scoped by `owner` and `namespace`:

| Method | Scoping | Status |
|--------|---------|--------|
| `insert_vector` | owner + namespace | **Isolated** |
| `search_similar` | `WHERE owner = $2 AND namespace = $3` | **Isolated** |
| `get_blobs_by_namespace` | `WHERE owner = $1 AND namespace = $2` | **Isolated** |
| `delete_by_namespace` | `WHERE owner = $1 AND namespace = $2` | **Isolated** |
| `get_storage_used` | `WHERE owner = $1` | **Isolated** |

**One exception:** `delete_by_blob_id` (db.rs:151) uses only `blob_id` without owner scoping.

**Finding R-16: delete_by_blob_id is not owner-scoped**
- **Severity:** LOW | **Confidence:** 6/10
- **Lines:** db.rs:150-162, routes.rs:758-773
- **Detail:** The `delete_by_blob_id` function deletes any vector entry matching the blob_id regardless of owner. Since blob_ids are Walrus content-addressed hashes, the probability of collision is negligible. However, if two users somehow stored the same encrypted blob (which SEAL makes nearly impossible since encryption is non-deterministic), one user's expired blob cleanup could delete the other's DB entry.
- **Remediation:** Pass `owner` to `cleanup_expired_blob` and add `AND owner = $2` to the delete query.

**Overall data isolation: Strong. Confirmed positive finding from existing audit.**

---

## 7. Sponsor Endpoints Analysis

The `/sponsor` and `/sponsor/execute` endpoints (routes.rs:1011-1060) are:

1. **Unauthenticated** -- in `public_routes` (main.rs:147-150)
2. **Unrate-limited** -- rate limit middleware only applies to `protected_routes` (main.rs:137-140)
3. **Unvalidated** -- raw body passthrough
4. **CORS-permissive** -- any website can call them cross-origin

This fully confirms the existing audit's Vuln 2.

---

## 8. The /api/analyze Endpoint -- Detailed Analysis

### 8.1 LLM Prompt Injection

The system prompt (routes.rs:516-534) instructs the LLM to extract facts. User input is placed in the `user` role message. An adversarial input could cause the LLM to output many fabricated facts. Each fact triggers a full remember cycle. The `temperature: 0.1` provides some stability but does not prevent prompt injection.

### 8.2 Cost Amplification

One analyze request (rate-limit cost: 10) can generate:
- 1 LLM chat completion call
- N embedding API calls (one per fact)
- N SEAL encryption calls
- N Walrus uploads (with gas)
- N DB inserts

Where N is the number of facts extracted (unbounded).

### 8.3 Storage Quota Check Bypass

**Finding R-17: Storage quota check uses plaintext size but stores encrypted size**
- **Severity:** LOW | **Confidence:** 8/10
- **Lines:** routes.rs:139-140 (remember), routes.rs:417-418 (analyze)
- **Detail:** In `remember`, `text_bytes = text.as_bytes().len()` is checked against quota, but `blob_size = encrypted.len()` is stored in DB (line 163). SEAL encryption adds overhead (~200-500 bytes typically). The `remember_manual` endpoint correctly uses `encrypted_bytes.len()` for both (line 314, 337).
- **Remediation:** Check quota using an estimated encrypted size, or move the quota check after encryption.

---

## 9. Findings Summary

| ID | Severity | Confidence | Lines | Description |
|----|----------|-----------|-------|-------------|
| R-1 | LOW | 7/10 | routes.rs:128-129 | No text length cap; wasted compute on OpenAI token limit overflow |
| R-2 | MEDIUM | 8/10 | routes.rs:213, 217-266 | Unbounded concurrent blob downloads in recall |
| R-3 | LOW | 7/10 | routes.rs:228-265 | Silent failure masks data loss in recall results |
| R-5 | MEDIUM | 8/10 | routes.rs:553-563, 516-534 | LLM prompt injection in analyze endpoint |
| R-6 | MEDIUM | 9/10 | routes.rs:593-597, 464 | No cap on extracted facts; unbounded concurrent operations |
| R-7 | LOW | 6/10 | routes.rs:695-708 | Indirect prompt injection via stored memories |
| R-9 | MEDIUM | 8/10 | routes.rs:869-892 | Restore blob downloads have unbounded concurrency |
| R-10 | HIGH | 9/10 | routes.rs:1011-1060 | Unauthenticated sponsor proxy with no validation |
| R-11 | MEDIUM | 8/10 | routes.rs:1013, 1039 | No body size limit on public endpoints |
| R-12 | MEDIUM | 9/10 | types.rs:362-377 | Internal errors leak infrastructure details |
| R-13 | HIGH | 9/10 | routes.rs:391-480 | Analyze endpoint cost amplification (rate limit weight constant despite variable cost) |
| R-14 | LOW | 7/10 | routes.rs:547-568 | No timeout on LLM API calls |
| R-16 | LOW | 6/10 | db.rs:150-162 | delete_by_blob_id not owner-scoped |
| R-17 | LOW | 8/10 | routes.rs:139-140, 417 | Storage quota uses plaintext size, stores encrypted size |

---

## 10. Comparison with Existing Audit Findings

| Vuln | Original | This Review | Change |
|------|----------|-------------|--------|
| Vuln 2 (Unauthenticated sponsors) | HIGH | HIGH | Confirmed. Added body-size issue (R-11) |
| Vuln 10 (Verbose errors) | MEDIUM | MEDIUM | Confirmed with additional leakage points |
| Vuln 12 (Unbounded limit on restore) | MEDIUM | MEDIUM | Confirmed. Extended to recall and ask endpoints |
| Vuln 17 (Plaintext in logs) | LOW | LOW | Confirmed |

---

## 11. Remediation Priority

| Priority | Finding | Description | Effort |
|----------|---------|-------------|--------|
| **P0** | R-10/R-11 | Authenticate + validate + size-limit sponsor endpoints | Low |
| **P0** | R-13/R-6 | Cap extracted facts at 20; use bounded concurrency for analyze | Low |
| **P1** | R-2 | Cap `limit` at 100 for recall, ask; use `buffer_unordered` | Low |
| **P1** | R-9 | Use `buffer_unordered(10)` for restore downloads | Low |
| **P1** | R-12 | Return generic error messages for Internal errors | Low |
| **P2** | R-5 | Add LLM output validation (fact count, format) | Low |
| **P2** | R-14 | Add timeouts to LLM and embedding HTTP calls | Low |
| **P2** | R-1 | Add text length cap (32KB) | Low |
| **P3** | R-17 | Fix storage quota to use estimated encrypted size | Low |
| **P3** | R-16 | Add owner scoping to delete_by_blob_id | Low |
| **P3** | R-7 | Add memory delimiter in ask system prompt | Low |
| **P3** | R-3 | Return skipped/error count in recall responses | Low |

---

## 12. Positive Security Observations

1. **SQL injection protection is comprehensive.** Every query in db.rs uses parameterized binds. No dynamic SQL construction.
2. **Data isolation is strong.** All data access paths are owner+namespace scoped with the owner derived from on-chain cryptographic verification.
3. **Auth middleware is well-designed.** Ed25519 signature verification + on-chain delegate key verification is a robust authentication model.
4. **Storage quota tracking exists** and is checked before expensive operations.
5. **Expired blob cleanup is reactive and resilient** -- errors in cleanup don't propagate to the user's request.
6. **SEAL decryption in restore uses bounded concurrency** (`buffer_unordered(3)`).
7. **The `walrus::download_blob` function has a 10-second timeout** (walrus.rs:178-179).
