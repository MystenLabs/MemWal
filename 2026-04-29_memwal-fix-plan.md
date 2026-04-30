---
date: 2026-04-29
tags: [plan, memwal, security, fix]
---
# Fix Plan for MemWal Review Findings

## Muc tieu
Fix 3 CRITICAL + 6 HIGH issues from code review. Ship-blocking before production.

## Phase 1: CRITICAL — Security Blockers (do first)
- [ ] 1.1 Remove x-delegate-key header from SDK auth flow
  - File: packages/sdk/src/memwal.ts:337-343
  - Fix: Stop sending private key. Auth already works via signature (timestamp.method.path.body_sha256). For SEAL decrypt, move decryption client-side or use a narrow-scope session token.
  - Also update: services/server/src/auth.rs to stop expecting the header

- [ ] 1.2 Sanitize error responses in production
  - File: services/server/src/types.rs:386-396
  - Fix: AppError::Internal → log full msg server-side with tracing::error!, return generic "Internal server error" to client

- [ ] 1.3 Enable SEAL key server verification
  - File: services/server/scripts/sidecar-server.ts:67
  - Fix: Set verifyKeyServers: true. Add startup health check that fails hard if verification fails.

## Phase 2: HIGH — Security & Reliability
- [ ] 2.1 Atomic rate limiting with Redis Lua script
  - File: services/server/src/rate_limit.rs:229-288
  - Fix: Replace check-then-record with single EVAL Lua script per window

- [ ] 2.2 Add remember_batch to rate limiter weights
  - File: services/server/src/rate_limit.rs:93-102
  - Fix: Add "/api/remember/batch" => items.len().min(100) * 5 (or fixed weight 50)

- [ ] 2.3 Cap user-supplied limit param
  - Files: services/server/src/routes.rs (recall, ask, restore handlers)
  - Fix: limit = limit.min(100) at top of each handler

- [ ] 2.4 Add timeouts to reqwest::Client
  - File: services/server/src/main.rs:61
  - Fix: .timeout(30s).connect_timeout(10s)

- [ ] 2.5 Secure the sidecar
  - File: services/server/scripts/sidecar-server.ts
  - Fix: Bind to 127.0.0.1, add shared secret header, reduce body limit to 5MB

- [ ] 2.6 Stop sending Sui private key in HTTP body
  - File: services/server/src/walrus.rs:84-85
  - Fix: Sidecar should load its own key from env, not receive it per-request

## Phase 3: MEDIUM — Hardening
- [ ] 3.1 Configure explicit CORS origins (main.rs:160)
- [ ] 3.2 Add pagination limit to registry scan (auth.rs/sui.rs)
- [ ] 3.3 Use full hash for cache keys (db.rs:172)
- [ ] 3.4 Fail hard if OPENAI_API_KEY missing (routes.rs:94)
- [ ] 3.5 Add input validation to sidecar endpoints

## Token estimate: ~3,000-5,000 (subagent coding per phase)
