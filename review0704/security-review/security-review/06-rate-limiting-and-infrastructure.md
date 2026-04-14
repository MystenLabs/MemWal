# Security Code Review: Rate Limiting, Infrastructure & Deployment

**Date:** 2026-04-02
**Scope:** `services/server/src/rate_limit.rs`, `services/server/docker-compose.yml`, `services/server/Dockerfile`
**Commit:** 5bb1669
**Reviewer:** Security code review

---

## 1. Rate Limiting Logic

### 1.1 FINDING: Check-Then-Act Race Condition (TOCTOU) in Rate Limit Enforcement

- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Affected Lines:** `rate_limit.rs:229-286`
- **Description:** The middleware checks all three windows (lines 229-281) before recording entries (lines 284-286). Between the check and the record, concurrent requests from the same key/owner can all pass the check simultaneously. For a weight-10 `/api/analyze` endpoint, if 6 concurrent requests arrive, they could all see count=0, all pass the limit of 60, and collectively record 60 weighted entries -- consuming the full minute budget in one burst.
- **Remediation:** Use an atomic Lua script that checks AND increments in a single Redis operation.

### 1.2 FINDING: Non-Atomic Record Pipeline

- **Severity:** LOW
- **Confidence:** 9/10
- **Affected Lines:** `rate_limit.rs:150-161`
- **Description:** `record_in_window` builds a pipeline of `ZADD` commands followed by `EXPIRE`, but the pipeline is not wrapped in `.atomic()` (unlike `check_window` at line 131). If the connection fails mid-pipeline, `EXPIRE` could fail while `ZADD`s succeed, creating a key with no TTL that accumulates indefinitely and permanently rate-limits the user.
- **Remediation:** Wrap the pipeline in `.atomic()`.

### 1.3 FINDING: Endpoint Weight Uses Exact Path Match Only

- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Affected Lines:** `rate_limit.rs:93-101`
- **Description:** `endpoint_weight` performs exact string matches against `request.uri().path()`. A trailing slash or URL encoding difference (e.g., `/api/analyze/` vs `/api/analyze`) causes expensive endpoints to fall through to the default weight of 1. Axum does not normalize trailing slashes by default.
- **Remediation:** Use `starts_with` or strip trailing slashes. Best: attach weight as a route-level extension.

### 1.4 FINDING: Negative or Zero Weight Allows Free Requests

- **Severity:** LOW
- **Confidence:** 6/10
- **Affected Lines:** `rate_limit.rs:93-101, 151`
- **Description:** The weight is `i64`. The `record_in_window` loop `for i in 0..weight` executes zero times for weight=0 and is empty for negative values. Not currently exploitable (all paths return positive values) but a defensive coding concern.
- **Remediation:** Assert `weight >= 1` or use `u64`/`u32`.

---

## 2. Redis Dependency and Fail-Open Behavior

### 2.1 FINDING: All Three Rate Limit Layers Fail Open (Confirms Vuln #4)

