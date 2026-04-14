# MemWal Frontend Apps -- STRIDE Threat Model

**Date:** 2026-04-03
**Commit:** 5bb1669 (branch `dev`)
**Scope:** `apps/app/` (Dashboard SPA), `apps/chatbot/` (Next.js), `apps/noter/` (Next.js + tRPC), `apps/researcher/` (Next.js)

---

## 1. Service Overview

Four frontend applications provide different interfaces to MemWal's encrypted memory system. Each has distinct authentication patterns and trust models.

### 1.1 Dashboard App (`apps/app/`)

**Stack:** Vite + React SPA
**Auth:** Enoki zkLogin with Google OAuth
**Key storage:** Delegate private key in **localStorage** (`memwal_delegate`)
**API pattern:** Signed HTTP requests to Rust server with `x-delegate-key` header (private key in every request)

### 1.2 Chatbot (`apps/chatbot/`)

**Stack:** Next.js 15 + NextAuth
**Auth:** Email/password (bcrypt) + Guest user provider
**Session:** JWT in httpOnly cookies (30-day expiry)
**MemWal integration:** Optional; `memwalKey` passed client-side
**Rate limiting:** 10 messages/hour per user + IP-based (Redis-backed)

### 1.3 Noter (`apps/noter/`)

**Stack:** Next.js + tRPC
**Auth:** Dual: zkLogin OAuth (Google) + Wallet signature (Slush)
**Session:** Database-backed sessions with UUID session IDs; stored in `sessionStorage` client-side
**Key handling:** Ephemeral keypair for zkLogin; wallet signature for wallet auth
**Rate limiting:** None observed

### 1.4 Researcher (`apps/researcher/`)

**Stack:** Next.js
**Auth:** Direct Ed25519 private key submission via `/api/auth/key`
**Session:** JWT in httpOnly cookies containing the **private key** (30-day expiry)
**MemWal integration:** Delegate key from session or `MEMWAL_KEY` env var fallback
**Rate limiting:** 100 messages/hour per user + IP-based

---

## 2. Trust Boundaries

```
+-------------------------------------------------------------------+
|                        Browser Environment                         |
|                                                                    |
|  +-------------+  +-------------+  +----------+  +-----------+    |
|  | Dashboard   |  | Chatbot     |  | Noter    |  | Researcher|    |
|  | (Vite SPA)  |  | (Next.js)  |  | (Next.js)|  | (Next.js) |    |
|  +------+------+  +------+------+  +----+-----+  +-----+-----+    |
|         |                |              |               |          |
|  localStorage     httpOnly cookie  sessionStorage  httpOnly cookie |
|  [PRIVATE KEY]    [JWT session]    [session ID]    [JWT+PRIV KEY] |
+-------------------------------------------------------------------+
          |                |              |               |
          v                v              v               v
+-------------------------------------------------------------------+
|                     Network (HTTPS / HTTP)                         |
+-------------------------------------------------------------------+
          |                |              |               |
    +-----v-----+   +-----v-----+  +----v-----+   +----v------+
    | MemWal    |   | Next.js   |  | Next.js  |   | Next.js   |
    | Rust      |   | Server    |  | Server   |   | Server    |
    | Server    |   | (chatbot) |  | (noter)  |   | (researcher)|
    | port 8000 |   | port 3001 |  | port 3002|   |           |
    +-----------+   +-----------+  +----------+   +-----------+
          |                |              |               |
          v                v              v               v
    +-----+-----+   +-----+-----+  +----+-----+   +----+------+
    | Sidecar   |   | PostgreSQL|  | PostgreSQL|   | PostgreSQL|
    | port 9000 |   | + Redis   |  |           |   | + Redis   |
    +-----------+   +-----------+  +----------+   +-----------+
```

### Per-App Trust Boundary Summary

