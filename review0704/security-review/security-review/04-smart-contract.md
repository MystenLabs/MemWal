# MemWal Move Smart Contract Security Review

**Contract:** `memwal::account` (`services/contract/sources/account.move`)
**Date:** 2026-04-02
**Scope:** Line-by-line security analysis of the Move smart contract
**Commit:** 5bb1669
**Reviewer:** Independent code review (second pass, validating against prior audit)

---

## Executive Summary

The MemWal Move contract is a compact (~427 lines) access control module with a small attack surface. The code quality is high: all entry functions have correct ownership assertions, the "Silent Authorization Check" antipattern is absent, and Move's linear type system eliminates reentrancy by design. The contract has 23 unit tests covering the major paths.

This review identifies **2 MEDIUM**, **3 LOW**, and **3 INFORMATIONAL** findings. The most significant issue (MEDIUM-1) is the previously-reported unvalidated `sui_address` parameter, which this review confirms and extends with a new attack scenario. A new MEDIUM finding (MEDIUM-2) identifies that delegates can decrypt data for ANY account they are registered in, without the `id` (key ID) being validated against the specific account.

---

## 1. Access Control Analysis

### Entry Function Authorization Matrix

| Function | Lines | Owner Check | Active Check | Other Checks |
|----------|-------|-------------|--------------|--------------|
| `create_account` | 132-161 | N/A (anyone can call) | N/A (new account) | No duplicate (registry) |
| `add_delegate_key` | 169-220 | `assert!(owner == sender)` L178 | `assert!(active)` L181 | Key length, max keys, no duplicate |
| `remove_delegate_key` | 226-257 | `assert!(owner == sender)` L231 | `assert!(active)` L234 | Key must exist |
| `deactivate_account` | 266-277 | `assert!(owner == sender)` L270 | None (correct) | None |
| `reactivate_account` | 281-292 | `assert!(owner == sender)` L285 | None (correct) | None |
| `seal_approve` | 373-390 | Implicit (owner OR delegate) | `assert!(active)` L379 | `is_owner \|\| is_delegate` L389 |

**Assessment:** All entry functions that modify state correctly verify `account.owner == ctx.sender()`. The `deactivate_account` and `reactivate_account` functions intentionally do NOT check `active` status, which is correct -- an owner must be able to deactivate an active account and reactivate a frozen one. No missing auth checks found.

---

## 2. Object Ownership Model

### Shared Objects

- **`AccountRegistry`** (line 50-54): Created once in `init()` (line 118-124), shared via `transfer::share_object`. Correct -- must be shared so any address can call `create_account`.
- **`MemWalAccount`** (line 58-68): Created in `create_account` (line 160), shared via `transfer::share_object`. Correct -- must be shared so SEAL key servers can call `seal_approve` via `dry_run`.

**Assessment:** Architecturally sound. Since `MemWalAccount` is shared, anyone can pass it as an argument to any function. All entry functions correctly gate mutations behind owner checks, so this is safe.

---

## 3. Delegate Key Management

### Addition (lines 169-220)
- **Owner-only:** Enforced (line 178)
- **Active-only:** Enforced (line 181)
- **Key length:** Exactly 32 bytes enforced (line 184)
- **Max keys:** Strictly < 20 enforced (line 187-189)
- **Duplicate check:** Iterates all existing keys, checks `public_key` equality (lines 193-201)

### Removal (lines 226-257)
- **Owner-only:** Enforced (line 231)
- **Active-only:** Enforced (line 234)
- **Key existence:** Iterates and asserts found (line 251)
- **Removal method:** `vector::remove(i)` -- shifts elements left. O(n) bounded by MAX_DELEGATE_KEYS=20, so negligible gas cost.

### Key Observations

1. **No sui_address uniqueness check** (see MEDIUM-1 below)
2. **No label length validation** -- labels are arbitrary `String` values. Bounded only by Sui's 128KB transaction size limit.
3. **Duplicate check is by public_key only** -- the same `sui_address` can appear in multiple `DelegateKey` entries with different (fake) public keys.

---

## 4. seal_approve() Analysis (lines 373-390)

