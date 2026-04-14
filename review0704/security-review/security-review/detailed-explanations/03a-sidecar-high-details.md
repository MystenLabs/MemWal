# Sidecar Server: HIGH-Severity Findings - Detailed Explanations

This document provides detailed analysis of each HIGH-severity finding in the MemWal
SEAL + Walrus HTTP sidecar server (`services/server/scripts/sidecar-server.ts`) and
related files.

---

## S1: Zero Authentication on All Sidecar Endpoints (HIGH)

### What it is

The Express sidecar server has no authentication middleware whatsoever. Every endpoint
-- `/seal/encrypt`, `/seal/decrypt`, `/seal/decrypt-batch`, `/walrus/upload`,
`/walrus/query-blobs`, `/sponsor`, `/sponsor/execute`, and `/health` -- is accessible
to any client that can reach the server. There are no API keys, bearer tokens, mTLS,
or any other credential check. In addition, CORS is configured to allow all origins
with a wildcard.

### Where in the code

**File:** `services/server/scripts/sidecar-server.ts`, lines 273-285

```typescript
const app = express();
app.use(express.json({ limit: "50mb" }));

// CORS -- allow frontend (any origin) to call sponsor endpoints
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

No route in the file (lines 288-817) adds any form of authentication or authorization
check before processing the request body and executing cryptographic operations.

### How it could be exploited

1. An attacker discovers the sidecar port (default 9000) through port scanning, SSRF
   from another co-hosted service, or network reconnaissance.
2. The attacker sends a POST request to `/seal/encrypt` with arbitrary `data`, `owner`,
   and `packageId` to encrypt data under any user's SEAL identity.
3. The attacker sends requests to `/walrus/query-blobs` with any `owner` address to
   enumerate all blobs belonging to any user.
4. The attacker sends requests to `/sponsor` to get arbitrary Sui transactions
   gas-sponsored for free using the project's Enoki API key.
5. Because CORS allows `*`, any malicious webpage can issue cross-origin requests
   to the sidecar from a user's browser if the server is reachable.

### Impact

- **Full unauthorized access** to all sidecar functionality: encryption, decryption
  (if attacker has a private key), Walrus uploads (consuming server wallet funds),
  blob enumeration, and transaction sponsorship.
- **Financial drain**: The `/walrus/upload` and `/sponsor` endpoints spend real SUI
  tokens from the server wallet or Enoki budget. An attacker can exhaust these.
- **Data exfiltration**: `/walrus/query-blobs` reveals which blobs belong to which
  user addresses, leaking metadata.

### Why the severity rating is correct

This is rated HIGH because the sidecar is designed to be an internal-only service
consumed by the Rust backend. However, the lack of any authentication means that if
the sidecar is reachable from any untrusted network (which S19 makes likely), all
endpoints are wide open. The CORS wildcard further widens the attack surface to
browser-based attacks. The combination with S19 (binding to 0.0.0.0) elevates this
from a defense-in-depth concern to an actively exploitable issue.

### Remediation

Add a shared-secret authentication middleware. The Rust server and sidecar should
share a secret (e.g., via an environment variable), and the sidecar should reject
all requests that do not present it.

```typescript
// At the top, after app creation:
const SIDECAR_AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN;
if (!SIDECAR_AUTH_TOKEN) {
    console.error("[sidecar] FATAL: SIDECAR_AUTH_TOKEN not set. Refusing to start without auth.");
    process.exit(1);
}