| App | Client -> Server Trust | Key Material Exposure | Session Store |
|-----|----------------------|----------------------|---------------|
| **Dashboard** | Ed25519 signed requests over HTTP; private key in header | localStorage (XSS-accessible) + every HTTP header | None (stateless signed requests) |
| **Chatbot** | NextAuth JWT; optional MemWal key client-side | Config-driven, not persisted in browser by app | httpOnly cookie |
| **Noter** | tRPC with session ID header; wallet signature or zkLogin | Ephemeral keypair in sessionStorage (XSS-accessible) | sessionStorage + DB |
| **Researcher** | NextAuth-style JWT containing private key | JWT cookie (httpOnly but contains private key!) | httpOnly cookie |

---

## 3. Data Flow Diagrams

### 3.1 Dashboard: Remember Flow

```
Browser (Dashboard SPA)                    MemWal Rust Server
    |                                          |
    | 1. User types memory text                |
    |                                          |
    | 2. Read delegate key from localStorage   |
    |    key = localStorage.get("memwal_delegate").delegateKey
    |                                          |
    | 3. Sign: sha256(ts.POST./api/remember.body_sha256)
    |                                          |
    | 4. POST /api/remember                    |
    |    x-delegate-key: [RAW PRIVATE KEY]     |  <-- CRITICAL
    |    x-public-key: [public key]            |
    |    x-signature: [Ed25519 sig]            |
    |    x-timestamp: [unix timestamp]         |
    |    x-account-id: [account object ID]     |
    |    Body: {"text": "...plaintext..."}     |
    |------------------------------------------->
    |                                          |
    |<--- 200 OK { id, blob_id } -------------|

RISK: Private key in localStorage + HTTP header. XSS = full compromise.
```

### 3.2 Researcher: Auth + Chat Flow

```
Browser                          Researcher Next.js Server
    |                                |
    | 1. POST /api/auth/key          |
    |    { privateKey: "abc123...",   |
    |      accountId: "0x..." }      |
    |------------------------------->|
    |                                |
    |              2. Validate: /^[0-9a-f]{64}$/i
    |              3. Derive public key via @noble/ed25519
    |              4. Upsert user by public key in DB
    |              5. Create JWT: { userId, publicKey,
    |                               privateKey, accountId }  <-- CRITICAL
    |              6. Set-Cookie: httpOnly, secure, 30-day
    |                                |
    |<--- 200 + Set-Cookie ----------|
    |                                |
    | 7. POST /api/chat              |
    |    Cookie: [JWT with private key inside]
    |------------------------------->|
    |              8. Decode JWT -> session.user.privateKey
    |              9. Initialize MemWal with private key
    |             10. Process chat with memory context
    |                                |
    |<--- { response } --------------|

RISK: Private key persisted in JWT cookie for 30 days.
AUTH_SECRET compromise = all user private keys exposed.
```

### 3.3 Noter: zkLogin Flow

```
Browser                    Noter Next.js          Google OAuth        Sui Prover
    |                          |                      |                   |
    | 1. initiate({provider})  |                      |                   |
    |------------------------->|                      |                   |
    |      2. Generate ephemeral Ed25519 keypair      |                   |
    |      3. Compute nonce(ephem_pk, max_epoch, rand)|                   |
    |      4. Store in sessionStorage:                |                   |
    |         { ephemeralPrivKey, ephemeralPubKey,     |                   |
    |           maxEpoch, randomness, nonce }          |                   |
    |<-- { redirectUrl } ------|                      |                   |
    |                          |                      |                   |
    | 5. Redirect to Google ---|--------------------->|                   |
    |<-- id_token (JWT) -------|----------------------|                   |
    |                          |                      |                   |
    | 6. completeLogin({jwt})  |                      |                   |
    |------------------------->|                      |                   |
    |      7. Validate JWT (exp, iss, sub, aud)       |                   |
    |      8. Derive salt: hash(iss::sub::aud)        |                   |
    |      9. Derive Sui address from JWT + salt      |                   |
    |     10. Request ZK proof ---|------------------------------------>|
    |                          |  |<-- zkProof ----------------------------|
    |     11. Upsert user (suiAddress, provider)      |                   |
    |     12. Create DB session (24h expiry)           |                   |
    |                          |                      |                   |
    |<-- { sessionId, user } --|                      |                   |

RISK: Ephemeral private key in sessionStorage. XSS = session hijack.
Salt derived client-side from JWT claims (deterministic, not secret).
```

