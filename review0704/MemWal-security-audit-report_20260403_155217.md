
--- Pass: sections-1-6 ---
# MemWal Security Audit Report

---

## 1. Cover Page

| Field | Value |
|---|---|
| **Project** | MemWal — Privacy-First AI Memory Layer |
| **Date** | 2026-04-03 |
| **Commit** | 5bb1669 |
| **Branch** | dev |
| **Scope** | Server (Rust/Axum), Sidecar (TypeScript/Express), Smart Contract (Move), SDK (TypeScript), Frontend Apps (React/Next.js), Infrastructure (Docker, Redis, PostgreSQL) |
| **Auditor Note** | This report was generated using automated static analysis augmented by AI-assisted code review. |

**Methodology Summary**

This audit was conducted in three phases. Phase 1 applied automated static analysis across all 599 source files in the monorepo, flagging patterns associated with credential exposure, injection, insecure configurations, and access control weaknesses. Phase 2 performed manual code-level review of all critical services — the Rust authentication and route-handler layers, the TypeScript sidecar, the Move smart contract, and the TypeScript SDK — producing six detailed review documents validated against a prior baseline audit. Phase 3 triaged and consolidated all findings, eliminated duplicates, ranked by severity and exploitability, and identified compound risk chains. The review covered commit 5bb1669 on the `dev` branch and was scoped to the components listed above; the review did not include penetration testing of live infrastructure, fuzzing of compiled binaries, or formal verification of cryptographic protocols.

---

## 2. Executive Summary

MemWal demonstrates a well-designed cryptographic foundation: Ed25519 request signing with on-chain delegate key verification, parameterized SQL throughout the data layer, strong data isolation via owner-scoped queries, and a Move smart contract free of the silent authorization-check antipattern. However, these strengths are substantially undermined by several architectural decisions that expose secret key material in transit and at rest, disable cryptographic verification of the SEAL encryption layer, and leave multiple high-value endpoints entirely unauthenticated. The most consequential issues — transmitting a delegate private key in every HTTP request header, disabling SEAL key server identity verification, and running the TypeScript sidecar with zero authentication on all network interfaces — each independently represent production-blocking risks. The combination creates compound attack chains where a single network-adjacent attacker can obtain cryptographic keys, drain gas budgets, and decrypt user memories without touching the authenticated API surface.

| Severity | Count |
|---|---|
| **CRITICAL** | 1 |
| **HIGH** | 13 |
| **MEDIUM** | 22 |
| **LOW** | 34 |
| **INFO** | 7 |
| **Total** | **77** |

**Most Urgent Issues**

- The `MemWal` SDK class sends the raw Ed25519 delegate private key in an HTTP header on every authenticated request; the `MemWalManual` class proves this is architecturally unnecessary.
- The TypeScript sidecar binds to `0.0.0.0:9000` with zero authentication, wildcard CORS, and no body-size limits, exposing SEAL encryption, Walrus uploads, and gas sponsorship to any network-reachable process.
- All three Redis-backed rate limit layers are configured to fail open when Redis is unavailable, removing the sole abuse-prevention control during outages.
- `verifyKeyServers: false` is set in all four SEAL client instances across the sidecar and SDK, disabling cryptographic verification of the threshold encryption key servers.
- The `/sponsor` and `/sponsor/execute` endpoints are public, unrate-limited, and unauthenticated, allowing any caller to drain the project's Enoki gas sponsorship budget via arbitrary transaction sponsorship.

---

## 3. Scope

### Components Reviewed

| Component | Path | Review Method |
|---|---|---|
| Rust Authentication Middleware | `services/server/src/auth.rs` | Manual code review |
| Rust Route Handlers | `services/server/src/routes.rs` | Manual code review |
| Rust Data Layer | `services/server/src/db.rs`, `seal.rs`, `walrus.rs`, `types.rs` | Manual code review |
| Rust Rate Limiter | `services/server/src/rate_limit.rs` | Manual code review |
| TypeScript Sidecar | `services/server/scripts/sidecar-server.ts`, `seal-encrypt.ts`, `seal-decrypt.ts` | Manual code review + STRIDE threat model |
| Move Smart Contract | `services/contract/sources/account.move` | Manual code review |
| TypeScript SDK | `packages/sdk/src/memwal.ts`, `manual.ts`, `types.ts`, `utils.ts` | Manual code review |
| React Dashboard App | `apps/app/src/` | Automated scan + manual review |
| Next.js Chatbot App | `apps/chatbot/app/`, `components/`, `lib/` | Automated scan + manual review |
| Infrastructure | `services/server/Dockerfile`, `docker-compose.yml` | Manual code review |
| Rust Indexer | `services/indexer/` | Out of scope (no direct user-facing attack surface) |
| Next.js Researcher App | `apps/researcher/` | Automated scan |
| Next.js Noter App | `apps/noter/` | Automated scan |
| OpenClaw Plugin | `packages/openclaw-memory-memwal/` | Automated scan |

### Out of Scope

- Live infrastructure, deployed contracts, or running services were not tested.
- Sui blockchain consensus or Walrus storage network internals were not reviewed.
- Formal verification of cryptographic protocol correctness was not performed.
- Binary fuzzing or dynamic analysis of compiled Rust artifacts was not performed.
- Third-party dependencies (`@mysten/seal`, `@mysten/walrus`, `ed25519_dalek`) were reviewed only at the call-site level, not internally audited.
- The `services/indexer/` Rust indexer was not reviewed in this pass.

---

## 4. Methodology

**Phase 1 — Automated Static Analysis**
Automated pattern-matching was run across all 599 files in the monorepo. Scans targeted credential exposure patterns (private keys in headers, environment variable handling), injection vectors (SQL, command, prompt), insecure configurations (CORS, TLS, default ports), access control weaknesses (missing authentication, authorization gaps), and dependency supply chain risks. Results were triaged by a secondary pass to eliminate false positives.

**Phase 2 — Manual Code-Level Review**
Six detailed review documents were produced covering the Rust server authentication module, Rust route handlers and data layer, TypeScript sidecar (including a full STRIDE threat model), Move smart contract, TypeScript SDK, and rate limiting and infrastructure configuration. Each review was conducted independently of the prior baseline audit and then cross-referenced against it to confirm, extend, or downgrade prior findings. All authorization-relevant boolean computations in the Move contract were systematically traced to their enclosing `assert!` statements.

**Phase 3 — Triage and Consolidation**
All findings were consolidated into a unified registry, duplicates were merged, compound risk chains were identified, and findings were ranked by severity and exploitability. The consolidated registry was compared against the prior baseline audit to surface a full list of confirmed, extended, downgraded, and new findings.

---

## 5. Positive Security Findings

