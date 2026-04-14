# MemWal SDK Client -- Detailed Security Finding Explanations

**Source review:** `security-review/05-sdk-client.md`
**Date:** 2026-04-02
**Commit:** 5bb1669

---

## Finding 1.1 -- CRITICAL: Private Key Sent in `x-delegate-key` Header on Every Request

### What It Is

The `MemWal` class (the "server mode" SDK client) transmits the raw Ed25519 private key -- the delegate key that authenticates the user -- as an HTTP header on every single API request. This is the cryptographic equivalent of mailing your house key with every letter you send. The private key is the one secret that should never leave the client; it exists solely to *prove* identity by signing messages, not to be shared.

### Where in the Code

**File:** `packages/sdk/src/memwal.ts`, lines 306-317

```typescript
const res = await fetch(url, {
    method,
    headers: {
        "Content-Type": "application/json",
        "x-public-key": bytesToHex(publicKey),
        "x-signature": bytesToHex(signature),
        "x-timestamp": timestamp,
        "x-delegate-key": bytesToHex(this.privateKey),   // <-- LINE 314
        "x-account-id": this.accountId,
    },
    body: bodyStr,
});
```

This `signedRequest` method is called by every API method in the class:

- `remember()` (line 103)
- `recall()` (line 126)
- `rememberManual()` (line 156)
- `recallManual()` (line 189)
- `embed()` (line 203)
- `analyze()` (line 220)
- `restore()` (line 240)

There is no conditional logic; the private key is sent unconditionally for all seven endpoints.

For comparison, the `MemWalManual` class in `packages/sdk/src/manual.ts` (lines 547-554) sends only three auth headers and omits the private key entirely:

```typescript
headers: {
    "Content-Type": "application/json",
    "x-public-key": bytesToHex(publicKey),
    "x-signature": bytesToHex(signature),
    "x-timestamp": timestamp,
},
```

This proves the private key header is not required for server-side authentication.

### How It Could Be Exploited

