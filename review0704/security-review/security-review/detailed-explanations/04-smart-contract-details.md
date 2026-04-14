# MemWal Smart Contract Security Findings -- Detailed Explanations

**Source files analyzed:**
- `services/contract/sources/account.move` (427 lines)
- `services/contract/tests/account_tests.move` (613 lines)

**Commit:** 5bb1669

---

## MEDIUM-1: Unvalidated `sui_address` in `add_delegate_key`

### What It Is

When an account owner adds a delegate key, they provide three user-controlled parameters: `public_key`, `sui_address`, and `label`. The contract validates that `public_key` is exactly 32 bytes (correct for Ed25519) and that it is not a duplicate. However, the contract never validates that `sui_address` is actually the Sui address derived from the provided `public_key`. The contract blindly trusts the caller-supplied value.

In a correct implementation, the Sui address would be derived on-chain by hashing the public key with a scheme flag byte. Instead, the contract stores whatever address the caller provides.

### Where in the Code

**File:** `services/contract/sources/account.move`

The function signature at lines 169-176 accepts `sui_address` as a plain parameter:

```move
entry fun add_delegate_key(
    account: &mut MemWalAccount,
    public_key: vector<u8>,
    sui_address: address,       // <-- caller-supplied, never validated
    label: String,
    clock: &Clock,
    ctx: &TxContext,
) {
```

The duplicate check loop at lines 192-201 only checks `public_key` uniqueness, never `sui_address` uniqueness:

```move
let mut i = 0;
let len = account.delegate_keys.length();
while (i < len) {
    assert!(
        account.delegate_keys[i].public_key != public_key,
        EDelegateKeyAlreadyExists,
    );
    i = i + 1;
};
```

The `DelegateKey` struct is then constructed at lines 203-208, storing the unvalidated `sui_address` directly:

```move
let key = DelegateKey {
    public_key,
    sui_address,      // <-- stored as-is, no derivation check
    label,
    created_at: clock.timestamp_ms(),
};
```

The `is_delegate_address` function at lines 312-322, which is the authorization check used by `seal_approve`, matches against the stored `sui_address`:

```move
public fun is_delegate_address(account: &MemWalAccount, addr: address): bool {
    let mut i = 0;
    let len = account.delegate_keys.length();
    while (i < len) {
        if (account.delegate_keys[i].sui_address == addr) {
            return true
        };
        i = i + 1;
    };
    false
}
```

### How It Could Be Exploited

**Scenario 1: Revocation-resistant delegate persistence**

1. Alice (account owner) wants to add Bob as a delegate. Bob's real public key is `PK_bob` and his real Sui address is `0xBOB`.
2. Alice calls `add_delegate_key(account, PK_bob, 0xBOB, "Bob's Key")`. This is the legitimate entry.
3. Later, Alice also adds a second key: `add_delegate_key(account, PK_fake_1, 0xBOB, "Server Key")`, where `PK_fake_1` is a different 32-byte value that does NOT actually derive to `0xBOB`. The duplicate check passes because `PK_fake_1 != PK_bob`.
4. Alice can repeat this with `PK_fake_2`, `PK_fake_3`, etc., all mapping to `0xBOB`.
5. If Alice later wants to revoke Bob's access, she removes `PK_bob`. But `is_delegate_address(account, 0xBOB)` still returns `true` because `PK_fake_1` maps to `0xBOB`.
6. Alice must discover and remove ALL entries pointing to `0xBOB` -- there is no single revocation path by address.

**Scenario 2: Phantom delegate authorization**

1. Mallory is an account owner. She wants to secretly give SEAL decryption access to her address `0xMAL` on a different account she controls.
2. On Account A (which she owns), she registers `add_delegate_key(account_a, PK_random, 0xVICTIM_DELEGATE, "normal label")`. This gives the appearance that `0xVICTIM_DELEGATE` is authorized, but the actual keypair for `PK_random` is unknown or controlled by Mallory.
3. Since `seal_approve` checks `is_delegate_address` (which only looks at the stored `sui_address`), anyone whose Sui address matches gains SEAL decryption access -- regardless of whether they hold the private key corresponding to `PK_random`.

### Impact

