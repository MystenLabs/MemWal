/// Walrus Memory (WM) — Account / Authentication layer (V2)
///
/// This is the **authentication** layer of the V2 data model. It answers the
/// question "does `ctx.sender()` legitimately speak for principal P?" where P is
/// either the account owner or one of its registered delegate keys. It says
/// nothing about *resources* — authorization lives in `walrus_memory::namespace`
/// (`MemoryNamespace` + ACL), joined to this layer by the principal address
/// (`account.owner`).
///
/// ## Objects
/// - `AccountRegistry`  : shared — `owner -> account_id` (one account per owner)
/// - `Account`          : shared — owner + delegate keys (each with a `perms` mask)
/// - `DelegateKey`      : ed25519 key + derived sui address + per-delegate `perms`
/// - `AdminCap`         : long-lived root governance cap (mints/burns `MigrationCap`)
/// - `MigrationCap`     : ephemeral cap for the no-signature migration forge path;
///                        burned at the end of the migration (Phase 7)
///
/// ## Capabilities (by lifecycle + blast radius — see design §10)
/// - `AdminCap`     : version migrates, mint/burn `MigrationCap`, (future: pause/config)
/// - `MigrationCap` : ONLY the forge entry points `admin_import_account` /
///                    `admin_add_delegate_key`. Burning it permanently removes the
///                    no-signature account-forge power.
///
/// ## Versioning (version-gating, cheap Class-A upgrades)
/// Governed objects carry a version in a dynamic field on their `UID`. Every
/// sensitive entry asserts the object is on the current `VERSION`. `migrate_*`
/// functions bump it; an object missing the field reads as `1` (legacy) and is
/// rejected — the downgrade guard.
///
/// SECURITY: `Account` is only constructible inside this module, and `owner` is
/// always set to `ctx.sender()` (forge path uses `MigrationCap`) and never has a
/// setter. This is what makes a forged `{owner: victim, delegate_keys: [me]}`
/// impossible — see `walrus_memory::seal::seal_approve` step 1 + the design's
/// attack table.
module walrus_memory::account {
    use std::string::String;
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::Clock;
    use sui::dynamic_field as df;

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
    /// Object/registry already at the target version
    const EAlreadyMigrated: u64 = 9;
    /// Delegate key label exceeds maximum allowed length
    const ELabelTooLong: u64 = 10;
    /// Account is already in the requested active state
    const EAccountAlreadyActive: u64 = 11;
    /// Delegate `perms` mask sets bits outside the valid permission range
    const EInvalidPerms: u64 = 12;
    /// Caller is not authorized to decrypt / authenticate (SEAL)
    const ENoAccess: u64 = 100;

    // ============================================================
    // Constants
    // ============================================================

    /// Maximum delegate keys per account
    const MAX_DELEGATE_KEYS: u64 = 20;
    /// Expected length of an Ed25519 public key in bytes
    const ED25519_PUBLIC_KEY_LENGTH: u64 = 32;
    /// Maximum allowed length of a delegate key label, in bytes
    const MAX_LABEL_LENGTH: u64 = 64;
    /// Mask of all valid permission bits (READ|WRITE|GRANT|ADMIN = 15).
    /// Canonical bit definitions live in `walrus_memory::namespace`; this mask is
    /// only used to reject delegate `perms` that set undefined bits.
    const PERMS_MASK: u8 = 0x0F;
    /// Authority of the owner's root key: all bits set. `0xFF & acl_bits ==
    /// acl_bits` for any valid `acl_bits`, so the owner key never narrows the
    /// namespace ACL. Avoids coupling this module to the permission-bit constants.
    const OWNER_ROOT_AUTHORITY: u8 = 0xFF;

    /// Current package version. Bump when shipping an upgrade that changes
    /// invariants of a governed object. P2 ships at VERSION = 2 so that any object
    /// lacking the version field (read as 1) is rejected by the downgrade guard.
    const VERSION: u64 = 2;

