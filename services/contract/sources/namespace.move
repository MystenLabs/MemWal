/// Walrus Memory V2 namespace, ACL, and encryption-key policy.
///
/// `MemWalAccount` is the root identity and emergency-containment boundary.
/// `MemoryNamespace` is the operational authorization boundary: current
/// arbitrary Sui principals receive namespace-scoped READ/WRITE, while trusted
/// current account delegates may additionally receive SHARE. Memory payloads
/// are encrypted off chain with AES-256-GCM under a
/// namespace DEK; one Seal-wrapped DEK is stored for each key version.
module memwal::namespace {
    use std::bcs;
    use std::string::String;
    use sui::clock::Clock;
    use sui::event;
    use sui::table::{Self, Table};
    use memwal::account::{Self, AccountRegistry, AdminCap, MemWalAccount};

    // Registry, linkage, and lifecycle.
    const EWrongVersion: u64 = 0;
    const EAlreadyMigrated: u64 = 1;
    const ENotAccountOwner: u64 = 2;
    const EAccountMismatch: u64 = 3;
    const EAccountInactive: u64 = 4;
    const ENamespaceAlreadyExists: u64 = 5;
    const ENamespaceInactive: u64 = 6;
    const ENamespaceAlreadyActive: u64 = 7;
    const ENamespaceDestroyed: u64 = 8;
    const EInvalidLabel: u64 = 9;

    // Principal and ACL policy.
    const EInvalidPrincipal: u64 = 10;
    const EShareRequiresAccountDelegate: u64 = 11;
    const EInvalidPermissions: u64 = 12;
    const EWriteRequiresRead: u64 = 13;
    const EPermissionsUnchanged: u64 = 14;
    const EGrantNotFound: u64 = 15;
    const ENoReadAccess: u64 = 16;
    const ENoWriteAccess: u64 = 17;
    const ENoShareAccess: u64 = 18;
    const ECannotModifyOwnPermissions: u64 = 19;
    const EOnlyOwnerCanManageShare: u64 = 20;

    // Key initialization, rotation, and Seal policy.
    const EKeyNotInitialized: u64 = 21;
    const EKeyAlreadyInitialized: u64 = 22;
    const EInvalidWrappedDek: u64 = 23;
    const EKeyVersionNotFound: u64 = 24;
    const EKeyVersionShredded: u64 = 25;
    const ENotCurrentKeyVersion: u64 = 26;
    const ECannotShredCurrentVersion: u64 = 27;
    const EInvalidSealId: u64 = 28;
    const EShareRequiresRead: u64 = 30;
    const EInvalidCommitment: u64 = 31;

    /// Global behavior version. Older package bytecode fails after the shared
    /// registry advances; the current package then becomes the only active
    /// policy. Namespace objects deliberately have no per-object version, so a
    /// behavior upgrade does not require migrating every namespace.
    const VERSION: u64 = 1;
    const MAX_LABEL_LENGTH: u64 = 64;
    const MAX_WRAPPED_DEK_LENGTH: u64 = 16384;
    const SEAL_ID_VERSION_LENGTH: u64 = 8;
    /// Blake2b-256 / SHA-256 digest bound for `write_fence` commitments.
    const COMMITMENT_LENGTH: u64 = 32;

    const PERMISSION_READ: u8 = 1;
    const PERMISSION_WRITE: u8 = 2;
    const PERMISSION_SHARE: u8 = 4;

    /// Shared uniqueness index and package-wide behavior gate.
    public struct NamespaceRegistry has key {
        id: UID,
        /// blake2b256(BCS(account_id) || BCS(label)) -> namespace object ID.
        /// Initialized or shredded namespaces stay as permanent tombstones so
        /// old ciphertext cannot be rebound to a new policy under the same
        /// label. An uninitialized reservation may be released by
        /// `cancel_uninitialized_namespace` before any DEK exists.
        namespaces: Table<vector<u8>, ID>,
        version: u64,
    }

