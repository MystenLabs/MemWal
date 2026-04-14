# MemWal Sidecar Server -- STRIDE Threat Model

**Date:** 2026-04-02
**Scope:** `services/server/scripts/sidecar-server.ts` and supporting modules `seal-encrypt.ts`, `seal-decrypt.ts`
**Commit:** 5bb1669
**Server:** Express.js on port 9000, spawned as child process of the Rust relayer

---

## 1. Service Overview

The sidecar is an Express.js HTTP server that exists because SEAL encryption, SEAL decryption, and Walrus blob uploads depend on TypeScript-only SDKs (`@mysten/seal`, `@mysten/walrus`) that cannot run natively in Rust. It is started once at Rust server boot and kept alive to avoid Node.js cold-start latency.

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Liveness check (returns uptime) |
| `/seal/encrypt` | POST | SEAL threshold-encrypt plaintext bound to an owner address |
| `/seal/decrypt` | POST | SEAL threshold-decrypt a single blob using a delegate private key |
| `/seal/decrypt-batch` | POST | SEAL threshold-decrypt multiple blobs in one session |
| `/walrus/upload` | POST | Multi-step Walrus blob upload (encode, register, upload, certify, transfer) |
| `/walrus/query-blobs` | POST | Query on-chain Walrus Blob objects owned by a Sui address |
| `/sponsor` | POST | Proxy to Enoki API to create a gas-sponsored transaction |
| `/sponsor/execute` | POST | Proxy to Enoki API to execute a signed sponsored transaction |

### External Dependencies

| Service | Connection | Purpose |
|---------|------------|---------|
| SEAL Key Servers | HTTPS (via `@mysten/seal`) | Threshold key share retrieval for encrypt/decrypt |
| Walrus Upload Relay | HTTPS (`WALRUS_UPLOAD_RELAY_URL`) | Blob data upload and tip configuration |
| Walrus Publisher | HTTPS (via `@mysten/walrus`) | Blob certification |
| Sui JSON-RPC | HTTPS (`getJsonRpcFullnodeUrl()`) | Transaction building, signing, execution, object queries |
| Enoki API | HTTPS (`api.enoki.mystenlabs.com`) | Transaction sponsorship (gas payment) |

---

## 2. Trust Boundaries

```
                  TRUST BOUNDARY 1                 TRUST BOUNDARY 2
                  (No authentication)              (TLS, API key auth)
                        |                                |
  +-------------+       |       +----------+             |       +------------------+
  | Rust Server  |------HTTP--->| Sidecar  |----HTTPS--->|------>| SEAL Key Servers |
  | (port 8000)  |  plaintext   | (port    |             |       +------------------+
  | Auth verified|  JSON with   |  9000)   |----HTTPS--->|------>| Walrus Relay     |
  +-------------+  private keys |          |             |       +------------------+
                        |       |          |----HTTPS--->|------>| Sui RPC          |
  +-------------+       |       |          |             |       +------------------+
  | Any network  |------HTTP--->|          |----HTTPS--->|------>| Enoki API        |
  | process      |  (0.0.0.0)  +----------+             |       +------------------+
  +-------------+       |                                |
```

### TB1: Rust Server <-> Sidecar (localhost HTTP, no auth)
- **Current state:** Fully trusted. No shared secret, no mTLS, no IP restriction.
- **Risk:** Any process on the host (or network, since binding is 0.0.0.0) can call all sidecar endpoints.
- **Code:** `sidecar-server.ts:811` -- `app.listen(PORT)` binds all interfaces. Lines 273-285 set `Access-Control-Allow-Origin: *`.

### TB2: Sidecar <-> SEAL Key Servers (HTTPS, unverified)
- **Current state:** TLS transport but `verifyKeyServers: false` at line 67.
- **Risk:** SEAL key server identity is not cryptographically verified. MitM can impersonate a key server.

### TB3: Sidecar <-> Walrus Upload Relay (HTTPS)
- **Current state:** Standard HTTPS to `WALRUS_UPLOAD_RELAY_URL`. Tip address fetched from relay.
- **Risk:** Relay tip address is cached after first fetch (line 157). DNS or relay compromise could redirect tips.

### TB4: Sidecar <-> Sui RPC (HTTPS)
- **Current state:** Standard HTTPS to Sui fullnode. Transactions signed locally, submitted via RPC.
- **Risk:** Standard RPC trust model. Fullnode could censor or reorder transactions.