    /// Dynamic field key used to store the per-object version.
    const VERSION_DF_KEY: vector<u8> = b"version";

    // ============================================================
    // Structs
    // ============================================================

    /// Shared registry — `owner -> account_id`. Enforces one account per owner,
    /// which is what makes the `owner -> account` mapping 1:1 and the legacy
    /// account-id alias (design §13) unambiguous.
    public struct AccountRegistry has key {
        id: UID,
        accounts: Table<address, ID>,
    }

    /// Authentication object — one per wallet. `owner` is the principal address.
    public struct Account has key, store {
        id: UID,
        /// Principal Sui address. Set to `ctx.sender()` at creation (or the forged
        /// owner during `MigrationCap` import); never mutated afterwards.
        owner: address,
        /// Authorized delegate keys, each with its own permission mask.
        delegate_keys: vector<DelegateKey>,
        /// Creation timestamp (epoch ms).
        created_at: u64,
        /// Active flag (false = frozen → SEAL access denied).
        active: bool,
        /// For migration-imported accounts, the old (V1) account object id, so the
        /// `old_id -> new_id` map is reconstructable from P2 alone (design §13).
        /// `none` for accounts created natively on P2.
        legacy_account_id: Option<ID>,
    }

    /// An authorized Ed25519 delegate key with its derived Sui address and the
    /// permission mask it may exercise on behalf of the principal.
    public struct DelegateKey has store, copy, drop {
        /// Ed25519 public key (32 bytes).
        public_key: vector<u8>,
        /// Sui address derived from this Ed25519 public key.
        sui_address: address,
        /// Human-readable label (e.g., "MacBook Pro").
        label: String,
        /// Per-delegate permission mask (<= the principal's authority). Composed
        /// with the namespace ACL by intersection at decryption time. See
        /// `walrus_memory::namespace` for the bit meanings.
        perms: u8,
        /// Timestamp when key was added (epoch ms).
        created_at: u64,
    }

    /// Long-lived root governance capability. Minted once at publish.
    public struct AdminCap has key, store { id: UID }

    /// Ephemeral migration capability. Gates the no-signature forge entry points
    /// (`admin_import_account`, `admin_add_delegate_key`). Burned at Phase 7 so
    /// the forge power provably ceases to exist.
    public struct MigrationCap has key, store { id: UID }

    // ============================================================
    // Events
    // ============================================================

    public struct AccountCreated has copy, drop { account_id: ID, owner: address }

    public struct AccountImported has copy, drop {
        new_id: ID,
        legacy_account_id: ID,
        owner: address,
    }

    public struct DelegateKeyAdded has copy, drop {
        account_id: ID,
        public_key: vector<u8>,
        sui_address: address,
        label: String,
        perms: u8,
    }

    public struct DelegateKeyRemoved has copy, drop {
        account_id: ID,
        public_key: vector<u8>,
        sui_address: address,
    }

    public struct AccountDeactivated has copy, drop { account_id: ID, owner: address }
    public struct AccountReactivated has copy, drop { account_id: ID, owner: address }
    public struct AccountMigrated has copy, drop { account_id: ID, from: u64, to: u64 }
    public struct RegistryMigrated has copy, drop { registry_id: ID, from: u64, to: u64 }
    public struct MigrationCapMinted has copy, drop { cap_id: ID }
    public struct MigrationCapBurned has copy, drop { cap_id: ID }

    // ============================================================
    // Init — runs once at module publish
    // ============================================================

    /// Create the shared `AccountRegistry` and mint the root `AdminCap` to the
    /// publisher.
    fun init(ctx: &mut TxContext) {
        let mut registry = AccountRegistry {
            id: object::new(ctx),
            accounts: table::new(ctx),
        };
        stamp_version(&mut registry.id);
        transfer::share_object(registry);

        transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    }

    // ============================================================
    // Account entry functions (native / owner-driven)
    // ============================================================

