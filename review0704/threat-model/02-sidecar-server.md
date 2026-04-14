# MemWal TypeScript Sidecar Server -- STRIDE Threat Model

**Date:** 2026-04-03
**Commit:** 5bb1669 (branch `dev`)
**Scope:** `services/server/scripts/sidecar-server.ts` -- Express.js sidecar handling SEAL crypto, Walrus uploads, and Enoki sponsorship

---

## 1. Service Overview

### What the Sidecar Does

The sidecar is a long-lived Express.js server that wraps TypeScript-only SDKs (SEAL, Walrus, Enoki) into HTTP endpoints consumed by the Rust server. It runs on the same host as the Rust server and listens on port 9000 (configurable via `SIDECAR_PORT`).

**Endpoints:**

| Endpoint | Line | Purpose | Auth |
|----------|------|---------|------|
| `POST /seal/encrypt` | L295 | SEAL-encrypt plaintext data for a given owner | **None** |
| `POST /seal/decrypt` | L321 | SEAL-decrypt a blob using a delegate private key | **None** |
| `POST /seal/decrypt-batch` | L398 | Batch SEAL-decrypt multiple blobs with a single SessionKey | **None** |
| `POST /walrus/upload` | L503 | Upload encrypted data to Walrus, set metadata, transfer blob | **None** |
| `POST /walrus/query-blobs` | L640 | Query user's Walrus Blob objects from Sui chain | **None** |
| `POST /sponsor` | L753 | Create Enoki-sponsored transaction for frontend wallets | **None** |
| `POST /sponsor/execute` | L782 | Execute a signed sponsored transaction via Enoki | **None** |
| `GET /health` | L288 | Health check | **None** |

### Shared Clients (Initialized at Boot)

| Client | Line | Configuration |
|--------|------|---------------|
| `SuiJsonRpcClient` | L56 | Network from `SUI_NETWORK` env (mainnet/testnet) |
| `SealClient` | L61 | Key servers from `SEAL_KEY_SERVERS` env; `verifyKeyServers: false` (L67) |
| `WalrusClient` | L70 | Upload relay from `WALRUS_UPLOAD_RELAY_URL` env |

### Key Design Decisions

- **No authentication on any endpoint** -- by design, all validation happens in the Rust server upstream
- **50MB JSON body limit** (L274) -- large encrypted blobs can be uploaded
- **CORS: `Access-Control-Allow-Origin: *`** (L278) -- intended for frontend `/sponsor` endpoints
- **Receives private keys** in request bodies (`/seal/decrypt`, `/seal/decrypt-batch`, `/walrus/upload`)
- **Enoki API key** stored server-side (L123) for transaction sponsorship
- **Signer queue** (L248) serializes uploads per signing key to avoid coin-lock conflicts

---

## 2. Trust Boundaries

```
+---------------------------+     +-----------------------------+
|  Frontend Apps (Browser)  |     |  Rust Server (port 8000)    |
|  - Wallet-connected       |     |  - Ed25519 auth verified    |
|  - Sends sponsor requests |     |  - Rate-limited             |
+----------+----------------+     +----------+------------------+
           |                                  |
           | /sponsor, /sponsor/execute       | /seal/*, /walrus/*
           | (direct, no auth)                | (proxied, no auth)
           v                                  v
+-----------------------------------------------------------+
|              Sidecar Express (port 9000)                  |
|  - NO authentication on any endpoint                      |
|  - CORS: Allow-Origin: *                                  |
|  - Receives private keys in request bodies                |
|  - 50MB body limit                                        |
+----------+----------+----------+-----------+--------------+
           |          |          |           |
    +------v---+ +---v------+ +-v--------+ +v-----------+
    | SEAL Key | | Walrus   | | Enoki    | | Sui RPC    |
    | Servers  | | Upload   | | Sponsor  | | (fullnode) |
    |          | | Relay    | | API      | |            |
    +----------+ +----------+ +----------+ +------------+
```

### Trust Boundary Analysis