app.use((req, res, next) => {
    // Allow health checks without auth
    if (req.path === "/health") return next();

    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || token !== SIDECAR_AUTH_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
});
```

Also restrict CORS to known origins:

```typescript
app.use((_req, res, next) => {
    // Only allow the Rust backend origin, not wildcard
    res.header("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "");
    // ...
});
```

---

## S3: verifyKeyServers: false in All SEAL Clients (HIGH)

### What it is

Every SEAL client instantiation across all three TypeScript files disables key server
certificate/identity verification by setting `verifyKeyServers: false`. This means
the client will accept decryption key shares from any server that responds, without
verifying that the server is a legitimate, trusted SEAL key server. This defeats the
core trust assumption of SEAL's threshold encryption scheme.

### Where in the code

**File:** `services/server/scripts/sidecar-server.ts`, line 67

```typescript
const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_KEY_SERVERS.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});
```

**File:** `services/server/scripts/seal-encrypt.ts`, line 96

```typescript
const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_KEY_SERVERS.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});
```

**File:** `services/server/scripts/seal-decrypt.ts`, line 117

```typescript
const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_KEY_SERVERS.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});
```

### How it could be exploited

1. An attacker positions themselves on the network path between the sidecar and the
   SEAL key servers (e.g., via DNS hijacking, ARP spoofing on the local network, or
   a compromised router).
2. When the sidecar calls `sealClient.fetchKeys()` (e.g., line 371 in
   `sidecar-server.ts`), the attacker intercepts the request and responds with a
   malicious key share.
3. Because `verifyKeyServers: false` is set, the client does not verify the
   responding server's on-chain attestation or TLS certificate against the expected
   SEAL key server identity.
4. The attacker provides a key share that they control, enabling them to decrypt the
   data (if they provide a valid-looking but attacker-controlled share) or cause a
   denial-of-service (if the share is invalid and decryption fails).
5. For encryption, a man-in-the-middle could manipulate the encryption parameters so
   that ciphertext is bound to attacker-controlled keys rather than the legitimate
   SEAL key servers.

### Impact

- **Broken encryption trust model**: The entire purpose of SEAL's threshold encryption
  is that multiple independent, verified key servers must cooperate. Disabling
  verification means a single compromised network hop can undermine the scheme.
- **Silent data compromise**: The attacker can potentially decrypt all user data
  without any indication of compromise.
- **Supply-chain risk**: If any DNS or network infrastructure is compromised (common
  in cloud environments with shared networking), the encryption offers no protection.

### Why the severity rating is correct

This is HIGH because it undermines the fundamental cryptographic guarantees of the
SEAL encryption system. SEAL's security model requires that clients verify they are
communicating with legitimate key servers whose identities are attested on-chain.
Disabling this verification converts a threshold trust system into one where any
network-level attacker can impersonate a key server. While exploitation requires a
network-level position, this is a realistic threat in cloud and shared hosting
environments.

### Remediation

Enable key server verification in all SEAL client instantiations:

```typescript
const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_KEY_SERVERS.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: true,  // MUST be true in production
});
```

If `verifyKeyServers: true` was disabled due to development/testing issues, address
the root cause (e.g., ensure SEAL key server object IDs in `SEAL_KEY_SERVERS` env var
are correct for the target network and that the on-chain key server objects have valid
attestation data). Never ship `verifyKeyServers: false` to production.

---

## S5: Private Keys Received in HTTP Request Bodies for Decrypt (HIGH)

### What it is

The `/seal/decrypt`, `/seal/decrypt-batch`, and `/walrus/upload` endpoints all
accept raw private keys (`privateKey`) as a field in the JSON request body. These
private keys are Ed25519 signing keys (in bech32 `suiprivkey1...` or raw hex format)
that control Sui wallets and are used to sign blockchain transactions. Transmitting
private keys over HTTP -- even between internal services -- means the keys traverse
the network in plaintext within the request body.

### Where in the code

**File:** `services/server/scripts/sidecar-server.ts`

**Line 323-336** (`/seal/decrypt`):
```typescript
const { data, privateKey, packageId, accountId } = req.body;
if (!data || !privateKey || !packageId || !accountId) {
    return res.status(400).json({ error: "Missing required fields: data, privateKey, packageId, accountId" });
}

// Decode delegate keypair -- supports both bech32 (suiprivkey1...) and raw hex
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

**Line 400-416** (`/seal/decrypt-batch`):
```typescript
const { items, privateKey, packageId, accountId } = req.body;
// ...
if (!privateKey || !packageId || !accountId) {
    return res.status(400).json({ error: "Missing required fields: privateKey, packageId, accountId" });
}

// Decode delegate keypair
let keypair: Ed25519Keypair;
if (privateKey.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    keypair = Ed25519Keypair.fromSecretKey(secretKey);
} else {
    const keyBytes = Uint8Array.from(privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
    keypair = Ed25519Keypair.fromSecretKey(keyBytes);
}
```

**Line 506-518** (`/walrus/upload`):
```typescript
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

// Decode signer
const { secretKey } = decodeSuiPrivateKey(privateKey);
const signer = Ed25519Keypair.fromSecretKey(secretKey);
```

### How it could be exploited

1. An attacker gains the ability to observe network traffic between the Rust backend
   and the sidecar -- for example, through a compromised container, a network tap, or
   log aggregation that inadvertently captures HTTP request bodies.
2. The attacker reads the `privateKey` field from intercepted `/seal/decrypt` or
   `/walrus/upload` requests.
