# MemWal TypeScript SDK -- STRIDE Threat Model

**Date:** 2026-04-02
**Scope:** TypeScript SDK (`packages/sdk/src/`) -- MemWal (server-assisted) and MemWalManual (client-side crypto)
**Commit:** 5bb1669
**Inputs:** Source code review, security code review (`security-review/05-sdk-client.md`), project CLAUDE.md

---

## 1. Service Overview

The MemWal SDK provides two distinct client classes for storing and retrieving end-to-end encrypted "memories" on Walrus decentralized storage with semantic vector search.

### 1.1 MemWal (Server-Assisted Mode)

**File:** `packages/sdk/src/memwal.ts`

The `MemWal` class is a thin HTTP client. It signs requests with an Ed25519 delegate key and sends plaintext to the server. The server performs all heavy operations: embedding via OpenAI, SEAL encryption via a TypeScript sidecar, Walrus upload, and pgvector storage.

**What it exposes:**
- Ed25519 delegate private key (sent in `x-delegate-key` header on every request, line 314)
- Ed25519 public key (sent in `x-public-key` header)
- Plaintext memory text (sent in POST body)
- Plaintext search queries (sent in POST body)
- Account ID (sent in `x-account-id` header)

**What it connects to:**
- MemWal Rust server (single endpoint, all operations)

### 1.2 MemWalManual (Client-Side Crypto Mode)

**File:** `packages/sdk/src/manual.ts`

The `MemWalManual` class performs SEAL encryption, OpenAI embedding, and Walrus upload/download on the client side. It only contacts the MemWal server for vector index registration and search. Decryption uses SEAL key servers directly.

**What it exposes:**
- Ed25519 delegate private key (held in memory only, never transmitted -- line 543-554 shows no `x-delegate-key` header)
- Sui private key or wallet signer (for SEAL operations and Walrus uploads)
- OpenAI API key (sent to embedding endpoint)
- Plaintext memory text (sent to OpenAI for embedding; encrypted before leaving client for storage)
- SEAL session keys (created per recall session, 30-minute TTL)

**What it connects to:**
- MemWal Rust server (vector registration and search only)
- OpenAI/OpenRouter API (embedding generation)
- SEAL key servers (encryption/decryption key material)
- Walrus publisher/aggregator (blob upload/download)
- Sui RPC (transaction signing, on-chain state)

---

## 2. Trust Boundaries

### TB-1: Application <-> SDK

| Property | Detail |
|----------|--------|
| **Direction** | Application passes secrets (private keys, API keys) to SDK via config |
| **Trust level** | SDK trusts application completely; application must trust SDK with key material |
| **Protocol** | In-process JavaScript function calls |
| **Key concern** | Keys passed as immutable JS strings (`types.ts:13,127`) cannot be zeroed from memory |

### TB-2: SDK <-> MemWal Server

| Property | Detail |
|----------|--------|
| **Direction** | SDK sends signed HTTP requests; server returns JSON responses |
| **Trust level** | Authenticated via Ed25519 signatures. MemWal mode: server receives plaintext + private key. Manual mode: server receives only vectors + encrypted blobs |
| **Protocol** | HTTP (default `http://localhost:8000`, `memwal.ts:72`, `manual.ts:82`). No HTTPS enforcement |
| **Key concern** | MemWal class sends delegate private key in every request (`memwal.ts:314`). Default URL is plaintext HTTP |

### TB-3: SDK <-> SEAL Key Servers (MemWalManual only)

| Property | Detail |
|----------|--------|
| **Direction** | SDK requests encryption/decryption key shares from SEAL threshold servers |
| **Trust level** | Should be cryptographically verified but `verifyKeyServers: false` (`manual.ts:200`) |
| **Protocol** | HTTPS to on-chain-registered SEAL server endpoints |
| **Key concern** | Disabled verification allows rogue key server substitution. Threshold is hardcoded to 1 (`manual.ts:454`) |

### TB-4: SDK <-> Walrus (MemWalManual only)

| Property | Detail |
|----------|--------|
| **Direction** | SDK uploads encrypted blobs to publisher, downloads from aggregator |
| **Trust level** | Walrus is external decentralized storage. Data is already SEAL-encrypted before upload |
| **Protocol** | HTTPS to publisher/aggregator endpoints (`manual.ts:468-515`) |
| **Key concern** | Publisher/aggregator URLs can be overridden via config. No integrity check on downloaded blobs beyond SEAL decryption |

