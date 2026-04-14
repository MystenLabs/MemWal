# Kết quả Review Security Tasks (MEM-1)

> Ngày review: 2026-04-14 | Nhánh chuẩn: `sec/security_fix`

---

## CẢNH BÁO CHUNG — Pattern Lỗi Lặp Lại Trên Nhiều PR

**Phát hiện nghiêm trọng xuyên suốt nhiều PR của Henry:**

Các PR #95, #96, #97, #98, #99, #100 đều có diff trong `sidecar-server.ts` với nội dung:

```diff
- import express, { Request, Response, NextFunction } from "express";
- import { timingSafeEqual } from "crypto";
+ import express from "express";

- // CORS — sidecar is called only by the co-located Rust server, never by browsers
- // Remove all CORS headers
- app.use((_req: Request, res: Response, next: NextFunction) => {
-     res.removeHeader("Access-Control-Allow-Origin");
-     ...
+ // CORS — allow frontend (any origin) to call sponsor endpoints
+ app.use((_req, res, next) => {
+     res.header("Access-Control-Allow-Origin", "*");
+     res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
```

**Đây là revert của MEM-11 fix** — CORS wildcard và xoá `timingSafeEqual` auth import. Không PR nào trong số này được phép có diff này. Toàn bộ sidecar CORS logic nên ở trạng thái **đã được fix bởi MEM-11** trên `sec/security_fix`.

> Nguyên nhân có thể: Các branch feature được tạo từ `dev` thay vì từ `sec/security_fix`, nên khi so sánh diff sẽ thấy thêm các thay đổi ngược chiều.

---

## Tổng quan nhanh

| Task | Assignee | Linear | @jnaulty cần tag | Code fix tồn tại | PR | Base branch | Kết quả |
|------|----------|--------|------------------|------------------|----|-------------|---------|
| MEM-2 | Henry | Backlog | — | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-3 | Harry | Backlog | Không áp dụng | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-4 | Harry | In Review | Không áp dụng | ✅ | (merged) | — | ✅ XONG |
| MEM-5 | Henry | In Review | Cần | ❌ | ❌ | — | ⛔ CHƯA FIX |
| MEM-6 | Harry | In Review | Không áp dụng | ⚠️ Partial | ❌ | — | ⚠️ PARTIAL |
| MEM-7 | Henry | In Progress | Cần | ✅ | PR#100 | ✅ | ⚠️ Có commit rác |
| MEM-8 | Harry | Backlog | Không áp dụng | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-9 | Harry | Backlog | Không áp dụng | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-10 | Harry | Backlog | Không áp dụng | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-11 | Harry | In Review | Không áp dụng | ✅ | (merged) | — | ✅ XONG |
| MEM-12 | Harry | In Review | Không áp dụng | ✅ | (merged) | — | ✅ nhưng PR#94 revert! |
| MEM-13 | Henry | In Review | Cần | ✅ | PR#87, PR#98 | ✅ | ✅ Code OK |
| MEM-14 | Henry | In Review | Cần | ✅ | PR#90 | ✅ | ✅ Code OK — Clean PR |
| MEM-15 | Harry | Backlog | Không áp dụng | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-16 | Henry | In Progress | Cần | ✅ | PR#95 | ✅ | ⚠️ Có commit rác |
| MEM-17 | Henry | In Progress | Cần | ✅ | PR#96 | ✅ | ⚠️ Có commit rác nghiêm trọng |
| MEM-18 | Henry | In Progress | Cần | ✅ | PR#97 | ✅ | ✅ Code OK, có commit rác nhẹ |
| MEM-19 | Henry | In Progress | Cần | ✅ | PR#98 | ✅ | ⚠️ Có commit rác nghiêm trọng |
| MEM-20 | Henry | In Progress | Cần | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-21 | Henry | In Progress | Cần | ✅ | PR#99 | ✅ | ⚠️ Có commit rác |
| MEM-22 | Henry | In Progress | Cần | ❌ | ❌ | — | ⛔ CHƯA LÀM |
| MEM-23 | Henry | In Progress | Cần | ✅ | PR#94 | ✅ | ⛔ BLOCK — Revert MEM-12 |

---

## Chi tiết Review từng Task (Bước 4 — Code Review)