    /// One namespace AES-256-GCM data-key cohort.
    ///
    /// `wrapped_dek` is a Seal encrypted object, safe to publish. The contract
    /// computes its Blake2b-256 commitment itself; callers cannot commit to
    /// unrelated bytes. Move cannot parse the Seal envelope, so malformed bytes
    /// can only deny service to the namespace owner, never bypass authorization.
    public struct KeyVersionState has store {
        wrapped_dek: vector<u8>,
        commitment: vector<u8>,
        created_at_ms: u64,
        retired_at_ms: Option<u64>,
        shredded_at_ms: Option<u64>,
    }

    /// Namespace-scoped ACL and key lifecycle. READ/WRITE rows may target any
    /// nonzero Sui address; SHARE rows are restricted to current account
    /// delegates, preserving the bounded delegate vector as a trusted-admin
    /// tier rather than an account-wide agent cap.
    ///
    /// Creation and key initialization are intentionally separate: the Seal ID
    /// includes this object's ID, which is only known after creation. `destroyed`
    /// is a terminal O(1) policy latch; Seal approval checks it before any
    /// per-version state. That latch is the namespace-level erasure primitive:
    /// wrapped DEKs may remain as public Seal ciphertext, but the committee
    /// will never unwrap them once this bit is set. Per-version shred additionally
    /// wipes stored bytes for a retired cohort and refunds that field.
    public struct MemoryNamespace has key {
        id: UID,
        account_id: ID,
        owner: address,
        label: String,
        permissions: Table<address, u8>,
        key_versions: Table<u64, KeyVersionState>,
        current_key_version: u64,
        key_initialized: bool,
        active: bool,
        destroyed: bool,
        created_at_ms: u64,
    }

    // ============================================================
    // Events
    // ============================================================

    public struct NamespaceCreated has copy, drop {
        namespace_id: ID,
        account_id: ID,
        owner: address,
        label: String,
        created_at_ms: u64,
    }

    public struct NamespaceInitialized has copy, drop {
        namespace_id: ID,
        account_id: ID,
        key_version: u64,
        key_commitment: vector<u8>,
        initialized_at_ms: u64,
    }

    public struct AccessUpdated has copy, drop {
        namespace_id: ID,
        account_id: ID,
        principal: address,
        old_permissions: u8,
        new_permissions: u8,
        updated_by: address,
        updated_at_ms: u64,
    }

    public struct AccessRevoked has copy, drop {
        namespace_id: ID,
        account_id: ID,
        principal: address,
        old_permissions: u8,
        revoked_by: address,
        key_rotated: bool,
        current_key_version: u64,
        revoked_at_ms: u64,
    }

    public struct KeyRotated has copy, drop {
        namespace_id: ID,
        account_id: ID,
        previous_version: u64,
        new_version: u64,
        key_commitment: vector<u8>,
        rotated_by: address,
        rotated_at_ms: u64,
    }

    public struct KeyVersionShredded has copy, drop {
        namespace_id: ID,
        account_id: ID,
        key_version: u64,
        key_commitment: vector<u8>,
        shredded_at_ms: u64,
    }

    public struct NamespaceDeactivated has copy, drop {
        namespace_id: ID,
        account_id: ID,
        owner: address,
        deactivated_at_ms: u64,
    }

    public struct NamespaceReactivated has copy, drop {
        namespace_id: ID,
        account_id: ID,
        owner: address,
        reactivated_at_ms: u64,
    }

    public struct NamespaceDestroyed has copy, drop {
        namespace_id: ID,
        account_id: ID,
        owner: address,
        key_initialized: bool,
        last_key_version: u64,
        destroyed_at_ms: u64,
    }

    public struct NamespaceCancelled has copy, drop {
        namespace_id: ID,
        account_id: ID,
        owner: address,
        label: String,
        cancelled_at_ms: u64,
    }

    /// On-chain write receipt for WALM-352 receipts / hash-chain anchoring.
    /// The contract stores only the digest; the relayer binds it to the Walrus
    /// blob in the same PTB.
    public struct MemoryWritten has copy, drop {
        namespace_id: ID,
        account_id: ID,
        key_version: u64,
        commitment: vector<u8>,
        writer: address,
        written_at_ms: u64,
    }

    public struct NamespaceRegistryMigrated has copy, drop {
        registry_id: ID,
        from: u64,
        to: u64,
    }

