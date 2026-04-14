# MEM-1 — Security Remediation Plan (Phase 2–5)

> **Scope**: MEM-16 → MEM-23 — Medium, Low & Informational findings  
> **Assignee**: Henry Nguyen (henry.nguyen)  
> **Branch pattern**: `feature/mem-{N}-...`  
> **Code inspected**: `dev` branch, post-PR-#84-revert (code sạch, chưa có fix nào)

---

## Các quyết định đã xác nhận (trước khi bắt đầu)

| # | Câu hỏi | Quyết định |
|---|---------|------------|
| SEAL threshold | `SEAL_KEY_SERVERS` có **2 servers** trên Railway | Giữ **threshold = 1** — nếu tăng lên 2/2 thì 1 server down là toàn bộ decrypt fail. Chỉ nâng khi có ≥3 servers |
| Contract upgrade | `Published.toml` có `upgrade-capability` cho cả testnet & mainnet | Dùng `sui client upgrade` — Package ID **giữ nguyên**, không cần migrate data hay re-encrypt |
| Redis Lua | Railway built-in Redis (hỗ trợ Lua ≥ 2.6) | Có thể dùng Lua script atomic, hoặc `pipe().atomic()` đều được |
| Redis cho auth.rs | `AppState.redis` đã có sẵn, middleware nhận `State<Arc<AppState>>` | Dùng trực tiếp, không cần refactor |
| Cookie Secure flag | Dev chạy HTTP localhost | Chỉ set `Secure` khi `NODE_ENV === 'production'` |

---

## Trạng thái Code Hiện Tại (sau khi pull về)

Dựa trên code đã đọc, dưới đây là trạng thái thực tế của từng vấn đề:

### Rate Limiter (`rate_limit.rs`) — ❌ Vẫn còn lỗi
- **Line 241**: `tracing::error!(..., "allowing")` → vẫn **fail-open** (HIGH-2 chưa được fix)
- **Line 260**: Same issue cho burst window
- **Line 279**: Same issue cho sustained window
- **Line 150**: `pipe` không có `.atomic()` trong `record_in_window`
- Path matching: không normalize trailing slash (MED-20)

### Auth (`auth.rs`) — ❌ Còn nhiều vấn đề
- **Line 61–64**: Vẫn đọc `x-delegate-key` header (CRIT-1 chưa fix)
- **Line 130**: Vẫn store `delegate_key: delegate_key_hex` trong AuthInfo
- **Không có nonce**: Không có replay protection (MED-1)
- **Timestamp window 300s = 5 phút**: OK nhưng không có nonce tracking → replay attacks vẫn có thể xảy ra

### Sui (`sui.rs`) — ❌ Thiếu account.active check
- `verify_delegate_key_onchain` không đọc field `active` (MED-2)
- Không có `AccountDeactivated` error variant

### Routes (`routes.rs`) — ❌ Nhiều vấn đề
- **Line 213**: `body.limit` không có upper cap → MED-3 chưa fix
- **Line 405**: `extract_facts_llm` trả về unlimited facts → không có `facts.truncate(20)` → MED-4/MED-5 chưa fix
- **Line 464**: `join_all(tasks)` unbounded trong `analyze` → MED-5/13 chưa fix
- **Line 888**: `join_all(download_tasks)` unbounded trong `restore` → MED-6 chưa fix

---

## Execution Plan

### MEM-16 — Add Replay Protection & Block Deactivated Accounts
**Branch**: `feature/mem-16-sec-add-replay-protection-block-deactivated-accounts`
**Findings**: MED-1 (Replay Protection), MED-2 (Block Deactivated Accounts)

#### Task A: Block Deactivated Accounts (MED-2) — `services/server/src/sui.rs`

**Vấn đề**: `verify_delegate_key_onchain` chỉ check xem public key có trong `delegate_keys` không, nhưng không kiểm tra `account.active == true`.

**Fix**:

```rust
// Sau khi extract owner (dòng ~64), thêm:
let active = fields
    .get("active")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

if !active {
    return Err(OnchainVerifyError::AccountDeactivated(format!(
        "Account {} is deactivated", account_object_id
    )));
}
```