---

### ✅ MEM-4 — Rate limiter fail closed when Redis unavailable
- **Assignee:** Harry | **Status:** In Review
- **Bước 1:** Không áp dụng (Harry task)
- **Bước 2:** ✅ Code đã merge vào `sec/security_fix`:
  - Redis down → HTTP 503 (không bypass)
  - Pipeline failure → atomic rollback
  - Log đúng (blocking, không nói "allowing")
- **Kết quả:** ✅ XONG

---

### ✅ MEM-11 — Lock down sidecar (Zero auth, wildcard CORS, 0.0.0.0)
- **Assignee:** Harry | **Status:** In Review
- **Bước 2:** ✅ Code đã merge vào `sec/security_fix` (commit `357bc6b`, `de0ae48`, `3bc98b6`):
  - CORS headers removed hoàn toàn
  - Auth middleware Bearer token (`timingSafeEqual`) — fail-closed
  - Bind `127.0.0.1` thay vì `0.0.0.0`
- **Kết quả:** ✅ XONG

---

### ✅ MEM-14 — SEAL key server verification disabled
- **Assignee:** Henry | **Status:** In Review
- **Bước 1:** Chưa tag @jnaulty (cần làm thủ công)
- **Bước 3/4:** PR#90 — **Code sạch nhất trong tất cả PR**
  - 4 files changed, tất cả đều đúng scope
  - `manual.ts`: `verifyKeyServers: false` → `true`
  - `seal-decrypt.ts`: `verifyKeyServers: false` → `true`
  - `seal-encrypt.ts`: `verifyKeyServers: false` → `true`
  - `sidecar-server.ts`: `verifyKeyServers: false` → `true`
  - ✅ Không có file thừa, không có commit rác
- **Kết quả:** ✅ Code đúng — cần tag @jnaulty review

---

### ✅ MEM-13 — Analyze endpoint cost amplification
- **Assignee:** Henry | **Status:** In Review
- **Bước 1:** Chưa tag @jnaulty
- **Bước 3/4:** PR#87 (chính) + PR#98 (một phần)
  - `rate_limit.rs`: `ANALYZE_BASE_WEIGHT = 10`, `ANALYZE_PER_FACT_WEIGHT = 1`, `endpoint_weight` public
  - `routes.rs`: `MAX_ANALYZE_FACTS = 20`, `ANALYZE_CONCURRENCY = 5`, `ANALYZE_MAX_OUTPUT_TOKENS = 256`
  - `test_analyze_rate_limit.py`: +105 dòng test mới (tốt, không phải xoá)
  - ✅ Logic đúng — cap facts, bounded concurrency
- **Kết quả:** ✅ Code đúng — cần tag @jnaulty review

---

### ✅ MEM-18 — Rate Limiting Hardening (Atomic Lua, path normalize, PG advisory lock)
- **Assignee:** Henry | **Status:** In Progress
- **Bước 1:** Chưa tag @jnaulty
- **Bước 3/4:** PR#97
  - `rate_limit.rs`:
    - MED-20: `path.trim_end_matches('/')` — normalize trailing slash ✅
    - MED-19: `pipe.atomic()` đã có, comment giải thích rõ MULTI/EXEC ✅
    - `record_in_window` dùng `.atomic()` — atomic zadd+expire ✅
  - `db.rs`: `acquire_advisory_lock` — PostgreSQL session-level advisory lock ✅
  - **Files thừa:** `App.tsx` (+4/-4), `chat.tsx` (+6/-6), `sidecar.ts` (-36 bao gồm revert MEM-11), `seal.rs`, `walrus.rs`, test bị xoá
  - ⚠️ Diff trong sidecar đảo ngược MEM-11 CORS fix (xem cảnh báo chung)
- **Kết quả:** Core changes đúng, nhưng cần clean PR (loại bỏ files thừa). Cần tag @jnaulty

---