    // ============================================================
    // Init and upgrade
    // ============================================================

    fun init(ctx: &mut TxContext) {
        transfer::share_object(NamespaceRegistry {
            id: object::new(ctx),
            namespaces: table::new(ctx),
            version: VERSION,
        });
    }

    /// Advance the single global namespace behavior gate after a compatible
    /// package upgrade. Struct-layout changes require a new object type instead.
    entry fun migrate_namespace_registry(
        _admin: &AdminCap,
        registry: &mut NamespaceRegistry,
    ) {
        let from = registry.version;
        assert!(from < VERSION, EAlreadyMigrated);
        registry.version = VERSION;
        event::emit(NamespaceRegistryMigrated {
            registry_id: object::id(registry),
            from,
            to: VERSION,
        });
    }

    // ============================================================
    // Namespace lifecycle
    // ============================================================

    /// Phase one: reserve a permanent account+label identity and share an
    /// inactive namespace object. Call `initialize_key` after its ID is known.
    entry fun create_namespace(
        registry: &mut NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        label: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_current_versions(registry, account_registry);
        assert!(account::is_active(account), EAccountInactive);
        assert!(account::owner(account) == ctx.sender(), ENotAccountOwner);
        assert!(label.as_bytes().length() > 0 && label.as_bytes().length() <= MAX_LABEL_LENGTH, EInvalidLabel);

        let account_id = object::id(account);
        let uniqueness_key = namespace_key(account_id, &label);
        assert!(!registry.namespaces.contains(uniqueness_key), ENamespaceAlreadyExists);

        let namespace = MemoryNamespace {
            id: object::new(ctx),
            account_id,
            owner: ctx.sender(),
            label,
            permissions: table::new(ctx),
            key_versions: table::new(ctx),
            current_key_version: 0,
            key_initialized: false,
            active: false,
            destroyed: false,
            created_at_ms: clock.timestamp_ms(),
        };
        let namespace_id = object::id(&namespace);
        registry.namespaces.add(uniqueness_key, namespace_id);
        event::emit(NamespaceCreated {
            namespace_id,
            account_id,
            owner: ctx.sender(),
            label,
            created_at_ms: clock.timestamp_ms(),
        });
        transfer::share_object(namespace);
    }

    /// Phase two: install the version-zero Seal-wrapped DEK and activate the
    /// namespace. Only the account owner may initialize it, exactly once.
    entry fun initialize_key(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        wrapped_dek: vector<u8>,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_linked(registry, account_registry, account, namespace);
        assert!(account::is_active(account), EAccountInactive);
        assert_owner(namespace, ctx.sender());
        assert!(!namespace.destroyed, ENamespaceDestroyed);
        assert!(!namespace.key_initialized, EKeyAlreadyInitialized);
        assert_valid_wrapped_dek(&wrapped_dek);

        let now = clock.timestamp_ms();
        let commitment = sui::hash::blake2b256(&wrapped_dek);
        namespace.key_versions.add(0, KeyVersionState {
            wrapped_dek,
            commitment,
            created_at_ms: now,
            retired_at_ms: option::none(),
            shredded_at_ms: option::none(),
        });
        namespace.current_key_version = 0;
        namespace.key_initialized = true;
        namespace.active = true;
        event::emit(NamespaceInitialized {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            key_version: 0,
            key_commitment: commitment,
            initialized_at_ms: now,
        });
    }

    /// Reversible namespace freeze. This remains available while the parent
    /// account is inactive so an owner can narrow containment further.
    entry fun deactivate_namespace(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_linked(registry, account_registry, account, namespace);
        assert_owner(namespace, ctx.sender());
        assert!(!namespace.destroyed, ENamespaceDestroyed);
        assert!(namespace.active, ENamespaceInactive);
        namespace.active = false;
        event::emit(NamespaceDeactivated {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            owner: namespace.owner,
            deactivated_at_ms: clock.timestamp_ms(),
        });
    }