- **Revocation complexity:** An owner cannot revoke a delegate's SEAL access by address alone. They must enumerate all `public_key` entries and remove each one that maps to the target address. The on-chain data does not provide a convenient way to query by `sui_address`, making this error-prone.
- **Authorization mismatch:** The stored `sui_address` can point to any address, meaning the public key stored on-chain is decorative -- the actual SEAL access is determined by the `sui_address` field, which is arbitrary.
- **Indexer confusion:** Off-chain indexers that trust the `public_key -> sui_address` mapping will have incorrect data.

### Why the Severity Rating Is Correct

MEDIUM is appropriate because:
- The vulnerability requires the account owner to be the one making the mistake or acting maliciously with their own account. An external attacker cannot exploit this without owning the account.
- The practical impact is limited to making revocation unreliable, not granting unauthorized access to external parties.
- It does not lead to direct fund loss, but it does undermine a core security property (reliable delegate revocation).
- It is not HIGH because the owner is the only one who can add delegates, so the blast radius is confined to that owner's account.

### Remediation

**Option A: Derive `sui_address` on-chain** (preferred)

Remove the `sui_address` parameter entirely and compute it from the public key. Sui addresses for Ed25519 keys are derived as `blake2b256(0x00 || public_key)[0..32]`. If Move has access to a blake2b256 hash function, the derivation can be done on-chain:

```move
entry fun add_delegate_key(
    account: &mut MemWalAccount,
    public_key: vector<u8>,
    // sui_address parameter REMOVED
    label: String,
    clock: &Clock,
    ctx: &TxContext,
) {
    // ... existing checks ...

    // Derive sui_address on-chain
    let mut preimage = vector::singleton(0x00u8); // Ed25519 scheme flag
    vector::append(&mut preimage, public_key);
    let sui_address = address::from_bytes(hash::blake2b256(&preimage));

    let key = DelegateKey {
        public_key,
        sui_address,  // now derived, not caller-supplied
        label,
        created_at: clock.timestamp_ms(),
    };
    // ...
}
```

**Option B: Add `sui_address` uniqueness enforcement**

If on-chain derivation is not feasible, at minimum add a uniqueness check to the duplicate loop:

```move
while (i < len) {
    assert!(
        account.delegate_keys[i].public_key != public_key,
        EDelegateKeyAlreadyExists,
    );
    assert!(
        account.delegate_keys[i].sui_address != sui_address,
        EDelegateKeyAlreadyExists,  // or a new error code like EDelegateAddressAlreadyExists
    );
    i = i + 1;
};
```

**Option C: Require delegate co-signature**

Require the delegate to co-sign the registration transaction, proving they control the private key corresponding to `public_key` and that `sui_address` is correct. This would change the function to require the delegate to be the transaction sender or to provide a signature.

---

## MEDIUM-2: Delegates Bypass Key ID Validation in `seal_approve`

### What It Is

The `seal_approve` function has two authorization paths: the owner path and the delegate path. When the owner calls `seal_approve`, the function checks that the `id` parameter (the SEAL key ID) ends with the BCS-encoded owner address -- this binds the decryption request to a specific owner's data. When a delegate calls `seal_approve`, the function only checks that the caller's Sui address is in the `delegate_keys` list. It does NOT validate the `id` parameter at all for the delegate path. This means a delegate could potentially pass any `id` value and the contract would authorize the decryption.

### Where in the Code

**File:** `services/contract/sources/account.move`, lines 373-390:

```move
entry fun seal_approve(
    id: vector<u8>,
    account: &MemWalAccount,
    ctx: &TxContext,
) {
    // Account must be active
    assert!(account.active, EAccountDeactivated);          // line 379

    let caller = ctx.sender();                              // line 381

    // Owner check: key ID must end with BCS(owner) and caller must be the owner
    let owner_bytes = sui::bcs::to_bytes(&account.owner);   // line 384
    let is_owner = (caller == account.owner) && has_suffix(&id, &owner_bytes);  // line 385
    // Delegate key holders can decrypt
    let is_delegate = is_delegate_address(account, caller);  // line 387

    assert!(is_owner || is_delegate, ENoAccess);             // line 389
}
```

The critical asymmetry is on line 385 vs line 387:
- **Owner path (line 385):** `(caller == account.owner) && has_suffix(&id, &owner_bytes)` -- two checks
- **Delegate path (line 387):** `is_delegate_address(account, caller)` -- one check, `id` is ignored