### TB-5: SDK <-> OpenAI/OpenRouter (MemWalManual only)

| Property | Detail |
|----------|--------|
| **Direction** | SDK sends plaintext to embedding API, receives vector |
| **Trust level** | External third party. Receives unencrypted memory content |
| **Protocol** | HTTPS with Bearer token auth (`manual.ts:425-429`) |
| **Key concern** | Plaintext memories are exposed to the embedding provider. API key sent in Authorization header |

### TB-6: SDK <-> Sui RPC (MemWalManual + Account Management)

| Property | Detail |
|----------|--------|
| **Direction** | SDK submits transactions, reads on-chain state |
| **Trust level** | External RPC node. Transaction validity enforced by Sui consensus |
| **Protocol** | HTTPS to fullnode endpoints (`manual.ts:134-139`, `account.ts:89-93`) |
| **Key concern** | RPC node could censor or delay transactions. Default public endpoints may be rate-limited |

---

## 3. Data Flow Diagrams

### 3.1 MemWal.remember() -- Server-Assisted Mode

```
+-------------------+                        +------------------+
|   Application     |                        |  MemWal Server   |
|                   |                        |  (Rust + Sidecar)|
+--------+----------+                        +--------+---------+
         |                                            |
         | 1. memwal.remember("allergic to peanuts")  |
         |                                            |
         v                                            |
+--------+----------+                                 |
|  MemWal SDK       |                                 |
|  (memwal.ts)      |                                 |
|                   |                                 |
| 2. Sign request:  |                                 |
|    sha256(ts.POST.|                                 |
|    /api/remember. |                                 |
|    body_hash)     |                                 |
|                   |                                 |
| 3. HTTP POST -----|----[PLAINTEXT OVER HTTP]------->|
|    Headers:       |    x-delegate-key: PRIVATE_KEY  |
|                   |    x-public-key: PUB_KEY        |
|                   |    x-signature: SIG             |
|                   |    x-timestamp: TS              |
|                   |    x-account-id: ACCT_ID        |
|    Body:          |    {"text":"allergic..."}        |
|                   |                                 |
|                   |                        4. Verify signature
|                   |                        5. Resolve account on-chain
|                   |                        6. Embed via OpenAI
|                   |                        7. SEAL encrypt via sidecar
|                   |                        8. Upload to Walrus
|                   |                        9. Store vector in pgvector
|                   |                                 |
|                   |<-------- 200 OK ----------------|
|                   |    {"id":"...","blob_id":"..."}  |
+-------------------+                        +------------------+

TRUST MODEL: Server sees plaintext + private key. Full trust required.
```

### 3.2 MemWal.recall() -- Server-Assisted Mode

```
+-------------------+                        +------------------+
|  MemWal SDK       |                        |  MemWal Server   |
+--------+----------+                        +--------+---------+
         |                                            |
         | 1. Signed POST /api/recall                 |
         |    Headers: x-delegate-key: PRIVATE_KEY    |
         |    Body: {"query":"food allergies"}         |
         |------------------------------------------->|
         |                                   2. Verify sig
         |                                   3. Embed query (OpenAI)
         |                                   4. Vector search (pgvector)
         |                                   5. Download blobs (Walrus)
         |                                   6. SEAL decrypt (sidecar)
         |                                            |
         |<--- {"results":[{"text":"allergic..."}]} --|
         |                                            |
TRUST MODEL: Server decrypts and returns plaintext. Private key exposed.
```

### 3.3 MemWalManual.rememberManual() -- Client-Side Crypto

```
+-------------------+   +----------+   +----------+   +------------------+
|  MemWalManual SDK |   | OpenAI   |   | SEAL Key |   |  MemWal Server   |
|  (manual.ts)      |   | API      |   | Servers  |   |                  |
+--------+----------+   +----+-----+   +----+-----+   +--------+---------+
         |                   |              |                   |
 1. rememberManual("allergic to peanuts")   |                   |
         |                   |              |                   |
         |--- PLAINTEXT ---->|              |                   |
         | 2. POST /embeddings              |                   |
         |   Bearer: OPENAI_KEY             |                   |
         |<-- vector[] ------|              |                   |
         |                   |              |                   |
         |--- encrypt req ----------------->|                   |
         | 3. sealEncrypt(plaintext)        |                   |
         |   threshold: 1                   |                   |
         |   verifyKeyServers: false        |                   |
         |<-- encrypted blob ---------------|                   |
         |                                                      |
         |--- Signed POST /api/remember/manual ---------------->|
         | 4. Headers: x-public-key, x-signature, x-timestamp   |
         |    Body: {"encrypted_data": base64, "vector": [...]} |
         |    (NO x-delegate-key header)                        |
         |                                                      |
         |                                     5. Upload to Walrus (relay)
         |                                     6. Store vector in pgvector
         |                                                      |
         |<--- {"id":"...","blob_id":"..."} --------------------|
         |                                                      |

TRUST MODEL: Server never sees plaintext. Private key stays local.
OpenAI sees plaintext for embedding. SEAL key server unverified.
```