    /// Create a new `Account`. Each address can create exactly one (registry).
    entry fun create_account(
        registry: &mut AccountRegistry,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_object_version(&registry.id);

        let sender = ctx.sender();
        assert!(!registry.accounts.contains(sender), EAccountAlreadyExists);

        let mut account = Account {
            id: object::new(ctx),
            owner: sender,
            delegate_keys: vector::empty(),
            created_at: clock.timestamp_ms(),
            active: true,
            legacy_account_id: option::none(),
        };
        stamp_version(&mut account.id);

        let account_id = object::id(&account);
        registry.accounts.add(sender, account_id);

        event::emit(AccountCreated { account_id, owner: sender });
        transfer::share_object(account);
    }

    /// Add a delegate key. Owner-only. `perms` is the mask this key may exercise.
    entry fun add_delegate_key(
        account: &mut Account,
        public_key: vector<u8>,
        sui_address: address,
        label: String,
        perms: u8,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert_object_version(&account.id);
        assert!(account.owner == ctx.sender(), ENotOwner);
        assert!(account.active, EAccountDeactivated);
        add_delegate_key_internal(account, public_key, sui_address, label, perms, clock.timestamp_ms());
    }

    /// Remove a delegate key. Owner-only. Allowed even when frozen so a
    /// compromised key can be purged after deactivation.
    entry fun remove_delegate_key(
        account: &mut Account,
        public_key: vector<u8>,
        ctx: &TxContext,
    ) {
        assert_object_version(&account.id);
        assert!(account.owner == ctx.sender(), ENotOwner);

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

        event::emit(DelegateKeyRemoved {
            account_id: object::id(account),
            public_key,
            sui_address,
        });
    }

    /// Deactivate (freeze) the account. Owner-only. Aborts if already frozen.
    entry fun deactivate_account(account: &mut Account, ctx: &TxContext) {
        assert_object_version(&account.id);
        assert!(account.owner == ctx.sender(), ENotOwner);
        assert!(account.active, EAccountDeactivated);
        account.active = false;
        event::emit(AccountDeactivated { account_id: object::id(account), owner: account.owner });
    }

    /// Reactivate a frozen account. Owner-only. Aborts if already active.
    entry fun reactivate_account(account: &mut Account, ctx: &TxContext) {
        assert_object_version(&account.id);
        assert!(account.owner == ctx.sender(), ENotOwner);
        assert!(!account.active, EAccountAlreadyActive);
        account.active = true;
        event::emit(AccountReactivated { account_id: object::id(account), owner: account.owner });
    }

    // ============================================================
    // Migration forge path (MigrationCap-gated, no user signature)
    // ============================================================

    /// Import a legacy account onto P2 without the user's signature. Gated by the
    /// ephemeral `MigrationCap`. Records `legacy_account_id` and emits the on-chain
    /// `old -> new` mapping. Enforces one account per owner.
    entry fun admin_import_account(
        _cap: &MigrationCap,
        registry: &mut AccountRegistry,
        owner: address,
        legacy_account_id: ID,
        created_at: u64,
        active: bool,
        ctx: &mut TxContext,
    ) {
        let account = import_account_for_migration(
            _cap,
            registry,
            owner,
            legacy_account_id,
            created_at,
            active,
            ctx,
        );
        transfer::share_object(account);
    }

    /// Add a delegate key to an imported account without the owner's signature.
    /// Gated by `MigrationCap`. Used in Phase 3 to copy delegate keys onto P2.
    entry fun admin_add_delegate_key(
        _cap: &MigrationCap,
        account: &mut Account,
        public_key: vector<u8>,
        sui_address: address,
        label: String,
        perms: u8,
        created_at: u64,
    ) {
        assert_object_version(&account.id);
        add_delegate_key_internal(account, public_key, sui_address, label, perms, created_at);
    }

    // ============================================================
    // Capability management (AdminCap-gated)
    // ============================================================