### 3.4 Noter: Wallet Auth Flow

```
Browser (Slush Wallet)        Noter Next.js Server
    |                             |
    | 1. Connect wallet (Wallet Standard API)
    | 2. Get address from wallet  |
    |                             |
    | 3. Sign message:            |
    |    "Sign this message to authenticate with Noter"
    |    [wallet popup]           |
    |                             |
    | 4. walletLogin({address,    |
    |     signature, message,     |
    |     walletType: "slush"})   |
    |---------------------------->|
    |         5. verifyPersonalMessageSignature(message, signature)
    |         6. Assert recovered address == provided address
    |         7. Upsert user (walletAddress, authMethod: "wallet")
    |         8. Create walletSession (24h, stores signature+message)
    |                             |
    |<-- { sessionId, user } -----|

RISK: Static sign-in message ("Sign this message to...") -- no nonce or timestamp.
Captured signature is replayable until session expires.
```

---

## 4. Assets

| Asset | App(s) | Location | Sensitivity |
|-------|--------|----------|-------------|
| **Ed25519 delegate private key** | Dashboard | `localStorage["memwal_delegate"]` + `x-delegate-key` header | CRITICAL |
| **Ed25519 private key in JWT** | Researcher | httpOnly cookie (30-day TTL) | CRITICAL |
| **AUTH_SECRET** | Chatbot, Researcher | Server env var; signs all JWTs | CRITICAL |
| **Ephemeral Ed25519 keypair** | Noter | `sessionStorage["zklogin:session:id"]` | HIGH |
| **Google OAuth id_token** | Dashboard, Noter | Transient in redirect flow | HIGH |
| **Wallet signature** | Noter | DB (`walletSessions.signature`) | HIGH |
| **User chat messages** | Chatbot, Researcher | PostgreSQL, transient in API routes | HIGH |
| **Uploaded files** | Chatbot, Researcher | Vercel Blob (public access) | MEDIUM |
| **MemWal key (env fallback)** | Chatbot, Researcher | `MEMWAL_KEY` server env var | HIGH |
| **Enoki API key** | Dashboard | `VITE_ENOKI_API_KEY` (public, embedded in SPA) | LOW (public key) |
| **OpenRouter API key** | Chatbot, Noter, Researcher | Server env var | HIGH |
| **Session IDs** | Noter | `x-session-id` header, sessionStorage | MEDIUM |
| **bcrypt password hashes** | Chatbot | PostgreSQL | MEDIUM |

---

## 5. STRIDE Analysis

### S -- Spoofing

| ID | Threat | App(s) | Analysis | Risk |
|----|--------|--------|----------|------|
| S-1 | XSS steals delegate key from localStorage | Dashboard | Any XSS vulnerability allows `localStorage.getItem("memwal_delegate")` to exfiltrate the private key. Full account takeover. | **CRITICAL** |
| S-2 | AUTH_SECRET compromise exposes all Researcher private keys | Researcher | JWT contains `privateKey` field. If AUTH_SECRET leaks, all JWTs can be decoded, revealing every user's private key. | **CRITICAL** |
| S-3 | XSS steals ephemeral key from sessionStorage | Noter | `sessionStorage["zklogin:session:id"]` contains ephemeral private key. XSS within same tab can extract it. | **HIGH** |
| S-4 | Wallet signature replay (no nonce in sign message) | Noter | Static message "Sign this message to authenticate with Noter" contains no timestamp or nonce. Captured signature is valid indefinitely for creating new sessions. | **HIGH** |
| S-5 | Guest user impersonation | Chatbot | Guest provider generates random email. No identity verification. Useful only for resource abuse, not impersonation of real users. | **LOW** |
| S-6 | JWT replay within 30-day window | Researcher | httpOnly + secure mitigates browser-based theft, but stolen cookie (e.g., via SSRF or log exposure) is replayable for 30 days. | **MEDIUM** |