Thêm variant mới vào enum `OnchainVerifyError`:
```rust
pub enum OnchainVerifyError {
    RpcError(String),
    KeyNotFound(String),
    AccountDeactivated(String),  // NEW
}
```

**Files**: `services/server/src/sui.rs`

---

#### Task B: Add Replay Protection (MED-1) — `auth.rs` + `memwal.ts`

**Vấn đề**: Signed message payload `{timestamp}.{method}.{path}.{body_sha256}` không có nonce. Kẻ tấn công có thể reuse một request hợp lệ trong window 5 phút.

**Fix — Server** (`services/server/src/auth.rs`):

1. Extract `x-nonce` header (required, UUID v4)
2. Check nonce chưa tồn tại trong Redis với key `nonce:{nonce_value}`, TTL = 600s (10 phút, > timestamp window 5 phút)
3. Include nonce trong signed message: `{timestamp}.{method}.{path}.{body_sha256}.{nonce}`
4. Store nonce vào Redis sau khi verify thành công

```rust
// Extract nonce header (required)
let nonce = headers
    .get("x-nonce")
    .and_then(|v| v.to_str().ok())
    .map(String::from)
    .ok_or(StatusCode::UNAUTHORIZED)?;

// Validate UUID format
uuid::Uuid::parse_str(&nonce).map_err(|_| StatusCode::UNAUTHORIZED)?;

// Check Redis for seen nonce
let nonce_key = format!("nonce:{}", nonce);
let seen: Option<String> = redis.get(&nonce_key).await.unwrap_or(None);
if seen.is_some() {
    return Err(StatusCode::UNAUTHORIZED); // replay detected
}

// Include nonce in message
let message = format!("{}.{}.{}.{}.{}", timestamp_str, method, path, body_hash, nonce);

// ... after successful verify:
let _: () = redis.set_ex(&nonce_key, "1", 600).await.unwrap_or(());
```

**Fix — SDK** (`packages/sdk/src/memwal.ts`):

```typescript
// Trong signedRequest(), thêm nonce vào headers và signed message
const nonce = crypto.randomUUID();
const message = `${timestamp}.${method}.${path}.${bodyHash}.${nonce}`;
headers["x-nonce"] = nonce;
```

**Lưu ý**: AppState cần expose Redis connection cho auth middleware. Kiểm tra xem `state.redis` có accessible không.

**Files**: `services/server/src/auth.rs`, `packages/sdk/src/memwal.ts`

---

### MEM-17 — Harden Concurrency & Resource Bounds
**Branch**: `feature/mem-17-sec-harden-concurrency-resource-bounds`
**Findings**: MED-3, MED-6, MED-13

#### Task A: Cap body.limit ≤ 100 trong /api/recall (MED-3)

**File**: `services/server/src/routes.rs`, line ~213

Hiện tại `RecallRequest` struct có field `limit` không bị cap:
```rust
// Trong recall() handler, TRƯỚC khi search:
let limit = body.limit.min(100); // cap at 100
let hits = state.db.search_similar(&query_vector, owner, namespace, limit).await?;
```

Hoặc tốt hơn, add validation ngay đầu hàm:
```rust
if body.limit > 100 {
    return Err(AppError::BadRequest("limit cannot exceed 100".into()));
}
```

**Files**: `services/server/src/routes.rs` (line ~213)

---

#### Task B: Replace join_all → buffer_unordered(10) trong /api/restore (MED-6)

**File**: `services/server/src/routes.rs`, line ~888

```rust
// BEFORE (line 888):
let downloaded: Vec<(String, Vec<u8>)> = futures::future::join_all(download_tasks)
    .await
    .into_iter()
    .flatten()
    .collect();

// AFTER — bounded concurrency:
use futures::StreamExt;
let downloaded: Vec<(String, Vec<u8>)> = futures::stream::iter(download_tasks)
    .buffer_unordered(10)
    .flatten()
    .collect()
    .await;
```

Thêm dependency vào `Cargo.toml` nếu chưa có: `futures = { features = ["executor"] }`

**Files**: `services/server/src/routes.rs` (line ~888)

---

#### Task C: Cap items.length ≤ 50 trong /seal/decrypt-batch (MED-13)