| Boundary | Trust Level | Notes |
|----------|-------------|-------|
| Rust Server -> Sidecar | **Fully trusted** (localhost) | No auth. Rust server forwards private keys, plaintext. If sidecar is exposed beyond localhost, entire security model breaks. |
| Frontend -> Sidecar (`/sponsor`) | **Unauthenticated** | Any origin can call `/sponsor` and `/sponsor/execute`. Relies on Enoki's own validation. |
| Sidecar -> SEAL Key Servers | **Unverified** | `verifyKeyServers: false` (L67). Sidecar trusts whatever SEAL servers are configured. |
| Sidecar -> Walrus Upload Relay | **External** | Upload relay URL from env. Tip config fetched and cached (L143-168). |
| Sidecar -> Enoki API | **External, API-keyed** | Bearer token auth (L178). Enoki validates sender/tx independently. |
| Sidecar -> Sui RPC | **External** | Public fullnode. Used for tx building, object queries. |

---

## 3. Data Flow Diagrams

### 3.1 SEAL Encrypt (called by Rust server)

```
Rust Server                     Sidecar (port 9000)              SEAL Key Servers
    |                               |                                |
    |-- POST /seal/encrypt -------->|                                |
    |   { data: base64,            |                                |
    |     owner: "0x...",          |                                |
    |     packageId: "0x..." }     |                                |
    |                               |                                |
    |                    1. Decode base64 -> plaintext (L302)        |
    |                    2. sealClient.encrypt({                     |
    |                         threshold: 1, (L304)                   |
    |                         id: owner, (L306)                      |
    |                         data: plaintext                        |
    |                       })                                       |
    |                               |--- fetch key shares ---------> |
    |                               |<-- encrypted object -----------|
    |                    3. Base64-encode result (L310)               |
    |                               |                                |
    |<-- { encryptedData: base64 } -|                                |

SENSITIVE DATA: Plaintext memory content visible in sidecar process memory.
```

### 3.2 SEAL Decrypt (called by Rust server)

```
Rust Server                     Sidecar (port 9000)              SEAL Key Servers
    |                               |                                |
    |-- POST /seal/decrypt -------->|                                |
    |   { data: base64,            |                                |
    |     privateKey: "suiprivkey.." or hex,                         |
    |     packageId: "0x...",      |                                |
    |     accountId: "0x..." }     |                                |
    |                               |                                |
    |              1. Decode private key (L329-337)                   |
    |              2. Parse EncryptedObject -> fullId (L342-343)      |
    |              3. Create SessionKey (30min TTL) (L351-357)        |
    |              4. Build seal_approve PTB (L360-368)               |
    |              5. fetchKeys({ids, txBytes, sessionKey}) -------->|
    |                               |<-- decryption shares ----------|
    |              6. sealClient.decrypt(data, sessionKey) (L379)    |
    |              7. Base64-encode plaintext (L385)                  |
    |                               |                                |
    |<-- { decryptedData: base64 } -|                                |

SENSITIVE DATA: Private key received in body. Plaintext in response.
SessionKey created with signer's authority.
```

### 3.3 Walrus Upload (called by Rust server)

```
Rust Server                  Sidecar                 Walrus Relay        Enoki API
    |                            |                       |                  |
    |-- POST /walrus/upload ---->|                       |                  |
    |   { data, privateKey,     |                       |                  |
    |     owner, namespace,     |                       |                  |
    |     packageId, epochs }   |                       |                  |
    |                            |                       |                  |
    |             1. Decode signer key (L518-519)        |                  |
    |             2. Serialize upload queue (L522)        |                  |
    |             3. writeBlobFlow.encode() (L527)        |                  |
    |             4. register({epochs, owner}) (L529)     |                  |
    |             5. patchGasCoinIntents (L545)           |                  |
    |             6. executeWithEnokiSponsor -------------|---------------->|
    |                (register tx)                        |    sponsor + exec|
    |             7. flow.upload(digest) ---------------->|                  |
    |             8. executeWithEnokiSponsor -------------|---------------->|
    |                (certify tx)                         |    sponsor + exec|
    |             9. Set metadata + transfer (L574-624)   |                  |
    |                                                     |                  |
    |<-- { blobId, objectId } ---|                       |                  |

SENSITIVE DATA: Server wallet private key in body.
On-chain transactions signed with server key.
Metadata (namespace, owner, packageId) stored on-chain (public).
```

### 3.4 Sponsor Flow (called by Frontend)

