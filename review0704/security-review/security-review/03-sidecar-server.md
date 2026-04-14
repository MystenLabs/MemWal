# Sidecar Server Security Review

**Date:** 2026-04-02
**Scope:** TypeScript sidecar server (`sidecar-server.ts`, `seal-encrypt.ts`, `seal-decrypt.ts`) and its integration with the Rust server
**Commit:** 5bb1669
**Reviewer:** Code-level security analysis

---

## 1. Authentication and Access Control

### Finding S1: Zero Authentication on All Sidecar Endpoints
- **Severity:** HIGH
- **Confidence:** 10/10
- **Affected lines:** `sidecar-server.ts:273-285` (Express app setup), all route handlers
- **Description:** The sidecar has no authentication mechanism whatsoever. No API key, no shared secret, no mTLS, no IP allowlist. Every endpoint -- `/seal/encrypt`, `/seal/decrypt`, `/seal/decrypt-batch`, `/walrus/upload`, `/walrus/query-blobs`, `/sponsor`, `/sponsor/execute`, `/health` -- is callable by any process that can reach the port.
- **Impact:** Any network-adjacent process can encrypt under arbitrary identities, decrypt data (given a delegate key), upload blobs spending the server's SUI/WAL tokens, drain the Enoki sponsorship budget, and query any user's on-chain blob inventory.
- **Relationship to existing audit:** Confirms and expands **Vuln 3**. Adds that `/walrus/query-blobs` and `/seal/decrypt-batch` (not mentioned in the original audit) are also exposed.
- **Remediation:** Add a shared secret header (e.g., `X-Sidecar-Secret` checked against an env var). Alternatively, use Unix domain sockets.

---

## 2. CORS Configuration

### Finding S2: Wildcard CORS on Sidecar
- **Severity:** MEDIUM
- **Confidence:** 9/10
- **Affected lines:** `sidecar-server.ts:277-285`
- **Description:** The sidecar sets `Access-Control-Allow-Origin: *` on every response via manual middleware.
- **Impact:** If the sidecar port is reachable from a browser, any webpage can make cross-origin requests to all sidecar endpoints. Combined with S1 (no auth), this enables browser-based attacks.
- **Relationship to existing audit:** Confirms **Vuln 6** for the sidecar.
- **Remediation:** Remove CORS headers entirely (sidecar should only be called by the co-located Rust server, never by browsers).

---

## 3. SEAL Encrypt/Decrypt Flow

### Finding S3: `verifyKeyServers: false` in All SEAL Client Instances
- **Severity:** HIGH
- **Confidence:** 8/10
- **Affected lines:** `sidecar-server.ts:67`, `seal-encrypt.ts:96`, `seal-decrypt.ts:117`
- **Description:** Every SEAL client is instantiated with `verifyKeyServers: false`, disabling cryptographic verification of SEAL key server identity.
- **Impact:** MitM or DNS poisoning between the sidecar and SEAL key server endpoints can substitute a rogue server, obtain decryption keys, and decrypt all SEAL-encrypted memories.
- **Relationship to existing audit:** Confirms **Vuln 5** exactly.
- **Remediation:** Set `verifyKeyServers: true` in all three files. One-line change per file.

### Finding S4: Threshold 1 Eliminates Threshold Security Benefits
- **Severity:** MEDIUM
- **Confidence:** 7/10
- **Affected lines:** `sidecar-server.ts:303` (encrypt), `sidecar-server.ts:375` (decrypt fetchKeys), `sidecar-server.ts:469` (batch fetchKeys), `seal-encrypt.ts:101`, `seal-decrypt.ts:155`
- **Description:** All encrypt and decrypt operations use `threshold: 1`, meaning only a single key server needs to provide its shard for decryption to succeed. Compromising any single key server breaks all encryption.
- **Remediation:** Increase the threshold to at least 2 (for a typical 3-server setup).

### Finding S5: Private Key Received Over HTTP in Decrypt Endpoints
- **Severity:** HIGH
- **Confidence:** 10/10
- **Affected lines:** `sidecar-server.ts:324` (decrypt), `sidecar-server.ts:404` (decrypt-batch), `sidecar-server.ts:517` (walrus/upload)
- **Description:** The `/seal/decrypt`, `/seal/decrypt-batch`, and `/walrus/upload` endpoints receive private key material in the JSON request body. The Rust server sends the user's delegate private key (from `x-delegate-key` header) and its own server SUI private key to the sidecar over HTTP.
- **Impact:** Key material is held in Express request objects in memory, potentially logged by middleware or error handlers, visible in Node.js heap dumps, and transmitted as plaintext HTTP.
- **Relationship to existing audit:** Extends **Vuln 1** and **Vuln 3**.
- **Remediation:** For the server wallet key, have the sidecar load `SERVER_SUI_PRIVATE_KEYS` from env vars at startup. For delegate keys, push SEAL decryption to the client.