```move
entry fun seal_approve(
    id: vector<u8>,
    account: &MemWalAccount,
    ctx: &TxContext,
) {
    assert!(account.active, EAccountDeactivated);  // L379
    let caller = ctx.sender();                      // L381
    let owner_bytes = sui::bcs::to_bytes(&account.owner);  // L384
    let is_owner = (caller == account.owner) && has_suffix(&id, &owner_bytes);  // L385
    let is_delegate = is_delegate_address(account, caller);  // L387
    assert!(is_owner || is_delegate, ENoAccess);    // L389
}
```

### Owner Path
- Requires BOTH `caller == account.owner` AND `has_suffix(id, bcs(owner))`.
- The `has_suffix` check ensures the key ID ends with the owner's BCS-encoded address. This binds the decryption to the correct owner's data.

### Delegate Path
- Requires ONLY that `caller`'s Sui address is in `delegate_keys[].sui_address`.
- **Does NOT check the `id` parameter at all.** This is significant -- see MEDIUM-2 below.

### has_suffix() Helper (lines 406-417)
- Correct suffix comparison implementation.
- Handles edge cases: `suffix_len > data_len` returns false (line 409).
- No underflow or overflow risk.

---

## 5. Account Lifecycle

### Creation (lines 132-161)
- One account per Sui address, enforced by `registry.accounts.contains(sender)` check.
- Account starts `active: true`.
- Immediately shared (`transfer::share_object`).

### Deactivation (lines 266-277)
- Owner-only. Sets `active = false`.
- Effect: `seal_approve` will reject all decryption requests. `add_delegate_key` and `remove_delegate_key` will also fail.
- Delegate keys are preserved (not cleared). Intentional -- reactivation restores all prior delegates.

### Reactivation (lines 281-292)
- Owner-only. Sets `active = true`.
- All previously registered delegate keys immediately regain SEAL access.

### Risk: Deactivation Does Not Clear Delegates
When an owner deactivates due to a compromised delegate key, the compromised key remains registered. Upon reactivation, the compromised delegate regains access. The owner must remember to remove the key after reactivation (or the contract should support removing keys while deactivated). See LOW-2 below.

---

## 6. Registry

- `Table<address, ID>` with O(1) lookup. No iteration capability on-chain (indexer handles discovery via events).
- No `delete_account` function -- registry entries are permanent. Design choice, not a vulnerability.

---

## 7. Data Validation

| Field | Validation | Lines | Assessment |
|-------|-----------|-------|------------|
| `public_key` | Exactly 32 bytes | 184 | Correct for Ed25519 |
| `sui_address` | None (caller-provided) | 170 | **MEDIUM finding** |
| `label` | None (arbitrary String) | 170 | LOW risk (see LOW-3) |
| `id` (seal key ID) | Suffix check only | 385 | By design |
| `delegate_keys.length()` | < 20 | 187-189 | Correct |

No integer overflow risk -- no arithmetic on user-controlled values beyond vector indexing bounded by max 20.

---

## 8. Event Emission

| Event | Emitted In | Lines | Complete? |
|-------|-----------|-------|-----------|
| `AccountCreated` | `create_account` | 155-158 | Yes: account_id, owner |
| `DelegateKeyAdded` | `add_delegate_key` | 212-217 | Yes: account_id, public_key, sui_address, label |
| `DelegateKeyRemoved` | `remove_delegate_key` | 253-256 | Yes: account_id, public_key |
| `AccountDeactivated` | `deactivate_account` | 273-276 | Yes: account_id, owner |
| `AccountReactivated` | `reactivate_account` | 289-291 | Yes: account_id, owner |

**Assessment:** All state-changing operations emit events. Events are emitted after assertions pass, so they accurately reflect committed state.

**Minor gap:** `DelegateKeyRemoved` does not include `sui_address` (INFORMATIONAL).

---

## 9. Specific Code-Level Findings

### MEDIUM-1: Unvalidated `sui_address` in `add_delegate_key` (Confirms Vuln 7)