### 3.4 MemWalManual.recallManual() -- Client-Side Crypto

```
+-------------------+  +--------+  +--------+  +--------+  +------------+
|  MemWalManual SDK |  | OpenAI |  | Server |  | Walrus |  | SEAL Keys  |
+--------+----------+  +---+----+  +---+----+  +---+----+  +-----+------+
         |                 |           |           |              |
 1. recallManual("food allergies")     |           |              |
         |                 |           |           |              |
         |-- embed req --->|           |           |              |
         |<- vector[] -----|           |           |              |
         |                             |           |              |
         |-- signed POST /recall/manual|           |              |
         |   (vector only) ----------->|           |              |
         |<- [{blob_id, distance}] ----|           |              |
         |                                         |              |
         |-- GET /v1/blobs/{id} ------------------>|              |
         |<- encrypted bytes ----------------------|              |
         |                                                        |
         | 2. Create SessionKey (wallet popup, 30min TTL)         |
         |                                                        |
         |-- fetchKeys(ids, txBytes, sessionKey) ---------------->|
         |<- decryption key shares --------------------------------|
         |                                                        |
         | 3. Decrypt locally: sealClient.decrypt(data, sessionKey)
         |    -> plaintext memories                               |
         |                                                        |

TRUST MODEL: Server sees only vectors, never plaintext.
Walrus sees only encrypted blobs. SEAL key servers gate decryption.
OpenAI sees plaintext queries. Private key stays local.
```

### 3.5 MemWal.analyze() -- Server-Assisted Mode

```
+-------------------+                        +------------------+
|  MemWal SDK       |                        |  MemWal Server   |
+--------+----------+                        +--------+---------+
         |                                            |
         | Signed POST /api/analyze                   |
         | Headers: x-delegate-key: PRIVATE_KEY       |
         | Body: {"text":"I love coffee, live in Tokyo"}
         |------------------------------------------->|
         |                                   1. Verify sig
         |                                   2. LLM extracts facts
         |                                   3. For EACH fact:
         |                                      a. Embed (OpenAI)
         |                                      b. SEAL encrypt
         |                                      c. Walrus upload
         |                                      d. Store vector
         |                                            |
         |<-- {"facts":[{text,id,blob_id},...]} ------|

TRUST MODEL: Server sees full conversation text + private key.
Cost weight = 10 (highest rate limit cost).
```

---

## 4. Assets

| Asset | Location | Sensitivity | Present In |
|-------|----------|-------------|------------|
| **Ed25519 delegate private key** | `memwal.ts:63` as `Uint8Array`; transmitted in `x-delegate-key` header (line 314) | CRITICAL -- controls all memory access for the account | MemWal: in-memory + every HTTP request. Manual: in-memory only |
| **Sui private key (bech32)** | `manual.ts:84` stored in `this.config`; decoded at `manual.ts:153` | CRITICAL -- controls wallet funds, SEAL operations, Walrus uploads | MemWalManual only |
| **OpenAI API key** | `manual.ts:413` stored in `this.config.embeddingApiKey`; sent as Bearer token (line 429) | HIGH -- billing exposure, rate abuse | MemWalManual only |
| **Plaintext memories** | Transient in `remember()` body; returned in `recall()` response | HIGH -- user's private information | MemWal: exposed to server + wire. Manual: exposed to OpenAI for embedding only |
| **Encrypted blobs** | SEAL-encrypted bytes on Walrus | LOW (when encryption is sound) -- ciphertext without key is inert | Both modes (server-side or client-side encryption) |
| **SEAL session keys** | `manual.ts:327` created per `recallManual()` call, 30-min TTL | HIGH -- grants decryption capability for session duration | MemWalManual only |
| **Embedding vectors** | Sent to server in manual mode; generated server-side in assisted mode | MEDIUM -- partial information leakage about memory content | Both modes |
| **Account ID** | `memwal.ts:67`; sent in `x-account-id` header (line 315) | LOW -- public on-chain object ID, but aids targeted attacks | MemWal mode |
| **Ed25519 public key** | Derived from private key; sent in `x-public-key` header | LOW -- public by design | Both modes |

