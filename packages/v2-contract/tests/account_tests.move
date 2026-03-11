#[test_only]
#[allow(implicit_const_copy)]
module memwal_v2::account_tests {
    use std::string;
    use sui::test_scenario;
    use memwal_v2::account::{Self, MemWalAccount, AdminCap, AccountRegistry};

    const OWNER: address = @0xCAFE;
    const OTHER: address = @0xBEEF;
    const TEE_ADMIN: address = @0xAD01;

    // ============================================================
    // Helper: init + create_account in one go
    // ============================================================

    fun setup_with_account(scenario: &mut test_scenario::Scenario) {
        // Init module (creates AdminCap + AccountRegistry)
        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Create account via registry
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::create_account(&mut registry, scenario.ctx());
            test_scenario::return_shared(registry);
        };
    }

    // ============================================================
    // Init & Admin Tests
    // ============================================================

    #[test]
    fun test_init_creates_admin_cap_and_registry() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Deployer should have AdminCap
        scenario.next_tx(OWNER);
        {
            let cap = scenario.take_from_sender<AdminCap>();
            scenario.return_to_sender(cap);
        };

        // AccountRegistry should be shared
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            assert!(account::admin(&registry) == OWNER);
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    fun test_set_admin() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Change admin to TEE_ADMIN
        scenario.next_tx(OWNER);
        {
            let cap = scenario.take_from_sender<AdminCap>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::set_admin(&cap, &mut registry, TEE_ADMIN);
            assert!(account::admin(&registry) == TEE_ADMIN);
            test_scenario::return_shared(registry);
            scenario.return_to_sender(cap);
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
            let account = scenario.take_from_sender<MemWalAccount>();
            assert!(account.owner() == OWNER);
            assert!(account.delegate_count() == 0);
            scenario.return_to_sender(account);
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
            account::create_account(&mut registry, scenario.ctx());
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
            let mut account = scenario.take_from_sender<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            account::add_delegate_key(
                &mut account,
                pk,
                string::utf8(b"MacBook Pro"),
                scenario.ctx(),
            );
            assert!(account.delegate_count() == 1);
            assert!(account.is_delegate(&pk));
            scenario.return_to_sender(account);
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
            let mut account = scenario.take_from_sender<MemWalAccount>();
            let pk1 = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let pk2 = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

            account::add_delegate_key(
                &mut account,
                pk1,
                string::utf8(b"Key 1"),
                scenario.ctx(),
            );
            account::add_delegate_key(
                &mut account,
                pk2,
                string::utf8(b"Key 2"),
                scenario.ctx(),
            );

            assert!(account.delegate_count() == 2);
            assert!(account.is_delegate(&pk1));
            assert!(account.is_delegate(&pk2));
            scenario.return_to_sender(account);
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
            let mut account = scenario.take_from_sender<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

            account::add_delegate_key(
                &mut account,
                pk,
                string::utf8(b"Temp Key"),
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
            scenario.return_to_sender(account);
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
            let account = scenario.take_from_sender<MemWalAccount>();
            let pk = x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
            assert!(!account.is_delegate(&pk));
            scenario.return_to_sender(account);
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
            let mut account = scenario.take_from_sender<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

            account::add_delegate_key(&mut account, pk, string::utf8(b"Key 1"), scenario.ctx());
            // Adding same key again should fail
            account::add_delegate_key(&mut account, pk, string::utf8(b"Key 2"), scenario.ctx());

            scenario.return_to_sender(account);
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
            let mut account = scenario.take_from_sender<MemWalAccount>();
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            // Removing key that doesn't exist should fail
            account::remove_delegate_key(&mut account, pk, scenario.ctx());

            scenario.return_to_sender(account);
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
            let mut account = scenario.take_from_address<MemWalAccount>(OWNER);
            let pk = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            // This should fail because OTHER is not the owner
            account::add_delegate_key(&mut account, pk, string::utf8(b"Stolen"), scenario.ctx());

            test_scenario::return_to_address(OWNER, account);
        };

        scenario.end();
    }

    // ============================================================
    // SEAL Access Control Tests
    // ============================================================

    #[test]
    fun test_seal_approve_owner() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Owner calls seal_approve with their own key ID → should pass
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let owner_bytes = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_bytes, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    fun test_seal_approve_admin() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Set TEE_ADMIN as admin
        scenario.next_tx(OWNER);
        {
            let cap = scenario.take_from_sender<AdminCap>();
            let mut registry = scenario.take_shared<AccountRegistry>();
            account::set_admin(&cap, &mut registry, TEE_ADMIN);
            test_scenario::return_shared(registry);
            scenario.return_to_sender(cap);
        };

        // TEE_ADMIN calls seal_approve for OWNER's data → should pass
        scenario.next_tx(TEE_ADMIN);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let owner_key_id = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_key_id, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun test_seal_approve_unauthorized() {
        let mut scenario = test_scenario::begin(OWNER);

        scenario.next_tx(OWNER);
        {
            account::test_init(scenario.ctx());
        };

        // Random address tries to decrypt OWNER's data → should fail
        scenario.next_tx(OTHER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let owner_key_id = sui::bcs::to_bytes(&OWNER);
            account::seal_approve(owner_key_id, &registry, scenario.ctx());
            test_scenario::return_shared(registry);
        };

        scenario.end();
    }
}
