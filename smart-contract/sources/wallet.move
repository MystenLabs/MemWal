/// @deprecated This module is DEPRECATED - use pdw::capability instead
///
/// MIGRATION NOTICE:
/// =================
/// This module used dynamic fields for context management.
/// The new pdw::capability module uses standalone MemoryCap objects.
///
/// Benefits of new architecture:
/// - No MainWallet object management needed
/// - Standard Sui object ownership
/// - SEAL-compliant PrivateData pattern
/// - Simpler cross-dApp data sharing
///
/// See CAPABILITY-ARCHITECTURE-SUMMARY.md for details.
///
/// @deprecated Use pdw::capability::MemoryCap instead
module pdw::wallet {
    use sui::event;

    // ========== Error Constants ==========
    const ENotOwner: u64 = 0;

    // ========== Structs ==========

    /// @deprecated Use pdw::capability::MemoryCap instead
    /// Kept for backward compatibility only
    public struct UserProfile has key, store {
        id: UID,
        owner: address,
        created_at: u64,
    }

    // ========== Events ==========

    public struct UserProfileCreated has copy, drop {
        profile_id: address,
        owner: address,
        created_at: u64,
    }

    // ========== Functions ==========

    /// @deprecated Use pdw::capability::create_memory_cap instead
    /// Create a simple user profile (for backward compatibility)
    public entry fun create_user_profile(ctx: &mut TxContext) {
        let owner = tx_context::sender(ctx);
        let profile_uid = object::new(ctx);
        let profile_address = object::uid_to_address(&profile_uid);

        let profile = UserProfile {
            id: profile_uid,
            owner,
            created_at: tx_context::epoch(ctx),
        };

        event::emit(UserProfileCreated {
            profile_id: profile_address,
            owner,
            created_at: tx_context::epoch(ctx),
        });

        transfer::transfer(profile, owner);
    }

    /// Get profile owner
    public fun get_owner(profile: &UserProfile): address {
        profile.owner
    }

    /// Get profile ID
    public fun get_profile_id(profile: &UserProfile): address {
        object::uid_to_address(&profile.id)
    }

    /// Delete user profile
    public entry fun delete_profile(profile: UserProfile, ctx: &TxContext) {
        assert!(profile.owner == tx_context::sender(ctx), ENotOwner);
        let UserProfile { id, owner: _, created_at: _ } = profile;
        object::delete(id);
    }

    // ========== Test Functions ==========

    #[test_only]
    public fun test_create_profile(ctx: &mut TxContext): UserProfile {
        let owner = tx_context::sender(ctx);
        let profile_uid = object::new(ctx);

        UserProfile {
            id: profile_uid,
            owner,
            created_at: tx_context::epoch(ctx),
        }
    }

    #[test_only]
    public fun test_delete_profile(profile: UserProfile) {
        let UserProfile { id, owner: _, created_at: _ } = profile;
        object::delete(id);
    }
}