---

## 5. STRIDE Analysis

### 5.1 TB-2: SDK <-> MemWal Server

#### Spoofing

| ID | Threat | Mode | Code Reference | Mitigation Status |
|----|--------|------|----------------|-------------------|
| S-1 | Attacker impersonates the MemWal server (DNS hijack, ARP spoof) | Both | `memwal.ts:72`, `manual.ts:82` -- default `http://localhost:8000` | **UNMITIGATED.** No TLS enforcement for non-localhost URLs. No certificate pinning. |
| S-2 | Attacker impersonates a legitimate client using stolen delegate key | Both | `memwal.ts:314` -- private key in header enables trivial theft | **UNMITIGATED in MemWal mode.** Key theft from header interception gives full impersonation. Manual mode is safer (key never leaves process). |

#### Tampering

| ID | Threat | Mode | Code Reference | Mitigation Status |
|----|--------|------|----------------|-------------------|
| T-1 | MitM modifies request body in transit | Both | `memwal.ts:295-298` -- body SHA-256 is included in signature | **MITIGATED** for body content. Signature covers `body_sha256`. |
| T-2 | MitM modifies unsigned headers (`x-account-id`) | MemWal | `memwal.ts:315` -- not part of signed message | **PARTIALLY MITIGATED.** Server verifies key-to-account binding on-chain. Attacker can cause lookup failures but not access wrong account. |
| T-3 | MitM modifies query string parameters | Both | `memwal.ts:298`, `manual.ts:540` -- path excludes query string | **UNMITIGATED.** Query string not signed. Not currently exploitable (all POST with JSON bodies) but fragile. |
| T-4 | Server tampers with recall results (returns fabricated memories) | MemWal | `memwal.ts:125-131` -- trusts server response entirely | **UNMITIGATED in MemWal mode.** Client cannot verify returned plaintext is authentic. Manual mode: client decrypts locally so tampering is detectable (SEAL decryption would fail). |

#### Repudiation

| ID | Threat | Mode | Code Reference | Mitigation Status |
|----|--------|------|----------------|-------------------|
| R-1 | Server denies receiving a remember request | Both | `memwal.ts:286-326` -- no client-side audit log | **UNMITIGATED.** SDK does not log or persist signed request evidence. |
| R-2 | Client denies creating a memory (claims server fabricated it) | Both | Server has signed request proof | **MITIGATED** by Ed25519 signatures. Server retains non-repudiable proof. |

#### Information Disclosure

| ID | Threat | Mode | Code Reference | Mitigation Status |
|----|--------|------|----------------|-------------------|
| I-1 | Delegate private key intercepted from HTTP header | MemWal | `memwal.ts:314` -- `x-delegate-key: bytesToHex(this.privateKey)` | **UNMITIGATED. CRITICAL.** Key sent in plaintext on every request. Any proxy, CDN, load balancer, or network tap captures it. |
| I-2 | Plaintext memories intercepted in transit | MemWal | `memwal.ts:103-104` -- text in JSON body over HTTP | **UNMITIGATED over HTTP.** Default URL is `http://`. Memories visible to network observers. |
| I-3 | Server error messages leak internal details | Both | `memwal.ts:320-322`, `manual.ts:558-560` -- raw error text propagated | **UNMITIGATED.** SDK passes through server error messages which may contain internal paths, SQL errors, etc. |
| I-4 | Embedding vectors leak partial information about memory content | Manual | `manual.ts:251` -- vector sent to server | **ACCEPTED RISK.** Vectors are lossy projections but can reveal semantic similarity. Architectural necessity for server-side search. |

#### Denial of Service