| Area | Assessment |
|---|---|
| **SQL Injection** | All queries in `db.rs` use parameterized binds via sqlx. Zero dynamic SQL construction in any code path reviewed. |
| **SSRF** | All outbound HTTP URLs originate from server-side environment variables, never from user input. Not exploitable at the server layer. |
| **Data Isolation** | All database queries filter by `(owner, namespace)`. Owner is derived from on-chain Ed25519 verification and cannot be forged by a client. |
| **Ed25519 Verification** | Signature verification uses `ed25519_dalek::verify()`, which is constant-time. No timing side-channel. |
| **Move Authorization Checks** | All 15 authorization-relevant boolean computations in `account.move` flow into `assert!` statements. The silent authorization-check antipattern is absent. |
| **Move Reentrancy** | Prevented by design via Move's linear type system. Not applicable as an attack vector. |
| **Account Resolution** | Strategy 1 cache hits are always re-verified on-chain before use. Strategy 3 header hints are verified on-chain. The system fails closed (401) on Sui RPC errors. |
| **Auth Middleware Ordering** | In Axum's layer stack, `auth::verify_signature` runs before `rate_limit_middleware`. `AuthInfo` is correctly available when the rate limiter reads it. |
| **Move Registry Duplicate Prevention** | `Table::contains` + `Table::add` is atomic on Sui. One account per Sui address is correctly enforced. |
| **Delegate Key Bounds** | `add_delegate_key` enforces exactly 32 bytes for the public key and a strict maximum of 20 keys per account. |
| **Walrus Download Timeout** | `walrus::download_blob` configures a 10-second timeout on the reqwest client, bounding the worst-case latency for download operations. |
| **SEAL Decryption Concurrency** | The `restore` endpoint uses `buffer_unordered(3)` for SEAL decryption, providing bounded concurrency for that step. |
| **Expired Blob Cleanup** | Cleanup failures do not propagate to the user request; the pattern is fire-and-forget with logged errors. |

---

## 6. Critical and High Findings

---

### CRIT-1 — Delegate Private Key Transmitted in Every HTTP Request

| Field | Detail |
|---|---|
| **ID** | CRIT-1 |
| **Severity** | CRITICAL |
| **Component** | SDK (`MemWal` class), Rust Server Auth Middleware, TypeScript Sidecar |
| **Files** | `packages/sdk/src/memwal.ts:314`, `apps/app/src/utils/api.ts`, `services/server/src/auth.rs:61-64`, `services/server/src/types.rs:326`, `services/server/scripts/sidecar-server.ts:324,404` |

**Description**
The `MemWal` SDK class transmits the raw Ed25519 delegate private key in the `x-delegate-key` HTTP header on every authenticated request — including `remember`, `recall`, `analyze`, `ask`, and `restore`. The key propagates from the SDK through the Rust server's `AuthInfo` struct and onward to the sidecar in SEAL decrypt request bodies. The `MemWalManual` class authenticates successfully without transmitting this header, confirming the transmission is architecturally unnecessary. The `AuthInfo` struct additionally derives `Debug` (`types.rs:317`), creating a latent risk that any `tracing::debug!` call formatting an `AuthInfo` value will print the private key to logs.

**Impact**
Any party with access to server access logs, reverse proxy logs, WAF logs, or network captures on a non-TLS path obtains the private key. A stolen delegate key enables the attacker to sign arbitrary API requests and, combined with the SEAL layer, decrypt all memories belonging to the associated account — indefinitely, until the owner revokes the key on-chain.

**Remediation**
Remove line 314 (`"x-delegate-key": bytesToHex(this.privateKey)`) from `MemWal.signedRequest()`. Push SEAL decryption to the client following the `MemWalManual` pattern. Implement a manual `Debug` for `AuthInfo` that redacts the `delegate_key` field.

---

### HIGH-1 — Sidecar Has Zero Authentication and Binds to All Interfaces

| Field | Detail |
|---|---|
| **ID** | HIGH-1 |
| **Severity** | HIGH |
| **Component** | TypeScript Sidecar |
| **Files** | `services/server/scripts/sidecar-server.ts:273-285,811` |

**Description**
The Express sidecar has no authentication mechanism on any endpoint and binds to `0.0.0.0` by default, making every endpoint — `/seal/encrypt`, `/seal/decrypt`, `/seal/decrypt-batch`, `/walrus/upload`, `/walrus/query-blobs`, `/sponsor`, `/sponsor/execute` — reachable from any host on the network. No shared secret, IP allowlist, or mTLS is present. Wildcard CORS (`Access-Control-Allow-Origin: *`) is applied to all responses, enabling browser-based access if the port is reachable.

**Impact**
A network-adjacent attacker can encrypt data under arbitrary identities, decrypt memories given a delegate key, upload Walrus blobs spending the server's SUI/WAL tokens, drain the Enoki gas budget, and enumerate any user's on-chain blob inventory. Combined with CRIT-1, all inbound delegate keys can be captured at the sidecar boundary.

**Remediation**
Change `app.listen(PORT)` to `app.listen(PORT, "127.0.0.1")` at `sidecar-server.ts:811`. Add a shared secret middleware that validates an `X-Sidecar-Secret` header against an environment variable on all non-health endpoints. Remove the CORS middleware entirely; the sidecar should never be called by browsers.

---

### HIGH-2 — Rate Limiter Fails Open on Redis Unavailability

| Field | Detail |
|---|---|
| **ID** | HIGH-2 |
| **Severity** | HIGH |
| **Component** | Rust Server Rate Limiter |
| **Files** | `services/server/src/rate_limit.rs:240-242,259-261,278-281` |

**Description**
All three rate limit window checks (per-owner-minute, per-owner-hour, per-delegate-key-minute) catch Redis errors and unconditionally allow the request through with a log warning. The `record_in_window` function at line 158 similarly swallows recording failures silently. An attacker or operator failure that takes Redis offline removes all rate limiting globally. Docker Compose additionally exposes Redis on `0.0.0.0:6379` with no authentication, enabling an attacker on the local network to issue `SHUTDOWN NOSAVE` to trigger this condition deliberately.

**Impact**
With rate limiting disabled, the `/api/analyze` endpoint (cost weight 10, normally capped at 6/minute) can be called at wire speed, each triggering unbounded LLM calls, embedding API calls, SEAL encryptions, and Walrus uploads. The cost amplification described in HIGH-3 becomes unconstrained.

**Remediation**
Return `429 Too Many Requests` when Redis is unreachable rather than allowing the request. Implement an in-memory token-bucket fallback for the per-owner-minute window as a secondary defense. Bind Redis to `127.0.0.1` in the Docker Compose configuration.

---

### HIGH-3 — Analyze Endpoint Cost Amplification via Unbounded Fact Extraction

| Field | Detail |
|---|---|
| **ID** | HIGH-3 |
| **Severity** | HIGH |
| **Component** | Rust Server Route Handlers |
| **Files** | `services/server/src/routes.rs:391-480,516-534,553-563,593-597` |

