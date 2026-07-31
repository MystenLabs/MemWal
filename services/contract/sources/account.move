/// Walrus Memory — Account & SEAL Access Control
///
/// Core on-chain module for managing Walrus Memory accounts and delegate keys.
/// Delegate keys are Ed25519 Sui keypairs that can sign transactions
/// and are authorized for SEAL decryption.
///
/// ## Architecture
/// - AccountRegistry: shared object — tracks accounts (prevents duplicates)
/// - MemWalAccount: shared object — stores owner + delegate_keys
/// - DelegateKey: struct with public_key, sui_address, label, created_at
/// - seal_approve: SEAL policy — authorizes owner OR delegate key holder to decrypt
///
/// ## Versioning
/// The `AccountRegistry` carries an explicit `version: u64` field. Every
/// permissionless entry takes the registry and asserts `registry.version ==
/// VERSION`, so a single `migrate_registry` call (AdminCap) flips the gate for
/// the whole package at once — there is no per-account version or per-account
/// migration. Historical ciphertext remains decryptable by targeting the
/// current policy package while keeping the immutable first-published package
/// as its SEAL identity. Emergency containment (`admin_deactivate_account`),
/// `migrate_registry`, and cap custody/burn are deliberately NOT gated, so
/// containment and upgrades still work while all ordinary and irreversible
/// state transitions are retired.
module memwal::account {
    use std::bcs;
    use std::string::String;
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::Clock;

    // ============================================================
    // Error Codes
    // ============================================================

    /// Delegate key already exists in the account
    const EDelegateKeyAlreadyExists: u64 = 0;
    /// Delegate key not found in the account
    const EDelegateKeyNotFound: u64 = 1;
    /// Maximum number of delegate keys reached
    const ETooManyDelegateKeys: u64 = 2;
    /// Account already exists for this address
    const EAccountAlreadyExists: u64 = 3;
    /// Caller is not the account owner
    const ENotOwner: u64 = 4;
    /// Invalid Ed25519 public key length (must be 32 bytes)
    const EInvalidPublicKeyLength: u64 = 5;
    /// Account is deactivated (frozen)
    const EAccountDeactivated: u64 = 6;
    /// Object/registry version does not match the current package VERSION
    const EWrongVersion: u64 = 7;
    // (code 8 retired: was ENotUpgradeAuthority. Admin gating moved from a
    //  package-id comparison on UpgradeCap — which can never pass on-chain,
    //  because `@memwal` compiles to the literal 0x0 from Move.toml and
    //  address constants are NOT relocated at publish — to the typed
    //  `AdminCap`, which no other package can forge.)
    /// Object/registry already at the target version
    const EAlreadyMigrated: u64 = 9;
    /// Delegate key label exceeds maximum allowed length
    const ELabelTooLong: u64 = 10;
    /// Account is already in the requested active state
    const EAccountAlreadyActive: u64 = 11;
    /// Migration has been finalized — the cap-gated import path is permanently closed
    const EMigrationFinalized: u64 = 12;
    /// Target is a native (owner-created) account, not a legacy import
    const ENotLegacyImported: u64 = 13;
    /// The legacy account/delegate is not part of the Admin-approved snapshot
    const EInvalidMigrationProof: u64 = 14;
    /// An allowlist root is already pinned on the registry
    const EAllowlistRootAlreadyPinned: u64 = 15;
    /// Requested allowlist root does not match the root pinned on the registry
    const EAllowlistRootMismatch: u64 = 16;
    /// No allowlist root is pinned yet — a root must be pinned before minting
    const EAllowlistRootNotPinned: u64 = 17;
    /// Owner-controlled account creation/mutation is blocked until migration finalizes
    const EMigrationInProgress: u64 = 18;
    // (code 19 retired: quarantine no longer blocks proof-bound delegate
    // hydration, because doing so made the exact global import count impossible.)
    /// Account is quarantined by the AdminCap holder
    const EAccountQuarantined: u64 = 20;
    /// Imported account/delegate totals do not match the pinned manifest totals
    const EMigrationImportCountMismatch: u64 = 21;
    /// Completion evidence digest or deadline is invalid
    const EInvalidCompletionEvidence: u64 = 22;
    /// Completion evidence expired before finalization executed
    const ECompletionEvidenceExpired: u64 = 23;
    /// The allowlist root can only be corrected before the first import
    const EAllowlistRepinAfterImport: u64 = 24;
    /// Caller is not authorized to decrypt (SEAL)
    const ENoAccess: u64 = 100;

    /// Maximum delegate keys per account
    const MAX_DELEGATE_KEYS: u64 = 20;
    /// Expected length of an Ed25519 public key in bytes
    const ED25519_PUBLIC_KEY_LENGTH: u64 = 32;
    /// Maximum allowed length of a delegate key label, in bytes
    const MAX_LABEL_LENGTH: u64 = 64;
    /// Blake2b-256 digest length used by the migration allowlist Merkle tree.
    const MERKLE_HASH_LENGTH: u64 = 32;
    /// Byte length of the BCS-encoded `access_counter_version` tail of a SEAL id.
    const SEAL_ID_COUNTER_LENGTH: u64 = 8;
    /// Completion reports remain valid for at most 15 minutes.
    const MAX_COMPLETION_EVIDENCE_TTL_MS: u64 = 900000;

    /// Current object-schema version. This module is a fresh publish, so every
    /// object it creates is born at v4 even though the on-chain package itself
    /// starts at package version 1. Bump this only for a future layout-compatible
    /// package upgrade that changes behavior gated through the registry. Sui
    /// upgrades cannot change existing struct layouts.
    const VERSION: u64 = 4;

    // ============================================================
    // Structs
    // ============================================================

