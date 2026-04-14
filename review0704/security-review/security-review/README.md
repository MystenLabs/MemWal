# MemWal Security Review -- Consolidated Report

**Date:** 2026-04-02
**Commit:** 5bb1669 (branch `dev`)
**Scope:** Full codebase -- server, sidecar, smart contract, SDK, infrastructure
**Baseline:** `security-review-claude-apr-5bb1669.md` (initial audit)
**Method:** Independent code-level review of all critical services, validating and extending the initial audit

---

## Review Documents

| # | File | Scope | Findings |
|---|------|-------|----------|
| 1 | [01-server-authentication.md](01-server-authentication.md) | Auth middleware, account resolution, credential handling | 2 HIGH, 2 MEDIUM, 3 LOW, 2 INFO |
| 2 | [02-server-routes-and-data.md](02-server-routes-and-data.md) | Route handlers, SQL injection, SSRF, error handling | 2 HIGH, 5 MEDIUM, 5 LOW |
| 3 | [03-sidecar-server.md](03-sidecar-server.md) | SEAL crypto, Walrus uploads, CORS, network exposure | 6 HIGH, 6 MEDIUM, 9 LOW, 1 INFO |
| 4 | [04-smart-contract.md](04-smart-contract.md) | Move contract access control, delegate keys, seal_approve | 2 MEDIUM, 3 LOW, 3 INFO |
| 5 | [05-sdk-client.md](05-sdk-client.md) | Private key handling, request signing, client-side crypto | 1 CRITICAL, 2 HIGH, 5 MEDIUM, 7 LOW |
| 6 | [06-rate-limiting-and-infrastructure.md](06-rate-limiting-and-infrastructure.md) | Rate limiting, Docker, deployment security | 1 HIGH, 4 MEDIUM, 7 LOW, 1 INFO |

---

## Consolidated Finding Counts

| Severity | Count | Key Examples |
|----------|-------|-------------|
| **CRITICAL** | 1 | Private key in HTTP headers (SDK sends on every request) |
| **HIGH** | 13 | Rate limiter fails open, unauthenticated sidecar/sponsors, SEAL verification disabled, server wallet key exposure |
| **MEDIUM** | 22 | Replay attacks, cost amplification, TOCTOU races, unbounded concurrency, information disclosure |
| **LOW** | 34 | Input validation gaps, label length, cache staleness, log leakage |
| **INFO** | 7 | Missing tests, event gaps, permanent registry |
| **Total** | **77** | |

---

## Top 10 Critical Findings (P0/P1)

### P0 -- Must Fix Before Production

| # | Finding | Source | Severity | Effort |
|---|---------|--------|----------|--------|
| 1 | **Remove delegate private key from HTTP headers** -- SDK sends raw Ed25519 private key in `x-delegate-key` on every request. `MemWalManual` proves this is unnecessary. | 01-auth F-3, 05-sdk 1.1 | CRITICAL | High (arch redesign) |
| 2 | **Authenticate sponsor endpoints** -- `/sponsor` and `/sponsor/execute` are public, unrate-limited, unvalidated proxies to Enoki. Any caller can drain gas budget. | 02-routes R-10 | HIGH | Low |
| 3 | **Secure sidecar** -- Bind to 127.0.0.1, add shared secret auth. Currently 0.0.0.0 with zero auth, wildcard CORS. | 03-sidecar S1, S19 | HIGH | Low |
| 4 | **Rate limiter must fail closed** -- All three rate limit layers silently allow requests when Redis is down. | 06-infra 2.1, 01-auth F-9 | HIGH | Medium |
| 5 | **Enable SEAL key server verification** -- `verifyKeyServers: false` in all 4 SEAL client instances. One-line fix each. | 03-sidecar S3, 05-sdk 4.2 | HIGH | Trivial |
| 6 | **Stop sending server wallet keys per-request** -- Server SUI private keys sent to sidecar in HTTP body on every Walrus upload. Load from env at boot instead. | 03-sidecar S8 | HIGH | Medium |

### P1 -- Fix Soon

| # | Finding | Source | Severity | Effort |
|---|---------|--------|----------|--------|
| 7 | **Check account `active` status in auth** -- Deactivated accounts still authenticate for non-SEAL endpoints. | 01-auth F-4 | MEDIUM | Low |
| 8 | **Cap analyze facts and add bounded concurrency** -- Unbounded LLM fact extraction triggers unbounded concurrent Walrus uploads. | 02-routes R-6, R-13 | HIGH | Low |
| 9 | **Add replay protection (nonce)** -- 5-minute replay window with no nonce tracking. | 01-auth F-1 | MEDIUM | Medium |
| 10 | **Cap `limit` parameter on all endpoints** -- recall, ask, restore accept unbounded limits triggering mass concurrent operations. | 02-routes R-2, R-9 | MEDIUM | Low |

---

## Comparison with Initial Audit

### Findings Confirmed (All 17 Original Vulns Validated)

