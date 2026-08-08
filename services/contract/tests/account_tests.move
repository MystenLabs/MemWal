#[test_only]
#[allow(implicit_const_copy)]
module memwal::account_tests {
    use std::string;
    use sui::test_scenario;
    use sui::clock;
    use memwal::account::{Self, MemWalAccount, AccountRegistry};

    const OWNER: address = @0xCAFE;
    const OTHER: address = @0xBEEF;
    /// Sui address derived from the `0xAA*32` delegate test key
    /// (`account::derive_sui_address(x"aa..aa")`). Used as the delegate caller
    /// in the `seal_approve` tests.
    const DELEGATE_ADDR: address = @0x9f89215dc3a091bc288a2ddfb1860f0cb9efc4d39a2bb728944f741a650a7fb1;
    /// Sui address derived from the `0xBB*32` delegate test key.
    const DELEGATE_ADDR2: address = @0xcbb8c34831749c2416ec0339bfc46f42d696576d08d8621e39ef767c42933d77;
    const LEGACY_ID: address = @0x11a2;

    // ============================================================
    // Helper: init + create_account in one go
    // ============================================================

    fun empty_root(): vector<u8> {
        x"0000000000000000000000000000000000000000000000000000000000000000"
    }

    fun finalize_migration(
        admin: &account::AdminCap,
        registry: &mut AccountRegistry,
        ctx: &mut TxContext,
    ) {
        let clock = clock::create_for_testing(ctx);
        account::finalize_migration(
            admin,
            registry,
            &clock,
            x"1111111111111111111111111111111111111111111111111111111111111111",
            900000,
        );
        clock::destroy_for_testing(clock);
    }

    fun setup_with_account(scenario: &mut test_scenario::Scenario) {
        // Init module (creates AccountRegistry)
        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // create_account is blocked until the migration window closes, so
        // finalize first, then create the native account.
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let admin = account::test_make_admin_cap(scenario.ctx());
            account::pin_allowlist_root(
                &admin,
                &mut registry,
                empty_root(),
                0,
                0,
            );
            finalize_migration(&admin, &mut registry, scenario.ctx());
            let clock = clock::create_for_testing(scenario.ctx());
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                &registry,
                pk,
                string::utf8(b"MacBook Pro"),
                &clock,
                scenario.ctx(),
            );
            assert!(account.delegate_count() == 1);
            assert!(account.is_delegate(&pk));
            // Stored address matches the on-chain derivation from the key.
            assert!(account.is_delegate_address(account::derive_sui_address(&pk)));
            assert!(account.delegate_address_at(0) == account::derive_sui_address(&pk));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk1 = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let pk2 = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(
                &mut account,
                &registry,
                pk1,
                string::utf8(b"Key 1"),
                &clock,
                scenario.ctx(),
            );
            account::add_delegate_key(
                &mut account,
                &registry,
                pk2,
                string::utf8(b"Key 2"),
                &clock,
                scenario.ctx(),
            );

            assert!(account.delegate_count() == 2);
            assert!(account.is_delegate(&pk1));
            assert!(account.is_delegate(&pk2));
            assert!(account.is_delegate_address(account::derive_sui_address(&pk1)));
            assert!(account.is_delegate_address(account::derive_sui_address(&pk2)));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(
                &mut account,
                &registry,
                pk,
                string::utf8(b"Temp Key"),
                &clock,
                scenario.ctx(),
            );
            assert!(account.delegate_count() == 1);

            account::remove_delegate_key(
                &mut account,
                &registry,
                pk,
                scenario.ctx(),
            );
            assert!(account.delegate_count() == 0);
            assert!(!account.is_delegate(&pk));
            assert!(!account.is_delegate_address(account::derive_sui_address(&pk)));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Key 1"), &clock, scenario.ctx());
            // Adding same key again should fail
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Key 2"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            // Removing key that doesn't exist should fail
            account::remove_delegate_key(&mut account, &registry, pk, scenario.ctx());

            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // This should fail because OTHER is not the owner
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Other Device"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            // 31 bytes — too short for Ed25519
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Bad Key"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            // 33 bytes — too long for Ed25519
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Bad Key"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            // 0 bytes — empty
            let pk = x"";
            let clock = clock::create_for_testing(scenario.ctx());

            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Empty Key"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account.is_active());

            account::deactivate_account(&mut account, &registry, scenario.ctx());
            assert!(!account.is_active());

            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            assert!(!account.is_active());