### TB5: Sidecar <-> Enoki API (HTTPS, Bearer token)
- **Current state:** Authenticated via `ENOKI_API_KEY` Bearer token (line 179).
- **Risk:** API key in memory for process lifetime. Unauthenticated `/sponsor` endpoints proxy directly to Enoki.

---

## 3. Data Flow Diagrams

### 3.1 POST /seal/encrypt

```
Client (Rust Server)
  |
  |  POST /seal/encrypt
  |  Body: { data: base64, owner: "0x...", packageId: "0x..." }
  v
[sidecar-server.ts:295-316]
  |
  |  1. Decode base64 -> plaintext (line 302)
  |  2. sealClient.encrypt({ threshold:1, packageId, id:owner, data }) (line 303-308)
  |     |
  |     +---> SEAL Key Servers (HTTPS, verifyKeyServers:false)
  |           - Derive encryption key from packageId + owner
  |           - Return encrypted object bytes
  |
  |  3. Base64-encode result (line 310)
  v
Response: { encryptedData: base64 }
```

### 3.2 POST /seal/decrypt

```
Client (Rust Server)
  |
  |  POST /seal/decrypt
  |  Body: { data: base64, privateKey: "suiprivkey1...", packageId: "0x...", accountId: "0x..." }
  v
[sidecar-server.ts:321-391]
  |
  |  1. Decode private key -> Ed25519Keypair (lines 329-337)
  |  2. Parse EncryptedObject to extract SEAL key ID (lines 341-343)
  |  3. Create SessionKey (ttlMin:30) signed by delegate keypair (lines 351-357)
  |     +---> Sui RPC (build transaction)
  |  4. Build seal_approve Move call PTB (lines 360-368)
  |     +---> Sui RPC (build transaction bytes)
  |  5. sealClient.fetchKeys({ ids, txBytes, sessionKey, threshold:1 }) (lines 371-376)
  |     +---> SEAL Key Servers
  |           - Verify session key
  |           - Execute seal_approve (policy check: is delegate authorized?)
  |           - Return key shares if authorized
  |  6. sealClient.decrypt({ data, sessionKey, txBytes }) (lines 379-383)
  |     - Local decryption using fetched key shares
  |  7. Base64-encode result (line 385)
  v
Response: { decryptedData: base64 }

SENSITIVE DATA IN FLIGHT: delegate private key in HTTP body (plaintext)
```

### 3.3 POST /seal/decrypt-batch

```
Client (Rust Server)
  |
  |  POST /seal/decrypt-batch
  |  Body: { items: [base64, ...], privateKey, packageId, accountId }
  v
[sidecar-server.ts:398-498]
  |
  |  1. Decode private key -> Ed25519Keypair (lines 409-416)
  |  2. Parse ALL encrypted objects, collect unique SEAL IDs (lines 423-431)
  |     - No limit on items array size
  |  3. Create ONE SessionKey (lines 441-447)
  |  4. Build ONE PTB with seal_approve for ALL IDs (lines 450-463)
  |  5. ONE fetchKeys call for all IDs (lines 466-470)
  |     +---> SEAL Key Servers (single round-trip)
  |  6. Decrypt each blob sequentially (lines 476-489)
  v
Response: { results: [{index, decryptedData}], errors: [{index, error}] }
```

### 3.4 POST /walrus/upload

```
Client (Rust Server)
  |
  |  POST /walrus/upload
  |  Body: { data: base64, privateKey: "suiprivkey1...", owner: "0x...",
  |          namespace: "...", packageId: "0x...", epochs: N }
  v
[sidecar-server.ts:503-634]
  |
  |  1. Decode server wallet private key -> Ed25519Keypair (lines 518-519)
  |  2. runExclusiveBySigner: serialize uploads per signer address (line 522)
  |  3. walrusClient.writeBlobFlow (line 526)
  |     a. flow.encode() -- erasure-encode blob (line 527)
  |     b. flow.register({ epochs, owner:signerAddress, deletable:true }) (lines 529-540)
  |        - Build registration Transaction with metadata attributes
  |     c. patchGasCoinIntents(registerTx) (line 545)
  |     d. executeWithEnokiSponsor(registerTx, signer) (line 548)
  |        +---> Enoki API: POST /transaction-blocks/sponsor (line 208)
  |        +---> Enoki API: POST /transaction-blocks/sponsor/{digest} (line 219)
  |        +---> [fallback] suiClient.signAndExecuteTransaction (line 236)
  |     e. flow.upload({ digest }) (line 551) -> Walrus Upload Relay
  |     f. flow.certify() (line 553)
  |        +---> executeWithEnokiSponsor(certifyTx) -> Enoki/Sui
  |  4. If owner != signerAddress: metadata set + transferObjects (lines 574-624)
  |     +---> executeWithEnokiSponsor(metaTx) -> Enoki/Sui
  v
Response: { blobId, objectId }

SENSITIVE DATA: Server wallet private key in HTTP body
FINANCIAL IMPACT: Each upload costs SUI (gas) + WAL (storage) + relay tip
```