    /// Shared registry — tracks all MemWalAccounts.
    /// Prevents duplicate account creation.
    public struct AccountRegistry has key {
        id: UID,
        /// Maps owner address → account object ID (prevents duplicates)
        accounts: Table<address, ID>,
        /// One-way latch: once true, every `MigrationCap`-gated import entry aborts.
        /// Set by `finalize_migration` after the V1→this-package import completes,
        /// which closes the import path for good.
        migration_finalized: bool,
        /// Admin-pinned allowlist root. Every mint and import must match the
        /// current root. An operator may correct it only before the first import;
        /// after imports begin it is immutable. Pinning is required before
        /// minting or finalizing.
        pinned_allowlist_root: Option<vector<u8>>,
        /// Manifest totals pinned atomically with the allowlist root. Import
        /// counters must match both totals before migration can be finalized.
        expected_account_imports: u64,
        expected_delegate_imports: u64,
        imported_accounts: u64,
        imported_delegates: u64,
        version: u64,
    }

    /// Main account object — one per user
    /// Stores the list of authorized delegate keys
    public struct MemWalAccount has key, store {
        id: UID,
        /// Owner's Sui address
        owner: address,
        /// List of authorized Ed25519 delegate keys (each with a Sui address)
        delegate_keys: vector<DelegateKey>,
        /// Timestamp when account was created (epoch ms)
        created_at: u64,
        /// Whether the account is active (false = frozen, SEAL access denied)
        active: bool,
        /// Admin quarantine is distinct from the owner's active flag. The owner
        /// cannot reactivate until the AdminCap holder explicitly clears it.
        admin_quarantined: bool,
        /// V1 account ID recorded by the trusted import operator; `none` if native.
        /// `some` is also the single source of truth that marks an imported account,
        /// so import-only entries cannot drift from a redundant boolean flag. This
        /// is provenance metadata, not an on-chain proof of the V1 relationship.
        legacy_account_id: Option<ID>,
        /// Rotation counter mixed into the SEAL identity. Born 0; incremented
        /// whenever access is withdrawn (delegate removed, account frozen).
        ///
        /// SEAL derives one reusable secret key per identity, so a delegate who
        /// fetched the key for `BCS(owner)` once could decrypt *future* memories
        /// forever, even after removal — never contacting `seal_approve` again.
        /// Encrypting under `BCS(owner) ‖ BCS(counter)` instead means bumping the
        /// counter yields a different identity, hence a different key, which a
        /// removed delegate can no longer fetch.
        ///
        /// Forward-only by design: bumping the counter only protects memories
        /// written *after* the bump. Everything already written stays readable
        /// with its original key by any delegate authorized then — so
        /// retroactively cutting off a removed or compromised delegate means
        /// re-encrypting those blobs.
        access_counter_version: u64,
    }

    /// An authorized Ed25519 delegate key with its derived Sui address
    public struct DelegateKey has store, copy, drop {
        /// Ed25519 public key (32 bytes)
        public_key: vector<u8>,
        /// Sui address derived from this Ed25519 public key
        sui_address: address,
        /// Human-readable label (e.g., "MacBook Pro", "Work Server")
        label: String,
        /// Timestamp when key was added (epoch ms)
        created_at: u64,
    }

    /// Admin authority for this package: gates batch migration, import-cap
    /// minting, and the finalize latch. Created once in `init` and transferred
    /// to the publisher. A typed cap rather than the package `UpgradeCap`,
    /// because comparing `upgrade_package(cap)` against `@memwal` can never
    /// succeed on-chain (`@memwal` is the literal `0x0` from Move.toml).
    ///
    /// Deliberately `key`-only (no `store`): with `store`, anyone holding the
    /// cap could `transfer::public_freeze_object` it, making it readable by
    /// every address and turning every `&AdminCap`-gated entry permissionless.
    /// Custody moves go through `transfer_admin_cap`.
    public struct AdminCap has key {
        id: UID,
    }

    /// Capability that authorizes the V1→this-package import
    /// (`legacy_import_account` / `legacy_import_delegate_key`) without owner
    /// signatures. Minted by the `AdminCap` holder; many can exist at once (one
    /// per migrator worker). Operators may burn them individually; the registry's
    /// one-way finalize latch makes every surviving cap inert. Owner-signed
    /// onboarding (`create_account` / `add_delegate_key`) never needs it.
    ///
    /// `key`-only (no `store`) for the same freeze-hardening reason as
    /// `AdminCap`; custody moves go through `transfer_migration_cap`.
    public struct MigrationCap has key {
        id: UID,
        /// Root of the immutable, Admin-approved V1 snapshot. Account leaves
        /// bind `(legacy_account_id, owner, active, created_at)` and delegate
        /// leaves bind `(legacy_account_id, public_key, label, created_at)`, so
        /// this cap cannot forge or alter an approved authority relationship.
        allowlist_root: vector<u8>,
    }

    // ============================================================
    // Events
    // ============================================================

    public struct AccountCreated has copy, drop {
        account_id: ID,
        owner: address,
    }

    public struct AccountImported has copy, drop {
        legacy_account_id: ID,
        new_account_id: ID,
        owner: address,
    }

    public struct DelegateKeyAdded has copy, drop {
        account_id: ID,
        public_key: vector<u8>,
        sui_address: address,
        label: String,
    }

    public struct DelegateKeyRemoved has copy, drop {
        account_id: ID,
        public_key: vector<u8>,
        sui_address: address,
    }

    public struct AccountDeactivated has copy, drop {
        account_id: ID,
        owner: address,
    }

    public struct AccountReactivated has copy, drop {
        account_id: ID,
        owner: address,
    }

    public struct AccountQuarantined has copy, drop {
        account_id: ID,
        owner: address,
    }

    public struct AccountQuarantineCleared has copy, drop {
        account_id: ID,
        owner: address,
    }

    public struct RegistryMigrated has copy, drop {
        registry_id: ID,
        from: u64,
        to: u64,
    }

    public struct MigrationCapMinted has copy, drop {
        cap_id: ID,
    }

    public struct MigrationCapBurned has copy, drop {
        cap_id: ID,
    }

    public struct MigrationFinalized has copy, drop {
        registry_id: ID,
        completion_evidence_sha256: vector<u8>,
        evidence_expires_at_ms: u64,
    }