### T -- Tampering

| ID | Threat | App(s) | Analysis | Risk |
|----|--------|--------|----------|------|
| T-1 | XSS modifies localStorage delegate key | Dashboard | Attacker replaces stored key with their own, redirecting all future memory operations to attacker's account. | **HIGH** |
| T-2 | Chat message injection via unsanitized input | All chat apps | Zod validates length (max 2000 chars) but no content sanitization. Prompt injection possible in LLM context. | **MEDIUM** |
| T-3 | File upload with malicious filename | Chatbot, Researcher | Filename from user passed to Vercel Blob without sanitization. Vercel Blob likely handles this safely, but defense-in-depth is missing. | **LOW** |
| T-4 | `dangerouslySetInnerHTML` for theme script | Chatbot, Researcher | Layout uses `dangerouslySetInnerHTML` for theme color script. Currently safe (static content), but fragile if config source changes. | **LOW** |
| T-5 | tRPC request tampering via session ID | Noter | Session ID in `x-session-id` header. If attacker obtains another user's session ID, they can impersonate them via tRPC calls. | **MEDIUM** |

### R -- Repudiation

| ID | Threat | App(s) | Analysis | Risk |
|----|--------|--------|----------|------|
| R-1 | No client-side audit trail for memory operations | Dashboard | SPA has no logging of remember/recall/analyze operations. User cannot prove what was stored or retrieved. | **LOW** |
| R-2 | Guest users leave no identity trail | Chatbot | Random email, no verification. Chat history exists but unattributable. | **LOW** |
| R-3 | Wallet sessions store signature (non-repudiation) | Noter | `walletSessions` table stores the original wallet signature, providing cryptographic proof of authentication. | **MITIGATED** |

### I -- Information Disclosure

| ID | Threat | App(s) | Analysis | Risk |
|----|--------|--------|----------|------|
| I-1 | Private key in localStorage readable by any same-origin script | Dashboard | Browser extensions, third-party scripts, XSS -- all can read localStorage. No encryption or access control. | **CRITICAL** |
| I-2 | Private key embedded in JWT cookie | Researcher | Even httpOnly cookies are accessible server-side, in logs, crash dumps, and any middleware that decodes the JWT. 30-day window of exposure. | **CRITICAL** |
| I-3 | `x-delegate-key` header exposes key to proxies/CDNs/logs | Dashboard | Every API request contains the raw private key in an HTTP header. Any intermediate proxy, CDN, WAF, or access log captures it. | **CRITICAL** |
| I-4 | Uploaded files stored with `access: "public"` | Chatbot, Researcher | Files uploaded to Vercel Blob are publicly accessible by URL. No access control after upload. | **MEDIUM** |
| I-5 | OpenRouter API key in server env accessible to server code | All chat apps | Standard practice but a single leaked env var exposes LLM billing. | **LOW** |
| I-6 | Ephemeral keys in sessionStorage | Noter | Accessible to any script running in the same tab/origin. Less persistent than localStorage but still XSS-vulnerable. | **HIGH** |
| I-7 | Error messages from MemWal server propagated to client | Dashboard | Raw server error text may contain internal paths, SQL errors, or stack traces. | **LOW** |
| I-8 | zkLogin salt derivable from public JWT claims | Noter | Salt = `hash(iss :: sub :: aud)`. All inputs are in the JWT (public). Salt provides no additional secrecy. | **LOW** |

### D -- Denial of Service