**Description**
The `/api/analyze` endpoint passes user-supplied text directly into a `user`-role LLM message alongside a system prompt that instructs the model to extract facts. There is no cap on the number of facts the LLM may return. All extracted facts are then processed concurrently via `join_all` with no concurrency bound — each fact triggers one embedding API call, one SEAL encryption, one Walrus upload, and one database insert. The endpoint's rate limit weight is a constant 10 regardless of how many facts are extracted, making the weight meaningless as a bound on actual resource consumption.

**Impact**
A user who provides adversarially crafted text that causes the LLM to return 200 facts consumes 200x the expected resources per rate-limited unit. At 6 analyze requests per minute (60/10), this yields potentially 1,200 Walrus uploads per minute from a single account, accelerating SUI token depletion and exhausting sidecar capacity.

**Remediation**
Add `facts.truncate(20)` after parsing the LLM response. Replace `join_all` with `buffer_unordered(5)` for the per-fact processing loop. Consider adjusting the rate limit weight post-extraction based on actual fact count.

---

### HIGH-4 — Unauthenticated Sponsor Proxy Endpoints

| Field | Detail |
|---|---|
| **ID** | HIGH-4 |
| **Severity** | HIGH |
| **Component** | Rust Server Public Routes, TypeScript Sidecar |
| **Files** | `services/server/src/routes.rs:1011-1060`, `services/server/src/main.rs:147-150`, `services/server/scripts/sidecar-server.ts:753-804` |

**Description**
`POST /sponsor` and `POST /sponsor/execute` on both the Rust server and the sidecar are public endpoints with no authentication, no rate limiting, and no body-size restrictions. They accept arbitrary `transactionBlockKindBytes` and `sender` values and proxy them directly to the Enoki API using the project's API key. No validation of transaction content or sender identity is performed. Any caller who can reach port 8000 or port 9000 can sponsor arbitrary Sui transactions at the project's expense.

**Impact**
Automated abuse drains the project's Enoki sponsorship budget, causing all downstream Walrus uploads (which depend on `executeWithEnokiSponsor`) to fail or fall back to direct signing, accelerating depletion of server wallet SUI balances. An attacker can also use these endpoints to sponsor arbitrary Move calls, not only MemWal operations.

**Remediation**
Move both sponsor endpoints behind the existing Ed25519 authentication middleware. Add rate limiting with a low cost weight. Add a body-size limit of 16KB via `axum::extract::DefaultBodyLimit::max(16_384)` on the public routes.

---

### HIGH-5 — SEAL Key Server Verification Disabled in All Client Instances

| Field | Detail |
|---|---|
| **ID** | HIGH-5 |
| **Severity** | HIGH |
| **Component** | TypeScript Sidecar, TypeScript SDK |
| **Files** | `services/server/scripts/sidecar-server.ts:67`, `services/server/scripts/seal-encrypt.ts:96`, `services/server/scripts/seal-decrypt.ts:117`, `packages/sdk/src/manual.ts:200` |

**Description**
Every `SealClient` instance in the codebase is constructed with `verifyKeyServers: false`. This disables cryptographic verification of SEAL key server identity against their on-chain object IDs. The flag is set in four separate files spanning both the server-side sidecar and the client-side SDK. With threshold set to 1 across all instances, a single compromised or impersonated key server is sufficient to obtain all key material needed to encrypt or decrypt any memory.

**Impact**
A DNS poisoning, BGP hijack, or BGP-level MitM attack allows an attacker to substitute a rogue SEAL key server. Because `verifyKeyServers: false` prevents the client from verifying the server's on-chain identity, the rogue server can participate in key generation and decryption undetected, yielding plaintext of all user memories.

**Remediation**
Set `verifyKeyServers: true` in all four files. This is a one-line change per file and requires no architectural changes.

---

### HIGH-6 — Server Wallet Private Keys Transmitted Per-Request to Sidecar

| Field | Detail |
|---|---|
| **ID** | HIGH-6 |
| **Severity** | HIGH |
| **Component** | Rust Server Walrus Integration, TypeScript Sidecar |
| **Files** | `services/server/src/walrus.rs:80-81`, `services/server/scripts/sidecar-server.ts:513-519` |

**Description**
On every Walrus upload, the Rust server selects a key from the `SERVER_SUI_PRIVATE_KEYS` pool and transmits the raw private key string in the HTTP request body to the sidecar's `/walrus/upload` endpoint. The sidecar uses this key to sign on-chain transactions for blob registration and certification. The key traverses a plaintext HTTP connection (localhost, but see HIGH-1 regarding `0.0.0.0` binding) and is held in the Express `req.body` object for the duration of the request, where it is accessible to heap dumps and error-logging middleware.

**Impact**
Compromise of the sidecar process — via supply chain attack on any npm dependency, exploitation of an Express vulnerability, or access following HIGH-1 — exposes all server wallet private keys over time as Walrus uploads occur. These keys hold SUI and WAL tokens used for storage payments. An attacker with the keys can drain all server wallet balances and delete registered blobs (which are uploaded as `deletable: true`).

**Remediation**
Load `SERVER_SUI_PRIVATE_KEYS` from environment variables at sidecar startup. Pass a key index or key identifier in the request body instead of the raw key material. The Rust server should reference keys by index; the sidecar should look up the key locally.

---

### HIGH-7 — Delegate Private Keys Received in Sidecar Decrypt Request Bodies

| Field | Detail |
|---|---|
| **ID** | HIGH-7 |
| **Severity** | HIGH |
| **Component** | TypeScript Sidecar, Rust Server SEAL Integration |
| **Files** | `services/server/scripts/sidecar-server.ts:324,404`, `services/server/src/seal.rs:109` |

**Description**
The `/seal/decrypt` and `/seal/decrypt-batch` endpoints receive the user's delegate private key in the JSON request body. The Rust server extracts the delegate key from the `AuthInfo` struct (originally from the `x-delegate-key` header, CRIT-1) and forwards it to the sidecar in every decrypt call. The key is held in the Express `req.body` object, held in a `SessionKey` object for a 30-minute TTL, and is accessible via heap dumps for the duration of the Node.js process.

**Impact**
Every SEAL decryption operation exposes the delegate private key at the sidecar boundary, compounding the exposure already created by CRIT-1. A compromised sidecar process can passively collect delegate keys from all decrypt operations without any active exploitation.

**Remediation**
The architectural fix is to push SEAL decryption to the client (eliminating the need to transmit the private key to the server at all). As an interim measure, reduce `ttlMin` from 30 to 2-5 minutes and ensure sidecar authentication (HIGH-1) is addressed first.

---

### HIGH-8 — Private Key Stored in localStorage in Frontend Apps