    entry fun reactivate_namespace(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_linked(registry, account_registry, account, namespace);
        assert!(account::is_active(account), EAccountInactive);
        assert_owner(namespace, ctx.sender());
        assert!(!namespace.destroyed, ENamespaceDestroyed);
        assert!(namespace.key_initialized, EKeyNotInitialized);
        assert!(!namespace.active, ENamespaceAlreadyActive);
        namespace.active = true;
        event::emit(NamespaceReactivated {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            owner: namespace.owner,
            reactivated_at_ms: clock.timestamp_ms(),
        });
    }

    /// Terminal, constant-cost namespace crypto-shred. This is a policy latch,
    /// not a table walk: `destroyed` makes `seal_approve` deny every version, so
    /// the Seal committee will never unwrap remaining public DEK ciphertext.
    /// That is the PRD erasure primitive. Per-version shred additionally wipes
    /// stored bytes for a retired cohort; namespace shred does not, because an
    /// unbounded dynamic-field walk would make erasure itself DoS-able.
    entry fun crypto_shred_namespace(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_linked(registry, account_registry, account, namespace);
        assert!(account::is_active(account), EAccountInactive);
        assert_owner(namespace, ctx.sender());
        assert!(!namespace.destroyed, ENamespaceDestroyed);
        namespace.active = false;
        namespace.destroyed = true;
        event::emit(NamespaceDestroyed {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            owner: namespace.owner,
            key_initialized: namespace.key_initialized,
            last_key_version: namespace.current_key_version,
            destroyed_at_ms: clock.timestamp_ms(),
        });
    }

    /// Release an unused two-phase reservation. Allowed only before
    /// `initialize_key`: no DEK exists, so no ciphertext can be rebound. The
    /// registry entry is removed so the label can be reused; the orphaned
    /// object is latched destroyed so it can never be initialized later.
    entry fun cancel_uninitialized_namespace(
        registry: &mut NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_linked(registry, account_registry, account, namespace);
        assert_owner(namespace, ctx.sender());
        assert!(!namespace.destroyed, ENamespaceDestroyed);
        assert!(!namespace.key_initialized, EKeyAlreadyInitialized);

        let uniqueness_key = namespace_key(namespace.account_id, &namespace.label);
        registry.namespaces.remove(uniqueness_key);
        namespace.active = false;
        namespace.destroyed = true;
        event::emit(NamespaceCancelled {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            owner: namespace.owner,
            label: namespace.label,
            cancelled_at_ms: clock.timestamp_ms(),
        });
    }

    // ============================================================
    // ACL
    // ============================================================

    /// Add or replace an ACL role. WRITE and SHARE both imply READ. The owner
    /// may manage all bits. A current trusted delegate with SHARE may manage
    /// READ/WRITE for any other principal, but cannot edit itself or
    /// grant/revoke SHARE. Removing all access uses `revoke_access`, which
    /// atomically rotates the key.
    entry fun grant_access(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        principal: address,
        can_read: bool,
        can_write: bool,
        can_share: bool,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_ready(registry, account_registry, account, namespace);
        let new_permissions = permission_bits(can_read, can_write, can_share);
        assert!(new_permissions != 0, EInvalidPermissions);
        assert!(!can_write || can_read, EWriteRequiresRead);
        assert!(!can_share || can_read, EShareRequiresRead);
        assert_valid_principal(account, namespace, principal, can_share);

        let old_permissions = if (namespace.permissions.contains(principal)) {
            *namespace.permissions.borrow(principal)
        } else {
            0
        };
        assert_acl_manager(account, namespace, principal, old_permissions, can_share, ctx.sender());
        assert!(old_permissions != new_permissions, EPermissionsUnchanged);

        if (namespace.permissions.contains(principal)) {
            *namespace.permissions.borrow_mut(principal) = new_permissions;
        } else {
            namespace.permissions.add(principal, new_permissions);
        };
        event::emit(AccessUpdated {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            principal,
            old_permissions,
            new_permissions,
            updated_by: ctx.sender(),
            updated_at_ms: clock.timestamp_ms(),
        });
    }