3. With the private key, the attacker can:
   - Sign any Sui transaction as the key owner (transfer funds, call smart contracts).
   - Decrypt all SEAL-encrypted data belonging to that key's account.
   - Upload arbitrary data to Walrus under the victim's identity.
4. If the Rust server logs request bodies at any log level (common for debugging),
   private keys end up in log files, monitoring systems, and log aggregation services
   (e.g., CloudWatch, Datadog).

### Impact

- **Complete key compromise**: Anyone who intercepts a single request obtains
  permanent control over the associated Sui wallet and all SEAL-encrypted data.
- **Lateral movement**: The server wallet key (see S8) flows through this same
  mechanism, so compromising the sidecar's inbound traffic compromises the server's
  operational wallet.
- **Logging exposure**: Standard request logging, error reporting, and APM tools
  will capture private keys in plaintext.

### Why the severity rating is correct

This is HIGH because private keys are the root of trust for the entire system.
Transmitting them in HTTP request bodies creates multiple exposure vectors (network
interception, logging, error reporting). While the Rust-to-sidecar communication is
intended to be localhost-only, the combination with S19 (0.0.0.0 binding) and S1
(no auth) means the keys may traverse real networks. Even on localhost, any process
on the machine can observe loopback traffic.

### Remediation

**Option A (preferred): Eliminate key transmission entirely.** The sidecar should
load private keys from environment variables or a secrets manager at startup, not
receive them per-request.

```typescript
// At startup, load the delegate/server key once:
const SERVER_PRIVATE_KEY = process.env.SERVER_SUI_PRIVATE_KEY;
if (!SERVER_PRIVATE_KEY) {
    console.error("[sidecar] FATAL: SERVER_SUI_PRIVATE_KEY not set");
    process.exit(1);
}
const { secretKey } = decodeSuiPrivateKey(SERVER_PRIVATE_KEY);
const serverKeypair = Ed25519Keypair.fromSecretKey(secretKey);

// In route handlers, use the pre-loaded keypair:
app.post("/seal/decrypt", async (req, res) => {
    const { data, packageId, accountId } = req.body;
    // Use serverKeypair instead of req.body.privateKey
    // ...
});
```

**Option B (if per-user delegate keys are needed):** Use a key reference/ID system.
The Rust server stores delegate keys in an encrypted vault (e.g., HashiCorp Vault,
AWS KMS) and sends only a key reference ID to the sidecar. The sidecar retrieves the
actual key from the vault.

At minimum, ensure the sidecar only listens on `127.0.0.1` (see S19) and add
authentication (see S1) to reduce the window of exposure.

---

## S8: Server Wallet Private Key Sent Per-Request to Sidecar (HIGH)

### What it is

The Rust backend sends the server's operational Sui wallet private key
(`SERVER_SUI_PRIVATE_KEY` / keys from `SERVER_SUI_PRIVATE_KEYS` pool) in every
`/walrus/upload` HTTP request to the sidecar. This key controls the wallet that pays
for Walrus storage, gas fees, and blob transfers. It is extracted from the key pool
on the Rust side and embedded directly in the JSON request body sent over HTTP.

### Where in the code

**Rust side - sending the key:**

**File:** `services/server/src/walrus.rs`, lines 76-86

```rust
let resp = client
    .post(&url)
    .json(&WalrusUploadRequest {
        data: data_b64,
        private_key: sui_private_key.to_string(),  // <-- server wallet key in request body
        owner: owner_address.to_string(),
        namespace: namespace.to_string(),
        package_id: package_id.to_string(),
        epochs,
    })
    .send()
    .await
```

The `WalrusUploadRequest` struct (lines 38-47) explicitly includes `private_key`:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WalrusUploadRequest {
    data: String,
    private_key: String,
    // ...
}
```

**Rust side - sourcing the key from the pool:**

**File:** `services/server/src/routes.rs`, lines 153-158 (memorize route), 317-320
(upload route), 429-431 (batch route):

```rust
let sui_key = state.key_pool.next()
    .map(|s| s.to_string())
    .ok_or_else(|| AppError::Internal("No Sui keys configured...".into()))?;