| Field | Detail |
|---|---|
| **ID** | HIGH-8 |
| **Severity** | HIGH |
| **Component** | React Dashboard App, Next.js Chatbot App |
| **Files** | `apps/app/src/App.tsx:71-85`, `apps/chatbot/components/chat.tsx:93-114` |

**Description**
The Ed25519 delegate private key is persisted to `localStorage` in plaintext JSON by both the dashboard app and the chatbot app. `localStorage` is synchronous, unencrypted, has no expiry, and is accessible to any JavaScript running on the same origin — including XSS payloads, malicious browser extensions, and injected third-party scripts. The chatbot app additionally sends the stored key in POST request bodies to `/api/chat`.

**Impact**
Any XSS vulnerability anywhere on the application origin — in a dependency, a chat message renderer, a URL reflection, or any injected third-party script — converts to full delegate key theft. An attacker with the key can sign arbitrary API requests and decrypt all user memories indefinitely until the key is revoked on-chain.

**Remediation**
Do not persist private key material to `localStorage`. Use `sessionStorage` as a minimum improvement (cleared on tab close). The correct solution is non-extractable `CryptoKey` objects via the Web Crypto API, or — consistent with the architectural fix for CRIT-1 — eliminate client-side raw key handling entirely.

---

### HIGH-9 — File Upload Path Traversal via Unsanitized Filename

| Field | Detail |
|---|---|
| **ID** | HIGH-9 |
| **Severity** | HIGH |
| **Component** | Next.js Chatbot App |
| **Files** | `apps/chatbot/app/(chat)/api/files/upload/route.ts:50-53` |

**Description**
The filename is extracted directly from multipart `FormData` and passed verbatim to the Vercel Blob `put()` call with no sanitization. An attacker can submit a filename containing path traversal sequences (`../../admin/payload.png`) or a filename matching another user's uploaded file, overwriting existing blobs. There is no per-user namespace prefix — all uploads land in a shared flat key space.

**Impact**
An authenticated attacker can overwrite other users' uploaded files by submitting a filename that collides with their blob key. Depending on how uploaded files are served and referenced, this may also enable content injection attacks against other users.

**Remediation**
Sanitize filenames by stripping path separators and restricting to safe characters. Prefix every upload key with a user-scoped, non-guessable identifier: `${session.user.id}/${crypto.randomUUID()}-${sanitizedFilename}`.

---

### HIGH-10 — Missing Authorization Checks on Destructive Server Actions (IDOR)

| Field | Detail |
|---|---|
| **ID** | HIGH-10 |
| **Severity** | HIGH |
| **Component** | Next.js Chatbot App |
| **Files** | `apps/chatbot/app/(chat)/actions.ts` |

**Description**
The `deleteTrailingMessages` and `updateChatVisibility` Next.js Server Actions perform mutations against chat and message records without verifying that the requesting user owns the affected resources. Any authenticated user who knows or guesses a valid message ID or chat ID can delete another user's messages or change the visibility of another user's chat. These are `"use server"` functions, making them callable via direct HTTP requests.

**Impact**
An authenticated attacker can delete arbitrary messages from any chat (IDOR leading to data destruction) or expose any private chat as public. Message IDs may be discoverable via shared/public chat links or other side channels.

**Remediation**
Verify resource ownership before performing mutations. Retrieve the authenticated user's session and compare `session.user.id` against the owner of the target message or chat before proceeding.

---

### HIGH-11 — User Enumeration via Distinct Registration Response

| Field | Detail |
|---|---|
| **ID** | HIGH-11 |
| **Severity** | HIGH |
| **Component** | Next.js Chatbot App |
| **Files** | `apps/chatbot/app/(auth)/actions.ts` |

**Description**
The registration server action returns a distinct `{ status: "user_exists" }` response when a registration attempt uses an already-registered email address. This allows an attacker to enumerate valid user accounts by scripting registration attempts and observing the response status.

**Impact**
Account enumeration enables targeted credential stuffing, phishing campaigns against confirmed users, and reconnaissance for subsequent attacks against specific high-value accounts.

**Remediation**
Return a generic failure status (e.g., `{ status: "failed" }`) for both "user already exists" and general error cases. Guide users who already have accounts via a rate-limited email flow rather than an immediate distinguishable response.

---

### HIGH-12 — Open Redirect via Unvalidated `redirectUrl` Parameter

| Field | Detail |
|---|---|
| **ID** | HIGH-12 |
| **Severity** | HIGH |
| **Component** | Next.js Chatbot App |
| **Files** | `apps/chatbot/app/(auth)/api/auth/guest/route.ts:7,18` |

**Description**
The guest sign-in route accepts a `redirectUrl` query parameter and passes it directly to `signIn()` as the post-authentication redirect target with no validation against an allowlist or origin check. An attacker can craft a URL where the initial domain is the legitimate application but the redirect target is an attacker-controlled site.

**Impact**
A victim who follows an attacker-crafted link completes guest sign-in on the legitimate domain and is then redirected to a malicious site. The redirect can be used for phishing, credential harvesting, or wallet signature capture.

**Remediation**
Validate `redirectUrl` before use. Reject any value that is not a relative path or that has an origin differing from the request's own origin.

---

### HIGH-13 — No Body Size Limit on Unauthenticated Public Endpoints

| Field | Detail |
|---|---|
| **ID** | HIGH-13 |
| **Severity** | HIGH |
| **Component** | Rust Server Public Routes, TypeScript Sidecar |
| **Files** | `services/server/src/routes.rs:1013,1039`, `services/server/scripts/sidecar-server.ts:274` |

**Description**
Public routes on the Rust server (`/sponsor`, `/sponsor/execute`) do not pass through the auth middleware that enforces the 1MB body limit, leaving them constrained only by Axum's default 2MB extractor limit. The sidecar applies a 50MB JSON body limit globally across all endpoints regardless of authentication status. Both limits are exploitable for memory pressure attacks against unauthenticated surfaces. The sidecar's `/seal/decrypt-batch` endpoint additionally has no limit on the `items` array, allowing a single request to trigger thousands of CPU-intensive `EncryptedObject.parse` and SEAL key server calls.

**Impact**
An unauthenticated attacker can initiate memory exhaustion against both services. A targeted batch-decrypt request with thousands of items can block the Node.js event loop, making the sidecar unresponsive to all legitimate requests until the process recovers.

**Remediation**
Add `axum::extract::DefaultBodyLimit::max(16_384)` to the public route group. Reduce the sidecar JSON body limit to 10MB. Add an explicit array size cap (e.g., 50 items) to `/seal/decrypt-batch` at the handler level.


--- Pass: section-7 ---
## 7. Medium Findings

---

### MED-1: No Replay Protection on Authenticated Requests

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Auth Middleware |
| **Files** | `services/server/src/auth.rs:66–74`, `packages/sdk/src/memwal.ts:293` |
| **Source** | 01-server-authentication F-1, 05-sdk-client 2.3 |

