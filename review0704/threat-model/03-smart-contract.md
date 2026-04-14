# MemWal Move Smart Contract Threat Model (STRIDE)

**Contract:** `memwal::account` -- `services/contract/sources/account.move`
**Commit:** 5bb1669
**Date:** 2026-04-02
**Scope:** On-chain account management, delegate key registry, and SEAL access authorization

---

## 1. Service Overview

### What the Contract Does

The `memwal::account` module is the on-chain access control layer for MemWal's encrypted memory system. It manages three core concerns:

1. **Account lifecycle** -- Creation of one-per-address `MemWalAccount` objects tracked by a global `AccountRegistry`, with activation/deactivation controls.
2. **Delegate key management** -- Registration and revocation of up to 20 Ed25519 delegate keys per account. Each delegate key maps a 32-byte public key to a Sui address.
3. **SEAL authorization** -- A `seal_approve` entry function called by SEAL key servers via `dry_run` to determine whether a caller (owner or delegate) may decrypt data encrypted under a given key ID.

### Shared Objects

| Object | Lines | Purpose |
|--------|-------|---------|
| `AccountRegistry` | L50-54 | Singleton. Maps `address -> ID` to prevent duplicate accounts. Created in `init()` (L118-124). |
| `MemWalAccount` | L58-68 | One per user. Stores owner, delegate_keys vector, active flag, created_at. Shared so SEAL key servers can reference it in `dry_run`. |

### Entry Functions

| Function | Lines | Mutability | Auth |
|----------|-------|------------|------|
| `create_account` | L132-161 | `&mut AccountRegistry` | Any address (one-time) |
| `add_delegate_key` | L169-220 | `&mut MemWalAccount` | Owner only, active only |
| `remove_delegate_key` | L226-257 | `&mut MemWalAccount` | Owner only, active only |
| `deactivate_account` | L266-277 | `&mut MemWalAccount` | Owner only |
| `reactivate_account` | L281-292 | `&mut MemWalAccount` | Owner only |
| `seal_approve` | L373-390 | `&MemWalAccount` (read-only) | Owner OR delegate, active only |

### Integration Points

- **SEAL key servers** call `seal_approve` via Sui `dry_run` (simulated transaction, no on-chain execution). The function must abort to deny access and succeed to grant it.
- **Rust server** (`services/server/src/auth.rs`) resolves accounts by scanning the `AccountRegistry` or using cached data, then verifies delegate key membership on-chain.
- **TypeScript sidecar** constructs SEAL key IDs using `seal_key_id()` (L396-398) and passes them to the SEAL SDK for encryption/decryption.

---

## 2. Trust Boundaries

```
+---------------------------+     +----------------------------+
|  Account Owner (Wallet)   |     |  Delegate Key Holder       |
|  - Full control of account|     |  - SEAL decrypt only       |
|  - Manages delegates      |     |  - No state mutation       |
+------------+--------------+     +-------------+--------------+
             |                                  |
             | entry fns (signed tx)            | seal_approve (dry_run)
             v                                  v
+-----------------------------------------------------------+
|              Sui Move Runtime                              |
|  memwal::account module                                   |
|  - ctx.sender() = signer identity                         |
|  - shared object access = permissionless reference        |
+-------------------+-------------------+-------------------+
                    |                   |
    +---------------v---+       +------v-----------------+
    | AccountRegistry   |       | MemWalAccount          |
    | (shared, global)  |       | (shared, per-user)     |
    +-------------------+       +------+-----------------+
                                       |
                    +------------------v-------------------+
                    | SEAL Key Servers (off-chain)         |
                    | - Call seal_approve via dry_run       |
                    | - Issue decryption shares if success  |
                    +--------------------------+-----------+
                                               |
                    +--------------------------v-----------+
                    | MemWal Rust Server (off-chain)       |
                    | - Reads on-chain account state       |
                    | - Caches in PostgreSQL                |
                    +-------------------------------------+
```

### Trust Boundary Analysis

| Boundary | Trust Model | Verification Mechanism |
|----------|-------------|----------------------|
| Owner <-> Contract | Cryptographic. `ctx.sender()` derived from transaction signature. | Sui runtime enforces signer identity. L178, L231, L270, L285 assert `owner == sender`. |
| Delegate <-> Contract | Address-based. Delegate's Sui address checked against `delegate_keys[].sui_address`. | `is_delegate_address()` (L312-322) iterates vector. No cryptographic binding between public_key and sui_address on-chain. |
| SEAL Key Servers <-> Contract | Execution-based. `seal_approve` must not abort for authorization. | SEAL servers execute `dry_run` and observe success/failure. The `id` parameter binds the request to a specific owner's data (owner path only). |
| Server Auth <-> Contract State | Eventually consistent. Server caches account state in PostgreSQL. | Server re-verifies on-chain via `AccountRegistry` scan (auth.rs strategy 2). Stale cache could grant/deny incorrectly. |

