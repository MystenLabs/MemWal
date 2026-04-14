# MemWal Security Audit — Remediation Plan

> Based on: [MemWal Security Audit Report (2026-04-03)](file:///Users/ducnmm/Documents/commandoss/MemWal/review0704/MemWal-security-audit-report_20260403_155217.md) — Commit `5bb1669`, branch `dev`
>
> **77 findings total**: 1 Critical · 13 High · 22 Medium · 34 Low · 7 Info

---

## Summary of Review Materials

| Document | Location |
|----------|----------|
| Main Audit Report | [MemWal-security-audit-report.md](file:///Users/ducnmm/Documents/commandoss/MemWal/review0704/MemWal-security-audit-report_20260403_155217.md) |
| Linear Issue Tracker CSV | [linear-security-issues.csv](file:///Users/ducnmm/Documents/commandoss/MemWal/review0704/linear-security-issues.csv) |
| Threat Models (STRIDE) | [threat-model/](file:///Users/ducnmm/Documents/commandoss/MemWal/review0704/threat-model/) — 7 component-level threat models |
| Detailed Security Reviews | [security-review/](file:///Users/ducnmm/Documents/commandoss/MemWal/review0704/security-review/security-review/) — 8 document reviews + detailed explanations |

---

## Compound Risk Chains (Must-Understand)

Before diving into individual fixes, these compound chains explain why sequential remediation matters:

| Chain | Findings | Impact |
|-------|----------|--------|
| **A: Full Account Takeover** | CRIT-1 → HIGH-8 → HIGH-4 | XSS + localStorage key + header transmission = read/write/corrupt all memories |
| **B: Resource Exhaustion** | HIGH-2 → HIGH-3 → MED-19 → LOW-27 | Redis outage → fail-open rate limiter → unbounded analyze = drain all budgets |
| **C: Crypto Compromise** | HIGH-1 → HIGH-5 → HIGH-7 → MED-10 | Sidecar exposure + SEAL bypass + threshold-1 = decrypt all user memories |

---

## Phase 1 — P0: Production Blockers 🔴

> **Goal**: Eliminate all attack chains that independently enable account takeover, key theft, or budget drain.
> **Estimated Effort**: 3–5 days
> **Dependency**: None — start immediately

### 1.1 CRIT-1: Remove Delegate Private Key from HTTP Headers

> [!CAUTION]
> This is the single most impactful vulnerability. The raw Ed25519 private key is transmitted in every SDK request via `x-delegate-key` header.

#### [MODIFY] [memwal.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/packages/sdk/src/memwal.ts)
- **Line ~314**: Remove `"x-delegate-key": bytesToHex(this.privateKey)` from `signedRequest()` headers
- Restructure the `MemWal` class to follow the `MemWalManual` pattern for SEAL decryption (client-side)
- The `MemWal` class should no longer have a "server-side SEAL decrypt" code path

#### [MODIFY] [auth.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/auth.rs)
- **Lines 61–64**: Remove extraction of `x-delegate-key` from request headers
- Update `AuthInfo` construction to no longer carry `delegate_key`

#### [MODIFY] [types.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/types.rs)
- **Line ~317**: Remove `#[derive(Debug)]` from `AuthInfo`; implement manual `Debug` that redacts sensitive fields
- **Line ~326**: Remove `delegate_key` field from `AuthInfo` struct (or mark it as `Option<_>` during transition)

#### [MODIFY] [seal.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/seal.rs)
- **Line ~109**: Remove code that forwards delegate key to sidecar decrypt requests

#### [MODIFY] [api.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/apps/app/src/utils/api.ts)
- Remove delegate key header from API request construction

---

### 1.2 HIGH-1: Lock Down Sidecar Network Access

#### [MODIFY] [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts)
- **Line ~811**: Change `app.listen(PORT)` → `app.listen(PORT, "127.0.0.1")`
- **Lines 277–285**: Remove wildcard CORS middleware entirely
- Add shared-secret middleware: validate `X-Sidecar-Secret` header against `SIDECAR_SECRET` env var on all non-health endpoints

#### [MODIFY] [walrus.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/walrus.rs)
- Add `X-Sidecar-Secret` header to all outbound HTTP requests to sidecar

#### [MODIFY] [seal.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/seal.rs)
- Add `X-Sidecar-Secret` header to all outbound HTTP requests to sidecar

---

### 1.3 HIGH-2: Make Rate Limiter Fail-Closed

#### [MODIFY] [rate_limit.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/rate_limit.rs)
- **Lines 240–242, 259–261, 278–281**: Replace `Ok(())` fallback on Redis error with `Err(429 Too Many Requests)`
- **Line ~158**: `record_in_window` should propagate errors, not swallow them
- Add fallback in-memory token-bucket for per-owner-minute window as secondary defense

---

### 1.4 HIGH-4: Authenticate Sponsor Endpoints

#### [MODIFY] [main.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/main.rs)
- **Lines ~147–150**: Move `/sponsor` and `/sponsor/execute` behind the Ed25519 auth middleware layer

#### [MODIFY] [routes.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/routes.rs)
- **Lines ~1011–1060**: Add body size limit `DefaultBodyLimit::max(16_384)` to sponsor endpoints
- Add rate limiting with low cost weight (e.g., weight=5)

#### [MODIFY] [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts)
- **Lines ~753–804**: Sponsor endpoints on sidecar are now protected by shared-secret from 1.2

---

### 1.5 HIGH-5: Enable SEAL Key Server Verification

#### [MODIFY] [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts)
- **Line ~67**: `verifyKeyServers: false` → `verifyKeyServers: true`

#### [MODIFY] [seal-encrypt.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/seal-encrypt.ts)
- **Line ~96**: `verifyKeyServers: true`

#### [MODIFY] [seal-decrypt.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/seal-decrypt.ts)
- **Line ~117**: `verifyKeyServers: true`

#### [MODIFY] [manual.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/packages/sdk/src/manual.ts)
- **Line ~200**: `verifyKeyServers: true`

---

### 1.6 HIGH-6: Stop Transmitting Server Wallet Keys Per-Request

#### [MODIFY] [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts)
- **Lines ~513–519**: Load `SERVER_SUI_PRIVATE_KEYS` from env at startup; accept only key **index** in request body
- Implement key lookup by index in the Walrus upload handler

#### [MODIFY] [walrus.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/walrus.rs)
- **Lines ~80–81**: Send key index instead of raw private key string to sidecar

---

### 1.7 HIGH-8: Remove Private Key from localStorage

#### [MODIFY] [App.tsx](file:///Users/ducnmm/Documents/commandoss/MemWal/apps/app/src/App.tsx)
- **Lines ~71–85**: Replace `localStorage` with `sessionStorage` (minimum); ideally use Web Crypto API `CryptoKey` objects
- Invoke `clearDelegateKeys()` on tab close via `beforeunload` event

#### [MODIFY] [chat.tsx](file:///Users/ducnmm/Documents/commandoss/MemWal/apps/chatbot/components/chat.tsx)
- **Lines ~93–114**: Same — migrate from `localStorage` to `sessionStorage`; remove key from POST body

---

### 1.8 HIGH-3: Cap Analyze Endpoint Resource Consumption

#### [MODIFY] [routes.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/routes.rs)
- **Lines ~391–480**: Add `facts.truncate(20)` after LLM response parsing
- **Lines ~593–597**: Replace `join_all` with `buffer_unordered(5)` for per-fact processing
- Adjust rate limit cost post-extraction based on actual fact count

---

## Phase 2 — P1: High-Priority Hardening 🟠

> **Goal**: Close remaining HIGH issues and the most exploitable MEDIUM issues.
> **Estimated Effort**: 3–4 days
> **Dependency**: Phase 1 must be complete (sidecar auth, key removal)

### 2.1 HIGH-7: Remove Delegate Key from Sidecar Decrypt Bodies
*(Largely addressed by CRIT-1 fix, but verify and clean up)*

#### [MODIFY] [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts)
- **Lines ~324, 404**: Remove delegate key acceptance from decrypt request body schema
- Reduce `SessionKey` TTL from 30 → 2–5 minutes

---

### 2.2 HIGH-9: Fix File Upload Path Traversal

#### [MODIFY] [route.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/apps/chatbot/app/(chat)/api/files/upload/route.ts)
- **Lines ~50–53**: Sanitize filename — strip path separators, restrict to `[a-zA-Z0-9._-]`
- Prefix upload key with `${session.user.id}/${crypto.randomUUID()}-${sanitizedFilename}`

---

### 2.3 HIGH-10: Add Authorization Checks on Destructive Actions

#### [MODIFY] [actions.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/apps/chatbot/app/(chat)/actions.ts)
- `deleteTrailingMessages`: Verify `session.user.id` owns the target message before deletion
- `updateChatVisibility`: Verify `session.user.id` owns the target chat before update

---

### 2.4 HIGH-11: Fix User Enumeration

#### [MODIFY] [actions.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/apps/chatbot/app/(auth)/actions.ts)
- Replace `{ status: "user_exists" }` with generic `{ status: "failed" }`
- Same error response for general failures and existing-user scenarios

---

### 2.5 HIGH-12: Fix Open Redirect

#### [MODIFY] [route.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/apps/chatbot/app/(auth)/api/auth/guest/route.ts)
- **Lines ~7, 18**: Validate `redirectUrl` — only allow relative paths or same-origin URLs
- Reject any URL with a different hostname

---

### 2.6 HIGH-13: Add Body Size Limits to Public Endpoints

#### [MODIFY] [routes.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/routes.rs)
- **Lines ~1013, 1039**: Add `DefaultBodyLimit::max(16_384)` to public route group

#### [MODIFY] [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts)
- **Line ~274**: Reduce global JSON body limit from 50MB → 10MB
- **Lines ~398–497**: Add max `items.length` cap of 50 on `/seal/decrypt-batch`

---

### 2.7 MED-2: Block Deactivated Accounts

#### [MODIFY] [sui.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/sui.rs)
- **Lines ~59–98**: Read `account.active` field in `verify_delegate_key_onchain`; assert `active == true`
- Return distinct `AccountDeactivated` error

---

### 2.8 MED-1: Add Replay Protection

#### [MODIFY] [auth.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/auth.rs)
- **Lines ~66–74**: Add nonce field to signed message payload
- Track seen nonces in Redis with matching TTL; reject duplicates

#### [MODIFY] [memwal.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/packages/sdk/src/memwal.ts)
- **Line ~293**: Add `crypto.randomUUID()` nonce to signed message

---

## Phase 3 — P2: Defense-in-Depth 🟡

> **Goal**: Address all remaining MEDIUM findings — concurrency bugs, input validation, infrastructure hardening.
> **Estimated Effort**: 3–4 days
> **Dependency**: Phase 2 complete

### 3.1 Concurrency & Resource Bounds

| Finding | File | Fix |
|---------|------|-----|
| MED-3 | [routes.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/routes.rs) :213 | Cap `body.limit` at 100 in `/api/recall` handler |
| MED-5 | routes.rs :593 | Already addressed by Phase 1.8 (`facts.truncate`) |
| MED-6 | routes.rs :869 | Replace `join_all` → `buffer_unordered(10)` in `/api/restore` download phase |
| MED-13 | [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts) :398 | Add `items.length <= 50` check to `/seal/decrypt-batch` |

### 3.2 Rate Limiting Fixes

| Finding | File | Fix |
|---------|------|-----|
| MED-19 | [rate_limit.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/rate_limit.rs) :229 | Atomic Redis Lua script for check+increment |
| MED-20 | rate_limit.rs :93 | Normalize paths (strip trailing `/`) before weight matching |
| MED-21 | rate_limit.rs :299 | PostgreSQL advisory lock per owner for storage quota |

### 3.3 Input Validation

| Finding | File | Fix |
|---------|------|-----|
| MED-4 | [routes.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/routes.rs) :516 | Cap extracted facts at 20; validate LLM response structure |
| MED-7 | routes.rs :1013 | Already in Phase 2.6 |
| MED-11 | [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts) :503 | Validate `owner` Sui address format |
| MED-12 | sidecar-server.ts :274 | Already in Phase 2.6 (50MB → 10MB) |

### 3.4 Error Message Sanitization (MED-8)

| File | Fix |
|------|-----|
| [types.rs](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/src/types.rs) :362 | Log detailed errors server-side with correlation ID; return generic messages |
| [sidecar-server.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/sidecar-server.ts) :314,389,496,632 | Same pattern for sidecar error responses |

### 3.5 SEAL Configuration (MED-9, MED-10)

| Finding | File | Fix |
|---------|------|-----|
| MED-9 | sidecar-server.ts :277 | Already removed in Phase 1.2 |
| MED-10 | sidecar-server.ts :303,375,469 + [manual.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/packages/sdk/src/manual.ts) :454 | Increase `threshold` from 1 → 2; make configurable via env var |

### 3.6 Smart Contract Fixes

| Finding | File | Fix |
|---------|------|-----|
| MED-15 | [account.move](file:///Users/ducnmm/Documents/commandoss/MemWal/services/contract/sources/account.move) :170 | Derive `sui_address` from `public_key` on-chain; add address uniqueness check |
| MED-16 | account.move :385 | Apply `has_suffix(id, owner_bytes)` to delegate auth path in `seal_approve` |

### 3.7 SDK Hardening

| Finding | File | Fix |
|---------|------|-----|
| MED-17 | [types.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/packages/sdk/src/types.ts) :13 | Accept `Uint8Array` as alternative; add `destroy()` method |
| MED-18 | [memwal.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/packages/sdk/src/memwal.ts) :72, [manual.ts](file:///Users/ducnmm/Documents/commandoss/MemWal/packages/sdk/src/manual.ts) :82 | Warn/throw for non-HTTPS non-localhost URLs |

### 3.8 Infrastructure (MED-14, MED-22)

| Finding | File | Fix |
|---------|------|-----|
| MED-14 | [package.json](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/scripts/package.json) | Pin exact versions for `@mysten/seal`, `@mysten/sui` |
| MED-22 | [Dockerfile](file:///Users/ducnmm/Documents/commandoss/MemWal/services/server/Dockerfile) | Add `USER appuser`; replace `curl \| bash` with official Node.js base image |

---

## Phase 4 — P3: Low Severity Polish 🟢

> **Goal**: Address all LOW findings. Group by component for efficiency.
> **Estimated Effort**: 2–3 days
> **Dependency**: Phase 3 complete

### 4.1 Server (Rust)

| ID | File | Fix |
|----|------|-----|
| LOW-1 | auth.rs | Include query string in signed message (`path_and_query()`) |
| LOW-2 | auth.rs | Normalize response timing across fallback paths |
| LOW-3 | auth.rs :168 | Add TTL-based eviction to delegate key cache |
| LOW-4 | rate_limit.rs :150 | Wrap ZADD + EXPIRE in `.atomic()` pipeline |
| LOW-5 | types.rs :317 | Implement manual `Debug` that redacts `delegate_key` (done in Phase 1) |
| LOW-6 | routes.rs :128 | Add explicit text length cap (~50KB) on `/api/remember` |
| LOW-7 | routes.rs :228 | Include error indicators in `/api/recall` response for failed downloads |
| LOW-8 | routes.rs :695 | Add clear delimiters between memory context and user query in `/api/ask` |
| LOW-9 | routes.rs :547 | Configure timeouts on reqwest clients (30s for LLM, 10s for embedding) |
| LOW-10 | db.rs :150 | Add owner filter to `delete_by_blob_id` query |
| LOW-11 | routes.rs :139 | Account for SEAL encryption overhead (~1.2x) in quota check |

### 4.2 Sidecar (TypeScript)

| ID | File | Fix |
|----|------|-----|
| LOW-12 | sidecar-server.ts :329 | Validate hex string before parsing; reject invalid input |
| LOW-13 | sidecar-server.ts :354 | Reduce `SessionKey` TTL from 30 → 2–5 minutes (done in Phase 2) |
| LOW-14 | sidecar-server.ts :620 | Report failure when blob object transfer to owner fails |
| LOW-15 | sidecar-server.ts :793 | Validate `digest` format before URL path interpolation |
| LOW-16 | sidecar-server.ts :297 | Validate `packageId` format at handler entry |
| LOW-17 | sidecar-server.ts :511 | Cap `epochs` parameter at maximum of 5 |
| LOW-18 | sidecar-server.ts :492 | Remove sensitive values from console logs; log only metadata |

### 4.3 Smart Contract (Move)

| ID | File | Fix |
|----|------|-----|
| LOW-19 | account.move :266 | Add guard `assert!(account.active == true)` before deactivation |
| LOW-20 | account.move :234 | Allow `remove_delegate_key` on deactivated accounts |
| LOW-21 | account.move :170 | Add max label length validation (e.g., 128 bytes) |

### 4.4 SDK (TypeScript)

| ID | File | Fix |
|----|------|-----|
| LOW-22 | memwal.ts :72 | Already done in MED-18 |
| LOW-23 | memwal.ts :315 | Include `x-account-id` in signed message payload |
| LOW-24 | manual.ts :457 | Include namespace in SEAL encryption identity |
| LOW-25 | utils.ts :32 | Validate hex input in `hexToBytes`; throw on invalid characters |
| LOW-26 | memwal.ts :320 | Sanitize error messages before throwing to callers |

### 4.5 Frontend Apps

| ID | File | Fix |
|----|------|-----|
| LOW-30 | Dashboard.tsx :170 | Redact key entirely in code snippets (use placeholder) |
| LOW-31 | Dashboard.tsx :119 | Add length (max 64) and character validation to label input |
| LOW-32 | App.tsx (DelegateKeyProvider) | Invoke `clearDelegateKeys` on logout and `beforeunload` |
| LOW-33 | multimodal-input.tsx :51 | Set `Secure` and `SameSite=Strict` attributes on cookie |
| LOW-34 | files/upload/route.ts | Add per-user rate limiting to upload endpoint |

### 4.6 Infrastructure

| ID | File | Fix |
|----|------|-----|
| LOW-27 | docker-compose.yml :16 | Bind PostgreSQL/Redis to `127.0.0.1`; remove hardcoded creds |
| LOW-28 | Dockerfile :7 | Pin base images by SHA256 digest |
| LOW-29 | docker-compose.yml | Add `mem_limit` and `cpus` to all services |

---

## Phase 5 — P4: Informational / Best Practices 🔵

> **Goal**: Close all INFO items and add missing test coverage.
> **Estimated Effort**: 1 day

| ID | Fix |
|----|-----|
| INFO-1 | Add TTL-based eviction to auth cache (overlaps LOW-3) |
| INFO-2 | Use `checked_sub` / `saturating_sub` for timestamp arithmetic in auth.rs |
| INFO-3 | Include `sui_address` in `DelegateKeyRemoved` event |
| INFO-4 | Document permanent registry design intent in architecture docs |
| INFO-5 | Add 5 missing edge-case tests: non-owner key removal, non-owner reactivation, max-key boundary, seal_approve wrong ID, duplicate sui_address |
| INFO-6 | Remove `process.uptime()` from health response |
| INFO-7 | Document unsigned health check limitation |

---

## User Review Required

> [!IMPORTANT]
> **Architectural Decision — CRIT-1 remediation approach:**
> Removing server-side SEAL decryption and pushing it fully to the client (following `MemWalManual` pattern) is a significant architectural change. This means:
> - The `MemWal` convenience class loses its "auto-decrypt" capability
> - All consuming apps must handle SEAL decryption client-side
> - The `/api/recall` and `/api/restore` endpoints will return encrypted blobs instead of plaintext
>
> **Do you want to:**
> - **(A)** Full migration — deprecate `MemWal` class, unify on `MemWalManual` pattern only
> - **(B)** Hybrid — keep server-side decrypt as an option but with proper key exchange (e.g., ephemeral session key via ECDH) instead of raw key transmission
> - **(C)** Phased — remove the key header immediately (breaking change), defer the SDK architectural redesign

> [!WARNING]
> **Smart Contract changes (MED-15, MED-16, LOW-19, LOW-20, LOW-21)** require a contract upgrade and redeployment. These should be batched and tested thoroughly before publishing.

> [!IMPORTANT]
> **SEAL threshold increase (MED-10)**: Changing from threshold 1 → 2 is a one-way operational change. All existing encrypted data must remain decryptable. Verify backward compatibility with existing SEAL key server setup before applying.

---

## Open Questions

1. **CRIT-1 approach**: Option A, B, or C above?
2. **Smart Contract upgrade strategy**: Deploy new package ID or use an upgrade cap? Note that existing accounts reference the old package.
3. **SEAL threshold**: Currently 3 key servers are configured. Is this confirmed in production? Threshold 2 requires ≥2 of 3 servers to be available.
4. **Enoki sponsorship**: After authenticating `/sponsor` endpoints (HIGH-4), should we also add transaction content validation (only allow MemWal-related Move calls)?
5. **Priority override**: Do you want to promote any MEDIUM or LOW findings to a higher priority phase?

---

## Verification Plan

### Automated Tests

```bash
# Rust server — unit + integration tests
cd services/server && cargo test

# Smart contract — Move tests
cd services/contract && sui move test

# SDK — TypeScript tests
cd packages/sdk && pnpm test

# Frontend apps — build check
cd apps/app && pnpm build
cd apps/chatbot && pnpm build
```

### Manual Verification
- **CRIT-1**: Capture HTTP traffic to confirm no `x-delegate-key` header in SDK requests
- **HIGH-1**: Port scan sidecar — confirm port 9000 only accepts connections from `127.0.0.1`
- **HIGH-2**: Simulate Redis outage — confirm requests return 429, not 200
- **HIGH-4**: Curl `/sponsor` without auth — confirm 401 response
- **HIGH-5**: Inspect SEAL client configuration — confirm `verifyKeyServers: true` in all instances
- **HIGH-8**: Inspect browser developer tools — confirm no private key in `localStorage`
- **Smart Contract**: Run full `sui move test` suite after MED-15/MED-16/LOW-19–21 changes

### Security Regression Tests
- Write integration tests for each compound risk chain (A, B, C) to prevent regressions
- Add CI check that `x-delegate-key` pattern does not appear in SDK codebase
- Add CI check that `verifyKeyServers: false` does not appear in any TypeScript file