| ID | Threat | Mode | Code Reference | Mitigation Status |
|----|--------|------|----------------|-------------------|
| D-1 | Attacker replays captured signed requests within 5-minute window | Both | `memwal.ts:293` -- timestamp is only replay protection, no nonce | **PARTIALLY MITIGATED.** 5-minute window limits exposure. Rate limiting provides secondary defense. No nonce prevents full mitigation. |
| D-2 | Large text input causes memory exhaustion on server | MemWal | `memwal.ts:102` -- no input length validation | **UNMITIGATED at SDK level.** Server may have its own limits but SDK sends arbitrary-length text. |
| D-3 | `btoa` spread operator crashes on large encrypted payloads | Manual | `manual.ts:250` -- `btoa(String.fromCharCode(...encrypted))` | **UNMITIGATED.** JS engine max argument limit (~65536-131072 args) can be exceeded by large payloads. |

#### Elevation of Privilege

| ID | Threat | Mode | Code Reference | Mitigation Status |
|----|--------|------|----------------|-------------------|
| E-1 | Stolen delegate key grants full memory access (read + write + delete) | Both | `memwal.ts:314` (MemWal: trivial theft), `manual.ts:61` (Manual: requires process compromise) | **UNMITIGATED in MemWal mode.** Key revocation requires on-chain `remove_delegate_key` transaction, which requires the Sui owner key. |
| E-2 | Namespace isolation bypass via SEAL policy (owner-scoped, not namespace-scoped) | Manual | `manual.ts:457` -- SEAL ID is `ownerAddress`, not namespace-qualified | **UNMITIGATED.** A delegate with SEAL decrypt access for one namespace can decrypt data from any namespace owned by the same account. |
| E-3 | Compromised SEAL key server issues unauthorized decryption keys | Manual | `manual.ts:200` -- `verifyKeyServers: false`; `manual.ts:454` -- threshold 1 | **UNMITIGATED.** With threshold=1 and no server verification, a single compromised or spoofed SEAL server breaks all encryption. |

### 5.2 TB-3: SDK <-> SEAL Key Servers (MemWalManual only)

#### Spoofing

| ID | Threat | Code Reference | Mitigation Status |
|----|--------|----------------|-------------------|
| S-3 | Rogue SEAL key server impersonation via DNS/network attack | `manual.ts:200` -- `verifyKeyServers: false` | **UNMITIGATED.** On-chain verification of key server identity is explicitly disabled. |
| S-4 | User-supplied `sealKeyServers` config points to attacker-controlled servers | `manual.ts:187` -- `this.config.sealKeyServers` used directly | **UNMITIGATED.** No validation that provided server IDs are legitimate on-chain objects. |

#### Information Disclosure

| ID | Threat | Code Reference | Mitigation Status |
|----|--------|----------------|-------------------|
| I-5 | SEAL key server learns which blob IDs a user is decrypting | `manual.ts:361` -- `fetchKeys({ids: [fullId]})` | **ACCEPTED RISK.** Inherent to threshold encryption. Key servers see access patterns. |

### 5.3 TB-5: SDK <-> OpenAI/OpenRouter (MemWalManual only)

#### Information Disclosure

| ID | Threat | Code Reference | Mitigation Status |
|----|--------|----------------|-------------------|
| I-6 | Embedding provider sees all plaintext memories and queries | `manual.ts:425-443` -- text sent to `/embeddings` endpoint | **ACCEPTED RISK.** Architectural requirement for semantic search. Documented trade-off. |
| I-7 | OpenAI API key exposed if embedding endpoint is HTTP | `manual.ts:420` -- `embeddingApiBase` can be overridden to non-HTTPS | **UNMITIGATED.** No validation that embedding API base uses HTTPS. |

#### Tampering

| ID | Threat | Code Reference | Mitigation Status |
|----|--------|----------------|-------------------|
| T-5 | Embedding provider returns manipulated vectors (poisoning search results) | `manual.ts:439` -- vector used directly without validation | **UNMITIGATED.** No integrity check on returned embeddings. A compromised or malicious embedding provider could bias all search results. |

### 5.4 TB-1: Application <-> SDK

#### Information Disclosure

| ID | Threat | Code Reference | Mitigation Status |
|----|--------|----------------|-------------------|
| I-8 | Private keys persist in JS heap as immutable strings | `types.ts:13,127` -- `key: string`; `memwal.ts:70` -- `hexToBytes(config.key)` but original string remains | **UNMITIGATED.** JS strings cannot be zeroed. GC timing is nondeterministic. |
| I-9 | `console.error` logs expose blob IDs and error details in browser DevTools | `manual.ts:291,377` | **UNMITIGATED.** Visible to any browser extension or DevTools user. |

