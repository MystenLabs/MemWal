/// MemWal V2 — Account, Admin & SEAL Access Control
///
/// Core on-chain module for managing MemWal accounts, delegate keys,
/// and TEE admin authorization for SEAL encryption/decryption.
///
/// ## Architecture
/// - AdminCap: capability object — holder is the admin authority
/// - AccountRegistry: shared object — tracks accounts (prevents duplicates) + stores TEE admin address
/// - MemWalAccount: owned object — stores owner + delegate_keys
/// - DelegateKey: struct with public_key (32 bytes), label, created_at
/// - seal_approve: SEAL policy — authorizes owner OR TEE admin to decrypt
module memwal_v2::account {
    use std::string::String;
    use sui::event;
    use sui::table::{Self, Table};

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
    /// Caller is not authorized to decrypt (SEAL)
    const ENoAccess: u64 = 100;

    /// Maximum delegate keys per account
    const MAX_DELEGATE_KEYS: u64 = 20;

    // ============================================================
    // Structs
    // ============================================================

    /// Admin capability — whoever owns this object is the admin authority.
    /// Created once at module init and transferred to deployer.
    /// Can be transferred to the TEE server wallet.
    public struct AdminCap has key, store {
        id: UID,
    }

    /// Shared registry — tracks all MemWalAccounts and stores TEE admin address.
    /// Prevents duplicate account creation and provides admin address for SEAL.
    public struct AccountRegistry has key {
        id: UID,
        /// Maps owner address → account object ID (prevents duplicates)
        accounts: Table<address, ID>,
        /// TEE admin Sui address — authorized for SEAL decrypt on behalf of users
        admin: address,
    }

    /// Main account object — one per user
    /// Stores the list of authorized delegate keys
    public struct MemWalAccount has key, store {
        id: UID,
        /// Owner's Sui address
        owner: address,
        /// List of authorized Ed25519 public keys
        delegate_keys: vector<DelegateKey>,
        /// Timestamp when account was created (epoch ms)
        created_at: u64,
    }

    /// An authorized Ed25519 public key
    public struct DelegateKey has store, copy, drop {
        /// Ed25519 public key (32 bytes, hex-encoded as string for readability)
        public_key: vector<u8>,
        /// Human-readable label (e.g., "MacBook Pro", "Work Server")
        label: String,
        /// Timestamp when key was added (epoch ms)
        created_at: u64,
    }

    // ============================================================
    // Events
    // ============================================================

    public struct AccountCreated has copy, drop {
        account_id: ID,
        owner: address,
    }

    public struct DelegateKeyAdded has copy, drop {
        account_id: ID,
        public_key: vector<u8>,
        label: String,
    }

    public struct DelegateKeyRemoved has copy, drop {
        account_id: ID,
        public_key: vector<u8>,
    }

    public struct AdminChanged has copy, drop {
        old_admin: address,
        new_admin: address,
    }

    // ============================================================
    // Init — runs once at module publish
    // ============================================================

    /// Create AdminCap (transferred to deployer) and AccountRegistry (shared).
    fun init(ctx: &mut TxContext) {
        // AdminCap → deployer
        transfer::transfer(
            AdminCap { id: object::new(ctx) },
            ctx.sender(),
        );

        // AccountRegistry → shared object
        transfer::share_object(AccountRegistry {
            id: object::new(ctx),
            accounts: table::new(ctx),
            admin: ctx.sender(),
        });
    }

    // ============================================================
    // Admin Functions
    // ============================================================

    /// Update the TEE admin address in the registry.
    /// Only the AdminCap holder can call this.
    entry fun set_admin(
        _cap: &AdminCap,
        registry: &mut AccountRegistry,
        new_admin: address,
    ) {
        let old_admin = registry.admin;
        registry.admin = new_admin;

        event::emit(AdminChanged {
            old_admin,
            new_admin,
        });
    }

    // ============================================================
    // Account Entry Functions
    // ============================================================

