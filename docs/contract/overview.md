---
title: "Smart Contract Overview"
description: >-
  Overview of the Walrus Memory smart contract (memwal::account) deployed on Sui, covering the onchain account model, key objects (AccountRegistry, MemWalAccount, DelegateKey), entry and view functions, events, and error codes.
keywords:
  - Walrus Memory
  - MemWal
  - smart contract
  - Move module
  - Sui
  - onchain account
goal:
  description: Map the MemWalAccount object model, identify the key onchain functions for creating and managing accounts, and explain how identity and access are enforced at the contract layer.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - "What does the Walrus Memory smart contract manage?"
  - "What are the key objects in the MemWal onchain account model?"
  - "What entry functions does the Walrus Memory Move module expose?"
answer: >-
  The Walrus Memory smart contract (memwal::account) is a Move module on Sui that manages onchain identity, delegate key authorization, SEAL access control, and account lifecycle (activation/deactivation). Key objects include AccountRegistry (prevents duplicate accounts), MemWalAccount (stores owner, delegate keys, and active status), and DelegateKey (Ed25519 public key with label and derived Sui address).
---

The smart contract (`memwal::account`) defines the onchain account model for Walrus Memory. It is a Move module deployed on Sui.

## Network IDs

These are the onchain IDs for the current public Walrus Memory deployments:

### Staging (Testnet)

```env
SUI_NETWORK=testnet
MEMWAL_PACKAGE_ID=0x0a625e2db2af6f591a4c80a3d8551ddf11656089cc3a20c5e9e7f8fb75b9265c
MEMWAL_REGISTRY_ID=0x736aef9906798fca4460490ccdf8e8502ef170122dc26ecae32111b78c6b42dd
```

### Production (Mainnet)

```env
SUI_NETWORK=mainnet
MEMWAL_PACKAGE_ID=0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6
MEMWAL_REGISTRY_ID=0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd
```

For relayer setup and environment variable usage, see [Self-Hosting](/relayer/self-hosting) and [Environment Variables](/reference/environment-variables).

## What It Manages

- **Ownership** — who owns a Walrus Memory account
- **Delegate keys** — which Ed25519 keys are authorized to act through the relayer
- **SEAL access control** — who can decrypt encrypted memories via `seal_approve`
- **Account lifecycle** — activation and deactivation (freeze/unfreeze)

The contract does not store memory content — it only manages identity, permissions, and access control.

## Key Objects

### `AccountRegistry`

A shared object created at module publish time. It tracks all MemWalAccount objects and prevents duplicate account creation (one account per Sui address).

### `MemWalAccount`

A shared object representing a single user's account. It stores:

| Field               | Type                  | Description                                            |
| ------------------- | --------------------- | ------------------------------------------------------ |
| `owner`             | `address`             | The Sui wallet address that owns this account          |
| `delegate_keys`     | `vector<DelegateKey>` | List of authorized Ed25519 delegate keys               |
| `created_at`        | `u64`                 | Timestamp when the account was created (epoch ms)      |
| `active`            | `bool`                | Whether the account is active (false = frozen)         |
| `admin_quarantined` | `bool`                | Whether AdminCap containment blocks owner reactivation |

### `DelegateKey`

A struct stored inside `MemWalAccount.delegate_keys`:

| Field         | Type         | Description                                 |
| ------------- | ------------ | ------------------------------------------- |
| `public_key`  | `vector<u8>` | Ed25519 public key (32 bytes)               |
| `sui_address` | `address`    | Sui address derived from this Ed25519 key   |
| `label`       | `String`     | Human-readable label (e.g., "MacBook Pro")  |
| `created_at`  | `u64`        | Timestamp when the key was added (epoch ms) |

## Limits

- **Maximum delegate keys per account**: 20

## Error Codes