1. **Network interception:** An attacker positions themselves on the network path between the SDK client and the server (e.g., compromised Wi-Fi, ISP-level interception, corporate proxy, or a misconfigured load balancer). Since the default server URL is `http://localhost:8000` (plaintext HTTP -- see Finding 7.1), any non-localhost deployment over HTTP transmits the key in cleartext.
2. **Read the header:** The attacker captures any single HTTP request and extracts the `x-delegate-key` header value.
3. **Full impersonation:** With the private key, the attacker can now sign arbitrary requests as the victim. They can `remember` (write arbitrary data), `recall` (read all the victim's memories), `analyze`, `restore`, or call any other endpoint.
4. **Persistence:** The delegate key remains valid until explicitly revoked on-chain via `remove_delegate_key`. The victim has no indication that their key was compromised.

Even without network interception:
- Server-side access logs that record HTTP headers will contain the private key in plaintext.
- Any logging middleware, reverse proxy (nginx, Cloudflare), or APM tool that captures request headers will store the key.
- A compromised server gains every user's private key for free, even if the server's own secrets are isolated.

### Impact

- **Complete account takeover:** The attacker can read all stored memories and write new ones.
- **Lateral movement:** If the delegate key is reused or if the attacker uses the key to derive the associated Sui address (possible since it is an Ed25519 key), they may access on-chain assets.
- **Stealth:** No on-chain transaction is needed to exploit this; the attacker simply makes API calls.
- **Scale:** Every single API call leaks the key, so even brief network monitoring yields credentials.

### Why the Severity Rating Is Correct

CRITICAL is correct because:
- **Exploitability is trivial** -- any party that can observe a single HTTP request obtains the key.
- **Impact is total** -- the attacker gains full read/write access to all of a user's encrypted memories.
- **The vulnerability is systematic** -- it affects every authenticated API call, not an edge case.
- **It violates the fundamental principle of public-key cryptography** -- private keys must never be transmitted.
- **Confidence is 10/10** -- the code is unambiguous; `bytesToHex(this.privateKey)` is literally on line 314.

### Remediation

**Immediate fix:** Remove line 314 from `packages/sdk/src/memwal.ts`:

```typescript
// BEFORE (vulnerable)
headers: {
    "Content-Type": "application/json",
    "x-public-key": bytesToHex(publicKey),
    "x-signature": bytesToHex(signature),
    "x-timestamp": timestamp,
    "x-delegate-key": bytesToHex(this.privateKey),  // DELETE THIS LINE
    "x-account-id": this.accountId,
},

// AFTER (safe)
headers: {
    "Content-Type": "application/json",
    "x-public-key": bytesToHex(publicKey),
    "x-signature": bytesToHex(signature),
    "x-timestamp": timestamp,
    "x-account-id": this.accountId,
},
```

**Architectural fix:** The server currently uses the delegate private key to perform SEAL decryption on the user's behalf. This server-side decryption model should be replaced with client-side decryption (as `MemWalManual` already implements). If server-side decryption must persist temporarily, use a short-lived session token derived from a key exchange, not the raw private key.

---

## Finding 1.2 -- HIGH: Key Material Held in Memory Without Cleanup

### What It Is

Both SDK client classes store cryptographic key material (private keys, decoded keypairs) in JavaScript object properties for the entire lifetime of the client instance. There is no mechanism to zero out or release this sensitive material when it is no longer needed. In languages like C, developers zero key buffers after use; JavaScript provides `Uint8Array` which supports byte-level writes for zeroing, but the SDK never does this.

### Where in the Code

**File:** `packages/sdk/src/manual.ts`, lines 74-86 (constructor):

```typescript
private constructor(config: MemWalManualConfig) {
    if (!config.suiPrivateKey && !config.walletSigner) {
        throw new Error("MemWalManual: provide either suiPrivateKey or walletSigner");
    }
    if (config.suiPrivateKey && config.walletSigner) {
        throw new Error("MemWalManual: provide suiPrivateKey OR walletSigner, not both");
    }
    this.delegatePrivateKey = hexToBytes(config.key);         // stored forever
    this.serverUrl = (config.serverUrl ?? "http://localhost:8000").replace(/\/$/, "");
    this.walletSigner = config.walletSigner ?? null;
    this.config = config;   // <-- entire config object stored, including suiPrivateKey string
    this.namespace = config.namespace ?? "default";
}
```

**File:** `packages/sdk/src/manual.ts`, lines 146-157 (keypair caching):

```typescript
private async getKeypair() {
    if (this.walletSigner) {
        throw new Error("getKeypair() not available in wallet signer mode");
    }
    if (!this._keypair) {
        const { decodeSuiPrivateKey } = await import("@mysten/sui/cryptography");
        const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
        const { secretKey } = decodeSuiPrivateKey(this.config.suiPrivateKey!);
        this._keypair = Ed25519Keypair.fromSecretKey(secretKey);  // cached indefinitely
    }
    return this._keypair;
}
```

**File:** `packages/sdk/src/memwal.ts`, lines 63-70 (MemWal class):

```typescript
export class MemWal {
    private privateKey: Uint8Array;     // stored forever
    private publicKey: Uint8Array | null = null;
    ...
    private constructor(config: MemWalConfig) {
        this.privateKey = hexToBytes(config.key);  // never zeroed
```

### How It Could Be Exploited

1. **Memory dump attack:** An attacker with access to the process (e.g., via a separate vulnerability, core dump, or debugging access) can read the process memory and find the private key bytes.
2. **Heap inspection in browser:** In browser environments, DevTools memory profiler or a malicious browser extension can inspect the JavaScript heap and find `Uint8Array` objects containing key material.
3. **Swap/hibernation:** If the OS swaps the process memory to disk or the machine hibernates, the key material is written to persistent storage in cleartext.
4. **Long-running processes:** Server-side Node.js applications may run for days or weeks. The key material remains in memory the entire time, widening the attack window.

### Impact

- An attacker who gains read access to process memory at any point during the client's lifetime can extract private keys.
- The `config` object in `MemWalManual` contains `suiPrivateKey` (a bech32-encoded Sui private key), which controls on-chain assets beyond just MemWal.

### Why the Severity Rating Is Correct

HIGH is appropriate because:
- The attack requires a secondary vulnerability (memory access), reducing likelihood compared to CRITICAL.
- However, the impact of key extraction is severe (full account compromise, potential on-chain asset theft).
- The `suiPrivateKey` in the config object controls Sui wallet assets, making the impact broader than just MemWal.
- Confidence is 7/10 because exploitation depends on the runtime environment and attacker capabilities.

### Remediation

Add a `destroy()` method to both classes that zeroes key material:

```typescript
// Add to MemWal class in memwal.ts
destroy(): void {
    this.privateKey.fill(0);
    if (this.publicKey) {
        this.publicKey.fill(0);
    }
}

// Add to MemWalManual class in manual.ts
destroy(): void {
    this.delegatePrivateKey.fill(0);
    if (this.delegatePublicKey) {
        this.delegatePublicKey.fill(0);
    }
    this._keypair = null;
    this._sealClient = null;
    // Note: this.config.suiPrivateKey is a string and cannot be zeroed (see 1.3)
    // but we can at least remove the reference
    (this.config as any).suiPrivateKey = undefined;
    (this.config as any).key = undefined;
}
```

Document the expected key lifecycle and advise callers to call `destroy()` when the client is no longer needed.

---

## Finding 1.3 -- MEDIUM: Private Key Passed as Immutable JavaScript String

### What It Is

Both `MemWalConfig` and `MemWalManualConfig` accept private keys as hex-encoded strings (`string` type). JavaScript strings are immutable -- once created, their contents cannot be modified or zeroed. Even after all references to the string are removed, the original bytes persist in the V8 heap until garbage collection, and GC timing is unpredictable. This means there is no reliable way to erase key material from memory.

### Where in the Code

**File:** `packages/sdk/src/types.ts`, line 13:

```typescript
export interface MemWalConfig {
    /** Ed25519 private key (hex string). This is the delegate key from app.memwal.com */
    key: string;   // <-- immutable JS string
```

**File:** `packages/sdk/src/types.ts`, lines 126-127:

```typescript
export interface MemWalManualConfig {
    /** Ed25519 delegate private key (hex) for server auth */
    key: string;   // <-- immutable JS string
```

**File:** `packages/sdk/src/memwal.ts`, line 70 (consumption):

```typescript
this.privateKey = hexToBytes(config.key);  // converts to Uint8Array, but original string persists
```

Even though `hexToBytes` converts the string to a `Uint8Array` (which can be zeroed), the original `config.key` string remains in the caller's scope and in the JS heap.

### How It Could Be Exploited

1. The caller passes a hex string: `MemWal.create({ key: "abcdef..." })`.
2. The SDK converts it to `Uint8Array` internally, but the original string literal `"abcdef..."` remains on the JS heap.
3. A memory dump or heap snapshot reveals the key string even after the SDK instance is destroyed.
4. In browser environments, V8's string interning may keep the string alive longer than expected.

### Impact

- Key material persists in memory for an unpredictable duration, even if the application attempts cleanup.
- Combined with Finding 1.2, this makes complete key erasure impossible with the current API.

### Why the Severity Rating Is Correct

MEDIUM is correct because:
- This is a defense-in-depth issue; exploitation requires memory access (same as 1.2).
- The impact is limited to extending the window of key exposure, not creating a new attack vector.
- It is a fundamental limitation of the JavaScript runtime, not a bug per se, but the API design could mitigate it.
- Confidence is 8/10 because the behavior is well-documented in V8/SpiderMonkey internals.

### Remediation

1. Accept `Uint8Array` as an alternative input type:

```typescript
export interface MemWalConfig {
    /** Ed25519 private key -- hex string OR Uint8Array (preferred for security) */
    key: string | Uint8Array;
    ...
}
```

2. Update the constructor:

```typescript
private constructor(config: MemWalConfig) {
    this.privateKey = typeof config.key === 'string'
        ? hexToBytes(config.key)
        : new Uint8Array(config.key);  // defensive copy
    ...
}
```

3. Document the limitation: if a hex string is provided, it cannot be erased from memory. Recommend `Uint8Array` for security-sensitive deployments.

---

## Finding 2.2 -- MEDIUM: Query String Not Included in Signature

### What It Is

The SDK's request signing scheme constructs the signed message from `timestamp`, HTTP method, URL path, and body hash. Crucially, the URL query string is excluded. This means a man-in-the-middle (MitM) could modify query parameters without invalidating the signature.

### Where in the Code

**File:** `packages/sdk/src/memwal.ts`, lines 293-298:

```typescript
const timestamp = Math.floor(Date.now() / 1000).toString();
const bodyStr = JSON.stringify(body);
const bodySha256 = await sha256hex(bodyStr);

// Build message to sign
const message = `${timestamp}.${method}.${path}.${bodySha256}`;
```

The `path` parameter is always a hardcoded string like `"/api/remember"` or `"/api/recall/manual"` -- it never includes query parameters.

**File:** `packages/sdk/src/manual.ts`, lines 536-540 (identical pattern):

```typescript
const timestamp = Math.floor(Date.now() / 1000).toString();
const bodyStr = JSON.stringify(body);
const bodySha256 = await sha256hex(bodyStr);

const message = `${timestamp}.${method}.${path}.${bodySha256}`;
```

### How It Could Be Exploited

Currently, all SDK endpoints use POST with JSON bodies, and parameters are sent in the body (which IS signed). However:

1. If the server adds GET endpoints or query-parameterized routes in the future, an attacker could modify query parameters (e.g., `?limit=1000`, `?namespace=other`) without breaking the signature.
2. An attacker intercepts a request to `/api/recall/manual` and appends `?debug=true` or `?admin=true` -- the signature remains valid.
3. If a reverse proxy or CDN caches responses based on query strings, an attacker could poison the cache.

### Impact

- Currently limited (all parameters are in the POST body).
- Creates a fragile security assumption that will break silently when new endpoints or query parameters are added.
- Could allow parameter injection if the server ever reads query parameters for any authenticated route.

### Why the Severity Rating Is Correct

MEDIUM is correct because:
- No currently exploitable path exists (all routes use POST bodies).
- But the gap is real, well-defined, and will become exploitable the moment any query-parameterized route is added.
- Confidence is 9/10 because the code clearly shows `path` without query string in the signature.
- Defense-in-depth principle demands signing all request components.

### Remediation

Include the full URL (path + query string) in the signed message:

```typescript
// In signedRequest(), change the message construction:
private async signedRequest<T>(
    method: string,
    path: string,
    body: object,
    queryParams?: Record<string, string>,
): Promise<T> {
    const ed = await getEd();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = JSON.stringify(body);
    const bodySha256 = await sha256hex(bodyStr);

    // Include query string in signature
    const queryString = queryParams
        ? "?" + new URLSearchParams(queryParams).toString()
        : "";
    const signedPath = path + queryString;

    const message = `${timestamp}.${method}.${signedPath}.${bodySha256}`;
    ...
}
```

---

## Finding 2.3 -- MEDIUM: 5-Minute Replay Window, No Nonce

### What It Is

The signed request includes a Unix timestamp (seconds precision), and the server validates that the timestamp is within a 5-minute window. However, the signed payload contains no nonce or unique request identifier. This means an identical request captured within the 5-minute window can be replayed verbatim -- the server cannot distinguish the replay from the original.

### Where in the Code

**File:** `packages/sdk/src/memwal.ts`, line 293:

```typescript
const timestamp = Math.floor(Date.now() / 1000).toString();
```

**File:** `packages/sdk/src/manual.ts`, line 536:

```typescript
const timestamp = Math.floor(Date.now() / 1000).toString();
```

The signed message format (both files):

```typescript
const message = `${timestamp}.${method}.${path}.${bodySha256}`;
```

No nonce, request ID, or sequence number is included. The same timestamp + method + path + body will produce the same signature within the same second, and even across seconds the server only checks the 5-minute window.

### How It Could Be Exploited

1. **Capture:** An attacker intercepts a `remember` request (e.g., via a compromised network or Finding 7.1's HTTP transport).
2. **Replay within window:** Within 5 minutes, the attacker resends the exact same request with the same headers. The server validates the signature and timestamp -- both pass.
3. **Duplicate write:** The `remember` endpoint stores a duplicate memory entry. For `analyze`, the server processes the same text twice, potentially creating duplicate facts.
4. **Denial of service:** An attacker could replay expensive operations (embedding generation, SEAL encryption) to exhaust server resources or the user's API quotas.
5. **State manipulation:** If a `restore` endpoint has side effects (re-indexing), replaying it could cause data corruption.

### Impact

- Duplicate data entries in the user's memory store.
- Resource exhaustion on the server (repeated embedding/encryption operations).
- Potential for state confusion if idempotency is not guaranteed on all endpoints.

### Why the Severity Rating Is Correct

MEDIUM is correct because:
- The replay window is bounded (5 minutes), limiting the attack duration.
- The attacker must be able to observe network traffic (requires MitM or compromised transport).
- The impact is data duplication and resource waste, not credential theft.
- Confidence is 9/10 because the absence of a nonce is verifiable from the code.

### Remediation

Add a cryptographically random nonce to the signed message and transmit it as a header:

```typescript
private async signedRequest<T>(
    method: string,
    path: string,
    body: object,
): Promise<T> {
    const ed = await getEd();

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();  // ADD: unique per request
    const bodyStr = JSON.stringify(body);
    const bodySha256 = await sha256hex(bodyStr);

    // Include nonce in signed message
    const message = `${timestamp}.${nonce}.${method}.${path}.${bodySha256}`;
    const msgBytes = new TextEncoder().encode(message);
    const signature = await ed.signAsync(msgBytes, this.privateKey);
    const publicKey = await this.getPublicKey();

    const res = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            "x-public-key": bytesToHex(publicKey),
            "x-signature": bytesToHex(signature),
            "x-timestamp": timestamp,
            "x-nonce": nonce,             // ADD: send nonce to server
            "x-account-id": this.accountId,
        },
        body: bodyStr,
    });
    ...
}
```

The server must then:
1. Include the nonce in its signature verification message.
2. Store seen nonces (e.g., in Redis with a 5-minute TTL) and reject duplicates.

---

## Finding 4.2 -- HIGH: SEAL `verifyKeyServers` Disabled

### What It Is

The SEAL encryption client is initialized with `verifyKeyServers: false`, which disables on-chain verification that the key servers the client communicates with are the legitimate, registered SEAL key servers. Without this verification, the client trusts whatever servers respond at the configured endpoints, making it vulnerable to man-in-the-middle attacks on the SEAL protocol.

### Where in the Code

**File:** `packages/sdk/src/manual.ts`, lines 194-201:

```typescript
this._sealClient = new SealClient({
    suiClient,
    serverConfigs: keyServers.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,   // <-- LINE 200: verification disabled
});
```

This is in the `getSealClient()` method (line 181), which is called by `sealEncrypt()` (line 451) and the decryption flow in `recallManual()` (line 310).

### How It Could Be Exploited

1. **DNS poisoning or MitM:** An attacker compromises DNS resolution or intercepts network traffic between the SDK and the SEAL key servers.
2. **Substitute rogue key server:** The attacker redirects SEAL key server requests to their own server that mimics the SEAL protocol.
3. **Key exfiltration during encryption:** When the SDK calls `sealClient.encrypt()`, the rogue server can provide keys it controls. The data is encrypted under the attacker's keys instead of the legitimate SEAL keys.
4. **Key exfiltration during decryption:** When the SDK calls `sealClient.fetchKeys()` during `recallManual()`, the rogue server can observe the decryption request and potentially return keys that allow the attacker to read the plaintext.
5. **Silent compromise:** The user sees no errors; encryption and decryption appear to work normally because the rogue server cooperates.

### Impact

- **Confidentiality breach:** All SEAL-encrypted memories can be decrypted by the attacker.
- **Integrity breach:** The attacker can encrypt data under their keys, making it appear to come from the user.
- **Affects all MemWalManual users:** Every client instance uses this setting.

### Why the Severity Rating Is Correct

HIGH is correct because:
- SEAL is the core encryption layer protecting user memory data.
- Disabling verification removes a critical trust anchor (on-chain key server registration).
- The fix is trivial (one boolean), making the risk/effort ratio highly unfavorable.
- Confidence is 8/10 because exploitation requires network-level access, but the vulnerability itself is absolute.

### Remediation

Change one line in `packages/sdk/src/manual.ts`, line 200:

```typescript
// BEFORE
verifyKeyServers: false,

// AFTER
verifyKeyServers: true,
```

If there are performance concerns about on-chain verification on every client instantiation, consider caching the verification result with a short TTL.

---

## Finding 4.3 -- MEDIUM: SEAL Threshold Hardcoded to 1

### What It Is

The SEAL encryption threshold is hardcoded to `1`, meaning only a single SEAL key server needs to participate for encryption or decryption to succeed. In a threshold encryption scheme, the threshold determines how many key servers must collude (or be compromised) to break confidentiality. With threshold=1, compromising any single key server breaks the encryption for all data.

### Where in the Code

**File:** `packages/sdk/src/manual.ts`, lines 454-459 (`sealEncrypt` method):

```typescript
const result = await sealClient.encrypt({
    threshold: 1,                          // <-- LINE 455: hardcoded
    packageId: this.config.packageId,
    id: ownerAddress,
    data: plaintext,
});
```

Also in the decryption flow, `packages/sdk/src/manual.ts`, lines 361-366:

```typescript
await sealClient.fetchKeys({
    ids: [fullId],
    txBytes,
    sessionKey,
    threshold: 1,                          // <-- LINE 366: hardcoded
});
```

The configured key servers show that testnet has 2 servers available (lines 51-53):

```typescript
testnet: [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
],
```

Yet the threshold is still 1, meaning only one of the two needs to cooperate.

### How It Could Be Exploited

1. **Compromise one key server:** An attacker gains control of a single SEAL key server (through a vulnerability, insider threat, or by running a malicious server that gets registered).
2. **Decrypt all data:** Since threshold=1, the compromised server alone can provide the decryption keys needed for any user's data.
3. **No detection:** The second key server is never needed, so its operator would not notice that decryption is happening through the other server alone.

### Impact

- The security guarantee of threshold encryption is effectively nullified.
- All user memories encrypted with SEAL are protected by the security of a single server rather than a quorum.

### Why the Severity Rating Is Correct

MEDIUM is correct because:
- Exploitation requires compromising a SEAL key server, which is a non-trivial attack.
- The design choice significantly weakens what should be a strong cryptographic guarantee.
- Mainnet currently has only 1 key server configured, making threshold >1 impossible in production today -- but the code should be ready for when more servers are available.
- Confidence is 7/10 because the practical impact depends on the number of available key servers.

### Remediation

Make the threshold configurable via the config object and default to a majority:

```typescript
// In MemWalManualConfig (types.ts), add:
/** SEAL threshold -- minimum key servers needed (default: ceil(n/2)) */
sealThreshold?: number;

// In sealEncrypt() (manual.ts):
const keyServers = this.config.sealKeyServers ?? DEFAULT_KEY_SERVERS[network] ?? [];
const threshold = this.config.sealThreshold ?? Math.ceil(keyServers.length / 2);

const result = await sealClient.encrypt({
    threshold,
    packageId: this.config.packageId,
    id: ownerAddress,
    data: plaintext,
});

// Same change in the fetchKeys call in recallManual():
await sealClient.fetchKeys({
    ids: [fullId],
    txBytes,
    sessionKey,
    threshold,
});
```

---

## Finding 4.4 -- LOW: SEAL Encryption ID is Owner-Scoped, Not Namespace-Scoped

### What It Is

When encrypting data with SEAL, the SDK uses the owner's Sui address as the encryption ID. This ID determines the access control policy -- who can request decryption keys. Since the same owner address is used regardless of namespace, all memories across all namespaces share the same SEAL policy. A delegate key authorized for one namespace could potentially request SEAL decryption for data stored in a different namespace.

### Where in the Code

**File:** `packages/sdk/src/manual.ts`, lines 450-459:

```typescript
private async sealEncrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const sealClient = await this.getSealClient();
    const ownerAddress = await this.getOwnerAddress();

    const result = await sealClient.encrypt({
        threshold: 1,
        packageId: this.config.packageId,
        id: ownerAddress,           // <-- LINE 457: only owner address, no namespace
        data: plaintext,
    });

    return new Uint8Array(result.encryptedObject);
}
```

The `id` field is `ownerAddress` (a Sui address like `0x1a2b3c...`). The namespace (e.g., `"my-app"`, `"personal"`) is not incorporated.

### How It Could Be Exploited

1. A user creates memories in namespace `"personal"` and namespace `"work"`, intending them to be isolated.
2. An application with a delegate key authorized only for the `"work"` namespace makes a SEAL decryption request.
3. Since the SEAL encryption ID is the same owner address for both namespaces, the key servers cannot distinguish between authorized and unauthorized namespace access at the SEAL level.
4. The application decrypts blobs from the `"personal"` namespace, bypassing the intended namespace isolation.

Note: This attack depends on how the `seal_approve` Move function validates access. If it only checks the delegate key against the account (not the namespace), the namespace boundary is purely a server-side filter, not a cryptographic boundary.

### Impact

- Namespace isolation is not enforced at the cryptographic layer.
- Users who rely on namespaces for access control between different applications or contexts get weaker isolation than expected.

### Why the Severity Rating Is Correct

LOW is correct because:
- Exploitation requires a delegate key already authorized on the account (limited attacker pool).
- Namespace isolation may also be enforced at the server layer, providing a secondary check.
- The current design may be intentional for simplicity, and the threat model may not require namespace-level SEAL isolation.
- Confidence is 6/10 because the actual exploitability depends on the Move contract's `seal_approve` logic.

### Remediation

Incorporate the namespace (and optionally the account ID) into the SEAL encryption ID:

```typescript
private async sealEncrypt(plaintext: Uint8Array, namespace: string): Promise<Uint8Array> {
    const sealClient = await this.getSealClient();
    const ownerAddress = await this.getOwnerAddress();

    // Create a namespace-scoped encryption ID
    const sealId = `${ownerAddress}:${this.config.accountId}:${namespace}`;

    const result = await sealClient.encrypt({
        threshold: 1,
        packageId: this.config.packageId,
        id: sealId,
        data: plaintext,
    });

    return new Uint8Array(result.encryptedObject);
}
```

The `seal_approve` Move function must also be updated to validate the namespace component of the ID.

---

## Finding 5.1 -- LOW: No Client-Side Input Validation

### What It Is

The `MemWal` class performs zero input validation on user-provided text, queries, namespaces, or limits before sending them to the server. The `MemWalManual` class is slightly better (it checks for empty text/query) but still does not validate namespace characters, limit bounds, or text length.

### Where in the Code

**File:** `packages/sdk/src/memwal.ts`, lines 102-106 (`remember` -- no validation):

```typescript
async remember(text: string, namespace?: string): Promise<RememberResult> {
    return this.signedRequest<RememberResult>("POST", "/api/remember", {
        text,                    // no check for empty, null, or excessively long text
        namespace: namespace ?? this.namespace,   // no character validation
    });
}
```

**File:** `packages/sdk/src/memwal.ts`, lines 125-131 (`recall` -- no validation):

```typescript
async recall(query: string, limit: number = 10, namespace?: string): Promise<RecallResult> {
    return this.signedRequest<RecallResult>("POST", "/api/recall", {
        query,                   // no check for empty
        limit,                   // no bounds check (could be 0, negative, or extremely large)
        namespace: namespace ?? this.namespace,
    });
}
```

**File:** `packages/sdk/src/manual.ts`, lines 238-239 (`rememberManual` -- minimal validation):

```typescript
async rememberManual(text: string, namespace?: string): Promise<RememberManualResult> {
    if (!text) throw new Error("Text cannot be empty");  // only check: not falsy
    // No max length check, no namespace validation
```

**File:** `packages/sdk/src/manual.ts`, lines 265-266 (`recallManual` -- minimal validation):

```typescript
async recallManual(query: string, limit: number = 10, namespace?: string): Promise<RecallManualResult> {
    if (!query) throw new Error("Query cannot be empty");  // only check: not falsy
    // No limit bounds check
```

### How It Could Be Exploited

1. **Oversized payloads:** A caller passes a 100MB string to `remember()`. The SDK serializes it, computes SHA-256, signs it, and sends it to the server. If the server also lacks length limits, this consumes memory and bandwidth.
2. **Invalid namespace characters:** A namespace like `"../../admin"` or `"default; DROP TABLE memories"` is sent directly to the server. While the server should validate, defense-in-depth requires client-side validation too.
3. **Negative or zero limits:** `recall("query", -1)` or `recall("query", 0)` produces undefined server behavior.
4. **Empty strings in MemWal class:** `remember("")` sends an empty text to the server for embedding, wasting resources.

### Impact

- Poor developer experience (cryptic server errors instead of clear client-side errors).
- Potential for denial-of-service via oversized payloads.
- Risk of injection if the server does not properly validate inputs.

### Why the Severity Rating Is Correct

LOW is correct because:
- The server should be the primary enforcement point for input validation.
- Client-side validation is a defense-in-depth measure and a UX improvement.
- No known exploitable vulnerability results from the missing validation alone.
- Confidence is 9/10 because the absence of validation is easily verified.

### Remediation

Add validation to both classes:

```typescript
// Shared validation constants
const MAX_TEXT_LENGTH = 100_000;  // 100KB
const MAX_NAMESPACE_LENGTH = 128;
const NAMESPACE_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_LIMIT = 1000;

// In remember():
async remember(text: string, namespace?: string): Promise<RememberResult> {
    if (!text || text.trim().length === 0) {
        throw new Error("Text cannot be empty");
    }
    if (text.length > MAX_TEXT_LENGTH) {
        throw new Error(`Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters`);
    }
    const ns = namespace ?? this.namespace;
    if (!NAMESPACE_REGEX.test(ns)) {
        throw new Error("Namespace must contain only alphanumeric characters, hyphens, and underscores");
    }
    ...
}

// In recall():
async recall(query: string, limit: number = 10, namespace?: string): Promise<RecallResult> {
    if (!query || query.trim().length === 0) {
        throw new Error("Query cannot be empty");
    }
    if (limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`Limit must be between 1 and ${MAX_LIMIT}`);
    }
    ...
}
```

---

## Finding 5.2 -- LOW: `hexToBytes` Silently Accepts Invalid Hex

### What It Is

The `hexToBytes` utility function does not validate that its input is a valid hexadecimal string. Non-hex characters (like `"g"`, `"z"`, spaces, or Unicode) are parsed by `parseInt(..., 16)`, which returns `NaN` for invalid input. `NaN` is then silently stored as `0` in the `Uint8Array` (because `NaN | 0 === 0` in typed array assignment). The function also does not check for odd-length strings or expected byte counts.

### Where in the Code

**File:** `packages/sdk/src/utils.ts`, lines 32-39:

```typescript
export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        // parseInt("zz", 16) === NaN
        // Uint8Array assignment: NaN becomes 0
    }
    return bytes;
}
```

This function is called in critical paths:

- `packages/sdk/src/memwal.ts`, line 70: `this.privateKey = hexToBytes(config.key);`
- `packages/sdk/src/manual.ts`, line 81: `this.delegatePrivateKey = hexToBytes(config.key);`
- `packages/sdk/src/utils.ts`, line 73: `const privateKey = hexToBytes(privateKeyHex);`
- `packages/sdk/src/account.ts`, line 229: `hexToBytes(opts.publicKey)`

### How It Could Be Exploited

1. **Corrupted key input:** A developer copies a private key from a config file but accidentally includes a trailing newline, space, or non-hex character: `"abcdef12\n"`.
2. **Silent corruption:** `hexToBytes` does not error. The last byte pair (containing `\n`) is parsed as `NaN` and stored as `0`.
3. **Wrong key used:** The SDK uses a corrupted private key that differs from the intended key. Signatures will fail at the server, producing confusing "invalid signature" errors instead of a clear "invalid hex input" error.
4. **Worse case -- partial corruption:** If only some bytes are corrupted (e.g., a single `g` in a 64-character hex string), the resulting key is subtly wrong. Debugging this is extremely difficult.
5. **Odd-length input:** `hexToBytes("abc")` produces a 1-byte array (from `"ab"`), silently dropping the last character `"c"`.

### Impact

- Silent key corruption leads to confusing authentication failures.
- In the worst case, a corrupted key that happens to match another valid key could cause cross-account issues (astronomically unlikely but theoretically possible).
- Poor developer experience when troubleshooting key-related errors.

### Why the Severity Rating Is Correct

LOW is correct because:
- The impact is primarily developer experience (confusing errors, not security bypass).
- A corrupted key will fail signature verification server-side, so no unauthorized access results.
- Confidence is 8/10 because the behavior is easily reproducible.

### Remediation

Add validation to `hexToBytes`:

```typescript
export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;

    // Validate hex characters
    if (!/^[0-9a-fA-F]*$/.test(clean)) {
        throw new Error("hexToBytes: input contains non-hex characters");
    }

    // Validate even length
    if (clean.length % 2 !== 0) {
        throw new Error("hexToBytes: input must have even length");
    }

    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
```

Optionally, add a variant that validates expected key length:

```typescript
export function hexToPrivateKey(hex: string): Uint8Array {
    const bytes = hexToBytes(hex);
    if (bytes.length !== 32) {
        throw new Error(`Expected 32-byte private key, got ${bytes.length} bytes`);
    }
    return bytes;
}
```

---

## Finding 5.3 -- LOW: `btoa` Spread May Blow Stack on Large Payloads

### What It Is

The `rememberManual` method converts encrypted bytes to base64 using `btoa(String.fromCharCode(...encrypted))`. The spread operator (`...`) expands the `Uint8Array` into individual arguments to `String.fromCharCode()`. JavaScript engines impose a maximum number of function arguments (typically 65,536 to ~500,000 depending on engine and available stack). For large encrypted payloads, this will throw a `RangeError: Maximum call stack size exceeded`.

### Where in the Code

**File:** `packages/sdk/src/manual.ts`, line 250:

```typescript
const encryptedBase64 = btoa(String.fromCharCode(...encrypted));
```

This is called after SEAL encryption, where `encrypted` is a `Uint8Array` containing the SEAL-encrypted ciphertext. SEAL ciphertext is typically larger than the plaintext (due to encryption overhead), so even moderately sized text inputs produce large `encrypted` arrays.

### How It Could Be Exploited

1. A user calls `rememberManual()` with a text payload of ~50KB or more.
2. After SEAL encryption, the ciphertext may be ~60-100KB.
3. `String.fromCharCode(...encrypted)` attempts to pass 60,000-100,000 arguments.
4. The JavaScript engine throws `RangeError: Maximum call stack size exceeded`.
5. The operation fails silently (the error is thrown but may not be caught cleanly if the Promise chain does not expect this error type).

This is a denial-of-service against the user's own operations -- they cannot store large memories.

### Impact

- Large payloads cause unrecoverable runtime errors.
- The error message (`Maximum call stack size exceeded`) is confusing and does not indicate the actual issue.
- Limits the practical size of memories that can be stored via `MemWalManual`.

### Why the Severity Rating Is Correct

LOW is correct because:
- This is a reliability/robustness issue, not a security vulnerability per se.
- An attacker cannot exploit this against other users; it only affects the caller's own operations.
- The fix is straightforward.
- Confidence is 6/10 because the exact threshold depends on the JS engine and available stack.

### Remediation

Use chunked base64 encoding:

```typescript
// Replace line 250 with:
function uint8ArrayToBase64(bytes: Uint8Array): string {
    const CHUNK_SIZE = 0x8000; // 32KB chunks
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + CHUNK_SIZE);
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

// Usage:
const encryptedBase64 = uint8ArrayToBase64(encrypted);
```

Or use the built-in `Buffer` in Node.js environments:

```typescript
const encryptedBase64 = typeof Buffer !== 'undefined'
    ? Buffer.from(encrypted).toString('base64')
    : uint8ArrayToBase64(encrypted);
```

---

## Finding 6.1 -- LOW: Server Error Messages Propagated to Caller

### What It Is

When the server returns an HTTP error, the SDK reads the full error response body and includes it verbatim in the thrown `Error` message. If the server returns detailed internal error messages (stack traces, database errors, configuration details), these are exposed to the SDK caller and potentially to end users.

### Where in the Code

**File:** `packages/sdk/src/memwal.ts`, lines 320-322:

```typescript
if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MemWal API error (${res.status}): ${errText}`);
}
```

**File:** `packages/sdk/src/manual.ts`, lines 558-560 (identical pattern):

```typescript
if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MemWal API error (${res.status}): ${errText}`);
}
```