            account::reactivate_account(&mut account, &registry, scenario.ctx());
            assert!(account.is_active());

            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut account, &registry, scenario.ctx());

            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // Should fail — account is deactivated
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Blocked"), &clock, scenario.ctx());

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// Owners can still remove delegate keys after the account is frozen.
    #[test]
    fun test_deactivated_allows_remove_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // First add a key while active
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Key"), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        // Deactivate then remove key — should succeed despite frozen state
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            assert!(!account.is_active());

            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            account::remove_delegate_key(&mut account, &registry, pk, scenario.ctx());
            assert!(account.delegate_count() == 0);
            assert!(!account.is_delegate(&pk));

            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        // Try seal_approve — should fail
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(account::seal_key_id(OWNER, 0), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(account::seal_key_id(OWNER, 0), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let key_id = account::seal_key_id(OWNER, 0);
            // Prepend some fake package ID prefix
            let mut prefixed_id = x"deadbeef1234567890abcdef";
            let mut i = 0;
            while (i < key_id.length()) {
                prefixed_id.push_back(key_id[i]);
                i = i + 1;
            };
            account::seal_approve(prefixed_id, &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                &registry,
                pk,
                string::utf8(b"Server Key"),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        // DELEGATE_ADDR calls seal_approve for OWNER's data → should pass
        scenario.next_tx(DELEGATE_ADDR);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(account::seal_key_id(OWNER, 0), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// A delegate is scoped to the account it is registered on: `seal_approve`
    /// grants access only for an id whose owner suffix matches this account.
    /// OWNER registers a delegate, which then requests an id for a different
    /// owner (OTHER) and is denied.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_seal_approve_delegate_requires_matching_owner() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // OWNER registers a delegate (pk 0xBB → DELEGATE_ADDR2) on their account.
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                &registry,
                pk,
                string::utf8(b"delegate"),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        // The delegate requests an id for a different owner (OTHER) — denied.
        scenario.next_tx(DELEGATE_ADDR2);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(account::seal_key_id(OTHER, 0), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(account::seal_key_id(OWNER, 0), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            account::remove_delegate_key(&mut account, &registry, pk, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OTHER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::reactivate_account(&mut account, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            // MAX_DELEGATE_KEYS = 20; loop 21 times so the 21st call triggers
            // ETooManyDelegateKeys. Build a 32-byte key (31-byte base + 1 byte
            // varying per iteration) so it passes the length check and reaches
            // the max-limit check.
            let mut i: u64 = 0;
            while (i <= 20) {
                let mut pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                pk.push_back((i as u8));
                account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"Key"), &clock, scenario.ctx());
                i = i + 1;
            };

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let wrong_id = account::seal_key_id(OTHER, 0); // using OTHER's id
            account::seal_approve(wrong_id, &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// An id shorter than the 40-byte owner ‖ counter suffix can never match, so
    /// `seal_approve` denies access. Empty-id case.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_seal_approve_empty_id_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(x"", &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// A truncated id (shorter than the 40-byte owner ‖ counter suffix) is denied
    /// for the same reason as the empty-id case.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_seal_approve_truncated_id_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            // 16 bytes — shorter than the 40-byte BCS owner ‖ counter tail
            let short_id = x"00112233445566778899aabbccddeeff";
            account::seal_approve(short_id, &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // SEAL identity rotation (access_counter_version)
    // ============================================================

    /// The check the whole rotation scheme rests on: a delegate authorized
    /// *right now* must not be able to fetch keys for counters the account has
    /// not reached. Otherwise it banks a key for every future identity and
    /// every later `remove_delegate_key` is cosmetic.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_seal_approve_rejects_future_counter() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account::access_counter_version(&account) == 0, 0);
            // Account is at counter 0; asking for 1 is asking for tomorrow's key.
            account::seal_approve(account::seal_key_id(OWNER, 1), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// Rotation is forward-only: after a bump the owner must still be able to
    /// read memories written under the old counter, or a revocation would lock
    /// them out of their own history.
    #[test]
    fun test_seal_approve_old_counter_still_allowed() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"k"), &clock, scenario.ctx());
            account::remove_delegate_key(&mut account, &registry, pk, scenario.ctx());
            clock::destroy_for_testing(clock);
            assert!(account::access_counter_version(&account) == 1, 0);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            // Both the pre-rotation and post-rotation identities open for the owner.
            account::seal_approve(account::seal_key_id(OWNER, 0), &registry, &account, scenario.ctx());
            account::seal_approve(account::seal_key_id(OWNER, 1), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// A persistence fence ordered before removal is a valid pre-revocation
    /// write. The later removal rotates the identity for subsequent writes.
    #[test]
    fun test_encrypt_fence_before_delegate_removal_succeeds() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_encrypt_fence(account::seal_key_id(OWNER, 0), &registry, &account);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"k"), &clock, scenario.ctx());
            account::remove_delegate_key(&mut account, &registry, pk, scenario.ctx());
            clock::destroy_for_testing(clock);
            assert!(account::access_counter_version(&account) == 1);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// A removal ordered first rotates the counter, so a stale counter-0
    /// ciphertext cannot be persisted afterwards.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_encrypt_fence_rejects_counter_rotated_before_fence() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"k"), &clock, scenario.ctx());
            account::remove_delegate_key(&mut account, &registry, pk, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_encrypt_fence(account::seal_key_id(OWNER, 0), &registry, &account);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// An owner freeze ordered before persistence rotates the counter and
    /// rejects ciphertext encrypted from the stale pre-freeze read.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_encrypt_fence_rejects_owner_deactivation_before_fence() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut managed = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut managed, &registry, scenario.ctx());
            let current = account::access_counter_version(&managed);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
            assert!(current == 1);
        };

        scenario.next_tx(OWNER);
        {
            let managed = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_encrypt_fence(account::seal_key_id(OWNER, 0), &registry, &managed);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
        };

        scenario.end();
    }

    /// An Admin quarantine ordered before persistence also rotates the counter,
    /// so ciphertext encrypted from the pre-quarantine read cannot be stored.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_encrypt_fence_rejects_admin_quarantine_before_fence() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut managed = scenario.take_shared<MemWalAccount>();
            let admin = account::test_make_admin_cap(scenario.ctx());
            account::admin_deactivate_account(&admin, &mut managed);
            let current = account::access_counter_version(&managed);
            sui::test_utils::destroy(admin);
            test_scenario::return_shared(managed);
            assert!(current == 1);
        };

        scenario.next_tx(OWNER);
        {
            let managed = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_encrypt_fence(account::seal_key_id(OWNER, 0), &registry, &managed);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
        };

        scenario.end();
    }

    /// Removing a delegate rotates the identity, so the key it already holds
    /// (counter 0) cannot open anything written afterwards (counter 1) — and it
    /// can no longer fetch a fresh one.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_removed_delegate_denied_after_rotation() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"k"), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        // While authorized the delegate can fetch the counter-0 key.
        scenario.next_tx(DELEGATE_ADDR);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(account::seal_key_id(OWNER, 0), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::remove_delegate_key(&mut account, &registry, pk, scenario.ctx());
            assert!(account::access_counter_version(&account) == 1, 0);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        // New memories go under counter 1, which it can no longer reach.
        scenario.next_tx(DELEGATE_ADDR);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::seal_approve(account::seal_key_id(OWNER, 1), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// Freezing rotates on the way down, so ciphertext written while frozen
    /// (encryption never calls `seal_approve`) is not readable with a key
    /// fetched before the freeze.
    #[test]
    fun test_deactivate_rotates_counter() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account::access_counter_version(&account) == 0, 0);
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            assert!(account::access_counter_version(&account) == 1, 1);
            // Reactivation does not rotate again: current delegates are
            // authorized by definition, and nobody could fetch counter 1 while
            // seal_approve was off.
            account::reactivate_account(&mut account, &registry, scenario.ctx());
            assert!(account::access_counter_version(&account) == 1, 2);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                &registry,
                pk,
                string::utf8(b"Server Key"),
                &clock,
                scenario.ctx(),
            );

            // Check an address that is not DELEGATE_ADDR
            assert!(!account.is_delegate_address(@0x1111));

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // Idempotent deactivate/reactivate
    // ============================================================

    #[test]
    #[expected_failure(abort_code = account::EAccountDeactivated)]
    fun test_double_deactivate_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            // Second call must abort to avoid spurious event emission
            account::deactivate_account(&mut account, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            // Account starts active — reactivating must abort
            account::reactivate_account(&mut account, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // Label length validation
    // ============================================================

    #[test]
    #[expected_failure(abort_code = account::ELabelTooLong)]
    fun test_add_delegate_key_label_too_long_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // 65-byte label exceeds MAX_LABEL_LENGTH (64)
            let label = string::utf8(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            account::add_delegate_key(&mut account, &registry, pk, label, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
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
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            // Exactly 64 bytes — at the boundary
            let label = string::utf8(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            account::add_delegate_key(&mut account, &registry, pk, label, &clock, scenario.ctx());
            assert!(account.delegate_count() == 1);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    // ============================================================
    // Version gating
    // ============================================================

    #[test]
    fun test_new_objects_have_current_version() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account::registry_version(&registry) == account::current_version());
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    /// A registry whose version != VERSION freezes the gated `add_delegate_key`
    /// entry (representative mutating entry).
    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_registry_blocks_add_key() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut registry, 1);

            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"k"), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// A registry whose version != VERSION freezes the old `seal_approve`
    /// policy. Historical ciphertext is decrypted through the current policy
    /// package while keeping the original package as the SEAL identity.
    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_registry_blocks_seal_approve() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut registry, 1);
            account::seal_approve(account::seal_key_id(OWNER, 0), &registry, &account, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion)]
    fun test_legacy_registry_blocks_quarantine_clear() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OTHER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut managed = scenario.take_shared<MemWalAccount>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::admin_deactivate_account(&admin, &mut managed);
            account::test_set_registry_version(&mut registry, 1);
            account::admin_clear_quarantine(&admin, &registry, &mut managed);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
            sui::test_utils::destroy(admin);
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

        // Force a wrong registry version to simulate an un-migrated registry.
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut registry, 1);
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
    #[expected_failure(abort_code = account::EWrongVersion, location = account)]
    fun test_legacy_registry_blocks_encrypt_fence() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let managed = scenario.take_shared<MemWalAccount>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut registry, 1);
            account::seal_encrypt_fence(
                account::seal_key_id(OWNER, 0),
                &registry,
                &managed,
            );
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion, location = account)]
    fun test_legacy_registry_blocks_allowlist_pin() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut registry, 1);
            account::pin_allowlist_root(&admin, &mut registry, empty_root(), 0, 0);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion, location = account)]
    fun test_legacy_registry_blocks_migration_cap_mint() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let root = empty_root();
            account::pin_allowlist_root(&admin, &mut registry, root, 0, 0);
            account::test_set_registry_version(&mut registry, 1);
            let migration_cap =
                account::mint_migration_cap(&admin, &registry, root, scenario.ctx());
            account::burn_migration_cap(migration_cap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EWrongVersion, location = account)]
    fun test_legacy_registry_blocks_migration_finalize() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);

        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(&admin, &mut registry, empty_root(), 0, 0);
            account::test_set_registry_version(&mut registry, 1);
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };

        scenario.end();
    }

    /// On a current-version registry, native creation stays blocked until the
    /// migration window is closed — accounts arrive only via the import path.
    #[test]
    #[expected_failure(abort_code = account::EMigrationInProgress)]
    fun test_create_account_blocked_before_finalize() {
        let mut scenario = test_scenario::begin(OWNER);
        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };
        // Correct version, migration NOT finalized → create_account aborts.
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
    fun test_migrate_registry_with_valid_cap() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut registry, 1);
            assert!(account::registry_version(&registry) == 1);
            test_scenario::return_shared(registry);
        };

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let cap = account::test_make_admin_cap(scenario.ctx());
            account::migrate_registry(&cap, &mut registry);
            assert!(account::registry_version(&registry) == account::current_version());
            sui::test_utils::destroy(cap);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    /// The cutover unfreeze: a registry behind VERSION freezes every gated entry
    /// (see `test_legacy_registry_blocks_add_key`); one `migrate_registry` call
    /// flips the gate so the same entry succeeds again. Proves the
    /// block -> migrate -> unblock path end to end.
    #[test]
    fun test_migrate_registry_unfreezes_gated_entry() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);

        // Simulate an un-migrated registry after a package upgrade.
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut registry, 1);
            test_scenario::return_shared(registry);
        };

        // One AdminCap call flips the gate for the whole package.
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let cap = account::test_make_admin_cap(scenario.ctx());
            account::migrate_registry(&cap, &mut registry);
            sui::test_utils::destroy(cap);
            test_scenario::return_shared(registry);
        };

        // The gated entry that was frozen at version 1 now succeeds.
        scenario.next_tx(OWNER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut account, &registry, pk, string::utf8(b"post-migrate"), &clock, scenario.ctx());
            assert!(account.delegate_count() == 1);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(account);
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
            let cap = account::test_make_admin_cap(scenario.ctx());
            account::migrate_registry(&cap, &mut registry);
            sui::test_utils::destroy(cap);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    // ============================================================
    // Migration import (MigrationCap) tests
    // ============================================================

    /// Init the shared registry with no owner account (import-only scenario).
    #[test_only]
    fun init_registry_only(scenario: &mut test_scenario::Scenario) {
        scenario.next_tx(OWNER);
        { account::test_init(scenario.ctx()); };
    }

    fun import_account_root(active: bool): vector<u8> {
        account::migration_account_leaf(object::id_from_address(LEGACY_ID), OTHER, active, 1)
    }

    fun import_delegate_root(public_key: &vector<u8>): vector<u8> {
        let label = string::utf8(b"device");
        account::migration_delegate_leaf(object::id_from_address(LEGACY_ID), public_key, &label, 2)
    }

    /// Pin `root` on the registry (one-shot) then mint a cap bound to it.
    /// Minting now requires a prior matching pin, so tests pin first.
    fun pin_and_mint(
        admin: &account::AdminCap,
        registry: &mut AccountRegistry,
        root: vector<u8>,
        expected_delegates: u64,
        ctx: &mut sui::tx_context::TxContext,
    ): account::MigrationCap {
        account::pin_allowlist_root(admin, registry, root, 1, expected_delegates);
        account::mint_migration_cap(admin, registry, root, ctx)
    }

    /// Import one account while leaving the global migration latch open.
    fun setup_unfinalized_import(scenario: &mut test_scenario::Scenario, active: bool) {
        init_registry_only(scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let root = import_account_root(active);
            let mcap = pin_and_mint(&admin, &mut registry, root, 0, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                active,
                1,
                vector[],
                vector[],
                scenario.ctx(),
            );
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(admin);
        };
    }

    #[test]
    fun test_imported_zero_delegate_owner_can_decrypt_before_finalize() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_unfinalized_import(&mut scenario, true);

        scenario.next_tx(OTHER);
        {
            let imported = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(imported.delegate_count() == 0);
            account::seal_approve(
                account::seal_key_id(OTHER, 0),
                &registry,
                &imported,
                scenario.ctx(),
            );
            test_scenario::return_shared(registry);
            test_scenario::return_shared(imported);
        };

        scenario.end();
    }

    /// Source-inactive accounts still need their existing memories persisted
    /// during migration. Counter equality is the write fence; `active` remains
    /// the separate decrypt authorization gate.
    #[test]
    fun test_inactive_import_accepts_current_encrypt_fence() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_unfinalized_import(&mut scenario, false);

        scenario.next_tx(OWNER);
        {
            let imported = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(!imported.is_active());
            account::seal_encrypt_fence(account::seal_key_id(OTHER, 0), &registry, &imported);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(imported);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationInProgress)]
    fun test_migration_window_blocks_owner_add_delegate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_unfinalized_import(&mut scenario, true);
        scenario.next_tx(OTHER);
        {
            let mut imported = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut imported,
                &registry,
                x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                string::utf8(b"device"),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationInProgress)]
    fun test_migration_window_blocks_owner_remove_delegate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_unfinalized_import(&mut scenario, true);
        scenario.next_tx(OTHER);
        {
            let mut imported = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::remove_delegate_key(
                &mut imported,
                &registry,
                x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                scenario.ctx(),
            );
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationInProgress)]
    fun test_migration_window_blocks_owner_deactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_unfinalized_import(&mut scenario, true);
        scenario.next_tx(OTHER);
        {
            let mut imported = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::deactivate_account(&mut imported, &registry, scenario.ctx());
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationInProgress)]
    fun test_migration_window_blocks_owner_reactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_unfinalized_import(&mut scenario, false);
        scenario.next_tx(OTHER);
        {
            let mut imported = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::reactivate_account(&mut imported, &registry, scenario.ctx());
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    fun test_inactive_import_reactivation_rotates_after_finalize() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_unfinalized_import(&mut scenario, false);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.next_tx(OTHER);
        {
            let mut imported = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account::access_counter_version(&imported) == 0);
            account::reactivate_account(&mut imported, &registry, scenario.ctx());
            assert!(imported.is_active());
            assert!(account::access_counter_version(&imported) == 1);
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    fun test_migration_account_leaf_matches_offchain_golden() {
        assert!(
            import_account_root(true) ==
                x"cc15ca3e5a0153af6940dd10abf7a36792661b7403352d67431a5a094e694405"
        );
        assert!(
            import_account_root(false) ==
                x"9b26f3716ffee97cf336e0affacaf4233bc97fe68e385a4101c8ef7e00d3c269"
        );
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert!(
            import_delegate_root(&pk) ==
                x"fef26a85aa0e5015cb0c4f9e345014ed4fa1d418f041e4ad8af4397f3f7a370c"
        );
    }

    #[test]
    fun test_legacy_import_account_and_delegate() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);

        // One pinned root commits both the account leaf and the delegate leaf;
        // each import supplies the directional Merkle path to its own leaf.
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let account_leaf = import_account_root(true);
        let delegate_leaf = import_delegate_root(&pk);
        let root = account::test_migration_merkle_parent(&account_leaf, &delegate_leaf);

        // Import an account for OTHER through the migration cap.
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, root, 1, scenario.ctx());
            account::legacy_import_account(&mcap, &mut registry, object::id_from_address(LEGACY_ID), OTHER, true, 1, vector[delegate_leaf], vector[false], scenario.ctx());
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };

        // Add a delegate to the imported account, then assert state.
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mut account = scenario.take_shared<MemWalAccount>();
            let mcap = account::mint_migration_cap(&ucap, &registry, root, scenario.ctx());
            account::legacy_import_delegate_key(&mcap, &mut registry, &mut account, pk, string::utf8(b"device"), 2, vector[account_leaf], vector[true]);
            assert!(account::is_legacy_imported(&account));
            assert!(account.owner() == OTHER);
            assert!(account.legacy_account_id() == option::some(object::id_from_address(LEGACY_ID)));
            assert!(account.is_delegate(&pk));
            assert!(account.is_delegate_address(account::derive_sui_address(&pk)));
            finalize_migration(&ucap, &mut registry, scenario.ctx());
            test_scenario::return_shared(account);
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// The root commits both leaf types; each operation needs the correct
    /// directional membership path rather than mere cap possession.
    #[test]
    fun test_migration_merkle_proofs_cover_account_and_delegate() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let account_leaf = import_account_root(true);
        let delegate_leaf = import_delegate_root(&pk);
        let root = account::test_migration_merkle_parent(&account_leaf, &delegate_leaf);

        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, root, 1, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                true,
                1,
                vector[delegate_leaf],
                vector[false],
                scenario.ctx(),
            );
            test_scenario::return_shared(registry);
            // Key-only cap: moved between addresses via the dedicated entry.
            account::transfer_migration_cap(mcap, OWNER);
            sui::test_utils::destroy(ucap);
        };

        scenario.next_tx(OWNER);
        {
            let mcap = scenario.take_from_sender<account::MigrationCap>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mut imported = scenario.take_shared<MemWalAccount>();
            account::legacy_import_delegate_key(
                &mcap,
                &mut registry,
                &mut imported,
                pk,
                string::utf8(b"device"),
                2,
                vector[account_leaf],
                vector[true],
            );
            assert!(imported.is_delegate(&pk));
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EInvalidMigrationProof)]
    fun test_migration_cap_rejects_unlisted_owner() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, import_account_root(true), 0, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OWNER,
                true,
                1,
                vector[],
                vector[],
                scenario.ctx(),
            );
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EInvalidMigrationProof)]
    fun test_migration_cap_rejects_unlisted_delegate() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);

        // Pin a root that legitimately contains the account and one ALLOWED
        // delegate; the attacker key is absent, so its import fails the proof
        // even though the cap is bound to the reviewed snapshot.
        let allowed = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let attacker = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let account_leaf = import_account_root(true);
        let delegate_leaf = import_delegate_root(&allowed);
        let root = account::test_migration_merkle_parent(&account_leaf, &delegate_leaf);

        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, root, 1, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                true,
                1,
                vector[delegate_leaf],
                vector[false],
                scenario.ctx(),
            );
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = account::mint_migration_cap(&ucap, &registry, root, scenario.ctx());
            let mut imported = scenario.take_shared<MemWalAccount>();
            account::legacy_import_delegate_key(
                &mcap,
                &mut registry,
                &mut imported,
                attacker,
                string::utf8(b"attacker"),
                1,
                vector[],
                vector[],
            );
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// The AdminCap freeze is the emergency-revocation route — `seal_approve`'s
    /// own comment points at it — so it must rotate just like the owner's
    /// freeze. Without this assertion the rotation can be dropped from
    /// `admin_deactivate_account` and the whole suite still passes, leaving a
    /// compromised delegate's existing key good for everything written while
    /// the account sits frozen.
    #[test]
    fun test_admin_deactivate_rotates_counter() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);
        scenario.next_tx(OTHER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut managed = scenario.take_shared<MemWalAccount>();
            assert!(account::access_counter_version(&managed) == 0, 0);
            account::admin_deactivate_account(&admin, &mut managed);
            assert!(account::access_counter_version(&managed) == 1, 1);
            assert!(account::is_admin_quarantined(&managed));
            // An idempotent retry must not rotate again: the quarantine latch
            // is the only thing stopping incident-response
            // retries from bumping the counter once per call.
            account::admin_deactivate_account(&admin, &mut managed);
            assert!(account::access_counter_version(&managed) == 1, 2);
            test_scenario::return_shared(managed);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    /// Quarantine revokes issued SEAL access even when the imported account was
    /// already inactive in the source snapshot.
    #[test]
    fun test_admin_quarantine_rotates_inactive_account_once() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let root = import_account_root(false);
            let mcap = pin_and_mint(&admin, &mut registry, root, 0, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                false,
                1,
                vector[],
                vector[],
                scenario.ctx(),
            );
            account::burn_migration_cap(mcap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };

        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut imported = scenario.take_shared<MemWalAccount>();
            assert!(!imported.is_active());
            assert!(account::access_counter_version(&imported) == 0, 0);
            account::admin_deactivate_account(&admin, &mut imported);
            assert!(account::access_counter_version(&imported) == 1, 1);
            account::admin_deactivate_account(&admin, &mut imported);
            assert!(account::access_counter_version(&imported) == 1, 2);
            test_scenario::return_shared(imported);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    #[test]
    fun test_admin_clear_quarantine_preserves_owner_reactivation() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);
        scenario.next_tx(OTHER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut managed = scenario.take_shared<MemWalAccount>();
            assert!(account::access_counter_version(&managed) == 0, 0);
            account::admin_deactivate_account(&admin, &mut managed);
            assert!(!managed.is_active());
            assert!(account::is_admin_quarantined(&managed));
            // The emergency freeze is a revocation path: it must rotate the
            // SEAL identity so a compromised delegate cannot keep decrypting
            // future ciphertext with a previously fetched key.
            assert!(account::access_counter_version(&managed) == 1, 1);
            // Incident-response retries are idempotent — including the
            // rotation, so retries cannot burn through counter space.
            account::admin_deactivate_account(&admin, &mut managed);
            assert!(account::access_counter_version(&managed) == 1, 2);
            let registry = scenario.take_shared<AccountRegistry>();
            account::admin_clear_quarantine(&admin, &registry, &mut managed);
            assert!(!account::is_admin_quarantined(&managed));
            assert!(!managed.is_active());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
            sui::test_utils::destroy(admin);
        };
        scenario.next_tx(OWNER);
        {
            let mut managed = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::reactivate_account(&mut managed, &registry, scenario.ctx());
            assert!(managed.is_active());
            // Reactivation restores access on the rotated identity; it does
            // not rotate again (remaining delegates fetch the current key).
            assert!(account::access_counter_version(&managed) == 1, 3);
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAccountQuarantined)]
    fun test_owner_cannot_clear_admin_quarantine() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario);
        scenario.next_tx(OTHER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut managed = scenario.take_shared<MemWalAccount>();
            account::admin_deactivate_account(&admin, &mut managed);
            test_scenario::return_shared(managed);
            sui::test_utils::destroy(admin);
        };
        scenario.next_tx(OWNER);
        {
            let mut managed = scenario.take_shared<MemWalAccount>();
            let registry = scenario.take_shared<AccountRegistry>();
            account::reactivate_account(&mut managed, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
            test_scenario::return_shared(managed);
        };
        scenario.end();
    }

    #[test]
    fun test_native_account_has_no_legacy_id() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario); // native OWNER account
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            assert!(account.legacy_account_id() == option::none());
            test_scenario::return_shared(account);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAccountAlreadyExists)]
    fun test_legacy_import_duplicate_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, import_account_root(true), 0, scenario.ctx());
            account::legacy_import_account(&mcap, &mut registry, object::id_from_address(LEGACY_ID), OTHER, true, 1, vector[], vector[], scenario.ctx());
            account::legacy_import_account(&mcap, &mut registry, object::id_from_address(LEGACY_ID), OTHER, true, 1, vector[], vector[], scenario.ctx()); // dup → abort
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// The import delegate path applies only to migration-created accounts,
    /// not to natively-created ones.
    #[test]
    #[expected_failure(abort_code = account::ENotLegacyImported)]
    fun test_legacy_import_delegate_rejects_native_account() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_with_account(&mut scenario); // native OWNER account (finalizes the registry)
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            // Reopen the import window: a native account can only coexist with an
            // open import path in tests, so the ENotLegacyImported guard is
            // reachable to assert here.
            account::test_set_migration_finalized(&mut registry, false);
            let mut account = scenario.take_shared<MemWalAccount>(); // native, legacy_account_id == none
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let mcap = account::mint_migration_cap(&ucap, &registry, empty_root(), scenario.ctx());
            account::legacy_import_delegate_key(&mcap, &mut registry, &mut account, pk, string::utf8(b"x"), 1, vector[], vector[]); // abort
            test_scenario::return_shared(account);
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// After finalize the import path is permanently closed.
    #[test]
    #[expected_failure(abort_code = account::EMigrationFinalized)]
    fun test_finalize_blocks_import() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(
                &ucap,
                &mut registry,
                import_account_root(true),
                0,
                scenario.ctx(),
            );
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                true,
                1,
                vector[],
                vector[],
                scenario.ctx(),
            );
            finalize_migration(&ucap, &mut registry, scenario.ctx());
            account::transfer_migration_cap(mcap, OWNER);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        scenario.next_tx(OWNER);
        {
            let mcap = scenario.take_from_sender<account::MigrationCap>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::legacy_import_account(&mcap, &mut registry, object::id_from_address(LEGACY_ID), OTHER, true, 1, vector[], vector[], scenario.ctx()); // abort
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EAllowlistRootNotPinned)]
    fun test_finalize_requires_pinned_root() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ECompletionEvidenceExpired)]
    fun test_finalize_rejects_expired_completion_evidence() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        let admin = account::test_make_admin_cap(scenario.ctx());
        let mut registry = scenario.take_shared<AccountRegistry>();
        account::pin_allowlist_root(&admin, &mut registry, empty_root(), 0, 0);
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, 900001);
        account::finalize_migration(
            &admin,
            &mut registry,
            &clock,
            x"1111111111111111111111111111111111111111111111111111111111111111",
            900000,
        );
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = account::EInvalidCompletionEvidence)]
    fun test_finalize_rejects_invalid_completion_digest() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        let admin = account::test_make_admin_cap(scenario.ctx());
        let mut registry = scenario.take_shared<AccountRegistry>();
        account::pin_allowlist_root(&admin, &mut registry, empty_root(), 0, 0);
        let clock = clock::create_for_testing(scenario.ctx());
        account::finalize_migration(&admin, &mut registry, &clock, x"11", 900000);
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = account::EInvalidCompletionEvidence)]
    fun test_finalize_rejects_excessive_completion_lifetime() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        let admin = account::test_make_admin_cap(scenario.ctx());
        let mut registry = scenario.take_shared<AccountRegistry>();
        account::pin_allowlist_root(&admin, &mut registry, empty_root(), 0, 0);
        let clock = clock::create_for_testing(scenario.ctx());
        account::finalize_migration(
            &admin,
            &mut registry,
            &clock,
            x"1111111111111111111111111111111111111111111111111111111111111111",
            900001,
        );
        abort 0
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationImportCountMismatch)]
    fun test_finalize_requires_all_accounts_imported() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(
                &admin,
                &mut registry,
                import_account_root(true),
                1,
                0,
            );
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationImportCountMismatch)]
    fun test_finalize_requires_all_delegates_imported() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let account_leaf = import_account_root(true);
        let delegate_leaf = import_delegate_root(&pk);
        let root = account::test_migration_merkle_parent(&account_leaf, &delegate_leaf);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&admin, &mut registry, root, 1, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                true,
                1,
                vector[delegate_leaf],
                vector[false],
                scenario.ctx(),
            );
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationFinalized)]
    fun test_mint_after_finalize_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(&admin, &mut registry, import_account_root(true), 0, 0);
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let registry = scenario.take_shared<AccountRegistry>();
            let mcap = account::mint_migration_cap(
                &admin,
                &registry,
                import_account_root(true),
                scenario.ctx(),
            );
            account::burn_migration_cap(mcap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::EMigrationFinalized)]
    fun test_finalize_is_one_way() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(&admin, &mut registry, import_account_root(true), 0, 0);
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            finalize_migration(&admin, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    /// On-chain derivation matches the known test vector — also validates the
    /// `DELEGATE_ADDR` constant used across the delegate tests.
    #[test]
    fun test_derive_sui_address_matches_known_vector() {
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert!(account::derive_sui_address(&pk) == DELEGATE_ADDR);
    }

    /// `derive_sui_address` validates its input length — a wrong-length key
    /// aborts rather than deriving an address from malformed input.
    #[test]
    #[expected_failure(abort_code = account::EInvalidPublicKeyLength)]
    fun test_derive_sui_address_wrong_length_fails() {
        // 31 bytes — one short of a valid Ed25519 public key
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        account::derive_sui_address(&pk);
    }

    /// The finalize latch closes delegate additions too, not just import —
    /// mirrors `test_finalize_blocks_import` for `legacy_import_delegate_key`.
    #[test]
    #[expected_failure(abort_code = account::EMigrationFinalized)]
    fun test_finalize_blocks_add_delegate() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        // Import a migration-created account BEFORE finalize.
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, import_account_root(true), 0, scenario.ctx());
            account::legacy_import_account(&mcap, &mut registry, object::id_from_address(LEGACY_ID), OTHER, true, 1, vector[], vector[], scenario.ctx());
            account::transfer_migration_cap(mcap, OWNER);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        // Finalize the migration.
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            finalize_migration(&ucap, &mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        // Adding a delegate must now abort — the finalize latch fires before the
        // Merkle proof, so the cap is minted with the pinned account root.
        scenario.next_tx(OWNER);
        {
            let mcap = scenario.take_from_sender<account::MigrationCap>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mut account = scenario.take_shared<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            account::legacy_import_delegate_key(&mcap, &mut registry, &mut account, pk, string::utf8(b"x"), 1, vector[], vector[]); // abort
            test_scenario::return_shared(account);
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
        };
        scenario.end();
    }

    /// Re-adding an already-present delegate on a full account is a no-op — the
    /// dedupe scan runs before the capacity check, so migration retries stay
    /// idempotent.
    #[test]
    fun test_legacy_import_delegate_idempotent_when_full() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);

        // pk0 = 0x00*32. One pinned root commits the account leaf + pk0's
        // delegate leaf; each import carries the directional path to its leaf.
        let mut pk0 = vector::empty<u8>();
        let mut z = 0u64;
        while (z < 32) { pk0.push_back(0u8); z = z + 1; };
        let account_leaf = import_account_root(true);
        let delegate_leaf = import_delegate_root(&pk0);
        let root = account::test_migration_merkle_parent(&account_leaf, &delegate_leaf);

        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, root, 1, scenario.ctx());
            account::legacy_import_account(&mcap, &mut registry, object::id_from_address(LEGACY_ID), OTHER, true, 1, vector[delegate_leaf], vector[false], scenario.ctx());
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mut account = scenario.take_shared<MemWalAccount>();
            // Import the key under test through the real Merkle-gated path.
            let mcap = account::mint_migration_cap(&ucap, &registry, root, scenario.ctx());
            account::legacy_import_delegate_key(&mcap, &mut registry, &mut account, pk0, string::utf8(b"device"), 2, vector[account_leaf], vector[true]);

            // Fill the other 19 slots directly. Repeating cap minting + Merkle
            // hashing here is unrelated to the ordering invariant under test
            // and exceeds the older CI Move VM's per-test instruction budget.
            let mut i = 1u8;
            while (i < 20) {
                let mut pk = vector::empty<u8>();
                let mut j = 0u64;
                while (j < 32) { pk.push_back(i); j = j + 1; };
                account::test_push_delegate_key_unchecked(&mut account, pk);
                i = i + 1;
            };
            assert!(account.delegate_count() == 20);
            // Re-add the first key while full → must no-op, not abort.
            account::legacy_import_delegate_key(&mcap, &mut registry, &mut account, pk0, string::utf8(b"device"), 2, vector[account_leaf], vector[true]);
            assert!(account.delegate_count() == 20);
            test_scenario::return_shared(account);
            test_scenario::return_shared(registry);
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// Quarantine keeps the account inactive but cannot strand the global import
    /// count: proof-bound hydration and its idempotent retry still complete.
    #[test]
    fun test_legacy_import_duplicate_noops_after_admin_quarantine() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let account_leaf = import_account_root(true);
        let delegate_leaf = import_delegate_root(&pk);
        let root = account::test_migration_merkle_parent(&account_leaf, &delegate_leaf);

        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&admin, &mut registry, root, 1, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                true,
                1,
                vector[delegate_leaf],
                vector[false],
                scenario.ctx(),
            );
            account::transfer_admin_cap(admin, OWNER);
            account::transfer_migration_cap(mcap, OWNER);
            test_scenario::return_shared(registry);
        };

        scenario.next_tx(OWNER);
        {
            let admin = scenario.take_from_sender<account::AdminCap>();
            let mcap = scenario.take_from_sender<account::MigrationCap>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mut imported = scenario.take_shared<MemWalAccount>();
            account::admin_deactivate_account(&admin, &mut imported);
            assert!(account::is_admin_quarantined(&imported));
            assert!(!account::is_active(&imported));
            assert!(account::access_counter_version(&imported) == 1);

            account::legacy_import_delegate_key(
                &mcap,
                &mut registry,
                &mut imported,
                pk,
                string::utf8(b"device"),
                2,
                vector[account_leaf],
                vector[true],
            );
            // A replay remains a no-op after the first import increments the
            // exact delegate counter.
            account::legacy_import_delegate_key(
                &mcap,
                &mut registry,
                &mut imported,
                pk,
                string::utf8(b"device"),
                2,
                vector[account_leaf],
                vector[true],
            );
            assert!(imported.delegate_count() == 1);
            finalize_migration(&admin, &mut registry, scenario.ctx());
            account::burn_migration_cap(mcap);
            sui::test_utils::destroy(admin);
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    /// Source-inactive accounts retain their source state. Migration can still
    /// hydrate their delegate set, but no caller can obtain a SEAL key until the
    /// owner deliberately reactivates the account.
    #[test]
    #[expected_failure(abort_code = account::EAccountDeactivated)]
    fun test_inactive_import_hydrates_delegate_but_denies_seal() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let account_leaf = import_account_root(false);
        let delegate_leaf = import_delegate_root(&pk);
        let root = account::test_migration_merkle_parent(&account_leaf, &delegate_leaf);

        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&admin, &mut registry, root, 1, scenario.ctx());
            account::legacy_import_account(
                &mcap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                false,
                1,
                vector[delegate_leaf],
                vector[false],
                scenario.ctx(),
            );
            account::transfer_migration_cap(mcap, OWNER);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };

        scenario.next_tx(OWNER);
        {
            let mcap = scenario.take_from_sender<account::MigrationCap>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mut imported = scenario.take_shared<MemWalAccount>();
            assert!(!imported.is_active());
            account::legacy_import_delegate_key(
                &mcap,
                &mut registry,
                &mut imported,
                pk,
                string::utf8(b"device"),
                2,
                vector[account_leaf],
                vector[true],
            );
            assert!(imported.is_delegate(&pk));
            assert!(account::access_counter_version(&imported) == 0);
            account::burn_migration_cap(mcap);
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };

        scenario.next_tx(OTHER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let imported = scenario.take_shared<MemWalAccount>();
            account::seal_approve(
                account::seal_key_id(OTHER, 0),
                &registry,
                &imported,
                scenario.ctx(),
            );
            test_scenario::return_shared(imported);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    // ============================================================
    // Capability custody (caps are key-only, no `store`)
    // ============================================================

    /// The AdminCap can be handed to a new custodian through the dedicated
    /// entry, even though the key-only cap is out of reach of
    /// `transfer::public_transfer` / PTB `TransferObjects`.
    #[test]
    fun test_transfer_admin_cap_entry() {
        let mut scenario = test_scenario::begin(OWNER);
        scenario.next_tx(OWNER);
        {
            let cap = account::test_make_admin_cap(scenario.ctx());
            account::transfer_admin_cap(cap, OTHER);
        };
        // New custodian owns the cap and can exercise admin authority.
        scenario.next_tx(OTHER);
        {
            let cap = scenario.take_from_sender<account::AdminCap>();
            sui::test_utils::destroy(cap);
        };
        scenario.end();
    }

    /// A freshly minted MigrationCap reaches a migrator worker through the
    /// dedicated entry and remains fully usable (burnable) at the destination.
    #[test]
    fun test_transfer_migration_cap_entry() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let mcap = pin_and_mint(&ucap, &mut registry, import_account_root(true), 0, scenario.ctx());
            account::transfer_migration_cap(mcap, OTHER);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        scenario.next_tx(OTHER);
        {
            let mcap = scenario.take_from_sender<account::MigrationCap>();
            account::burn_migration_cap(mcap);
        };
        scenario.end();
    }

    // ============================================================
    // Allowlist root pinning (opt-in mint hardening)
    // ============================================================

    /// Pinning a root, then minting with the identical root, succeeds.
    #[test]
    fun test_pin_allowlist_root_then_matching_mint_succeeds() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            assert!(account::pinned_allowlist_root(&registry).is_none());
            account::pin_allowlist_root(&ucap, &mut registry, import_account_root(true), 1, 0);
            assert!(
                account::pinned_allowlist_root(&registry) == option::some(import_account_root(true))
            );
            let mcap = account::mint_migration_cap(&ucap, &registry, import_account_root(true), scenario.ctx());
            account::burn_migration_cap(mcap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// Once a root is pinned, minting with any other root aborts — a
    /// compromised AdminCap can no longer widen the import snapshot.
    #[test]
    #[expected_failure(abort_code = account::EAllowlistRootMismatch)]
    fun test_pin_allowlist_root_blocks_mismatched_mint() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(&ucap, &mut registry, import_account_root(true), 1, 0);
            // 32 bytes, but not the pinned root → abort.
            let other_root = x"1111111111111111111111111111111111111111111111111111111111111111";
            let mcap = account::mint_migration_cap(&ucap, &registry, other_root, scenario.ctx());
            account::burn_migration_cap(mcap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// Pinning is one-shot: a second pin aborts even for the AdminCap holder.
    #[test]
    #[expected_failure(abort_code = account::EAllowlistRootAlreadyPinned)]
    fun test_double_pin_allowlist_root_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(&ucap, &mut registry, import_account_root(true), 1, 0);
            // Second pin (same or different root) must abort.
            account::pin_allowlist_root(&ucap, &mut registry, import_account_root(true), 1, 0);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// Operators can recover from a bad root/count before any import starts.
    #[test]
    fun test_repin_allowlist_root_before_import_succeeds() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(&admin, &mut registry, empty_root(), 99, 99);
            account::repin_allowlist_root(
                &admin,
                &mut registry,
                import_account_root(true),
                1,
                0,
            );
            assert!(
                account::pinned_allowlist_root(&registry) == option::some(import_account_root(true))
            );
            let cap = account::mint_migration_cap(
                &admin,
                &registry,
                import_account_root(true),
                scenario.ctx(),
            );
            account::burn_migration_cap(cap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    /// A cap minted for the replaced root cannot import against the new root.
    #[test]
    #[expected_failure(abort_code = account::EAllowlistRootMismatch)]
    fun test_repin_makes_old_migration_cap_inert() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::pin_allowlist_root(&admin, &mut registry, empty_root(), 1, 0);
            let old_cap = account::mint_migration_cap(&admin, &registry, empty_root(), scenario.ctx());
            account::repin_allowlist_root(
                &admin,
                &mut registry,
                import_account_root(true),
                1,
                0,
            );
            account::legacy_import_account(
                &old_cap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                true,
                1,
                vector[],
                vector[],
                scenario.ctx(),
            );
            account::burn_migration_cap(old_cap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    /// Once an import has changed registry state, the snapshot is immutable.
    #[test]
    #[expected_failure(abort_code = account::EAllowlistRepinAfterImport)]
    fun test_repin_allowlist_root_after_import_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            let root = import_account_root(true);
            let cap = pin_and_mint(&admin, &mut registry, root, 0, scenario.ctx());
            account::legacy_import_account(
                &cap,
                &mut registry,
                object::id_from_address(LEGACY_ID),
                OTHER,
                true,
                1,
                vector[],
                vector[],
                scenario.ctx(),
            );
            account::repin_allowlist_root(&admin, &mut registry, empty_root(), 0, 0);
            account::burn_migration_cap(cap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };
        scenario.end();
    }

    /// The pinned root must be a 32-byte Blake2b digest, like every other root.
    #[test]
    #[expected_failure(abort_code = account::EInvalidMigrationProof)]
    fun test_pin_allowlist_root_wrong_length_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let mut registry = scenario.take_shared<AccountRegistry>();
            // 31 bytes — one short of a valid root.
            let short_root = x"11111111111111111111111111111111111111111111111111111111111111";
            account::pin_allowlist_root(&ucap, &mut registry, short_root, 1, 0);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }

    /// Minting now requires a pinned root: an unpinned registry rejects the
    /// mint, so no cap can ever be bound to an unreviewed snapshot.
    #[test]
    #[expected_failure(abort_code = account::EAllowlistRootNotPinned)]
    fun test_mint_without_pin_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        init_registry_only(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ucap = account::test_make_admin_cap(scenario.ctx());
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account::pinned_allowlist_root(&registry).is_none());
            let mcap = account::mint_migration_cap(&ucap, &registry, import_account_root(true), scenario.ctx()); // abort — no pin
            account::burn_migration_cap(mcap);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(ucap);
        };
        scenario.end();
    }
}