    /// Mint a `MigrationCap`. Only the `AdminCap` holder can. Returned so it can be
    /// used / transferred within the same PTB.
    public fun mint_migration_cap(_admin: &AdminCap, ctx: &mut TxContext): MigrationCap {
        let cap = MigrationCap { id: object::new(ctx) };
        event::emit(MigrationCapMinted { cap_id: object::id(&cap) });
        cap
    }

    /// Burn a `MigrationCap` — permanently removes the no-signature forge power.
    public fun burn_migration_cap(_admin: &AdminCap, cap: MigrationCap) {
        event::emit(MigrationCapBurned { cap_id: object::id(&cap) });
        let MigrationCap { id } = cap;
        object::delete(id);
    }

    /// CLI convenience: mint a `MigrationCap` and transfer it to `recipient`.
    entry fun issue_migration_cap(admin: &AdminCap, recipient: address, ctx: &mut TxContext) {
        transfer::public_transfer(mint_migration_cap(admin, ctx), recipient);
    }

    /// CLI convenience: burn a `MigrationCap` passed by value.
    entry fun revoke_migration_cap(admin: &AdminCap, cap: MigrationCap) {
        burn_migration_cap(admin, cap);
    }

    // ============================================================
    // Migration (version-gating)
    // ============================================================

    /// Owner-initiated migration of an `Account` to the current VERSION.
    entry fun migrate_account(account: &mut Account, ctx: &TxContext) {
        assert!(account.owner == ctx.sender(), ENotOwner);
        let cur = get_version(&account.id);
        assert!(cur < VERSION, EAlreadyMigrated);
        set_version(&mut account.id, VERSION);
        event::emit(AccountMigrated { account_id: object::id(account), from: cur, to: VERSION });
    }

    /// Admin batch migration of an `Account`. Gated by `AdminCap`.
    entry fun admin_migrate_account(_admin: &AdminCap, account: &mut Account) {
        let cur = get_version(&account.id);
        assert!(cur < VERSION, EAlreadyMigrated);
        set_version(&mut account.id, VERSION);
        event::emit(AccountMigrated { account_id: object::id(account), from: cur, to: VERSION });
    }

    /// Migrate the shared `AccountRegistry`. Gated by `AdminCap`.
    entry fun migrate_registry(_admin: &AdminCap, registry: &mut AccountRegistry) {
        let cur = get_version(&registry.id);
        assert!(cur < VERSION, EAlreadyMigrated);
        set_version(&mut registry.id, VERSION);
        event::emit(RegistryMigrated { registry_id: object::id(registry), from: cur, to: VERSION });
    }

    // ============================================================
    // Package-internal accessors (used by namespace / seal modules)
    // ============================================================

    /// AUTHN: resolve a signer to the delegate authority it may exercise for this
    /// account. Returns `0xFF` (all bits) for the owner's root key, or the
    /// delegate's `perms` for a registered delegate key. Aborts `ENoAccess` if the
    /// caller is neither — this is the authentication gate of `seal_approve`.
    public(package) fun authn(account: &Account, caller: address): u8 {
        if (caller == account.owner) {
            OWNER_ROOT_AUTHORITY
        } else {
            let mut i = 0;
            let len = account.delegate_keys.length();
            while (i < len) {
                if (account.delegate_keys[i].sui_address == caller) {
                    return account.delegate_keys[i].perms
                };
                i = i + 1;
            };
            abort ENoAccess
        }
    }

    /// Registry integrity: the supplied account is the canonical registered one
    /// for its owner. Belt-and-suspenders against stale/rogue `Account` objects.
    public(package) fun is_canonical_account(
        registry: &AccountRegistry,
        owner: address,
        account_id: ID,
    ): bool {
        registry.accounts.contains(owner)
            && *registry.accounts.borrow(owner) == account_id
    }

    /// Stamp a freshly-minted object's `UID` with the current VERSION.
    public(package) fun stamp_version(id: &mut UID) { set_version(id, VERSION) }

