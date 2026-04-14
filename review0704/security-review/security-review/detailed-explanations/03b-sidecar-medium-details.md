# Sidecar Server -- MEDIUM Severity Findings (Detailed)

This document provides detailed explanations for each MEDIUM-severity finding
identified in the MemWal SEAL + Walrus HTTP sidecar server.

---

## S2: Wildcard CORS on Sidecar

### What It Is

The sidecar server sets `Access-Control-Allow-Origin: *` on every response,
permitting any website on the internet to make cross-origin requests to the
sidecar API.  Because the sidecar exposes encryption, decryption, and Walrus
upload endpoints -- some of which accept private keys in the request body --
this is an overly permissive policy.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 277-285

```typescript
app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});
```

### How to Exploit

1. An attacker hosts a malicious webpage at `https://evil.example.com`.
2. A victim who has legitimate access to the sidecar visits the page.
3. JavaScript on the malicious page issues `fetch("https://<sidecar-host>:9000/seal/decrypt", ...)` with crafted payloads.
4. Because `Access-Control-Allow-Origin: *`, the browser permits the response to be read by the attacker's script.
5. If the sidecar is exposed on a network-accessible address (not only localhost), any website the user visits can interact with it directly.

Even if the sidecar only listens on localhost, a malicious page can target
`http://localhost:9000` from the browser and the wildcard CORS will allow reading
the response.

### Impact

- Enables cross-origin abuse of all sidecar endpoints from any website.
- Combined with other findings (e.g., private keys in request bodies), an
  attacker could exfiltrate decrypted data or trigger unwanted uploads.
- Violates the principle of least privilege for cross-origin access.

### Severity Justification

MEDIUM -- The sidecar is intended to be an internal service, but the wildcard
CORS configuration contradicts this intent.  Exploitation requires a victim to
visit a malicious page while the sidecar is network-reachable, which is a
realistic scenario in development and some deployment configurations.

### Remediation

Replace the wildcard with an explicit allowlist of trusted origins, ideally
sourced from an environment variable:

```typescript
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});
```

If the sidecar is strictly internal, consider removing CORS headers entirely and
binding to `127.0.0.1` only.

---

## S4: Threshold 1 Eliminates Threshold Security

### What It Is

Every call to SEAL `encrypt` and `fetchKeys` uses `threshold: 1`.  SEAL is
designed as a threshold encryption system where `t` of `n` key servers must
cooperate to decrypt.  Setting the threshold to 1 means a single compromised key
server is sufficient to decrypt all data, completely negating the security
benefit of a multi-server key management design.

### Where in the Code

The value is hardcoded in four locations across two files:

**File:** `services/server/scripts/sidecar-server.ts`

Line 303 (encrypt endpoint):
```typescript
const result = await sealClient.encrypt({
    threshold: 1,
    packageId,
    id: owner,
    data: new Uint8Array(plaintext),
});
```

Line 375 (decrypt endpoint):
```typescript
await sealClient.fetchKeys({
    ids: [fullId],
    txBytes,
    sessionKey,
    threshold: 1,
});
```

Line 469 (decrypt-batch endpoint):
```typescript
await sealClient.fetchKeys({
    ids: allIds,
    txBytes,
    sessionKey,
    threshold: 1,
});
```

**File:** `services/server/scripts/seal-encrypt.ts`, line 101:
```typescript
const result = await sealClient.encrypt({
    threshold: 1,
    packageId,
    id: owner,
    data: new Uint8Array(data),
});
```

**File:** `services/server/scripts/seal-decrypt.ts`, line 155:
```typescript
await sealClient.fetchKeys({
    ids: [fullId],
    txBytes,
    sessionKey,
    threshold: 1,
});
```

### How to Exploit

1. An attacker compromises a single SEAL key server (out of however many are
   configured via `SEAL_KEY_SERVERS`).
2. With threshold = 1, that single compromised server can issue the key share
   needed to decrypt any blob.
