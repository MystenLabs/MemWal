#[test_only]
module memwal_v2::account_tests {
    use std::string;
    use sui::test_scenario;
    use memwal_v2::account::{Self, MemWalAccount};

    const OWNER: address = @0xCAFE;
    const OTHER: address = @0xBEEF;

    #[test]
    fun test_create_account() {
        let mut scenario = test_scenario::begin(OWNER);

        // Create account
        {
            account::create_account(scenario.ctx());
        };

        // Verify account was created and transferred to owner
        scenario.next_tx(OWNER);
        {
            let account = scenario.take_from_sender<MemWalAccount>();
            assert!(account.owner() == OWNER);
            assert!(account.delegate_count() == 0);
            scenario.return_to_sender(account);
        };

        scenario.end();
    }

    #[test]
    fun test_add_delegate_key() {
        let mut scenario = test_scenario::begin(OWNER);

        // Create account
        {
            account::create_account(scenario.ctx());
        };

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

        // Create account
        {
            account::create_account(scenario.ctx());
        };

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

        // Create account
        {
            account::create_account(scenario.ctx());
        };

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

        // Create account
        {
            account::create_account(scenario.ctx());
        };

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
    #[expected_failure]
    fun test_add_duplicate_key_fails() {
        let mut scenario = test_scenario::begin(OWNER);

        {
            account::create_account(scenario.ctx());
        };

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
    #[expected_failure]
    fun test_remove_nonexistent_key_fails() {
        let mut scenario = test_scenario::begin(OWNER);

        {
            account::create_account(scenario.ctx());
        };

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
    #[expected_failure]
    fun test_non_owner_cannot_add_key() {
        let mut scenario = test_scenario::begin(OWNER);

        {
            account::create_account(scenario.ctx());
        };

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
}
