---
date: 2026-04-29
tags: [review, security, memwal, critical]
---
# MemWal Code Review — Everything Review

Verdict: BLOCK — 3 CRITICAL, 6 HIGH, 5 MEDIUM, 4 LOW

## CRITICAL
1. Private key sent in HTTP header (x-delegate-key) on every API call — packages/sdk/src/memwal.ts:342
2. Internal error details leak to clients — services/server/src/types.rs:386-396
3. verifyKeyServers: false disables SEAL chain-of-trust — services/server/scripts/sidecar-server.ts:67

## HIGH
1. Rate limit check/record non-atomic (TOCTOU race)
2. remember_batch missing from rate limiter weights (weight 1 vs should be 50+)
3. No upper-bound on user-supplied limit param — resource exhaustion
4. reqwest::Client has no timeout — external calls hang forever
5. Sidecar: 50MB body, permissive CORS, no auth — bypassable
6. Sui private key as plain String, sent in HTTP body to sidecar

## Lessons
- Delegate key model is broken if the private key leaves the client
- Silent fallbacks (mock embeddings, default contract addresses) are dangerous in prod
- Sidecar trust boundary needs explicit auth, not just localhost assumption