3. The attacker can decrypt all past and future SEAL-encrypted data without
   needing to compromise any additional servers.

### Impact

- Complete loss of the threshold security guarantee.
- A single key server compromise exposes all encrypted data.
- Eliminates the redundancy and fault-tolerance benefits of having multiple key
  servers.

### Severity Justification

MEDIUM -- While this is a significant architectural weakness, exploitation
requires first compromising a SEAL key server, which is a non-trivial
prerequisite.  The finding is MEDIUM rather than HIGH because the key servers
themselves are external infrastructure with their own security controls.

### Remediation

Make the threshold configurable and set a meaningful default (e.g., majority
quorum):

```typescript
// Environment-driven threshold (default: majority of configured servers)
const SEAL_THRESHOLD = parseInt(
    process.env.SEAL_THRESHOLD ||
    String(Math.ceil(SEAL_KEY_SERVERS.length / 2)),
    10
);
```

Then use `SEAL_THRESHOLD` in all encrypt and fetchKeys calls:

```typescript
const result = await sealClient.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId,
    id: owner,
    data: new Uint8Array(plaintext),
});
```

Ensure the same threshold is used consistently across encryption and decryption.
The threshold used during decryption (`fetchKeys`) must be less than or equal to
the threshold used during encryption.

---

## S9: No Validation of Owner Address in Upload

### What It Is

The `/walrus/upload` endpoint accepts an `owner` field in the request body and
uses it to set on-chain metadata and to transfer the Walrus blob object.  There
is no validation that the `owner` value is a well-formed Sui address, nor any
authorization check that the caller is entitled to designate that owner.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 503-515

```typescript
app.post("/walrus/upload", async (req, res) => {
    try {
        const {
            data,
            privateKey,
            owner,
            namespace,
            packageId,
            epochs = DEFAULT_WALRUS_EPOCHS,
        } = req.body;
        if (!data || !privateKey) {
            return res.status(400).json({ error: "Missing required fields: data, privateKey" });
        }
```

Note that `owner` is destructured but never validated.  It is used directly on
line 537 (as metadata), line 574 (for transfer decision), and line 615
(`metaTx.transferObjects([blobArg], owner)`):

```typescript
// Line 574 - owner used in condition without validation
if (owner && owner !== signerAddress && blobObjectId) {

// Line 615 - owner used directly as transfer target
metaTx.transferObjects([blobArg], owner);
```

### How to Exploit

1. An attacker calls `/walrus/upload` with a valid `privateKey` and `data` but
   sets `owner` to an arbitrary Sui address (e.g., their own address or a
   burn address).