### 3.5 POST /walrus/query-blobs

```
Client (Rust Server)
  |
  |  POST /walrus/query-blobs
  |  Body: { owner: "0x...", namespace?: "...", packageId?: "0x..." }
  v
[sidecar-server.ts:640-747]
  |
  |  1. Paginated suiClient.getOwnedObjects (lines 657-667)
  |     +---> Sui RPC (multiple pages, limit:50 each)
  |  2. For each blob object:
  |     a. Extract blob_id from Move object fields (lines 676-677)
  |     b. getDynamicFieldObject for metadata (lines 684-710)
  |        +---> Sui RPC
  |     c. Filter by namespace and packageId (lines 714-715)
  |     d. Convert numeric blob_id -> base64url (lines 722-733)
  v
Response: { blobs: [{blobId, objectId, namespace, packageId}], total }

INFO DISCLOSURE: Enumerates all Walrus blobs for any owner address
```

### 3.6 POST /sponsor

```
Client (any -- UNAUTHENTICATED)
  |
  |  POST /sponsor
  |  Body: { transactionBlockKindBytes: base64, sender: "0x..." }
  v
[sidecar-server.ts:753-776]
  |
  |  1. Validate required fields (lines 755-757)
  |  2. callEnoki("/transaction-blocks/sponsor", {...}) (lines 764-769)
  |     +---> Enoki API (Bearer: ENOKI_API_KEY)
  |     - Enoki pays gas for arbitrary transaction
  v
Response: { bytes, digest }

NO AUTH: Anyone who can reach port 9000 can sponsor arbitrary transactions
```

### 3.7 POST /sponsor/execute

```
Client (any -- UNAUTHENTICATED)
  |
  |  POST /sponsor/execute
  |  Body: { digest: "...", signature: "..." }
  v
[sidecar-server.ts:782-804]
  |
  |  1. Validate required fields (lines 784-787)
  |  2. callEnoki("/transaction-blocks/sponsor/{digest}", {...}) (lines 793-797)
  |     +---> Enoki API (Bearer: ENOKI_API_KEY)
  v
Response: { digest }

NO AUTH: Completes execution of any previously sponsored transaction
```

---

## 4. Assets

| Asset | Location | Sensitivity | Protection |
|-------|----------|-------------|------------|
| **Server wallet private keys** (`SERVER_SUI_PRIVATE_KEYS`) | Sent per-request in HTTP body to `/walrus/upload` (`walrus.rs:80-81`, `sidecar-server.ts:517-519`) | CRITICAL -- controls SUI funds for storage payments | None beyond process isolation. Keys transit plaintext HTTP. |
| **Delegate private keys** | Sent per-request in HTTP body to `/seal/decrypt`, `/seal/decrypt-batch` (`seal.rs:109`, `sidecar-server.ts:324,404`) | HIGH -- enables SEAL decryption of user memories | None. Keys originate from `x-delegate-key` HTTP header (SDK->Rust->Sidecar). |
| **Enoki API key** (`ENOKI_API_KEY`) | Process env var, used in `Authorization: Bearer` header (`sidecar-server.ts:124,179`) | HIGH -- controls sponsorship budget; theft enables gas draining | Standard env var protection. Never sent to clients. |
| **SEAL key server object IDs** (`SEAL_KEY_SERVERS`) | Process env var, configured in `SealClient` (`sidecar-server.ts:32-38,61-68`) | MEDIUM -- identifies threshold key servers | Not secret per se, but combined with `verifyKeyServers:false` allows substitution. |
| **Encrypted user data** | Transits through sidecar as base64 in request/response bodies | HIGH -- user memories (plaintext during encrypt, ciphertext during decrypt) | In-memory only during request lifecycle. No disk persistence. |
| **Decrypted user data** | Returned in response bodies from `/seal/decrypt`, `/seal/decrypt-batch` | CRITICAL -- plaintext user memories | Plaintext HTTP response. In-memory during request. |
| **Walrus blob metadata** | On-chain (owner, namespace, packageId attributes) | LOW-MEDIUM -- reveals which addresses use MemWal and namespace structure | Public on Sui chain by design. |
| **Sui JSON-RPC endpoint** | Process env / hardcoded (`sidecar-server.ts:29,57`) | LOW -- public infrastructure | N/A |