---

## 3. Data Flow Diagrams

### 3.1 Account Creation

```
User Wallet                  Sui Runtime                AccountRegistry (shared)
    |                            |                            |
    |-- create_account(reg, clk) -->                          |
    |                            |-- sender = ctx.sender()    |
    |                            |-- assert !reg.contains(sender) [L140]
    |                            |                            |
    |                            |-- new MemWalAccount{       |
    |                            |     owner: sender,         |
    |                            |     delegate_keys: [],     |
    |                            |     active: true           |
    |                            |   }                        |
    |                            |                            |
    |                            |-- reg.accounts.add(sender, id) [L153]
    |                            |-- emit AccountCreated [L155]
    |                            |-- transfer::share_object(account) [L160]
    |                            |                            |
    |<--- tx success ------------+                            |
```

### 3.2 Add Delegate Key

```
Owner Wallet            Sui Runtime              MemWalAccount (shared)
    |                       |                         |
    |-- add_delegate_key(account, pk, sui_addr, label, clk) -->
    |                       |                         |
    |                       |-- assert owner == sender [L178]
    |                       |-- assert active [L181]
    |                       |-- assert len(pk) == 32 [L184]
    |                       |-- assert delegates.len < 20 [L188]
    |                       |-- for each dk: assert dk.pk != pk [L193-201]
    |                       |                         |
    |                       |-- NO VALIDATION: sui_addr matches pk? [!]
    |                       |-- NO VALIDATION: sui_addr unique? [!]
    |                       |                         |
    |                       |-- push_back(DelegateKey{pk, sui_addr, label, ts})
    |                       |-- emit DelegateKeyAdded [L212]
    |                       |                         |
    |<--- tx success -------+                         |
```

### 3.3 Remove Delegate Key

```
Owner Wallet            Sui Runtime              MemWalAccount (shared)
    |                       |                         |
    |-- remove_delegate_key(account, pk) ------------>|
    |                       |                         |
    |                       |-- assert owner == sender [L231]
    |                       |-- assert active [L234]      <-- BLOCKS removal when deactivated
    |                       |-- iterate: find pk match [L242-249]
    |                       |-- assert found [L251]
    |                       |-- vector::remove(i) [L244]
    |                       |-- emit DelegateKeyRemoved [L253]
    |                       |                         |
    |<--- tx success -------+                         |
```

### 3.4 seal_approve -- Owner Path

```
Owner Wallet            SEAL Key Server           Sui Runtime (dry_run)    MemWalAccount
    |                       |                         |                       |
    |-- decrypt request --->|                         |                       |
    |                       |-- dry_run: seal_approve(id, account) --------->|
    |                       |                         |                       |
    |                       |                         |-- assert active [L379]
    |                       |                         |-- caller = sender [L381]
    |                       |                         |-- owner_bytes = bcs(owner) [L384]
    |                       |                         |-- is_owner = (caller==owner)
    |                       |                         |     AND has_suffix(id, owner_bytes) [L385]
    |                       |                         |-- assert is_owner [L389]
    |                       |                         |                       |
    |                       |<-- dry_run success -----+                       |
    |<-- decryption shares -|                         |                       |
```

### 3.5 seal_approve -- Delegate Path

```
Delegate (via Server)   SEAL Key Server           Sui Runtime (dry_run)    MemWalAccount
    |                       |                         |                       |
    |-- decrypt request --->|                         |                       |
    |                       |-- dry_run: seal_approve(id, account) --------->|
    |                       |                         |                       |
    |                       |                         |-- assert active [L379]
    |                       |                         |-- caller = sender [L381]
    |                       |                         |-- is_owner = false (caller != owner)
    |                       |                         |-- is_delegate = is_delegate_address(
    |                       |                         |     account, caller) [L387]
    |                       |                         |-- assert is_delegate [L389]
    |                       |                         |                       |
    |                       |                         |-- NOTE: `id` NOT validated [!]
    |                       |                         |                       |
    |                       |<-- dry_run success -----+                       |
    |<-- decryption shares -|                         |                       |
```