| ID | Threat | App(s) | Analysis | Risk |
|----|--------|--------|----------|------|
| D-1 | Rate limit bypass via guest accounts | Chatbot | Guest provider creates unlimited accounts, each with its own rate limit quota. 10 msg/hour per user is easily circumvented. | **MEDIUM** |
| D-2 | No rate limiting on tRPC endpoints | Noter | No rate limiting observed on any tRPC procedure. Attacker can spam memory operations. | **MEDIUM** |
| D-3 | 10MB file upload limit is generous | Researcher | 10MB per file, no apparent per-user file count limit. Could exhaust Vercel Blob storage quota. | **LOW** |
| D-4 | LLM cost amplification via large messages | All chat apps | 2000-char messages sent to LLM + potentially MemWal analyze (weight=10). Rapid requests before rate limit kicks in. | **LOW** |

### E -- Elevation of Privilege

| ID | Threat | App(s) | Analysis | Risk |
|----|--------|--------|----------|------|
| E-1 | XSS -> full MemWal account takeover | Dashboard | XSS extracts private key from localStorage. Attacker gains permanent read/write/delete access to all memories. Key remains valid until on-chain revocation. | **CRITICAL** |
| E-2 | AUTH_SECRET leak -> all Researcher accounts compromised | Researcher | Decoding all JWTs reveals every user's private key. Mass account takeover. | **CRITICAL** |
| E-3 | Session ID theft -> noter account access | Noter | Session IDs in `x-session-id` header. If intercepted (e.g., via XSS reading headers, or server logs), attacker gains user's session. | **MEDIUM** |
| E-4 | `MEMWAL_KEY` env var as fallback grants server-level access | Chatbot, Researcher | If session has no private key, falls back to `MEMWAL_KEY`. This shared key accesses a single MemWal account for all users. | **MEDIUM** |
| E-5 | Guest escalation to paid features | Chatbot | Guest users share the same entitlement tier. No differentiation between guest and authenticated user capabilities. | **LOW** |

---

## 6. Attack Scenarios

### Scenario 1: XSS -> Dashboard Key Theft (S-1 + E-1)

**Attacker:** XSS via third-party dependency, CDN compromise, or reflected input
**Target:** Dashboard SPA user's MemWal account

1. Attacker injects `<script>` that executes in Dashboard origin
2. Script reads `localStorage.getItem("memwal_delegate")` -- JSON with `delegateKey`, `delegatePublicKey`, `accountObjectId`
3. Script exfiltrates to attacker server
4. Attacker uses stolen delegate key to sign requests to MemWal server
5. Attacker can: read all memories, inject false memories, delete memories
6. Victim has no indication of compromise until they notice data anomalies
7. Revocation requires on-chain `remove_delegate_key` transaction with owner's Sui wallet

**Impact:** CRITICAL. Persistent full account access.
**Likelihood:** MEDIUM (XSS in SPAs is common, especially with third-party deps).

### Scenario 2: AUTH_SECRET Compromise (S-2 + E-2)

**Attacker:** Insider, leaked env file, server compromise
**Target:** All Researcher app users

1. Attacker obtains `AUTH_SECRET` from `.env`, server logs, or process memory
2. Attacker collects JWT cookies (e.g., from access logs, CDN cache, or active interception)
3. Decodes JWTs with `AUTH_SECRET` -> extracts `{ privateKey, accountId }` for each user
4. Each extracted private key grants full MemWal access for that user's account
5. Mass compromise: every user who ever logged in within 30-day cookie window

**Impact:** CRITICAL. Mass account compromise.
**Likelihood:** LOW-MEDIUM (requires AUTH_SECRET exposure).

### Scenario 3: Wallet Signature Replay (S-4)

**Attacker:** Network observer or malicious dApp that captures wallet signatures
**Target:** Noter wallet-auth users

1. Attacker observes the wallet signature from a previous login (e.g., via shared browser, malicious dApp, or network interception)
2. The signed message is static: "Sign this message to authenticate with Noter"
3. Attacker calls `walletLogin({ address, signature, message, walletType: "slush" })`
4. Server verifies signature -> valid (same message, same sig, same address)
5. New session created for attacker with 24-hour expiry
6. Attacker has full access to victim's notes and memories

