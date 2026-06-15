/// Walrus Memory (WM) — Namespace / Authorization layer (V2)
///
/// This is the **authorization** layer. A `MemoryNamespace` is one resource
/// boundary; its `acl` is the single source of truth for "what may principal P do
/// on THIS resource?". It is joined to the authentication layer
/// (`walrus_memory::account`) only by the principal address — `account.owner` is
/// the key looked up in `namespace.acl`. No namespace ever stores an `account_id`;
/// that decoupling is what makes ownership transfer an ACL edit instead of a
/// re-encryption (design §11).
///
/// The Seal identity is **owner-free and namespace-anchored**:
///   `inner_id = bcs(object::id(namespace)) ‖ bcs(key_version)`
/// (built in `walrus_memory::seal`). Ownership lives in this on-chain ACL, never
/// in the ciphertext.
///
/// ## Encryption coupling (DEK envelope — design "DEK Envelope Encryption")
/// `current_key_version` is the active generation for new writes; `wrapped_deks`
/// holds one Seal-wrapped DEK per generation. The blob bytes (AES-256-GCM under
/// the DEK) live on Walrus; only the 32-byte wrapped DEK lives here.
///
/// ## Deferred (per migration §17.0 — bundle only the irreversible bits)
/// - key rotation operations (`bump_key_version`) + crypto-shred — the FIELD ships
///   now (`current_key_version`, `wrapped_deks`), the machinery is a later Class-A
///   add (no re-encryption needed).
/// - GRANT-delegation depth, multi-owner / co-owners, guests. ACL management here
///   is owner-only for now.
module walrus_memory::namespace {
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::Clock;
    use walrus_memory::account::{Self, Account, AccountRegistry, AdminCap, MigrationCap};

    // ============================================================
    // Error Codes
    // ============================================================

    /// Caller is not the namespace owner
    const ENotNamespaceOwner: u64 = 200;
    /// Caller lacks the required permission on this namespace
    const ENoPermission: u64 = 201;
    /// Permission mask sets bits outside the valid range
    const EInvalidPerms: u64 = 202;
    /// The supplied MemBlob does not belong to the supplied namespace
    const EWrongNamespace: u64 = 203;
    /// Cannot write an ACL entry for the owner (owner is implicitly FULL)
    const EOwnerNotInAcl: u64 = 204;
    /// Object version does not match the current package VERSION
    const EAlreadyMigrated: u64 = 205;

    // ============================================================
    // Permission bits (canonical definitions for the whole package)
    // ============================================================

    /// Decrypt / fetch memories — required for `seal_approve` to pass.
    const READ: u8 = 1;
    /// Create / update memories (new blobs under current key_version).
    const WRITE: u8 = 2;
    /// Add / remove other principals in the ACL (delegated admin). [reserved]
    const GRANT: u8 = 4;
    /// Rotate key_version, manage envelope / namespace settings. [reserved]
    const ADMIN: u8 = 8;
    /// READ | WRITE | GRANT | ADMIN.
    const FULL: u8 = 15;

    // ============================================================
    // Structs
    // ============================================================

    /// Authorization object — one resource boundary. `seal_approve` reads this.
    public struct MemoryNamespace has key, store {
        id: UID,
        /// Current owner principal (implicitly FULL; never stored in `acl`).
        owner: address,
        /// principal address -> permission bits.
        acl: Table<address, u8>,
        /// Active Seal key generation for new writes.
        current_key_version: u32,
        /// key_version -> Seal-wrapped DEK (the DEK leg of the envelope).
        wrapped_deks: Table<u32, vector<u8>>,
        created_at: u64,
    }

    /// Thin on-chain pointer to one encrypted memory. Holds NO access-control
    /// state — authz is always evaluated against the governing namespace.
    public struct MemBlob has key, store {
        id: UID,
        /// Which namespace governs this memory (authz anchor).
        namespace_id: ID,
        /// Walrus content address.
        blob_id: vector<u8>,
        /// Which wrapped DEK decrypts this blob.
        key_version: u32,
        created_at: u64,
    }