**File**: `services/server/scripts/sidecar-server.ts`, line ~398

```typescript
// Đầu handler /seal/decrypt-batch:
if (!Array.isArray(body.items) || body.items.length > 50) {
    return res.status(400).json({
        error: "items array must have at most 50 elements"
    });
}
```

**Files**: `services/server/scripts/sidecar-server.ts` (line ~398)

---

### MEM-18 — Rate Limiting Hardening
**Branch**: `feature/mem-18-sec-rate-limiting-hardening`
**Findings**: MED-19 (Atomic Lua), MED-20 (Path normalization), MED-21 (PG advisory lock)

#### Task A: Fail-Closed + Atomic Pipeline (MED-19) — `rate_limit.rs`

**Vấn đề nghiêm trọng**: Cả 3 `Err` branches (line 240, 259, 278) hiện tại **log rồi bỏ qua** lỗi Redis → rate limiter fail-open.

```rust
// BEFORE (line 240-242):
Err(e) => {
    tracing::error!("redis rate limit check failed (dk): {}, allowing", e);
}

// AFTER — fail closed:
Err(e) => {
    tracing::error!("redis rate limit check failed (dk): {}", e);
    return axum::response::Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("Content-Type", "application/json")
        .body(axum::body::Body::from(
            r#"{"error":"Rate limiter temporarily unavailable"}"#
        ))
        .unwrap();
}
```

Apply tương tự cho line 259-261 (burst) và 278-280 (sustained).

**Atomic pipeline** trong `record_in_window` (line ~150):
```rust
// BEFORE:
let mut pipe = redis::pipe();
// AFTER:
let mut pipe = redis::pipe();
pipe.atomic();  // wrap in MULTI/EXEC
```

**Atomic Lua script** cho check+increment (MED-19 yêu cầu):
```rust
// Thay check_window + record_in_window bằng Lua script:
const RATE_LIMIT_LUA: &str = r#"
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
local count = redis.call('ZCARD', key)

if count >= limit then
    return -1
end

for i = 0, weight - 1 do
    local ts = now + i * 0.001
    redis.call('ZADD', key, ts, tostring(ts))
end
redis.call('EXPIRE', key, ttl)
return count
"#;
```

**Files**: `services/server/src/rate_limit.rs` (lines 140–290)

---

#### Task B: Normalize Paths (MED-20) — `rate_limit.rs`

**Vấn đề**: `/api/analyze` và `/api/analyze/` được match khác nhau, bypass cost weight.

```rust
// Trong endpoint_weight(), normalize path trước khi match:
fn endpoint_weight(path: &str) -> i64 {
    let path = path.trim_end_matches('/'); // normalize trailing slash
    match path {
        "/api/analyze" => 10,
        // ...
    }
}
```

**Files**: `services/server/src/rate_limit.rs` (line ~93)

---

#### Task C: PostgreSQL Advisory Lock cho Storage Quota (MED-21)

**Vấn đề**: `check_storage_quota` là read-then-write (TOCTOU race), nhiều concurrent requests có thể all pass quota check rồi cùng write vượt quota.

```rust
// Trong check_storage_quota, wrap trong advisory lock:
pub async fn check_storage_quota(
    state: &AppState,
    owner: &str,
    additional_bytes: i64,
) -> Result<(), AppError> {
    // Acquire per-owner advisory lock
    let lock_key = crc32fast::hash(owner.as_bytes()) as i64;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock_key)
        .execute(&state.db.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Advisory lock failed: {}", e)))?;

    // Now do the quota check (within transaction lock)
    let used = state.db.get_storage_used(owner).await?;
    // ...
}
```

Cần thêm `crc32fast` dependency hoặc dùng `std::collections::hash_map::DefaultHasher`.

**Files**: `services/server/src/rate_limit.rs` (line ~299)

---

### MEM-19 — Input Validation & Error Message Sanitization
**Branch**: `feature/mem-19-sec-input-validation-error-message-sanitization`
**Findings**: MED-4, MED-8, MED-11

#### Task A: Cap extracted facts ≤ 20 (MED-4) — `routes.rs`

**File**: `services/server/src/routes.rs`, sau line 597 trong `extract_facts_llm`:

```rust
// Sau khi collect facts (line ~597):
let facts: Vec<String> = content
    .lines()
    .map(|l| l.trim().to_string())
    .filter(|l| !l.is_empty() && l != "NONE")
    .take(20)  // cap at 20 facts — MED-4
    .collect();
```

Ngoài ra, validate LLM response structure: nếu `choices` rỗng → trả về `[]` thay vì panic.

**Files**: `services/server/src/routes.rs` (line ~597)

---

#### Task B: Validate Sui Address Format cho owner (MED-11) — `sidecar-server.ts`

**File**: `services/server/scripts/sidecar-server.ts`, line ~503

```typescript
// Helper function:
function isValidSuiAddress(addr: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(addr);
}

// Trong /walrus/upload handler:
if (!isValidSuiAddress(body.owner)) {
    return res.status(400).json({ error: "Invalid owner Sui address format" });
}
```

**Files**: `services/server/scripts/sidecar-server.ts` (line ~503)

---

#### Task C: Error Message Sanitization (MED-8)

**Vấn đề**: Internal errors được expose trực tiếp cho client.

**Fix — Server** (`services/server/src/types.rs`, line ~362):

```rust
// Trong AppError impl IntoResponse, log detail và return generic:
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let correlation_id = uuid::Uuid::new_v4().to_string();
        let (status, user_msg) = match &self {
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".into()),
            AppError::QuotaExceeded(msg) => (StatusCode::PAYMENT_REQUIRED, msg.clone()),
            AppError::BlobNotFound(_) | AppError::NotFound(_) => {
                (StatusCode::NOT_FOUND, "Resource not found".into())
            }
            AppError::Internal(detail) => {
                // Log internally, return generic
                tracing::error!(correlation_id = %correlation_id, "Internal error: {}", detail);
                (StatusCode::INTERNAL_SERVER_ERROR,
                 format!("Internal error (ref: {})", correlation_id))
            }
        };
        // ...
    }
}
```

**Fix — Sidecar** (`sidecar-server.ts`):

```typescript
// Error handler middleware — tất cả unhandled errors:
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    const correlationId = crypto.randomUUID();
    console.error(`[${correlationId}] Unhandled error:`, err);
    res.status(500).json({
        error: "Internal server error",
        ref: correlationId
    });
});
```

**Files**: `services/server/src/types.rs`, `services/server/scripts/sidecar-server.ts`

---

### MEM-20 — SEAL Config & Smart Contract Hardening
**Branch**: `feature/mem-20-sec-seal-config-smart-contract-hardening`
**Findings**: MED-10, MED-15, MED-16

> [!WARNING]
> Smart contract changes (MED-15, MED-16) yêu cầu contract upgrade và redeployment. **Batch tất cả contract changes vào một lần deploy duy nhất.**

#### Task A: SEAL threshold — **SKIP MED-10** (threshold giữ nguyên = 1)

> **Lý do**: Production `SEAL_KEY_SERVERS` chỉ có **2 servers**. Nâng threshold lên 2/2 nghĩa là nếu 1 server bất kỳ down thì **toàn bộ decrypt fail cho mọi user**. Quá rủi ro.
>
> **Action thay thế**: Thêm server thứ 3 vào `SEAL_KEY_SERVERS` trên Railway trước, rồi mới set `threshold=2`.

Các fix còn lại trong MEM-20 (MED-15, MED-16) vẫn tiến hành bình thường.

---

#### Task B: Smart Contract — Derive sui_address from public_key (MED-15)

> **Upgrade strategy đã xác nhận**: Dùng `sui client upgrade` với `upgrade-capability`:  
> - Testnet: `0x97f972776ad53c73f1e79b8f83681ddcc2c1b82bed08f699b4a86c44bcae54be`  
> - Mainnet: `0xd98341980569514d1c4038ca8a6689d7012c82f4667951a7e5b6bdb015988a37`  
> Package ID **không thay đổi** → data cũ và users không bị ảnh hưởng.

#### Task B: Smart Contract — Derive sui_address from public_key (MED-15)

**File**: `services/contract/sources/account.move`, line ~170