    /// Create a new MemWalAccount.
    /// Each address can only create ONE account (enforced by registry).
    entry fun create_account(
        registry: &mut AccountRegistry,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();

        // Check: no duplicate accounts
        assert!(!registry.accounts.contains(sender), EAccountAlreadyExists);

        let account = MemWalAccount {
            id: object::new(ctx),
            owner: sender,
            delegate_keys: vector::empty(),
            created_at: 0, // NOTE: currently set to 0; use sui::clock if real timestamps are needed
        };

        let account_id = object::id(&account);

        // Register in the registry
        registry.accounts.add(sender, account_id);

        event::emit(AccountCreated {
            account_id,
            owner: sender,
        });

        transfer::transfer(account, sender);
    }

    /// Add a delegate key to the account
    /// Only the owner can add delegate keys
    ///
    /// * `public_key` - Ed25519 public key bytes (32 bytes)
    /// * `label` - Human-readable label for this key
    entry fun add_delegate_key(
        account: &mut MemWalAccount,
        public_key: vector<u8>,
        label: String,
        ctx: &TxContext,
    ) {
        // Verify caller is the owner
        assert!(account.owner == ctx.sender(), ENotOwner);

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

        let key = DelegateKey {
            public_key,
            label,
            created_at: 0, // NOTE: currently set to 0; use sui::clock if real timestamps are needed
        };

        let account_id = object::id(account);

        event::emit(DelegateKeyAdded {
            account_id,
            public_key: key.public_key,
            label: key.label,
        });

        account.delegate_keys.push_back(key);
    }

    /// Remove a delegate key from the account
    /// Only the owner can remove delegate keys
    ///
    /// * `public_key` - Ed25519 public key bytes to remove
    entry fun remove_delegate_key(
        account: &mut MemWalAccount,
        public_key: vector<u8>,
        ctx: &TxContext,
    ) {
        // Verify caller is the owner
        assert!(account.owner == ctx.sender(), ENotOwner);

        // Find and remove the key
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

    /// Get the owner address
    public fun owner(account: &MemWalAccount): address {
        account.owner
    }

    /// Get the number of delegate keys
    public fun delegate_count(account: &MemWalAccount): u64 {
        account.delegate_keys.length()
    }

    /// Get a delegate key's public key by index
    public fun delegate_key_at(account: &MemWalAccount, index: u64): &vector<u8> {
        &account.delegate_keys[index].public_key
    }

    /// Get a delegate key's label by index
    public fun delegate_label_at(account: &MemWalAccount, index: u64): &String {
        &account.delegate_keys[index].label
    }

    /// Get the TEE admin address from registry
    public fun admin(registry: &AccountRegistry): address {
        registry.admin
    }

    /// Check if an address already has an account
    public fun has_account(registry: &AccountRegistry, addr: address): bool {
        registry.accounts.contains(addr)
    }

    // ============================================================
    // SEAL Access Control
    // ============================================================

    /// SEAL policy: authorize owner OR TEE admin to decrypt.
    ///
    /// Key ID format: [package_id][bcs::to_bytes(owner_address)]
    /// This is called by SEAL key servers via dry_run to verify access.
    ///
    /// Access is granted if the caller is:
    /// 1. The data owner (caller address matches key ID), OR
    /// 2. The TEE admin (caller matches registry.admin)
    entry fun seal_approve(
        id: vector<u8>,
        registry: &AccountRegistry,
        ctx: &TxContext,
    ) {
        let caller = ctx.sender();
        let caller_bytes = sui::bcs::to_bytes(&caller);

        // Owner can decrypt their own data
        let is_owner = (id == caller_bytes);
        // TEE admin can decrypt any user's data
        let is_admin = (registry.admin == caller);

        assert!(is_owner || is_admin, ENoAccess);
    }

    /// Compute the SEAL key ID for a given owner address.
    /// Used by clients to construct the correct key ID for encryption.
    /// Key ID = bcs::to_bytes(owner_address)
    /// (Package ID prefix is added automatically by SEAL SDK)
    public fun seal_key_id(owner: address): vector<u8> {
        sui::bcs::to_bytes(&owner)
    }

    // ============================================================
    // Test helpers
    // ============================================================

    #[test_only]
    public fun test_init(ctx: &mut TxContext) {
        init(ctx);
    }
}