    // ============================================================
    // Events
    // ============================================================

    public struct NamespaceCreated has copy, drop {
        namespace_id: ID,
        owner: address,
        key_version: u32,
    }

    public struct AclUpdated has copy, drop {
        namespace_id: ID,
        principal: address,
        perms: u8,
    }

    public struct AclRemoved has copy, drop {
        namespace_id: ID,
        principal: address,
    }

    public struct NamespaceOwnershipTransferred has copy, drop {
        namespace_id: ID,
        previous_owner: address,
        new_owner: address,
    }

    public struct MemoryRecorded has copy, drop {
        mem_blob_id: ID,
        namespace_id: ID,
        blob_id: vector<u8>,
        key_version: u32,
    }

    public struct MemoryDeleted has copy, drop {
        mem_blob_id: ID,
        namespace_id: ID,
        blob_id: vector<u8>,
    }

    public struct NamespaceMigrated has copy, drop { namespace_id: ID, to: u64 }

    // ============================================================
    // Namespace creation
    // ============================================================

    /// Create a namespace owned by the caller, seeding `wrapped_deks[1]` with the
    /// initial Seal-wrapped DEK (generated server-side).
    entry fun create_namespace(
        initial_wrapped_dek: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let ns = new_namespace(ctx.sender(), initial_wrapped_dek, clock.timestamp_ms(), ctx);
        transfer::share_object(ns);
    }

    /// Create a namespace on behalf of `owner` without their signature. Gated by
    /// `MigrationCap` (Phase 3: one namespace per imported account).
    entry fun admin_create_namespace(
        _cap: &MigrationCap,
        owner: address,
        initial_wrapped_dek: vector<u8>,
        created_at: u64,
        ctx: &mut TxContext,
    ) {
        let ns = new_namespace(owner, initial_wrapped_dek, created_at, ctx);
        transfer::share_object(ns);
    }

    // ============================================================
    // ACL management (owner-only; GRANT-delegation deferred)
    // ============================================================

    /// Grant / update a principal's permission bits. Owner-only.
    entry fun set_acl(
        ns: &mut MemoryNamespace,
        principal: address,
        perms: u8,
        ctx: &TxContext,
    ) {
        account::assert_object_version(&ns.id);
        assert!(ctx.sender() == ns.owner, ENotNamespaceOwner);
        assert!(perms & (FULL ^ 0xFF) == 0, EInvalidPerms);
        assert!(principal != ns.owner, EOwnerNotInAcl);

        if (ns.acl.contains(principal)) {
            *ns.acl.borrow_mut(principal) = perms;
        } else {
            ns.acl.add(principal, perms);
        };
        event::emit(AclUpdated { namespace_id: object::id(ns), principal, perms });
    }

    /// Remove a principal from the ACL. Owner-only. No-op-safe (aborts only on
    /// version/owner check; removing an absent principal is a silent success).
    entry fun remove_acl(ns: &mut MemoryNamespace, principal: address, ctx: &TxContext) {
        account::assert_object_version(&ns.id);
        assert!(ctx.sender() == ns.owner, ENotNamespaceOwner);
        if (ns.acl.contains(principal)) {
            let _: u8 = ns.acl.remove(principal);
            event::emit(AclRemoved { namespace_id: object::id(ns), principal });
        };
    }

    /// Transfer ownership. Owner-only. Pure state mutation — NO re-encryption: the
    /// Seal identity `(namespace_id, key_version)` is unchanged; the new owner
    /// passes `seal_approve` immediately because step 3 reads `namespace.owner`.
    /// (For a forward cut-off of the old owner, pair with a future key_version
    /// bump — deferred §17.0.)
    entry fun transfer_namespace_ownership(
        ns: &mut MemoryNamespace,
        new_owner: address,
        ctx: &TxContext,
    ) {
        account::assert_object_version(&ns.id);
        assert!(ctx.sender() == ns.owner, ENotNamespaceOwner);
        let previous_owner = ns.owner;
        ns.owner = new_owner;
        event::emit(NamespaceOwnershipTransferred {
            namespace_id: object::id(ns),
            previous_owner,
            new_owner,
        });
    }