**Impact:** HIGH. Account takeover.
**Likelihood:** MEDIUM (wallet signature capture is feasible in shared environments).

### Scenario 4: Guest Account Rate Limit Bypass (D-1)

**Attacker:** Anyone
**Target:** Chatbot LLM resources

1. Attacker scripts repeated logins via guest provider (random email each time)
2. Each guest account gets fresh 10 msg/hour rate limit
3. Attacker cycles through guest accounts to bypass per-user limits
4. IP-based rate limiting only works on Vercel (requires Redis)
5. Self-hosted deployments without Redis have no effective rate limiting

**Impact:** MEDIUM. LLM cost amplification and resource exhaustion.
**Likelihood:** HIGH (trivially scriptable).

### Scenario 5: Shared MEMWAL_KEY Fallback (E-4)

**Attacker:** Any authenticated user of Chatbot or Researcher
**Target:** Other users' memories stored under the shared key

1. Chatbot/Researcher configured with `MEMWAL_KEY` env var as fallback
2. Multiple users' sessions use this same key when session-specific key is absent
3. All memories stored under the same MemWal account/delegate
4. User A can recall User B's memories (same key, same namespace)
5. No per-user isolation when fallback key is active

**Impact:** HIGH. Cross-user data exposure.
**Likelihood:** MEDIUM (depends on deployment configuration).

---

## 7. Threat Matrix

| ID | Threat | Category | App(s) | Likelihood | Impact | Risk |
|----|--------|----------|--------|------------|--------|------|
| I-1 | Private key in localStorage | Info Disclosure | Dashboard | High | Critical | **CRITICAL** |
| I-3 | Private key in HTTP header | Info Disclosure | Dashboard | High | Critical | **CRITICAL** |
| S-1 | XSS steals localStorage key | Spoofing | Dashboard | Medium | Critical | **CRITICAL** |
| E-1 | XSS -> full account takeover | EoP | Dashboard | Medium | Critical | **CRITICAL** |
| I-2 | Private key in JWT cookie | Info Disclosure | Researcher | Medium | Critical | **CRITICAL** |
| S-2 | AUTH_SECRET -> mass key extraction | Spoofing | Researcher | Low-Med | Critical | **CRITICAL** |
| E-2 | AUTH_SECRET -> mass compromise | EoP | Researcher | Low-Med | Critical | **CRITICAL** |
| S-3 | XSS steals ephemeral key | Spoofing | Noter | Medium | High | **HIGH** |
| S-4 | Wallet signature replay | Spoofing | Noter | Medium | High | **HIGH** |
| I-6 | Ephemeral keys in sessionStorage | Info Disclosure | Noter | Medium | High | **HIGH** |
| T-1 | XSS modifies localStorage key | Tampering | Dashboard | Medium | High | **HIGH** |
| E-4 | Shared MEMWAL_KEY fallback | EoP | Chatbot, Researcher | Medium | High | **MEDIUM** |
| T-2 | LLM prompt injection via chat | Tampering | All chat apps | Medium | Medium | **MEDIUM** |
| T-5 | Session ID theft | Tampering | Noter | Medium | Medium | **MEDIUM** |
| S-6 | JWT replay (30-day window) | Spoofing | Researcher | Low | High | **MEDIUM** |
| E-3 | Session ID -> noter access | EoP | Noter | Medium | Medium | **MEDIUM** |
| D-1 | Guest account rate limit bypass | DoS | Chatbot | High | Medium | **MEDIUM** |
| D-2 | No rate limiting on tRPC | DoS | Noter | Medium | Medium | **MEDIUM** |
| I-4 | Files uploaded as public | Info Disclosure | Chatbot, Researcher | Medium | Medium | **MEDIUM** |
| R-2 | Guest users unattributable | Repudiation | Chatbot | Medium | Low | **LOW** |
| T-3 | Unsanitized upload filename | Tampering | Chatbot, Researcher | Low | Low | **LOW** |
| T-4 | dangerouslySetInnerHTML | Tampering | Chatbot, Researcher | Low | Medium | **LOW** |
| D-3 | File upload storage exhaustion | DoS | Researcher | Low | Medium | **LOW** |
| D-4 | LLM cost amplification | DoS | All chat apps | Low | Medium | **LOW** |
| E-5 | Guest escalation | EoP | Chatbot | Low | Low | **LOW** |
| I-5 | OpenRouter key in env | Info Disclosure | All chat apps | Low | Medium | **LOW** |
| I-7 | Server errors propagated | Info Disclosure | Dashboard | Medium | Low | **LOW** |
| I-8 | zkLogin salt derivable | Info Disclosure | Noter | High | Low | **LOW** |
| R-1 | No client audit trail | Repudiation | Dashboard | Low | Low | **LOW** |
| S-5 | Guest impersonation | Spoofing | Chatbot | Low | Low | **LOW** |