    public struct AllowlistRootPinned has copy, drop {
        registry_id: ID,
        root: vector<u8>,
        expected_account_imports: u64,
        expected_delegate_imports: u64,
    }

    public struct AllowlistRootRepinned has copy, drop {
        registry_id: ID,
        old_root: vector<u8>,
        new_root: vector<u8>,
        expected_account_imports: u64,
        expected_delegate_imports: u64,
    }

    // ============================================================
    // Init — runs once at module publish
    // ============================================================

    /// Create AccountRegistry (shared) + the AdminCap (to the publisher).
    fun init(ctx: &mut TxContext) {
        let registry = AccountRegistry {
            id: object::new(ctx),
            accounts: table::new(ctx),
            migration_finalized: false,
            pinned_allowlist_root: option::none(),
            expected_account_imports: 0,
            expected_delegate_imports: 0,
            imported_accounts: 0,
            imported_delegates: 0,
            // Tag the registry with the current VERSION so future upgrades can detect un-migrated
            // objects.
            version: VERSION,
        };
        transfer::share_object(registry);

        transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    }

    // ============================================================
    // Capability custody
    // ============================================================
    //
    // Both caps are `key`-only, so the generic transfer surface
    // (`TransferObjects` in a PTB, `transfer::public_transfer`) and — more
    // importantly — `transfer::public_freeze_object` cannot touch them. These
    // module-internal entries preserve legitimate custody moves: rotating the
    // AdminCap to a new governance address, or handing a freshly minted
    // MigrationCap to the migrator controller wallet.

    // Both transfers are `public`, not `entry`: a private entry function
    // rejects values produced by earlier non-entry commands in the same PTB
    // (InvalidArgumentToPrivateEntryFunction), which would make it impossible
    // to chain `mint_migration_cap` into a transfer — and with `key`-only,
    // non-drop caps there is no other way to move a freshly minted cap.

    /// Hand the `AdminCap` to a new custodian address.
    public fun transfer_admin_cap(cap: AdminCap, to: address) {
        transfer::transfer(cap, to);
    }

    /// Hand a `MigrationCap` to a migrator worker/controller address.
    public fun transfer_migration_cap(cap: MigrationCap, to: address) {
        transfer::transfer(cap, to);
    }

    // ============================================================
    // Account Entry Functions
    // ============================================================

    /// Create a new MemWalAccount. Each address can only create ONE account
    /// (enforced by the registry). Blocked during the migration window: until
    /// `finalize_migration` sets the latch, accounts arrive only through the
    /// `MigrationCap` import path, so this aborts
    /// `EMigrationInProgress`.
    entry fun create_account(
        registry: &mut AccountRegistry,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Version gating: the registry must be on the current VERSION
        // before any state mutation is allowed.
        assert!(registry.version == VERSION, EWrongVersion);
        // Migration window: native creation opens only once imports are closed.
        assert!(registry.migration_finalized, EMigrationInProgress);

        let sender = ctx.sender();

        // Check: no duplicate accounts
        assert!(!registry.accounts.contains(sender), EAccountAlreadyExists);

        let account = MemWalAccount {
            id: object::new(ctx),
            owner: sender,
            delegate_keys: vector::empty(),
            created_at: clock.timestamp_ms(),
            active: true,
            admin_quarantined: false,
            legacy_account_id: option::none(),
            access_counter_version: 0,
        };

        let account_id = object::id(&account);

        // Register in the registry
        registry.accounts.add(sender, account_id);

        event::emit(AccountCreated {
            account_id,
            owner: sender,
        });

        transfer::share_object(account);
    }

    /// Add a delegate key to the account
    /// Only the owner can add delegate keys
    ///
    /// * `public_key` - Ed25519 public key bytes (32 bytes). The Sui address is
    ///   derived from it on-chain (see `derive_sui_address`), never supplied by the
    ///   caller — so the stored address is always the key's real address.
    /// * `label` - Human-readable label for this key
    entry fun add_delegate_key(
        account: &mut MemWalAccount,
        registry: &AccountRegistry,
        public_key: vector<u8>,
        label: String,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        // Version gating
        assert!(registry.version == VERSION, EWrongVersion);

        // Verify caller is the owner
        assert!(account.owner == ctx.sender(), ENotOwner);
        // Imported authority must stay identical to the pinned snapshot until
        // every account and delegate has been counted and migration finalizes.
        assert!(registry.migration_finalized, EMigrationInProgress);

        // Verify account is active
        assert!(account.active, EAccountDeactivated);

        // Validate Ed25519 public key length (must be exactly 32 bytes)
        assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);

        // Validate label length — labels are stored on-chain
        // for the lifetime of the account, so cap the byte length to keep
        // storage costs predictable.
        assert!(label.as_bytes().length() <= MAX_LABEL_LENGTH, ELabelTooLong);

        // Check max limit
        assert!(
            account.delegate_keys.length() < MAX_DELEGATE_KEYS,
            ETooManyDelegateKeys,
        );

        // Check key doesn't already exist
        let mut i = 0;
        let len = account.delegate_keys.length();
        while (i < len) {
            assert!(
                account.delegate_keys[i].public_key != public_key,
                EDelegateKeyAlreadyExists,
            );
            i = i + 1;
        };

        // Derive the Sui address from the public key on-chain so `public_key`
        // and `sui_address` always stay consistent.
        let sui_address = derive_sui_address(&public_key);

        let key = DelegateKey {
            public_key,
            sui_address,
            label,
            created_at: clock.timestamp_ms(),
        };

        let account_id = object::id(account);

        event::emit(DelegateKeyAdded {
            account_id,
            public_key: key.public_key,
            sui_address: key.sui_address,
            label: key.label,
        });