let upload_result = walrus::upload_blob(
    &state.http_client, &state.config.sidecar_url,
    &encrypted, 50, owner, &sui_key, namespace, &state.config.package_id,
).await?;
```

**Sidecar side - receiving and using the key:**

**File:** `services/server/scripts/sidecar-server.ts`, lines 513-519

```typescript
const {
    data,
    privateKey,       // <-- server wallet private key
    owner,
    // ...
} = req.body;
// ...
const { secretKey } = decodeSuiPrivateKey(privateKey);
const signer = Ed25519Keypair.fromSecretKey(secretKey);
```

### How it could be exploited

1. An attacker intercepts traffic between the Rust server and the sidecar (the
   sidecar binds to 0.0.0.0 per S19, and has no auth per S1).
2. The attacker extracts the `privateKey` field from any `/walrus/upload` request.
3. This key is the **server's operational wallet** -- it holds SUI tokens used to pay
   for storage and gas across all users.
4. With the server wallet key, the attacker can:
   - Drain all SUI tokens from the server wallet.
   - Sign transactions as the server, potentially manipulating on-chain state.
   - Upload/modify blobs under the server's authority.
   - Impersonate the server in Enoki-sponsored transactions.
5. Since the key pool may contain multiple keys (`SERVER_SUI_PRIVATE_KEYS`), repeated
   interception reveals all operational wallet keys.

### Impact

- **Complete server wallet compromise**: The attacker gains control of the wallet(s)
  that fund all Walrus operations for the entire platform.
- **Financial loss**: All SUI tokens in the server wallet(s) can be drained.
- **Service disruption**: Without funds, the server cannot upload blobs or sponsor
  transactions, breaking the service for all users.
- **Trust violation**: The server wallet is also used for blob transfers to users
  (line 617 in sidecar-server.ts), so the attacker could redirect blob ownership.

### Why the severity rating is correct

This is HIGH because the server wallet is the most sensitive credential in the system
after the SEAL key servers. It controls real financial assets (SUI tokens) and
operational capabilities (blob uploads, sponsorship). Sending it in every HTTP request
creates a large number of interception opportunities. Combined with S1 (no auth) and
S19 (network-exposed), this key is at significant risk.

### Remediation

The sidecar should load the server wallet key(s) directly from environment variables
at startup, not receive them per-request.

```typescript
// At startup:
const SERVER_SUI_PRIVATE_KEYS = (process.env.SERVER_SUI_PRIVATE_KEYS || process.env.SERVER_SUI_PRIVATE_KEY || "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);

if (SERVER_SUI_PRIVATE_KEYS.length === 0) {
    console.error("[sidecar] FATAL: No server wallet keys configured");
    process.exit(1);
}

// Build keypairs once
const serverKeypairs = SERVER_SUI_PRIVATE_KEYS.map(key => {
    const { secretKey } = decodeSuiPrivateKey(key);
    return Ed25519Keypair.fromSecretKey(secretKey);
});

let keyIndex = 0;
function nextServerKeypair(): Ed25519Keypair {
    const kp = serverKeypairs[keyIndex % serverKeypairs.length];
    keyIndex++;
    return kp;
}

// In /walrus/upload handler -- no privateKey in request body:
app.post("/walrus/upload", async (req, res) => {
    const { data, owner, namespace, packageId, epochs } = req.body;
    const signer = nextServerKeypair();
    // ...
});
```

On the Rust side, remove `private_key` from `WalrusUploadRequest` and the
`upload_blob` function signature.

---

## S11: Unauthenticated Sponsor Endpoints (HIGH)

### What it is

The `/sponsor` and `/sponsor/execute` endpoints allow any caller to request
gas-sponsored Sui transactions using the project's Enoki API key. There is no
authentication, rate limiting, or authorization check. Any caller can submit
arbitrary transaction bytes and have them sponsored (gas paid) by MemWal's Enoki
account.

### Where in the code

**File:** `services/server/scripts/sidecar-server.ts`

**Lines 753-776** (`/sponsor`):
```typescript
app.post("/sponsor", async (req, res) => {
    try {
        const { transactionBlockKindBytes, sender } = req.body;
        if (!transactionBlockKindBytes || !sender) {
            return res.status(400).json({ error: "Missing required fields: transactionBlockKindBytes, sender" });
        }
        if (!enokiApiKey) {
            return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
        }

        console.log(`[sponsor] creating sponsored tx for sender=${sender}`);
        const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
            network: enokiNetwork,
            transactionBlockKindBytes,
            sender,
        });

        console.log(`[sponsor] sponsored tx created, digest=${sponsored.digest}`);
        res.json(sponsored); // { bytes, digest }
    } catch (err: any) {
        console.error(`[sponsor] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});
```

**Lines 782-804** (`/sponsor/execute`):
```typescript
app.post("/sponsor/execute", async (req, res) => {
    try {
        const { digest, signature } = req.body;
        if (!digest || !signature) {
            return res.status(400).json({ error: "Missing required fields: digest, signature" });
        }
        if (!enokiApiKey) {
            return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
        }

        console.log(`[sponsor/execute] executing sponsored tx digest=${digest}`);
        const executed = await callEnoki<EnokiExecuteResponse>(
            `/transaction-blocks/sponsor/${digest}`,
            { digest, signature }
        );

        console.log(`[sponsor/execute] tx executed, final digest=${executed.digest}`);
        res.json(executed); // { digest }
    } catch (err: any) {
        console.error(`[sponsor/execute] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});
```

Note the comment on line 276: `// CORS -- allow frontend (any origin) to call sponsor
endpoints` -- the developers intentionally opened CORS for these endpoints, confirming
they are designed to be called directly from browsers.

### How it could be exploited

1. An attacker discovers the sidecar URL (or the sponsor endpoints are intentionally
   public as the CORS comment suggests).
2. The attacker crafts a Sui `TransactionKind` that performs any operation they want
   -- e.g., transferring NFTs, calling arbitrary Move functions, or minting tokens.
3. The attacker sends `{ transactionBlockKindBytes: "<malicious tx>", sender: "<attacker address>" }`
   to `POST /sponsor`.
4. The sidecar forwards this directly to Enoki's sponsorship API using MemWal's API
   key, and Enoki pays the gas for the transaction.
5. The attacker signs the sponsored transaction with their own wallet and calls
   `POST /sponsor/execute` to execute it on-chain.
6. The attacker can repeat this indefinitely, draining the Enoki sponsorship budget.
7. There is no validation that the transaction is MemWal-related -- any arbitrary Sui
   transaction can be sponsored.

### Impact

- **Financial drain**: The Enoki sponsorship budget (real money) is consumed by
  attacker transactions that have nothing to do with MemWal.
- **Abuse of trust**: The attacker uses MemWal's Enoki API key to sponsor arbitrary
  blockchain operations, potentially associating MemWal with malicious on-chain
  activity.
- **Denial of service**: Once the sponsorship budget is exhausted, legitimate MemWal
  users can no longer use sponsored transactions, breaking core functionality
  (Walrus uploads fall back to direct signing with server keys, or fail entirely).

### Why the severity rating is correct

This is HIGH because it provides a direct mechanism for financial loss. The Enoki
sponsorship budget represents real funds, and the endpoints accept completely
arbitrary transaction bytes with no validation or rate limiting. The comment in the
source code confirms the developers intended these to be browser-accessible,
further increasing the attack surface. The lack of transaction content validation
means any Sui transaction -- not just MemWal operations -- can be sponsored.

### Remediation

1. **Add authentication**: Require a valid user session or API token.
2. **Validate transaction content**: Parse the `transactionBlockKindBytes` and verify
   it only contains MemWal-related Move calls (specific package IDs and function
   targets).
3. **Rate limit per sender**: Cap the number of sponsored transactions per address.
4. **Set Enoki allowedAddresses**: Always include `allowedAddresses` to constrain
   which addresses the sponsored transaction can interact with.

```typescript
app.post("/sponsor", async (req, res) => {
    // 1. Authenticate the request
    const authToken = req.headers.authorization?.replace("Bearer ", "");
    if (!authToken || !isValidUserToken(authToken)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    // 2. Rate limit per sender
    const { transactionBlockKindBytes, sender } = req.body;
    if (await isSponsorRateLimited(sender)) {
        return res.status(429).json({ error: "Sponsor rate limit exceeded" });
    }

    // 3. Validate transaction content (only allow MemWal package calls)
    const ALLOWED_PACKAGES = [process.env.MEMWAL_PACKAGE_ID, WALRUS_PACKAGE_ID];
    if (!validateTransactionTargets(transactionBlockKindBytes, ALLOWED_PACKAGES)) {
        return res.status(403).json({ error: "Transaction contains disallowed operations" });
    }

    // 4. Include allowedAddresses constraint
    const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
        network: enokiNetwork,
        transactionBlockKindBytes,
        sender,
        allowedAddresses: [sender, WALRUS_PACKAGE_ID],
    });
    // ...
});
```

---

## S19: Express Server Binds to 0.0.0.0 (HIGH)

### What it is

The Express sidecar server listens on all network interfaces (0.0.0.0) by default.
The `app.listen(PORT)` call in Express, when called with only a port number, binds
to `0.0.0.0` (INADDR_ANY). This means the sidecar is accessible from any machine
that can route to the host -- not just localhost.

### Where in the code

**File:** `services/server/scripts/sidecar-server.ts`, line 811

```typescript
const PORT = parseInt(process.env.SIDECAR_PORT || "9000", 10);
app.listen(PORT, () => {
    console.log(JSON.stringify({
        event: "sidecar_ready",
        port: PORT,
        pid: process.pid,
    }));
});
```

The `app.listen(PORT, callback)` signature does not specify a host/address parameter.
In Node.js/Express, this defaults to binding on `::` (IPv6 all interfaces) or
`0.0.0.0` (IPv4 all interfaces), depending on the OS. Either way, the server accepts
connections from any network interface.

### How it could be exploited

1. The sidecar is deployed in a cloud environment (e.g., a VM, a Kubernetes pod, an
   ECS container) where it shares a network with other services or is exposed via a
   load balancer.
2. An attacker on the same network (or who has compromised an adjacent service) scans
   for open ports and discovers port 9000.
3. Because the sidecar has no authentication (S1) and binds to all interfaces, the
   attacker now has unrestricted access to all sidecar endpoints.
4. In cloud environments, this is especially dangerous because:
   - Container orchestrators (Kubernetes, ECS) typically have flat pod networking
     where any pod can reach any other pod's ports.
   - VPC security groups may focus on public-facing ports and overlook internal
     service ports.
   - Metadata services and sidecars on the same host can also reach the port.
5. Combined with S5 and S8, the attacker can intercept private keys passing through
   these endpoints.

### Impact

- **Network-level exposure**: The sidecar, intended as an internal-only service,
  becomes reachable from the entire network segment.
- **Amplifies all other findings**: S1 (no auth), S5 (private keys in bodies), S8
  (server wallet key), and S11 (open sponsor) are all far more dangerous when the
  sidecar is network-accessible rather than localhost-only.
- **Lateral movement vector**: A compromised adjacent service can use the sidecar
  to access SEAL encryption/decryption, drain the server wallet, or abuse sponsorship.

### Why the severity rating is correct

This is HIGH because it is the enabler that turns internal-only vulnerabilities into
network-exploitable ones. On its own, binding to 0.0.0.0 is a medium-severity
misconfiguration. But in combination with the complete lack of authentication (S1) and
the transmission of private keys in request bodies (S5, S8), it creates a realistic
attack path for any adversary with network access. In modern cloud deployments, the
assumption that "only localhost can reach this port" is frequently violated.

### Remediation

Bind the server explicitly to the loopback interface:

```typescript
const PORT = parseInt(process.env.SIDECAR_PORT || "9000", 10);
const HOST = process.env.SIDECAR_HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
    console.log(JSON.stringify({
        event: "sidecar_ready",
        host: HOST,
        port: PORT,
        pid: process.pid,
    }));
});
```

This ensures the sidecar only accepts connections from the same machine. If the Rust
server and sidecar run in separate containers (e.g., in Kubernetes), use a Unix
domain socket instead of TCP, or implement proper authentication (S1) and restrict
network access via network policies.

For Kubernetes deployments where the sidecar must be in a separate pod:

```yaml
# NetworkPolicy: only allow traffic from the Rust server pod
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sidecar-restrict
spec:
  podSelector:
    matchLabels:
      app: memwal-sidecar
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: memwal-server
      ports:
        - port: 9000
```

---

## Summary of Compound Risk

These six findings are not independent -- they form an attack chain. S19 (0.0.0.0
binding) makes the sidecar network-reachable. S1 (no auth) means any caller is
accepted. S5 and S8 (private keys in request bodies) mean intercepting a single
request compromises wallet keys. S3 (no key server verification) undermines the
cryptographic trust model. S11 (open sponsor endpoints) enables direct financial
drain.

An attacker who gains any network access to the sidecar's port can: (1) drain the
Enoki sponsorship budget via S11, (2) enumerate user data via unauthenticated blob
queries, (3) intercept server wallet keys via S8, and (4) compromise SEAL encryption
integrity via S3. Addressing any one finding in isolation still leaves significant
residual risk.

**Priority order for remediation:**

1. **S19** -- Bind to 127.0.0.1 (immediate, one-line fix, eliminates network exposure)
2. **S1** -- Add shared-secret auth (eliminates unauthorized access even if binding changes)
3. **S8 + S5** -- Load keys at startup, not per-request (eliminates key transmission)
4. **S3** -- Set `verifyKeyServers: true` (restores SEAL trust model)
5. **S11** -- Add auth + rate limiting + tx validation to sponsor endpoints