| Code | Name                            | Description                                               |
| ---- | ------------------------------- | --------------------------------------------------------- |
| 0    | `EDelegateKeyAlreadyExists`     | Key already registered in this account                    |
| 1    | `EDelegateKeyNotFound`          | Key not found when trying to remove                       |
| 2    | `ETooManyDelegateKeys`          | Account has reached the 20-key limit                      |
| 3    | `EAccountAlreadyExists`         | Address already has an account                            |
| 4    | `ENotOwner`                     | Caller is not the account owner                           |
| 5    | `EInvalidPublicKeyLength`       | Public key is not exactly 32 bytes                        |
| 6    | `EAccountDeactivated`           | Account is frozen — operation denied                      |
| 7    | `EWrongVersion`                 | Registry behavior version does not match this package     |
| 12   | `EMigrationFinalized`           | The one-way migration latch is already closed             |
| 13   | `ENotLegacyImported`            | Import-only operation targeted a native account           |
| 14   | `EInvalidMigrationProof`        | Account or delegate is absent from the pinned manifest    |
| 15   | `EAllowlistRootAlreadyPinned`   | A root must be corrected with `repin_allowlist_root`      |
| 16   | `EAllowlistRootMismatch`        | MigrationCap root differs from the pinned root            |
| 17   | `EAllowlistRootNotPinned`       | Migration cannot begin or finalize before root pinning    |
| 18   | `EMigrationInProgress`          | Owner mutation is blocked until migration finalizes       |
| 19   | retired                         | Previously blocked delegate hydration after quarantine    |
| 20   | `EAccountQuarantined`           | Admin quarantine blocks owner reactivation                |
| 21   | `EMigrationImportCountMismatch` | Imported totals differ from the pinned manifest totals    |
| 22   | `EInvalidCompletionEvidence`    | Finalization digest or evidence lifetime is invalid       |
| 23   | `ECompletionEvidenceExpired`    | Completion evidence expired before execution              |
| 24   | `EAllowlistRepinAfterImport`    | Root/counts cannot be changed after any import            |
| 100  | `ENoAccess`                     | SEAL access denied — caller is neither owner nor delegate |

## Entry Functions

| Function                                                         | Description                                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `create_account(registry, clock)`                                | Create a new MemWalAccount (one per address)                                                             |
| `add_delegate_key(account, registry, public_key, label, clock)`  | Add a delegate key; its Sui address is derived from the public key (owner only)                          |
| `remove_delegate_key(account, registry, public_key)`             | Remove a delegate key (owner only)                                                                       |
| `deactivate_account(account, registry)`                          | Freeze the account — SEAL access and new delegate keys denied; removals remain available (owner only)    |
| `reactivate_account(account, registry)`                          | Unfreeze the account unless Admin quarantine is active (owner only)                                      |
| `admin_deactivate_account(admin, account)`                       | Quarantine and freeze a compromised account (AdminCap only)                                              |
| `admin_clear_quarantine(admin, registry, account)`               | Release quarantine through the current registry version without reactivating the account (AdminCap only) |
| `pin_allowlist_root(admin, registry, root, accounts, delegates)` | One-time commitment to the reviewed migration manifest and exact import totals                           |
| `mint_migration_cap(admin, registry, root)`                      | Create proof-bound import authority for a migration worker                                               |
| `legacy_import_account(cap, registry, ...)`                      | Import one manifest-proven V1 account without an owner signature                                         |
| `legacy_import_delegate_key(cap, registry, account, ...)`        | Hydrate one manifest-proven V1 delegate; duplicate imports are no-ops                                    |
| `finalize_migration(admin, registry, clock, digest, expiry)`     | Permanently close imports after exact totals and fresh completion evidence                               |
| `seal_approve(id, registry, account)`                            | SEAL policy — authorizes owner or delegate key holder to decrypt                                         |

## View Functions

| Function                             | Description                                      |
| ------------------------------------ | ------------------------------------------------ |
| `is_delegate(account, public_key)`   | Check if a public key is an authorized delegate  |
| `is_delegate_address(account, addr)` | Check if a Sui address is an authorized delegate |
| `owner(account)`                     | Get the owner address                            |
| `delegate_count(account)`            | Get the number of delegate keys                  |
| `has_account(registry, addr)`        | Check if an address already has an account       |
| `is_active(account)`                 | Check if the account is active                   |
| `is_admin_quarantined(account)`      | Check whether Admin containment is active        |

## Events

| Event                      | Emitted when                                            |
| -------------------------- | ------------------------------------------------------- |
| `AccountCreated`           | A new account is created                                |
| `DelegateKeyAdded`         | A delegate key is added to an account                   |
| `DelegateKeyRemoved`       | A delegate key is removed from an account               |
| `AccountDeactivated`       | An account is frozen                                    |
| `AccountReactivated`       | A frozen account is unfrozen                            |
| `AccountQuarantined`       | Admin containment is applied                            |
| `AccountQuarantineCleared` | Admin containment is released; the account stays frozen |