    /// Remove all permissions and atomically rotate the DEK. Every valid ACL
    /// role contains READ, including SHARE administrators, so every full revoke
    /// closes future ciphertext access.
    ///
    /// A non-owner revoker must already have READ before it may supply the
    /// replacement key. That is an accepted trust assumption, not extra privilege:
    /// a principal with current READ already holds historical plaintext, so they
    /// can already leak it off chain. Letting them wrap K_{v+1} only excludes the
    /// revoked principal from *future* ciphertext. A garbage DEK is owner-recoverable
    /// via `rotate_key`.
    entry fun revoke_access(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        principal: address,
        new_wrapped_dek: vector<u8>,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_ready(registry, account_registry, account, namespace);
        assert!(namespace.permissions.contains(principal), EGrantNotFound);
        let old_permissions = *namespace.permissions.borrow(principal);
        assert_acl_manager(account, namespace, principal, old_permissions, false, ctx.sender());

        assert!(has_permission(old_permissions, PERMISSION_READ), EInvalidPermissions);
        assert_can_supply_key(namespace, ctx.sender());
        namespace.permissions.remove(principal);
        rotate_key_internal(namespace, new_wrapped_dek, clock, ctx.sender());
        event::emit(AccessRevoked {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            principal,
            old_permissions,
            revoked_by: ctx.sender(),
            key_rotated: true,
            current_key_version: namespace.current_key_version,
            revoked_at_ms: clock.timestamp_ms(),
        });
    }

    // ============================================================
    // Key lifecycle
    // ============================================================

    /// Owner-controlled proactive DEK rotation. Historical versions remain
    /// available to principals that still have effective READ permission.
    entry fun rotate_key(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        new_wrapped_dek: vector<u8>,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_ready(registry, account_registry, account, namespace);
        assert_owner(namespace, ctx.sender());
        rotate_key_internal(namespace, new_wrapped_dek, clock, ctx.sender());
    }

    /// Permanently deny new Seal unwraps for one historical cohort. The current
    /// version must first be rotated. Previously downloaded DEKs/plaintext
    /// cannot be clawed back and are outside this on-chain guarantee.
    entry fun crypto_shred_key_version(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &mut MemoryNamespace,
        key_version: u64,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_ready(registry, account_registry, account, namespace);
        assert_owner(namespace, ctx.sender());
        assert!(key_version != namespace.current_key_version, ECannotShredCurrentVersion);
        assert!(namespace.key_versions.contains(key_version), EKeyVersionNotFound);
        let state = namespace.key_versions.borrow_mut(key_version);
        assert!(state.shredded_at_ms.is_none(), EKeyVersionShredded);
        let now = clock.timestamp_ms();
        let commitment = state.commitment;
        state.wrapped_dek = vector::empty();
        state.shredded_at_ms.fill(now);
        event::emit(KeyVersionShredded {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            key_version,
            key_commitment: commitment,
            shredded_at_ms: now,
        });
    }

    // ============================================================
    // Seal and write authorization
    // ============================================================

    /// Seal policy for a namespace DEK version.
    ///
    /// Canonical Seal ID:
    /// `[optional prefix] || BCS(namespace_object_id) || BCS(key_version)`
    /// where the mandatory suffix is exactly 40 bytes: 32-byte object ID then
    /// little-endian BCS `u64` version. Seal may prepend a domain-separation
    /// prefix (typically `BCS(package_id)`). The contract checks suffix equality
    /// only; SDKs must use the same BCS encoding (see golden vectors in tests).
    entry fun seal_approve(
        id: vector<u8>,
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &MemoryNamespace,
        ctx: &TxContext,
    ) {
        assert_ready(registry, account_registry, account, namespace);
        let key_version = assert_seal_id(&id, namespace);
        assert_key_decryptable(namespace, key_version);
        assert!(can_read(namespace, ctx.sender()), ENoReadAccess);
    }