### How It Could Be Exploited

1. An attacker triggers an error condition (e.g., malformed request, server misconfiguration).
2. The server responds with a detailed error message containing internal paths, database connection strings, or stack traces.
3. The SDK wraps this in an `Error` and throws it.
4. If the calling application displays error messages to end users (common in web apps), the internal details are exposed.
5. The attacker uses leaked information (server software versions, internal paths, database types) to plan further attacks.

### Impact

- Information disclosure: internal server details may be exposed to end users.
- Aids reconnaissance for further attacks against the server infrastructure.

### Why the Severity Rating Is Correct

LOW is correct because:
- The primary fix should be on the server side (do not return detailed errors).
- The SDK is a secondary defense; it is reasonable to pass through error messages for debugging.
- No direct security breach results from this alone.
- Confidence is 8/10.

### Remediation

Sanitize error messages at the SDK level:

```typescript
if (!res.ok) {
    const errText = await res.text();
    // Log full error for debugging but throw a sanitized version
    if (typeof console !== 'undefined') {
        console.debug(`MemWal API error (${res.status}):`, errText);
    }

    // Return generic error to caller
    const publicMessage = res.status === 401 ? "Authentication failed"
        : res.status === 403 ? "Access denied"
        : res.status === 404 ? "Resource not found"
        : res.status === 429 ? "Rate limit exceeded"
        : `Server error (${res.status})`;

    const err = new Error(`MemWal API error: ${publicMessage}`);
    (err as any).statusCode = res.status;
    (err as any).serverMessage = errText;  // available for debugging if needed
    throw err;
}
```