Signed requests are protected only by a ±300-second timestamp window with no nonce or seen-signature tracking. Any captured valid request can be replayed an unlimited number of times within that window; the rate limiter provides partial mitigation only when Redis is available.

**Remediation:** Add a `crypto.randomUUID()` nonce to the signed message payload; track seen nonces in Redis with a matching TTL and reject duplicates.

---

### MED-2: Deactivated Accounts Authenticate Successfully

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Sui Auth |
| **Files** | `services/server/src/sui.rs:59–98` |
| **Source** | 01-server-authentication F-4 (NEW) |

`verify_delegate_key_onchain` checks whether a delegate key exists on-chain but never reads the `active` field of `MemWalAccount`. A deactivated account passes server authentication and can invoke non-SEAL endpoints (`remember_manual`, `recall_manual`), consuming storage quota and writing garbage data even after the owner called `deactivate_account()` to freeze access.

**Remediation:** Read and assert `account.active == true` inside `verify_delegate_key_onchain`; return a distinct `AccountDeactivated` error on failure.

---

### MED-3: Unbounded Concurrent Blob Downloads in `/api/recall`

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Route Handlers |
| **Files** | `services/server/src/routes.rs:213, 217–266` |
| **Source** | 02-server-routes-and-data R-2 |

The `limit` parameter on `/api/recall` is passed directly to a SQL `LIMIT` clause with no upper bound. A request with an extreme limit causes the server to spawn an equal number of concurrent Walrus download and sidecar SEAL decrypt tasks via `join_all`, overwhelming downstream services.

**Remediation:** Cap `body.limit` at a maximum value (e.g., 100) in the handler before passing it to the database query.

---

### MED-4: LLM Prompt Injection in `/api/analyze`

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Route Handlers |
| **Files** | `services/server/src/routes.rs:516–534, 553–563` |
| **Source** | 02-server-routes-and-data R-5 |

User-supplied text is injected without sanitization into the LLM `user` message alongside the `FACT_EXTRACTION_PROMPT` system prompt. A crafted payload can override system instructions, causing the model to produce an arbitrarily large number of facts and poisoning the caller's own memory store with fabricated content.

**Remediation:** Cap the number of accepted extracted facts (e.g., at 20) and validate response structure before processing.

---

### MED-5: Unbounded Fact Count Amplifies Cost in `/api/analyze`

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Route Handlers |
| **Files** | `services/server/src/routes.rs:593–597, 423–464` |
| **Source** | 02-server-routes-and-data R-6 |

Extracted facts are iterated without a ceiling and dispatched concurrently via `join_all`. Each fact triggers an embedding API call, a SEAL encryption, a Walrus upload, and a database insert. The rate-limit cost for `analyze` is a constant 10 regardless of how many facts are produced, making the per-request resource cost effectively unbounded.

**Remediation:** Apply `facts.truncate(MAX_FACTS)` immediately after parsing and replace `join_all` with `buffer_unordered(N)` to bound concurrency.

---

### MED-6: Unbounded Concurrent Downloads in `/api/restore`

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Route Handlers |
| **Files** | `services/server/src/routes.rs:869–892` |
| **Source** | 02-server-routes-and-data R-9 |

Blob downloads in the restore path are dispatched with `join_all` without a concurrency limit. Although the SEAL decryption step later uses `buffer_unordered(3)`, a large `limit` value causes all missing blobs to be downloaded simultaneously, with no bound on parallel outbound HTTP connections.

**Remediation:** Replace `join_all` with `buffer_unordered(10)` for the download phase.

---

### MED-7: No Body Size Limit on Public Sponsor Endpoints

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Route Handlers |
| **Files** | `services/server/src/routes.rs:1013, 1039` |
| **Source** | 02-server-routes-and-data R-11 |

The unauthenticated `/sponsor` and `/sponsor/execute` endpoints use a raw `axum::body::Bytes` extractor that bypasses the 1 MB limit enforced by the auth middleware. Axum's default extractor limit (2 MB) applies, but repeated large-payload requests from unauthenticated callers create a viable memory-pressure vector.

**Remediation:** Apply an explicit `axum::extract::DefaultBodyLimit::max(16_384)` layer to the public route group.

---

### MED-8: Internal Error Messages Returned to Clients

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server, TypeScript Sidecar |
| **Files** | `services/server/src/types.rs:362–377`, `services/server/scripts/sidecar-server.ts:314, 389, 496, 632` |
| **Source** | 02-server-routes-and-data R-12, 03-sidecar-server S17 |

Both the Rust server and the sidecar return raw internal error strings to callers. Disclosed content includes database connection details, sidecar URL and connectivity status, embedding and LLM API status codes and response bodies, and Enoki API error context.

**Remediation:** Log detailed errors server-side with a correlation ID; return a generic "Internal server error" message to clients.

---

### MED-9: Wildcard CORS on Sidecar

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript Sidecar |
| **Files** | `services/server/scripts/sidecar-server.ts:277–285` |
| **Source** | 03-sidecar-server S2 |

The sidecar sets `Access-Control-Allow-Origin: *` on every response via a manual middleware applied to all endpoints. Combined with the absence of authentication (HIGH-3) and binding to `0.0.0.0`, any browser context that can reach port 9000 can make unrestricted cross-origin requests to all sidecar endpoints.

**Remediation:** Remove CORS headers from the sidecar entirely; it should only be called by the co-located Rust server, never by browsers.

---

### MED-10: SEAL Threshold Hardcoded to 1

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript Sidecar, TypeScript SDK |
| **Files** | `services/server/scripts/sidecar-server.ts:303, 375, 469`, `packages/sdk/src/manual.ts:454` |
| **Source** | 03-sidecar-server S4, 05-sdk-client 4.3 |

All SEAL encrypt and decrypt operations use `threshold: 1`, meaning a single key server compromise provides complete access to all encrypted memories. The multi-server SEAL configuration provides no redundancy or threshold security benefit at this setting.

**Remediation:** Increase the threshold to at least 2 for a standard 3-server deployment; make the value configurable via environment variable.

---

### MED-11: `owner` Address Not Validated in Walrus Upload

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript Sidecar |
| **Files** | `services/server/scripts/sidecar-server.ts:503–515` |
| **Source** | 03-sidecar-server S9 |

The `/walrus/upload` endpoint accepts an `owner` address parameter with no format validation. Since the sidecar has no authentication, a direct caller can specify any Sui address as recipient for blob objects uploaded at the server wallet's expense.

**Remediation:** Validate that `owner` matches the expected Sui address format; authentication on the sidecar (HIGH-3) is the primary fix.

---