```move
// BEFORE: accept sui_address từ caller
public fun register_account(
    registry: &mut AccountRegistry,
    sui_address: address,  // caller-provided, không verified
    ...
)

// AFTER: derive từ public_key
use sui::ecdsa_r1; // hoặc ed25519
public fun register_account(
    registry: &mut AccountRegistry,
    public_key_bytes: vector<u8>,
    ...
) {
    let derived_address = derive_address_from_pubkey(&public_key_bytes);
    // Thêm uniqueness check:
    assert!(!registry.addresses.contains(&derived_address), EAddressAlreadyRegistered);
    ...
}
```

---

#### Task C: Smart Contract — has_suffix check trong seal_approve (MED-16)

**File**: `services/contract/sources/account.move`, line ~385

```move
// Trong seal_approve, thêm:
let id_bytes = bcs::to_bytes(&id);
let owner_bytes = bcs::to_bytes(&account.owner);
// Verify id has owner_bytes as suffix (namespace binding)
assert!(
    vector::length(&id_bytes) >= vector::length(&owner_bytes) &&
    has_suffix(&id_bytes, &owner_bytes),
    EInvalidSealId
);
```

---

### MEM-21 — SDK & Infrastructure Hardening
**Branch**: `feature/mem-21-sec-sdk-infrastructure-hardening`
**Findings**: MED-14, MED-17, MED-18, MED-22

#### Task A: Accept Uint8Array + add destroy() method (MED-17)

**File**: `packages/sdk/src/types.ts`, line ~13

```typescript
// BEFORE:
export type DelegateKey = {
    privateKey: string; // hex
}

// AFTER:
export type DelegateKey = {
    privateKey: string | Uint8Array;
    destroy(): void; // zero-fill key material
}

// Implementation:
function createDelegateKey(privateKey: string | Uint8Array): DelegateKey {
    const keyHex = typeof privateKey === 'string'
        ? privateKey
        : bytesToHex(privateKey);
    let destroyed = false;
    return {
        privateKey: keyHex,
        destroy() {
            if (!destroyed) {
                // zero-fill string (best-effort in JS)
                destroyed = true;
            }
        }
    };
}
```

---

#### Task B: Warn/throw for non-HTTPS URLs (MED-18)

**File**: `packages/sdk/src/memwal.ts`, line ~72

```typescript
// Validate server URL at construction time:
constructor(config: MemWalConfig) {
    const url = new URL(config.serverUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new Error(
            `[MemWal] Security warning: serverUrl must use HTTPS in production. ` +
            `Got: ${config.serverUrl}`
        );
    }
    // ...
}
```

Same cho `packages/sdk/src/manual.ts`, line ~82.

---

#### Task C: Pin exact dependency versions (MED-14)

**File**: `services/server/scripts/package.json`

```json
// BEFORE (range version):
"@mysten/seal": "^0.1.0",
"@mysten/sui": "^1.0.0"

// AFTER (exact pin — run: npm install @mysten/seal@exact @mysten/sui@exact):
"@mysten/seal": "0.1.2",
"@mysten/sui": "1.18.0"
```

---

#### Task D: Docker hardening (MED-22)

**File**: `services/server/Dockerfile`

```dockerfile
# BEFORE:
FROM node:18
RUN curl | bash  # dangerous

# AFTER:
FROM node:20-slim  # official slim image, no curl|bash needed
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
# Add non-root user:
RUN addgroup --system appuser && adduser --system --ingroup appuser appuser
USER appuser
EXPOSE 9000
CMD ["node", "sidecar-server.js"]
```

---

### MEM-22 — Phase 4: Remediate 34 Low Severity Findings
**Branch**: `feature/mem-22-sec-phase-4-remediate-34-low-severity-polish-findings`

Nhóm các fixes nhỏ theo component:

#### Server (Rust) — LOW-1 to LOW-11