    /// Linearization fence to place in the same PTB that persists/transfers a
    /// new Walrus Blob. It rejects a stale version, enforces effective WRITE,
    /// and emits a `MemoryWritten` receipt binding `(namespace, key_version,
    /// commitment, writer)` for WALM-352 receipts and hash-chain anchoring.
    /// `commitment` must be a 32-byte content digest; the contract does not
    /// interpret the bytes beyond that length bound.
    ///
    /// The on-chain ACL table is not enumerable. Authorization is authoritative
    /// here; WALM-352's indexer is the projection/display layer, rebuilt from
    /// `AccessUpdated` / `AccessRevoked` plus this write receipt stream.
    entry fun write_fence(
        id: vector<u8>,
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &MemoryNamespace,
        commitment: vector<u8>,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_ready(registry, account_registry, account, namespace);
        assert!(commitment.length() == COMMITMENT_LENGTH, EInvalidCommitment);
        let key_version = assert_seal_id(&id, namespace);
        assert!(key_version == namespace.current_key_version, ENotCurrentKeyVersion);
        assert_key_decryptable(namespace, key_version);
        assert!(can_write(namespace, ctx.sender()), ENoWriteAccess);
        event::emit(MemoryWritten {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            key_version,
            commitment,
            writer: ctx.sender(),
            written_at_ms: clock.timestamp_ms(),
        });
    }

    // ============================================================
    // Views
    // ============================================================

    public fun seal_key_id(namespace_id: ID, key_version: u64): vector<u8> {
        let mut id = bcs::to_bytes(&namespace_id);
        id.append(bcs::to_bytes(&key_version));
        id
    }

    public fun owner(namespace: &MemoryNamespace): address { namespace.owner }
    public fun account_id(namespace: &MemoryNamespace): ID { namespace.account_id }
    public fun label(namespace: &MemoryNamespace): &String { &namespace.label }
    public fun is_active(namespace: &MemoryNamespace): bool { namespace.active }
    public fun is_destroyed(namespace: &MemoryNamespace): bool { namespace.destroyed }
    public fun is_key_initialized(namespace: &MemoryNamespace): bool { namespace.key_initialized }
    public fun current_key_version(namespace: &MemoryNamespace): u64 { namespace.current_key_version }
    public fun created_at_ms(namespace: &MemoryNamespace): u64 { namespace.created_at_ms }
    public fun registry_version(registry: &NamespaceRegistry): u64 { registry.version }
    public fun current_version(): u64 { VERSION }
    public fun commitment_length(): u64 { COMMITMENT_LENGTH }

    public fun has_namespace(
        registry: &NamespaceRegistry,
        account_id: ID,
        label: &String,
    ): bool {
        registry.namespaces.contains(namespace_key(account_id, label))
    }

    public fun permissions(namespace: &MemoryNamespace, principal: address): u8 {
        if (principal == namespace.owner) return PERMISSION_READ | PERMISSION_WRITE | PERMISSION_SHARE;
        if (!namespace.permissions.contains(principal)) return 0;
        *namespace.permissions.borrow(principal)
    }

    public fun can_read(namespace: &MemoryNamespace, principal: address): bool {
        has_permission(permissions(namespace, principal), PERMISSION_READ)
    }

    public fun can_write(namespace: &MemoryNamespace, principal: address): bool {
        has_permission(permissions(namespace, principal), PERMISSION_WRITE)
    }

    public fun can_share(namespace: &MemoryNamespace, principal: address): bool {
        has_permission(permissions(namespace, principal), PERMISSION_SHARE)
    }

    public fun key_version_exists(namespace: &MemoryNamespace, key_version: u64): bool {
        namespace.key_versions.contains(key_version)
    }

    public fun wrapped_dek(namespace: &MemoryNamespace, key_version: u64): &vector<u8> {
        assert_key_exists(namespace, key_version);
        &namespace.key_versions.borrow(key_version).wrapped_dek
    }

    public fun key_commitment(namespace: &MemoryNamespace, key_version: u64): &vector<u8> {
        assert_key_exists(namespace, key_version);
        &namespace.key_versions.borrow(key_version).commitment
    }

    public fun key_created_at_ms(namespace: &MemoryNamespace, key_version: u64): u64 {
        assert_key_exists(namespace, key_version);
        namespace.key_versions.borrow(key_version).created_at_ms
    }

    public fun key_retired_at_ms(namespace: &MemoryNamespace, key_version: u64): Option<u64> {
        assert_key_exists(namespace, key_version);
        namespace.key_versions.borrow(key_version).retired_at_ms
    }

    public fun key_shredded_at_ms(namespace: &MemoryNamespace, key_version: u64): Option<u64> {
        assert_key_exists(namespace, key_version);
        namespace.key_versions.borrow(key_version).shredded_at_ms
    }