```
Browser (any origin)            Sidecar                          Enoki API
    |                               |                                |
    |-- POST /sponsor ------------->|                                |
    |   { transactionBlockKindBytes,|                                |
    |     sender: "0x..." }        |                                |
    |                               |                                |
    |             1. Validate required fields (L756)                  |
    |             2. callEnoki(/sponsor) --------------------------->|
    |                { network, txBytes, sender }                    |
    |                               |<-- { bytes, digest } ----------|
    |<-- { bytes, digest } ---------|                                |
    |                                                                |
    |   [ User signs `bytes` with wallet ]                           |
    |                                                                |
    |-- POST /sponsor/execute ----->|                                |
    |   { digest, signature }      |                                |
    |             3. callEnoki(/sponsor/{digest}) ------------------>|
    |                { digest, signature }                            |
    |                               |<-- { digest } ----------------|
    |<-- { digest } ----------------|                                |

NO AUTH: Any origin, any sender. Enoki API key spent on behalf of arbitrary callers.
```

---

## 4. Assets

| Asset | Description | Location | Sensitivity |
|-------|-------------|----------|-------------|
| **Delegate private keys** | Received in `/seal/decrypt`, `/seal/decrypt-batch` request bodies | L323, L400 | CRITICAL -- controls SEAL decryption and account access |
| **Server wallet private keys** | Received in `/walrus/upload` request body; used for on-chain tx signing | L518 | CRITICAL -- controls SUI funds and blob ownership |
| **Plaintext memory content** | Visible during `/seal/encrypt` (pre-encryption) and after `/seal/decrypt` (post-decryption) | L302, L385 | HIGH -- user's private information |
| **Enoki API key** | Server-side env var; gates transaction sponsorship | L123, L178 | HIGH -- billing exposure, gas sponsorship abuse |
| **SEAL session keys** | Created per decrypt request, 30-min TTL | L351, L441 | HIGH -- grants decryption capability |
| **Encrypted blobs** | Base64 ciphertext transiting through sidecar | L310, L341 | LOW (when encryption sound) |
| **Walrus blob metadata** | Namespace, owner, packageId written on-chain | L535-612 | LOW -- public on-chain data |
| **Upload relay tip address** | Cached from relay tip-config endpoint | L137 | LOW |

---

## 5. STRIDE Analysis

### S -- Spoofing

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| S-1 | Attacker directly calls sidecar bypassing Rust server auth | L273-284 | No authentication on any endpoint. If port 9000 is network-accessible, any caller can encrypt/decrypt/upload. CORS `*` does not prevent non-browser clients. | **CRITICAL** (if exposed) / **LOW** (if localhost-only) |
| S-2 | Frontend spoofs `sender` in `/sponsor` to drain Enoki budget | L753-776 | Any address can be passed as `sender`. Enoki validates that `sender` matches the signer, but gas sponsorship is consumed regardless of who calls. | **MEDIUM** |
| S-3 | Attacker replays `/sponsor/execute` with captured digest+signature | L782-804 | `digest` and `signature` are one-time values. Enoki should reject replays. | **LOW** |
| S-4 | Rogue SEAL key server substitution | L61-68 | `verifyKeyServers: false`. Attacker who can modify env vars or DNS can substitute SEAL servers. | **HIGH** (same as SDK finding) |

### T -- Tampering

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| T-1 | MitM between sidecar and Walrus upload relay | L70-77, L149 | Upload relay URL from env. HTTPS by default but configurable. Tip config fetched over HTTP if URL overridden. | **LOW** |
| T-2 | Attacker modifies `/seal/encrypt` request to change `owner` field | L297 | Owner field determines SEAL key ID. If sidecar is accessible, attacker can encrypt data under any owner's key. Useful for injecting memories that appear legitimate. | **HIGH** (if exposed) / **LOW** (if localhost-only) |
| T-3 | Attacker modifies `transactionBlockKindBytes` in `/sponsor` | L753-755 | Arbitrary transaction kinds can be sponsored. Enoki validates transaction structure but may accept harmful operations. | **MEDIUM** |
| T-4 | Metadata tampering on Walrus blobs | L574-624 | Metadata (namespace, owner, packageId) is set after upload. If metadata tx fails, blob exists without correct attribution (L620-623 logs error but continues). | **LOW** |

### R -- Repudiation

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| R-1 | No request logging for `/seal/decrypt` with private keys | L321-391 | Decrypt requests containing private keys are not audit-logged (only errors logged). No trail of who decrypted what. | **MEDIUM** |
| R-2 | `/sponsor` calls not tied to authenticated identity | L753-776 | No caller identity captured. Cannot attribute sponsorship spend to specific users. | **MEDIUM** |
| R-3 | Walrus upload success logged but no structured audit trail | L619 | Console.log only. No persistent audit record linking blob IDs to upload requests. | **LOW** |

