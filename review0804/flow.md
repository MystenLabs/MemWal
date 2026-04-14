# Security Fix — Development Flow

> Áp dụng cho mỗi task trong MEM-16 đến MEM-23.
> Tuân theo đúng thứ tự này, không bỏ bước.

---

## Checklist mỗi task

```
[ ] 1. Tạo nhánh mới
[ ] 1b. Đọc plan → hỏi ngay nếu có gì không rõ → chờ xác nhận
[ ] 2. Implement fix
[ ] 3. Viết / cập nhật unit test
[ ] 4. Chạy test
[ ] 5. Build để check compile
[ ] 6. Review bằng AI (static analysis)
[ ] 7. Commit + push
[ ] 8. Update plan → chuyển task tiếp theo
```

---

## Bước 1 — Tạo nhánh mới từ `dev`

```bash
git checkout dev
git pull origin dev
git checkout -b feature/mem-{N}-{slug}

# Ví dụ:
git checkout -b feature/mem-18-sec-rate-limiting-hardening
```

> **Quy tắc đặt tên**: `feature/mem-{issue-number}-{kebab-case-title-tối-đa-5-từ}`

---

## Bước 2 — Implement fix

Làm theo đúng task description trong `MEM-1-review-plan.md`.

**Lưu ý khi code**:
- Không thêm code ngoài scope của task (tránh diff lớn, dễ review)
- Giữ nguyên comments/docstrings không liên quan
- Nếu phát hiện bug mới → ghi chú vào plan, **không fix lẫn vào PR này**

---

## Bước 3 — Viết / cập nhật unit test

### Rust (server)
```bash
# Thêm test vào cuối file hoặc vào tests/ module
# Convention: #[cfg(test)] mod tests { ... }
```

### TypeScript (sidecar, SDK)
```bash
cd services/server/scripts   # hoặc packages/sdk
# Thêm test case vào file .test.ts liên quan
```

### Move (contract)
```bash
# Thêm vào services/contract/tests/
```

> Mỗi fix bảo mật phải có **ít nhất 1 test case chứng minh lỗi cũ bị block**.

---

## Bước 4 — Chạy test

### Rust
```bash
cd services/server
cargo test 2>&1 | tail -20
# Expect: test result: ok. N passed; 0 failed
```

### TypeScript sidecar
```bash
cd services/server/scripts
npx tsc --noEmit
# Expect: 0 errors
```

### SDK
```bash
cd packages/sdk
pnpm test 2>&1 | tail -20
# hoặc: npx vitest run
```

### Move contract
```bash
cd services/contract
sui move test 2>&1 | tail -20
# Expect: Test result: OK. Total tests: N; passed: N; failed: 0
```

---

## Bước 5 — Build để check compile

### Rust (bắt buộc)
```bash
cd services/server
cargo build 2>&1 | grep -E "^error|warning\[" | head -30
# Expect: Finished ... (0 errors)
```

### TypeScript sidecar (bắt buộc)
```bash
cd services/server/scripts
npx tsc --noEmit 2>&1 | head -20
# Expect: no output = 0 errors
```

### SDK (nếu có thay đổi)
```bash
cd packages/sdk
pnpm build 2>&1 | tail -10
```

### Frontend app (nếu có thay đổi)
```bash
cd apps/app
pnpm build 2>&1 | tail -10
# Chỉ build nếu task chạm vào file trong apps/
```

---

## Bước 6 — AI Review (static analysis)

Dùng Gemini CLI để double-check những gì vừa thay đổi:

```bash
# Xem diff những gì đã thay đổi
git diff dev...HEAD -- services/server/src/ > /tmp/current_diff.patch

# Chạy Gemini review (nếu có gemini CLI)
gemini review /tmp/current_diff.patch \
  --prompt "Review security fix diff. Find: logic errors, edge cases missed, new attack surfaces introduced. Be concise."

# Nếu không có gemini CLI → dùng claude CLI (đã cài)
claude review /tmp/current_diff.patch 2>/dev/null \
  || git diff dev...HEAD | head -200
```