### Finding S6: Dual Private Key Format Parsing Without Validation
- **Severity:** LOW
- **Confidence:** 7/10
- **Affected lines:** `sidecar-server.ts:329-337`, `sidecar-server.ts:409-416`
- **Description:** The decrypt endpoints accept private keys in bech32 and raw hex formats. The raw hex path uses `parseInt(b, 16)` which returns `NaN` for invalid hex, producing `NaN` bytes in key material.
- **Remediation:** Validate that hex strings are exactly 64 characters and contain only hex digits.

### Finding S7: SessionKey TTL of 30 Minutes is Generous
- **Severity:** LOW
- **Confidence:** 6/10
- **Affected lines:** `sidecar-server.ts:354` (decrypt), `sidecar-server.ts:443` (decrypt-batch), `seal-decrypt.ts:134`
- **Description:** Session keys are created with `ttlMin: 30` (30 minutes), far longer than needed for a single decrypt operation that takes seconds.
- **Remediation:** Reduce `ttlMin` to 2-5 minutes.

---

## 4. Walrus Upload/Download -- Key Handling and Transaction Signing

### Finding S8: Server Wallet Private Key Sent Per-Request to Sidecar
- **Severity:** HIGH
- **Confidence:** 10/10
- **Affected lines:** `sidecar-server.ts:513-519` (walrus/upload receives `privateKey`), `walrus.rs:80-81` (Rust server sends `sui_private_key`)
- **Description:** On every Walrus upload, the Rust server sends one of its `SERVER_SUI_PRIVATE_KEYS` to the sidecar in the HTTP request body. The sidecar uses it to sign on-chain transactions.
- **Impact:** Compromise of the sidecar process exposes all server wallet private keys. These keys hold SUI tokens used for Walrus storage payments.
- **Remediation:** Have the sidecar load wallet keys from environment variables at boot. Pass a key identifier in the request body instead of the actual key material.

### Finding S9: No Validation of `owner` Address in Upload
- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Affected lines:** `sidecar-server.ts:503-515`
- **Description:** The `owner` parameter is used as the transfer recipient for the blob object with no validation that it's a valid Sui address. Since the sidecar has no auth (S1), a direct caller can specify any address and receive blob objects paid for by the server's wallet.
- **Remediation:** Validate address format. More importantly, fix S1 (add auth).

### Finding S10: Non-Fatal Metadata/Transfer Failure
- **Severity:** LOW
- **Confidence:** 8/10
- **Affected lines:** `sidecar-server.ts:620-624`
- **Description:** If the metadata-set + transfer transaction fails after a successful upload, the error is caught and logged, but the endpoint returns success with the blob ID. The blob remains owned by the server wallet.
- **Remediation:** Return the error to the caller or include a `transferStatus` field in the response.

---

## 5. Sponsor Proxy

### Finding S11: Unauthenticated Sponsor Endpoints with No Transaction Validation
- **Severity:** HIGH
- **Confidence:** 9/10
- **Affected lines:** `sidecar-server.ts:753-776` (`/sponsor`), `sidecar-server.ts:782-804` (`/sponsor/execute`)
- **Description:** Completely unauthenticated. Accept arbitrary `transactionBlockKindBytes` and `sender` values proxied directly to the Enoki sponsorship API.
- **Relationship to existing audit:** Confirms **Vuln 2**.
- **Remediation:** Move behind authentication. Add transaction operation whitelist. Add per-sender rate limiting.

### Finding S12: Sponsor Digest Parameter Used Unsanitized in URL Path
- **Severity:** LOW
- **Confidence:** 7/10
- **Affected lines:** `sidecar-server.ts:219`, `sidecar-server.ts:793`
- **Description:** The `digest` value is interpolated directly into the Enoki API URL path without format validation.
- **Remediation:** Validate that `digest` matches the expected format before use.

---

## 6. Input Validation