        account.delegate_keys.push_back(key);
    }

    /// Remove a delegate key from the account.
    /// Only the owner can remove delegate keys.
    ///
    /// Removal is allowed even when the account is
    /// deactivated, so the owner can purge a compromised key after freezing.
    ///
    /// * `public_key` - Ed25519 public key bytes to remove
    entry fun remove_delegate_key(
        account: &mut MemWalAccount,
        registry: &AccountRegistry,
        public_key: vector<u8>,
        ctx: &TxContext,
    ) {
        // Version gating
        assert!(registry.version == VERSION, EWrongVersion);

        // Verify caller is the owner
        assert!(account.owner == ctx.sender(), ENotOwner);
        assert!(registry.migration_finalized, EMigrationInProgress);

        // NOTE: deliberately no `account.active` check; owners must be able to purge keys after freezing.

        // Find and remove the key
        let mut found = false;
        let mut sui_address = @0x0;
        let mut i = 0;
        let len = account.delegate_keys.length();

        while (i < len) {
            if (account.delegate_keys[i].public_key == public_key) {
                sui_address = account.delegate_keys[i].sui_address;
                account.delegate_keys.remove(i);
                found = true;
                break
            };
            i = i + 1;
        };

        assert!(found, EDelegateKeyNotFound);

        rotate_access_counter(account);

        event::emit(DelegateKeyRemoved {
            account_id: object::id(account),
            public_key,
            sui_address,
        });
    }

    // ============================================================
    // Account Activation / Deactivation
    // ============================================================

    /// Deactivate (freeze) the account.
    /// When deactivated: SEAL access is denied, delegate keys cannot be added.
    /// Only the owner can deactivate.
    ///
    /// Calling on an already-deactivated account aborts to
    /// avoid emitting spurious `AccountDeactivated` events.
    entry fun deactivate_account(
        account: &mut MemWalAccount,
        registry: &AccountRegistry,
        ctx: &TxContext,
    ) {
        // Version gating
        assert!(registry.version == VERSION, EWrongVersion);

        assert!(account.owner == ctx.sender(), ENotOwner);
        assert!(registry.migration_finalized, EMigrationInProgress);
        assert!(account.active, EAccountDeactivated);
        account.active = false;
        rotate_access_counter(account);

        event::emit(AccountDeactivated {
            account_id: object::id(account),
            owner: account.owner,
        });
    }

    /// Emergency containment for a compromised or incorrectly imported
    /// account. Quarantine is Admin-controlled: the owner cannot reactivate
    /// until `admin_clear_quarantine` is called. Idempotent for safe retries.
    entry fun admin_deactivate_account(
        _admin: &AdminCap,
        account: &mut MemWalAccount,
    ) {
        if (account.admin_quarantined) return;
        account.admin_quarantined = true;
        // Rotate even when the account was already inactive so a key issued
        // before quarantine cannot decrypt ciphertext written at the new
        // counter after quarantine is cleared. Manifest-proven delegate
        // hydration may continue, but inactive accounts cannot authorize
        // decryption.
        rotate_access_counter(account);
        if (account.active) {
            account.active = false;
            event::emit(AccountDeactivated {
                account_id: object::id(account),
                owner: account.owner,
            });
        };
        event::emit(AccountQuarantined {
            account_id: object::id(account),
            owner: account.owner,
        });
    }

    /// Release Admin quarantine without restoring access. The owner must still
    /// call `reactivate_account`, so operations cannot silently reactivate users.
    entry fun admin_clear_quarantine(
        _admin: &AdminCap,
        registry: &AccountRegistry,
        account: &mut MemWalAccount,
    ) {
        // Containment stays available across upgrades; restoration must use
        // the policy version selected by the shared registry.
        assert!(registry.version == VERSION, EWrongVersion);
        if (!account.admin_quarantined) return;
        account.admin_quarantined = false;
        event::emit(AccountQuarantineCleared {
            account_id: object::id(account),
            owner: account.owner,
        });
    }

    /// Reactivate a previously deactivated account.
    /// Only the owner can reactivate.
    /// Aborts with `EAccountAlreadyActive` if the account is already active
    /// This mirrors the deactivate-account idempotency guard.
    entry fun reactivate_account(
        account: &mut MemWalAccount,
        registry: &AccountRegistry,
        ctx: &TxContext,
    ) {
        // Version gating
        assert!(registry.version == VERSION, EWrongVersion);

        assert!(account.owner == ctx.sender(), ENotOwner);
        assert!(registry.migration_finalized, EMigrationInProgress);
        assert!(!account.admin_quarantined, EAccountQuarantined);
        assert!(!account.active, EAccountAlreadyActive);
        // A source-inactive legacy account starts at counter zero so its
        // delegates can be hydrated in either order. Once its owner restores
        // access, rotate exactly once to close that unsigned import path.
        if (account.legacy_account_id.is_some() && account.access_counter_version == 0) {
            rotate_access_counter(account);
        };
        account.active = true;

        event::emit(AccountReactivated {
            account_id: object::id(account),
            owner: account.owner,
        });
    }

    // ============================================================
    // Future layout-compatible behavior migration
    // ============================================================

    /// Advance the shared `AccountRegistry` behavior version. Gated by the `AdminCap`
    /// because there is exactly one registry and migrating it is an ops-only
    /// rollout step.
    entry fun migrate_registry(
        _admin: &AdminCap,
        registry: &mut AccountRegistry,
    ) {
        let cur = registry.version;
        assert!(cur < VERSION, EAlreadyMigrated);
        registry.version = VERSION;

        event::emit(RegistryMigrated {
            registry_id: object::id(registry),
            from: cur,
            to: VERSION,
        });
    }

    // ============================================================
    // Legacy V1 → this fresh package import (MigrationCap-gated)
    // ============================================================
    //
    // Imports existing V1 accounts + delegate keys so migrated users don't
    // re-onboard. Every entry is gated by a `MigrationCap` (minted with the
    // `AdminCap`) and the `migration_finalized` latch; delegate additions also
    // require `legacy_account_id.is_some()`. Burn each `MigrationCap` when its
    // worker finishes and call `finalize_migration` once the import completes;
    // finalization also makes any surviving cap inert. The `AdminCap` has no
    // burn path and must remain under secure governance for future upgrades.

    /// Pin the single allowlist root that every `mint_migration_cap` must use.
    /// Required before any mint — `mint_migration_cap` aborts
    /// `EAllowlistRootNotPinned` until a root is pinned. A mistaken root may be
    /// corrected with `repin_allowlist_root`, but only before the first import.
    /// The expected account and delegate totals are pinned in the same
    /// transaction and gate finalization.
    entry fun pin_allowlist_root(
        _admin: &AdminCap,
        registry: &mut AccountRegistry,
        root: vector<u8>,
        expected_account_imports: u64,
        expected_delegate_imports: u64,
    ) {
        assert!(registry.version == VERSION, EWrongVersion);
        assert!(root.length() == MERKLE_HASH_LENGTH, EInvalidMigrationProof);
        assert!(registry.pinned_allowlist_root.is_none(), EAllowlistRootAlreadyPinned);
        registry.pinned_allowlist_root.fill(root);
        registry.expected_account_imports = expected_account_imports;
        registry.expected_delegate_imports = expected_delegate_imports;
        event::emit(AllowlistRootPinned {
            registry_id: object::id(registry),
            root,
            expected_account_imports,
            expected_delegate_imports,
        });
    }

    /// Correct an unreachable root or count before imports begin. Existing
    /// `MigrationCap`s remain objects but become inert because every import also
    /// checks the cap root against the registry's current root. Once either
    /// import counter is non-zero, the snapshot is immutable.
    entry fun repin_allowlist_root(
        _admin: &AdminCap,
        registry: &mut AccountRegistry,
        root: vector<u8>,
        expected_account_imports: u64,
        expected_delegate_imports: u64,
    ) {
        assert!(registry.version == VERSION, EWrongVersion);
        assert!(!registry.migration_finalized, EMigrationFinalized);
        assert!(root.length() == MERKLE_HASH_LENGTH, EInvalidMigrationProof);
        assert!(registry.pinned_allowlist_root.is_some(), EAllowlistRootNotPinned);
        assert!(
            registry.imported_accounts == 0 && registry.imported_delegates == 0,
            EAllowlistRepinAfterImport,
        );
        let pinned = registry.pinned_allowlist_root.borrow_mut();
        let old_root = *pinned;
        *pinned = root;
        registry.expected_account_imports = expected_account_imports;
        registry.expected_delegate_imports = expected_delegate_imports;
        event::emit(AllowlistRootRepinned {
            registry_id: object::id(registry),
            old_root,
            new_root: root,
            expected_account_imports,
            expected_delegate_imports,
        });
    }

    /// Mint a `MigrationCap` bound to one immutable V1 snapshot. Only the
    /// `AdminCap` holder chooses the allowlist root; workers receive proofs,
    /// never authority to extend the snapshot. A root must first be pinned on
    /// the registry via `pin_allowlist_root`, and the requested root must match
    /// it — so no cap can ever be bound to an unreviewed snapshot, even if the
    /// `AdminCap` is later compromised.
    public fun mint_migration_cap(
        _admin: &AdminCap,
        registry: &AccountRegistry,
        allowlist_root: vector<u8>,
        ctx: &mut TxContext,
    ): MigrationCap {
        assert!(registry.version == VERSION, EWrongVersion);
        assert!(!registry.migration_finalized, EMigrationFinalized);
        assert!(allowlist_root.length() == MERKLE_HASH_LENGTH, EInvalidMigrationProof);
        assert!(registry.pinned_allowlist_root.is_some(), EAllowlistRootNotPinned);
        assert!(
            registry.pinned_allowlist_root.borrow() == &allowlist_root,
            EAllowlistRootMismatch,
        );
        let mcap = MigrationCap { id: object::new(ctx), allowlist_root };
        event::emit(MigrationCapMinted { cap_id: object::id(&mcap) });
        mcap
    }

    /// Burn a `MigrationCap` so no import authority survives finalize.
    public fun burn_migration_cap(mcap: MigrationCap) {
        let MigrationCap { id, allowlist_root: _ } = mcap;
        let cap_id = object::uid_to_inner(&id);
        object::delete(id);
        event::emit(MigrationCapBurned { cap_id });
    }

    /// Permanently close the legacy import path — one-way. After this the
    /// `MigrationCap`-gated import entries abort `EMigrationFinalized`, and
    /// native `create_account` becomes available (it aborts
    /// `EMigrationInProgress` until this latch is set). Every
    /// account and delegate declared when the root was pinned must have been
    /// imported; future in-package schema migration remains available through
    /// the retained `AdminCap`. Gated by the `AdminCap`.
    entry fun finalize_migration(
        _admin: &AdminCap,
        registry: &mut AccountRegistry,
        clock: &Clock,
        completion_evidence_sha256: vector<u8>,
        evidence_expires_at_ms: u64,
    ) {
        assert!(registry.version == VERSION, EWrongVersion);
        assert!(!registry.migration_finalized, EMigrationFinalized);
        assert!(registry.pinned_allowlist_root.is_some(), EAllowlistRootNotPinned);
        assert!(completion_evidence_sha256.length() == MERKLE_HASH_LENGTH, EInvalidCompletionEvidence);
        let now = clock.timestamp_ms();
        assert!(now <= evidence_expires_at_ms, ECompletionEvidenceExpired);
        assert!(
            evidence_expires_at_ms <= now + MAX_COMPLETION_EVIDENCE_TTL_MS,
            EInvalidCompletionEvidence,
        );
        assert!(
            registry.imported_accounts == registry.expected_account_imports &&
                registry.imported_delegates == registry.expected_delegate_imports,
            EMigrationImportCountMismatch,
        );
        registry.migration_finalized = true;
        event::emit(MigrationFinalized {
            registry_id: object::id(registry),
            completion_evidence_sha256,
            evidence_expires_at_ms,
        });
    }

    /// Import a V1 account for `owner` without the owner's signature. Creates +
    /// shares a `MemWalAccount` carrying `some(legacy_account_id)` and registers it.
    /// Aborts `EAccountAlreadyExists` if `owner` already has one. The Rust
    /// migrator catches that abort and verifies/folds it to success on retry;
    /// unlike delegate re-add, the Move entry itself is not a no-op.
    entry fun legacy_import_account(
        cap: &MigrationCap,
        registry: &mut AccountRegistry,
        legacy_account_id: ID,
        owner: address,
        active: bool,
        created_at: u64,
        merkle_proof: vector<vector<u8>>,
        sibling_is_left: vector<bool>,
        ctx: &mut TxContext,
    ) {
        assert!(registry.version == VERSION, EWrongVersion);
        assert!(!registry.migration_finalized, EMigrationFinalized);
        assert!(registry.pinned_allowlist_root.is_some(), EAllowlistRootNotPinned);
        assert!(
            registry.pinned_allowlist_root.borrow() == &cap.allowlist_root,
            EAllowlistRootMismatch,
        );
        assert_migration_proof(
            &cap.allowlist_root,
            migration_account_leaf(legacy_account_id, owner, active, created_at),
            merkle_proof,
            sibling_is_left,
        );
        assert!(!registry.accounts.contains(owner), EAccountAlreadyExists);
        assert!(
            registry.imported_accounts < registry.expected_account_imports,
            EMigrationImportCountMismatch,
        );

        let account = MemWalAccount {
            id: object::new(ctx),
            owner,
            delegate_keys: vector::empty(),
            created_at,
            active,
            admin_quarantined: false,
            legacy_account_id: option::some(legacy_account_id),
            access_counter_version: 0,
        };

        let account_id = object::id(&account);
        registry.accounts.add(owner, account_id);
        registry.imported_accounts = registry.imported_accounts + 1;
        event::emit(AccountCreated { account_id, owner });
        event::emit(AccountImported { legacy_account_id, new_account_id: account_id, owner });
        transfer::share_object(account);
    }

    /// Add a delegate key to a migration-created account without the owner's
    /// signature (mirrors only the user's manifest-proven V1 delegates). The Sui
    /// address is derived from `public_key`. Idempotent: a key already present is
    /// skipped. Aborts on a native account. A quarantined account may still
    /// receive manifest-proven delegates while it remains inactive; otherwise
    /// one early quarantine would make the exact global import count impossible.
    entry fun legacy_import_delegate_key(
        cap: &MigrationCap,
        registry: &mut AccountRegistry,
        account: &mut MemWalAccount,
        public_key: vector<u8>,
        label: String,
        created_at: u64,
        merkle_proof: vector<vector<u8>>,
        sibling_is_left: vector<bool>,
    ) {
        assert!(registry.version == VERSION, EWrongVersion);
        assert!(!registry.migration_finalized, EMigrationFinalized);
        assert!(registry.pinned_allowlist_root.is_some(), EAllowlistRootNotPinned);
        assert!(
            registry.pinned_allowlist_root.borrow() == &cap.allowlist_root,
            EAllowlistRootMismatch,
        );
        assert!(account.legacy_account_id.is_some(), ENotLegacyImported);
        assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);
        assert!(label.as_bytes().length() <= MAX_LABEL_LENGTH, ELabelTooLong);
        assert_migration_proof(
            &cap.allowlist_root,
            migration_delegate_leaf(
                *account.legacy_account_id.borrow(),
                &public_key,
                &label,
                created_at,
            ),
            merkle_proof,
            sibling_is_left,
        );

        // Skip a key already registered. Runs before the capacity check so a
        // repeated add on a full account stays a no-op.
        let mut i = 0;
        let len = account.delegate_keys.length();
        while (i < len) {
            if (account.delegate_keys[i].public_key == public_key) return;
            i = i + 1;
        };

        assert!(account.delegate_keys.length() < MAX_DELEGATE_KEYS, ETooManyDelegateKeys);
        assert!(
            registry.imported_delegates < registry.expected_delegate_imports,
            EMigrationImportCountMismatch,
        );

        let sui_address = derive_sui_address(&public_key);
        let account_id = object::id(account);
        let key = DelegateKey { public_key, sui_address, label, created_at };
        event::emit(DelegateKeyAdded {
            account_id,
            public_key: key.public_key,
            sui_address: key.sui_address,
            label: key.label,
        });
        account.delegate_keys.push_back(key);
        registry.imported_delegates = registry.imported_delegates + 1;
    }

    /// Domain-separated allowlist leaf for one V1 account and its timestamp.
    /// Public so offline snapshot tooling can mirror the exact byte layout.
    public fun migration_account_leaf(
        legacy_account_id: ID,
        owner: address,
        active: bool,
        created_at: u64,
    ): vector<u8> {
        let mut bytes = vector[4u8, 0];
        bytes.append(bcs::to_bytes(&legacy_account_id));
        bytes.append(bcs::to_bytes(&owner));
        bytes.append(bcs::to_bytes(&active));
        bytes.append(bcs::to_bytes(&created_at));
        sui::hash::blake2b256(&bytes)
    }

    /// Domain-separated allowlist leaf for one V1 delegate, including metadata.
    /// Binding the legacy account id prevents replay onto another account.
    public fun migration_delegate_leaf(
        legacy_account_id: ID,
        public_key: &vector<u8>,
        label: &String,
        created_at: u64,
    ): vector<u8> {
        assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);
        let mut bytes = vector[4u8, 1];
        bytes.append(bcs::to_bytes(&legacy_account_id));
        bytes.append(*public_key);
        bytes.append(bcs::to_bytes(label));
        bytes.append(bcs::to_bytes(&created_at));
        sui::hash::blake2b256(&bytes)
    }

    fun migration_merkle_parent(left: &vector<u8>, right: &vector<u8>): vector<u8> {
        assert!(left.length() == MERKLE_HASH_LENGTH, EInvalidMigrationProof);
        assert!(right.length() == MERKLE_HASH_LENGTH, EInvalidMigrationProof);
        let mut bytes = vector[4u8, 2];
        bytes.append(*left);
        bytes.append(*right);
        sui::hash::blake2b256(&bytes)
    }

    fun assert_migration_proof(
        root: &vector<u8>,
        leaf: vector<u8>,
        proof: vector<vector<u8>>,
        sibling_is_left: vector<bool>,
    ) {
        assert!(root.length() == MERKLE_HASH_LENGTH, EInvalidMigrationProof);
        assert!(proof.length() == sibling_is_left.length(), EInvalidMigrationProof);
        let mut current = leaf;
        let mut i = 0;
        while (i < proof.length()) {
            let sibling = &proof[i];
            current = if (sibling_is_left[i]) {
                migration_merkle_parent(sibling, &current)
            } else {
                migration_merkle_parent(&current, sibling)
            };
            i = i + 1;
        };
        assert!(current == *root, EInvalidMigrationProof);
    }

    // ============================================================
    // View Functions
    // ============================================================

    /// Check if a public key is an authorized delegate for this account
    public fun is_delegate(account: &MemWalAccount, public_key: &vector<u8>): bool {
        let mut i = 0;
        let len = account.delegate_keys.length();
        while (i < len) {
            if (&account.delegate_keys[i].public_key == public_key) {
                return true
            };
            i = i + 1;
        };
        false
    }

    /// Check if a Sui address is an authorized delegate for this account
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

    /// Get the owner address
    public fun owner(account: &MemWalAccount): address {
        account.owner
    }

    public fun legacy_account_id(account: &MemWalAccount): Option<ID> {
        account.legacy_account_id
    }

    /// Get the number of delegate keys
    public fun delegate_count(account: &MemWalAccount): u64 {
        account.delegate_keys.length()
    }

    /// Get a delegate key's public key by index
    public fun delegate_key_at(account: &MemWalAccount, index: u64): &vector<u8> {
        &account.delegate_keys[index].public_key
    }

    /// Get a delegate key's Sui address by index
    public fun delegate_address_at(account: &MemWalAccount, index: u64): address {
        account.delegate_keys[index].sui_address
    }

    /// Get a delegate key's label by index
    public fun delegate_label_at(account: &MemWalAccount, index: u64): &String {
        &account.delegate_keys[index].label
    }

    /// Check if an address already has an account
    public fun has_account(registry: &AccountRegistry, addr: address): bool {
        registry.accounts.contains(addr)
    }

    /// The allowlist root pinned on the registry, if any.
    public fun pinned_allowlist_root(registry: &AccountRegistry): Option<vector<u8>> {
        registry.pinned_allowlist_root
    }

    /// Check if the account is active
    public fun is_active(account: &MemWalAccount): bool {
        account.active
    }

    /// Whether the AdminCap holder has quarantined this account.
    public fun is_admin_quarantined(account: &MemWalAccount): bool {
        account.admin_quarantined
    }

    /// Current SEAL identity counter. Clients MUST read this fresh from chain
    /// immediately before encrypting — see `seal_key_id`.
    public fun access_counter_version(account: &MemWalAccount): u64 {
        account.access_counter_version
    }

    /// True if the account was created by the import path (not owner onboarding).
    public fun is_legacy_imported(account: &MemWalAccount): bool {
        account.legacy_account_id.is_some()
    }

    /// Read the schema version stored on the AccountRegistry.
    public fun registry_version(registry: &AccountRegistry): u64 {
        registry.version
    }

    /// Current package VERSION constant exposed for off-chain consumers.
    public fun current_version(): u64 { VERSION }

    // ============================================================
    // SEAL Access Control
    // ============================================================

    /// SEAL policy: authorize owner OR delegate key holder to decrypt.
    ///
    /// Key ID format: [package_id][..][BCS(owner_address)][BCS(access_counter_version)]
    /// This is called by SEAL key servers via dry_run to verify access.
    ///
    /// Access is granted if the caller is:
    /// 1. The data owner (key ID carries BCS(owner) + caller is account owner), OR
    /// 2. A registered delegate key holder (caller's Sui address is in delegate_keys)
    ///
    /// Anything may sit between the package id and the owner bytes — the SDK's
    /// namespace prefix does (see `sealEncrypt` in packages/sdk/src/manual.ts) —
    /// so only the trailing owner ‖ counter is matched.
    ///
    /// The account must be active (not frozen) and on the current VERSION. The
    /// version gate retires old policy bytecode after an upgrade; clients keep
    /// historical ciphertext decryptable by targeting the current policy
    /// package while the SEAL SessionKey stays scoped to the immutable
    /// first-published package. Emergency revocation must set `active = false`
    /// through owner `deactivate_account` or the retained AdminCap's
    /// `admin_deactivate_account`; Admin must clear quarantine before the owner
    /// can reactivate.
    entry fun seal_approve(
        id: vector<u8>,
        registry: &AccountRegistry,
        account: &MemWalAccount,
        ctx: &TxContext,
    ) {
        // Disable older policy bytecode after a registry migration.
        assert!(registry.version == VERSION, EWrongVersion);

        // Account must be active
        assert!(account.active, EAccountDeactivated);

        let counter = assert_seal_id_owner(&id, account);

        // Never mint a key for a counter the account has not reached yet.
        // Without this, a delegate that is authorized *right now* could walk
        // counter = 0..n, bank a key for every identity the account will ever
        // use, and make every future rotation a no-op — which is the whole
        // point of the counter. This single check is what makes removal bite.
        assert!(counter <= account.access_counter_version, ENoAccess);

        let caller = ctx.sender();

        // Owner can decrypt — return early; this also avoids scanning the
        // delegate list in the common owner path.
        if (caller == account.owner) return;

        // Otherwise the caller must be a registered delegate of this account.
        assert!(is_delegate_address(account, caller), ENoAccess);
    }

    /// Linearization fence for persisting freshly encrypted ciphertext.
    ///
    /// Writers call this in the same transaction that transfers the Walrus
    /// Blob to its owner. A revocation ordered before that transaction rotates
    /// the counter and aborts the stale write; a revocation ordered after it is
    /// correctly ordered after the write.
    entry fun seal_encrypt_fence(
        id: vector<u8>,
        registry: &AccountRegistry,
        account: &MemWalAccount,
    ) {
        assert!(registry.version == VERSION, EWrongVersion);
        let counter = assert_seal_id_owner(&id, account);
        assert!(counter == account.access_counter_version, ENoAccess);
    }

    /// Compute the SEAL key ID for a given owner address at a counter value.
    /// Used by clients to construct the correct key ID for encryption; pass
    /// `access_counter_version(account)` read fresh from chain, never a cached
    /// or caller-supplied counter — encrypting under a stale counter hands the
    /// data straight back to the delegate that was just removed.
    /// Key ID = bcs::to_bytes(owner) ‖ bcs::to_bytes(counter)
    /// (Package ID prefix is added automatically by SEAL SDK)
    public fun seal_key_id(owner: address, counter: u64): vector<u8> {
        let mut id = sui::bcs::to_bytes(&owner);
        id.append(sui::bcs::to_bytes(&counter));
        id
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    /// Derive the Sui address of an Ed25519 public key: `blake2b256(0x00 ‖ pubkey)`.
    /// The `0x00` prefix is the Ed25519 signature-scheme flag. Deriving on-chain
    /// keeps the stored address consistent with the key. Public so clients/tests
    /// can compute the same address.
    public fun derive_sui_address(public_key: &vector<u8>): address {
        assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);
        let mut bytes = vector::empty<u8>();
        bytes.push_back(0);
        bytes.append(*public_key);
        sui::address::from_bytes(sui::hash::blake2b256(&bytes))
    }

    /// Bump the SEAL identity counter, retiring every key already handed out
    /// from decrypting ciphertext written at later counters. Called wherever
    /// access is withdrawn; historical ciphertext remains readable by design.
    ///
    /// Freezing rotates too, and rotating on freeze (rather than on the way
    /// back up via `reactivate_account`) is what protects memories written
    /// while the account is frozen: encryption never calls `seal_approve`, so a
    /// frozen account can still accumulate ciphertext, and under the old
    /// counter a pre-freeze key would read all of it. Rotating on the way down
    /// puts those writes on a counter nobody holds a key for yet — no key is
    /// obtainable until the owner reactivates. Reactivation itself needs no
    /// rotation: whoever is still a delegate is authorized by definition.
    fun rotate_access_counter(account: &mut MemWalAccount) {
        account.access_counter_version = account.access_counter_version + 1;
    }

    /// Decode the trailing BCS-encoded u64 (little-endian) of a SEAL key id.
    /// Caller must have length-checked `id` first.
    fun seal_id_counter(id: &vector<u8>): u64 {
        let offset = id.length() - SEAL_ID_COUNTER_LENGTH;
        let mut counter = 0u64;
        let mut i = 0;
        while (i < SEAL_ID_COUNTER_LENGTH) {
            counter = counter + ((id[offset + i] as u64) << ((8 * i) as u8));
            i = i + 1;
        };
        counter
    }

    /// Validate that a SEAL id belongs to this account and return its counter.
    fun assert_seal_id_owner(id: &vector<u8>, account: &MemWalAccount): u64 {
        let owner_bytes = sui::bcs::to_bytes(&account.owner);
        assert!(
            id.length() >= owner_bytes.length() + SEAL_ID_COUNTER_LENGTH,
            ENoAccess,
        );
        let counter = seal_id_counter(id);
        let mut expected = owner_bytes;
        expected.append(sui::bcs::to_bytes(&counter));
        assert!(has_suffix(id, &expected), ENoAccess);
        counter
    }

    /// Check if `data` ends with `suffix`.
    /// Used for flexible key ID matching (with or without package prefix).
    fun has_suffix(data: &vector<u8>, suffix: &vector<u8>): bool {
        let data_len = data.length();
        let suffix_len = suffix.length();
        if (suffix_len > data_len) return false;
        let offset = data_len - suffix_len;
        let mut i = 0;
        while (i < suffix_len) {
            if (data[offset + i] != suffix[i]) return false;
            i = i + 1;
        };
        true
    }

    // ============================================================
    // Test helpers
    // ============================================================

    #[test_only]
    public fun test_init(ctx: &mut TxContext) {
        init(ctx);
    }

    /// Create an `AdminCap` for tests (init transfers the real one to the
    /// publisher; tests mint their own to avoid test_scenario plumbing).
    #[test_only]
    public fun test_make_admin_cap(ctx: &mut TxContext): AdminCap {
        AdminCap { id: object::new(ctx) }
    }

    #[test_only]
    public fun test_migration_merkle_parent(
        left: &vector<u8>,
        right: &vector<u8>,
    ): vector<u8> {
        migration_merkle_parent(left, right)
    }

    /// Populate a delegate slot without exercising Merkle verification. Tests
    /// that target full-account behavior use this to avoid spending their
    /// instruction budget on unrelated cap minting and proof hashing.
    #[test_only]
    public fun test_push_delegate_key_unchecked(
        account: &mut MemWalAccount,
        public_key: vector<u8>,
    ) {
        assert!(account.delegate_keys.length() < MAX_DELEGATE_KEYS, ETooManyDelegateKeys);
        account.delegate_keys.push_back(DelegateKey {
            public_key,
            sui_address: @0x0,
            label: std::string::utf8(b"test fixture"),
            created_at: 0,
        });
    }

    /// Force the registry's stored version, to exercise the `EWrongVersion`
    /// gate in tests (simulates an un-migrated registry after a package upgrade).
    #[test_only]
    public fun test_set_registry_version(registry: &mut AccountRegistry, v: u64) {
        registry.version = v;
    }

    #[test_only]
    /// Force the migration latch. Lets tests reach states the production gates
    /// make mutually exclusive (e.g. a native account while imports are open).
    public fun test_set_migration_finalized(registry: &mut AccountRegistry, finalized: bool) {
        registry.migration_finalized = finalized;
    }
}