---

## Finding 6.2 -- LOW: `console.error` Leaks Blob IDs and Error Details

### What It Is

The `MemWalManual` class uses `console.error` to log blob IDs and full error objects when Walrus downloads or SEAL decryptions fail. In browser environments, this output is visible in DevTools. Blob IDs are identifiers for data stored on Walrus and could be used by an attacker to download (though not decrypt) the user's encrypted data.

### Where in the Code

**File:** `packages/sdk/src/manual.ts`, line 290-291:

```typescript
} catch (err) {
    console.error(`[MemWalManual] Walrus download failed for ${hit.blob_id}:`, err);
    return null;
}
```

**File:** `packages/sdk/src/manual.ts`, line 377:

```typescript
} catch (err) {
    console.error(`[MemWalManual] SEAL decrypt failed for ${blob.blob_id}:`, err);
}
```

Additional instances at lines 316 and 335:

```typescript
console.error('[MemWalManual] Failed to initialize SEAL/SUI clients:', err);
...
console.error('[MemWalManual] SessionKey.create failed:', err);
```

### How It Could Be Exploited

1. A user opens a MemWal-powered web application in their browser.
2. Some recall operations partially fail (e.g., a blob is temporarily unavailable on Walrus).
3. The blob IDs and error details are logged to the browser console.
4. A malicious browser extension, shoulder surfer, or shared screen captures the console output.
5. The attacker uses the blob IDs to download the encrypted data from Walrus (Walrus data is publicly accessible by blob ID).
6. While the data is SEAL-encrypted and cannot be decrypted without the key, the attacker now knows the blob IDs and can attempt to correlate them with other metadata.