**Những gì cần check thủ công nếu không có CLI**:
- [ ] Không có `unwrap()` / `expect()` mới nào trên đường code có thể panic
- [ ] Không expose thêm thông tin lỗi nội bộ ra response
- [ ] Không hardcode secret / key nào trong code
- [ ] Không có logic nào có thể bypass authentication

---

## Bước 7 — Commit & Push

```bash
# Stage chỉ những file liên quan đến task
git add services/server/src/rate_limit.rs   # ví dụ

# Commit với format chuẩn
git commit -m "fix(security): MEM-18 rate limiter fail-closed on Redis error (MED-19, MED-20, MED-21)"

# Format: fix(security): MEM-{N} {mô tả ngắn gọn} ({finding IDs})
# Ví dụ khác:
# fix(security): MEM-16 add nonce-based replay protection (MED-1)
# fix(security): MEM-16 block deactivated accounts in onchain verify (MED-2)
# fix(security): MEM-17 cap recall limit ≤100 prevent DB scan (MED-3)

git push origin feature/mem-{N}-{slug}
```

> **Không push nhiều task vào 1 commit**. 1 PR = 1 MEM issue.

---

## Bước 8 — Update plan → task tiếp theo

Đến file `review0804/MEM-1-review-plan.md`:
1. Đánh dấu task vừa xong: thêm ✅ hoặc `[DONE]` vào đầu
2. Ghi PR link (sau khi tạo PR trên GitHub)
3. Note bất kỳ vấn đề phát hiện thêm
4. Chuyển sang task tiếp theo theo thứ tự

---

## Thứ tự thực hiện

```
MEM-18  →  MEM-16  →  MEM-17  →  MEM-19  →  MEM-20  →  MEM-21  →  MEM-22  →  MEM-23
```

| Issue | Branch | Scope | Build check |
|-------|--------|-------|-------------|
| MEM-18 | `feature/mem-18-sec-rate-limiting-hardening` | `rate_limit.rs` | `cargo build` + `cargo test` |
| MEM-16 | `feature/mem-16-sec-replay-protection-block-deactivated` | `auth.rs`, `sui.rs`, SDK | `cargo build` + `tsc` + SDK test |
| MEM-17 | `feature/mem-17-sec-harden-concurrency-resource-bounds` | `routes.rs`, `sidecar-server.ts` | `cargo build` + `tsc` |
| MEM-19 | `feature/mem-19-sec-input-validation-error-sanitization` | `routes.rs`, `types.rs`, `sidecar-server.ts` | `cargo build` + `tsc` |
| MEM-20 | `feature/mem-20-sec-seal-config-smart-contract-hardening` | `account.move` | `sui move test` |
| MEM-21 | `feature/mem-21-sec-sdk-infrastructure-hardening` | SDK, `Dockerfile` | `pnpm build` + `docker build` |
| MEM-22 | `feature/mem-22-sec-phase-4-low-findings` | nhiều file | tất cả |
| MEM-23 | `feature/mem-23-sec-phase-5-informational` | docs, tests | `sui move test` |

---

## Quick Reference — Lệnh hay dùng

```bash
# Xem những file mình đã sửa
git diff --name-only dev...HEAD

# Xem full diff
git diff dev...HEAD

# Undo file cụ thể (nếu lỡ sửa sai)
git checkout dev -- services/server/src/routes.rs

# Stash tạm khi cần chuyển branch
git stash && git stash pop

# Cargo check (nhanh hơn build, chỉ check compile errors)
cargo check 2>&1 | grep "^error" | head -20

# TypeScript check nhanh
npx tsc --noEmit --skipLibCheck 2>&1 | head -20
```

---

## Quy tắc không được vi phạm

1. **Không bao giờ commit trực tiếp lên `dev`** — luôn qua branch + PR
2. **Không gộp 2+ MEM issues vào 1 branch** — mỗi PR phải review được độc lập
3. **Không push nếu `cargo build` còn lỗi**
4. **Không push nếu test fail**
5. **Contract changes (MEM-20)**: test trên testnet trước, xác nhận OK 24h, rồi mới upgrade mainnet
