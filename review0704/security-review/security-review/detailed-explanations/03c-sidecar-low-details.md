# Sidecar Server -- LOW and INFO Severity Findings

This document provides detailed explanations for each LOW and INFO severity finding
identified in the MemWal sidecar server (`services/server/scripts/sidecar-server.ts`
and related files).

---

## S6: Dual Private Key Format Parsing Without Validation

**Severity: LOW**

### What It Is

The sidecar accepts private keys in two formats -- bech32 (`suiprivkey1...`) and raw
hex -- but applies no validation to the raw hex path. The hex parsing branch blindly
converts any string through a regex without verifying length, character set, or
cryptographic validity before constructing a keypair.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 328-337 (decrypt endpoint)
and lines 408-416 (decrypt-batch endpoint):

```typescript
// sidecar-server.ts:328-337
let keypair: Ed25519Keypair;
if (privateKey.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    keypair = Ed25519Keypair.fromSecretKey(secretKey);
} else {
    // Raw hex private key (32 bytes = 64 hex chars)
    const keyBytes = Uint8Array.from(privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
    keypair = Ed25519Keypair.fromSecretKey(keyBytes);
}
```

The identical pattern appears again at lines 409-416 for the `/seal/decrypt-batch`
endpoint.

### How to Exploit

1. **Invalid key length:** An attacker can submit a hex string of any length (e.g., 10
   characters, 200 characters). The regex `/.{1,2}/g` will happily split it into byte
   pairs regardless of whether the result is a valid 32-byte Ed25519 secret key.
   `Ed25519Keypair.fromSecretKey()` may throw, but the error path exposes internal
   details.

2. **Non-hex characters:** Submitting `"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"`
   (64 chars) will cause `parseInt(b, 16)` to return `NaN` for each pair, producing a
   `Uint8Array` filled with `NaN` values (coerced to 0). This creates a valid-looking
   but degenerate keypair from all-zero bytes.

3. **Error message leakage:** Malformed keys that pass the regex but fail downstream
   crypto operations produce error messages that may leak internal state via the 500
   response.

### Impact

- Confusing error messages and potential information disclosure via error responses.
- The all-zeros keypair from non-hex input is a deterministic keypair -- if any resources
  were ever encrypted to the address derived from a zero key, they could be decrypted
  by anyone who discovers this behavior.
- No direct compromise of existing keys, but the lack of input validation weakens
  defense-in-depth.

### Severity Justification

LOW: The hex branch is primarily used for internal/testing purposes. The bech32 path
(`suiprivkey1...`) uses the SDK's `decodeSuiPrivateKey` which includes proper validation.
Exploitation requires the attacker to already be submitting their own private key, so the
primary risk is to the attacker's own operations. The degenerate-key scenario is
theoretical.

### Remediation

Add explicit validation before constructing the keypair from hex:

```typescript
let keypair: Ed25519Keypair;
if (privateKey.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    keypair = Ed25519Keypair.fromSecretKey(secretKey);
} else {
    // Validate hex format: exactly 64 hex characters (32 bytes)
    if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) {
        return res.status(400).json({
            error: "Invalid private key format. Expected bech32 (suiprivkey1...) or 64-character hex string."
        });
    }
    const keyBytes = Uint8Array.from(
        privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16))
    );
    keypair = Ed25519Keypair.fromSecretKey(keyBytes);
}
```

Alternatively, deprecate the raw hex path entirely and require all callers to use the
bech32 `suiprivkey1...` format, which has built-in checksum validation.

---

## S7: SessionKey TTL of 30 Minutes

**Severity: LOW**

### What It Is

All `SessionKey.create()` calls use a fixed 30-minute TTL (`ttlMin: 30`). Session keys
are short-lived cryptographic credentials that authorize SEAL key-server requests. A
30-minute window is generous for operations that typically complete in seconds, expanding
the window during which a compromised or leaked session key can be reused.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, line 354:

```typescript
// sidecar-server.ts:350-357
const sessionKey = await SessionKey.create({
    address: signerAddress,
    packageId,
    ttlMin: 30,
    signer: keypair,
    suiClient: suiClient as any,
});
```

**File:** `services/server/scripts/sidecar-server.ts`, lines 441-447 (decrypt-batch):

```typescript
// sidecar-server.ts:441-447
const sessionKey = await SessionKey.create({
    address: signerAddress,
    packageId,
    ttlMin: 30,
    signer: keypair,
    suiClient: suiClient as any,
});
```