### ⚠️ MEM-16 — Replay Protection & Block Deactivated Accounts
- **Assignee:** Henry | **Status:** In Progress
- **Bước 1:** Chưa tag @jnaulty
- **Bước 3/4:** PR#95
  - `auth.rs`: Nonce tracking (UUID v4, TTL=600s > timestamp window 300s) ✅
    - `x-nonce` header required, UUID format validated
    - Redis `SETNX key TTL` để track seen nonces
    - Fail-closed nếu Redis không available
  - `sui.rs`: `account.active` check trước khi verify delegate key ✅
    - Default `true` cho backward compat với contract cũ — hợp lý
    - Trả về `AccountDeactivated` error riêng
  - `memwal.ts` (SDK): nonce UUID v4 per-request, include trong message ký ✅
  - **Files thừa:** `App.tsx`, `chat.tsx`, sidecar (revert MED-11 CORS), `rate_limit.rs`, `seal.rs`, `walrus.rs`, test bị xoá
  - ⚠️ Diff trong sidecar đảo ngược MEM-11 CORS fix
- **Kết quả:** Core changes đúng — cần clean PR. Cần tag @jnaulty

---

### ⚠️❗ MEM-17 — Harden Concurrency & Resource Bounds
- **Assignee:** Henry | **Status:** In Progress
- **Bước 1:** Chưa tag @jnaulty
- **Bước 3/4:** PR#96
  - `routes.rs` (+24/-31): có `futures::StreamExt` import, nhưng patch hiển thị xoá `sidecar_secret.as_deref()` — **đây là revert của MEM-11 auth logic**
  - **VẤN ĐỀ NGHIÊM TRỌNG trong sidecar.ts:**
    ```diff
    - // CORS — sidecar is called only by the co-located Rust server
    - app.use((_req: Request, res: Response, next: NextFunction) => {
    -     res.removeHeader("Access-Control-Allow-Origin");
    + // CORS — allow frontend (any origin)
    + app.use((_req, res, next) => {
    +     res.header("Access-Control-Allow-Origin", "*");
    ```
    **Đây là revert hoàn toàn MEM-11!** Nếu merge PR này sẽ mở lại wildcard CORS trên sidecar.
  - Cũng xoá `timingSafeEqual` import → mất auth middleware
  - Scope thực của MEM-17 (cap body.limit, buffer_unordered) không rõ vì bị dìm trong noise
- **Kết quả:** ⛔ **BLOCK** — Phải loại bỏ toàn bộ sidecar.ts diff và routes.rs diff thừa trước khi merge

---

### ⚠️❗ MEM-19 — Input Validation & Error Message Sanitization
- **Assignee:** Henry | **Status:** In Progress
- **Bước 1:** Chưa tag @jnaulty
- **Bước 3/4:** PR#98
  - `routes.rs` (+83/-25): `validate_namespace()` function — đúng scope ✅
    - Max 64 chars, chỉ alphanumeric + `-_` + `.`, không có `..`
    - Áp dụng namespace validation ở các endpoints
  - `types.rs` (+17/-9): `MAX_RESTORE_LIMIT = 200`, xoá `sidecar_secret` khỏi Config
    - ⚠️ Xoá `sidecar_secret` khỏi Config **loại bỏ SIDECAR_AUTH_TOKEN** — revert MEM-11 auth
  - **sidecar.ts diff:** Revert MEM-11 CORS giống PR#96 (wildcard CORS trở lại)
- **Kết quả:** ⛔ Cần clean: xoá diff trong `sidecar.ts`, khôi phục `sidecar_secret` trong `types.rs`. Sau đó cần tag @jnaulty

---

### ⚠️ MEM-21 — SDK & Infrastructure Hardening
- **Assignee:** Henry | **Status:** In Progress
- **Bước 1:** Chưa tag @jnaulty
- **Bước 3/4:** PR#99
  - `memwal.ts` (+51): `destroy()` method, `Uint8Array` support, HTTPS validation ✅
  - `types.ts` (+17): `key: string | Uint8Array`, `onDestroy?: () => void` ✅
  - `Dockerfile` (+6): `USER appuser` non-root, `chown` ✅
  - `scripts/package.json`: pin exact versions (`^` → thẳng version) ✅
  - **Files thừa:** `App.tsx`, `chat.tsx`, `rate_limit.rs`, `routes.rs`, `seal.rs`, `test_rate_limit_redis.py` (xoá 76 dòng)
  - ⚠️ Sidecar diff có revert CORS (tương tự các PR khác)