### Impact

- Blob ID disclosure enables downloading encrypted data (which is still encrypted, so limited impact).
- Full error objects may contain stack traces, internal URLs, or session key details.
- In a shared environment (screen sharing, recorded demos), sensitive identifiers are visible.

### Why the Severity Rating Is Correct

LOW is correct because:
- Blob IDs alone do not grant decryption capability.
- The encrypted data on Walrus is useless without SEAL keys.
- The information leakage is to the local browser console, not to a remote attacker.
- Confidence is 7/10.

### Remediation

Use a configurable logger and redact sensitive identifiers:

```typescript
// Add a logger option to MemWalManualConfig
/** Custom logger (default: console). Set to null to disable logging. */
logger?: Pick<Console, 'error' | 'warn' | 'debug'> | null;

// In the class:
private log(level: 'error' | 'warn' | 'debug', message: string, ...args: any[]) {
    const logger = this.config.logger;
    if (logger === null) return;
    (logger ?? console)[level](`[MemWalManual] ${message}`, ...args);
}

// Replace console.error calls:
// BEFORE:
console.error(`[MemWalManual] Walrus download failed for ${hit.blob_id}:`, err);

// AFTER (redacted blob ID):
this.log('error', `Walrus download failed for blob ${hit.blob_id.slice(0, 8)}...:`, 
    err instanceof Error ? err.message : 'unknown error');
```