---

## 6. Attack Scenarios

### 6.1 Key Theft via Header Interception (MemWal Mode)

**Attacker:** Network observer (proxy, CDN, ISP, compromised router, browser extension)
**Target:** `x-delegate-key` header (`memwal.ts:314`)
**Prerequisites:** Network position between SDK and server, or access to HTTP logs

**Attack flow:**
1. Application configures `MemWal.create({ key: "abc123...", serverUrl: "http://api.example.com:8000" })`
2. SDK calls `remember("my SSN is 123-45-6789")`
3. SDK constructs HTTP request with `x-delegate-key: abc123...` in headers (line 314)
4. Attacker captures the HTTP request (plaintext, no TLS)
5. Attacker now possesses the delegate private key
6. Attacker constructs their own signed requests to remember/recall/analyze
7. Attacker has full read/write access to all of the victim's memories across all namespaces

**Impact:** CRITICAL. Complete account compromise. Attacker can read all memories, inject false memories, and delete data.

**Why Manual mode is different:** `MemWalManual.signedRequest()` (lines 529-556) does not include `x-delegate-key`. The private key never leaves the process.

### 6.2 Man-in-the-Middle on Non-HTTPS Connection

**Attacker:** Active network adversary
**Target:** SDK <-> Server communication
**Prerequisites:** SDK configured with HTTP URL (the default)

**Attack flow:**
1. Attacker performs ARP spoofing or DNS hijacking to intercept traffic
2. For `MemWal` mode:
   - Attacker captures delegate private key from `x-delegate-key` header
   - Attacker reads plaintext memories from request/response bodies
   - Attacker modifies recall responses to inject false memories
3. For `MemWalManual` mode:
   - Attacker cannot steal delegate key (not in headers)
   - Attacker can observe encrypted data and vectors but not plaintext
   - Attacker could modify vector search results (blob IDs + distances)
   - Modified blob IDs would cause SEAL decryption failure (detectable)

**Impact:** CRITICAL for MemWal mode, MEDIUM for MemWalManual mode.

### 6.3 Rogue SEAL Key Server (MemWalManual Mode)

**Attacker:** Operator of a malicious SEAL key server, or network attacker performing DNS poisoning
**Target:** SEAL encryption/decryption flow
**Prerequisites:** `verifyKeyServers: false` (line 200), threshold=1 (line 454)

**Attack flow:**
1. Attacker either:
   a. Operates a server that responds to SEAL protocol but serves attacker-controlled keys, OR
   b. DNS-poisons the SEAL key server endpoint (possible because verification is disabled)
2. During `sealEncrypt()`: attacker's server provides encryption key shares that the attacker knows
3. All new memories encrypted with attacker-known keys
4. During `recallManual()` -> `fetchKeys()`: attacker's server provides decryption key shares
5. Attacker can now decrypt any previously-encrypted blob they can retrieve from Walrus

**Impact:** HIGH. Complete break of encryption confidentiality. All encrypted memories become readable.

**Mitigations available:** Set `verifyKeyServers: true` (single-line fix at `manual.ts:200`). Increase threshold above 1.

### 6.4 Replay Attacks

**Attacker:** Network observer who captured a previously valid signed request
**Target:** Any authenticated SDK endpoint
**Prerequisites:** Captured signed request within 5-minute freshness window

**Attack flow:**
1. Attacker captures a signed `POST /api/remember` request (including body, signature, timestamp)
2. Within 5 minutes, attacker replays the exact same request
3. Server accepts it because timestamp is still fresh and signature is valid
4. For `remember`: duplicate memory stored (data pollution)
5. For `analyze`: duplicate LLM processing (cost amplification, rate limit weight = 10)