    // ============================================================
    // Memory records (saga write/delete legs — design storage §9)
    // ============================================================

    /// Record a memory under the namespace's CURRENT key_version. Requires WRITE
    /// in the effective rights (delegate-resolved, same authn+authz as
    /// `seal_approve` but for the write path). The new `MemBlob` is owned by the
    /// caller (server-owned blob model, storage §5). `blob_id` is content-addressed
    /// (idempotent retry).
    entry fun record_memory(
        account: &Account,
        ns: &MemoryNamespace,
        registry: &AccountRegistry,
        blob_id: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_write(account, ns, registry, ctx.sender());

        let mem_blob = MemBlob {
            id: object::new(ctx),
            namespace_id: object::id(ns),
            blob_id,
            key_version: ns.current_key_version,
            created_at: clock.timestamp_ms(),
        };
        event::emit(MemoryRecorded {
            mem_blob_id: object::id(&mem_blob),
            namespace_id: mem_blob.namespace_id,
            blob_id: mem_blob.blob_id,
            key_version: mem_blob.key_version,
        });
        transfer::transfer(mem_blob, ctx.sender());
    }

    /// Delete a memory record (chain-first; Walrus storage reclaim follows
    /// off-chain). Requires WRITE in the effective rights and that the blob
    /// belongs to this namespace.
    entry fun delete_memory(
        mem_blob: MemBlob,
        account: &Account,
        ns: &MemoryNamespace,
        registry: &AccountRegistry,
        ctx: &TxContext,
    ) {
        assert!(mem_blob.namespace_id == object::id(ns), EWrongNamespace);
        assert_write(account, ns, registry, ctx.sender());

        let mem_blob_id = object::id(&mem_blob);
        let MemBlob { id, namespace_id, blob_id, key_version: _, created_at: _ } = mem_blob;
        event::emit(MemoryDeleted { mem_blob_id, namespace_id, blob_id });
        object::delete(id);
    }

    /// Write-path authorization: resolve the signer to its principal + delegate
    /// authority (`account::authn`), intersect with the principal's namespace ACL,
    /// and require WRITE. Mirrors `seal_approve`'s authn+authz (which gates READ),
    /// so delegate writes work exactly like delegate reads. The shared building
    /// blocks (`account::authn`, `acl_bits_for`) keep the two paths consistent.
    fun assert_write(
        account: &Account,
        ns: &MemoryNamespace,
        registry: &AccountRegistry,
        caller: address,
    ) {
        account::assert_object_version(&ns.id);
        assert!(account::is_active(account), ENoPermission);
        let principal = account::owner(account);
        assert!(
            account::is_canonical_account(registry, principal, object::id(account)),
            ENoPermission,
        );
        let delegate_perms = account::authn(account, caller);
        let acl_bits = acl_bits_for(ns, principal);
        assert!((acl_bits & delegate_perms) & WRITE != 0, ENoPermission);
    }

    // ============================================================
    // Migration (version-gating)
    // ============================================================

    /// Admin migration of a `MemoryNamespace` to the current VERSION.
    entry fun admin_migrate_namespace(_admin: &AdminCap, ns: &mut MemoryNamespace) {
        assert!(account::object_version(&ns.id) < account::current_version(), EAlreadyMigrated);
        account::stamp_version(&mut ns.id);
        event::emit(NamespaceMigrated { namespace_id: object::id(ns), to: account::current_version() });
    }

    // ============================================================
    // Package-internal accessors (used by the seal module)
    // ============================================================

    /// AUTHZ: what may `principal` do on THIS namespace? Owner is implicitly FULL;
    /// otherwise the ACL entry, or 0 if absent.
    public(package) fun acl_bits_for(ns: &MemoryNamespace, principal: address): u8 {
        if (principal == ns.owner) {
            FULL
        } else if (ns.acl.contains(principal)) {
            *ns.acl.borrow(principal)
        } else {
            0
        }
    }

    /// The READ bit — `seal_approve` requires it in the effective rights.
    public(package) fun read_bit(): u8 { READ }