2. The server uses Enoki-sponsored gas (or the signer's gas) to upload the blob
   and then transfers the Walrus blob object to the attacker-specified address.
3. Since there is no validation, the attacker can:
   - Claim ownership of blobs uploaded using another user's private key.
   - Set `owner` to a malformed string, causing the transfer transaction to
     fail on-chain (the blob remains owned by the signer but metadata is
     inconsistent).
   - Set `owner` to `0x0` or other special addresses, potentially burning the
     blob object.

### Impact

- Blob objects can be transferred to unintended recipients.
- Inconsistent on-chain metadata if `owner` is malformed.
- Potential for gas griefing via Enoki-sponsored transactions that will fail
  on-chain.
- Data integrity issue: the `memwal_owner` metadata attribute may not match the
  actual object owner.

### Severity Justification

MEDIUM -- The endpoint requires a valid `privateKey` to function, which limits
the attack surface.  However, a user with a valid key can direct blob transfers
to arbitrary addresses and poison on-chain metadata.  The lack of address format
validation can also cause silent failures.

### Remediation

Add address format validation and optionally verify that the owner matches the
signer or an authorized delegate:

```typescript
// Validate Sui address format
function isValidSuiAddress(addr: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(addr);
}

app.post("/walrus/upload", async (req, res) => {
    try {
        const { data, privateKey, owner, namespace, packageId, epochs = DEFAULT_WALRUS_EPOCHS } = req.body;
        if (!data || !privateKey) {
            return res.status(400).json({ error: "Missing required fields: data, privateKey" });
        }
        if (owner && !isValidSuiAddress(owner)) {
            return res.status(400).json({ error: "Invalid owner address format" });
        }
        // ... rest of handler
    }
});
```

For stronger protection, verify that the signer is authorized to upload on
behalf of the specified owner (e.g., by checking an on-chain delegation
relationship).

---

## S13: 50 MB JSON Body Limit

### What It Is

The Express JSON body parser is configured with a `limit` of `"50mb"`, which
allows any client to send up to 50 megabytes of JSON in a single request.  This
is a large limit for a JSON API and creates a resource exhaustion vector.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, line 274

```typescript
app.use(express.json({ limit: "50mb" }));
```

### How to Exploit

1. An attacker sends multiple concurrent POST requests to any endpoint (e.g.,
   `/seal/encrypt`, `/walrus/upload`), each containing a ~50 MB JSON body.
2. Express parses each request body into a JavaScript object in memory.  JSON
   parsing is CPU-intensive and allocates significantly more memory than the raw
   payload size (a 50 MB JSON string can expand to 200+ MB as a JS object tree).
3. With 10 concurrent requests: 10 x 50 MB = 500 MB raw, potentially 2+ GB
   in-process memory.
4. The Node.js process runs out of heap memory or becomes unresponsive due to
   garbage collection pressure.
5. This can be amplified with deeply nested JSON structures that cause
   exponential memory usage during parsing.

### Impact

- Denial of service via memory exhaustion on the sidecar process.
- Degraded latency for legitimate requests due to GC pauses.
- Potential cascading failure if the sidecar becomes unresponsive and the Rust
  server retries or queues requests.

### Severity Justification

MEDIUM -- Denial of service is a real risk, but it requires network access to
the sidecar and does not lead to data breach.  The sidecar is intended as an
internal service, which reduces (but does not eliminate) the attack surface.

### Remediation

Reduce the body limit to the minimum needed for the largest legitimate payload.
Encrypted memory blobs are typically kilobytes, not megabytes.  Apply
per-endpoint limits:

```typescript
// Global default: conservative limit
app.use(express.json({ limit: "1mb" }));

// Override for upload endpoint which may carry larger base64 blobs
app.post("/walrus/upload", express.json({ limit: "5mb" }), async (req, res) => {
    // ... handler
});
```

Additionally, consider adding request rate limiting (requests per IP per time
window) to prevent rapid-fire abuse.

---

## S14: No Array Size Limit on decrypt-batch

### What It Is

The `/seal/decrypt-batch` endpoint accepts an `items` array of arbitrary length.
There is no upper bound on the number of items, so a client can submit thousands
or millions of items in a single request, causing the server to perform
unbounded work.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 398-497

The only validation on `items` is that it is a non-empty array (line 401):

```typescript
app.post("/seal/decrypt-batch", async (req, res) => {
    try {
        const { items, privateKey, packageId, accountId } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Missing required field: items (array of base64 encrypted data)" });
        }
```

The code then iterates over all items to parse them (line 423), builds a
transaction with a `moveCall` for each unique ID (line 451-461), calls
`fetchKeys` for all IDs (line 466-471), and then decrypts each item
individually (line 476-489).  Every step scales linearly (or worse) with array
size.

### How to Exploit

1. An attacker sends a POST to `/seal/decrypt-batch` with `items` containing
   10,000+ base64-encoded encrypted blobs.
2. The server attempts to parse all items, build a massive PTB transaction, and
   call `fetchKeys` for all unique IDs simultaneously.
3. This consumes:
   - CPU: parsing 10,000 base64 strings and EncryptedObjects.
   - Memory: holding all parsed items and the PTB in memory.
   - Network: issuing requests to SEAL key servers for all IDs.
   - Time: the request handler blocks for an extended period.
4. The sidecar becomes unresponsive to other requests.

Combined with S13 (50 MB body limit), an attacker could send a 50 MB array of
items in a single request.

### Impact

- Denial of service via CPU, memory, and network exhaustion.
- Degraded service for all concurrent users.
- Potential timeout cascades in the calling Rust server.

### Severity Justification

MEDIUM -- The attack is straightforward and requires only network access to the
sidecar.  Impact is limited to availability (denial of service), not
confidentiality or integrity.

### Remediation

Add an upper bound on the `items` array size:

```typescript
const MAX_BATCH_SIZE = 50; // adjust based on expected usage

app.post("/seal/decrypt-batch", async (req, res) => {
    try {
        const { items, privateKey, packageId, accountId } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Missing required field: items (non-empty array)" });
        }
        if (items.length > MAX_BATCH_SIZE) {
            return res.status(400).json({
                error: `Batch size ${items.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
            });
        }
        // ... rest of handler
    }
});
```

Consider also adding a per-item size limit and overall request timeout.

---

## S17: Error Messages Returned to Clients

### What It Is

Every `catch` block in the sidecar forwards the raw exception message to the
HTTP response.  This can leak internal implementation details, file paths, stack
traces, or third-party API error messages to external callers.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`