- **Kết quả:** Core changes đúng — cần clean PR (giữ lại chỉ: sdk files, Dockerfile, package.json). Cần tag @jnaulty

---

### ⚠️ MEM-7 — Server wallet private keys transmitted per-request to sidecar
- **Assignee:** Henry | **Status:** In Progress
- **Bước 1:** Chưa tag @jnaulty (comment trước chỉ tag @harry.phan)
- **Bước 3/4:** PR#100
  - `walrus.rs`: `private_key: String` → `key_index: usize` trong struct + hàm ✅
  - `types.rs`: thêm `next_index()` trả về round-robin index ✅
  - `sidecar-server.ts`: Load `SERVER_SUI_PRIVATE_KEYS` từ env lúc startup ✅
    - Resolve key từ index tại runtime — keys không bao giờ qua wire ✅
  - `seal.rs`: Xoá `sidecar_secret` param khỏi `seal_encrypt/decrypt` — ⚠️ revert auth
  - **Files thừa:** `App.tsx`, `chat.tsx`, `rate_limit.rs`, `seal.rs` (xoá auth), test bị xoá
  - PR#91 (ENG-1423) cũng cover cùng fix này nhưng clean hơn (4 files, đúng scope)
- **Kết quả:** Core changes đúng. Cần clean: xoá files thừa. PR#91 sạch hơn PR#100. Cần tag @jnaulty

---

### ⚠️ MEM-12 — Migrate delegate key storage: localStorage → sessionStorage
- **Assignee:** Harry | **Status:** In Review
- **Bước 2:** ✅ Fix đã có trên `sec/security_fix` (sessionStorage)
- **Bước 1:** Comment tag @jnaulty đã được post ✅
- **⛔ VẤN ĐỀ — PR#94 REVERT FIX NÀY:**
  ```diff
  PR#94 (MEM-23) — App.tsx:
  - "Delegate Key Context (stored in sessionStorage — cleared on tab close)"
  + "Delegate Key Context (stored in localStorage)"
  + localStorage.setItem('memwal_delegate', encryptObj(next))   // XOR obfuscation
  ```
  - XOR với hardcoded key `"memwal_sec_2026_04"` — **không phải mã hoá thực**
  - Bất kỳ JS nào trên page đều decode được dễ dàng
  - Nếu PR#94 merge → MEM-12 fix bị revert → security regression
- **Kết quả:** ✅ Fix tồn tại nhưng ⛔ BLOCK PR#94 cho đến khi `App.tsx` + `chat.tsx` được loại bỏ

---

### ⛔ MEM-23 — Phase 5: Informational / Best Practices
- **Assignee:** Henry | **Status:** In Progress
- **Bước 1:** Chưa tag @jnaulty
- **Bước 3/4:** PR#94
  - `auth.rs` (+10): TTL-based eviction cho auth cache ✅
  - `db.rs` (+23): `expires_at` tracking cho delegate keys ✅
  - `main.rs` (+18): background task cleanup ✅
  - `services/contract/sources/account.move` (+4): `sui_address` trong `DelegateKeyRemoved` event ✅
  - `services/contract/tests/account_tests.move` (+112): test coverage ✅
  - `docs/`: 2 docs mới về permanent registry và unsigned health check ✅
  - **⛔ COMMIT RÁC NGHIÊM TRỌNG:**
    - `apps/app/src/App.tsx`: Revert sessionStorage → localStorage + XOR obfuscation
    - `apps/chatbot/components/chat.tsx`: Tương tự — revert MEM-12
    - `rate_limit.rs`, `routes.rs`, `seal.rs`, `walrus.rs`: diff thừa
    - `tests/test_rate_limit_redis.py`: xoá 76 dòng test
- **Kết quả:** ⛔ **BLOCK** — Phải loại bỏ `App.tsx`, `chat.tsx`, và Rust/test files thừa trước khi merge. Sau khi clean, cần tag @jnaulty

---

## Tasks Backlog — Chưa có code fix

### ⛔ MEM-2 — Delegate private keys in sidecar decrypt request bodies
- **Assignee:** Henry | **Status:** Backlog
- `privateKey` vẫn tồn tại trong body của `/seal/decrypt`, `/seal/decrypt-batch`, `/walrus/upload` trên `sec/security_fix`
- **Không có PR nào**