### 3.6 Deactivation / Reactivation

```
Owner Wallet            Sui Runtime              MemWalAccount
    |                       |                         |
    |-- deactivate_account(account) ----------------->|
    |                       |-- assert owner == sender [L270]
    |                       |-- account.active = false [L271]
    |                       |-- emit AccountDeactivated [L273]
    |                       |                         |
    |   [ account frozen: seal_approve rejects all ]  |
    |   [ add/remove delegate key blocked ]           |
    |                       |                         |
    |-- reactivate_account(account) ----------------->|
    |                       |-- assert owner == sender [L285]
    |                       |-- account.active = true [L286]
    |                       |-- emit AccountReactivated [L289]
    |                       |                         |
    |   [ ALL prior delegates immediately regain access ]
```

---

## 4. Assets

| Asset | Description | Location | Sensitivity |
|-------|-------------|----------|-------------|
| **Account ownership** | The `owner` field determines who controls the account. Immutable after creation. | L60 | CRITICAL |
| **Delegate key registry** | The `delegate_keys` vector determines who can decrypt SEAL-encrypted data. | L63 | HIGH |
| **SEAL authorization decisions** | The boolean outcome of `seal_approve` controls decryption share release. | L373-390 | CRITICAL |
| **Account active flag** | Emergency kill switch for all SEAL access. | L67 | HIGH |
| **Registry integrity** | `AccountRegistry` table enforces one-account-per-address. | L53 | MEDIUM |
| **On-chain state consistency** | Server caches on-chain state; stale cache = incorrect auth. | Off-chain | MEDIUM |

---

## 5. STRIDE Analysis

### S -- Spoofing

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| S-1 | Impersonate account owner | L178, L231, L270, L285 | All owner-gated functions check `owner == ctx.sender()`. Spoofing requires compromising the owner's private key. | **Mitigated by Sui runtime** |
| S-2 | Register fake delegate with arbitrary sui_address | L170, L203-206 | `sui_address` is caller-supplied with NO on-chain derivation from `public_key`. Creates phantom delegates. | **MEDIUM** |
| S-3 | Impersonate delegate in seal_approve | L387, L312-322 | SEAL servers set `sender` based on client identity. Requires SEAL server misconfiguration. | **LOW** |
| S-4 | Forge ctx.sender() in dry_run | L381 | External to contract; requires compromised SEAL server. | **LOW** |

### T -- Tampering

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| T-1 | Corrupt delegate_keys vector | L63, L219, L244 | Only owner-gated functions modify. Move type system prevents external mutation. | **Mitigated** |
| T-2 | Tamper with active flag | L67, L271, L286 | Only owner-gated functions modify. | **Mitigated** |
| T-3 | Tamper with AccountRegistry | L53, L153 | Only `create_account` adds entries. No deletion exists. | **Mitigated** |
| T-4 | Multiple public_keys -> same sui_address | L193-201 | Duplicate check only validates `public_key` uniqueness, NOT `sui_address`. Revoking one key does not revoke the address's SEAL access. | **MEDIUM** |
| T-5 | Manipulate `id` in delegate seal_approve | L385-389 | Delegate path completely ignores `id` parameter. | **MEDIUM** |

### R -- Repudiation

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| R-1 | Deny account creation | L155-158 | `AccountCreated` event emitted. Immutable on-chain. | **Mitigated** |
| R-2 | Deny delegate key addition | L212-217 | `DelegateKeyAdded` event with full details. | **Mitigated** |
| R-3 | Deny delegate key removal (incomplete event) | L253-256 | Missing `sui_address` in `DelegateKeyRemoved`. Indexer must correlate. | **LOW** |
| R-4 | Deny deactivation/reactivation | L273-276, L289-291 | Events emitted for both. | **Mitigated** |
| R-5 | seal_approve leaves no on-chain record | L373-390 | No event emitted. Runs via dry_run (not committed). No audit trail of decryptions. | **MEDIUM** |
| R-6 | Spurious events from idempotent calls | L266-277, L281-292 | Can call deactivate on already-deactivated account, emitting duplicates. | **LOW** |

### I -- Information Disclosure

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| I-1 | All on-chain data publicly readable | L50-68 | Shared objects readable by anyone. Labels may leak device/location info. | **LOW** |
| I-2 | delegate_keys expose organizational structure | L70-80 | Number and labels reveal connected devices/agents. | **LOW** |
| I-3 | AccountRegistry reveals all MemWal users | L50-54 | Enumerable list of all participants. Privacy concern. | **LOW** |
| I-4 | Events expose delegate key lifecycle | L86-111 | Publicly indexed events track device additions/removals. | **LOW** |