- **Severity:** MEDIUM
- **Confidence:** 9/10
- **Lines:** 169-219, specifically line 170 (parameter) and lines 193-201 (duplicate check)
- **Description:** The `sui_address` parameter is accepted as caller input with no on-chain validation that it corresponds to the `public_key`. The contract trusts the caller to provide the correct derivation.

  **Extended attack scenario beyond Vuln 7:** Because duplicate checking only validates `public_key` uniqueness and NOT `sui_address` uniqueness, an owner can register N different 32-byte public keys all mapping to the same `sui_address`. Revoking one `public_key` does not revoke the address's SEAL access, because the same `sui_address` appears under other entries. The owner would need to discover and remove ALL entries for that address.

- **Remediation:** Derive `sui_address` on-chain from `public_key`, or require the delegate to co-sign registration. Add `sui_address` uniqueness enforcement to the duplicate check loop.

### MEDIUM-2: Delegates Bypass Key ID Validation in `seal_approve`

- **Severity:** MEDIUM
- **Confidence:** 8/10
- **Lines:** 385-389
- **Description:** The owner path requires `has_suffix(id, bcs(owner))` -- verifying the key ID binds to this specific owner's data. The delegate path performs NO validation of the `id` parameter. A delegate's authorization is checked solely by `is_delegate_address(account, caller)`.

  If a delegate is registered in multiple accounts, the lack of `id` validation means the same `seal_approve` call could succeed against any of those accounts, potentially confusing the SEAL key server about which policy was satisfied.

  **Practical impact depends on SEAL key server implementation.** If SEAL key servers verify that the `seal_approve` call was made against the specific account associated with the key ID, this is not exploitable.

- **Remediation:** Add `has_suffix(id, owner_bytes)` validation to the delegate path as well.

### LOW-1: `deactivate_account` Can Be Called on Already-Deactivated Account

- **Severity:** LOW
- **Confidence:** 10/10
- **Lines:** 266-277
- **Description:** No check for already-deactivated state. Calling it on an already-deactivated account emits a spurious `AccountDeactivated` event. Same issue for `reactivate_account` (lines 281-292).
- **Remediation:** Add idempotency guards.

### LOW-2: Deactivation Prevents Delegate Key Removal

- **Severity:** LOW
- **Confidence:** 10/10
- **Lines:** 234, 181
- **Description:** Both `add_delegate_key` and `remove_delegate_key` require `account.active == true`. If an owner deactivates because a delegate key was compromised, they cannot remove it until reactivation. Upon reactivation, the compromised delegate immediately regains SEAL access in the window between transactions.

  On Sui, the owner could use a PTB to atomically execute `reactivate_account` + `remove_delegate_key`, but this requires awareness and PTB construction.

- **Remediation:** Allow `remove_delegate_key` on deactivated accounts.

### LOW-3: No Label Length Validation

- **Severity:** LOW
- **Confidence:** 7/10
- **Lines:** 170, 203-208
- **Description:** Labels can be very long strings, consuming on-chain storage and increasing gas costs for `seal_approve` reads.
- **Remediation:** Add a maximum label length check (e.g., 256 bytes).

### INFORMATIONAL-1: `DelegateKeyRemoved` Event Missing `sui_address`

- **Lines:** 98-101, 253-256
- **Description:** The indexer must correlate with prior `DelegateKeyAdded` events to determine which address lost access.

### INFORMATIONAL-2: No `AccountDeleted` Capability

- **Description:** Accounts are permanent once created. Registry grows monotonically. Design choice, not a vulnerability.

### INFORMATIONAL-3: Missing Test Coverage

Missing tests for: non-owner remove key, non-owner reactivate, max delegate keys boundary (20), seal_approve with wrong key ID (owner path), duplicate sui_address with different public_key.

---

## 10. Silent Authorization Check Antipattern -- Dedicated Analysis

**Systematic check of every boolean computation:**