### Finding S13: 50MB JSON Body Limit
- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Affected lines:** `sidecar-server.ts:274`
- **Description:** Express JSON body parser configured with 50MB limit for all endpoints. Multiple concurrent requests could exhaust Node.js heap memory.
- **Remediation:** Reduce to 5-10MB. Consider per-endpoint limits.

### Finding S14: No Array Size Limit on `/seal/decrypt-batch`
- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Affected lines:** `sidecar-server.ts:398-497`
- **Description:** The `items` array has no size limit. Each item triggers base64 decode, EncryptedObject.parse (CPU-intensive), SEAL key server calls (network I/O), and decrypt (CPU-intensive).
- **Remediation:** Add a maximum items limit (e.g., 50-100).

### Finding S15: No Validation of `packageId` Format
- **Severity:** LOW
- **Confidence:** 7/10
- **Affected lines:** `sidecar-server.ts:297-298`, `sidecar-server.ts:361-366`
- **Description:** `packageId` used directly in Move call targets without validation. Malformed values cause transaction build failures with potentially revealing error messages.
- **Remediation:** Validate against `/^0x[a-f0-9]{64}$/i`.

### Finding S16: `epochs` Parameter Accepted Without Bounds
- **Severity:** LOW
- **Confidence:** 7/10
- **Affected lines:** `sidecar-server.ts:511`
- **Description:** A caller could request storage for an extremely large number of epochs, increasing the SUI cost charged to the server wallet.
- **Remediation:** Cap `epochs` at a reasonable maximum.

---

## 7. Error Handling and Information Disclosure

### Finding S17: Internal Error Messages Returned to Clients
- **Severity:** MEDIUM
- **Confidence:** 9/10
- **Affected lines:** All catch blocks (`sidecar-server.ts:314, 389, 496, 632, 745, 774, 801`)
- **Description:** Every catch block returns the raw error message: `res.status(500).json({ error: err.message || String(err) })`. Error messages from `@mysten/seal`, `@mysten/walrus`, `@mysten/sui`, and Enoki may contain internal URLs, object IDs, stack traces, and API keys in error contexts.
- **Remediation:** Return generic error messages. Log details server-side only.

### Finding S18: Console Logging of Sensitive Operations
- **Severity:** LOW
- **Confidence:** 7/10
- **Affected lines:** `sidecar-server.ts:492, 619, 763-770`
- **Description:** Various `console.log` and `console.error` calls include sender addresses, blob object IDs, digest values, and error messages.
- **Remediation:** Use structured logging with configurable log levels.

---

## 8. Network Binding and Exposure

### Finding S19: Express Server Binds to 0.0.0.0 by Default
- **Severity:** HIGH
- **Confidence:** 10/10
- **Affected lines:** `sidecar-server.ts:811`
- **Description:** `app.listen(PORT)` without hostname specification causes Express to bind to all interfaces. No `SIDECAR_HOST` configuration option exists.
- **Relationship to existing audit:** Confirms **Vuln 3** binding issue. Still not remediated.
- **Remediation:**
  ```typescript
  const HOST = process.env.SIDECAR_HOST || "127.0.0.1";
  app.listen(PORT, HOST, () => { ... });
  ```

---

## 9. Dependency and Supply Chain Risks

### Finding S20: Express 5.x (Early Release)
- **Severity:** LOW | **Confidence:** 6/10
- **Description:** Uses `"express": "^5.1.0"` which has a smaller production deployment base than 4.x.

### Finding S21: Broad Semver Ranges on Security-Critical Dependencies
- **Severity:** MEDIUM | **Confidence:** 7/10
- **Affected lines:** `package.json:10-15`
- **Description:** All dependencies use caret (`^`) semver ranges. For cryptographic libraries (`@mysten/seal`, `@mysten/sui`), an unexpected API change could alter encryption behavior.
- **Remediation:** Pin exact versions for crypto dependencies. Verify lockfile is committed.

### Finding S22: `tsx` Runtime in Production
- **Severity:** LOW | **Confidence:** 6/10
- **Description:** Sidecar runs via `tsx` (TypeScript execution), adding the TypeScript compiler to the production attack surface.
- **Remediation:** Pre-compile to JavaScript.

---

## 10. Additional Code-Level Findings

### Finding S23: Non-null Assertion on Regex Match
- **Severity:** LOW | **Confidence:** 8/10
- **Affected lines:** `sidecar-server.ts:335, 347, 414, 453`, `seal-decrypt.ts:127`
- **Description:** `someString.match(/.{1,2}/g)!` with non-null assertion. Empty string input returns `null`, causing TypeError.
- **Remediation:** Add null checks before regex matching.

