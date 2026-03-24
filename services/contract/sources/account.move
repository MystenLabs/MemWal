/// MemWal — Account & SEAL Access Control
///
/// Core on-chain module for managing MemWal accounts and delegate keys.
/// Delegate keys are Ed25519 Sui keypairs that can sign transactions
/// and are authorized for SEAL decryption.
///
/// ## Architecture
/// - AccountRegistry: shared object — tracks accounts (prevents duplicates)
/// - MemWalAccount: owned object — stores owner + delegate_keys
/// - DelegateKey: struct with public_key, sui_address, label, created_at
/// - seal_approve: SEAL policy — authorizes owner OR delegate key holder to decrypt
module memwal::account {
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
    /// Caller is not authorized to decrypt (SEAL)
    const ENoAccess: u64 = 100;

    /// Maximum delegate keys per account
    const MAX_DELEGATE_KEYS: u64 = 20;
    /// Expected length of an Ed25519 public key in bytes
    const ED25519_PUBLIC_KEY_LENGTH: u64 = 32;

    // ============================================================
    // Structs
    // ============================================================

    /// Shared registry — tracks all MemWalAccounts.
    /// Prevents duplicate account creation.
    public struct AccountRegistry has key {
        id: UID,
        /// Maps owner address → account object ID (prevents duplicates)
        accounts: Table<address, ID>,
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
        sui_address: address,
        label: String,
    }

    public struct DelegateKeyRemoved has copy, drop {
        account_id: ID,
        public_key: vector<u8>,
    }

    public struct AccountDeactivated has copy, drop {
        account_id: ID,
        owner: address,
    }

    public struct AccountReactivated has copy, drop {
        account_id: ID,
        owner: address,
    }

    // ============================================================
    // Init — runs once at module publish
    // ============================================================

    /// Create AccountRegistry (shared).
    fun init(ctx: &mut TxContext) {
        // AccountRegistry → shared object
        transfer::share_object(AccountRegistry {
            id: object::new(ctx),
            accounts: table::new(ctx),
        });
    }

    // ============================================================
    // Account Entry Functions
    // ============================================================

    /// Create a new MemWalAccount.
    /// Each address can only create ONE account (enforced by registry).
    entry fun create_account(
        registry: &mut AccountRegistry,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();

        // Check: no duplicate accounts
        assert!(!registry.accounts.contains(sender), EAccountAlreadyExists);

        let account = MemWalAccount {
            id: object::new(ctx),
            owner: sender,
            delegate_keys: vector::empty(),
            created_at: clock.timestamp_ms(),
            active: true,
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
    /// * `public_key` - Ed25519 public key bytes (32 bytes)
    /// * `sui_address` - Sui address derived from the Ed25519 public key
    /// * `label` - Human-readable label for this key
    entry fun add_delegate_key(
        account: &mut MemWalAccount,
        public_key: vector<u8>,
        sui_address: address,
        label: String,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        // Verify caller is the owner
        assert!(account.owner == ctx.sender(), ENotOwner);

        // Verify account is active
        assert!(account.active, EAccountDeactivated);

        // Validate Ed25519 public key length (must be exactly 32 bytes)
        assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);

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

        // Verify account is active
        assert!(account.active, EAccountDeactivated);

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
    // Account Activation / Deactivation
    // ============================================================

    /// Deactivate (freeze) the account.
    /// When deactivated: SEAL access is denied, delegate keys cannot be modified.
    /// Only the owner can deactivate.
    entry fun deactivate_account(
        account: &mut MemWalAccount,
        ctx: &TxContext,
    ) {
        assert!(account.owner == ctx.sender(), ENotOwner);
        account.active = false;

        event::emit(AccountDeactivated {
            account_id: object::id(account),
            owner: account.owner,
        });
    }

    /// Reactivate a previously deactivated account.
    /// Only the owner can reactivate.
    entry fun reactivate_account(
        account: &mut MemWalAccount,
        ctx: &TxContext,
    ) {
        assert!(account.owner == ctx.sender(), ENotOwner);
        account.active = true;

        event::emit(AccountReactivated {
            account_id: object::id(account),
            owner: account.owner,
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

    /// Check if the account is active
    public fun is_active(account: &MemWalAccount): bool {
        account.active
    }

    // ============================================================
    // SEAL Access Control
    // ============================================================

    /// SEAL policy: authorize owner OR delegate key holder to decrypt.
    ///
    /// Key ID format: [package_id][bcs::to_bytes(owner_address)]
    /// This is called by SEAL key servers via dry_run to verify access.
    ///
    /// Access is granted if the caller is:
    /// 1. The data owner (key ID ends with BCS(owner) + caller is account owner), OR
    /// 2. A registered delegate key holder (caller's Sui address is in delegate_keys)
    ///
    /// The account must be active (not frozen).
    entry fun seal_approve(
        id: vector<u8>,
        account: &MemWalAccount,
        ctx: &TxContext,
    ) {
        // Account must be active
        assert!(account.active, EAccountDeactivated);

        let caller = ctx.sender();

        // Owner check: key ID must end with BCS(owner) and caller must be the owner
        let owner_bytes = sui::bcs::to_bytes(&account.owner);
        let is_owner = (caller == account.owner) && has_suffix(&id, &owner_bytes);
        // Delegate key holders can decrypt
        let is_delegate = is_delegate_address(account, caller);

        assert!(is_owner || is_delegate, ENoAccess);
    }

    /// Compute the SEAL key ID for a given owner address.
    /// Used by clients to construct the correct key ID for encryption.
    /// Key ID = bcs::to_bytes(owner_address)
    /// (Package ID prefix is added automatically by SEAL SDK)
    public fun seal_key_id(owner: address): vector<u8> {
        sui::bcs::to_bytes(&owner)
    }

    // ============================================================
    // Internal helpers
    // ============================================================

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
}