    public fun is_key_shredded(namespace: &MemoryNamespace, key_version: u64): bool {
        assert_key_exists(namespace, key_version);
        namespace.key_versions.borrow(key_version).shredded_at_ms.is_some()
    }

    // ============================================================
    // Internal policy helpers
    // ============================================================

    fun assert_current_versions(registry: &NamespaceRegistry, account_registry: &AccountRegistry) {
        assert!(registry.version == VERSION, EWrongVersion);
        assert!(account::registry_version(account_registry) == account::current_version(), EWrongVersion);
    }

    fun assert_linked(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &MemoryNamespace,
    ) {
        assert_current_versions(registry, account_registry);
        assert!(object::id(account) == namespace.account_id, EAccountMismatch);
        assert!(account::owner(account) == namespace.owner, EAccountMismatch);
    }

    fun assert_ready(
        registry: &NamespaceRegistry,
        account_registry: &AccountRegistry,
        account: &MemWalAccount,
        namespace: &MemoryNamespace,
    ) {
        assert_linked(registry, account_registry, account, namespace);
        assert!(account::is_active(account), EAccountInactive);
        assert!(!namespace.destroyed, ENamespaceDestroyed);
        assert!(namespace.key_initialized, EKeyNotInitialized);
        assert!(namespace.active, ENamespaceInactive);
    }

    fun assert_owner(namespace: &MemoryNamespace, caller: address) {
        assert!(namespace.owner == caller, ENotAccountOwner);
    }

    fun assert_valid_principal(
        account: &MemWalAccount,
        namespace: &MemoryNamespace,
        principal: address,
        receives_share: bool,
    ) {
        assert!(principal != @0x0 && principal != namespace.owner, EInvalidPrincipal);
        if (receives_share) {
            assert!(account::is_delegate_address(account, principal), EShareRequiresAccountDelegate);
        };
    }

    fun assert_acl_manager(
        account: &MemWalAccount,
        namespace: &MemoryNamespace,
        principal: address,
        target_old_permissions: u8,
        target_new_share: bool,
        caller: address,
    ) {
        if (caller == namespace.owner) return;
        assert!(account::is_delegate_address(account, caller), EShareRequiresAccountDelegate);
        assert!(can_share(namespace, caller), ENoShareAccess);
        assert!(principal != caller, ECannotModifyOwnPermissions);
        assert!(!target_new_share, EOnlyOwnerCanManageShare);
        assert!(
            !has_permission(target_old_permissions, PERMISSION_SHARE),
            EOnlyOwnerCanManageShare,
        );
    }

    /// Supplying a new wrapped DEK means choosing its plaintext before Seal
    /// encryption. Only the owner or a principal that already has effective READ
    /// may rotate: they already hold historical plaintext, so wrapping K_{v+1}
    /// grants no extra confidentiality privilege.
    fun assert_can_supply_key(namespace: &MemoryNamespace, caller: address) {
        if (caller == namespace.owner) return;
        assert!(can_read(namespace, caller), ENoReadAccess);
    }

    fun permission_bits(read: bool, write: bool, share: bool): u8 {
        (if (read) PERMISSION_READ else 0) |
            (if (write) PERMISSION_WRITE else 0) |
            (if (share) PERMISSION_SHARE else 0)
    }

    fun has_permission(value: u8, permission: u8): bool { value & permission == permission }

    fun namespace_key(account_id: ID, label: &String): vector<u8> {
        let mut bytes = bcs::to_bytes(&account_id);
        bytes.append(bcs::to_bytes(label));
        sui::hash::blake2b256(&bytes)
    }

    fun assert_valid_wrapped_dek(wrapped_dek: &vector<u8>) {
        assert!(
            wrapped_dek.length() > 0 && wrapped_dek.length() <= MAX_WRAPPED_DEK_LENGTH,
            EInvalidWrappedDek,
        );
    }

