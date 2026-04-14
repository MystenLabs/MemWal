# MemWal TypeScript SDK -- Security Code Review

**Date:** 2026-04-02
**Scope:** TypeScript SDK (`packages/sdk/src/`) -- all source files
**Commit:** 5bb1669
**Reviewer:** Code-level security analysis

---

## 1. Private Key Handling

### 1.1 CRITICAL: Delegate Private Key Transmitted in Every HTTP Request (MemWal class)

- **Severity:** CRITICAL
- **Confidence:** 10/10
- **File:** `packages/sdk/src/memwal.ts`, line 314
- **Existing Audit:** Confirms and reinforces Vuln 1

The `MemWal.signedRequest()` method sends the raw Ed25519 private key in the `x-delegate-key` header on every single authenticated API call:

```typescript
"x-delegate-key": bytesToHex(this.privateKey),  // line 314
```

This is sent on ALL requests: `remember`, `recall`, `embed`, `analyze`, `restore`, `rememberManual`, `recallManual`. There is no conditional logic that limits transmission to decrypt-only operations.

The `MemWalManual` class (lines 529-556 in `manual.ts`) does NOT send `x-delegate-key`, confirming the header is not architecturally necessary for authentication.

**Remediation:** Remove line 314 entirely. Push SEAL decryption to the client. The `MemWalManual` class already demonstrates the safe pattern.

### 1.2 HIGH: Key Material Held in Memory Without Cleanup

- **Severity:** HIGH
- **Confidence:** 7/10
- **Files:** `manual.ts:74-86, 146-157`

`MemWalManual` stores the full config object (including `suiPrivateKey` bech32 string) in `this.config`. The decoded keypair is cached for the client's lifetime. Neither keys are ever zeroed.

**Remediation:** Provide a `destroy()` method that zeroes `Uint8Array` key material. Document key lifetime.

### 1.3 MEDIUM: Private Key Passed as Immutable JavaScript String

- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Files:** `types.ts:13, 127`; `memwal.ts:70`

Both config types accept private keys as hex strings. JavaScript strings are immutable and cannot be zeroed. The original string persists in the JS heap until GC.

**Remediation:** Document limitation. Consider accepting `Uint8Array` directly as alternative.

---

## 2. Request Signing Analysis

### 2.1 What Is Signed

```
message = "{timestamp}.{method}.{path}.{body_sha256}"
```

Components: timestamp (Unix seconds), method (uppercase HTTP), path (URL path only), body_sha256 (SHA-256 hex digest of JSON body).

### 2.2 MEDIUM: Query String Not Included in Signature

- **Severity:** MEDIUM
- **Confidence:** 9/10
- **Files:** `memwal.ts:298`, `manual.ts:540`
- **Existing Audit:** Confirms Vuln 9

Path variable excludes query parameters. Not currently exploitable (all POST routes with JSON bodies), but fragile pattern.

**Remediation:** Sign `path + queryString`.

### 2.3 MEDIUM: 5-Minute Replay Window, No Nonce

- **Severity:** MEDIUM
- **Confidence:** 9/10
- **Files:** `memwal.ts:293`, `manual.ts:536`
- **Existing Audit:** Confirms Vuln 8

No nonce or request ID in signed payload. Captured signed requests can be replayed within 5-minute window.

**Remediation:** Add `crypto.randomUUID()` nonce to signed message and as `x-nonce` header.

### 2.4 LOW: Server URL Not Validated for HTTPS

- **Severity:** LOW
- **Confidence:** 8/10
- **Files:** `memwal.ts:72`, `manual.ts:82`

Default is `http://localhost:8000` (plaintext HTTP). No warning for non-localhost HTTP URLs. Combined with Vuln 1, private keys travel in plaintext.

**Remediation:** Warn or throw when `serverUrl` is not HTTPS in non-localhost configurations.

### 2.5 LOW: `x-account-id` Header Not Signed

- **Severity:** LOW
- **Confidence:** 7/10
- **File:** `memwal.ts:315`

Not part of the signed message. An intermediary could swap this value. Since the server verifies key-to-account binding on-chain, this is a performance concern rather than a security bypass.

---

## 3. MemWal vs MemWalManual -- Security Comparison