    /// Package-internal migration primitive used by the namespace module's
    /// atomic account+namespace import entry. It updates `AccountRegistry` and
    /// emits the same import event, but leaves sharing to the caller so both
    /// registries can be committed in the same transaction.
    public(package) fun import_account_for_migration(
        _cap: &MigrationCap,
        registry: &mut AccountRegistry,
        owner: address,
        legacy_account_id: ID,
        created_at: u64,
        active: bool,
        ctx: &mut TxContext,
    ): Account {
        assert_object_version(&registry.id);
        assert!(!registry.accounts.contains(owner), EAccountAlreadyExists);

        let mut account = Account {
            id: object::new(ctx),
            owner,
            delegate_keys: vector::empty(),
            created_at,
            active,
            legacy_account_id: option::some(legacy_account_id),
        };
        stamp_version(&mut account.id);

        let new_id = object::id(&account);
        registry.accounts.add(owner, new_id);

        event::emit(AccountImported { new_id, legacy_account_id, owner });
        account
    }

    /// Assert an object is on the current VERSION (the downgrade guard).
    public(package) fun assert_object_version(id: &UID) {
        assert!(get_version(id) == VERSION, EWrongVersion);
    }

    /// Read an object's stored version (missing field reads as `1`). Used by
    /// sibling modules' `migrate_*` functions.
    public(package) fun object_version(id: &UID): u64 { get_version(id) }

    // ============================================================
    // Public view functions
    // ============================================================

    public fun owner(account: &Account): address { account.owner }
    public fun is_active(account: &Account): bool { account.active }
    public fun delegate_count(account: &Account): u64 { account.delegate_keys.length() }
    public fun has_account(registry: &AccountRegistry, addr: address): bool {
        registry.accounts.contains(addr)
    }
    public fun account_id_of(registry: &AccountRegistry, addr: address): ID {
        *registry.accounts.borrow(addr)
    }

    public fun is_delegate(account: &Account, public_key: &vector<u8>): bool {
        let mut i = 0;
        let len = account.delegate_keys.length();
        while (i < len) {
            if (&account.delegate_keys[i].public_key == public_key) return true;
            i = i + 1;
        };
        false
    }

    public fun is_delegate_address(account: &Account, addr: address): bool {
        let mut i = 0;
        let len = account.delegate_keys.length();
        while (i < len) {
            if (account.delegate_keys[i].sui_address == addr) return true;
            i = i + 1;
        };
        false
    }

    public fun delegate_key_at(account: &Account, index: u64): &vector<u8> {
        &account.delegate_keys[index].public_key
    }
    public fun delegate_address_at(account: &Account, index: u64): address {
        account.delegate_keys[index].sui_address
    }
    public fun delegate_label_at(account: &Account, index: u64): &String {
        &account.delegate_keys[index].label
    }
    public fun delegate_perms_at(account: &Account, index: u64): u8 {
        account.delegate_keys[index].perms
    }

    public fun legacy_account_id(account: &Account): &Option<ID> { &account.legacy_account_id }

    public fun account_version(account: &Account): u64 { get_version(&account.id) }
    public fun registry_version(registry: &AccountRegistry): u64 { get_version(&registry.id) }
    public fun current_version(): u64 { VERSION }

    // ============================================================
    // Internal helpers
    // ============================================================

    /// Shared add-delegate logic for both the owner and `MigrationCap` paths.
    fun add_delegate_key_internal(
        account: &mut Account,
        public_key: vector<u8>,
        sui_address: address,
        label: String,
        perms: u8,
        created_at: u64,
    ) {
        assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);
        assert!(label.as_bytes().length() <= MAX_LABEL_LENGTH, ELabelTooLong);
        assert!(perms & (PERMS_MASK ^ 0xFF) == 0, EInvalidPerms);
        assert!(account.delegate_keys.length() < MAX_DELEGATE_KEYS, ETooManyDelegateKeys);

        let mut i = 0;
        let len = account.delegate_keys.length();
        while (i < len) {
            assert!(account.delegate_keys[i].public_key != public_key, EDelegateKeyAlreadyExists);
            i = i + 1;
        };