### How It Could Be Exploited

1. Alice owns Account A. Bob is registered as a delegate in Account A. Carol owns Account C. Bob is also registered as a delegate in Account C.
2. Bob wants to decrypt data that was encrypted under Account A's SEAL key ID.
3. Bob calls `seal_approve(id_for_account_A, account_C, ctx)` where he passes Account C's object but Account A's key ID.
4. The contract checks: `is_delegate_address(account_C, bob_address)` -- this returns `true` because Bob is a delegate of Account C.
5. The contract does NOT check whether `id_for_account_A` has any relationship to Account C.
6. The SEAL key server sees that `seal_approve` succeeded and may release the decryption key for Account A's data.

Whether this is actually exploitable depends on the SEAL key server's implementation:
- If the SEAL key server verifies that the `account` object passed to `seal_approve` is the correct account for the requested key ID, this attack fails at the server level.
- If the SEAL key server only checks that `seal_approve` did not abort, the attack succeeds.

### Impact

- **Cross-account decryption:** A delegate registered in multiple accounts could potentially decrypt data belonging to any of those accounts, even if they were only intended to have access to one.
- **Policy confusion:** The SEAL key server may be tricked into releasing keys for an account that did not actually authorize the request.
- **Trust boundary violation:** The purpose of binding the key ID to the owner address (the `has_suffix` check) is to ensure that decryption is scoped to the correct account. Bypassing this for delegates removes that scoping.

### Why the Severity Rating Is Correct

MEDIUM is appropriate because:
- The practical exploitability depends on the SEAL key server implementation. If the server independently validates the account-to-key-ID binding, this is not exploitable. The confidence is rated 8/10 (not 10/10) for this reason.
- The attacker must already be a registered delegate in at least one account, limiting the attack surface.
- It does not allow completely unauthorized access -- the attacker must have some level of delegated trust.
- It is not LOW because the potential impact (cross-account data decryption) is significant if the SEAL server does not have additional validation.

### Remediation

Add the `has_suffix` check to the delegate path as well. This ensures the `id` parameter is always validated against the account's owner, regardless of who is calling:

```move
entry fun seal_approve(
    id: vector<u8>,
    account: &MemWalAccount,
    ctx: &TxContext,
) {
    assert!(account.active, EAccountDeactivated);

    let caller = ctx.sender();
    let owner_bytes = sui::bcs::to_bytes(&account.owner);

    // BOTH paths now validate id against this account's owner
    let valid_id = has_suffix(&id, &owner_bytes);

    let is_owner = (caller == account.owner) && valid_id;
    let is_delegate = is_delegate_address(account, caller) && valid_id;

    assert!(is_owner || is_delegate, ENoAccess);
}
```

This is a low-effort, high-value fix. It adds a single boolean conjunction and ensures that delegates can only authorize decryption for the specific account they are calling `seal_approve` on.

---

## LOW-1: `deactivate_account` Can Be Called on Already-Deactivated Account

### What It Is

The `deactivate_account` and `reactivate_account` functions do not check whether the account is already in the target state before performing the state change. Calling `deactivate_account` on an already-deactivated account succeeds and emits a spurious `AccountDeactivated` event. The same applies to `reactivate_account` on an already-active account.

### Where in the Code

**File:** `services/contract/sources/account.move`

`deactivate_account` at lines 266-277:

```move
entry fun deactivate_account(
    account: &mut MemWalAccount,
    ctx: &TxContext,
) {
    assert!(account.owner == ctx.sender(), ENotOwner);  // line 270
    account.active = false;                              // line 271 -- no check if already false

    event::emit(AccountDeactivated {                     // line 273 -- emitted even if redundant
        account_id: object::id(account),
        owner: account.owner,
    });
}
```

`reactivate_account` at lines 281-292:

```move
entry fun reactivate_account(
    account: &mut MemWalAccount,
    ctx: &TxContext,
) {
    assert!(account.owner == ctx.sender(), ENotOwner);  // line 285
    account.active = true;                               // line 286 -- no check if already true

    event::emit(AccountReactivated {                     // line 288 -- emitted even if redundant
        account_id: object::id(account),
        owner: account.owner,
    });
}
```

### How It Could Be Exploited

This is not directly exploitable for unauthorized access. The impact is operational:

1. An owner (or a script acting on behalf of the owner) calls `deactivate_account` twice.
2. Both calls succeed. Two `AccountDeactivated` events are emitted.
3. Off-chain indexers or monitoring systems that track account state via events may become confused. They may log two deactivation events without an intervening reactivation, leading to incorrect state tracking.
4. Similarly, calling `reactivate_account` on an already-active account emits a spurious `AccountReactivated` event. An alerting system that triggers on reactivation events would fire a false alarm.

### Impact

- **Event log pollution:** Indexers and monitoring dashboards that rely on events to track account state may show incorrect or misleading information.
- **Gas waste:** The caller pays gas for a no-op state change.
- **No security impact:** The actual on-chain state is correct regardless (setting `false` to `false` is a no-op).

### Why the Severity Rating Is Correct

LOW is appropriate because:
- There is no security impact -- no unauthorized access, no state corruption, no fund loss.
- The issue is purely operational (event accuracy and gas efficiency).
- It is not INFORMATIONAL because spurious events can cause real confusion in production monitoring and indexer systems, which is a tangible operational cost.

### Remediation

Add idempotency guards to both functions:

```move
entry fun deactivate_account(
    account: &mut MemWalAccount,
    ctx: &TxContext,
) {
    assert!(account.owner == ctx.sender(), ENotOwner);
    assert!(account.active, EAccountDeactivated);  // NEW: prevent redundant deactivation
    account.active = false;

    event::emit(AccountDeactivated {
        account_id: object::id(account),
        owner: account.owner,
    });
}

entry fun reactivate_account(
    account: &mut MemWalAccount,
    ctx: &TxContext,
) {
    assert!(account.owner == ctx.sender(), ENotOwner);
    assert!(!account.active, EAccountAlreadyActive);  // NEW: prevent redundant reactivation
    account.active = true;

    event::emit(AccountReactivated {
        account_id: object::id(account),
        owner: account.owner,
    });
}
```

A new error code `EAccountAlreadyActive` would be needed, or the existing `EAccountDeactivated` could be reused contextually.

---

## LOW-2: Deactivation Prevents Delegate Key Removal (Race Condition on Reactivation)

### What It Is

Both `add_delegate_key` and `remove_delegate_key` require the account to be active (`account.active == true`). This means that when an owner deactivates their account (e.g., because a delegate key was compromised), they cannot remove the compromised key until they reactivate the account. The problem is that reactivation immediately restores SEAL access for ALL delegates, including the compromised one. There is a race window between reactivation and key removal where the compromised delegate has access.

### Where in the Code

**File:** `services/contract/sources/account.move`

The active check in `remove_delegate_key` at line 234:

```move
entry fun remove_delegate_key(
    account: &mut MemWalAccount,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    assert!(account.owner == ctx.sender(), ENotOwner);      // line 231
    assert!(account.active, EAccountDeactivated);            // line 234 -- blocks removal when deactivated
    // ...
}
```

The same check in `add_delegate_key` at line 181:

```move
assert!(account.active, EAccountDeactivated);                // line 181
```

When reactivation occurs at line 286:

```move
account.active = true;                                       // line 286 -- ALL delegates immediately regain access
```

This is confirmed by the test at lines 456-487 in `account_tests.move`:

```move
#[test]
#[expected_failure(abort_code = account::EAccountDeactivated)]
fun test_deactivated_blocks_remove_key() {
    // ... adds a key, deactivates, then tries to remove -- correctly fails
}
```

### How It Could Be Exploited