| Aspect | MemWal (Server Mode) | MemWalManual (Client Mode) |
|--------|---------------------|---------------------------|
| **Private key transmission** | CRITICAL: sends raw private key in every HTTP header | SAFE: never sends delegate private key over the wire |
| **SEAL encryption** | Server-side (via sidecar) | Client-side (user's own SEAL client) |
| **SEAL key server verification** | `verifyKeyServers: false` (sidecar) | `verifyKeyServers: false` (line 200) -- same weakness |
| **Embedding** | Server-side (server's OpenAI key) | Client-side (user's own OpenAI key) |
| **Walrus upload** | Server-side (server's SUI keys) | Hybrid: encrypted data sent to server for relay |
| **Trust model** | Must trust server with plaintext AND private keys | Must trust server only for vector storage |
| **Auth headers** | public_key, signature, timestamp, delegate_key, account_id | public_key, signature, timestamp only |

**Key finding:** `MemWalManual` is fundamentally more secure. Its `signedRequest` authenticates successfully without transmitting the private key.

---

## 4. SEAL Encryption/Decryption Client-Side Flow

### 4.1 Encryption (MemWalManual.sealEncrypt, lines 450-462)

Uses `threshold: 1`, meaning only one SEAL key server needed. The `id` used is `ownerAddress` (Sui address from wallet).

### 4.2 HIGH: SEAL verifyKeyServers Disabled

- **Severity:** HIGH
- **Confidence:** 8/10
- **File:** `manual.ts:200`
- **Existing Audit:** Confirms Vuln 5

```typescript
verifyKeyServers: false,  // line 200
```

MitM or DNS poisoning can substitute rogue key servers.

**Remediation:** Set `verifyKeyServers: true`.

### 4.3 MEDIUM: Hardcoded Threshold of 1

- **Severity:** MEDIUM
- **Confidence:** 7/10
- **File:** `manual.ts:454`

With threshold=1, compromising a single SEAL key server breaks all encryption. Testnet has 2 servers configured but threshold is still 1.

**Remediation:** Make threshold configurable. Default to `ceil(n/2)`.

### 4.4 LOW: SEAL Encryption ID is Owner-Scoped, Not Namespace-Scoped

- **Severity:** LOW
- **Confidence:** 6/10
- **File:** `manual.ts:457`

All memories for the same owner use the same SEAL policy ID regardless of namespace. A delegate authorized for one namespace can potentially request SEAL decryption for data in a different namespace.

**Remediation:** Incorporate account ID and/or namespace into the SEAL encryption ID.

---

## 5. Input Validation and Sanitization

### 5.1 LOW: Minimal Client-Side Input Validation

- **Severity:** LOW
- **Confidence:** 9/10
- **Files:** `memwal.ts:102, 125`; `manual.ts:238-239, 265-266`

`MemWal` class performs zero input validation. `MemWalManual` is slightly better (checks `if (!text)`, `if (!query)`). Neither validates namespace characters, limit bounds, or text maximum length.

### 5.2 LOW: hexToBytes Does Not Validate Input

- **Severity:** LOW
- **Confidence:** 8/10
- **File:** `utils.ts:32-39`

No validation for hex characters (non-hex produces `NaN` -> `0`), even-length input, or expected key length. Corrupted key strings produce silently wrong keys.

**Remediation:** Validate hex characters, even length, and expected byte count.

### 5.3 LOW: Large Base64 Encoding May Exhaust Memory

- **Severity:** LOW
- **Confidence:** 6/10
- **File:** `manual.ts:250`

`btoa(String.fromCharCode(...encrypted))` uses spread operator which can exceed JS engine's max argument count for large payloads.

**Remediation:** Use chunked base64 encoding.

---

## 6. Error Handling -- Information Leakage

### 6.1 LOW: Server Error Messages Propagated to Caller

- **Severity:** LOW
- **Confidence:** 8/10
- **Files:** `memwal.ts:320-322`, `manual.ts:558-560`

Raw server error text included in thrown Error messages. Per Vuln 10, server returns detailed internal errors which the SDK passes through.

### 6.2 LOW: console.error Leaks Blob IDs and Error Details

- **Severity:** LOW
- **Confidence:** 7/10
- **File:** `manual.ts:291, 377`

Blob IDs and full error objects logged to `console.error`. Visible in browser DevTools.

---

## 7. Transport Security

### 7.1 MEDIUM: Default Server URL Is Plaintext HTTP

- **Severity:** MEDIUM
- **Confidence:** 9/10
- **Files:** `memwal.ts:72`, `manual.ts:82`

Default `http://localhost:8000` -- unencrypted. No enforcement for non-localhost HTTPS.

### 7.2 LOW: Health Check Is Unsigned

- **Severity:** LOW | **Confidence:** 9/10
- **File:** `memwal.ts:249-255`

MitM could return fake healthy status. Informational only.

---

## 8. Findings Summary

| # | Severity | Confidence | File:Line | Description |
|---|----------|-----------|-----------|-------------|
| 1.1 | CRITICAL | 10/10 | `memwal.ts:314` | Private key sent in `x-delegate-key` header on every request |
| 1.2 | HIGH | 7/10 | `manual.ts:74-86` | Key material held in memory indefinitely, never zeroed |
| 4.2 | HIGH | 8/10 | `manual.ts:200` | `verifyKeyServers: false` disables SEAL server verification |
| 1.3 | MEDIUM | 8/10 | `types.ts:13,127` | Private keys accepted as immutable JS strings |
| 2.2 | MEDIUM | 9/10 | `memwal.ts:298`, `manual.ts:540` | Query string excluded from signature |
| 2.3 | MEDIUM | 9/10 | `memwal.ts:293`, `manual.ts:536` | 5-minute replay window with no nonce |
| 4.3 | MEDIUM | 7/10 | `manual.ts:454` | SEAL threshold hardcoded to 1 |
| 7.1 | MEDIUM | 9/10 | `memwal.ts:72`, `manual.ts:82` | Default server URL is plaintext HTTP |
| 2.5 | LOW | 7/10 | `memwal.ts:315` | `x-account-id` header not included in signature |
| 4.4 | LOW | 6/10 | `manual.ts:457` | SEAL encryption ID owner-scoped, not namespace-scoped |
| 5.1 | LOW | 9/10 | `memwal.ts:102,125` | No client-side input validation |
| 5.2 | LOW | 8/10 | `utils.ts:32-39` | `hexToBytes` silently accepts invalid hex |
| 5.3 | LOW | 6/10 | `manual.ts:250` | `btoa` spread may blow stack on large payloads |
| 6.1 | LOW | 8/10 | `memwal.ts:320-322` | Raw server error messages propagated to caller |
| 6.2 | LOW | 7/10 | `manual.ts:291,377` | `console.error` leaks blob IDs and error details |

---

## 9. Comparison with Existing Audit Findings

| Vuln | Original | This Review | Change |
|------|----------|-------------|--------|
| Vuln 1 (Private key in headers) | HIGH | CRITICAL | Elevated -- key sent on ALL requests, not just decrypt; provably unnecessary |
| Vuln 5 (verifyKeyServers) | HIGH | HIGH | Confirmed at SDK level (manual.ts:200) |
| Vuln 8 (Replay window) | MEDIUM | MEDIUM | Confirmed at SDK level. SDK-side nonce would be low-effort enabler |
| Vuln 9 (Query string not signed) | MEDIUM | MEDIUM | Confirmed at SDK level |

---

## 10. Remediation Priority

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| **P0** | 1.1 -- Remove `x-delegate-key` from MemWal class | High (requires server arch change) | Eliminates systemic credential exposure |
| **P0** | 4.2 -- Set `verifyKeyServers: true` | Trivial (one line) | Prevents SEAL MitM |
| **P1** | 2.3 -- Add nonce to signed message | Low (SDK) + Medium (server) | Prevents replay attacks |
| **P1** | 7.1 -- Warn on non-HTTPS server URLs | Low | Prevents plaintext key transmission |
| **P1** | 4.3 -- Make SEAL threshold configurable | Low | Strengthens encryption |
| **P2** | 2.2 -- Include query string in signature | Low | Defense-in-depth |
| **P2** | 5.2 -- Validate hex input in `hexToBytes` | Low | Prevents silent key corruption |
| **P2** | 1.2 -- Add `destroy()` method for key zeroing | Low | Reduces key exposure window |
| **P3** | All LOW findings | Low | Defense-in-depth |