---

## Finding 7.1 -- MEDIUM: Default Server URL Is Plaintext HTTP

### What It Is

Both `MemWal` and `MemWalManual` default to `http://localhost:8000` as the server URL. While `localhost` is safe for local development, there is no warning or enforcement when a non-localhost URL is configured without HTTPS. This means a production deployment could easily use plaintext HTTP, transmitting all data (including the private key per Finding 1.1, signatures, and memory content) in cleartext.

### Where in the Code

**File:** `packages/sdk/src/memwal.ts`, line 72:

```typescript
this.serverUrl = (config.serverUrl ?? "http://localhost:8000").replace(/\/$/, "");
```

**File:** `packages/sdk/src/manual.ts`, line 82:

```typescript
this.serverUrl = (config.serverUrl ?? "http://localhost:8000").replace(/\/$/, "");
```

No validation is performed on the resulting URL. All of these are accepted silently:
- `http://memwal.example.com` (plaintext to remote server)
- `http://10.0.0.5:8000` (plaintext to internal network)
- `ftp://example.com` (wrong protocol entirely)

### How It Could Be Exploited

1. A developer deploys to production and sets `serverUrl: "http://api.memwal.example.com"` (forgetting the `s` in `https`).
2. All API traffic, including signed requests and (in `MemWal` class) the raw private key in `x-delegate-key`, travels in plaintext.
3. Any network observer (ISP, cloud provider, compromised router) can read all memory content and steal credentials.
4. Combined with Finding 1.1 (private key in headers) and Finding 2.3 (replay window), this creates a complete compromise chain.