    fun rotate_key_internal(
        namespace: &mut MemoryNamespace,
        new_wrapped_dek: vector<u8>,
        clock: &Clock,
        rotated_by: address,
    ) {
        assert_valid_wrapped_dek(&new_wrapped_dek);
        // No artificial version cap: `Table` is O(1) dynamic fields, and Move
        // already aborts on u64 overflow. A 10_000 cap would deadlock revoke
        // (which always rotates) and permanently tombstone the label.
        let now = clock.timestamp_ms();
        let previous_version = namespace.current_key_version;
        namespace.key_versions.borrow_mut(previous_version).retired_at_ms.fill(now);
        let new_version = previous_version + 1;
        let commitment = sui::hash::blake2b256(&new_wrapped_dek);
        namespace.key_versions.add(new_version, KeyVersionState {
            wrapped_dek: new_wrapped_dek,
            commitment,
            created_at_ms: now,
            retired_at_ms: option::none(),
            shredded_at_ms: option::none(),
        });
        namespace.current_key_version = new_version;
        event::emit(KeyRotated {
            namespace_id: object::id(namespace),
            account_id: namespace.account_id,
            previous_version,
            new_version,
            key_commitment: commitment,
            rotated_by,
            rotated_at_ms: now,
        });
    }

    fun assert_key_exists(namespace: &MemoryNamespace, key_version: u64) {
        assert!(namespace.key_versions.contains(key_version), EKeyVersionNotFound);
    }

    fun assert_key_decryptable(namespace: &MemoryNamespace, key_version: u64) {
        assert_key_exists(namespace, key_version);
        assert!(namespace.key_versions.borrow(key_version).shredded_at_ms.is_none(), EKeyVersionShredded);
    }

    fun assert_seal_id(id: &vector<u8>, namespace: &MemoryNamespace): u64 {
        assert!(id.length() >= 32 + SEAL_ID_VERSION_LENGTH, EInvalidSealId);
        let version = decode_trailing_u64(id);
        let expected = seal_key_id(object::id(namespace), version);
        assert!(has_suffix(id, &expected), EInvalidSealId);
        version
    }

    fun decode_trailing_u64(id: &vector<u8>): u64 {
        let offset = id.length() - SEAL_ID_VERSION_LENGTH;
        let mut value = 0u64;
        let mut i = 0;
        while (i < SEAL_ID_VERSION_LENGTH) {
            value = value + ((id[offset + i] as u64) << ((8 * i) as u8));
            i = i + 1;
        };
        value
    }

    fun has_suffix(data: &vector<u8>, suffix: &vector<u8>): bool {
        if (suffix.length() > data.length()) return false;
        let offset = data.length() - suffix.length();
        let mut i = 0;
        while (i < suffix.length()) {
            if (data[offset + i] != suffix[i]) return false;
            i = i + 1;
        };
        true
    }

    // ============================================================
    // Test helpers
    // ============================================================

    #[test_only]
    public fun test_init(ctx: &mut TxContext) { init(ctx); }

    #[test_only]
    public fun test_set_registry_version(registry: &mut NamespaceRegistry, version: u64) {
        registry.version = version;
    }

    #[test_only]
    public fun test_set_owner(namespace: &mut MemoryNamespace, owner: address) {
        namespace.owner = owner;
    }

    #[test_only]
    public fun test_set_permissions(
        namespace: &mut MemoryNamespace,
        principal: address,
        value: u8,
    ) {
        *namespace.permissions.borrow_mut(principal) = value;
    }

    #[test_only]
    public fun test_has_suffix(data: &vector<u8>, suffix: &vector<u8>): bool {
        has_suffix(data, suffix)
    }

    #[test_only]
    public fun test_decode_trailing_u64(id: &vector<u8>): u64 {
        decode_trailing_u64(id)
    }

    #[test_only]
    public fun test_set_current_key_version(
        namespace: &mut MemoryNamespace,
        version: u64,
        wrapped_dek: vector<u8>,
    ) {
        if (!namespace.key_versions.contains(version)) {
            let commitment = sui::hash::blake2b256(&wrapped_dek);
            namespace.key_versions.add(version, KeyVersionState {
                wrapped_dek,
                commitment,
                created_at_ms: 0,
                retired_at_ms: option::none(),
                shredded_at_ms: option::none(),
            });
        };
        namespace.current_key_version = version;
    }
}