This pattern appears in every endpoint handler.  Examples:

Line 314 (`/seal/encrypt`):
```typescript
} catch (err: any) {
    console.error(`[seal/encrypt] error: ${err.message || err}`);
    res.status(500).json({ error: err.message || String(err) });
}
```

Line 389 (`/seal/decrypt`):
```typescript
} catch (err: any) {
    console.error(`[seal/decrypt] error: ${err.message || err}`);
    res.status(500).json({ error: err.message || String(err) });
}
```

Line 495 (`/seal/decrypt-batch`):
```typescript
} catch (err: any) {
    console.error(`[seal/decrypt-batch] error: ${err.message || err}`);
    res.status(500).json({ error: err.message || String(err) });
}
```

Line 632 (`/walrus/upload`):
```typescript
} catch (err: any) {
    console.error(`[walrus/upload] error: ${err.message || err}`);
    res.status(500).json({ error: err.message || String(err) });
}
```

Lines 774, 802 (`/sponsor`, `/sponsor/execute`) follow the same pattern.

### How to Exploit

1. An attacker sends malformed requests to various endpoints.
2. The error responses may reveal:
   - Internal Sui RPC URLs and network configuration.
   - SEAL key server object IDs or connection failures.
   - Enoki API error details (including API version, rate limit info).
   - Node.js module paths or dependency versions.
   - Transaction build errors that reveal Move package structure.
3. The attacker uses this information to refine further attacks, identify
   software versions with known vulnerabilities, or map the internal
   infrastructure.

Example leaked error: `"Enoki API error (429): {"message":"rate limit exceeded","retryAfter":60}"` reveals that Enoki is used, the rate limit policy, and retry timing.

### Impact

- Information disclosure that aids reconnaissance.
- Potential exposure of internal infrastructure details (RPC URLs, object IDs).
- Violation of security best practice: never expose internal errors to clients.

### Severity Justification

MEDIUM -- Information disclosure alone does not directly compromise data, but it
materially aids an attacker in planning more targeted attacks.  The pattern is
pervasive across all endpoints.

### Remediation

Return generic error messages to clients and log detailed errors server-side
only:

```typescript
function safeErrorResponse(res: express.Response, statusCode: number, err: any, context: string) {
    // Log full error details server-side
    console.error(`[${context}] error: ${err.message || err}`);
    if (err.stack) {
        console.error(`[${context}] stack: ${err.stack}`);
    }

    // Return generic message to client
    const clientMessages: Record<number, string> = {
        400: "Bad request",
        500: "Internal server error",
        503: "Service unavailable",
    };
    res.status(statusCode).json({
        error: clientMessages[statusCode] || "An error occurred",
        // Optionally include a request ID for correlation
        // requestId: req.headers["x-request-id"] || crypto.randomUUID(),
    });
}

// Usage in catch blocks:
} catch (err: any) {
    safeErrorResponse(res, 500, err, "seal/encrypt");
}
```