### MED-12: 50 MB JSON Body Limit on All Sidecar Endpoints

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript Sidecar |
| **Files** | `services/server/scripts/sidecar-server.ts:274` |
| **Source** | 03-sidecar-server S13 |

The Express JSON body parser is configured with a 50 MB limit applied globally to all endpoints. Multiple concurrent large-payload requests can exhaust Node.js heap memory, causing the sidecar to become unresponsive and blocking all SEAL and Walrus operations for legitimate users.

**Remediation:** Reduce the global body limit to 5–10 MB and consider per-endpoint limits for operations with known payload bounds.

---

### MED-13: No Array Size Limit on `/seal/decrypt-batch`

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript Sidecar |
| **Files** | `services/server/scripts/sidecar-server.ts:398–497` |
| **Source** | 03-sidecar-server S14 |

The `items` array in `/seal/decrypt-batch` has no maximum size. Each element triggers `EncryptedObject.parse` (CPU-intensive), SEAL key server network calls, and an individual decrypt operation. A request with thousands of entries can block the Node.js event loop and render the sidecar unresponsive.

**Remediation:** Enforce a maximum items limit (e.g., 50–100) at the handler entry point.

---

### MED-14: Broad Semver Ranges on Security-Critical Dependencies

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript Sidecar |
| **Files** | `services/server/scripts/package.json:10–15` |
| **Source** | 03-sidecar-server S21 |

All sidecar dependencies, including cryptographic libraries `@mysten/seal` and `@mysten/sui`, use caret (`^`) semver ranges. An unexpected minor or patch release could alter encryption behavior or introduce a vulnerability, and will be automatically adopted on the next install.

**Remediation:** Pin exact versions for cryptographic dependencies and commit the lockfile; adopt a dependency update process that includes changelog review for security-critical packages.

---

### MED-15: Unvalidated `sui_address` in `add_delegate_key`

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Move Smart Contract |
| **Files** | `services/contract/sources/account.move:170, 193–201` |
| **Source** | 04-smart-contract MEDIUM-1 |

The `sui_address` parameter in `add_delegate_key` is accepted as caller-supplied input with no on-chain validation that it derives from the accompanying `public_key`. The duplicate check enforces `public_key` uniqueness only, not address uniqueness, allowing an owner to register the same `sui_address` under multiple different public keys. Revoking one key does not revoke that address's SEAL access.

**Remediation:** Derive `sui_address` on-chain from `public_key`, or require the delegate to co-sign registration; add address uniqueness enforcement to the duplicate check loop.

---

### MED-16: Delegate Path Skips Key ID Validation in `seal_approve`

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Move Smart Contract |
| **Files** | `services/contract/sources/account.move:385–389` |
| **Source** | 04-smart-contract MEDIUM-2 |

The owner path in `seal_approve` requires `has_suffix(id, bcs(owner))`, binding decryption to the specific owner's data. The delegate path checks only `is_delegate_address(account, caller)` with no validation of the `id` parameter. If a delegate is registered in multiple accounts, the lack of ID validation could produce unexpected policy evaluation at the SEAL key server level.

**Remediation:** Apply the same `has_suffix(id, owner_bytes)` check to the delegate authorization path.

---

### MED-17: Private Key Accepted as Immutable JavaScript String

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript SDK |
| **Files** | `packages/sdk/src/types.ts:13, 127`, `packages/sdk/src/memwal.ts:70` |
| **Source** | 05-sdk-client 1.3 |

Both SDK config types accept private keys as hex strings. JavaScript strings are immutable primitives that cannot be zeroed; the original key string persists in the V8 heap until garbage collection, extending the exposure window in memory.

**Remediation:** Document this limitation; consider accepting `Uint8Array` directly as an alternative input type and provide a `destroy()` method that zeroes the buffer.

---

### MED-18: Default Server URL Uses Plaintext HTTP

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | TypeScript SDK |
| **Files** | `packages/sdk/src/memwal.ts:72`, `packages/sdk/src/manual.ts:82` |
| **Source** | 05-sdk-client 7.1 |

The SDK defaults to `http://localhost:8000` with no enforcement or warning for non-localhost HTTP configurations in production. Combined with the `x-delegate-key` credential transmission issue (CRIT-1), private key material travels over an unencrypted channel in any non-HTTPS deployment.

**Remediation:** Emit a console warning or throw when `serverUrl` is non-HTTPS and the host is not localhost.

---

### MED-19: Rate Limit Check-Then-Record TOCTOU Race

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Rate Limiter |
| **Files** | `services/server/src/rate_limit.rs:229–286` |
| **Source** | 06-rate-limiting-and-infrastructure 1.1 |

The middleware checks all three rate limit windows before recording any entries. Under concurrent load, multiple requests from the same key can each complete the check phase before any record operation runs, collectively consuming the full window budget in a single burst.

**Remediation:** Replace the check-then-record pattern with an atomic Redis Lua script that checks and increments in a single operation.

---

### MED-20: Endpoint Weight Bypassable via Path Variation

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Rate Limiter |
| **Files** | `services/server/src/rate_limit.rs:93–101` |
| **Source** | 06-rate-limiting-and-infrastructure 1.3 |

`endpoint_weight` performs exact string matches against `request.uri().path()`. A trailing slash (e.g., `/api/analyze/`) or URL-encoded variant causes the expensive endpoint to fall through to the default weight of 1, allowing callers to perform high-cost operations at a 10× lower rate limit cost.

**Remediation:** Normalize paths by stripping trailing slashes before matching, or attach cost weights as Axum route extensions at route registration time.

---

### MED-21: Storage Quota Check-Then-Write Race Condition

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Rust Server — Rate Limiter, Route Handlers |
| **Files** | `services/server/src/rate_limit.rs:299–328`, `services/server/src/routes.rs:139–140, 417–418` |
| **Source** | 06-rate-limiting-and-infrastructure 3.1 |

`check_storage_quota` reads current usage from PostgreSQL, then the caller proceeds independently to upload and insert. Concurrent requests — including multiple parallel fact operations from a single `/api/analyze` call — can all pass the same quota baseline before any of them record their storage consumption.

**Remediation:** Use a PostgreSQL advisory lock per owner or a Redis-based reservation system to atomically check and reserve quota before starting uploads.

---

### MED-22: Container Runs as Root / Remote Script Execution in Dockerfile

| Field | Detail |
|---|---|
| **Severity** | Medium |
| **Component** | Infrastructure — Dockerfile |
| **Files** | `services/server/Dockerfile` (no `USER` directive), `services/server/Dockerfile:31` |
| **Source** | 06-rate-limiting-and-infrastructure 5.1, 5.2 |

The production Docker image has no `USER` directive, causing both the Rust server and its sidecar child process to run as `root`. Additionally, the Dockerfile fetches and executes a remote shell script (`curl -fsSL https://deb.nodesource.com/setup_22.x | bash -`) at build time with no content hash verification, creating a supply chain risk.