### Finding S25: `signerUploadQueues` Memory Leak Potential
- **Severity:** LOW | **Confidence:** 6/10
- **Affected lines:** `sidecar-server.ts:136, 248-267`
- **Description:** The Map retains a reference to the latest promise for each signer indefinitely.
- **Remediation:** Add periodic cleanup of stale entries.

### Finding S26: Health Endpoint Leaks Process Uptime
- **Severity:** INFORMATIONAL | **Confidence:** 10/10
- **Affected lines:** `sidecar-server.ts:289`
- **Description:** `/health` returns `process.uptime()`, revealing operational information.

---

## 11. Comparison with Existing Audit Findings

| Vuln | Original | This Review | Change |
|------|----------|-------------|--------|
| Vuln 3 (Unauthenticated sidecar) | HIGH | HIGH | Confirmed. Added batch/query-blobs exposure, server wallet key risk |
| Vuln 5 (SEAL verifyKeyServers) | HIGH | HIGH | Confirmed. Added threshold=1 compounding risk (S4) |
| Vuln 6 (Permissive CORS) | MEDIUM | MEDIUM/HIGH | For sidecar specifically: wildcard CORS + no auth + 0.0.0.0 = HIGH |

---

## 12. Summary of Findings

| ID | Finding | Severity | Confidence |
|----|---------|----------|------------|
| S1 | Zero authentication on all endpoints | HIGH | 10/10 |
| S2 | Wildcard CORS | MEDIUM | 9/10 |
| S3 | `verifyKeyServers: false` everywhere | HIGH | 8/10 |
| S4 | Threshold 1 eliminates threshold security | MEDIUM | 7/10 |
| S5 | Private keys in HTTP request bodies | HIGH | 10/10 |
| S8 | Server wallet key sent per-request | HIGH | 10/10 |
| S9 | No validation of `owner` address | MEDIUM | 8/10 |
| S10 | Silent metadata/transfer failure | LOW | 8/10 |
| S11 | Unauthenticated sponsor endpoints | HIGH | 9/10 |
| S12 | Unsanitized digest in URL path | LOW | 7/10 |
| S13 | 50MB JSON body limit | MEDIUM | 8/10 |
| S14 | No array size limit on decrypt-batch | MEDIUM | 8/10 |
| S15 | No `packageId` format validation | LOW | 7/10 |
| S16 | Unbounded `epochs` parameter | LOW | 7/10 |
| S17 | Error messages returned to clients | MEDIUM | 9/10 |
| S18 | Sensitive data in console logs | LOW | 7/10 |
| S19 | Binds to 0.0.0.0 by default | HIGH | 10/10 |
| S20 | Express 5.x early adoption | LOW | 6/10 |
| S21 | Broad semver on crypto deps | MEDIUM | 7/10 |
| S22 | tsx runtime in production | LOW | 6/10 |
| S23 | Non-null assertion on regex | LOW | 8/10 |
| S25 | signerUploadQueues memory leak | LOW | 6/10 |
| S26 | Health endpoint leaks uptime | INFO | 10/10 |

**Totals: 6 HIGH, 6 MEDIUM, 9 LOW, 1 INFORMATIONAL**

---

## 13. Remediation Priority

| Priority | Findings | Description | Effort |
|----------|----------|-------------|--------|
| **P0** | S1, S19 | Bind to 127.0.0.1 + add shared secret auth | Low |
| **P0** | S11 | Authenticate sponsor endpoints or move behind Rust auth | Low |
| **P0** | S8 | Load server wallet keys from env at boot, not per-request | Medium |
| **P1** | S3 | Set `verifyKeyServers: true` | Low (one line x3) |
| **P1** | S5 | Architectural redesign for delegate key handling | High |
| **P1** | S2 | Remove CORS from sidecar entirely | Low |
| **P1** | S13, S14 | Reduce body limit; cap batch array size | Low |
| **P2** | S4 | Increase SEAL threshold to 2 | Low |
| **P2** | S9, S15, S16 | Add input validation for addresses, packageId, epochs | Low |
| **P2** | S17 | Sanitize error responses | Low |
| **P2** | S21 | Pin crypto dependency versions | Low |
| **P3** | S6, S7, S10, S12, S18, S20, S22-S26 | Low-severity and informational items | Low |