| Location | Boolean | Used In Assert? | Safe? |
|----------|---------|-----------------|-------|
| L140 | `!registry.accounts.contains(sender)` | `assert!` L140 | Yes |
| L178 | `account.owner == ctx.sender()` | `assert!` L178 | Yes |
| L181 | `account.active` | `assert!` L181 | Yes |
| L184 | `public_key.length() == ED25519_PUBLIC_KEY_LENGTH` | `assert!` L184 | Yes |
| L188 | `account.delegate_keys.length() < MAX_DELEGATE_KEYS` | `assert!` L188 | Yes |
| L197 | `delegate_keys[i].public_key != public_key` | `assert!` L197 | Yes |
| L231 | `account.owner == ctx.sender()` | `assert!` L231 | Yes |
| L234 | `account.active` | `assert!` L234 | Yes |
| L243 | `delegate_keys[i].public_key == public_key` | Controls `found`, asserted L251 | Yes |
| L251 | `found` | `assert!` L251 | Yes |
| L270 | `account.owner == ctx.sender()` | `assert!` L270 | Yes |
| L285 | `account.owner == ctx.sender()` | `assert!` L285 | Yes |
| L379 | `account.active` | `assert!` L379 | Yes |
| L385 | `is_owner` (compound) | `assert!(is_owner \|\| is_delegate)` L389 | Yes |
| L387 | `is_delegate` | `assert!(is_owner \|\| is_delegate)` L389 | Yes |

**Result: Zero instances of the Silent Authorization Check antipattern.** All 15 authorization-relevant boolean computations are properly asserted.

---

## 11. Findings Summary

| ID | Severity | Confidence | Lines | Description |
|----|----------|------------|-------|-------------|
| MEDIUM-1 | MEDIUM | 9/10 | 170, 193-201 | Unvalidated `sui_address` + no address uniqueness check (confirms Vuln 7, extended) |
| MEDIUM-2 | MEDIUM | 8/10 | 385-389 | Delegate path in `seal_approve` does not validate `id` parameter |
| LOW-1 | LOW | 10/10 | 266-277, 281-292 | Deactivate/reactivate idempotent but emit spurious events |
| LOW-2 | LOW | 10/10 | 234 | Deactivation prevents delegate key removal, creating reactivation race |
| LOW-3 | LOW | 7/10 | 170, 203-208 | No label length validation |
| INFO-1 | INFO | 10/10 | 98-101 | `DelegateKeyRemoved` event missing `sui_address` field |
| INFO-2 | INFO | 10/10 | N/A | No account deletion capability |
| INFO-3 | INFO | 8/10 | N/A | Missing test coverage for 5 scenarios |

---

## 12. Remediation Priority

| Priority | Finding | Effort | Description |
|----------|---------|--------|-------------|
| P1 | MEDIUM-2 | Low | Add `has_suffix(id, owner_bytes)` check for delegate path |
| P2 | MEDIUM-1 | Medium | Derive `sui_address` on-chain or require co-signature; add address uniqueness |
| P2 | LOW-2 | Low | Allow `remove_delegate_key` on deactivated accounts |
| P3 | LOW-1 | Low | Add idempotency guards |
| P3 | LOW-3 | Low | Add label length max (256 bytes) |
| P3 | INFO-3 | Low | Add missing test cases |

---

## 13. Positive Findings

| Area | Assessment |
|------|-----------|
| **Owner checks on all mutations** | Correct. Every entry function that modifies `MemWalAccount` asserts `owner == sender`. |
| **No silent authorization checks** | Confirmed. All 15 boolean authorization computations flow into `assert!` statements. |
| **No reentrancy** | Move's linear type system prevents reentrancy by design. |
| **Registry duplicate prevention** | Correct. `Table::contains` + `Table::add` is atomic. |
| **Max delegate keys enforced** | Correct. Strict < 20 check prevents unbounded growth. |
| **Ed25519 key length validated** | Correct. Exactly 32 bytes enforced. |
| **Deactivation freezes SEAL access** | Correct. `seal_approve` checks `active` before authorization. |
| **has_suffix implementation** | Correct. No off-by-one, no underflow, handles edge cases. |
| **Event emission** | Complete. All 5 state-changing operations emit events. |
| **Shared object model** | Architecturally sound. Required for SEAL dry_run integration. |
| **Test coverage** | Good. 23 tests covering major positive and negative paths. |
