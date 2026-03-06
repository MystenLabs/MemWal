/// MemWal V2 — Account & Delegate Key Management
///
/// Core on-chain module for managing MemWal accounts and delegate keys.
/// Each user creates a MemWalAccount (shared object) that stores a list of
/// authorized Ed25519 public keys (delegate keys). The server verifies
/// that a request's signing key is in this list before processing it.
///
/// ## Architecture
/// - MemWalAccount: owned object, stores owner + delegate_keys
/// - DelegateKey: struct with public_key (32 bytes), label, created_at
/// - Entry functions: create_account, add_delegate_key, remove_delegate_key
/// - View function: is_delegate (checks if a public key is authorized)
module memwal_v2::account {
    use std::string::String;
    use sui::event;

    // ============================================================
    // Error Codes
    // ============================================================

    /// Delegate key already exists in the account
    const EDelegateKeyAlreadyExists: u64 = 0;
    /// Delegate key not found in the account
    const EDelegateKeyNotFound: u64 = 1;
    /// Maximum number of delegate keys reached
    const ETooManyDelegateKeys: u64 = 2;

    /// Maximum delegate keys per account
    const MAX_DELEGATE_KEYS: u64 = 20;

    // ============================================================
    // Structs
    // ============================================================

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

    // ============================================================
    // Entry Functions
    // ============================================================

    /// Create a new MemWalAccount
    /// The caller becomes the owner, and the account is transferred to them
    entry fun create_account(ctx: &mut TxContext) {
        let account = MemWalAccount {
            id: object::new(ctx),
            owner: ctx.sender(),
            delegate_keys: vector::empty(),
            created_at: 0, // TODO: Use sui::clock for real timestamp
        };

        let account_id = object::id(&account);

        event::emit(AccountCreated {
            account_id,
            owner: ctx.sender(),
        });

        transfer::transfer(account, ctx.sender());
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
        assert!(account.owner == ctx.sender(), 0);

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
            public_key: public_key,
            label: label,
            created_at: 0, // TODO: Use sui::clock for real timestamp
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
        assert!(account.owner == ctx.sender(), 0);

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
}