        let key = DelegateKey { public_key, sui_address, label, perms, created_at };
        event::emit(DelegateKeyAdded {
            account_id: object::id(account),
            public_key: key.public_key,
            sui_address: key.sui_address,
            label: key.label,
            perms: key.perms,
        });
        account.delegate_keys.push_back(key);
    }

    /// Read the version dynamic field. Missing field reads as `1` (legacy).
    fun get_version(id: &UID): u64 {
        if (df::exists_with_type<vector<u8>, u64>(id, VERSION_DF_KEY)) {
            *df::borrow<vector<u8>, u64>(id, VERSION_DF_KEY)
        } else {
            1
        }
    }

    /// Set the version dynamic field (add if missing, else update in place).
    fun set_version(id: &mut UID, v: u64) {
        if (df::exists_with_type<vector<u8>, u64>(id, VERSION_DF_KEY)) {
            let r = df::borrow_mut<vector<u8>, u64>(id, VERSION_DF_KEY);
            *r = v;
        } else {
            df::add(id, VERSION_DF_KEY, v);
        }
    }

    // ============================================================
    // Test helpers
    // ============================================================

    #[test_only]
    public fun test_init(ctx: &mut TxContext) { init(ctx) }

    #[test_only]
    public fun test_mint_admin_cap(ctx: &mut TxContext): AdminCap {
        AdminCap { id: object::new(ctx) }
    }

    /// Build a versioned registry as a local value (not shared) for unit tests.
    #[test_only]
    public fun test_new_registry(ctx: &mut TxContext): AccountRegistry {
        let mut registry = AccountRegistry { id: object::new(ctx), accounts: table::new(ctx) };
        stamp_version(&mut registry.id);
        registry
    }

    /// Register an account for `owner` and return it as a local value.
    #[test_only]
    public fun test_register_account(
        registry: &mut AccountRegistry,
        owner: address,
        active: bool,
        ctx: &mut TxContext,
    ): Account {
        let mut account = Account {
            id: object::new(ctx),
            owner,
            delegate_keys: vector::empty(),
            created_at: 0,
            active,
            legacy_account_id: option::none(),
        };
        stamp_version(&mut account.id);
        registry.accounts.add(owner, object::id(&account));
        account
    }

    /// Add a delegate with a synthetic 32-byte pubkey derived from `pk_seed`.
    #[test_only]
    public fun test_add_delegate(account: &mut Account, sui_address: address, perms: u8, pk_seed: u8) {
        let mut public_key = vector::empty<u8>();
        let mut i = 0;
        while (i < ED25519_PUBLIC_KEY_LENGTH) { public_key.push_back(pk_seed); i = i + 1; };
        account.delegate_keys.push_back(DelegateKey {
            public_key,
            sui_address,
            label: std::string::utf8(b"test"),
            perms,
            created_at: 0,
        });
    }

    /// Test wrapper for the `MigrationCap`-gated import entry.
    #[test_only]
    public fun test_admin_import_account(
        cap: &MigrationCap,
        registry: &mut AccountRegistry,
        owner: address,
        legacy_account_id: ID,
        created_at: u64,
        active: bool,
        ctx: &mut TxContext,
    ) {
        admin_import_account(cap, registry, owner, legacy_account_id, created_at, active, ctx);
    }

    /// Dispose a locally-built registry in tests (transfer, not share, so it works
    /// across `next_tx` boundaries).
    #[test_only]
    public fun test_consume_registry(registry: AccountRegistry) {
        transfer::transfer(registry, @0x0)
    }

    #[test_only]
    public fun test_force_account_version(account: &mut Account, v: u64) {
        set_version(&mut account.id, v);
    }

    /// Force an arbitrary version on any object UID (used by the namespace test
    /// helper to simulate a downgraded namespace).
    #[test_only]
    public(package) fun test_set_object_version(id: &mut UID, v: u64) { set_version(id, v) }
}