### I -- Information Disclosure

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| I-1 | Private keys in request bodies visible to any process-level observer | L323, L400, L518 | Delegate keys and server wallet keys transmitted as JSON body fields. Visible in process memory, any request logging middleware, and crash dumps. | **HIGH** |
| I-2 | Error messages leak internal details | L314, L389, L496, L632, L745, L775, L803 | `err.message` returned directly in 500 responses. May contain SEAL key server URLs, Walrus relay internals, Enoki error details, stack traces. | **MEDIUM** |
| I-3 | Health endpoint exposes uptime | L289 | `process.uptime()` reveals when sidecar was last restarted. Minor reconnaissance value. | **LOW** |
| I-4 | On-chain metadata reveals namespace and owner per blob | L535-612 | `memwal_namespace`, `memwal_owner`, `memwal_package_id` are public on-chain. Allows enumeration of who uses MemWal and their namespace structure. | **LOW** |
| I-5 | `console.log` of sponsor requests includes sender address | L763, L797 | Logged to stdout. Could leak to log aggregation systems. | **LOW** |
| I-6 | Plaintext visible in sidecar process memory during encrypt/decrypt | L302, L385 | Between base64 decode and SEAL operation, plaintext exists as `Buffer`/`Uint8Array` in Node.js heap. Not zeroed after use. | **MEDIUM** |

### D -- Denial of Service

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| D-1 | 50MB body limit enables memory exhaustion | L274 | `express.json({ limit: "50mb" })`. Attacker sending many large requests can exhaust Node.js heap. No rate limiting on sidecar. | **HIGH** (if exposed) / **LOW** (if localhost-only) |
| D-2 | `/sponsor` endpoint drains Enoki gas budget | L753-776 | Unauthenticated. Attacker can submit many sponsor requests, consuming the Enoki API quota and gas budget. | **HIGH** |
| D-3 | `/seal/decrypt-batch` with large `items` array | L398-498 | No limit on `items.length`. Each item triggers SEAL parsing + decryption. CPU and memory exhaustion possible. | **MEDIUM** (if exposed) / **LOW** (if localhost-only) |
| D-4 | Signer queue memory growth | L248-267 | `signerUploadQueues` Map grows with concurrent signers. Not bounded. | **LOW** |
| D-5 | `/walrus/query-blobs` pagination loop unbounded | L656-740 | Iterates all owned blobs with no result limit. User with thousands of blobs causes long-running request. | **MEDIUM** |
| D-6 | SEAL key server unavailability blocks all encrypt/decrypt | L61-68 | Single point of failure. `threshold: 1` means one server down = total failure. | **MEDIUM** |

### E -- Elevation of Privilege

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| E-1 | Direct sidecar access bypasses Rust server rate limiting and auth | All endpoints | If sidecar port is accessible, attacker has unlimited access to encrypt, decrypt, upload, and sponsor operations without Ed25519 auth or rate limits. | **CRITICAL** (if exposed) / **MITIGATED** (if localhost-only) |
| E-2 | `/sponsor` allows arbitrary transaction sponsorship | L753-776 | No validation of transaction content. Attacker can sponsor any valid Sui transaction kind, not just MemWal operations. Enoki API key used as oracle of trust. | **MEDIUM** |
| E-3 | `/seal/decrypt` with stolen private key grants full decryption | L321-391 | If attacker obtains a delegate key (e.g., via `x-delegate-key` header interception from Rust server), they can call decrypt directly. | **HIGH** (if exposed) / **LOW** (if localhost-only, key already needed for Rust server) |
| E-4 | `/walrus/upload` transfers blob ownership to arbitrary address | L574, L615 | `owner` field in request determines transfer recipient. No validation that `owner` is a legitimate MemWal account. | **MEDIUM** (if exposed) / **LOW** (if localhost-only) |

---

## 6. Attack Scenarios

### Scenario 1: Sidecar Port Exposure (S-1 + E-1)

**Attacker:** External network attacker
**Goal:** Bypass all MemWal authentication and rate limiting
**Prerequisites:** Port 9000 accessible (misconfigured firewall, cloud security group, or Docker port mapping)