### D -- Denial of Service

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| D-1 | Shared object contention on AccountRegistry | L50-54, L132 | `create_account` takes `&mut`. One-time per user, low risk. | **LOW** |
| D-2 | Shared object contention on MemWalAccount | L58-68 | `seal_approve` uses immutable ref, no contention with mutations. | **LOW** |
| D-3 | Gas griefing via large labels | L170, L203-208 | No label length validation. Bounded by Sui tx limit and MAX_DELEGATE_KEYS=20. | **LOW** |
| D-4 | Account cannot be deleted | N/A | No `delete_account` function. Design choice. | **INFORMATIONAL** |
| D-5 | Deactivation prevents delegate removal | L234 | Creates reactivation race window for compromised keys. PTB can mitigate. | **LOW** |

### E -- Elevation of Privilege

| ID | Threat | Lines | Analysis | Risk |
|----|--------|-------|----------|------|
| E-1 | Delegate gains owner privileges | L178, L231, L270, L285 | All mutation checks `owner == sender`. | **Mitigated** |
| E-2 | Unauthorized SEAL via unvalidated sui_address | L170, L387 | Owner can register fake delegate granting SEAL access to arbitrary address. | **MEDIUM** |
| E-3 | Delegate bypasses key ID binding | L385-389 | Delegate path skips `id` validation. Could confuse SEAL servers about data scope. | **MEDIUM** |
| E-4 | Cross-account delegate access | L312-322, L387 | Address registered in multiple accounts can seal_approve against any. Combined with E-3. | **MEDIUM** |
| E-5 | Reactivation restores all delegates | L286, L289-291 | Including compromised ones. No selective re-enable. | **LOW** |

---

## 6. Attack Scenarios

### Scenario 1: Fake Delegate Registration (S-2 + E-2)

**Attacker:** Malicious/compromised account owner
**Goal:** Grant SEAL access to arbitrary Sui address without valid Ed25519 key

1. Owner calls `add_delegate_key(account, random_32_bytes, attacker_address, "fake", clock, ctx)` (L169)
2. 32-byte length check passes (L184). No derivation check exists.
3. `attacker_address` now in `delegate_keys[].sui_address`
4. Attacker calls SEAL decrypt. SEAL server dry_runs with `sender = attacker_address`
5. `seal_approve` succeeds via delegate path (L387-389)

**Impact:** HIGH -- full data access. Off-chain Ed25519 verification fails creating auth model split.
**Likelihood:** LOW (requires owner compromise)

### Scenario 2: Delegate Key ID Bypass (T-5 + E-3)

**Attacker:** Legitimate delegate in Account A
**Goal:** Decrypt data encrypted under Account B's key ID

1. Delegate registered in Account A with `sui_address = delegate_addr`
2. Constructs `key_id_B = bcs(owner_B)` for Account B
3. Requests SEAL decryption for `key_id_B`, pointing to Account A
4. SEAL server calls `seal_approve(key_id_B, account_A, {sender: delegate_addr})`
5. `seal_approve` passes: active=true, is_delegate=true, id not validated for delegates

**Impact:** CRITICAL if SEAL server doesn't independently verify key ID to account binding.
**Likelihood:** LOW-MEDIUM (depends on SEAL server implementation)

### Scenario 3: Deactivation Race Condition (D-5 + E-5)

**Attacker:** Compromised delegate key holder
**Goal:** Maintain SEAL access across deactivation/reactivation cycle

1. Owner discovers compromise, calls `deactivate_account` (L266)
2. Cannot remove compromised delegate while deactivated (L234 blocks)
3. Owner calls `reactivate_account` (L281) to restore service
4. Compromised delegate immediately regains SEAL access in window before `remove_delegate_key`
5. Automated attacker exfiltrates data in this window

**Mitigation:** PTB can atomically `reactivate + remove + deactivate` in single tx.
**Likelihood:** MEDIUM | **Impact:** MEDIUM

### Scenario 4: Phantom Delegate Persistence (T-4)

**Attacker:** Social engineers owner into registering multiple keys for same address
**Goal:** Persistent access despite apparent revocation

1. Owner registers 3 different public_keys all with `sui_address = attacker_addr`
2. Owner later removes `pk_1` thinking revocation complete
3. `attacker_addr` still appears under `pk_2` and `pk_3` entries
4. `is_delegate_address` still returns true