---

## 5. STRIDE Analysis

### 5.1 Trust Boundary: Rust Server <-> Sidecar (TB1)

| Threat | Category | Description | Affected Code | Severity |
|--------|----------|-------------|---------------|----------|
| **T1** | **Spoofing** | Any process on the network can impersonate the Rust server. No shared secret, no client certificate, no IP allowlist. The sidecar cannot distinguish legitimate Rust server requests from malicious ones. | `sidecar-server.ts:273-285` (no auth middleware), `sidecar-server.ts:811` (binds 0.0.0.0) | CRITICAL |
| **T2** | **Tampering** | An attacker on the same network segment can modify requests in transit (HTTP, not HTTPS). Could alter `owner` in encrypt requests to encrypt under a different identity, or alter `privateKey` in decrypt requests. | `sidecar-server.ts:295-316` (encrypt), `sidecar-server.ts:321-391` (decrypt) | HIGH |
| **T3** | **Information Disclosure** | Private keys (server wallet, delegate keys) are sent as plaintext HTTP JSON. Any network sniffer on localhost or (due to 0.0.0.0 binding) the LAN can capture them. | `walrus.rs:80-81` sends `sui_private_key`, `seal.rs:109` sends `private_key` | CRITICAL |
| **T4** | **Denial of Service** | 50MB JSON body limit (line 274) across all endpoints. Attacker sends large payloads to exhaust Node.js heap. `/seal/decrypt-batch` has no array size limit (line 398). | `sidecar-server.ts:274,398` | HIGH |
| **T5** | **Elevation of Privilege** | Unauthenticated access to `/walrus/upload` allows spending server wallet funds. Unauthenticated `/sponsor` allows draining Enoki sponsorship budget. | `sidecar-server.ts:503,753,782` | CRITICAL |

### 5.2 Trust Boundary: Sidecar <-> SEAL Key Servers (TB2)

| Threat | Category | Description | Affected Code | Severity |
|--------|----------|-------------|---------------|----------|
| **T6** | **Spoofing** | `verifyKeyServers: false` disables cryptographic verification of SEAL key server identity. A MitM or DNS poisoning attack can substitute a rogue server that returns attacker-controlled key shares. | `sidecar-server.ts:67`, `seal-encrypt.ts:96`, `seal-decrypt.ts:117` | HIGH |
| **T7** | **Information Disclosure** | Threshold of 1 means compromising any single key server (of potentially 3+) yields all key material needed to decrypt any memory. No redundancy benefit. | `sidecar-server.ts:303` (encrypt threshold:1), `sidecar-server.ts:375` (decrypt threshold:1) | MEDIUM |
| **T8** | **Tampering** | A rogue SEAL key server could return manipulated key shares, causing encrypt to produce ciphertext decryptable by the attacker, or causing decrypt to silently fail. | `sidecar-server.ts:303-308` (encrypt call), `sidecar-server.ts:371-383` (fetchKeys + decrypt) | HIGH |

### 5.3 Trust Boundary: Sidecar <-> Walrus (TB3)

| Threat | Category | Description | Affected Code | Severity |
|--------|----------|-------------|---------------|----------|
| **T9** | **Tampering** | Walrus upload relay tip address is fetched once and cached indefinitely (`uploadRelayTipAddressCache`, line 157). If the relay is compromised during that first fetch, all subsequent tips go to the attacker's address. | `sidecar-server.ts:143-168` (`getUploadRelayTipAddress`) | MEDIUM |
| **T10** | **Denial of Service** | Walrus upload relay downtime blocks all blob uploads. The `writeBlobFlow` is a multi-step stateful process (encode -> register -> upload -> certify); failure at any step leaves partial state. | `sidecar-server.ts:526-558` | MEDIUM |
| **T11** | **Repudiation** | Blob upload success is returned even if the metadata-set + transfer transaction fails (lines 620-624). The server reports success, but the blob is stuck on the server wallet. No audit trail of the partial failure is returned to the caller. | `sidecar-server.ts:620-624` | LOW |

### 5.4 Trust Boundary: Sidecar <-> Enoki API (TB5)