**File:** `services/server/scripts/seal-decrypt.ts`, lines 131-137:

```typescript
// seal-decrypt.ts:131-137
const sessionKey = await SessionKey.create({
    address: adminAddress,
    packageId,
    ttlMin: 30,
    signer: keypair,
    suiClient: suiClient as any,
});
```

### How to Exploit

1. An attacker who intercepts a session key (e.g., through a memory dump, log leak, or
   network interception of key-server requests) has a 30-minute window to replay it.

2. The session key authorizes `fetchKeys` requests to SEAL key servers. With a captured
   session key and the corresponding `txBytes`, an attacker could call `fetchKeys`
   themselves to obtain decryption keys for any data the session key was authorized for.

3. In the batch endpoint, one session key is used across potentially many decryption
   operations, increasing its value as a target.

### Impact

- Extended replay window for intercepted session keys.
- In a server compromise scenario, all active session keys (up to 30 minutes old) remain
  valid, increasing the blast radius.

### Severity Justification

LOW: Session keys are ephemeral, created per-request, and only used server-side. They are
not exposed to clients or transmitted over public networks (only to SEAL key servers over
HTTPS). The 30-minute TTL is generous but not unreasonable for batch operations that may
take time. The SEAL key servers also enforce their own policy checks on each request.

### Remediation

Reduce the TTL to the minimum needed. For single-decrypt operations, 2-5 minutes is
sufficient. For batch operations, consider scaling the TTL based on batch size:

```typescript
// Single decrypt: tight TTL
const sessionKey = await SessionKey.create({
    address: signerAddress,
    packageId,
    ttlMin: 5,  // 5 minutes is ample for a single decrypt
    signer: keypair,
    suiClient: suiClient as any,
});

// Batch decrypt: scale with batch size, cap at 10 minutes
const batchTtl = Math.min(Math.max(5, Math.ceil(items.length / 10)), 10);
const sessionKey = await SessionKey.create({
    address: signerAddress,
    packageId,
    ttlMin: batchTtl,
    signer: keypair,
    suiClient: suiClient as any,
});
```

Extract the TTL as a named constant for easy auditing:

```typescript
const SESSION_KEY_TTL_MIN = 5;
```

---

## S10: Non-Fatal Metadata/Transfer Failure

**Severity: LOW**

### What It Is

After a Walrus blob is successfully uploaded, the server attempts to set on-chain
metadata and transfer the blob object to the user. If this step fails, the error is
caught and logged but the endpoint returns a 200 success response with the `blobId` and
`objectId`. The caller believes the operation succeeded, but the blob is stuck owned by
the server's signer address with no metadata.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 620-624:

```typescript
// sidecar-server.ts:620-624
} catch (metaErr: any) {
    // Non-fatal: blob is uploaded but metadata/transfer failed
    console.error(`[walrus/upload] metadata+transfer failed: ${metaErr.message}`);
}
```

This catch block wraps the entire metadata-setting and transfer transaction (lines
574-619). The response at lines 626-629 then returns success regardless:

```typescript
// sidecar-server.ts:626-629
res.json({
    blobId: blob.blobId,
    objectId: blobObjectId,
});
```

### How to Exploit