    /// Active key generation (the highest version a reader may need to bind to).
    public(package) fun current_key_version(ns: &MemoryNamespace): u32 {
        ns.current_key_version
    }

    /// Assert the namespace is on the current VERSION (downgrade guard).
    public(package) fun assert_namespace_version(ns: &MemoryNamespace) {
        account::assert_object_version(&ns.id);
    }

    // ============================================================
    // Public views
    // ============================================================

    public fun namespace_owner(ns: &MemoryNamespace): address { ns.owner }
    public fun key_version(ns: &MemoryNamespace): u32 { ns.current_key_version }
    public fun has_acl_entry(ns: &MemoryNamespace, principal: address): bool {
        ns.acl.contains(principal)
    }
    public fun acl_perms(ns: &MemoryNamespace, principal: address): u8 {
        *ns.acl.borrow(principal)
    }
    public fun has_wrapped_dek(ns: &MemoryNamespace, v: u32): bool {
        ns.wrapped_deks.contains(v)
    }
    public fun wrapped_dek(ns: &MemoryNamespace, v: u32): &vector<u8> {
        ns.wrapped_deks.borrow(v)
    }

    public fun mem_namespace_id(mem_blob: &MemBlob): ID { mem_blob.namespace_id }
    public fun mem_blob_id(mem_blob: &MemBlob): &vector<u8> { &mem_blob.blob_id }
    public fun mem_key_version(mem_blob: &MemBlob): u32 { mem_blob.key_version }

    // Permission bit getters for off-chain consumers.
    public fun perm_read(): u8 { READ }
    public fun perm_write(): u8 { WRITE }
    public fun perm_grant(): u8 { GRANT }
    public fun perm_admin(): u8 { ADMIN }
    public fun perm_full(): u8 { FULL }

    // ============================================================
    // Internal helpers
    // ============================================================

    fun new_namespace(
        owner: address,
        initial_wrapped_dek: vector<u8>,
        created_at: u64,
        ctx: &mut TxContext,
    ): MemoryNamespace {
        let mut wrapped_deks = table::new<u32, vector<u8>>(ctx);
        wrapped_deks.add(1, initial_wrapped_dek);

        let mut ns = MemoryNamespace {
            id: object::new(ctx),
            owner,
            acl: table::new<address, u8>(ctx),
            current_key_version: 1,
            wrapped_deks,
            created_at,
        };
        account::stamp_version(&mut ns.id);

        event::emit(NamespaceCreated {
            namespace_id: object::id(&ns),
            owner,
            key_version: 1,
        });
        ns
    }

    // ============================================================
    // Test helpers
    // ============================================================

    #[test_only]
    public fun test_create_namespace(
        owner: address,
        initial_wrapped_dek: vector<u8>,
        ctx: &mut TxContext,
    ): MemoryNamespace {
        new_namespace(owner, initial_wrapped_dek, 0, ctx)
    }

    #[test_only]
    public fun test_set_acl(ns: &mut MemoryNamespace, principal: address, perms: u8, ctx: &TxContext) {
        set_acl(ns, principal, perms, ctx);
    }

    #[test_only]
    public fun test_transfer_ownership(ns: &mut MemoryNamespace, new_owner: address, ctx: &TxContext) {
        transfer_namespace_ownership(ns, new_owner, ctx);
    }

    /// Force a downgraded object version to exercise the version guard.
    #[test_only]
    public fun test_force_version(ns: &mut MemoryNamespace, v: u64) {
        account::test_set_object_version(&mut ns.id, v);
    }

    #[test_only]
    public fun test_record_memory(
        account: &Account,
        ns: &MemoryNamespace,
        registry: &AccountRegistry,
        blob_id: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        record_memory(account, ns, registry, blob_id, clock, ctx);
    }

    #[test_only]
    public fun test_delete_memory(
        mem_blob: MemBlob,
        account: &Account,
        ns: &MemoryNamespace,
        registry: &AccountRegistry,
        ctx: &TxContext,
    ) {
        delete_memory(mem_blob, account, ns, registry, ctx);
    }
}