### Impact

- All data in transit is exposed: memory content, private keys, signatures, account IDs.
- Enables all other network-dependent attacks (replay, MitM, credential theft).

### Why the Severity Rating Is Correct

MEDIUM is correct because:
- The default (`localhost`) is safe for development.
- The vulnerability requires a misconfiguration (using HTTP for a remote server).
- However, the SDK provides no guardrails against this common misconfiguration.
- Combined with Finding 1.1, the impact of this misconfiguration is catastrophic.
- Confidence is 9/10.

### Remediation

Add URL validation in both constructors:

```typescript
private constructor(config: MemWalConfig) {
    this.privateKey = hexToBytes(config.key);
    this.accountId = config.accountId;

    const serverUrl = (config.serverUrl ?? "http://localhost:8000").replace(/\/$/, "");

    // Warn or throw for non-HTTPS on non-localhost
    const parsed = new URL(serverUrl);
    const isLocalhost = parsed.hostname === "localhost"
        || parsed.hostname === "127.0.0.1"
        || parsed.hostname === "::1";

    if (parsed.protocol !== "https:" && !isLocalhost) {
        throw new Error(
            `MemWal: serverUrl "${serverUrl}" uses plaintext HTTP for a non-localhost address. ` +
            "Use HTTPS to protect data in transit. " +
            "If you intentionally want HTTP (NOT recommended), use config.allowInsecureHttp = true."
        );
    }

    this.serverUrl = serverUrl;
    this.namespace = config.namespace ?? "default";
}
```