**Impact:** MEDIUM. Data duplication, cost amplification. Cannot be used to read data (recall results go to the original caller's connection). No nonce or request-ID prevents detection (`memwal.ts:293`, `manual.ts:536`).

### 6.5 Memory Poisoning via Compromised Server

**Attacker:** Compromised or malicious MemWal server operator
**Target:** User's memory store
**Prerequisites:** User using MemWal (server-assisted) mode

**Attack flow:**
1. Server operator (or attacker who compromised the server) has access to:
   - All plaintext memories (received in request bodies)
   - Delegate private key (from `x-delegate-key` header)
   - All embeddings and encrypted blobs
2. Server injects false memories by storing fabricated text with plausible embeddings
3. When user recalls, false memories are returned alongside real ones
4. If the user's application (e.g., AI agent) acts on these memories, decisions are manipulated

**Impact:** HIGH. Integrity violation. Particularly dangerous for AI agent use cases where memories drive autonomous decisions.

**Why Manual mode is different:** In Manual mode, the server never sees plaintext. It could manipulate vector search results (return wrong blob IDs), but SEAL decryption of the wrong blob would either fail or return obviously wrong content.

### 6.6 Embedding Provider Memory Exfiltration (MemWalManual Mode)

**Attacker:** Compromised or malicious embedding API provider
**Target:** Plaintext memory content
**Prerequisites:** User using MemWalManual with external embedding API

**Attack flow:**
1. All plaintext memories pass through the embedding API (`manual.ts:425-443`)
2. Embedding provider logs or exfiltrates the text content
3. Provider also sees all search queries, revealing user intent

**Impact:** HIGH for privacy. The "end-to-end encryption" claim is weakened because plaintext is shared with the embedding provider. This is an inherent architectural trade-off of client-side semantic search.

---

## 7. Comparative Threat Analysis: MemWal vs MemWalManual

| Threat Category | MemWal (Server-Assisted) | MemWalManual (Client-Side) | Winner |
|----------------|--------------------------|---------------------------|--------|
| **Private key exposure** | CRITICAL: delegate key sent in every HTTP header (`memwal.ts:314`) | SAFE: delegate key never leaves process; Sui key held locally | **Manual** |
| **Plaintext exposure to server** | All memories sent as plaintext in request body | Server never sees plaintext; only receives encrypted blobs + vectors | **Manual** |
| **Plaintext exposure to third parties** | Only server sees plaintext | OpenAI/embedding provider sees all plaintext for embedding | **MemWal** (fewer parties) |
| **Encryption trust model** | Trust server to encrypt correctly via sidecar | Client encrypts locally via SEAL; but `verifyKeyServers: false` and threshold=1 weaken guarantees | **Tied** (both have issues) |
| **Replay resistance** | 5-min window, no nonce | 5-min window, no nonce | **Tied** |
| **MitM resilience** | Catastrophic: private key + plaintext exposed | Moderate: encrypted data + vectors exposed, but no key material | **Manual** |
| **Server compromise impact** | Total: server has plaintext + private key | Partial: server can manipulate search results but cannot read memories | **Manual** |
| **Key revocation** | Requires on-chain tx (slow). Stolen key usable until revoked | Same for delegate key. Sui wallet key theft is separate concern | **Tied** |
| **Operational complexity** | Simple: one key, one server | Complex: manage delegate key + Sui key + OpenAI key + SEAL config | **MemWal** |
| **Dependencies / attack surface** | Minimal: fetch + @noble/ed25519 | Large: @mysten/sui, @mysten/seal, @mysten/walrus, OpenAI API | **MemWal** |
| **Browser compatibility** | Full (just HTTP) | Requires wallet extension for signing (or raw key in code) | **MemWal** |
| **Namespace isolation** | Server-enforced via DB queries (owner, namespace) | SEAL policy is owner-scoped only (`manual.ts:457`), namespace not cryptographically enforced | **MemWal** |

**Summary:** MemWalManual provides fundamentally stronger confidentiality guarantees at the cost of operational complexity and a larger client-side attack surface. The critical `x-delegate-key` header in MemWal mode is an architectural flaw that makes Manual mode strictly superior for security-sensitive deployments.

---

## 8. Threat Matrix

| ID | Threat | Category | Trust Boundary | Affected Mode | Likelihood | Impact | Risk Rating | Code Reference |
|----|--------|----------|---------------|---------------|------------|--------|-------------|----------------|
| I-1 | Delegate private key intercepted from HTTP header | Information Disclosure | TB-2 (SDK<->Server) | MemWal | **High** (default HTTP, key in every request) | **Critical** (full account takeover) | **CRITICAL** | `memwal.ts:314` |
| E-1 | Stolen delegate key grants full memory access | Elevation of Privilege | TB-2 | MemWal | **High** (follows from I-1) | **Critical** (read/write/delete all memories) | **CRITICAL** | `memwal.ts:314` |
| S-3 | Rogue SEAL key server via disabled verification | Spoofing | TB-3 (SDK<->SEAL) | Manual | **Medium** (requires network position or DNS attack) | **High** (breaks all encryption) | **HIGH** | `manual.ts:200` |
| E-3 | Single SEAL server compromise breaks encryption | Elevation of Privilege | TB-3 | Manual | **Medium** (threshold=1, one target) | **High** (all encrypted data exposed) | **HIGH** | `manual.ts:200,454` |
| I-2 | Plaintext memories intercepted over HTTP | Information Disclosure | TB-2 | MemWal | **High** (default HTTP) | **High** (privacy breach) | **HIGH** | `memwal.ts:72,103` |
| I-6 | Embedding provider sees all plaintext | Information Disclosure | TB-5 (SDK<->OpenAI) | Manual | **High** (by design) | **Medium** (third-party data exposure) | **HIGH** | `manual.ts:425-443` |
| T-4 | Server returns fabricated recall results | Tampering | TB-2 | MemWal | **Low** (requires server compromise) | **High** (memory poisoning for AI agents) | **MEDIUM** | `memwal.ts:125-131` |
| S-1 | Attacker impersonates MemWal server | Spoofing | TB-2 | Both | **Medium** (DNS hijack) | **High** (MemWal: key theft; Manual: search manipulation) | **MEDIUM** | `memwal.ts:72`, `manual.ts:82` |
| D-1 | Request replay within 5-minute window | Denial of Service | TB-2 | Both | **Medium** (requires network capture) | **Medium** (data duplication, cost amplification) | **MEDIUM** | `memwal.ts:293`, `manual.ts:536` |
| T-5 | Embedding provider returns manipulated vectors | Tampering | TB-5 | Manual | **Low** (requires provider compromise) | **Medium** (biased search results) | **MEDIUM** | `manual.ts:439` |
| E-2 | Namespace isolation bypass via owner-scoped SEAL policy | Elevation of Privilege | TB-3 | Manual | **Medium** (any delegate key holder) | **Medium** (cross-namespace decryption) | **MEDIUM** | `manual.ts:457` |
| I-8 | Private keys persist as immutable JS strings | Information Disclosure | TB-1 (App<->SDK) | Both | **Low** (requires memory dump/heap inspection) | **High** (key extraction) | **MEDIUM** | `types.ts:13,127` |
| T-3 | Query string tampering (unsigned) | Tampering | TB-2 | Both | **Low** (not currently exploitable, all POST) | **Medium** (future risk) | **LOW** | `memwal.ts:298`, `manual.ts:540` |
| I-3 | Server error messages leak internal details | Information Disclosure | TB-2 | Both | **Medium** (on any error) | **Low** (reconnaissance) | **LOW** | `memwal.ts:320-322` |
| I-9 | console.error leaks blob IDs in browser | Information Disclosure | TB-1 | Manual | **Medium** (any browser user) | **Low** (metadata exposure) | **LOW** | `manual.ts:291,377` |
| D-3 | btoa spread operator stack overflow | Denial of Service | TB-1 | Manual | **Low** (requires large payload) | **Low** (client-side crash) | **LOW** | `manual.ts:250` |
| I-7 | OpenAI API key exposed over non-HTTPS | Information Disclosure | TB-5 | Manual | **Low** (requires custom non-HTTPS base URL) | **Medium** (API key theft) | **LOW** | `manual.ts:420` |
| S-4 | Attacker-controlled sealKeyServers in config | Spoofing | TB-3 | Manual | **Low** (requires config manipulation) | **High** (breaks encryption) | **LOW** | `manual.ts:187` |
| T-2 | Unsigned x-account-id header modification | Tampering | TB-2 | MemWal | **Medium** (MitM) | **Low** (causes lookup failure, not access) | **LOW** | `memwal.ts:315` |
| R-1 | No client-side audit log for requests | Repudiation | TB-2 | Both | **Low** (dispute scenario) | **Low** (no proof of submission) | **LOW** | `memwal.ts:286-326` |

---

## Appendix: Risk Rating Methodology

- **Likelihood:** Low (requires specialized access or unlikely conditions), Medium (feasible with moderate effort or common misconfigurations), High (trivially exploitable or enabled by default)
- **Impact:** Low (information leakage, minor disruption), Medium (partial data exposure, service degradation), High (significant data breach, financial loss), Critical (full account compromise, systemic key exposure)
- **Risk Rating:** Combination of likelihood and impact: Critical (High/Critical), High (Medium/High or High/High), Medium (varied), Low (Low/Low or Low/Medium)
