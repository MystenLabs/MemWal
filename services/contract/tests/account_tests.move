#[test_only]
#[allow(implicit_const_copy)]
module memwal::account_tests {
    use std::string;
    use sui::test_scenario;
    use sui::clock;
    use memwal::account::{Self, MemWalAccount, AccountRegistry};

    const OWNER: address = @0xCAFE;
    const OTHER: address = @0xBEEF;
    /// Simulated delegate key's Sui address
    const DELEGATE_ADDR: address = @0xDE1E;

    // ============================================================
    // Helper: init + create_account in one go
    // ============================================================

    fun setup_with_account(scenario: &mut test_scenario::Scenario) {
        // Init module (creates AccountRegistry)
        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Create account via registry
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };
    }

    // ============================================================
    // Init Tests
    // ============================================================

    #[test]
    fun test_init_creates_registry() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // AccountRegistry should be shared
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    // ============================================================
    // Account Tests
    // ============================================================

    #[test]
    fun test_create_account() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Verify account was created and transferred to owner
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            assert!(account.owner() == OWNER);
            assert!(account.delegate_count() == 0);
            assert!(account.is_active());
            test_scenario::return_shared(account);
        };

        // Verify registry tracks the account
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account::has_account(&registry, OWNER));
            assert!(!account::has_account(&registry, OTHER));
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAccountAlreadyExists)]
    fun test_duplicate_account_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Try to create a second account — should fail
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    // ============================================================
    // Delegate Key Tests
    // ============================================================

    #[test]
    fun test_add_delegate_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Add a delegate key
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                pk,
                DELEGATE_ADDR,
                string::utf8(b"MacBook Pro"),
                &clock,
                scenario.ctx(),
            );
            assert!(account.delegate_count() == 1);
            assert!(account.is_delegate(&pk));
            assert!(account.is_delegate_address(DELEGATE_ADDR));
            assert!(account.delegate_address_at(0) == DELEGATE_ADDR);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_add_multiple_delegate_keys() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Add two delegate keys
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk1 = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let pk2 = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(
                &mut account,
                pk1,
                DELEGATE_ADDR,
                string::utf8(b"Key 1"),
                &clock,
                scenario.ctx(),
            );
            account::add_delegate_key(
                &mut account,
                pk2,
                @0xDE2E,
                string::utf8(b"Key 2"),
                &clock,
                scenario.ctx(),
            );

            assert!(account.delegate_count() == 2);
            assert!(account.is_delegate(&pk1));
            assert!(account.is_delegate(&pk2));
            assert!(account.is_delegate_address(DELEGATE_ADDR));
            assert!(account.is_delegate_address(@0xDE2E));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_remove_delegate_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Add then remove a delegate key
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(
                &mut account,
                pk,
                DELEGATE_ADDR,
                string::utf8(b"Temp Key"),
                &clock,
                scenario.ctx(),
            );
            assert!(account.delegate_count() == 1);

            account::remove_delegate_key(
                &mut account,
                pk,
                scenario.ctx(),
            );
            assert!(account.delegate_count() == 0);
            assert!(!account.is_delegate(&pk));
            assert!(!account.is_delegate_address(DELEGATE_ADDR));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_is_delegate_not_found() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Check non-existent key
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let pk = x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
            assert!(!account.is_delegate(&pk));
            assert!(!account.is_delegate_address(@0x9999));
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EDelegateKeyAlreadyExists)]
    fun test_add_duplicate_key_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Key 1"), &clock, scenario.ctx());
            // Adding same key again should fail
            account::add_delegate_key(&mut account, pk, @0xDE2E, string::utf8(b"Key 2"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EDelegateKeyNotFound)]
    fun test_remove_nonexistent_key_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            // Removing key that doesn't exist should fail
            account::remove_delegate_key(&mut account, pk, scenario.ctx());

            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENotOwner)]
    fun test_non_owner_cannot_add_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Try to add key as non-owner
        scenario.next_tx(OTHER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // This should fail because OTHER is not the owner
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Stolen"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // Public Key Validation Tests
    // ============================================================

    #[test]
    #[expected_failure(abort_code = account::EInvalidPublicKeyLength)]
    fun test_add_delegate_key_too_short_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            // 31 bytes — too short for Ed25519
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Bad Key"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EInvalidPublicKeyLength)]
    fun test_add_delegate_key_too_long_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            // 33 bytes — too long for Ed25519
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Bad Key"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EInvalidPublicKeyLength)]
    fun test_add_delegate_key_empty_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            // 0 bytes — empty
            let pk = x"";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Empty Key"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // Account Deactivation Tests
    // ============================================================

    #[test]
    fun test_deactivate_account() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            assert!(account.is_active());

            account::deactivate_account(&mut account, scenario.ctx());
            assert!(!account.is_active());

            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_reactivate_account() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::deactivate_account(&mut account, scenario.ctx());
            assert!(!account.is_active());

            account::reactivate_account(&mut account, scenario.ctx());
            assert!(account.is_active());

            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENotOwner)]
    fun test_non_owner_cannot_deactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OTHER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::deactivate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAccountDeactivated)]
    fun test_deactivated_blocks_add_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::deactivate_account(&mut account, scenario.ctx());

            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // Should fail — account is deactivated
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Blocked"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// LOW-20 / SEC-281: owners must be able to purge delegate keys even after
    /// the account is frozen, so that compromised keys can be removed.
    #[test]
    fun test_deactivated_allows_remove_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // First add a key while active
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Key"), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        // Deactivate then remove key — should succeed despite frozen state
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::deactivate_account(&mut account, scenario.ctx());
            assert!(!account.is_active());

            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            account::remove_delegate_key(&mut account, pk, scenario.ctx());
            assert!(account.delegate_count() == 0);
            assert!(!account.is_delegate(&pk));

            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAccountDeactivated)]
    fun test_deactivated_blocks_seal_approve() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Deactivate account
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::deactivate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        // Try seal_approve — should fail
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let owner_bytes = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_bytes, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // SEAL Access Control Tests
    // ============================================================

    #[test]
    fun test_seal_approve_owner() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Owner calls seal_approve with their own key ID → should pass
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let owner_bytes = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_bytes, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_seal_approve_owner_with_prefix() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Owner calls seal_approve with prefixed key ID → should pass
        // Simulate key ID = [package_prefix][bcs(owner)]
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let owner_bytes = sui::bcs::to_bytes(&OWNER);
            // Prepend some fake package ID prefix
            let mut prefixed_id = x"deadbeef1234567890abcdef";
            let mut i = 0;
            while (i < owner_bytes.length()) {
                prefixed_id.push_back(owner_bytes[i]);
                i = i + 1;
            };
            account::seal_approve(prefixed_id, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_seal_approve_delegate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Add delegate key with DELEGATE_ADDR
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                pk,
                DELEGATE_ADDR,
                string::utf8(b"Server Key"),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        // DELEGATE_ADDR calls seal_approve for OWNER's data → should pass
        scenario.next_tx(DELEGATE_ADDR);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let owner_key_id = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_key_id, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_seal_approve_unauthorized() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Random address tries to decrypt OWNER's data → should fail
        scenario.next_tx(OTHER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let owner_key_id = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_key_id, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENotOwner)]
    fun test_non_owner_cannot_remove_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

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
    fun test_add_key_max_limit_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let clock = clock::create_for_testing(scenario.ctx());
            let mut i: u64 = 0;
            while (i <= 20) {
                // 30-byte base + 2 push_back = 32 bytes (Ed25519 key length)
                let mut pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                pk.push_back((i as u8));
                pk.push_back(((i + 1) as u8));
                account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"Key"), &clock, scenario.ctx());
                i = i + 1;
            };

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_seal_approve_wrong_id_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let wrong_bytes = sui::bcs::to_bytes(&OTHER); // using OTHER's id
            account::seal_approve(wrong_bytes, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_is_delegate_address_not_found() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                pk,
                DELEGATE_ADDR,
                string::utf8(b"Server Key"),
                &clock,
                scenario.ctx(),
            );

            // Check an address that is not DELEGATE_ADDR
            assert!(!account.is_delegate_address(@0x1111));
            
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // LOW-19 — Idempotent deactivate/reactivate (SEC-279)
    // ============================================================

    #[test]
    #[expected_failure(abort_code = account::EAccountDeactivated)]
    fun test_double_deactivate_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::deactivate_account(&mut account, scenario.ctx());
            // Second call must abort to avoid spurious event emission
            account::deactivate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAccountAlreadyActive)]
    fun test_reactivate_active_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            // Account starts active — reactivating must abort
            account::reactivate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // LOW-21 — Label length validation (SEC-282)
    // ============================================================

    #[test]
    #[expected_failure(abort_code = account::ELabelTooLong)]
    fun test_add_delegate_key_label_too_long_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // 65-byte label exceeds MAX_LABEL_LENGTH (64)
            let label = string::utf8(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, label, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_add_delegate_key_label_at_max_succeeds() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // Exactly 64 bytes — at the boundary
            let label = string::utf8(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, label, &clock, scenario.ctx());
            assert!(account.delegate_count() == 1);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // HIGH-14 — Version gating (SEC-303)
    // ============================================================

    #[test]
    fun test_new_objects_have_current_version() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let account = scenario.take_shared<MemWalAccount>();
            assert!(account::registry_version(&registry) == account::current_version());
            assert!(account::account_version(&account) == account::current_version());
            test_scenario::return_shared(account);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_account_blocks_add_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Simulate a legacy account that pre-dates the version-gating upgrade.
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);

            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"k"), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_account_blocks_remove_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Add a key first while at current VERSION
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"k"), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        // Strip the version (simulate legacy) and try to remove
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            account::remove_delegate_key(&mut account, pk, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_account_blocks_deactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            account::deactivate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_account_blocks_reactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Deactivate while on current version
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::deactivate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        // Strip version and try to reactivate
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            account::reactivate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_account_blocks_seal_approve() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let owner_bytes = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_bytes, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_registry_blocks_create_account() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Strip the registry's version to simulate legacy registry
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_strip_registry_version(&mut registry);
            test_scenario::return_shared(registry);
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    fun test_migrate_account_owner_success() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Strip version to simulate legacy state
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            assert!(account::account_version(&account) == 1);
            test_scenario::return_shared(account);
        };

        // Owner migrates
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::migrate_account(&mut account, scenario.ctx());
            assert!(account::account_version(&account) == account::current_version());
            test_scenario::return_shared(account);
        };

        // After migration owner can call mutating entries again
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, pk, DELEGATE_ADDR, string::utf8(b"k"), &clock, scenario.ctx());
            assert!(account.delegate_count() == 1);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENotOwner)]
    fun test_migrate_account_non_owner_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OTHER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::migrate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAlreadyMigrated)]
    fun test_migrate_account_already_at_version_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            // account is freshly created → already at VERSION
            account::migrate_account(&mut account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_admin_migrate_account_with_valid_cap() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let cap = account::test_make_upgrade_cap(scenario.ctx());
            account::admin_migrate_account(&cap, &mut account);
            assert!(account::account_version(&account) == account::current_version());
            sui::package::make_immutable(cap);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENotUpgradeAuthority)]
    fun test_admin_migrate_account_with_foreign_cap_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            account::test_strip_account_version(&mut account);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let cap = account::test_make_foreign_upgrade_cap(scenario.ctx());
            account::admin_migrate_account(&cap, &mut account);
            sui::package::make_immutable(cap);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    fun test_migrate_registry_with_valid_cap() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_strip_registry_version(&mut registry);
            assert!(account::registry_version(&registry) == 1);
            test_scenario::return_shared(registry);
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let cap = account::test_make_upgrade_cap(scenario.ctx());
            account::migrate_registry(&cap, &mut registry);
            assert!(account::registry_version(&registry) == account::current_version());
            sui::package::make_immutable(cap);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENotUpgradeAuthority)]
    fun test_migrate_registry_with_foreign_cap_fails() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_strip_registry_version(&mut registry);
            test_scenario::return_shared(registry);
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let cap = account::test_make_foreign_upgrade_cap(scenario.ctx());
            account::migrate_registry(&cap, &mut registry);
            sui::package::make_immutable(cap);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAlreadyMigrated)]
    fun test_migrate_registry_already_at_version_fails() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            // registry is freshly created → already at VERSION
            let cap = account::test_make_upgrade_cap(scenario.ctx());
            account::migrate_registry(&cap, &mut registry);
            sui::package::make_immutable(cap);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }
}