**Remediation:** Add a non-root `appuser` via `adduser` and a `USER appuser` directive; replace the curl-pipe-to-bash pattern with an official Node.js base image or a verified offline installer.


--- Pass: sections-8-11 ---
## 8. Low and Informational Findings

> Detailed writeups for each finding reside in `security-review/detailed-explanations/`. This table provides the summary index only.

### 8.1 Low Severity

| ID | Title | Severity | Component | Description |
|----|-------|----------|-----------|-------------|
| LOW-1 | Query string excluded from request signature | Low | Server / SDK | Path signed without query params; no current routes are affected but pattern is fragile |
| LOW-2 | Config fallback account resolution timing side-channel | Low | Server (`auth.rs`) | Response timing may differ between "key not found" and "account not exist" in Strategy 3 |
| LOW-3 | Stale delegate key cache not removed on revocation | Low | Server (`auth.rs:168`) | Revoked keys re-check on-chain every request but stale row persists in DB indefinitely |
| LOW-4 | Non-atomic rate limit record pipeline | Low | Server (`rate_limit.rs:150`) | ZADD + EXPIRE not wrapped in `.atomic()`; partial pipeline failure can leave keys with no TTL |
| LOW-5 | `AuthInfo` derives `Debug`, leaking delegate key | Low | Server (`types.rs:317`) | Any `{:?}` format of `AuthInfo` prints the raw private key hex to logs |
| LOW-6 | No text length cap on `/api/remember` | Low | Server (`routes.rs:128`) | Input bounded only by 1MB body limit; oversized payloads waste OpenAI embedding quota |
| LOW-7 | Silent result drop in `/api/recall` | Low | Server (`routes.rs:228`) | Failed blob downloads silently omitted; client cannot distinguish errors from empty results |
| LOW-8 | Indirect prompt injection via stored memories in `/api/ask` | Low | Server (`routes.rs:695`) | User-stored memories injected into LLM context without delimiter; low risk (own data only) |
| LOW-9 | No timeout on LLM / embedding HTTP calls | Low | Server (`routes.rs:547`) | `reqwest::Client` has no configured timeout; slow LLM responses block handler indefinitely |
| LOW-10 | `delete_by_blob_id` not owner-scoped | Low | Server (`db.rs:150`) | Deletes any matching blob_id regardless of owner; collision risk is negligible but exists |
| LOW-11 | Storage quota pre-check uses plaintext byte length | Low | Server (`routes.rs:139`) | Quota checked against raw text size; SEAL encryption overhead is not accounted for |
| LOW-12 | Private key hex parsed without validation in sidecar | Low | Sidecar (`sidecar-server.ts:329`) | `parseInt(b, 16)` returns `NaN` for invalid hex; produces silent zero bytes in key material |
| LOW-13 | SessionKey TTL set to 30 minutes | Low | Sidecar (`sidecar-server.ts:354`) | Decrypt session keys remain valid 30 min; a single-request operation needs ≤2 min |
| LOW-14 | Metadata/transfer failure after Walrus upload is silent | Low | Sidecar (`sidecar-server.ts:620`) | Upload reports success even when blob object transfer to owner fails |
| LOW-15 | Sponsor `digest` interpolated directly into Enoki URL path | Low | Sidecar (`sidecar-server.ts:793`) | No format validation before path interpolation |
| LOW-16 | No `packageId` format validation | Low | Sidecar (`sidecar-server.ts:297`) | Malformed Move call targets cause opaque transaction errors |
| LOW-17 | `epochs` parameter accepted without bounds | Low | Sidecar (`sidecar-server.ts:511`) | Caller can request excessive storage epochs, increasing SUI cost to server wallet |
| LOW-18 | Sensitive values in sidecar console logs | Low | Sidecar (`sidecar-server.ts:492`) | Sender addresses, blob object IDs, and error details logged via `console.log/error` |
| LOW-19 | Contract: `deactivate_account` not idempotent | Low | Contract (`account.move:266`) | Re-deactivating an already-deactivated account emits a spurious `AccountDeactivated` event |
| LOW-20 | Contract: deactivation prevents delegate key removal | Low | Contract (`account.move:234`) | `remove_delegate_key` requires `active == true`; owner cannot purge compromised key after deactivation |
| LOW-21 | Contract: no delegate key label length validation | Low | Contract (`account.move:170`) | Labels are arbitrary-length strings; only Sui's 128 KB transaction limit applies |
| LOW-22 | SDK: default server URL is plaintext HTTP | Low | SDK (`memwal.ts:72`) | Default `http://localhost:8000` is used without HTTPS enforcement in non-localhost configs |
| LOW-23 | SDK: `x-account-id` header not part of signed message | Low | SDK (`memwal.ts:315`) | Intermediary can swap the account hint without breaking the signature |
| LOW-24 | SDK: SEAL encryption ID is owner-scoped, not namespace-scoped | Low | SDK (`manual.ts:457`) | Delegates authorized for one namespace can request SEAL decryption across all namespaces |
| LOW-25 | SDK: `hexToBytes` silently accepts invalid hex | Low | SDK (`utils.ts:32`) | Non-hex characters produce `NaN` → `0` bytes; corrupted keys fail silently |
| LOW-26 | SDK: server error messages propagated verbatim to callers | Low | SDK (`memwal.ts:320`) | Internal server details (stack traces, RPC URLs) surface in client-thrown exceptions |
| LOW-27 | Docker Compose: PostgreSQL and Redis exposed to all interfaces | Low | Infrastructure (`docker-compose.yml:16`) | Both services bind `0.0.0.0`; dev credentials hardcoded in committed file |
| LOW-28 | Docker: container base images not pinned by digest | Low | Infrastructure (`Dockerfile:7`) | Mutable tags `rust:1.85-bookworm` and `debian:bookworm-slim` allow silent tag mutation |
| LOW-29 | Docker: no resource limits on containers | Low | Infrastructure (`docker-compose.yml`) | Runaway queries can consume all host memory and CPU |
| LOW-30 | App: partial private key exposed in Dashboard code snippets | Low | `apps/app` (`Dashboard.tsx:170`) | First and last 8 hex characters of delegate key rendered in copyable SDK examples |
| LOW-31 | App: key label input accepts arbitrary content | Low | `apps/app` (`Dashboard.tsx:119`) | No length or character restriction; stored on-chain; potential for XSS in non-React consumers |
| LOW-32 | App: no session expiry or key-wipe on inactivity | Low | `apps/app` (`DelegateKeyProvider`) | `clearDelegateKeys` is defined but never invoked on logout or tab close |
| LOW-33 | Chatbot: cookie set without `Secure` / `SameSite` attributes | Low | `apps/chatbot` (`multimodal-input.tsx:51`) | `chat-model` cookie is sent over HTTP in non-HTTPS deployments |
| LOW-34 | Chatbot: file upload endpoint has no rate limit | Low | `apps/chatbot` (`files/upload/route.ts`) | Authenticated users can upload indefinitely, exhausting blob storage budget |