| Threat | Category | Description | Affected Code | Severity |
|--------|----------|-------------|---------------|----------|
| **T12** | **Spoofing** | `/sponsor` accepts arbitrary `sender` addresses. An attacker can sponsor transactions under any Sui address identity, consuming the MemWal project's Enoki sponsorship quota. | `sidecar-server.ts:753-776` | HIGH |
| **T13** | **Elevation of Privilege** | `/sponsor` proxies arbitrary `transactionBlockKindBytes` to Enoki with no validation of the transaction content. Attacker can sponsor any Move call, not just MemWal operations. | `sidecar-server.ts:764-769` | HIGH |
| **T14** | **Denial of Service** | Enoki sponsorship budget is finite. Automated requests to `/sponsor` can exhaust the budget, blocking legitimate Walrus uploads that depend on Enoki gas sponsorship. | `sidecar-server.ts:753-776`, `sidecar-server.ts:193-242` (`executeWithEnokiSponsor`) | HIGH |
| **T15** | **Information Disclosure** | `digest` parameter in `/sponsor/execute` is interpolated directly into Enoki API URL path (line 793: `` `/transaction-blocks/sponsor/${digest}` ``). Crafted digest could cause path traversal in the Enoki API request. | `sidecar-server.ts:219,793` | LOW |

### 5.5 Per-Endpoint Analysis

#### /seal/encrypt (lines 295-316)

| Threat | Category | Description | Severity |
|--------|----------|-------------|----------|
| **T16** | Tampering | Attacker calls encrypt with their own `owner` address, producing ciphertext that they can later decrypt. Not directly exploitable since encryption alone does not grant access to existing data, but could be used to "wrap" data under a different identity. | LOW |
| **T17** | DoS | No rate limiting. Large `data` payloads (up to 50MB) trigger CPU-intensive SEAL encryption. | MEDIUM |

#### /seal/decrypt and /seal/decrypt-batch (lines 321-498)

| Threat | Category | Description | Severity |
|--------|----------|-------------|----------|
| **T18** | Information Disclosure | Private key in request body is held in Express `req.body` for the request duration, visible in heap dumps, potentially logged by error middleware. | HIGH |
| **T19** | DoS | `/seal/decrypt-batch` has no limit on `items` array. 1000 items = 1000 EncryptedObject.parse + 1000 decrypt operations + SEAL key server load. | HIGH |
| **T20** | Tampering | Raw hex key parsing (lines 335-336, 414-415) uses `parseInt(b, 16)` which returns `NaN` for invalid hex. This creates an invalid keypair silently rather than failing fast. | LOW |

#### /walrus/upload (lines 503-634)

| Threat | Category | Description | Severity |
|--------|----------|-------------|----------|
| **T21** | Elevation of Privilege | Server wallet private key received in body. If sidecar is compromised, attacker extracts all server wallet keys from incoming requests. | CRITICAL |
| **T22** | Tampering | `owner` address not validated (line 513). Attacker specifies any Sui address to receive blob objects paid by server wallet. | HIGH |
| **T23** | DoS | `epochs` parameter unbounded (line 511). High epoch count = high SUI storage cost charged to server wallet. Default is 3 (mainnet) or 50 (testnet). | MEDIUM |
| **T24** | Repudiation | If metadata+transfer fails (line 620-624), blob is uploaded and paid for but stays on server wallet. Caller gets success response with blobId. No indication of transfer failure. | MEDIUM |

#### /walrus/query-blobs (lines 640-747)

| Threat | Category | Description | Severity |
|--------|----------|-------------|----------|
| **T25** | Information Disclosure | Enumerates all Walrus blob objects for any Sui address. No authentication required. Reveals which addresses use MemWal, their namespaces, and blob counts. | MEDIUM |
| **T26** | DoS | Paginated Sui RPC queries with no timeout. An address with thousands of blob objects triggers many RPC calls, each with a getDynamicFieldObject sub-call. | MEDIUM |

#### /sponsor and /sponsor/execute (lines 753-804)

| Threat | Category | Description | Severity |
|--------|----------|-------------|----------|
| **T27** | Spoofing/EoP | Completely unauthenticated. Any caller can sponsor and execute arbitrary transactions using the project's Enoki API key. | CRITICAL |
| **T28** | DoS | Budget exhaustion via automated sponsor requests. No rate limiting, no per-sender caps. | HIGH |

---

## 6. Attack Scenarios