1. Attacker scans target and discovers port 9000 responding to `/health`
2. Attacker calls `POST /sponsor` with arbitrary `transactionBlockKindBytes` to drain gas budget (D-2)
3. If attacker has any private key, calls `/seal/decrypt` to decrypt blobs
4. Attacker calls `/seal/encrypt` with fabricated data to pollute the encryption layer
5. All Rust server protections (Ed25519 auth, rate limiting, account verification) are completely bypassed

**Impact:** CRITICAL. Total security model collapse.
**Likelihood:** LOW in proper deployments, HIGH if containerized without network isolation.

### Scenario 2: Enoki Gas Budget Drain (S-2 + D-2)

**Attacker:** Any internet user (no credentials needed)
**Goal:** Exhaust MemWal's Enoki sponsorship budget

1. Attacker discovers `/sponsor` endpoint (e.g., via frontend JavaScript inspection)
2. Attacker crafts valid `transactionBlockKindBytes` for expensive operations
3. Submits thousands of sponsor requests from different `sender` addresses
4. Each request consumes Enoki API quota and gas budget
5. Legitimate users can no longer get transactions sponsored

**Impact:** HIGH. Service degradation, financial cost.
**Likelihood:** MEDIUM. Endpoint is intentionally public for frontend use.

### Scenario 3: Batch Decrypt Resource Exhaustion (D-3)

**Attacker:** Compromised Rust server or direct sidecar access
**Goal:** Crash or slow the sidecar

1. Attacker sends `/seal/decrypt-batch` with `items` array of 10,000 entries
2. Each entry is parsed, SEAL decrypted, and base64-encoded
3. Node.js process exhausts heap memory or CPU
4. Sidecar becomes unresponsive, blocking all encrypt/decrypt/upload operations

**Impact:** HIGH. Complete service outage for memory operations.
**Likelihood:** LOW (requires sidecar access or Rust server compromise).

### Scenario 4: Metadata Transaction Failure Leaves Orphaned Blobs (T-4)

**Attacker:** None (operational failure scenario)
**Trigger:** Enoki sponsorship failure, Sui network congestion, or insufficient gas

1. `/walrus/upload` successfully uploads blob to Walrus and registers on-chain
2. Post-upload metadata+transfer transaction fails (L620-623)
3. Blob exists on-chain owned by server signer, not the intended user
4. No metadata attributes set; blob is not attributed to any namespace
5. User's memory is stored but unretrievable through normal query paths
6. Server still returns `{ blobId, objectId }` as if successful (L626-629)

**Impact:** MEDIUM. Data integrity issue. Silent failure.
**Likelihood:** LOW-MEDIUM. Depends on Enoki reliability.

### Scenario 5: SEAL Server Substitution (S-4)

**Attacker:** Operator with env var access, or DNS attacker
**Goal:** Decrypt all memories

1. Attacker modifies `SEAL_KEY_SERVERS` env var to include attacker-controlled server
2. Sidecar initializes `SealClient` with `verifyKeyServers: false` (L67)
3. All encryptions use attacker-known key shares (threshold=1 means one server suffices)
4. Attacker can decrypt any blob encrypted after the substitution

**Impact:** CRITICAL. Complete break of encryption.
**Likelihood:** LOW (requires env var or DNS control).

---

## 7. Threat Matrix