---

## Finding 7.2 -- LOW: Health Check Is Unsigned

### What It Is

The `health()` method makes a plain, unsigned HTTP GET request to the `/health` endpoint. Unlike all other API calls, it does not include any authentication headers or signature. A man-in-the-middle could return a fake "healthy" response even when the server is down or compromised.

### Where in the Code

**File:** `packages/sdk/src/memwal.ts`, lines 249-255:

```typescript
async health(): Promise<HealthResult> {
    const res = await fetch(`${this.serverUrl}/health`);
    if (!res.ok) {
        throw new Error(`Health check failed: ${res.status}`);
    }
    return res.json();
}
```

No `x-public-key`, `x-signature`, or `x-timestamp` headers are included. The response type (`HealthResult` from `types.ts`, lines 68-71) is:

```typescript
export interface HealthResult {
    status: string;
    version: string;
}
```

### How It Could Be Exploited

1. An application uses `health()` to verify the server is operational before performing sensitive operations.
2. A MitM attacker intercepts the health check and returns `{ "status": "ok", "version": "1.0.0" }`.
3. The application proceeds to make authenticated requests, believing the server is healthy.
4. The attacker intercepts these subsequent requests and captures credentials (especially combined with Finding 1.1).

Alternatively:
1. The server is compromised or replaced with a malicious version.
2. The health check returns a "healthy" status from the malicious server.
3. The application trusts the health check and sends sensitive data to the compromised server.

### Impact

- A false-positive health check could lead to data being sent to a compromised or impersonated server.
- The health check provides no cryptographic assurance that the responding server is the legitimate MemWal server.

### Why the Severity Rating Is Correct

LOW is correct because:
- Health checks are typically informational and unauthenticated by convention.
- Signing the health check would only prove that the server has a valid signing key, not that it is trustworthy.
- The real defense against server impersonation is TLS certificate validation (HTTPS).
- If HTTPS is used (per Finding 7.1's remediation), this finding becomes largely moot.
- Confidence is 9/10 because the unsigned nature is clear from the code.

### Remediation

If health check integrity is important, add a lightweight signature verification:

```typescript
async health(): Promise<HealthResult> {
    const res = await fetch(`${this.serverUrl}/health`);
    if (!res.ok) {
        throw new Error(`Health check failed: ${res.status}`);
    }
    const result = await res.json() as HealthResult;

    // Optional: verify the server's response includes a known field
    if (!result.status || !result.version) {
        throw new Error("Health check returned unexpected response format");
    }

    return result;
}
```

Alternatively, document that the health check is unsigned and should not be used as a security gate. The primary mitigation is ensuring HTTPS is used for all connections (Finding 7.1).