1. Alice has an account with delegate keys for Bob (legitimate) and Carol (compromised).
2. Alice discovers Carol's key is compromised and immediately calls `deactivate_account`. SEAL access is now denied for everyone -- good.
3. Alice wants to remove Carol's key, but `remove_delegate_key` requires `active == true`. The call fails with `EAccountDeactivated`.
4. Alice must first call `reactivate_account`, which sets `active = true`.
5. The moment `reactivate_account` is executed, `seal_approve` will succeed for Carol again. If Carol (or an attacker with Carol's key) is monitoring the chain and has a SEAL decryption request ready, they can call `seal_approve` in the same block or immediately after.
6. Alice then calls `remove_delegate_key` to remove Carol's key, but Carol may have already decrypted data in the window.

**Mitigation via PTB:** On Sui, Alice could construct a Programmable Transaction Block (PTB) that atomically executes `reactivate_account` + `remove_delegate_key` in a single transaction. However:
- This requires the owner to know about PTBs and construct one correctly.
- Standard wallet UIs may not support this easily.
- It is an unnecessary foot-gun that the contract could eliminate.

### Impact

- **Temporary re-exposure to compromised delegate:** The compromised delegate regains SEAL access during the reactivation-to-removal window.
- **Operational complexity:** The owner must use PTBs or accept a risk window, adding complexity to what should be a simple revocation flow.

### Why the Severity Rating Is Correct

LOW is appropriate because:
- The vulnerability requires a specific sequence of events (compromise + deactivation + reactivation).
- There is a workaround (PTB atomic execution) that fully mitigates the issue.
- The exposure window is small (between reactivation and removal transactions).
- It is not MEDIUM because the workaround exists and the attack requires monitoring the chain in real-time.

### Remediation

Allow `remove_delegate_key` to work on deactivated accounts. Remove the active check from `remove_delegate_key` only (keep it for `add_delegate_key` since adding keys to a frozen account is a different security concern):

```move
entry fun remove_delegate_key(
    account: &mut MemWalAccount,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    assert!(account.owner == ctx.sender(), ENotOwner);
    // REMOVED: assert!(account.active, EAccountDeactivated);
    // Rationale: owners must be able to remove compromised keys while deactivated

    let mut found = false;
    let mut i = 0;
    let len = account.delegate_keys.length();
    while (i < len) {
        if (account.delegate_keys[i].public_key == public_key) {
            account.delegate_keys.remove(i);
            found = true;
            break
        };
        i = i + 1;
    };
    assert!(found, EDelegateKeyNotFound);

    event::emit(DelegateKeyRemoved {
        account_id: object::id(account),
        public_key,
    });
}
```

The corresponding test `test_deactivated_blocks_remove_key` (lines 456-487 in `account_tests.move`) would need to be updated to expect success instead of failure.

---

## LOW-3: No Label Length Validation

### What It Is

The `label` parameter in `add_delegate_key` is a `String` with no maximum length enforcement. While Move's `String` type and Sui's transaction size limit (128KB) provide an upper bound, the contract itself does not enforce a reasonable maximum. This allows delegate keys to carry arbitrarily large labels, consuming on-chain storage and increasing gas costs when the account is read.

### Where in the Code

**File:** `services/contract/sources/account.move`

The `label` parameter at line 173:

```move
entry fun add_delegate_key(
    account: &mut MemWalAccount,
    public_key: vector<u8>,
    sui_address: address,
    label: String,              // <-- no length validation
    clock: &Clock,
    ctx: &TxContext,
) {
```

The label is stored directly in the `DelegateKey` struct at lines 203-208:

```move
let key = DelegateKey {
    public_key,
    sui_address,
    label,                      // <-- stored as-is
    created_at: clock.timestamp_ms(),
};
```

The `DelegateKey` struct definition at lines 71-80 shows the label field:

```move
public struct DelegateKey has store, copy, drop {
    public_key: vector<u8>,
    sui_address: address,
    label: String,              // <-- no constraints
    created_at: u64,
}
```

There is no validation between the parameter declaration and the struct construction. Compare this to `public_key`, which has an explicit length check at line 184:

```move
assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);
```

No analogous check exists for `label`.

### How It Could Be Exploited

1. An account owner calls `add_delegate_key` with a label that is tens of thousands of bytes long (up to Sui's 128KB transaction limit).
2. This label is stored on-chain in the `MemWalAccount` object.
3. Every subsequent read of the `MemWalAccount` object (including `seal_approve` calls by SEAL key servers) must deserialize this oversized object, increasing gas costs.
4. With up to 20 delegate keys (the `MAX_DELEGATE_KEYS` limit), each carrying a large label, the `MemWalAccount` object could grow to several hundred KB.
5. This increases the cost of every `seal_approve` call, which affects both the owner and all delegates.

The attack is self-inflicted (the owner harms their own account), so the practical risk is limited. However, it could be used for griefing if the account is later transferred or if a third-party protocol relies on reading this account.

### Impact

- **Storage bloat:** Unnecessarily large on-chain objects.
- **Increased gas costs:** Every operation that reads the `MemWalAccount` object pays more gas.
- **No direct security impact:** This is a resource abuse issue, not an access control issue.

### Why the Severity Rating Is Correct

LOW is appropriate because:
- The impact is limited to gas costs and storage efficiency.
- The attack is self-inflicted -- only the account owner can add delegate keys.
- Sui's transaction size limit provides a natural upper bound.
- It is not INFORMATIONAL because excessive storage can have real gas cost implications for legitimate operations.
- The confidence is 7/10 because the practical impact depends on how SEAL key servers handle large objects.

### Remediation

Add a constant and a check:

```move
const MAX_LABEL_LENGTH: u64 = 256;
const ELabelTooLong: u64 = 7;

// In add_delegate_key, after the existing validations:
assert!(label.length() <= MAX_LABEL_LENGTH, ELabelTooLong);
```

256 bytes is generous for a human-readable label like "MacBook Pro" or "Work Server" while preventing abuse.

---

## INFO-1: `DelegateKeyRemoved` Event Missing `sui_address`

### What It Is

When a delegate key is removed, the emitted `DelegateKeyRemoved` event contains the `account_id` and `public_key` but does not include the `sui_address` of the removed delegate. Off-chain systems that need to know which Sui address lost access must correlate this event with a prior `DelegateKeyAdded` event to find the address.

### Where in the Code

**File:** `services/contract/sources/account.move`

The `DelegateKeyRemoved` event struct at lines 98-101:

```move
public struct DelegateKeyRemoved has copy, drop {
    account_id: ID,
    public_key: vector<u8>,
    // NOTE: sui_address is absent
}
```

Compare with `DelegateKeyAdded` at lines 91-96, which includes `sui_address`:

```move
public struct DelegateKeyAdded has copy, drop {
    account_id: ID,
    public_key: vector<u8>,
    sui_address: address,       // <-- present here
    label: String,
}
```

The event emission at lines 253-256:

```move
event::emit(DelegateKeyRemoved {
    account_id: object::id(account),
    public_key,
    // sui_address not included
});
```

At the time of emission (inside `remove_delegate_key`), the `sui_address` was available in the removed `DelegateKey` struct, but the code discards it. The `vector::remove(i)` at line 244 returns the removed element, but the return value is not captured:

```move
if (account.delegate_keys[i].public_key == public_key) {
    account.delegate_keys.remove(i);   // returns DelegateKey, but it's dropped
    found = true;
    break
};
```

### How It Could Be Exploited

This is not exploitable. It is an information completeness issue for off-chain systems.

### Impact

- **Indexer complexity:** Off-chain indexers must maintain a mapping of `public_key -> sui_address` from `DelegateKeyAdded` events and look up the address when processing `DelegateKeyRemoved` events.
- **Audit trail gaps:** If a `DelegateKeyAdded` event was missed or the indexer started after the key was added, the removal event alone does not indicate which address lost access.

### Why the Severity Rating Is Correct

INFORMATIONAL is appropriate because there is no security impact. The data is available via event correlation; it is just inconvenient. This is a quality-of-life improvement for indexer developers.

### Remediation

Capture the removed `DelegateKey` and include its `sui_address` in the event:

```move
if (account.delegate_keys[i].public_key == public_key) {
    let removed_key = account.delegate_keys.remove(i);
    found = true;

    event::emit(DelegateKeyRemoved {
        account_id: object::id(account),
        public_key,
        sui_address: removed_key.sui_address,  // NEW
    });
    break
};
```

Update the event struct:

```move
public struct DelegateKeyRemoved has copy, drop {
    account_id: ID,
    public_key: vector<u8>,
    sui_address: address,   // NEW
}
```

Note: This changes the event emission location from after the loop to inside the loop. The `event::emit` call at lines 253-256 would be removed and replaced with the one inside the loop above.

---

## INFO-2: No Account Deletion Capability

### What It Is

Once a `MemWalAccount` is created and registered in the `AccountRegistry`, there is no way to delete it. The registry's `Table<address, ID>` grows monotonically. An owner can deactivate their account, but the on-chain object and the registry entry persist forever.

### Where in the Code

**File:** `services/contract/sources/account.move`

The registry is a `Table` at lines 50-54:

```move
public struct AccountRegistry has key {
    id: UID,
    accounts: Table<address, ID>,
}
```

The only function that writes to the registry is `create_account` at line 153:

```move
registry.accounts.add(sender, account_id);
```

There is no function anywhere in the module that calls `registry.accounts.remove(...)` or destroys a `MemWalAccount` object. The module has these entry functions:
- `create_account` -- adds to registry
- `add_delegate_key` -- modifies account
- `remove_delegate_key` -- modifies account
- `deactivate_account` -- modifies account
- `reactivate_account` -- modifies account
- `seal_approve` -- read-only

None of these remove from the registry or destroy the account.

### How It Could Be Exploited

This is not exploitable. It is a design limitation.

### Impact

- **Storage growth:** The registry and all account objects persist on-chain indefinitely. On Sui, storage has a rebate model -- destroying objects returns storage fees. Without deletion, these fees are locked forever.
- **Address lock-in:** An address that created an account can never create a new one (due to the duplicate check at line 140). If the owner wants a fresh start, they must use a new Sui address.
- **No GDPR-style right to erasure:** While not legally required for smart contracts, the inability to delete data may be a concern for some users.

### Why the Severity Rating Is Correct

INFORMATIONAL is appropriate because:
- This is a deliberate design choice, not an oversight. The review notes it is "not a vulnerability."
- Account permanence is a common pattern in smart contracts.
- The practical impact is minimal -- storage costs on Sui are low, and deactivation provides functional equivalence to deletion for access control purposes.

### Remediation

If account deletion is desired, add a `delete_account` function:

```move
entry fun delete_account(
    registry: &mut AccountRegistry,
    account: MemWalAccount,      // takes ownership (by value)
    ctx: &TxContext,
) {
    assert!(account.owner == ctx.sender(), ENotOwner);
    assert!(account.delegate_keys.length() == 0, EDelegateKeysExist);  // require all keys removed first

    // Remove from registry
    registry.accounts.remove(account.owner);

    // Destroy the account object
    let MemWalAccount { id, owner: _, delegate_keys: _, created_at: _, active: _ } = account;
    object::delete(id);

    // Event emission for indexers
    // event::emit(AccountDeleted { ... });
}
```

Note: This is complex because `MemWalAccount` is a shared object. Shared objects on Sui cannot be taken by value in entry functions in the standard way. A different approach (e.g., a two-phase delete using a `DeletionCap` or wrapping) may be needed. This complexity is one reason the current design omits deletion.

---

## INFO-3: Missing Test Coverage for 5 Scenarios

### What It Is

The test suite in `account_tests.move` has 23 tests covering the major positive and negative paths. However, 5 specific scenarios are not covered by any test. These gaps could hide bugs in edge cases.

### Where in the Code

**File:** `services/contract/tests/account_tests.move` (613 lines, 23 tests)

The missing test scenarios are:

**1. Non-owner attempting to remove a key:**
The tests include `test_non_owner_cannot_add_key` (line 283) and `test_non_owner_cannot_deactivate` (line 418), but there is no `test_non_owner_cannot_remove_key`. While the code clearly has the check at line 231 (`assert!(account.owner == ctx.sender(), ENotOwner)`), this path is untested.

**2. Non-owner attempting to reactivate:**
The tests include `test_non_owner_cannot_deactivate` (line 418) but there is no corresponding test for reactivation. The check is at line 285.

**3. Maximum delegate keys boundary (20):**
No test attempts to add exactly 20 keys (the maximum) or 21 keys (which should fail). The constant `MAX_DELEGATE_KEYS` at line 40 is set to 20, and the check is at line 187-189, but the boundary is never tested.

**4. `seal_approve` with wrong key ID (owner path):**
The test `test_seal_approve_owner` (line 520) and `test_seal_approve_owner_with_prefix` (line 537) test the success case. But no test verifies that `seal_approve` fails when the owner provides an `id` that does NOT end with their BCS-encoded address. This is important because it validates the `has_suffix` check on line 385.

**5. Duplicate `sui_address` with different `public_key`:**
No test verifies what happens when two delegate keys are added with different `public_key` values but the same `sui_address`. As noted in MEDIUM-1, this is currently allowed. A test should document this behavior (whether it is intentional or a bug).

### How It Could Be Exploited

Missing tests do not create vulnerabilities directly. However, they increase the risk that future code changes introduce regressions in these untested paths.

### Impact

- **Regression risk:** Without tests, future refactoring could break these code paths without detection.
- **Specification gap:** Tests serve as documentation of intended behavior. Missing tests mean the intended behavior for these edge cases is ambiguous.

### Why the Severity Rating Is Correct

INFORMATIONAL is appropriate because:
- The code for these scenarios is straightforward and appears correct upon manual review.
- Missing tests are a code quality issue, not a security vulnerability.
- The existing 23 tests cover the critical paths well.

### Remediation

Add the following 5 tests to `services/contract/tests/account_tests.move`:

```move
#[test]
#[expected_failure(abort_code = account::ENotOwner)]
fun test_non_owner_cannot_remove_key() {
    let mut scenario = test_scenario::begin(OWNER);
    setup_with_account(&mut scenario);

    // Owner adds a key
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<MemWalAccount>();
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let clock = clock::create_for_testing(scenario.ctx());
        account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Key"), &clock, scenario.ctx());
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(account);
    };

    // Non-owner tries to remove it
    scenario.next_tx(OTHER);
    {
        let mut account = scenario.take_shared<MemWalAccount>();
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        account::remove_delegate_key(&mut account, pk, scenario.ctx());
        test_scenario::return_shared(account);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = account::ENotOwner)]
fun test_non_owner_cannot_reactivate() {
    let mut scenario = test_scenario::begin(OWNER);
    setup_with_account(&mut scenario);

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<MemWalAccount>();
        account::deactivate_account(&mut account, scenario.ctx());
        test_scenario::return_shared(account);
    };

    scenario.next_tx(OTHER);
    {
        let mut account = scenario.take_shared<MemWalAccount>();
        account::reactivate_account(&mut account, scenario.ctx());
        test_scenario::return_shared(account);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = account::ETooManyDelegateKeys)]
fun test_max_delegate_keys_boundary() {
    let mut scenario = test_scenario::begin(OWNER);
    setup_with_account(&mut scenario);

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<MemWalAccount>();
        let clock = clock::create_for_testing(scenario.ctx());
        let mut i = 0u64;
        while (i < 21) {  // 21st key should fail
            let mut pk = vector::empty<u8>();
            // Create unique 32-byte keys by varying the first byte
            pk.push_back((i as u8));
            let mut j = 1;
            while (j < 32) { pk.push_back(0xaa); j = j + 1; };
            let addr = @0x1;  // address doesn't matter for this test
            account::add_delegate_key(&mut account, pk, addr, string::utf8(b"Key"), &clock, scenario.ctx());
            i = i + 1;
        };
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(account);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = account::ENoAccess)]
fun test_seal_approve_owner_wrong_id() {
    let mut scenario = test_scenario::begin(OWNER);
    setup_with_account(&mut scenario);

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<MemWalAccount>();
        // Use OTHER's bytes instead of OWNER's -- should fail
        let wrong_id = sui::bcs::to_bytes(&OTHER);
        account::seal_approve(wrong_id, &account, scenario.ctx());
        test_scenario::return_shared(account);
    };

    scenario.end();
}

#[test]
fun test_duplicate_sui_address_different_pubkey() {
    let mut scenario = test_scenario::begin(OWNER);
    setup_with_account(&mut scenario);

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<MemWalAccount>();
        let pk1 = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let pk2 = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let clock = clock::create_for_testing(scenario.ctx());

        // Both keys map to the same sui_address -- currently allowed
        account::add_delegate_key(&mut account, pk1, DELEGATE_ADDR, string::utf8(b"Key 1"), &clock, scenario.ctx());
        account::add_delegate_key(&mut account, pk2, DELEGATE_ADDR, string::utf8(b"Key 2"), &clock, scenario.ctx());

        assert!(account.delegate_count() == 2);
        assert!(account.is_delegate_address(DELEGATE_ADDR));

        // Remove one key -- address should still be a delegate via the other key
        account::remove_delegate_key(&mut account, pk1, scenario.ctx());
        assert!(account.delegate_count() == 1);
        assert!(account.is_delegate_address(DELEGATE_ADDR));  // still true!

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(account);
    };

    scenario.end();
}
```

These tests would be added to the existing file at `services/contract/tests/account_tests.move`, before the closing `}` of the module.