### ⛔ MEM-3 — No body size limit on unauthenticated public endpoints
- **Assignee:** Harry | **Status:** Backlog
- Không có `DefaultBodyLimit::max(16_384)` nào trong `routes.rs`
- **Không có PR nào**

### ⛔ MEM-5 — Remove delegate private key from HTTP request headers
- **Assignee:** Henry | **Status:** In Review (sai — thực tế chưa fix)
- SDK (`memwal.ts` line 314 trên `sec/security_fix`) vẫn gửi `"x-delegate-key": bytesToHex(this.privateKey)`
- **Không có PR riêng** cho task này
- *Lưu ý: PR#99 (MEM-21) thêm HTTPS check nhưng không xóa `x-delegate-key` header*

### ⛔ MEM-6 — Add auth and rate limiting to /sponsor and /sponsor/execute
- **Assignee:** Harry | **Status:** In Review
- `/sponsor` và `/sponsor/execute` trên `sec/security_fix` chỉ proxy sang sidecar, **không có auth/rate limiting từ external caller vào Rust server**
- Notion plan đã được tạo nhưng chưa có code implementation
- **Không có PR riêng**

### ⛔ MEM-8, MEM-9, MEM-10, MEM-15 — Backlog (Harry)
- Không có code fix, không có PR

### ⛔ MEM-20 — SEAL Config & Smart Contract Hardening
- **Assignee:** Henry | **Status:** In Progress (sai)
- Không có branch `feature/mem-20-*` trên remote, không có PR

### ⛔ MEM-22 — Phase 4: Remediate 34 Low Severity Findings
- **Assignee:** Henry | **Status:** In Progress (sai)
- Không có branch `feature/mem-22-*` trên remote, không có PR

---

## Action Items tổng hợp

### 🚨 BLOCK ngay — Không được merge

| PR | Lý do |
|----|-------|
| PR#94 (MEM-23) | Revert MEM-12 (sessionStorage→localStorage + XOR fake crypto) |
| PR#96 (MEM-17) | Revert MEM-11 CORS (wildcard CORS trở lại sidecar) |
| PR#98 (MEM-19) | Revert MEM-11 (xoá sidecar_secret khỏi Config + CORS) |

### ⚠️ Cần clean trước khi merge

| PR | Files cần loại bỏ |
|----|-------------------|
| PR#94 | `App.tsx`, `chat.tsx`, `rate_limit.rs`, `routes.rs`, `seal.rs`, `walrus.rs`, test file |
| PR#95 | `App.tsx`, `chat.tsx`, sidecar CORS diff, `rate_limit.rs`, `seal.rs`, `walrus.rs`, test file |
| PR#96 | Toàn bộ sidecar diff, `routes.rs` diff thừa, `rate_limit.rs`, `seal.rs`, `walrus.rs`, test file |
| PR#97 | `App.tsx`, `chat.tsx`, sidecar CORS diff, `seal.rs`, `walrus.rs`, test file |
| PR#98 | Sidecar CORS diff, `sidecar_secret` xoá trong `types.rs` |
| PR#99 | `App.tsx`, `chat.tsx`, `rate_limit.rs`, `routes.rs`, `seal.rs`, test file |
| PR#100 | `App.tsx`, `chat.tsx`, `rate_limit.rs`, seal.rs auth removal, test file |

### 📌 Cần tag @jnaulty review (Harry tự quyết định khi nào)

MEM-7 (PR#100), MEM-13 (PR#87/#98), MEM-14 (PR#90), MEM-16 (PR#95), MEM-17 (PR#96), MEM-18 (PR#97), MEM-19 (PR#98), MEM-21 (PR#99), MEM-23 (PR#94)

### 📌 Cần assign & implement

| Task | Assignee | Priority |
|------|----------|----------|
| MEM-5 | Henry | 🔴 Urgent |
| MEM-6 | Harry | 🔴 Urgent |
| MEM-2 | Henry | 🟠 High |
| MEM-3 | Harry | 🟠 High |
| MEM-20 | Henry | — |
| MEM-22 | Henry | — |
| MEM-8, 9, 10, 15 | Harry | 🟠 High |
