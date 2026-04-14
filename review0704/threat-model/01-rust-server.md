# MemWal Rust Server -- STRIDE Threat Model

**Date:** 2026-04-02
**Commit:** 5bb1669 (branch `dev`)
**Scope:** `services/server/` -- the Axum-based Rust API server
**Authors:** Security review, automated analysis

---

## Table of Contents

1. [Service Overview](#1-service-overview)
2. [Trust Boundaries](#2-trust-boundaries)
3. [Data Flow Diagrams](#3-data-flow-diagrams)
4. [Assets](#4-assets)
5. [STRIDE Analysis](#5-stride-analysis)
6. [Attack Scenarios](#6-attack-scenarios)
7. [Threat Matrix](#7-threat-matrix)

---

## 1. Service Overview

### What the Service Does

The MemWal Rust server (`services/server/`) is the central API gateway for the MemWal privacy-first AI memory layer. It:

- **Authenticates** all SDK requests via Ed25519 signature verification + on-chain delegate key verification against Sui blockchain
- **Embeds** plaintext text into vector representations via OpenAI-compatible APIs
- **Coordinates encryption** via a TypeScript sidecar (SEAL threshold encryption)
- **Uploads encrypted blobs** to Walrus decentralized storage via the same sidecar
- **Stores vector embeddings** in PostgreSQL with pgvector for semantic search
- **Rate limits** authenticated requests via Redis sliding windows
- **Proxies** Enoki sponsor transactions (unauthenticated)

### What It Exposes

| Endpoint | Auth | Method | Purpose |
|----------|------|--------|---------|
| `/api/remember` | Ed25519 + on-chain | POST | Embed + encrypt + upload + store memory |
| `/api/recall` | Ed25519 + on-chain | POST | Search + download + decrypt memories |
| `/api/remember/manual` | Ed25519 + on-chain | POST | Upload pre-encrypted data + store vector |
| `/api/recall/manual` | Ed25519 + on-chain | POST | Search vectors only (no decrypt) |
| `/api/analyze` | Ed25519 + on-chain | POST | LLM fact extraction + remember each fact |
| `/api/ask` | Ed25519 + on-chain | POST | Recall + LLM Q&A |
| `/api/restore` | Ed25519 + on-chain | POST | Re-download + re-decrypt + re-embed from Walrus |
| `/health` | None | GET | Health check |
| `/sponsor` | **None** | POST | Proxy to Enoki sponsor API |
| `/sponsor/execute` | **None** | POST | Proxy to Enoki execute API |

**Listening address:** `0.0.0.0:{PORT}` (default 8000) -- binds to all interfaces.

### What It Connects To

| Dependency | Protocol | Purpose |
|-----------|----------|---------|
| TypeScript Sidecar (localhost:9000) | HTTP (no auth) | SEAL encrypt/decrypt, Walrus upload, blob queries |
| PostgreSQL | TCP (sqlx pool, max 10 connections) | Vector storage, delegate key cache, account lookup |
| Redis | TCP | Rate limiting sliding windows |
| Sui RPC | HTTPS | On-chain account verification, registry scanning |
| OpenAI/OpenRouter API | HTTPS | Text embedding, LLM chat completions |

---

## 2. Trust Boundaries

```
                     UNTRUSTED                          TRUSTED (server-controlled)
    +-----------------+       +------------------------------------------------------------------+
    |                 |       |                                                                  |
    |  SDK Clients    |       |  +------------------+     +-------------------+                  |
    |  (Internet)     |------>|  |  Rust Server     |---->|  TS Sidecar       |                  |
    |                 | TLS?  |  |  (port 8000)     |HTTP |  (port 9000)      |                  |
    |  - Ed25519 sig  |       |  |                  |     |  - SEAL encrypt   |                  |
    |  - x-public-key |       |  |  - Auth MW       |     |  - SEAL decrypt   |                  |
    |  - x-timestamp  |       |  |  - Rate limit MW |     |  - Walrus upload  |                  |
    |  - x-delegate-  |       |  |  - Routes        |     |  - Sponsor proxy  |                  |
    |    key (PRIV!)  |       |  +--------+---------+     +-------------------+                  |
    |                 |       |           |                                                      |
    +-----------------+       |    +------+------+------+                                        |
                              |    |             |      |                                        |
                              |    v             v      v                                        |
                              |  +-------+  +-------+  +----------+                             |
                              |  | PgSQL |  | Redis |  | Sui RPC  | (external, verified)        |
                              |  +-------+  +-------+  +----------+                             |
                              |                                                                  |
                              |                        +----------+                             |
                              |                        | OpenAI   | (external API)              |
                              |                        +----------+                             |
                              +------------------------------------------------------------------+
```

### Trust Boundary Definitions

| Boundary ID | From | To | Trust Level | Authentication |
|-------------|------|------|------------|----------------|
| **TB-1** | SDK Client | Rust Server | Untrusted | Ed25519 signature + on-chain verification |
| **TB-2** | Rust Server | TS Sidecar | Fully trusted | **None** (localhost HTTP, no auth) |
| **TB-3** | Rust Server | PostgreSQL | Trusted internal | Connection string (password in DATABASE_URL) |
| **TB-4** | Rust Server | Redis | Trusted internal | Connection string (REDIS_URL) |
| **TB-5** | Rust Server | Sui RPC | External, verified | None (public RPC); responses verified against known object structure |
| **TB-6** | Rust Server | OpenAI API | External | Bearer token (OPENAI_API_KEY) |
| **TB-7** | Public Internet | Sponsor endpoints | **Untrusted, unauthenticated** | **None** |

---

## 3. Data Flow Diagrams

### 3.1 Remember Flow (`POST /api/remember`)

```
Client                    Server (auth.rs)            Server (routes.rs)          Sidecar (:9000)       PostgreSQL
  |                            |                           |                          |                    |
  |-- POST /api/remember ----->|                           |                          |                    |
  |   Headers:                 |                           |                          |                    |
  |    x-public-key            |                           |                          |                    |
  |    x-signature             |  1. Verify Ed25519 sig    |                          |                    |
  |    x-timestamp             |  2. resolve_account()     |                          |                    |
  |    x-delegate-key (PRIV)   |     -> cache/chain/hint   |                          |                    |
  |   Body: {text, namespace}  |  3. Set AuthInfo ext      |                          |                    |
  |                            |                           |                          |                    |
  |                            |---rate_limit_middleware-->|                          |                    |
  |                            |   Check 3 Redis windows   |                          |                    |
  |                            |                           |                          |                    |
  |                            |                           |  4. check_storage_quota   |                    |
  |                            |                           |     -> SUM(blob_size)---->|                    |
  |                            |                           |                          |                    |
  |                            |                           |  5a. generate_embedding   |                    |
  |                            |                           |      -> OpenAI API        |                    |
  |                            |                           |  5b. seal_encrypt ------->| POST /seal/encrypt |
  |                            |                           |      (plaintext, owner)   |                    |
  |                            |                           |                          |                    |
  |                            |                           |  6. upload_blob --------->| POST /walrus/upload|
  |                            |                           |     (encrypted,           | (SUI_PRIVATE_KEY   |
  |                            |                           |      SUI_PRIVATE_KEY!)    |  in body!)         |
  |                            |                           |                          |                    |
  |                            |                           |  7. insert_vector ------->|                    |
  |                            |                           |     (id, owner, ns,       |                    |
  |<-- 200 {id, blob_id} -----|                           |      blob_id, vector,     |                    |
  |                            |                           |      blob_size)           |                    |
```

### 3.2 Recall Flow (`POST /api/recall`)

```
Client                    Server                    Sidecar (:9000)       PostgreSQL        Walrus
  |                          |                          |                    |                |
  |-- POST /api/recall ----->|                          |                    |                |
  |   {query, limit, ns}     |                          |                    |                |
  |   + x-delegate-key       |                          |                    |                |
  |                          |  1. Auth + rate limit     |                    |                |
  |                          |  2. generate_embedding    |                    |                |
  |                          |  3. search_similar ------>|                    |                |
  |                          |     (vector, owner, ns)   |                    |                |
  |                          |     <- [{blob_id, dist}]  |                    |                |
  |                          |                          |                    |                |
  |                          |  4. For each blob_id:    |                    |                |
  |                          |     download_blob ------->|                   |  <- GET blob   |
  |                          |     seal_decrypt -------->| POST /seal/decrypt|                |
  |                          |       (encrypted_data,    | (DELEGATE PRIVATE |                |
  |                          |        DELEGATE_KEY!,     |  KEY in body!)    |                |
  |                          |        package_id,        |                    |                |
  |                          |        account_id)        |                    |                |
  |                          |                          |                    |                |
  |<-- 200 {results: [       |                          |                    |                |
  |      {blob_id, TEXT,     |                          |                    |                |
  |       distance}]}        |                          |                    |                |
```

### 3.3 Analyze Flow (`POST /api/analyze`)

```
Client                    Server                    OpenAI              Sidecar           PostgreSQL
  |                          |                          |                  |                  |
  |-- POST /api/analyze ---->|                          |                  |                  |
  |   {text, namespace}      |  1. Auth + rate limit    |                  |                  |
  |                          |  2. extract_facts_llm -->| POST /chat/...   |                  |
  |                          |     (FULL USER TEXT      |                  |                  |
  |                          |      sent to OpenAI!)    |                  |                  |
  |                          |  <- [fact1, fact2, ...]  |                  |                  |
  |                          |                          |                  |                  |
  |                          |  3. check_storage_quota  |                  |                  |
  |                          |                          |                  |                  |
  |                          |  4. For EACH fact (UNBOUNDED concurrency): |                  |
  |                          |     a. generate_embedding|                  |                  |
  |                          |     b. seal_encrypt ---->|                  |                  |
  |                          |     c. upload_blob ----->|                  |                  |
  |                          |     d. insert_vector --->|                  |                  |
  |                          |                          |                  |                  |
  |<-- 200 {facts: [...]}   |                          |                  |                  |
```

### 3.4 Sponsor Flow (`POST /sponsor`, `POST /sponsor/execute`)

```
ANY CLIENT (no auth)      Server                    Sidecar (:9000)
  |                          |                          |
  |-- POST /sponsor -------->|                          |
  |   (arbitrary JSON body)  |  No auth check!          |
  |                          |  No rate limit!           |
  |                          |  No body validation!      |
  |                          |                          |
  |                          |-- POST /sponsor -------->|
  |                          |   (raw body forwarded)   | -> Enoki API
  |                          |                          |    (uses server's
  |                          |                          |     gas budget)
  |<-- proxied response -----|<-- response -------------|
```

### 3.5 Ask Flow (`POST /api/ask`)

```
Client                    Server                    OpenAI              Sidecar/Walrus
  |                          |                          |                  |
  |-- POST /api/ask -------->|                          |                  |
  |   {question, limit, ns}  |  1. Auth + rate limit    |                  |
  |                          |  2. Embed question        |                  |
  |                          |  3. Search DB -> blob_ids |                  |
  |                          |  4. Download + decrypt    |                  |
  |                          |     (all blobs concurrent)|                  |
  |                          |                          |                  |
  |                          |  5. Build system prompt   |                  |
  |                          |     with DECRYPTED        |                  |
  |                          |     MEMORIES (plaintext   |                  |
  |                          |     sent to OpenAI!)      |                  |
  |                          |                          |                  |
  |                          |  6. Chat completion ----->| (memories in     |
  |                          |                          |  system prompt)  |
  |                          |                          |                  |
  |<-- 200 {answer,          |                          |                  |
  |     memories_used,       |                          |                  |
  |     memories: [TEXT]}    |                          |                  |
```

### 3.6 Restore Flow (`POST /api/restore`)

```
Client                    Server                    Sidecar           Walrus           PostgreSQL
  |                          |                          |                |                |
  |-- POST /api/restore ---->|                          |                |                |
  |   {namespace, limit}     |  1. Auth + rate limit    |                |                |
  |                          |  2. query_blobs_by_owner->| query chain    |                |
  |                          |     <- [blob_ids]        |                |                |
  |                          |  3. get_blobs_by_ns ---->|                |                |
  |                          |     <- existing_ids      |                |                |
  |                          |  4. Download missing ---->|                |<-- GET blobs   |
  |                          |  5. Decrypt (3 concurrent)|               |                |
  |                          |     seal_decrypt -------->|               |                |
  |                          |  6. Re-embed (concurrent) |               |                |
  |                          |  7. insert_vector ------->|               |                |
  |<-- 200 {restored, ...}  |                          |                |                |
```

---

## 4. Assets

### 4.1 Cryptographic Material

| Asset | Location | Sensitivity | Code Reference |
|-------|----------|-------------|----------------|
| **Server SUI private keys** | `Config.sui_private_keys` (env vars), sent in HTTP body to sidecar on every upload | CRITICAL -- controls server wallet funds | `types.rs:73-76`, `walrus.rs:79` (`WalrusUploadRequest.private_key`) |
| **Delegate private key** | `x-delegate-key` HTTP header, stored in `AuthInfo.delegate_key`, sent to sidecar for SEAL decrypt | CRITICAL -- grants memory access | `auth.rs:61-64`, `seal.rs:99` (`SealDecryptRequest.private_key`) |
| **OpenAI API key** | `Config.openai_api_key` (env var) | HIGH -- billing implications | `types.rs:68`, `routes.rs:63` |
| **Ed25519 verifying keys** | `x-public-key` header (public, not secret) | LOW | `auth.rs:36-40` |

### 4.2 User Data

| Asset | Location | Sensitivity |
|-------|----------|-------------|
| **Plaintext memories** | In transit: server memory during remember/recall/analyze/ask/restore. Sent to OpenAI for embedding. Sent to sidecar for SEAL encrypt. | HIGH -- the core privacy promise |
| **Decrypted memories in /ask** | Sent to OpenAI in LLM system prompt | HIGH -- leaves trust boundary |
| **User text in /analyze** | Sent to OpenAI for fact extraction | HIGH -- leaves trust boundary |
| **Embedding vectors** | PostgreSQL `vector_entries.embedding` | MEDIUM -- can leak semantic similarity information |
| **Owner addresses** | PostgreSQL, logged | LOW -- public blockchain data |
| **Namespace strings** | PostgreSQL, logged | LOW -- application-layer isolation |

### 4.3 Infrastructure

| Asset | Sensitivity |
|-------|-------------|
| **PostgreSQL database** | HIGH -- contains all vector entries, delegate key cache, account mappings |
| **Redis state** | MEDIUM -- rate limiting counters (loss = rate limits disabled) |
| **Server wallet SUI balance** | HIGH -- pays for Walrus storage, Enoki gas |
| **Sidecar process** | HIGH -- has access to all crypto operations, no auth |

---

## 5. STRIDE Analysis

### TB-1: SDK Client <-> Rust Server

#### S -- Spoofing

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| S-1.1 | **Replay attack within 5-minute window.** The auth middleware accepts any valid signature within a 300-second window (`auth.rs:71`). There is no nonce or request ID tracking, so a captured request can be replayed. | `auth.rs:67-73` | MEDIUM |
| S-1.2 | **Timestamp manipulation.** The `(now - timestamp).abs() > 300` check uses absolute difference, meaning a timestamp 5 minutes in the future is also accepted. An attacker with a slight clock advantage can extend the replay window. | `auth.rs:71` | LOW |
| S-1.3 | **Account ID hint spoofing.** The `x-account-id` header is used as a fallback in Strategy 3 of account resolution. While it is verified on-chain (`auth.rs:199-206`), it allows an attacker to trigger verification against arbitrary account objects, potentially causing DoS via RPC calls. | `auth.rs:195-206` | LOW |

#### T -- Tampering

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| T-1.1 | **Body consumed and re-injected.** The auth middleware reads the entire body (`auth.rs:98`), hashes it, verifies the signature, then reconstructs the request (`auth.rs:134`). The body is included in the signature via SHA-256, so tampering is detected. **Mitigated.** | `auth.rs:98-103` | NONE |
| T-1.2 | **Query string not signed.** The signature covers `{timestamp}.{method}.{path}.{body_sha256}` where `path` is `request.uri().path()` (no query string). If future routes use query parameters, they can be tampered. | `auth.rs:93, 103` | LOW |
| T-1.3 | **No TLS enforcement.** The server binds to `0.0.0.0:{PORT}` without TLS. If deployed without a TLS-terminating reverse proxy, all traffic including `x-delegate-key` (private key!) is in cleartext. | `main.rs:160-161` | HIGH (deployment) |

#### R -- Repudiation

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| R-1.1 | **Insufficient request logging.** Auth failures are logged at `warn` level with reason, but successful requests only log at `debug` level for auth and `info` for route actions. There is no structured audit log with request IDs, client IP, or full auth context. | `auth.rs:109, 113, 123` | MEDIUM |
| R-1.2 | **No request ID tracking.** Individual requests have no correlation ID. If a user denies making a request, there is no way to trace it through the auth -> rate limit -> route -> sidecar -> DB chain. | N/A | MEDIUM |

#### I -- Information Disclosure

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| I-1.1 | **CRITICAL: Delegate private key in HTTP header.** The `x-delegate-key` header carries the raw Ed25519 private key on every request. Any network observer, proxy, CDN, WAF log, or load balancer access log captures this key. The key grants SEAL decrypt access to all user memories. | `auth.rs:61-64`, stored in `AuthInfo.delegate_key` | CRITICAL |
| I-1.2 | **Verbose error responses.** `AppError::Internal(msg)` returns the internal error string to clients (`types.rs:368-369`). This can leak database connection strings, sidecar URLs, RPC errors, etc. | `types.rs:362-377` | MEDIUM |
| I-1.3 | **Plaintext logged in tracing.** The `remember` route logs the first 50 bytes of user text: `truncate_str(text, 50)`. The SEAL module logs byte lengths. While truncated, this leaks partial plaintext to log aggregation systems. | `routes.rs:136` | LOW |
| I-1.4 | **AuthInfo has `Debug` derive.** If `AuthInfo` is ever debug-printed (e.g., in error paths), the delegate private key is included in logs. | `types.rs:317` (struct has `Debug` but note it's manually defined, not derived -- however the `delegate_key: Option<String>` field would print) | LOW |
| I-1.5 | **CORS is fully permissive.** `CorsLayer::permissive()` allows any origin to make requests. Combined with the lack of CSRF protection, a malicious website can make authenticated requests if the user's browser has credentials. | `main.rs:156` | MEDIUM |

#### D -- Denial of Service

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| D-1.1 | **Rate limiter fails open.** All three rate limit check layers (`check_window`) catch Redis errors and log them, but then **allow the request to proceed** (`rate_limit.rs:241-242`, `260-261`, `279-280`). If Redis goes down, all rate limiting is disabled. | `rate_limit.rs:229-243, 248-262, 267-281` | HIGH |
| D-1.2 | **1MB body limit is the only body size control.** `axum::body::to_bytes(body, 1024 * 1024)` in auth middleware caps request bodies at 1MB. This is reasonable but an attacker can still send many 1MB requests. | `auth.rs:98` | LOW |
| D-1.3 | **On-chain registry scan is unbounded.** `find_account_by_delegate_key()` in `sui.rs:115-273` paginates through ALL accounts in the registry (50 per page) and fetches each one individually. An attacker with a valid signature but unknown account triggers a full scan on every request. | `sui.rs:154-269` | MEDIUM |
| D-1.4 | **No timeout on Sui RPC calls.** The `http_client` used for Sui RPC has no per-request timeout configured. A slow or unresponsive Sui RPC can hang the auth middleware indefinitely, blocking the request handler thread. | `sui.rs:27-31` | MEDIUM |

#### E -- Elevation of Privilege

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| E-1.1 | **Deactivated accounts still authenticate.** The auth middleware verifies the delegate key exists in the on-chain `MemWalAccount` object but does NOT check the `active` field. A deactivated account can still access all API endpoints except SEAL operations (which check on-chain). | `sui.rs:59-98` (no `active` field check), `auth.rs:116` | MEDIUM |
| E-1.2 | **Config fallback account.** If `MEMWAL_ACCOUNT_ID` is set, any delegate key that fails cache + registry resolution is verified against this single fallback account. If the fallback account has broad delegate keys, this widens the attack surface. | `auth.rs:195-206`, `types.rs:104` | LOW |

---

### TB-2: Rust Server <-> TypeScript Sidecar

#### S -- Spoofing

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| S-2.1 | **No authentication on sidecar.** The sidecar has zero authentication. Any process on the same host (or network if the sidecar binds to 0.0.0.0) can call `/seal/encrypt`, `/seal/decrypt`, `/walrus/upload`, `/sponsor`, etc. | `main.rs:46` (sidecar_url), `seal.rs:47`, `walrus.rs:74` | HIGH |
| S-2.2 | **Sidecar URL from environment.** `SIDECAR_URL` can be overridden. If an attacker controls this env var, they can redirect all crypto operations to a malicious server that captures plaintext and private keys. | `types.rs:130-131` | MEDIUM |

#### T -- Tampering

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| T-2.1 | **Server private keys sent in HTTP body.** Every Walrus upload sends `sui_private_key` in the JSON body to the sidecar (`walrus.rs:79`, `WalrusUploadRequest.private_key`). If the sidecar is compromised or the connection is intercepted, the server wallet is fully compromised. | `walrus.rs:64-98` | HIGH |
| T-2.2 | **Delegate private keys sent in HTTP body.** Every SEAL decrypt sends the user's delegate private key in the JSON body to the sidecar (`seal.rs:99`, `SealDecryptRequest.private_key`). | `seal.rs:95-116` | HIGH |
| T-2.3 | **No response integrity verification.** The server trusts sidecar responses completely. A compromised sidecar could return fake encrypted data (causing data loss), fake decrypted data (privacy violation), or fake blob IDs. | `seal.rs:71-76`, `walrus.rs:101-116` | HIGH |

#### R -- Repudiation

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| R-2.1 | **Sidecar operations not audit-logged on server side.** The server logs success/failure of sidecar calls at `info`/`warn` level but there is no structured audit trail linking sidecar operations to authenticated user requests. | `seal.rs:79-83`, `walrus.rs:105-111` | LOW |

#### I -- Information Disclosure

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| I-2.1 | **Plaintext sent to sidecar for encryption.** The full plaintext memory is sent to the sidecar in base64 over localhost HTTP for SEAL encryption. If the sidecar process is compromised, all memories being encrypted are exposed. | `seal.rs:40-86` | HIGH |
| I-2.2 | **Server SUI private keys exposed to sidecar.** The sidecar receives server wallet private keys on every Walrus upload. The sidecar could exfiltrate these keys. | `walrus.rs:79` | HIGH |

#### D -- Denial of Service

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| D-2.1 | **Sidecar crash takes down all operations.** If the sidecar process crashes, all encrypt, decrypt, upload, and sponsor operations fail. The server does not restart the sidecar automatically (it only checks health at startup, `main.rs:64-78`). | `main.rs:52-82` | MEDIUM |
| D-2.2 | **No request timeout to sidecar.** The `reqwest::Client` used for sidecar calls has no per-request timeout. A hung sidecar blocks server handler threads. | `seal.rs:50-61`, `walrus.rs:77-91` | MEDIUM |

#### E -- Elevation of Privilege

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| E-2.1 | **Sidecar has full crypto authority.** The sidecar can encrypt data for any owner, decrypt any blob, upload to any address, and execute sponsor transactions. A compromised sidecar has complete control over the system. | All of `seal.rs`, `walrus.rs` | HIGH |

---

### TB-3: Rust Server <-> PostgreSQL

#### S -- Spoofing

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| S-3.1 | **Database authentication via connection string.** The `DATABASE_URL` env var contains credentials. If leaked (e.g., via error messages or logs), an attacker gains direct DB access. | `types.rs:100-101` | MEDIUM |

#### T -- Tampering

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| T-3.1 | **SQL injection: fully mitigated.** All queries use parameterized `sqlx::query` with `$1`, `$2`, etc. Zero dynamic SQL construction. | `db.rs` (all methods) | NONE |
| T-3.2 | **Delegate key cache poisoning.** The `cache_delegate_key` method uses `ON CONFLICT DO UPDATE` (`db.rs:192-197`). If an attacker can somehow insert a row first, the cache could map a delegate key to the wrong account. However, the cache is only written after on-chain verification, so this requires compromising the verification. | `db.rs:186-207` | LOW |

#### R -- Repudiation

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| R-3.1 | **No DB-level audit trail.** Vector insertions and deletions are logged via tracing but not stored in a database audit table. The `cached_at` timestamp in `delegate_key_cache` is the only temporal record. | `db.rs:70, 159` | LOW |

#### I -- Information Disclosure

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| I-3.1 | **Embedding vectors reveal semantic information.** While the actual plaintext is encrypted and stored on Walrus, the embedding vectors in PostgreSQL encode semantic meaning. An attacker with DB read access can perform similarity searches to infer content themes without decrypting blobs. | `db.rs:76-106` | MEDIUM |
| I-3.2 | **Owner-namespace data isolation depends on query correctness.** All queries filter by `owner` and `namespace`, but there is no row-level security (RLS) in PostgreSQL. A SQL injection (which is mitigated) or direct DB access bypasses all isolation. | `db.rs:86-91` | LOW |

#### D -- Denial of Service

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| D-3.1 | **Connection pool exhaustion.** Max 10 connections (`db.rs:14`). If the sidecar or external APIs are slow, all 10 connections could be held by in-flight requests, blocking new requests. | `db.rs:14` | LOW |

#### E -- Elevation of Privilege

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| E-3.1 | **No row-level security.** Database permissions rely entirely on the application layer. The database user specified in `DATABASE_URL` has full access to all tables. | N/A | LOW |

---

### TB-4: Rust Server <-> Redis

#### S -- Spoofing

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| S-4.1 | **Redis authentication via URL.** If `REDIS_URL` has no password, anyone with network access to Redis can manipulate rate limit counters. | `rate_limit.rs:77-79` | MEDIUM |

#### T -- Tampering

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| T-4.1 | **Rate limit key predictability.** Redis keys follow predictable patterns: `rate:dk:{public_key}`, `rate:{owner}`, `rate:hr:{owner}`. An attacker with Redis access can delete keys to reset rate limits or add entries to block legitimate users. | `rate_limit.rs:227, 246, 265` | MEDIUM |
| T-4.2 | **TOCTOU race in rate limiting.** The check (`check_window`) and record (`record_in_window`) are not atomic. Between the check and record, other requests from the same user can slip through, exceeding the intended limit. | `rate_limit.rs:229-286` | MEDIUM |

#### D -- Denial of Service

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| D-4.1 | **Rate limiter fails open on Redis errors.** As noted in D-1.1, all three layers log errors but allow requests through. An attacker who can cause Redis to become unavailable (e.g., memory exhaustion, connection flood) disables all rate limiting. | `rate_limit.rs:241, 260, 279` | HIGH |
| D-4.2 | **Record failures also fail open.** The `record_in_window` function logs a warning but does not propagate errors (`rate_limit.rs:158-160`). If recording fails, the request counter is not incremented, allowing unlimited subsequent requests. | `rate_limit.rs:143-161` | MEDIUM |

---

### TB-5: Rust Server <-> Sui RPC

#### S -- Spoofing

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| S-5.1 | **No RPC endpoint authentication.** The server trusts the Sui RPC response at face value. If `SUI_RPC_URL` is pointed at a malicious endpoint, the attacker controls account resolution, potentially authenticating arbitrary keys. | `types.rs:102-103`, `sui.rs` | HIGH (if env compromised) |

#### T -- Tampering

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| T-5.1 | **RPC response parsing trusts structure.** The `sui.rs` module parses JSON-RPC responses and trusts the structure (fields, types). A malicious or compromised RPC could return crafted responses. However, the response is cross-checked (delegate key must match), limiting impact. | `sui.rs:46-98` | LOW |

#### D -- Denial of Service

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| D-5.1 | **Sui RPC unavailability blocks authentication.** If the Sui RPC is down, all cache misses fail authentication. Even cached accounts are re-verified on-chain (`auth.rs:156-163`), so a stale cache entry with a down RPC blocks that user too. | `auth.rs:152-172` | HIGH |
| D-5.2 | **Registry scan amplifies RPC load.** A single request with an unknown delegate key triggers potentially hundreds of RPC calls (50 dynamic fields per page, each requiring a follow-up fetch, then an account fetch). An attacker with valid signatures but no registered account triggers maximum scan cost. | `sui.rs:154-269` | MEDIUM |

---

### TB-6: Rust Server <-> OpenAI API

#### S -- Spoofing

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| S-6.1 | **API base URL from environment.** `OPENAI_API_BASE` can point to any OpenAI-compatible endpoint. If compromised, all user text and LLM prompts go to an attacker-controlled server. | `types.rs:106-107` | HIGH (if env compromised) |

#### T -- Tampering

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| T-6.1 | **LLM prompt injection in analyze.** User-supplied text is inserted directly into the LLM prompt for fact extraction (`routes.rs:559-560`). A crafted input could manipulate the LLM to return attacker-controlled "facts" that are then stored as memories. | `routes.rs:537-599` | MEDIUM |
| T-6.2 | **LLM prompt injection in ask.** Decrypted memories are injected into the system prompt. If a stored memory contains adversarial text, it can manipulate the LLM response. | `routes.rs:696-708` | MEDIUM |

#### I -- Information Disclosure

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| I-6.1 | **Plaintext memories sent to OpenAI.** The `/api/remember` flow sends plaintext to OpenAI for embedding. The `/api/analyze` flow sends full user text for fact extraction. The `/api/ask` flow sends decrypted memories in the system prompt. This contradicts the "privacy-first" promise -- OpenAI sees all plaintext. | `routes.rs:59-110` (embedding), `routes.rs:537-599` (facts), `routes.rs:704-708` (ask prompt) | HIGH |
| I-6.2 | **OpenAI API key in Bearer header.** Standard practice, but the key is sent on every request. If the OpenAI endpoint is compromised, the key is captured. | `routes.rs:63` | LOW |

#### D -- Denial of Service

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| D-6.1 | **No timeout on OpenAI API calls.** Neither embedding nor LLM completion requests have explicit timeouts. A slow OpenAI API blocks server handler threads. | `routes.rs:59-110`, `routes.rs:547-580` | MEDIUM |
| D-6.2 | **Cost amplification via analyze.** The LLM can return an unbounded number of "facts" from a single `/api/analyze` request. Each fact triggers an embedding call + SEAL encrypt + Walrus upload. A crafted input designed to maximize fact extraction amplifies cost and resource usage. | `routes.rs:421-462` | HIGH |

---

### TB-7: Public Internet <-> Sponsor Endpoints

#### S -- Spoofing

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| S-7.1 | **No authentication on sponsor endpoints.** `/sponsor` and `/sponsor/execute` accept any request from any source. An attacker can submit arbitrary transaction sponsorship requests. | `main.rs:147-150`, `routes.rs:1011-1060` | HIGH |

#### T -- Tampering

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| T-7.1 | **Raw body forwarding.** The sponsor proxy forwards the request body directly to the sidecar with no validation or sanitization. The sidecar then forwards to Enoki. An attacker can send any JSON payload. | `routes.rs:1018-1019` | HIGH |

#### D -- Denial of Service

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| D-7.1 | **No rate limiting on sponsor endpoints.** The sponsor routes are outside the `protected_routes` group and have no rate limiting middleware. An attacker can flood these endpoints to drain the server's Enoki gas budget. | `main.rs:147-150` | HIGH |

#### E -- Elevation of Privilege

| ID | Threat | Code Reference | Risk |
|----|--------|---------------|------|
| E-7.1 | **Gas budget drain.** By submitting many sponsor requests, an attacker can exhaust the server's gas budget, preventing legitimate users from creating accounts via sponsored transactions. | `routes.rs:1011-1060` | HIGH |

---

## 6. Attack Scenarios

### Scenario 1: Private Key Exfiltration via Network Interception

**Target:** User's delegate private key (CRITICAL)
**Threat IDs:** I-1.1, T-1.3

**Steps:**
1. Attacker positions themselves on the network path between SDK client and server (e.g., compromised WiFi, ISP-level, CDN/proxy).
2. Client sends any authenticated request (e.g., `/api/recall`).
3. Attacker captures the `x-delegate-key` HTTP header containing the raw Ed25519 private key.
4. Attacker now possesses the delegate private key and can:
   a. Sign requests as the victim (spoofing).
   b. SEAL-decrypt all of the victim's memories.
   c. The key cannot be rotated without on-chain transaction + re-encryption of all data.

**Likelihood:** MEDIUM (requires MITM, but no TLS enforcement in server)
**Impact:** CRITICAL (full memory access, irreversible without re-encryption)
**Risk:** CRITICAL

---

### Scenario 2: Rate Limit Bypass via Redis Disruption

**Target:** Service availability, cost amplification
**Threat IDs:** D-1.1, D-4.1, D-4.2

**Steps:**
1. Attacker identifies that rate limiting depends on Redis.
2. Attacker floods Redis with connections or memory-consuming commands (if Redis is network-accessible, per S-4.1).
3. Redis becomes unavailable or starts returning errors.
4. All three rate limit layers catch errors and **allow requests through** (`rate_limit.rs:241, 260, 279`).
5. Attacker now has unlimited access to:
   - `/api/analyze` (cost weight 10, triggers LLM + N Walrus uploads)
   - `/api/remember` (cost weight 5, triggers embedding + encrypt + upload)
6. Each request consumes: OpenAI API credits, Walrus storage fees, SEAL key server resources.
7. Server wallet SUI balance is drained via Walrus uploads.

**Likelihood:** MEDIUM (requires Redis access or ability to cause OOM)
**Impact:** HIGH (financial loss, service degradation)
**Risk:** HIGH

---

### Scenario 3: Gas Budget Drain via Unauthenticated Sponsor Endpoints

**Target:** Server Enoki gas budget
**Threat IDs:** S-7.1, D-7.1, E-7.1

**Steps:**
1. Attacker discovers `/sponsor` and `/sponsor/execute` are public (no auth, no rate limit).
2. Attacker writes a script that sends rapid POST requests to `/sponsor` with valid Enoki-format JSON.
3. Each request is proxied directly to the sidecar, which forwards to Enoki.
4. Enoki sponsors transactions using the server's gas budget.
5. After thousands of requests, the gas budget is exhausted.
6. Legitimate users can no longer create MemWal accounts (account creation requires sponsored transactions).

**Likelihood:** HIGH (trivially exploitable, no auth required)
**Impact:** MEDIUM (service degradation, financial loss)
**Risk:** HIGH

---

### Scenario 4: Cost Amplification via Analyze Endpoint

**Target:** OpenAI API credits, Walrus storage budget, server resources
**Threat IDs:** D-6.2, T-6.1

**Steps:**
1. Attacker crafts input text designed to maximize fact extraction:
   ```
   User likes cats. User likes dogs. User likes birds. User likes fish.
   [... 200 similar lines ...]
   ```
2. Attacker sends `POST /api/analyze` with this text.
3. LLM extracts N facts (no cap in code -- `routes.rs:593-598` collects all non-empty lines).
4. For each fact, the server concurrently (`routes.rs:421-462`):
   - Calls OpenAI embedding API (cost: ~$0.00002 per call)
   - Calls sidecar SEAL encrypt
   - Calls sidecar Walrus upload (cost: SUI gas + storage fees)
   - Inserts into PostgreSQL
5. A single request with 200 facts triggers 200 concurrent embedding calls, 200 SEAL encrypts, 200 Walrus uploads.
6. Rate limit weight is only 10 for `/api/analyze` regardless of fact count.
7. At 60 req/min burst limit, attacker achieves 60 * 200 = 12,000 Walrus uploads/minute.

**Likelihood:** HIGH (requires only valid auth)
**Impact:** HIGH (massive cost amplification, potential wallet drain)
**Risk:** HIGH

---

### Scenario 5: Replay Attack for Unauthorized Data Access

**Target:** User memories (confidentiality)
**Threat IDs:** S-1.1

**Steps:**
1. Attacker captures a legitimate `/api/recall` request (e.g., from shared log, network tap, or browser devtools).
2. The captured request includes valid `x-public-key`, `x-signature`, `x-timestamp`, `x-delegate-key`, and body.
3. Within 5 minutes of the original timestamp (`auth.rs:71`), attacker replays the exact request.
4. The server accepts it because:
   - Signature is valid for the given timestamp + method + path + body hash
   - Timestamp is within the 5-minute window
   - No nonce or replay tracking exists
5. Attacker receives all matching decrypted memories.
6. If the attacker also has the delegate private key (from I-1.1), they can modify the body, re-sign, and make arbitrary requests.

**Likelihood:** MEDIUM (requires capture of a request with delegate key)
**Impact:** HIGH (unauthorized memory access)
**Risk:** HIGH

---

### Scenario 6: Sidecar Compromise Leading to Full System Takeover

**Target:** All cryptographic operations
**Threat IDs:** S-2.1, T-2.1, T-2.2, T-2.3, E-2.1

**Steps:**
1. Attacker gains code execution on the server host (e.g., via unrelated vulnerability, supply chain attack on npm dependency used by sidecar).
2. Attacker connects to `localhost:9000` (sidecar) with no authentication required.
3. Attacker calls:
   - `POST /seal/decrypt` with any encrypted blob and a captured delegate key to decrypt memories
   - `POST /walrus/upload` to upload arbitrary data at the server's expense
   - `POST /sponsor` to drain the gas budget
4. Since the sidecar has no authentication, all calls succeed.
5. Attacker can also intercept normal server-to-sidecar traffic to capture:
   - All plaintext being encrypted
   - All server SUI private keys (sent per-upload in `WalrusUploadRequest.private_key`)
   - All delegate private keys (sent per-decrypt in `SealDecryptRequest.private_key`)

**Likelihood:** LOW (requires host-level access)
**Impact:** CRITICAL (complete system compromise)
**Risk:** HIGH

---

### Scenario 7: Memory Exposure via OpenAI Data Flow

**Target:** User privacy (plaintext memories)
**Threat IDs:** I-6.1

**Steps:**
1. User stores sensitive memories via `/api/remember` (e.g., medical conditions, financial data).
2. Server sends plaintext to OpenAI for embedding generation (`routes.rs:59-110`).
3. User asks a question via `/api/ask`.
4. Server recalls and decrypts relevant memories, then sends them in cleartext in the LLM system prompt to OpenAI (`routes.rs:704-708`).
5. OpenAI receives the user's decrypted private memories in plaintext.
6. This violates the "end-to-end encrypted" and "privacy-first" marketing promise.
7. If OpenAI is compromised, has a data breach, or retains training data, user memories are exposed.

**Likelihood:** HIGH (happens on every normal request)
**Impact:** HIGH (privacy violation is by design, not a bug)
**Risk:** HIGH (architectural concern)

---

## 7. Threat Matrix

| ID | Threat | Boundary | Category | Likelihood | Impact | Risk | Status |
|----|--------|----------|----------|------------|--------|------|--------|
| **I-1.1** | Delegate private key in HTTP header | TB-1 | Info Disclosure | MEDIUM | CRITICAL | **CRITICAL** | Open |
| **D-1.1** | Rate limiter fails open on Redis error | TB-1/TB-4 | DoS | MEDIUM | HIGH | **HIGH** | Open |
| **S-7.1** | Unauthenticated sponsor endpoints | TB-7 | Spoofing | HIGH | MEDIUM | **HIGH** | Open |
| **D-7.1** | No rate limiting on sponsor endpoints | TB-7 | DoS | HIGH | MEDIUM | **HIGH** | Open |
| **E-7.1** | Gas budget drain via sponsor | TB-7 | EoP | HIGH | MEDIUM | **HIGH** | Open |
| **D-6.2** | Cost amplification via unbounded analyze facts | TB-6 | DoS | HIGH | HIGH | **HIGH** | Open |
| **S-2.1** | No authentication on sidecar | TB-2 | Spoofing | LOW | CRITICAL | **HIGH** | Open |
| **T-2.1** | Server private keys sent to sidecar per-request | TB-2 | Tampering | LOW | CRITICAL | **HIGH** | Open |
| **T-2.2** | Delegate private keys sent to sidecar | TB-2 | Tampering | LOW | CRITICAL | **HIGH** | Open |
| **T-2.3** | No sidecar response integrity verification | TB-2 | Tampering | LOW | HIGH | **HIGH** | Open |
| **E-2.1** | Sidecar has full crypto authority | TB-2 | EoP | LOW | CRITICAL | **HIGH** | Open |
| **I-2.1** | Plaintext sent to sidecar for encryption | TB-2 | Info Disclosure | LOW | HIGH | **HIGH** | Open |
| **I-2.2** | Server SUI private keys exposed to sidecar | TB-2 | Info Disclosure | LOW | HIGH | **HIGH** | Open |
| **I-6.1** | Plaintext memories sent to OpenAI | TB-6 | Info Disclosure | HIGH | HIGH | **HIGH** | Architectural |
| **D-5.1** | Sui RPC unavailability blocks auth | TB-5 | DoS | MEDIUM | HIGH | **HIGH** | Open |
| **S-1.1** | Replay attack within 5-minute window | TB-1 | Spoofing | MEDIUM | HIGH | **HIGH** | Open |
| **T-7.1** | Raw body forwarding to sponsor proxy | TB-7 | Tampering | HIGH | LOW | **MEDIUM** | Open |
| **T-4.2** | TOCTOU race in rate limiting | TB-4 | Tampering | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **D-4.2** | Record failures fail open | TB-4 | DoS | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **E-1.1** | Deactivated accounts still authenticate | TB-1 | EoP | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **I-1.2** | Verbose error responses leak internals | TB-1 | Info Disclosure | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **I-1.5** | CORS fully permissive | TB-1 | Info Disclosure | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **I-3.1** | Embedding vectors reveal semantic info | TB-3 | Info Disclosure | LOW | MEDIUM | **MEDIUM** | Open |
| **T-6.1** | LLM prompt injection in analyze | TB-6 | Tampering | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **T-6.2** | LLM prompt injection in ask | TB-6 | Tampering | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **D-1.3** | Unbounded on-chain registry scan | TB-1 | DoS | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **D-1.4** | No timeout on Sui RPC calls | TB-1 | DoS | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **D-2.1** | Sidecar crash takes down operations | TB-2 | DoS | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **D-2.2** | No request timeout to sidecar | TB-2 | DoS | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **D-5.2** | Registry scan amplifies RPC load | TB-5 | DoS | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **D-6.1** | No timeout on OpenAI API calls | TB-6 | DoS | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **R-1.1** | Insufficient request logging | TB-1 | Repudiation | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **R-1.2** | No request ID tracking | TB-1 | Repudiation | MEDIUM | MEDIUM | **MEDIUM** | Open |
| **S-2.2** | Sidecar URL from environment | TB-2 | Spoofing | LOW | HIGH | **MEDIUM** | Open |
| **S-3.1** | DB auth via connection string | TB-3 | Spoofing | LOW | HIGH | **MEDIUM** | Open |
| **S-4.1** | Redis auth via URL | TB-4 | Spoofing | LOW | MEDIUM | **MEDIUM** | Open |
| **T-4.1** | Rate limit key predictability | TB-4 | Tampering | LOW | MEDIUM | **MEDIUM** | Open |
| **T-1.3** | No TLS enforcement | TB-1 | Tampering | LOW | HIGH | **MEDIUM** | Deployment |
| **T-1.2** | Query string not signed | TB-1 | Tampering | LOW | LOW | **LOW** | Open |
| **S-1.2** | Timestamp manipulation | TB-1 | Spoofing | LOW | LOW | **LOW** | Open |
| **S-1.3** | Account ID hint DoS | TB-1 | Spoofing | LOW | LOW | **LOW** | Open |
| **I-1.3** | Plaintext truncated in logs | TB-1 | Info Disclosure | LOW | LOW | **LOW** | Open |
| **I-1.4** | AuthInfo Debug may leak key | TB-1 | Info Disclosure | LOW | LOW | **LOW** | Open |
| **I-6.2** | OpenAI API key in Bearer header | TB-6 | Info Disclosure | LOW | LOW | **LOW** | Open |
| **E-1.2** | Config fallback account | TB-1 | EoP | LOW | LOW | **LOW** | Open |
| **T-3.2** | Delegate key cache poisoning | TB-3 | Tampering | LOW | LOW | **LOW** | Open |
| **T-5.1** | RPC response parsing trusts structure | TB-5 | Tampering | LOW | LOW | **LOW** | Open |
| **I-3.2** | Data isolation depends on query correctness | TB-3 | Info Disclosure | LOW | LOW | **LOW** | Open |
| **R-2.1** | Sidecar operations not audit-logged | TB-2 | Repudiation | LOW | LOW | **LOW** | Open |
| **R-3.1** | No DB-level audit trail | TB-3 | Repudiation | LOW | LOW | **LOW** | Open |
| **D-1.2** | 1MB body limit only control | TB-1 | DoS | LOW | LOW | **LOW** | Open |
| **D-3.1** | Connection pool exhaustion | TB-3 | DoS | LOW | LOW | **LOW** | Open |
| **E-3.1** | No row-level security in PostgreSQL | TB-3 | EoP | LOW | LOW | **LOW** | Open |
| **T-3.1** | SQL injection | TB-3 | Tampering | NONE | N/A | **NONE** | Mitigated |
| **T-1.1** | Body tampering | TB-1 | Tampering | NONE | N/A | **NONE** | Mitigated |

---

### Risk Summary

| Risk Level | Count | Key Concerns |
|------------|-------|-------------|
| **CRITICAL** | 1 | Delegate private key in HTTP headers |
| **HIGH** | 15 | Rate limiter fails open, unauthenticated sponsors, sidecar trust, plaintext to OpenAI, replay attacks, cost amplification |
| **MEDIUM** | 21 | TOCTOU races, deactivated accounts, verbose errors, permissive CORS, prompt injection, missing timeouts |
| **LOW** | 15 | Query string signing, cache poisoning, logging gaps, config fallback |
| **NONE (Mitigated)** | 2 | SQL injection, body tampering |
| **Total** | **54** | |