| ID | Threat | Category | Likelihood | Impact | Risk |
|----|--------|----------|------------|--------|------|
| S-1 | Direct sidecar access bypasses all auth | Spoofing | Low (proper deploy) / High (misconfigured) | Critical | **CRITICAL** (conditional) |
| E-1 | Sidecar exposure = full privilege bypass | EoP | Low / High | Critical | **CRITICAL** (conditional) |
| S-4 | SEAL key server substitution | Spoofing | Low | Critical | **HIGH** |
| D-2 | Enoki gas budget drain via `/sponsor` | DoS | Medium | High | **HIGH** |
| I-1 | Private keys in request bodies | Info Disclosure | Medium | High | **HIGH** |
| D-1 | 50MB body limit memory exhaustion | DoS | Low / Medium | High | **HIGH** (conditional) |
| E-3 | Stolen key + sidecar = unlimited decrypt | EoP | Low | High | **MEDIUM** |
| I-2 | Error messages leak internals | Info Disclosure | Medium | Medium | **MEDIUM** |
| I-6 | Plaintext in process memory not zeroed | Info Disclosure | Low | High | **MEDIUM** |
| D-3 | Unbounded batch decrypt array | DoS | Low | High | **MEDIUM** |
| D-5 | Unbounded blob query pagination | DoS | Medium | Medium | **MEDIUM** |
| D-6 | SEAL server SPOF (threshold=1) | DoS | Medium | Medium | **MEDIUM** |
| E-2 | Arbitrary tx sponsorship via `/sponsor` | EoP | Medium | Medium | **MEDIUM** |
| S-2 | Sender spoofing in `/sponsor` | Spoofing | Medium | Medium | **MEDIUM** |
| T-3 | Tampered tx bytes in `/sponsor` | Tampering | Medium | Medium | **MEDIUM** |
| R-1 | No audit log for decrypt operations | Repudiation | High | Medium | **MEDIUM** |
| R-2 | Sponsor calls unattributed | Repudiation | High | Low | **MEDIUM** |
| E-4 | Blob transfer to arbitrary address | EoP | Low | Medium | **LOW** |
| T-2 | Owner field tampering in encrypt | Tampering | Low | High | **LOW** |
| T-4 | Metadata tx failure = orphaned blob | Tampering | Low-Med | Medium | **LOW** |
| I-4 | On-chain metadata reveals user info | Info Disclosure | High | Low | **LOW** |
| D-4 | Signer queue memory growth | DoS | Low | Low | **LOW** |
| I-3 | Health endpoint exposes uptime | Info Disclosure | High | Low | **LOW** |
| I-5 | Sponsor logs include sender | Info Disclosure | Medium | Low | **LOW** |
| R-3 | No structured upload audit trail | Repudiation | Medium | Low | **LOW** |
| T-1 | MitM on Walrus relay | Tampering | Low | Low | **LOW** |
| S-3 | Sponsor execute replay | Spoofing | Low | Low | **LOW** |

### Risk Summary

| Risk Level | Count |
|------------|-------|
| CRITICAL (conditional) | 2 (S-1, E-1 -- only if port exposed) |
| HIGH | 4 (S-4, D-2, I-1, D-1) |
| MEDIUM | 11 |
| LOW | 10 |

---

## 8. Recommendations

### P0 -- Address CRITICAL Risks

1. **Bind sidecar to `127.0.0.1` explicitly** (currently binds to `0.0.0.0` by default via Express). Add `app.listen(PORT, "127.0.0.1", ...)` at L811. This is the single most important fix -- the entire security model depends on localhost isolation.
2. **Add a shared secret or mTLS between Rust server and sidecar** to prevent any other localhost process from calling sidecar endpoints.

### P1 -- Address HIGH Risks

3. **Rate-limit `/sponsor` and `/sponsor/execute`** by IP or sender address. Add per-sender budget caps to prevent Enoki gas drain (D-2).
4. **Set `verifyKeyServers: true`** in SealClient config (L67). Fixes S-4.
5. **Avoid passing private keys in HTTP request bodies.** Explore alternatives: sidecar loads keys from a local keystore file, or use a Unix socket instead of HTTP (eliminates network exposure of key material).
6. **Reduce JSON body limit** from 50MB to a reasonable maximum (e.g., 5MB for encrypted blobs). Fixes D-1.

### P2 -- Address MEDIUM Risks

7. **Cap `items.length` in `/seal/decrypt-batch`** to a reasonable maximum (e.g., 50). Fixes D-3.
8. **Add result limit to `/walrus/query-blobs`** pagination (e.g., max 500 blobs). Fixes D-5.
9. **Validate `/sponsor` transaction content** -- restrict to known MemWal package Move calls only. Fixes E-2, T-3.
10. **Sanitize error messages** -- return generic errors to callers, log details server-side only. Fixes I-2.
11. **Add structured request logging** for decrypt and sponsor operations (request ID, timestamp, key fingerprint -- not the key itself). Fixes R-1, R-2.
12. **Increase SEAL threshold above 1** for production deployments. Fixes D-6.
13. **Zero sensitive buffers after use** where possible (plaintext, key material). Fixes I-6.

### P3 -- Defense in Depth

14. **Run sidecar in a minimal container** with no network egress except to known SEAL, Walrus, Enoki, and Sui RPC endpoints.
15. **Add a `/walrus/upload` metadata retry mechanism** or make the upload atomic (fail if metadata cannot be set). Fixes T-4.
16. **Consider replacing HTTP with Unix domain socket** for Rust <-> sidecar communication. Eliminates TCP exposure entirely.