1. **Denial of ownership:** If the metadata/transfer transaction fails (due to gas
   issues, network problems, or Enoki sponsorship failure), the blob object remains
   owned by the signer address (the server's ephemeral key). The user has no way to
   access or manage the blob on-chain.

2. **Silent data loss:** The client receives `{ blobId, objectId }` and records this as
   a successful upload. Later attempts to query blobs by owner (`/walrus/query-blobs`)
   will not find this blob because it was never transferred.

3. **Intentional trigger:** An attacker could craft conditions that cause the transfer
   to fail (e.g., by manipulating the `owner` address to be an address that causes the
   `transferObjects` call to fail) while the upload itself succeeds, creating orphaned
   blobs.

### Impact

- Data integrity issue: blobs are uploaded and encrypted but may become inaccessible
  because ownership was never transferred.
- The caller has no indication that follow-up operations are needed.
- Over time, orphaned blobs accumulate under the server's signer address.

### Severity Justification

LOW: The blob data itself is safely stored on Walrus and can be retrieved by `blobId`.
The primary issue is on-chain ownership -- the blob object is not transferred to the
intended owner. This is a reliability/UX issue rather than a security vulnerability.
Recovery is possible through manual transfer of the blob object.

### Remediation

Return a warning flag in the response when the metadata/transfer step fails, so the
caller can implement retry logic:

```typescript
let transferSuccess = true;
let transferError: string | undefined;

if (owner && owner !== signerAddress && blobObjectId) {
    try {
        // ... existing metadata + transfer code ...
    } catch (metaErr: any) {
        transferSuccess = false;
        transferError = metaErr.message;
        console.error(`[walrus/upload] metadata+transfer failed: ${metaErr.message}`);
    }
}

res.json({
    blobId: blob.blobId,
    objectId: blobObjectId,
    transferred: transferSuccess,
    ...(transferError ? { transferWarning: transferError } : {}),
});
```

Additionally, consider implementing a retry queue for failed transfers, or returning
a 207 (Multi-Status) HTTP code to signal partial success.

---

## S12: Unsanitized Digest in URL Path

**Severity: LOW**

### What It Is

User-supplied `digest` values are interpolated directly into URL paths for Enoki API
calls without sanitization. While the Enoki API likely rejects malformed digests, the
lack of validation at the sidecar level means path traversal or injection characters
could be sent upstream.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 219-224:

```typescript
// sidecar-server.ts:219-224
const executed = await callEnoki<EnokiExecuteResponse>(
    `/transaction-blocks/sponsor/${sponsored.digest}`,
    {
        digest: sponsored.digest,
        signature: signature.signature,
    }
);
```

**File:** `services/server/scripts/sidecar-server.ts`, lines 792-796:

```typescript
// sidecar-server.ts:792-796
console.log(`[sponsor/execute] executing sponsored tx digest=${digest}`);
const executed = await callEnoki<EnokiExecuteResponse>(
    `/transaction-blocks/sponsor/${digest}`,
    { digest, signature }
);
```

In the `/sponsor/execute` endpoint (line 793), the `digest` comes directly from
`req.body` -- completely user-controlled. It is interpolated into the URL path without
any validation.

### How to Exploit

1. **URL path injection:** An attacker sends a POST to `/sponsor/execute` with:
   ```json
   { "digest": "../../admin/delete-all", "signature": "..." }
   ```
   This would construct the URL:
   `https://api.enoki.mystenlabs.com/v1/transaction-blocks/sponsor/../../admin/delete-all`

2. **SSRF-adjacent behavior:** While the `fetch()` call in `callEnoki` uses string
   concatenation (`${ENOKI_API_BASE_URL}${path}`), crafted digest values with `/`,
   `?`, `#`, or encoded characters could redirect the request to unintended Enoki API
   endpoints.

3. **Log injection:** The digest is also logged directly at line 792, allowing newline
   characters or other control sequences to be injected into log output.

### Impact

- Potential to reach unintended Enoki API endpoints, though the Bearer token limits
  what can be done.
- Log injection/spoofing.
- The first occurrence (line 219) uses `sponsored.digest` from the Enoki response itself,
  which is trusted. The second (line 793) uses user input directly.

### Severity Justification

LOW: The Enoki API is an external service that performs its own validation. The Bearer
token restricts access to MemWal's authorized operations. Path traversal in HTTP URLs
typically does not work the same way as filesystem traversal. However, the lack of input
validation violates defense-in-depth.

### Remediation

Validate that the digest matches the expected format (base64 or base58 transaction
digest) before using it:

```typescript
// Sui transaction digests are base58-encoded, typically 44 characters
const TX_DIGEST_PATTERN = /^[A-HJ-NP-Za-km-z1-9]{32,64}$/;

app.post("/sponsor/execute", async (req, res) => {
    try {
        const { digest, signature } = req.body;
        if (!digest || !signature) {
            return res.status(400).json({ error: "Missing required fields: digest, signature" });
        }
        if (!TX_DIGEST_PATTERN.test(digest)) {
            return res.status(400).json({ error: "Invalid digest format" });
        }
        // ... rest of handler
    }
});
```

Additionally, use `encodeURIComponent()` when interpolating into URL paths:

```typescript
const executed = await callEnoki<EnokiExecuteResponse>(
    `/transaction-blocks/sponsor/${encodeURIComponent(digest)}`,
    { digest, signature }
);
```

---

## S15: No packageId Format Validation

**Severity: LOW**

### What It Is

The `packageId` parameter is accepted from request bodies and used directly in Move call
targets (`${packageId}::account::seal_approve`) and passed to SEAL SDK methods without
any format validation. Sui package IDs must be 66-character hex strings starting with
`0x`, but this is never checked.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 297-298:

```typescript
// sidecar-server.ts:297-298
const { data, owner, packageId } = req.body;
if (!data || !owner || !packageId) {
```

Only checks for truthiness, not format. The `packageId` is then used at lines 361-366:

```typescript
// sidecar-server.ts:361-366
tx.moveCall({
    target: `${packageId}::account::seal_approve`,
    arguments: [
        tx.pure("vector<u8>", idBytes),
        tx.object(accountId),
    ],
});
```

And in `sealClient.encrypt()` at line 305:

```typescript
// sidecar-server.ts:303-308
const result = await sealClient.encrypt({
    threshold: 1,
    packageId,
    id: owner,
    data: new Uint8Array(plaintext),
});
```

### How to Exploit

1. **Malformed Move call targets:** Submitting `packageId: "not-a-package"` creates an
   invalid Move call target `not-a-package::account::seal_approve`. This fails at
   transaction build time, but the error message may leak internal details.

2. **Wrong package substitution:** An attacker could supply a valid but wrong package ID,
   potentially invoking a `seal_approve` function on a different package with different
   access control logic. If a malicious contract exposes a
   `<malicious_pkg>::account::seal_approve` that always approves, this could bypass
   SEAL access controls.

3. **Injection in string interpolation:** While TypeScript string interpolation does not
   have traditional injection vectors, unusual characters in `packageId` could cause
   unexpected behavior in the Sui SDK's transaction builder.

### Impact

- Error responses may leak internal SDK error details.
- Potential to invoke `seal_approve` on a different package, though the SEAL key servers
  also validate the package ID during `fetchKeys`.
- Wasted compute and network resources from invalid requests reaching the Sui RPC.

### Severity Justification

LOW: The SEAL key servers perform their own package ID validation when issuing decryption
keys, providing a second layer of defense. For encryption, using a wrong package ID would
only affect the caller's own data (encrypted under the wrong key). The primary risk is
the "wrong package" scenario for decryption, but the key servers mitigate this.

### Remediation

Add format validation for Sui object/package IDs:

```typescript
const SUI_OBJECT_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function isValidSuiObjectId(id: string): boolean {
    return SUI_OBJECT_ID_PATTERN.test(id);
}

// In each endpoint:
if (!isValidSuiObjectId(packageId)) {
    return res.status(400).json({ error: "Invalid packageId format. Expected 0x followed by 64 hex characters." });
}
```

Apply the same validation to `accountId`, `registryId`, and `owner` parameters where
they represent Sui addresses or object IDs.

---

## S16: Unbounded Epochs Parameter

**Severity: LOW**

### What It Is

The `epochs` parameter in the `/walrus/upload` endpoint accepts any value from the
request body with only a default fallback. There is no upper-bound validation. Since
epochs determine how long a Walrus blob is stored (and the associated storage cost),
an extremely large value could cause excessive on-chain costs.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, line 511:

```typescript
// sidecar-server.ts:504-512
const {
    data,
    privateKey,
    owner,
    namespace,
    packageId,
    epochs = DEFAULT_WALRUS_EPOCHS,
} = req.body;
```

The `epochs` value flows directly into the Walrus `writeBlobFlow` registration at line
529:

```typescript
// sidecar-server.ts:529-540
const registerTx = flow.register({
    epochs,
    owner: signerAddress,
    deletable: true,
    attributes: { ... },
});
```

The default is set at line 54:

```typescript
// sidecar-server.ts:54
const DEFAULT_WALRUS_EPOCHS = SUI_NETWORK === "testnet" ? 50 : 3;
```

### How to Exploit

1. **Cost amplification:** An attacker with access to the upload endpoint sends:
   ```json
   { "data": "...", "privateKey": "...", "epochs": 999999 }
   ```
   This registers the blob for an enormous number of epochs, consuming far more storage
   tokens than intended. Since the transaction is sponsored (by Enoki or the signer),
   the cost is borne by the key holder or the sponsor.

2. **Non-numeric values:** Since there is no type validation, `epochs` could be a string,
   object, or negative number. The Walrus SDK may handle these unpredictably.

3. **Zero epochs:** Setting `epochs: 0` might cause undefined behavior in blob
   registration.

### Impact

- Potential for excessive storage costs if the endpoint is exposed to untrusted callers.
- Unexpected behavior from non-numeric or out-of-range values.
- Since the signer's private key is required, the attacker is primarily burning their own
  resources, but in a sponsored transaction model the sponsor (Enoki) absorbs gas costs.

### Severity Justification

LOW: The attacker must provide a valid private key to use the upload endpoint, limiting
the attack surface to authorized users. The Walrus network itself may impose epoch limits.
The primary risk is cost amplification against the Enoki sponsor.

### Remediation

Validate and clamp the `epochs` parameter:

```typescript
const MIN_EPOCHS = 1;
const MAX_EPOCHS = SUI_NETWORK === "testnet" ? 200 : 10;

// After destructuring:
let validatedEpochs = DEFAULT_WALRUS_EPOCHS;
if (epochs !== undefined) {
    const parsed = Number(epochs);
    if (!Number.isInteger(parsed) || parsed < MIN_EPOCHS || parsed > MAX_EPOCHS) {
        return res.status(400).json({
            error: `epochs must be an integer between ${MIN_EPOCHS} and ${MAX_EPOCHS}`
        });
    }
    validatedEpochs = parsed;
}
```

---

## S18: Sensitive Data in Console Logs

**Severity: LOW**

### What It Is

Several console.log statements output potentially sensitive operational data including
user addresses, blob object IDs, transaction digests, and request metadata. In a
containerized deployment, these logs are typically aggregated into centralized logging
systems where they may be accessible to a broader audience than intended.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, line 492:

```typescript
// sidecar-server.ts:492
console.log(`[seal/decrypt-batch] ${results.length}/${items.length} decrypted ok, ${errors.length} errors`);
```

**File:** `services/server/scripts/sidecar-server.ts`, line 619:

```typescript
// sidecar-server.ts:619
console.log(`[walrus/upload] metadata set + transferred blob ${blobObjectId} to ${owner} (ns=${namespace})`);
```

**File:** `services/server/scripts/sidecar-server.ts`, lines 763-770:

```typescript
// sidecar-server.ts:763-770
console.log(`[sponsor] creating sponsored tx for sender=${sender}`);
const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
    network: enokiNetwork,
    transactionBlockKindBytes,
    sender,
});

console.log(`[sponsor] sponsored tx created, digest=${sponsored.digest}`);
```

Additionally, line 792:

```typescript
// sidecar-server.ts:792
console.log(`[sponsor/execute] executing sponsored tx digest=${digest}`);
```

### How to Exploit

1. **Log aggregation exposure:** In production, container logs are often shipped to
   services like CloudWatch, Datadog, or ELK. Anyone with access to these systems can
   see:
   - User wallet addresses (`sender`, `owner`)
   - Transaction digests (linkable to on-chain activity)
   - Namespace names (revealing organizational structure)
   - Blob object IDs (inventory of user data)

2. **Correlation attacks:** By correlating logged addresses with transaction digests, an
   attacker with log access can build a complete picture of which users are storing what
   data and when.

3. **Log injection:** Since user-controlled values (`sender`, `owner`, `namespace`,
   `digest`) are interpolated directly into log strings, an attacker can inject newline
   characters or control sequences to forge log entries or confuse log parsers.

### Impact

- Privacy leakage through operational logs.
- Correlation of user activity across requests.
- Potential log injection/spoofing.
- On-chain data is public, but log correlation reveals which server instance handles
  which user's requests -- operational metadata that is not public.

### Severity Justification

LOW: The logged data (addresses, digests) is largely derivable from public blockchain
data. The server does not log private keys or decrypted content. However, the operational
correlation and log injection vectors are real concerns in a production deployment.

### Remediation

1. Implement structured logging and sanitize interpolated values:

```typescript
import { createLogger } from './logger'; // or use pino, winston, etc.
const logger = createLogger({ service: 'sidecar' });

// Instead of:
console.log(`[sponsor] creating sponsored tx for sender=${sender}`);

// Use structured logging with sanitization:
logger.info({
    event: 'sponsor_create',
    sender: sender.slice(0, 10) + '...',  // truncate address
});
```

2. Use a log-level configuration to suppress verbose logs in production:

```typescript
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
// Only log detailed request info at debug level
if (LOG_LEVEL === 'debug') {
    logger.debug({ event: 'sponsor_create', sender, digest: sponsored.digest });
}
```

3. Sanitize user input before logging to prevent log injection:

```typescript
function sanitizeForLog(value: string): string {
    return value.replace(/[\n\r\t]/g, '').slice(0, 128);
}
```

---

## S20: Express 5.x Early Adoption

**Severity: INFO**

### What It Is

The sidecar server depends on Express 5.1.0, which was only recently released from a
long beta period. Express 5.x introduces breaking changes from the well-established
4.x line and has a significantly smaller production deployment base, meaning edge-case
bugs and security issues are less likely to have been discovered and patched.

### Where in the Code

**File:** `services/server/scripts/package.json`, line 13:

```json
{
    "dependencies": {
        "express": "^5.1.0",
        ...
    }
}
```

### How to Exploit

This is not directly exploitable. The risk is indirect:

1. Express 5.x has had less security scrutiny than Express 4.x. Undiscovered
   vulnerabilities in the framework could affect the sidecar.
2. Express 5.x changed how async error handling works. If the sidecar relies on
   Express 4.x error-handling behavior, unhandled promise rejections in route handlers
   could crash the process or leave connections hanging.
3. Community middleware and security tools may not yet be fully compatible with
   Express 5.x.

### Impact

- Potential exposure to undiscovered framework-level vulnerabilities.
- Reduced availability of security-focused middleware tested against Express 5.x.
- Risk of subtle behavioral differences from Express 4.x in error handling and routing.

### Severity Justification

INFO: Express 5.x is a legitimate, officially released version. The sidecar uses Express
in a straightforward way (JSON body parsing, simple route handlers) that is unlikely to
hit edge cases. This is a supply-chain risk awareness item rather than a concrete
vulnerability.

### Remediation

No immediate action required. Monitor Express 5.x security advisories. If stability is
a priority, consider pinning to the exact version rather than using the `^` range:

```json
"express": "5.1.0"
```

Alternatively, if Express 5.x features are not specifically needed, downgrade to the
mature Express 4.x line:

```json
"express": "^4.21.0"
```

---

## S22: tsx Runtime in Production

**Severity: INFO**

### What It Is

The sidecar server runs TypeScript files directly via `tsx` (a TypeScript executor built
on esbuild) in production. The `package.json` script and Dockerfile both invoke
TypeScript files without a compilation step, meaning `tsx` performs on-the-fly
transpilation at runtime.

### Where in the Code

**File:** `services/server/scripts/package.json`, line 7:

```json
{
    "scripts": {
        "sidecar": "tsx sidecar-server.ts"
    }
}
```

**File:** `services/server/Dockerfile`, lines 41-43:

```dockerfile
COPY scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm ci --omit=dev
COPY scripts/*.ts ./scripts/
```

The Dockerfile copies `.ts` files directly (not compiled `.js`), and `tsx` is listed as
a production dependency (line 14 of package.json):

```json
"dependencies": {
    "tsx": "^4.19.0"
}
```

### How to Exploit

This is not directly exploitable. The risks are:

1. **Startup latency:** `tsx` must parse and transpile TypeScript on each cold start.
   While tsx is fast (uses esbuild), pre-compiled JavaScript would be faster.

2. **Increased attack surface:** `tsx` and its dependency `esbuild` are additional
   runtime dependencies that could contain vulnerabilities. They are not needed if
   TypeScript is pre-compiled during the Docker build.

3. **Unpredictable transpilation:** Different versions of `tsx`/`esbuild` may transpile
   TypeScript differently, potentially introducing subtle runtime behavior changes
   without source code changes.

### Impact

- Slightly larger container image and attack surface from unnecessary runtime
  dependencies.
- Marginally slower cold starts.
- No direct security vulnerability.

### Severity Justification

INFO: `tsx` is a well-maintained, widely-used tool. The sidecar is a long-lived process
(started once at boot), so cold-start cost is minimal. This is a best-practice
recommendation, not a security finding.

### Remediation

Add a TypeScript compilation step to the Dockerfile and run compiled JavaScript:

```dockerfile
# In Dockerfile, add compilation step:
COPY scripts/package.json scripts/package-lock.json ./scripts/
COPY scripts/tsconfig.json ./scripts/
COPY scripts/*.ts ./scripts/
RUN cd scripts && npm ci && npx tsc && npm prune --production

# Then run compiled JS:
CMD ["node", "scripts/dist/sidecar-server.js"]
```

Add a `tsconfig.json` if not already present:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "bundler",
        "outDir": "dist",
        "strict": true
    },
    "include": ["*.ts"]
}
```

---

## S23: Non-Null Assertion on Regex Match Results

**Severity: INFO**

### What It Is

Multiple locations use the non-null assertion operator (`!`) on the result of
`String.match()`, which returns `null` when there is no match. If the input string is
empty or contains no matchable characters, this results in a `TypeError` at runtime
rather than a graceful error.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, line 335:

```typescript
// sidecar-server.ts:335
const keyBytes = Uint8Array.from(privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
```

**File:** `services/server/scripts/sidecar-server.ts`, line 347:

```typescript
// sidecar-server.ts:347
Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
```

**File:** `services/server/scripts/sidecar-server.ts`, line 414:

```typescript
// sidecar-server.ts:414
const keyBytes = Uint8Array.from(privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
```

**File:** `services/server/scripts/sidecar-server.ts`, line 453:

```typescript
// sidecar-server.ts:452-454
const idBytes = Array.from(
    Uint8Array.from(id.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
);
```

**File:** `services/server/scripts/seal-decrypt.ts`, line 127:

```typescript
// seal-decrypt.ts:126-128
const idBytes = Array.from(
    Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
);
```

### How to Exploit

1. If `privateKey` is an empty string (passes the `if (!privateKey)` check since
   `""` is falsy, but in the hex branch it would need to not start with "suiprivkey" --
   e.g., a single space `" "`), then `" ".match(/.{1,2}/g)` returns `[" "]` (not null),
   so this specific regex is unlikely to return null for non-empty strings.

2. However, if `fullId` (from `EncryptedObject.parse()`) were somehow an empty string,
   `"".match(/.{1,2}/g)` returns `null`, and the `!` assertion would cause:
   ```
   TypeError: Cannot read properties of null (reading 'map')
   ```

3. This crashes the request handler. Express 5.x catches async errors, but synchronous
   TypeErrors in non-async code paths could behave differently.

### Impact

- Potential unhandled `TypeError` causing a 500 error with a stack trace in the response.
- The outer try/catch blocks should catch these, so the impact is limited to unhelpful
  error messages rather than server crashes.

### Severity Justification

INFO: The regex `/.{1,2}/g` matches any character (including whitespace, control
characters), so it only returns `null` for truly empty strings. The inputs in question
(`privateKey` in the hex branch, `fullId` from `EncryptedObject.parse()`) are unlikely to
be empty strings given the preceding validation. The non-null assertions are code-smell
rather than real vulnerabilities.

### Remediation

Replace non-null assertions with explicit null checks:

```typescript
function hexToBytes(hex: string): Uint8Array {
    const matches = hex.match(/.{1,2}/g);
    if (!matches) {
        throw new Error("Invalid hex string: empty input");
    }
    return Uint8Array.from(matches.map((b) => parseInt(b, 16)));
}

// Usage:
const keyBytes = hexToBytes(privateKey);
const idBytes = Array.from(hexToBytes(fullId));
```

This centralizes the hex parsing logic, eliminates all five non-null assertions, and
provides a clear error message when the input is invalid.

---

## S25: signerUploadQueues Memory Leak Potential

**Severity: LOW**

### What It Is

The `signerUploadQueues` map stores per-signer promise chains to serialize concurrent
uploads. While the cleanup logic at line 263-265 deletes the map entry when the current
task is the last in the chain, race conditions or unhandled rejections could cause
entries to persist indefinitely.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, line 136:

```typescript
// sidecar-server.ts:136
const signerUploadQueues = new Map<string, Promise<void>>();
```

**File:** `services/server/scripts/sidecar-server.ts`, lines 248-267:

```typescript
// sidecar-server.ts:248-267
async function runExclusiveBySigner<T>(signerAddress: string, task: () => Promise<T>): Promise<T> {
    const previous = signerUploadQueues.get(signerAddress) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const queued = previous.then(() => current);
    signerUploadQueues.set(signerAddress, queued);

    await previous;
    try {
        return await task();
    } finally {
        release();
        // Cleanup queue map entry once this task is done and no newer task replaced it.
        if (signerUploadQueues.get(signerAddress) === queued) {
            signerUploadQueues.delete(signerAddress);
        }
    }
}
```

### How to Exploit

1. **Promise chain retention:** Even when cleanup succeeds, the promise chain retains
   references to all intermediate promises. If signer A makes 1000 sequential uploads,
   the chain is `p1.then(() => p2).then(() => p3)...then(() => p1000)`. Until the final
   promise resolves, all intermediate closures are retained in memory.

2. **Stale entries from racing:** Consider this sequence:
   - Task A starts for signer X, sets `queued_A` in map
   - Task B starts for signer X, sets `queued_B` in map (replacing `queued_A`)
   - Task A finishes, checks `map.get(X) === queued_A` -- this is `false` (it's
     `queued_B`), so it does NOT delete
   - Task B finishes, checks `map.get(X) === queued_B` -- this is `true`, deletes
   This is correct behavior. However, if Task B throws and the `finally` block's
   `release()` is called but `queued_B` is never awaited by another task, `queued_B`
   remains settled but the map entry persists until the next upload for signer X.

3. **Unbounded signers:** Each unique signer address gets a map entry. If many unique
   signers make uploads, the map grows without bound. There is no TTL or eviction policy.

### Impact

- Gradual memory growth in long-running sidecar processes proportional to the number of
  unique signer addresses that have made uploads.
- For typical usage with a small number of signers, this is negligible.
- In adversarial scenarios where many unique ephemeral keys are used, memory could grow
  significantly over time.

### Severity Justification

LOW: The map entries are small (a string key + a Promise reference), and the cleanup
logic works correctly for the normal case. Memory growth is proportional to the number
of unique signers, which is bounded by the number of valid private keys in the system.
This is a long-running process hygiene issue.

### Remediation

Add a periodic cleanup sweep and/or a maximum size limit:

```typescript
const MAX_SIGNER_QUEUE_SIZE = 1000;
const SIGNER_QUEUE_CLEANUP_INTERVAL_MS = 60_000;

// Periodic cleanup of settled promises
setInterval(() => {
    for (const [address, promise] of signerUploadQueues) {
        // Check if promise is settled by racing with an immediate resolve
        Promise.race([
            promise.then(() => true),
            Promise.resolve(false),
        ]).then((settled) => {
            if (settled) {
                signerUploadQueues.delete(address);
            }
        });
    }
}, SIGNER_QUEUE_CLEANUP_INTERVAL_MS);

// In runExclusiveBySigner, add size guard:
if (signerUploadQueues.size > MAX_SIGNER_QUEUE_SIZE) {
    throw new Error("Upload queue capacity exceeded. Try again later.");
}
```

A simpler approach is to use a `Map` with a `WeakRef` or simply accept the minor memory
cost and document the expected signer cardinality.

---

## S26: Health Endpoint Leaks Uptime

**Severity: INFO**

### What It Is

The `/health` endpoint returns `process.uptime()`, revealing exactly how long the sidecar
process has been running. This is a minor information disclosure that aids attacker
reconnaissance.

### Where in the Code

**File:** `services/server/scripts/sidecar-server.ts`, lines 288-289:

```typescript
// sidecar-server.ts:288-289
app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
});
```

### How to Exploit

1. **Deployment timing:** The uptime reveals when the server was last restarted/deployed.
   An attacker monitoring uptime can detect:
   - Deployment frequency (how often patches are applied)
   - Whether a restart occurred (indicating a possible crash or config change)
   - How long the server has been running without patches

2. **Post-exploit validation:** After attempting an exploit that should crash the process,
   an attacker can check if uptime reset to near-zero to confirm the crash succeeded.

3. **Infrastructure fingerprinting:** Combined with other information (response headers,
   Node.js version fingerprinting), uptime helps build a detailed picture of the
   deployment environment.

### Impact

- Minor information disclosure useful for reconnaissance.
- No direct security impact.

### Severity Justification

INFO: Uptime disclosure is a common best-practice violation listed in hardening guides
(e.g., OWASP). It provides marginal value to an attacker and is trivially fixable. The
health endpoint is typically not exposed to the public internet (it runs on port 9000,
intended for internal health checks).

### Remediation

Remove the uptime from the health response. If uptime monitoring is needed, expose it
on a separate metrics endpoint that is not publicly accessible:

```typescript
// Public health check -- minimal response
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

// Internal metrics (bind to separate port or protect with auth)
app.get("/internal/metrics", (_req, res) => {
    res.json({
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        signerQueueSize: signerUploadQueues.size,
    });
});
```

Alternatively, if the health endpoint must stay as-is for internal tooling, ensure it is
not exposed through the public-facing reverse proxy.