| ID | File | Dòng | Fix |
|----|------|------|-----|
| LOW-1 | `auth.rs` | ~103 | `path_and_query()` thay vì chỉ `path()` trong signed message |
| LOW-2 | `auth.rs` | — | Normalize response timing với `tokio::time::sleep` để constant-time |
| LOW-3 | `auth.rs` | ~186 | Add `expires_at` column vào `delegate_key_cache` table; evict old entries |
| LOW-4 | `rate_limit.rs` | ~150 | `pipe.atomic()` (đã cover trong MEM-18) |
| LOW-5 | `types.rs` | ~317 | Manual `Debug` impl: redact `delegate_key` field |
| LOW-6 | `routes.rs` | ~128 | Cap text length ≤ 50KB trong `/api/remember` |
| LOW-7 | `routes.rs` | ~268 | Count download failures, include in response |
| LOW-8 | `routes.rs` | ~695 | Add `\n\n---USER QUERY---\n\n` delimiter trong `/api/ask` |
| LOW-9 | `routes.rs` | ~70 | `reqwest::ClientBuilder::timeout(Duration::from_secs(30))` cho LLM |
| LOW-10 | `db.rs` | ~150 | Add `AND owner = $2` filter vào `delete_by_blob_id` |
| LOW-11 | `routes.rs` | ~139 | `text_bytes * 1.2` cho SEAL overhead trong quota check |

#### Sidecar (TypeScript) — LOW-12 to LOW-18

| ID | File | Dòng | Fix |
|----|------|------|-----|
| LOW-12 | `sidecar-server.ts` | ~329 | `/^[0-9a-f]+$/i.test(hex)` trước khi parse hex |
| LOW-13 | `sidecar-server.ts` | ~354 | SessionKey TTL: 30 → 5 phút (done với MED-2) |
| LOW-14 | `sidecar-server.ts` | ~620 | Log + return error khi blob transfer to owner fails |
| LOW-15 | `sidecar-server.ts` | ~793 | `/^[A-Za-z0-9+/=]{43}$/.test(digest)` trước URL interpolation |
| LOW-16 | `sidecar-server.ts` | ~297 | `isValidSuiAddress(packageId)` tại handler entry |
| LOW-17 | `sidecar-server.ts` | ~511 | `epochs = Math.min(body.epochs, 5)` |
| LOW-18 | `sidecar-server.ts` | ~492 | `console.log(...)` → `console.log({ owner, blobId })` (không log private key) |

#### Smart Contract (Move) — LOW-19 to LOW-21

| ID | File | Dòng | Fix |
|----|------|------|-----|
| LOW-19 | `account.move` | ~266 | `assert!(!account.active, EAlreadyDeactivated)` trước khi deactivate |
| LOW-20 | `account.move` | ~234 | Remove `assert!(account.active)` trong `remove_delegate_key` |
| LOW-21 | `account.move` | ~170 | `assert!(label_len <= 128, ELabelTooLong)` |

#### SDK & Frontend — LOW-22 to LOW-34

| ID | File | Dòng | Fix |
|----|------|------|-----|
| LOW-23 | `memwal.ts` | ~315 | Include `x-account-id` trong signed message payload |
| LOW-24 | `manual.ts` | ~457 | Include namespace trong SEAL encryption identity |
| LOW-25 | `utils.ts` | ~32 | `if (!/^[0-9a-f]*$/i.test(hex)) throw new Error(...)` |
| LOW-26 | `memwal.ts` | ~320 | Sanitize error: chỉ expose message, không expose stack trace |
| LOW-30 | `Dashboard.tsx` | ~170 | Replace actual key với `"sk_•••••••••"` placeholder |
| LOW-31 | `Dashboard.tsx` | ~119 | `if (label.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(label))` |
| LOW-32 | `App.tsx` | — | `window.addEventListener('beforeunload', clearDelegateKeys)` |
| LOW-33 | `multimodal-input.tsx` | ~51 | `document.cookie = "...;Secure;SameSite=Strict"` |
| LOW-34 | `files/upload/route.ts` | — | Rate limit: 10 uploads/hour per userId |

#### Infrastructure — LOW-27 to LOW-29

| ID | File | Fix |
|----|------|-----|
| LOW-27 | `docker-compose.yml` | PostgreSQL + Redis bind to `127.0.0.1`; remove hardcoded passwords |
| LOW-28 | `Dockerfile` | Pin: `FROM node:20-slim@sha256:...` |
| LOW-29 | `docker-compose.yml` | Add `mem_limit: 512m` và `cpus: "0.5"` per service |