**Likelihood:** LOW | **Impact:** HIGH (persistent unauthorized SEAL access)

### Scenario 5: Registry Squatting

**Not exploitable.** `create_account` uses `ctx.sender()` (L137), so only the address itself can create its account.

### Scenario 6: seal_approve via Actual Transaction (Not dry_run)

**No impact.** `seal_approve` has no side effects. On-chain execution is a no-op (wasted gas for attacker).

---

## 7. Threat Matrix

| ID | Threat | Category | Likelihood | Impact | Risk |
|----|--------|----------|------------|--------|------|
| S-1 | Impersonate account owner | Spoofing | VERY LOW | CRITICAL | **LOW** |
| S-2 | Register fake delegate sui_address | Spoofing | LOW | HIGH | **MEDIUM** |
| S-3 | Impersonate delegate in seal_approve | Spoofing | LOW | HIGH | **LOW** |
| S-4 | Forge ctx.sender() in dry_run | Spoofing | VERY LOW | CRITICAL | **LOW** |
| T-1 | Corrupt delegate_keys vector | Tampering | VERY LOW | HIGH | **LOW** |
| T-2 | Tamper with active flag | Tampering | VERY LOW | HIGH | **LOW** |
| T-3 | Tamper with AccountRegistry | Tampering | VERY LOW | MEDIUM | **LOW** |
| T-4 | Multiple public_keys -> same sui_address | Tampering | LOW | HIGH | **MEDIUM** |
| T-5 | Manipulate `id` in delegate seal_approve | Tampering | MEDIUM | HIGH | **MEDIUM** |
| R-3 | Incomplete DelegateKeyRemoved event | Repudiation | LOW | LOW | **LOW** |
| R-5 | No audit trail for seal_approve | Repudiation | HIGH | MEDIUM | **MEDIUM** |
| R-6 | Spurious deactivation/reactivation events | Repudiation | LOW | LOW | **LOW** |
| I-1 | All on-chain data publicly readable | Info Disclosure | HIGH | LOW | **LOW** |
| I-2 | Delegate keys expose org structure | Info Disclosure | MEDIUM | LOW | **LOW** |
| I-3 | Registry reveals all MemWal users | Info Disclosure | HIGH | LOW | **LOW** |
| D-1 | Shared object contention (registry) | DoS | LOW | LOW | **LOW** |
| D-3 | Gas griefing via large labels | DoS | LOW | LOW | **LOW** |
| D-5 | Deactivation prevents delegate removal | DoS | MEDIUM | MEDIUM | **LOW** |
| E-2 | Unauthorized SEAL via unvalidated address | EoP | LOW | HIGH | **MEDIUM** |
| E-3 | Delegate bypasses key ID binding | EoP | LOW-MED | CRITICAL | **MEDIUM** |
| E-4 | Cross-account delegate access | EoP | LOW | HIGH | **MEDIUM** |
| E-5 | Reactivation restores all delegates | EoP | MEDIUM | MEDIUM | **LOW** |

### Risk Summary

| Risk Level | Count |
|------------|-------|
| MEDIUM | 7 (S-2, T-4, T-5, R-5, E-2, E-3, E-4) |
| LOW | 13 |
| INFORMATIONAL | 1 (D-4) |
| Mitigated | 5 (S-1, T-1, T-2, T-3, E-1, R-1, R-2, R-4) |

---

## 8. Recommendations

### P1 -- Address MEDIUM Risks

1. **Add `has_suffix(id, owner_bytes)` to delegate path** in `seal_approve` (fixes T-5, E-3, E-4)
2. **Derive `sui_address` on-chain from `public_key`** or require co-signature (fixes S-2, T-4, E-2)
3. **Add `sui_address` uniqueness check** in `add_delegate_key` (fixes T-4)

### P2 -- Improve Operational Safety

4. **Allow `remove_delegate_key` on deactivated accounts** (fixes D-5, E-5)
5. **Add idempotency guards** to `deactivate/reactivate` (fixes R-6)
6. **Add label length validation** (e.g., max 256 bytes) (fixes D-3)
7. **Include `sui_address` in `DelegateKeyRemoved` event** (fixes R-3)

### P3 -- Defense in Depth

8. **Consider emitting an event in `seal_approve`** for audit trail (addresses R-5, but requires on-chain execution not dry_run)
9. **Add missing test coverage** for edge cases (non-owner operations, max keys boundary, wrong key ID)