### Risk Summary

| Risk Level | Count |
|------------|-------|
| CRITICAL | 7 (I-1, I-3, S-1, E-1, I-2, S-2, E-2) |
| HIGH | 4 (S-3, S-4, I-6, T-1) |
| MEDIUM | 9 |
| LOW | 10 |

---

## 8. Missing Security Controls

All four apps lack:
- **Content Security Policy (CSP) headers** -- no XSS mitigation at the HTTP level
- **X-Frame-Options / frame-ancestors** -- clickjacking possible
- **Strict-Transport-Security (HSTS)** -- no HTTPS enforcement
- **X-Content-Type-Options: nosniff** -- MIME sniffing attacks possible
- **Explicit CORS configuration** -- relies on framework defaults

---

## 9. Recommendations

### P0 -- Address CRITICAL Risks

1. **Remove private key from localStorage (Dashboard).** Use session-scoped memory (sessionStorage at minimum) or, better, derive a short-lived token server-side. Never store raw private keys in persistent browser storage.
2. **Remove private key from JWT cookie (Researcher).** Store only a session ID in the cookie; keep private keys server-side in an encrypted session store keyed by session ID. Reduce cookie TTL from 30 days to session-length.
3. **Remove `x-delegate-key` header (Dashboard + SDK).** This is an architectural issue inherited from the SDK (see `04-sdk-clients.md` threat I-1). The server should never receive the delegate private key -- it should verify signatures only.

### P1 -- Address HIGH Risks

4. **Add nonce + timestamp to Noter wallet sign message.** Replace "Sign this message to authenticate with Noter" with "Sign in to Noter\nNonce: {uuid}\nTimestamp: {iso8601}". Verify nonce freshness server-side. Prevents signature replay.
5. **Move ephemeral keys out of sessionStorage (Noter).** Use a non-extractable `CryptoKey` via Web Crypto API where possible, or at minimum encrypt the key material before storing.
6. **Add Content Security Policy headers** to all apps. At minimum: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`. Blocks XSS payload execution.

### P2 -- Address MEDIUM Risks

7. **Remove or scope `MEMWAL_KEY` fallback.** Either require per-user keys or namespace memories by user ID when using a shared key.
8. **Add rate limiting to Noter tRPC endpoints.** Redis-backed sliding window similar to chatbot implementation.
9. **Tie guest rate limits to IP, not user account** (Chatbot). Prevents trivial bypass via account cycling.
10. **Upload files as private** in Vercel Blob. Generate signed URLs for access.
11. **Reduce Researcher JWT expiry** from 30 days to 24 hours or shorter.
12. **Add LLM prompt injection defenses** -- system prompt hardening, output sanitization, tool call validation.

### P3 -- Defense in Depth

13. **Add security headers middleware** (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) to all Next.js apps.
14. **Sanitize upload filenames** before passing to storage backends.
15. **Add session invalidation** on password change (Chatbot) and on suspicious activity (all apps).
16. **Log authentication events** (login, logout, key rotation) for audit trail.