### Scenario 1: Sidecar Network Exposure -- Full Compromise

**Precondition:** Sidecar binds to 0.0.0.0 (line 811). Attacker is on the same network segment (co-located VM, container escape, cloud VPC peer).

**Steps:**
1. Attacker scans for port 9000 on the target host.
2. Attacker calls `GET /health` to confirm the sidecar is running and identify uptime.
3. Attacker calls `POST /sponsor` with a crafted `transactionBlockKindBytes` that transfers SUI from a user wallet to the attacker's address. Enoki sponsors the gas.
4. Attacker calls `POST /sponsor/execute` with the user's signature (obtained separately or if the attacker IS the user trying to get free gas).
5. Alternatively, attacker calls `POST /walrus/upload` with a known server wallet `privateKey` (obtained from step 6) and `owner` set to the attacker's address, causing the server to pay for blob storage and transfer the blob to the attacker.
6. Attacker sends repeated requests to `/seal/decrypt` with different `data` payloads, observing error messages to enumerate valid encrypted objects.

**Impact:** Enoki budget drained. Server wallet funds spent. Attacker can sponsor arbitrary transactions at MemWal's expense.

### Scenario 2: Server Wallet Key Theft via Sidecar Compromise

**Precondition:** Attacker gains code execution in the sidecar process (e.g., via supply chain attack on `@mysten/seal`, `@mysten/walrus`, or Express dependency).

**Steps:**
1. Attacker modifies the `/walrus/upload` handler to log incoming `privateKey` values to an external endpoint.
2. Every subsequent Walrus upload from the Rust server sends one of the `SERVER_SUI_PRIVATE_KEYS` in the request body (`walrus.rs:80-81`).
3. Attacker collects all server wallet private keys over time.
4. Attacker uses stolen keys to sign arbitrary Sui transactions, draining all SUI and WAL tokens from server wallets.

**Impact:** Complete loss of server wallet funds. All future Walrus uploads fail. On-chain blob objects controlled by these keys can be deleted (blobs were registered as `deletable: true` at line 534).

### Scenario 3: Gas Draining via Unauthenticated Sponsor Proxy

**Precondition:** Sidecar reachable (even just from localhost by a co-located process).