For 400-level validation errors where the message is constructed by the server
(not from exceptions), it is acceptable to return specific details since the
server controls the content.

---

## S21: Broad Semver on Crypto Dependencies

### What It Is

The sidecar's `package.json` uses caret (`^`) semver ranges for all
dependencies, including security-critical cryptographic packages (`@mysten/seal`,
`@mysten/sui`, `@mysten/walrus`).  Caret ranges allow automatic upgrades to any
minor or patch version, meaning a future publish of these packages (whether
legitimate or via a supply-chain attack) would be pulled in automatically on the
next `npm install`.

### Where in the Code

**File:** `services/server/scripts/package.json`, lines 9-15

```json
"dependencies": {
    "@mysten/seal": "^1.1.0",
    "@mysten/sui": "^2.5.0",
    "@mysten/walrus": "^1.0.3",
    "express": "^5.1.0",
    "tsx": "^4.19.0"
}
```

All five dependencies use `^` ranges:
- `@mysten/seal: ^1.1.0` -- accepts any `1.x.y` where `x >= 1` or `x == 1, y >= 0`
- `@mysten/sui: ^2.5.0` -- accepts any `2.x.y` where `x >= 5`
- `@mysten/walrus: ^1.0.3` -- accepts any `1.x.y` where `x >= 0, y >= 3`
- `express: ^5.1.0` -- accepts any `5.x.y`
- `tsx: ^4.19.0` -- accepts any `4.x.y`

### How to Exploit

**Supply-chain attack scenario:**
1. An attacker compromises a Mysten Labs npm account or exploits an npm registry
   vulnerability.
2. They publish `@mysten/seal@1.2.0` with a backdoor that exfiltrates plaintext
   data during encryption or decryption.
3. On the next `npm install` (CI/CD rebuild, container build, or developer
   setup), the backdoored version is pulled automatically because `^1.1.0`
   matches `1.2.0`.
4. All encryption/decryption operations now leak data to the attacker.

**Accidental breakage scenario:**
1. A legitimate minor version update to `@mysten/seal` or `@mysten/sui` changes
   behavior (e.g., default parameters, serialization format).
2. The change is semver-compatible by the author's assessment but breaks
   MemWal's specific usage.
3. Production breaks silently after a routine rebuild.

### Impact

- Supply-chain attack could compromise all cryptographic operations.
- Unintended dependency updates can break production deployments.
- Crypto libraries are especially sensitive -- even minor changes can affect
  security properties.

### Severity Justification

MEDIUM -- Supply-chain attacks on npm packages are a well-documented threat
vector.  The risk is elevated because the affected packages perform
cryptographic operations (key management, encryption, decryption).  However,
exploitation requires compromising an upstream package, which is outside the
direct control of an attacker targeting MemWal.

### Remediation

**Option 1 (Recommended): Pin exact versions**

```json
"dependencies": {
    "@mysten/seal": "1.1.0",
    "@mysten/sui": "2.5.0",
    "@mysten/walrus": "1.0.3",
    "express": "5.1.0",
    "tsx": "4.19.0"
}
```

**Option 2: Use a lockfile and verify it in CI**

Ensure `package-lock.json` (or equivalent) is committed and that CI runs
`npm ci` (which respects the lockfile exactly) rather than `npm install`.

**Option 3: Use npm `overrides` or `resolutions` for crypto packages**

At minimum, pin the security-critical packages while allowing flexibility for
tooling:

```json
"dependencies": {
    "@mysten/seal": "1.1.0",
    "@mysten/sui": "2.5.0",
    "@mysten/walrus": "1.0.3",
    "express": "^5.1.0",
    "tsx": "^4.19.0"
}
```

Regardless of pinning strategy, enable `npm audit` in CI and use a tool like
Renovate or Dependabot for controlled, reviewed dependency updates.