### 8.2 Informational

| ID | Title | Severity | Component | Description |
|----|-------|----------|-----------|-------------|
| INFO-1 | Stale cache entries not evicted on delegate key revocation | Info | Server (`auth.rs:168`) | Performance waste; no security impact due to mandatory on-chain re-verification |
| INFO-2 | Integer overflow in timestamp subtraction (debug builds) | Info | Server (`auth.rs:71`) | `i64::MIN` timestamp causes panic in debug mode; wraps harmlessly in release |
| INFO-3 | `DelegateKeyRemoved` event does not include `sui_address` | Info | Contract (`account.move:98`) | Indexer must correlate with `DelegateKeyAdded` to determine which address lost access |
| INFO-4 | Account registry entries are permanent (no deletion) | Info | Contract | Intentional design; registry grows monotonically with no cleanup path |
| INFO-5 | Missing contract test coverage for five edge cases | Info | Contract | No tests for: non-owner key removal, non-owner reactivation, max-key boundary, seal_approve wrong ID, duplicate sui_address |
| INFO-6 | Sidecar `/health` endpoint discloses process uptime | Info | Sidecar (`sidecar-server.ts:289`) | `process.uptime()` returned in health response; minor operational disclosure |
| INFO-7 | SDK health check is unsigned | Info | SDK (`memwal.ts:249`) | A MitM can return a fake healthy status; no authenticated endpoint validation |

---

## 9. Compound Risk Chains

### Chain A: XSS + localStorage Private Key + HTTP Header Transmission = Full Account Takeover

**Findings involved:** LOW-30 (partial key in DOM snippets), CRIT-2 (private key in localStorage), CRIT-1 (x-delegate-key header on every request), HIGH-2 (unauthenticated sponsor endpoints), HIGH-3 (sidecar zero auth)

**Chain:**
1. An attacker delivers an XSS payload to the victim's browser via a crafted chat message, a malicious dependency, or a DOM injection in the Dashboard. React's default escaping does not protect code rendered outside JSX (e.g., `SyntaxHighlighter` blocks, `innerHTML`-based toast libraries).
2. The payload reads `localStorage.getItem('memwal_delegate')` to extract the Ed25519 delegate private key, which is stored in plaintext.
3. The attacker exfiltrates the key. Because `MemWal.signedRequest()` transmits the key in the `x-delegate-key` header on every API call, the attacker can now independently sign authenticated requests.
4. Using the delegate key, the attacker calls `/api/remember`, `/api/analyze`, and `/api/recall` to read all user memories and inject false ones.
5. The attacker also calls the unauthenticated `/sponsor` endpoint directly to drain the Enoki gas budget and trigger on-chain operations at no personal cost.

**Combined impact:** Full MemWal account takeover — read, write, and corrupt all user memories; drain gas sponsorship budget. Neither account deactivation (which is not checked in server auth, HIGH-8) nor SEAL encryption prevents this because the attacker has the valid delegate key.

---

### Chain B: Redis Outage + Rate Limiter Fail-Open + Analyze Cost Amplification = Resource Exhaustion at Scale

**Findings involved:** HIGH-1 (rate limiter fails open), MED-6 (TOCTOU in rate limit check), HIGH-6 (analyze cost amplification), LOW-27 (Redis exposed on 0.0.0.0)

**Chain:**
1. An attacker on the local network (or inside the container network) sends `FLUSHALL` or `SHUTDOWN NOSAVE` to the unauthenticated Redis instance, which is bound to `0.0.0.0:6379` in the Docker Compose configuration.
2. Redis becomes unavailable. All three rate limit `check_window` calls log a warning and allow every request through (`rate_limit.rs:240-280`).
3. The attacker (or a scripted client) sends rapid concurrent POST requests to `/api/analyze`. The rate limit cost of 10 per request is never recorded.
4. Each `/api/analyze` request uses the LLM to extract an unbounded number of facts, then spawns a `join_all` over N concurrent embedding + SEAL encrypt + Walrus upload operations.
5. At 60 unauthenticated (rate-limit-bypassed) requests per minute, each producing 50 facts: 3,000 Walrus uploads per minute, consuming server SUI gas, Enoki sponsorship budget, and OpenAI API quota simultaneously.

**Combined impact:** Financial resource exhaustion — server wallet drained, Enoki budget exhausted, OpenAI billing inflated — without the attacker spending any SUI. The system degrades for all users.

---

### Chain C: Sidecar Exposure + SEAL Key Server Impersonation + Threshold-1 = Decryption of All User Memories

**Findings involved:** HIGH-3/HIGH-4 (sidecar unauthenticated, 0.0.0.0), HIGH-5 (verifyKeyServers: false), MED-14 (threshold hardcoded to 1), CRIT-1 (delegate key in request body to sidecar)

**Chain:**
1. The sidecar binds to `0.0.0.0:9000` with no authentication. An attacker who gains access to the host network (co-located VM, container escape, cloud VPC peer) can reach the sidecar directly.
2. The attacker intercepts HTTP traffic between the Rust server (port 8000) and sidecar (port 9000). Every `/seal/decrypt` request carries the user's delegate private key in the JSON body (`seal.rs:109` → `sidecar-server.ts:324`).
3. In parallel, the attacker performs DNS poisoning or BGP hijacking to redirect one SEAL key server hostname to a rogue server. Because `verifyKeyServers: false` is set in all four SEAL client instances, the rogue server's identity is never verified.
4. With `threshold: 1`, only one SEAL key server shard is required. The rogue server returns attacker-controlled key shares during both encrypt and decrypt flows.
5. Using intercepted delegate keys and the rogue SEAL server, the attacker can decrypt all memories for any user who authenticated during the compromise window.

**Combined impact:** Cryptographic compromise — all SEAL-encrypted user memories become readable. The encryption layer, which is the primary privacy guarantee of MemWal, is bypassed entirely. Remediation requires key rotation, re-encryption of all stored blobs, and removal of the compromised delegate keys on-chain.

---

## 10. Remediation Roadmap

### Phase 1 — P0: Block Production Deployment

These findings must be resolved before any production deployment. Each represents a systemic failure that an attacker can exploit with low effort and high impact.

| Finding | Description | Effort |
|---------|-------------|--------|
| CRIT-1 | Remove `x-delegate-key` header from `MemWal` SDK; push SEAL decryption to client (as `MemWalManual` already does) | High — architectural redesign of SDK + server SEAL flow |
| HIGH-3 / HIGH-4 | Bind sidecar to `127.0.0.1`; add shared-secret middleware (`X-Sidecar-Secret` env var) | Low — 1-line