---

### MEM-23 — Phase 5: Informational / Best Practices
**Branch**: `feature/mem-23-sec-phase-5-informational-best-practices`

| ID | File | Fix |
|----|------|-----|
| INFO-1 | `auth.rs` | delegate_key_cache: add `expires_at = NOW() + INTERVAL '24 hours'`; cron eviction |
| INFO-2 | `auth.rs` | `now.checked_sub(timestamp)` thay vì `(now - timestamp).abs()` |
| INFO-3 | `account.move` | Thêm `sui_address` field vào `DelegateKeyRemoved` event struct |
| INFO-4 | `docs/` | Tạo `docs/architecture/permanent-registry-design.md` |
| INFO-5 | `services/contract/tests/` | 5 test cases: non-owner key removal, non-owner reactivation, max-key boundary, seal_approve wrong id, duplicate sui_address |
| INFO-6 | `scripts/sidecar-server.ts` | Xóa `uptime: process.uptime()` khỏi `/health` response |
| INFO-7 | `docs/` | Tạo `docs/security/health-check-unsigned.md` |

---

## Dependency Order & Git Strategy

```
MEM-18 (rate_limit hardening)
    ↓
MEM-16 (replay protection — cần Redis access từ auth.rs)
    ↓
MEM-17 (concurrency bounds — independent)
MEM-19 (input validation — independent)
    ↓
MEM-20 (SEAL + smart contract — cần test kỹ trước deploy)
MEM-21 (SDK + infra — largely independent)
    ↓
MEM-22 (LOW findings — polish, no dependencies)
    ↓
MEM-23 (INFO — docs + tests)
```

**PR Strategy**: Mỗi MEM issue = 1 PR riêng. Smart contract changes (MEM-20) cần sign-off từ cả team trước khi merge.

---

## Verification Checklist Per Issue

### MEM-16
```bash
# Test replay:
NONCE=$(uuidgen)
curl -H "x-nonce: $NONCE" ... # first: 200
curl -H "x-nonce: $NONCE" ... # second: 401 (replay detected)

# Test deactivated account:
# Deactivate account onchain thì request phải trả 401
```

### MEM-17
```bash
# Test MED-3: recall với limit=9999 → phải nhận 400 hoặc bị cap về 100
curl -d '{"query":"test","limit":9999}' .../api/recall

# Test MED-6: restore với 1000 blobs → không OOM, bounded concurrency
# Test MED-13: decrypt-batch với 51 items → 400
```

### MEM-18
```bash
# Test fail-closed:
docker stop redis
curl .../api/recall  # Expected: 503 {"error":"Rate limiter temporarily unavailable"}
docker start redis

# Test path normalization:
# /api/analyze/ (trailing slash) phải có weight = 10, không phải 1
```

### MEM-19
```bash
# Test facts cap: input văn bản dài với 50+ facts → output tối đa 20
# Test Sui address validation: owner="invalid" → 400
# Test error sanitization: trigger internal error → no stack trace in response
```

### MEM-20
```bash
# SEAL threshold: test với 1/3 key servers down → decrypt phải fail (threshold=2)
# Smart contract: sui move test (full suite)
```

### MEM-21
```bash
cd packages/sdk && pnpm test
cd apps/app && pnpm build
# Docker: docker run --user appuser ... (should work)
# Verify no curl|bash in Dockerfile
```

### MEM-22 & MEM-23
```bash
cargo test  # Rust unit tests
sui move test  # Contract tests
pnpm test   # SDK tests
```

---

## Upgrade Command (cho MEM-20)

```bash
# Testnet
sui client upgrade \
  --upgrade-capability 0x97f972776ad53c73f1e79b8f83681ddcc2c1b82bed08f699b4a86c44bcae54be \
  --gas-budget 500000000

# Mainnet
sui client upgrade \
  --upgrade-capability 0xd98341980569514d1c4038ca8a6689d7012c82f4667951a7e5b6bdb015988a37 \
  --gas-budget 500000000
```

> Chạy từ thư mục `services/contract/`. Package ID trong Railway env **không cần đổi**.