**Steps:**
1. Attacker crafts a TransactionKind that performs expensive on-chain operations (many Move calls, large object creation).
2. Attacker sends `POST /sponsor` with the crafted bytes and their own `sender` address.
3. Enoki API sponsors the transaction (gas paid from MemWal's Enoki budget).
4. Attacker signs and submits via `POST /sponsor/execute`.
5. Repeat in a loop. No rate limiting exists.
6. Within minutes to hours, the Enoki sponsorship budget is exhausted.
7. Legitimate Walrus uploads that depend on `executeWithEnokiSponsor()` (line 193) now fail.
8. If `ENOKI_FALLBACK_TO_DIRECT_SIGN` is true (default, line 128-131), uploads fall back to direct signing, spending server wallet SUI for gas.

**Impact:** Sponsorship budget exhausted. Legitimate operations degrade to direct-pay mode, accelerating server wallet depletion.

### Scenario 4: Rogue SEAL Key Server (MitM)

**Precondition:** `verifyKeyServers: false` (line 67). Attacker can perform DNS spoofing or BGP hijack to intercept traffic between sidecar and a SEAL key server.

**Steps:**
1. Attacker sets up a rogue SEAL key server that mimics the API of a legitimate one.
2. Attacker poisons DNS to redirect one of the SEAL key server hostnames to their server.
3. Because `verifyKeyServers: false`, the `SealClient` does not verify the key server's on-chain identity.
4. During encrypt (line 303), the rogue server participates in key generation, learning or controlling the encryption key.
5. During decrypt (line 371-376 `fetchKeys`), the rogue server can return valid-looking key shares that are actually attacker-controlled, or simply log the session key and encrypted data.
6. With `threshold: 1`, only one server needs to be compromised for full decryption capability.

**Impact:** All memories encrypted after the compromise can be decrypted by the attacker. If the rogue server also logs the encrypted data and session keys during decrypt flows, existing memories are also exposed.

### Scenario 5: Delegate Key Interception

**Precondition:** Network observer on the path between Rust server and sidecar (trivially possible since it is plaintext HTTP, and if sidecar binds 0.0.0.0, the traffic may traverse a network).

**Steps:**
1. Attacker captures HTTP traffic between Rust server (port 8000) and sidecar (port 9000).
2. Every `/seal/decrypt` and `/seal/decrypt-batch` request body contains the user's delegate `privateKey` (lines 324, 404).
3. Attacker extracts delegate private keys for all active users.
4. Using a stolen delegate key, attacker can independently create SessionKeys and call SEAL key servers to decrypt any memory belonging to that user's MemWalAccount.
5. Attacker does not even need to go through the sidecar; they can use the SEAL SDK directly.

**Impact:** Mass compromise of user delegate keys. All memories for affected users can be decrypted indefinitely (until the user deactivates their account or removes the delegate key on-chain).

### Scenario 6: Batch Decrypt Resource Exhaustion

**Precondition:** Sidecar reachable.

**Steps:**
1. Attacker sends `POST /seal/decrypt-batch` with `items` array containing 10,000 entries of valid-looking base64 data.
2. The sidecar attempts to parse all 10,000 `EncryptedObject` entries (lines 423-431) -- CPU intensive.
3. Even if most fail parsing, the successful ones trigger SEAL key server calls (line 466-470) and individual decrypt operations (lines 476-489).
4. Node.js single-threaded event loop is blocked during CPU-intensive crypto operations.
5. All other sidecar endpoints become unresponsive, blocking Walrus uploads and SEAL operations for legitimate users.
6. 50MB body limit allows each request to carry substantial data.

**Impact:** Complete sidecar denial of service. All MemWal operations that depend on the sidecar are blocked.

---

## 7. Threat Matrix

| ID | Threat | Category | Trust Boundary | Likelihood | Impact | Risk Rating |
|----|--------|----------|----------------|------------|--------|-------------|
| T1 | No authentication on sidecar endpoints | Spoofing | TB1 (Rust<->Sidecar) | HIGH (0.0.0.0 binding) | CRITICAL (full access to all operations) | **CRITICAL** |
| T2 | HTTP request tampering (no TLS) | Tampering | TB1 | MEDIUM (requires network position) | HIGH (alter encryption identity, keys) | **HIGH** |
| T3 | Private keys in plaintext HTTP | Info Disclosure | TB1 | HIGH (trivial sniffing if 0.0.0.0) | CRITICAL (server wallet + delegate keys) | **CRITICAL** |
| T4 | 50MB body + unlimited batch array | DoS | TB1 | HIGH (no auth needed) | HIGH (sidecar unresponsive) | **HIGH** |
| T5 | Unauthenticated access to privileged ops | EoP | TB1 | HIGH (no auth) | CRITICAL (spend funds, drain budget) | **CRITICAL** |
| T6 | SEAL key server identity not verified | Spoofing | TB2 (Sidecar<->SEAL) | LOW (requires MitM/DNS) | CRITICAL (all encryption compromised) | **HIGH** |
| T7 | Threshold=1 eliminates redundancy | Info Disclosure | TB2 | LOW (requires server compromise) | HIGH (single server = all decryption) | **MEDIUM** |
| T8 | Rogue SEAL server returns bad shares | Tampering | TB2 | LOW (requires MitM/DNS) | CRITICAL (attacker-controlled encryption) | **HIGH** |
| T9 | Cached tip address from relay | Tampering | TB3 (Sidecar<->Walrus) | LOW (relay compromise at boot) | MEDIUM (tips redirected) | **LOW** |
| T10 | Walrus relay downtime blocks uploads | DoS | TB3 | MEDIUM (external dependency) | MEDIUM (uploads fail) | **MEDIUM** |
| T11 | Silent metadata/transfer failure | Repudiation | TB3 | MEDIUM (tx failures happen) | LOW (blob stuck on server) | **LOW** |
| T12 | Arbitrary sender in /sponsor | Spoofing | TB5 (Sidecar<->Enoki) | HIGH (no auth) | HIGH (budget abuse) | **HIGH** |
| T13 | Arbitrary tx content in /sponsor | EoP | TB5 | HIGH (no auth) | HIGH (sponsor any Move call) | **HIGH** |
| T14 | Enoki budget exhaustion | DoS | TB5 | HIGH (automated, no rate limit) | HIGH (all sponsored ops fail) | **HIGH** |
| T15 | Digest path injection in Enoki URL | Tampering | TB5 | LOW (Enoki likely validates) | LOW (path traversal attempt) | **LOW** |
| T16 | Encrypt under arbitrary owner | Tampering | Endpoint | LOW (limited exploitability) | LOW (no access to existing data) | **LOW** |
| T17 | Large payload SEAL encrypt DoS | DoS | Endpoint | MEDIUM (50MB limit) | MEDIUM (CPU exhaustion) | **MEDIUM** |
| T18 | Private key in req.body memory | Info Disclosure | Endpoint | MEDIUM (heap dump/debug) | HIGH (key exposure) | **HIGH** |
| T19 | Unbounded decrypt-batch array | DoS | Endpoint | HIGH (no limit, no auth) | HIGH (sidecar blocked) | **HIGH** |
| T20 | Invalid hex key parsed silently | Tampering | Endpoint | LOW (causes error downstream) | LOW (no security bypass) | **LOW** |
| T21 | Server wallet key theft via sidecar | Info Disclosure | Endpoint | MEDIUM (requires code exec) | CRITICAL (all funds at risk) | **CRITICAL** |
| T22 | Arbitrary owner in walrus/upload | Tampering | Endpoint | HIGH (no auth, no validation) | HIGH (server pays, attacker receives) | **HIGH** |
| T23 | Unbounded epochs cost amplification | DoS | Endpoint | HIGH (no auth, no cap) | MEDIUM (increased storage cost) | **HIGH** |
| T24 | Partial upload success without transfer | Repudiation | Endpoint | MEDIUM (tx can fail) | LOW (blob on wrong wallet) | **LOW** |
| T25 | Blob enumeration for any address | Info Disclosure | Endpoint | HIGH (no auth) | MEDIUM (usage/namespace leak) | **MEDIUM** |
| T26 | Paginated RPC query resource exhaustion | DoS | Endpoint | MEDIUM (needs large account) | MEDIUM (slow response) | **MEDIUM** |
| T27 | Unauthenticated sponsor proxy | Spoofing/EoP | Endpoint | HIGH (no auth, public) | CRITICAL (arbitrary sponsored tx) | **CRITICAL** |
| T28 | Sponsor budget drain via automation | DoS | Endpoint | HIGH (trivially scriptable) | HIGH (ops degraded) | **HIGH** |

### Risk Summary

| Risk Rating | Count | Threat IDs |
|-------------|-------|------------|
| **CRITICAL** | 5 | T1, T3, T5, T21, T27 |
| **HIGH** | 11 | T2, T4, T6, T8, T12, T13, T14, T18, T19, T22, T23, T28 |
| **MEDIUM** | 5 | T7, T10, T17, T25, T26 |
| **LOW** | 7 | T9, T11, T15, T16, T20, T24 |

### Recommended Remediation Priority

| Priority | Action | Threats Mitigated | Effort |
|----------|--------|-------------------|--------|
| **P0** | Bind sidecar to `127.0.0.1` (`app.listen(PORT, "127.0.0.1")`) | T1, T2, T3, T5 (reduces likelihood from HIGH to LOW for network-based attacks) | 1 line change at `sidecar-server.ts:811` |
| **P0** | Add shared secret authentication (e.g., `X-Sidecar-Secret` header verified against env var) | T1, T4, T5, T12, T13, T14, T19, T22, T23, T25, T27, T28 | ~20 lines middleware |
| **P0** | Load server wallet keys from env at boot; pass key index in request body instead of key material | T3, T21 | Medium refactor of `walrus.rs` + `sidecar-server.ts` |
| **P1** | Move `/sponsor` and `/sponsor/execute` behind Rust server authentication | T12, T13, T14, T27, T28 | Route restructuring |
| **P1** | Set `verifyKeyServers: true` | T6, T8 | 1 line x 3 files |
| **P1** | Remove CORS headers from sidecar (only Rust server calls it) | T1 (browser vector) | Delete lines 277-285 |
| **P2** | Cap `items` array in `/seal/decrypt-batch` (e.g., max 100) | T19 | 3 lines |
| **P2** | Cap `epochs` parameter (e.g., max 10 on mainnet) | T23 | 3 lines |
| **P2** | Reduce body limit from 50MB to 10MB | T4, T17 | 1 line |
| **P2** | Increase SEAL threshold to 2 | T7 | 1 line x 3 files |
| **P2** | Validate address format for `owner`, `packageId`, `accountId` | T16, T22 | ~15 lines |
| **P3** | Reduce SessionKey TTL from 30 to 5 minutes | T18 | 1 line x 2 |
| **P3** | Sanitize error responses (generic messages to client, details to logs) | T18 (info disclosure via errors) | ~20 lines |
| **P3** | Validate `digest` format before URL interpolation | T15 | 2 lines |