- **Severity:** HIGH
- **Confidence:** 10/10
- **Affected Lines:** `rate_limit.rs:240-242, 259-261, 279-281`
- **Description:** Fully confirmed. Each of the three `check_window` error paths logs a warning and allows the request through unconditionally. No circuit breaker, no fallback in-memory limiter, no metric/alert.
- **Additional Context:** `record_in_window` (line 158) also silently continues on failure. If Redis has intermittent connectivity, some requests may be checked successfully but their recording fails -- the window appears to have capacity but costs are never tracked.
- **Chain Risk:** Combined with docker-compose exposing Redis without auth (Vuln #14), an attacker on the local network can `FLUSHALL` or `SHUTDOWN NOSAVE` Redis to disable all rate limiting.
- **Remediation:** Fail closed by default. Return 503 when Redis is unreachable. Implement in-memory fallback token bucket.

### 2.2 FINDING: No Redis Connection Resilience

- **Severity:** MEDIUM
- **Confidence:** 7/10
- **Affected Lines:** `rate_limit.rs:109-118`
- **Description:** `create_redis_client` establishes a `MultiplexedConnection` once at startup. No explicit configuration for reconnection backoff, max retries, or connection timeout.
- **Remediation:** Configure explicit connection timeouts. Consider connection pool with health checks.

---

## 3. Storage Quota Enforcement

### 3.1 FINDING: Storage Quota Check-Then-Write Race Condition

- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Affected Lines:** `rate_limit.rs:299-328`, `routes.rs:139-140, 314, 417-418`
- **Description:** `check_storage_quota` reads current usage from PostgreSQL, then the caller proceeds to upload and store. Between check and INSERT, concurrent requests can all pass. For `/api/analyze`, multiple facts are processed concurrently, meaning N parallel uploads all checked against the same baseline.
- **Remediation:** Use PostgreSQL advisory lock per owner, or Redis-based reservation system.

### 3.2 FINDING: Quota Checked Against Text Size, Actual Storage is Encrypted

- **Severity:** LOW
- **Confidence:** 7/10
- **Affected Lines:** `routes.rs:139` vs `db.rs:216`
- **Description:** In `remember`, quota is checked against `text.as_bytes().len()`, but SEAL encryption adds overhead. The `remember_manual` endpoint correctly uses encrypted bytes length.
- **Remediation:** Multiply text size by estimated encryption overhead factor for pre-check.

### 3.3 FINDING: Storage Quota Disabled by Zero Config

- **Severity:** LOW
- **Confidence:** 9/10
- **Affected Lines:** `rate_limit.rs:307-309`
- **Description:** `RATE_LIMIT_STORAGE_BYTES=0` disables quota entirely. Acceptable but worth documenting.

---

## 4. Docker Compose Configuration

### 4.1 FINDING: PostgreSQL Exposed with Hardcoded Credentials (Confirms Vuln #14)

- **Severity:** LOW (dev-only) / HIGH (if used in production)
- **Confidence:** 9/10
- **Affected Lines:** `docker-compose.yml:9-11, 16-17`
- **Description:** Confirmed. PostgreSQL on `0.0.0.0:5432` with `POSTGRES_PASSWORD: memwal_secret` hardcoded.
- **Remediation:** Use `127.0.0.1:5432:5432`. Use Docker secrets or `.env` not committed to git.

### 4.2 FINDING: Redis Exposed Without Authentication (Confirms Vuln #14)

- **Severity:** LOW (dev-only) / HIGH (if used in production)
- **Confidence:** 9/10
- **Affected Lines:** `docker-compose.yml:27-28`
- **Description:** Confirmed. Redis on `0.0.0.0:6379` with zero authentication. Chains with fail-open rate limiting (Vuln #4).
- **Remediation:** Add `command: redis-server --requirepass <password>`. Bind to `127.0.0.1`.

### 4.3 FINDING: No Resource Limits on Containers

- **Severity:** LOW
- **Confidence:** 8/10
- **Description:** Neither container has `mem_limit`, `cpus`, or `deploy.resources` constraints. Runaway queries can consume all host resources.
- **Remediation:** Add resource limits. Configure Redis `maxmemory`.

### 4.4 FINDING: No Network Isolation Between Services

- **Severity:** LOW
- **Confidence:** 7/10
- **Description:** Both services on default Docker bridge network. No custom network isolation.
- **Remediation:** Define separate networks for production.

---

## 5. Dockerfile Security

### 5.1 FINDING: Container Runs as Root (Confirms Vuln #11)

- **Severity:** MEDIUM
- **Confidence:** 10/10
- **Affected Lines:** `Dockerfile` (entire file -- no `USER` directive)
- **Description:** Confirmed. Both the Rust server and the Node.js sidecar child process run as `root`.
- **Remediation:**
  ```dockerfile
  RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
  RUN chown -R appuser:appgroup /app
  USER appuser
  ```

### 5.2 FINDING: Remote Script Execution via curl | bash (Supply Chain Risk)

- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Affected Lines:** `Dockerfile:31`
- **Description:** `curl -fsSL https://deb.nodesource.com/setup_22.x | bash -` fetches and executes a remote script during build. Not pinned to a hash.
- **Remediation:** Use official Node.js Docker image as base, or download script separately and verify checksum.

### 5.3 FINDING: No Image Pinning by Digest

- **Severity:** LOW
- **Confidence:** 8/10
- **Affected Lines:** `Dockerfile:7, 24`
- **Description:** Both base images use mutable tags (`rust:1.85-bookworm`, `debian:bookworm-slim`).
- **Remediation:** Pin by digest: `rust:1.85-bookworm@sha256:<hash>`.

### 5.4 FINDING: EXPOSE Only Documents Port 8000

- **Severity:** INFORMATIONAL
- **Confidence:** 9/10
- **Affected Lines:** `Dockerfile:53`
- **Description:** Only `EXPOSE ${PORT}` (8000). Sidecar port 9000 not exposed. This is actually positive -- reduces accidental mapping.

---

## 6. Container Networking Analysis

| Component | Runs Where | Listens On | Accessible From |
|-----------|-----------|------------|-----------------|
| Rust server | Container or host | `0.0.0.0:8000` | Internet (via LB) |
| Sidecar | Same container (child) | `0.0.0.0:9000` (default) | Container-internal, potentially exposed |
| PostgreSQL | Docker container | `0.0.0.0:5432` (host-mapped) | Any host-reachable client |
| Redis | Docker container | `0.0.0.0:6379` (host-mapped) | Any host-reachable client |

---

## 7. Environment Variable and Secrets Handling

### 7.1 FINDING: Database Credentials in Committed docker-compose.yml

- **Severity:** LOW (dev) / MEDIUM (if copied for prod)
- **Confidence:** 9/10
- **Lines:** `docker-compose.yml:9-11`
- **Description:** `POSTGRES_PASSWORD: memwal_secret` in committed file.
- **Remediation:** Use `env_file` or Docker secrets.

### 7.2 Positive: No Secrets in Dockerfile

- **Confidence:** 10/10
- **Description:** The Dockerfile contains no hardcoded secrets. All sensitive configuration via runtime env vars. Correct.

---

## 8. Comparison with Existing Audit Findings

### Vuln #4 (Rate Limiter Fails Open) -- CONFIRMED AND EXPANDED

Additional dimensions:
1. **Record failures also fail open** (line 158): Budget is never consumed on recording failures.
2. **TOCTOU race** (new): Even with Redis operational, check-then-record allows concurrent bypass.

**Assessment:** HIGH severity confirmed.

### Vuln #11 (Docker Container Runs as Root) -- CONFIRMED

No `USER` directive. Supply chain risk of `curl | bash` elevated as separate finding.

**Assessment:** MEDIUM confirmed.

### Vuln #14 (Docker Compose Exposes Ports) -- CONFIRMED, CHAIN RISK UNDER-STATED

The chain with Vuln #4 is significant: exposed Redis -> crash Redis -> disable all rate limiting. Minimum fix: bind to localhost (`"127.0.0.1:5432:5432"`).

---

## 9. New Findings Not in Existing Audit

| ID | Finding | Severity | Lines |
|----|---------|----------|-------|
| NEW-1 | TOCTOU race in rate limit check-then-record | MEDIUM | rate_limit.rs:229-286 |
| NEW-2 | Non-atomic record pipeline may leave keys without TTL | LOW | rate_limit.rs:150-161 |
| NEW-3 | Endpoint weight exact match bypassable via path variation | MEDIUM | rate_limit.rs:93-101 |
| NEW-4 | Storage quota TOCTOU between check and write | MEDIUM | rate_limit.rs:299-328 |
| NEW-5 | Quota pre-check uses plaintext size, actual is larger | LOW | routes.rs:139 |
| NEW-6 | No resource limits on Docker containers | LOW | docker-compose.yml |
| NEW-7 | Base images not pinned by digest | LOW | Dockerfile:7,24 |

---

## 10. Remediation Priority

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| **P0** | Fail-open rate limiting (Vuln #4 + record failures) | Medium (Lua script + fallback) | Prevents complete rate limit bypass |
| **P1** | TOCTOU race in rate limit (NEW-1) | Medium (atomic Lua check-and-increment) | Prevents concurrent bypass |
| **P1** | Endpoint weight path bypass (NEW-3) | Low (normalize path or use route extensions) | Prevents weight downgrade |
| **P1** | Run container as non-root (Vuln #11) | Low (3 lines in Dockerfile) | Limits container escape |
| **P2** | Storage quota TOCTOU (NEW-4) | Medium (advisory locks or reservation) | Prevents quota overrun |
| **P2** | Supply chain: curl pipe to bash (Dockerfile:31) | Low (use official Node image) | Eliminates build-time risk |
| **P2** | Non-atomic record pipeline (NEW-2) | Low (add `.atomic()`) | Prevents stuck keys |
| **P3** | Docker compose bind to localhost (Vuln #14) | Low (one-line change) | Eliminates network exposure |
| **P3** | Pin images by digest (NEW-7) | Low | Supply chain hardening |
| **P3** | Container resource limits (NEW-6) | Low | DoS resilience |
| **P3** | Quota size mismatch (NEW-5) | Low | Accuracy improvement |