| Original Vuln | Severity | Status |
|---------------|----------|--------|
| #1 Private key in headers | HIGH | **Confirmed, elevated to CRITICAL** (sent on ALL requests, provably unnecessary) |
| #2 Unauthenticated sponsors | HIGH | **Confirmed, extended** (added body-size issue) |
| #3 Unauthenticated sidecar | HIGH | **Confirmed, expanded** (new endpoints, wallet key exposure) |
| #4 Rate limiter fails open | HIGH | **Confirmed, expanded** (record failures also fail open, TOCTOU race) |
| #5 SEAL verification disabled | HIGH | **Confirmed** (also in SDK client, not just sidecar) |
| #6 Permissive CORS | MEDIUM | **Confirmed** |
| #7 Unvalidated sui_address | MEDIUM | **Confirmed, extended** (address uniqueness not enforced) |
| #8 5-minute replay window | MEDIUM | **Confirmed** |
| #9 Query string not signed | MEDIUM | **Downgraded to LOW** (no current routes use query params) |
| #10 Verbose error messages | MEDIUM | **Confirmed** (additional leakage points identified) |
| #11 Docker runs as root | MEDIUM | **Confirmed** (added supply chain risk) |
| #12 Unbounded limit on restore | MEDIUM | **Confirmed, extended** to recall and ask endpoints |
| #13 Config fallback | LOW | **Confirmed** |
| #14 Docker compose ports | LOW | **Confirmed** (chain risk with Vuln #4 under-stated) |
| #15 No vector dimension validation | LOW | **Confirmed** |
| #16 TOCTOU cache | LOW | **Confirmed** |
| #17 Plaintext in logs | LOW | **Confirmed** |

### New Findings Not in Initial Audit

| Finding | Severity | Source |
|---------|----------|--------|
| Account `active` status not checked in server auth | MEDIUM | 01-auth F-4 |
| Delegate path in seal_approve skips key ID validation | MEDIUM | 04-contract MEDIUM-2 |
| Analyze endpoint cost amplification (unbounded facts) | HIGH | 02-routes R-13 |
| Rate limit TOCTOU race (check-then-record) | MEDIUM | 06-infra 1.1 |
| Storage quota TOCTOU race | MEDIUM | 06-infra 3.1 |
| Endpoint weight bypassed by path variation | MEDIUM | 06-infra 1.3 |
| Non-atomic rate limit record pipeline | LOW | 06-infra 1.2 |
| Debug derive on AuthInfo leaks delegate key | LOW | 01-auth F-10 |
| Stale cache entries not evicted | INFO | 01-auth F-7 |
| Deactivation prevents delegate key removal (race) | LOW | 04-contract LOW-2 |
| SEAL threshold hardcoded to 1 | MEDIUM | 03-sidecar S4 |
| 50MB JSON body limit on sidecar | MEDIUM | 03-sidecar S13 |
| No array size limit on decrypt-batch | MEDIUM | 03-sidecar S14 |
| Server wallet key sent per-request to sidecar | HIGH | 03-sidecar S8 |
| LLM prompt injection in analyze | MEDIUM | 02-routes R-5 |
| No timeout on LLM/embedding API calls | LOW | 02-routes R-14 |
| curl pipe to bash in Dockerfile | MEDIUM | 06-infra 5.2 |

---

## Positive Security Findings

| Area | Assessment |
|------|-----------|
| **SQL Injection** | All queries parameterized via sqlx. Zero dynamic SQL. **Strong.** |
| **SSRF** | All outbound URLs from server-side config, never user input. **Not exploitable.** |
| **Move Contract Assertions** | All 15 boolean authorization computations flow into `assert!`. Zero silent checks. **Strong.** |
| **Ed25519 Verification** | Constant-time via `ed25519_dalek::verify()`. **No timing side-channel.** |
| **Data Isolation** | All DB queries owner+namespace scoped. Owner derived from on-chain verification. **Strong.** |
| **Auth Middleware Ordering** | Auth runs before rate limiting. Correctly implemented. |
| **Account Resolution** | Cache always re-verified on-chain. Header hint verified on-chain. Fails closed on RPC error. **Strong.** |
| **Move Reentrancy** | Prevented by design (linear type system). **Not applicable.** |

---

## Remediation Roadmap

### Phase 1: Immediate (P0) -- Block Production Deployment
1. Bind sidecar to 127.0.0.1 + add shared secret
2. Move sponsor endpoints behind auth + rate limiting
3. Set `verifyKeyServers: true` (4 one-line changes)
4. Rate limiter: fail closed on Redis errors
5. Load server wallet keys from env in sidecar (not per-request)

### Phase 2: Short-term (P1) -- Within 2 Weeks
6. Cap analyze facts at 20; use bounded concurrency
7. Cap `limit` parameter at 100/500 on all endpoints
8. Check `account.active` in server auth
9. Restrict CORS to allowed origins
10. Add replay protection (nonce + Redis tracking)
11. Run container as non-root user

### Phase 3: Medium-term (P2) -- Within 1 Month
12. Architectural redesign: remove `x-delegate-key` header
13. Add `has_suffix` check to delegate path in seal_approve
14. Sanitize error messages (generic to client, detailed to logs)
15. Include query string in signature
16. Increase SEAL threshold to 2
17. Add input validation (text length, vector dimensions, namespace)

### Phase 4: Hardening (P3) -- Ongoing
18. Pin Docker images by digest
19. Evict stale delegate key cache entries
20. Add idempotency guards to deactivate/reactivate
21. Redact delegate key in AuthInfo Debug impl
22. Add missing contract test coverage
23. Pin crypto dependency versions
