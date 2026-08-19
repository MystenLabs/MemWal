#[test_only]
#[allow(deprecated_usage)]
module memwal::namespace_tests {
    use std::string::{Self, String};
    use sui::clock;
    use sui::test_scenario;
    use memwal::account::{Self, AccountRegistry, MemWalAccount};
    use memwal::namespace::{Self, MemoryNamespace, NamespaceRegistry};

    const OWNER: address = @0xCAFE;
    const OTHER: address = @0xBEEF;
    const D1: address = @0x9f89215dc3a091bc288a2ddfb1860f0cb9efc4d39a2bb728944f741a650a7fb1;
    const D2: address = @0xcbb8c34831749c2416ec0339bfc46f42d696576d08d8621e39ef767c42933d77;
    const D3: address = @0x9ee170bac49919c40436fe41ef78c8f0f886a5bd547a1968d51a40734fff58ae;

    fun pk1(): vector<u8> { x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    fun pk2(): vector<u8> { x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    fun pk3(): vector<u8> { x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }

    fun wrapped(byte: u8): vector<u8> {
        wrapped_len(byte, 32)
    }

    fun wrapped_len(byte: u8, length: u64): vector<u8> {
        let mut value = vector::empty();
        let mut i = 0;
        while (i < length) {
            value.push_back(byte);
            i = i + 1;
        };
        value
    }

    /// Publish both modules, finalize the account import window, create OWNER's
    /// account, and register three real account delegates used by ACL tests.
    fun setup_account(scenario: &mut test_scenario::Scenario): ID {
        scenario.next_tx(OWNER);
        account::test_init(scenario.ctx());
        namespace::test_init(scenario.ctx());

        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let admin = account::test_make_admin_cap(scenario.ctx());
            account::pin_allowlist_root(&admin, &mut registry, wrapped(0), 0, 0);
            let clock = clock::create_for_testing(scenario.ctx());
            account::finalize_migration(&admin, &mut registry, &clock, wrapped(1), 900000);
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
            sui::test_utils::destroy(admin);
        };

        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared<MemWalAccount>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(&mut managed, &registry, pk1(), string::utf8(b"delegate-1"), &clock, scenario.ctx());
            account::add_delegate_key(&mut managed, &registry, pk2(), string::utf8(b"delegate-2"), &clock, scenario.ctx());
            account::add_delegate_key(&mut managed, &registry, pk3(), string::utf8(b"delegate-3"), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };

        scenario.next_tx(OWNER);
        {
            let managed = scenario.take_shared<MemWalAccount>();
            let id = object::id(&managed);
            test_scenario::return_shared(managed);
            id
        }
    }

    fun create_namespace(
        scenario: &mut test_scenario::Scenario,
        account_id: ID,
        label: String,
    ): ID {
        scenario.next_tx(OWNER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::create_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                label,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };

        scenario.next_tx(OWNER);
        {
            let ns = scenario.take_shared<MemoryNamespace>();
            let id = object::id(&ns);
            test_scenario::return_shared(ns);
            id
        }
    }

    fun initialize_namespace(
        scenario: &mut test_scenario::Scenario,
        account_id: ID,
        namespace_id: ID,
        dek: vector<u8>,
    ) {
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::initialize_key(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                dek,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
    }

    fun setup_namespace(scenario: &mut test_scenario::Scenario): (ID, ID) {
        let account_id = setup_account(scenario);
        let namespace_id = create_namespace(scenario, account_id, string::utf8(b"project-a"));
        initialize_namespace(scenario, account_id, namespace_id, wrapped(2));
        (account_id, namespace_id)
    }

    fun owner_grant(
        scenario: &mut test_scenario::Scenario,
        account_id: ID,
        namespace_id: ID,
        principal: address,
        read: bool,
        write: bool,
        share: bool,
        _legacy_rotation_dek: vector<u8>,
    ) {
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::grant_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                principal,
                read,
                write,
                share,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
    }

    fun seal_as(
        scenario: &mut test_scenario::Scenario,
        caller: address,
        account_id: ID,
        namespace_id: ID,
        key_version: u64,
    ) {
        scenario.next_tx(caller);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::seal_approve(
                namespace::seal_key_id(namespace_id, key_version),
                &ns_registry,
                &account_registry,
                &managed,
                &ns,
                scenario.ctx(),
            );
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
    }

    fun write_as(
        scenario: &mut test_scenario::Scenario,
        caller: address,
        account_id: ID,
        namespace_id: ID,
        key_version: u64,
    ) {
        scenario.next_tx(caller);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            let written = namespace::write_fence(
                namespace::seal_key_id(namespace_id, key_version),
                &ns_registry,
                &account_registry,
                &managed,
                &ns,
                wrapped(1),
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::memory_written_namespace_id(&written) == namespace_id);
            assert!(namespace::memory_written_account_id(&written) == account_id);
            assert!(namespace::memory_written_key_version(&written) == key_version);
            assert!(namespace::memory_written_commitment(&written) == &wrapped(1));
            assert!(namespace::memory_written_writer(&written) == caller);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
    }

    // ============================================================
    // Registry, creation, and two-phase initialization
    // ============================================================

    #[test]
    fun test_init_and_current_registry_version() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_account(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<NamespaceRegistry>();
            assert!(namespace::registry_version(&registry) == namespace::current_version());
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    fun test_migrate_namespace_registry() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_account(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<NamespaceRegistry>();
            namespace::test_set_registry_version(&mut registry, 0);
            let admin = account::test_make_admin_cap(scenario.ctx());
            namespace::migrate_namespace_registry(&admin, &mut registry);
            assert!(namespace::registry_version(&registry) == namespace::current_version());
            sui::test_utils::destroy(admin);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAlreadyMigrated)]
    fun test_migrate_current_registry_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        setup_account(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<NamespaceRegistry>();
            let admin = account::test_make_admin_cap(scenario.ctx());
            namespace::migrate_namespace_registry(&admin, &mut registry);
            sui::test_utils::destroy(admin);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EWrongVersion)]
    fun test_wrong_namespace_registry_version_blocks_creation() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let mut registry = scenario.take_shared<NamespaceRegistry>();
            namespace::test_set_registry_version(&mut registry, 0);
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::create_namespace(
                &mut registry,
                &account_registry,
                &managed,
                string::utf8(b"blocked"),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    fun test_create_is_uninitialized_and_permanently_indexed() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"project-a"));
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<NamespaceRegistry>();
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            assert!(namespace::owner(&ns) == OWNER);
            assert!(namespace::account_id(&ns) == account_id);
            assert!(!namespace::is_key_initialized(&ns));
            assert!(!namespace::is_active(&ns));
            assert!(!namespace::is_destroyed(&ns));
            assert!(namespace::has_namespace(&registry, account_id, &string::utf8(b"project-a")));
            test_scenario::return_shared(ns);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENotAccountOwner)]
    fun test_non_owner_cannot_create_namespace() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        scenario.next_tx(OTHER);
        {
            let mut registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::create_namespace(
                &mut registry,
                &account_registry,
                &managed,
                string::utf8(b"not-owner"),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidLabel)]
    fun test_empty_label_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        create_namespace(&mut scenario, account_id, string::utf8(b""));
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidLabel)]
    fun test_oversized_label_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        create_namespace(
            &mut scenario,
            account_id,
            string::utf8(b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        );
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceAlreadyExists)]
    fun test_duplicate_account_label_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        create_namespace(&mut scenario, account_id, string::utf8(b"duplicate"));
        create_namespace(&mut scenario, account_id, string::utf8(b"duplicate"));
        scenario.end();
    }

    #[test]
    fun test_initialize_key_stores_wrapped_dek_and_contract_commitment() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"init"));
        initialize_namespace(&mut scenario, account_id, namespace_id, wrapped(7));
        scenario.next_tx(OWNER);
        {
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let expected = sui::hash::blake2b256(&wrapped(7));
            assert!(namespace::is_key_initialized(&ns));
            assert!(namespace::is_active(&ns));
            assert!(namespace::current_key_version(&ns) == 0);
            assert!(namespace::key_version_exists(&ns, 0));
            assert!(namespace::wrapped_dek(&ns, 0) == &wrapped(7));
            assert!(namespace::key_commitment(&ns, 0) == &expected);
            assert!(!namespace::is_key_shredded(&ns, 0));
            test_scenario::return_shared(ns);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyAlreadyInitialized)]
    fun test_initialize_key_twice_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        initialize_namespace(&mut scenario, account_id, namespace_id, wrapped(8));
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidWrappedDek)]
    fun test_empty_wrapped_dek_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"empty-dek"));
        initialize_namespace(&mut scenario, account_id, namespace_id, vector::empty());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidWrappedDek)]
    fun test_oversized_wrapped_dek_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"large-dek"));
        initialize_namespace(&mut scenario, account_id, namespace_id, wrapped_len(9, 16385));
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyNotInitialized)]
    fun test_uninitialized_namespace_denies_seal() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"pending"));
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    // ============================================================
    // Hybrid ACL policy: arbitrary READ/WRITE, trusted-delegate SHARE
    // ============================================================

    #[test]
    fun test_owner_grants_read_write_and_owner_is_implicit_admin() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, true, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            assert!(namespace::can_read(&ns, D1));
            assert!(namespace::can_write(&ns, D1));
            assert!(!namespace::can_share(&ns, D1));
            assert!(namespace::can_read(&ns, OWNER));
            assert!(namespace::can_write(&ns, OWNER));
            assert!(namespace::can_share(&ns, OWNER));
            test_scenario::return_shared(ns);
        };
        seal_as(&mut scenario, D1, account_id, namespace_id, 0);
        write_as(&mut scenario, D1, account_id, namespace_id, 0);
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        write_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    fun test_owner_can_grant_arbitrary_wallet_read_write() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, OTHER, true, true, false, vector::empty());
        seal_as(&mut scenario, OTHER, account_id, namespace_id, 0);
        write_as(&mut scenario, OTHER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EShareRequiresAccountDelegate)]
    fun test_owner_cannot_grant_share_to_arbitrary_wallet() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, OTHER, true, false, true, vector::empty());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENoWriteAccess)]
    fun test_arbitrary_read_only_wallet_cannot_write() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, OTHER, true, false, false, vector::empty());
        seal_as(&mut scenario, OTHER, account_id, namespace_id, 0);
        write_as(&mut scenario, OTHER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    fun test_namespace_acl_scales_beyond_account_delegate_cap() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        let principals = vector[
            @0x100, @0x101, @0x102, @0x103, @0x104, @0x105, @0x106,
            @0x107, @0x108, @0x109, @0x10a, @0x10b, @0x10c, @0x10d,
            @0x10e, @0x10f, @0x110, @0x111, @0x112, @0x113, @0x114,
        ];
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            let mut i = 0;
            while (i < principals.length()) {
                namespace::grant_access(
                    &ns_registry,
                    &account_registry,
                    &managed,
                    &mut ns,
                    principals[i],
                    true,
                    false,
                    false,
                    &clock,
                    scenario.ctx(),
                );
                i = i + 1;
            };
            let mut j = 0;
            while (j < principals.length()) {
                assert!(namespace::can_read(&ns, principals[j]));
                assert!(!namespace::can_share(&ns, principals[j]));
                j = j + 1;
            };
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EWriteRequiresRead)]
    fun test_write_without_read_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, false, true, false, vector::empty());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidPermissions)]
    fun test_zero_permission_grant_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, false, false, false, vector::empty());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EPermissionsUnchanged)]
    fun test_unchanged_grant_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        scenario.end();
    }

    #[test]
    fun test_share_manager_can_grant_read_write_to_arbitrary_wallet() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());

        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::grant_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                OTHER,
                true,
                true,
                false,
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::can_read(&ns, OTHER));
            assert!(namespace::can_write(&ns, OTHER));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        seal_as(&mut scenario, OTHER, account_id, namespace_id, 0);
        write_as(&mut scenario, OTHER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ECannotModifyOwnPermissions)]
    fun test_share_manager_cannot_self_escalate() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::grant_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D1,
                true,
                true,
                true,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EOnlyOwnerCanManageShare)]
    fun test_share_manager_cannot_grant_share() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::grant_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D2,
                true,
                false,
                true,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENoShareAccess)]
    fun test_non_share_delegate_cannot_manage_acl() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::grant_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D2,
                true,
                false,
                false,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENoWriteAccess)]
    fun test_read_only_delegate_cannot_write() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        seal_as(&mut scenario, D1, account_id, namespace_id, 0);
        write_as(&mut scenario, D1, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENoReadAccess)]
    fun test_current_but_ungranted_delegate_cannot_decrypt() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        seal_as(&mut scenario, D3, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENoReadAccess)]
    fun test_arbitrary_wallet_acl_is_namespace_scoped() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let first_id = create_namespace(&mut scenario, account_id, string::utf8(b"first"));
        initialize_namespace(&mut scenario, account_id, first_id, wrapped(2));
        let second_id = create_namespace(&mut scenario, account_id, string::utf8(b"second"));
        initialize_namespace(&mut scenario, account_id, second_id, wrapped(3));
        owner_grant(&mut scenario, account_id, first_id, OTHER, true, false, false, vector::empty());
        seal_as(&mut scenario, OTHER, account_id, first_id, 0);
        seal_as(&mut scenario, OTHER, account_id, second_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENoReadAccess)]
    fun test_arbitrary_wallet_revoke_rotates_and_denies_access() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, OTHER, true, false, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                OTHER,
                wrapped(19),
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::current_key_version(&ns) == 1);
            assert!(!namespace::can_read(&ns, OTHER));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        seal_as(&mut scenario, OTHER, account_id, namespace_id, 1);
        scenario.end();
    }

    #[test]
    fun test_removed_account_delegate_retains_explicit_namespace_read() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::remove_delegate_key(&mut managed, &registry, pk1(), scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        seal_as(&mut scenario, D1, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EShareRequiresAccountDelegate)]
    fun test_removed_account_delegate_loses_share_authority() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::remove_delegate_key(&mut managed, &registry, pk1(), scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        // READ remains namespace-local, but trusted SHARE authority does not.
        seal_as(&mut scenario, D1, account_id, namespace_id, 0);
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::grant_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                OTHER,
                true,
                false,
                false,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    fun test_share_role_removal_preserves_read_without_rotation() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            assert!(namespace::can_read(&ns, D1));
            assert!(!namespace::can_share(&ns, D1));
            assert!(namespace::current_key_version(&ns) == 0);
            test_scenario::return_shared(ns);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EShareRequiresRead)]
    fun test_share_role_requires_read() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, false, false, true, vector::empty());
        scenario.end();
    }

    #[test]
    fun test_revoke_read_rotates_and_rejects_stale_write() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, true, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D1,
                wrapped(4),
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::current_key_version(&ns) == 1);
            assert!(!namespace::can_read(&ns, D1));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        // Owner is authorized, but version zero is stale for new writes.
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            assert!(namespace::current_key_version(&ns) == 1);
            namespace::seal_approve(
                namespace::seal_key_id(namespace_id, 0),
                &ns_registry,
                &account_registry,
                &managed,
                &ns,
                scenario.ctx(),
            );
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    fun test_revoke_read_share_role_rotates() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D1,
                wrapped(5),
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::current_key_version(&ns) == 1);
            assert!(!namespace::can_read(&ns, D1));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EGrantNotFound)]
    fun test_revoke_missing_grant_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D1,
                wrapped(4),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    // ============================================================
    // Seal identity, rotation, historical recovery, and shred
    // ============================================================

    #[test]
    fun test_rotate_preserves_historical_owner_decryption_and_updates_state() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::rotate_key(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                wrapped(5),
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::current_key_version(&ns) == 1);
            assert!(namespace::key_retired_at_ms(&ns, 0).is_some());
            assert!(namespace::wrapped_dek(&ns, 1) == &wrapped(5));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 1);
        write_as(&mut scenario, OWNER, account_id, namespace_id, 1);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyVersionNotFound)]
    fun test_future_key_version_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 1);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidSealId)]
    fun test_cross_namespace_seal_id_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_a) = setup_namespace(&mut scenario);
        let namespace_b = create_namespace(&mut scenario, account_id, string::utf8(b"project-b"));
        initialize_namespace(&mut scenario, account_id, namespace_b, wrapped(6));
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let ns_b = scenario.take_shared_by_id<MemoryNamespace>(namespace_b);
            namespace::seal_approve(
                namespace::seal_key_id(namespace_a, 0),
                &ns_registry,
                &account_registry,
                &managed,
                &ns_b,
                scenario.ctx(),
            );
            test_scenario::return_shared(ns_b);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidSealId)]
    fun test_malformed_seal_id_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::seal_approve(
                x"00112233",
                &ns_registry,
                &account_registry,
                &managed,
                &ns,
                scenario.ctx(),
            );
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    fun test_shred_historical_version_clears_wrapper_and_marks_state() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::rotate_key(&ns_registry, &account_registry, &managed, &mut ns, wrapped(7), &clock, scenario.ctx());
            namespace::crypto_shred_key_version(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                0,
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::is_key_shredded(&ns, 0));
            assert!(namespace::wrapped_dek(&ns, 0).length() == 0);
            assert!(namespace::key_shredded_at_ms(&ns, 0).is_some());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyVersionShredded)]
    fun test_shredded_version_denies_seal() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::rotate_key(&ns_registry, &account_registry, &managed, &mut ns, wrapped(7), &clock, scenario.ctx());
            namespace::crypto_shred_key_version(&ns_registry, &account_registry, &managed, &mut ns, 0, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ECannotShredCurrentVersion)]
    fun test_cannot_shred_current_version() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_key_version(&ns_registry, &account_registry, &managed, &mut ns, 0, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    fun test_high_key_version_still_rotates() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            // Artificial 10_000 caps are gone: a high existing version must still
            // rotate, or revoke would deadlock and tombstone the label.
            namespace::test_set_current_key_version(&mut ns, 9999, wrapped(8));
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::rotate_key(&ns_registry, &account_registry, &managed, &mut ns, wrapped(9), &clock, scenario.ctx());
            assert!(namespace::current_key_version(&ns) == 10000);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    // ============================================================
    // Reversible freeze, account containment, and terminal O(1) destroy
    // ============================================================

    #[test]
    fun test_deactivate_and_reactivate_namespace() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::deactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            assert!(!namespace::is_active(&ns));
            namespace::reactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            assert!(namespace::is_active(&ns));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountInactive)]
    fun test_admin_quarantine_dominates_namespace_acl() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OTHER);
        {
            let admin = account::test_make_admin_cap(scenario.ctx());
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::admin_deactivate_account(&admin, &mut managed);
            assert!(account::is_admin_quarantined(&managed));
            test_scenario::return_shared(managed);
            sui::test_utils::destroy(admin);
        };
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceInactive)]
    fun test_inactive_namespace_denies_seal() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::deactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountInactive)]
    fun test_inactive_account_dominates_namespace_acl() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::deactivate_account(&mut managed, &registry, scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    fun test_destroy_is_terminal_and_constant_cost_at_high_version() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            // A discontinuous high-version fixture proves destroy does not walk
            // 0..current; production histories stay contiguous.
            namespace::test_set_current_key_version(&mut ns, 9999, wrapped(8));
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::is_destroyed(&ns));
            assert!(!namespace::is_active(&ns));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_destroyed_namespace_cannot_reactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            namespace::reactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_destroyed_namespace_cannot_rotate() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            namespace::rotate_key(&ns_registry, &account_registry, &managed, &mut ns, wrapped(9), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_destroyed_namespace_denies_seal() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    // ============================================================
    // Additional negative branches and cross-object invariants
    // ============================================================

    #[test]
    #[expected_failure(abort_code = namespace::ENotCurrentKeyVersion)]
    fun test_stale_write_after_read_revocation_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, true, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D1,
                wrapped(10),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        write_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EOnlyOwnerCanManageShare)]
    fun test_share_manager_cannot_revoke_another_share_manager() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        owner_grant(&mut scenario, account_id, namespace_id, D2, true, false, true, vector::empty());
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D2,
                vector::empty(),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EShareRequiresRead)]
    fun test_share_only_role_cannot_be_created_for_sybil_safety() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, false, false, true, vector::empty());
        scenario.end();
    }

    #[test]
    fun test_read_share_manager_can_revoke_arbitrary_reader_and_rotate() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        owner_grant(&mut scenario, account_id, namespace_id, OTHER, true, false, false, vector::empty());
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                OTHER,
                wrapped(11),
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::current_key_version(&ns) == 1);
            assert!(!namespace::can_read(&ns, OTHER));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    fun test_owner_can_clean_acl_after_account_delegate_removal() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::remove_delegate_key(&mut managed, &registry, pk1(), scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                D1,
                wrapped(12),
                &clock,
                scenario.ctx(),
            );
            assert!(!namespace::can_read(&ns, D1));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidPrincipal)]
    fun test_owner_cannot_be_inserted_into_explicit_acl() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, OWNER, true, true, true, vector::empty());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidPrincipal)]
    fun test_zero_address_cannot_be_acl_principal() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, @0x0, true, false, false, vector::empty());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENotAccountOwner)]
    fun test_non_owner_cannot_initialize_key() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"non-owner-init"));
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::initialize_key(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                wrapped(13),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EWrongVersion)]
    fun test_wrong_account_registry_version_blocks_namespace_policy() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let mut account_registry = scenario.take_shared<AccountRegistry>();
            account::test_set_registry_version(&mut account_registry, 1);
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::seal_approve(
                namespace::seal_key_id(namespace_id, 0),
                &ns_registry,
                &account_registry,
                &managed,
                &ns,
                scenario.ctx(),
            );
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountMismatch)]
    fun test_namespace_rejects_different_account_object() {
        let mut scenario = test_scenario::begin(OWNER);
        let (owner_account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OTHER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };
        scenario.next_tx(OTHER);
        let other_account_id = {
            let managed = scenario.take_shared<MemWalAccount>();
            let id = object::id(&managed);
            assert!(id != owner_account_id);
            test_scenario::return_shared(managed);
            id
        };
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let wrong_account = scenario.take_shared_by_id<MemWalAccount>(other_account_id);
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::seal_approve(
                namespace::seal_key_id(namespace_id, 0),
                &ns_registry,
                &account_registry,
                &wrong_account,
                &ns,
                scenario.ctx(),
            );
            test_scenario::return_shared(ns);
            test_scenario::return_shared(wrong_account);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountMismatch)]
    fun test_namespace_rejects_corrupted_owner_linkage() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::test_set_owner(&mut ns, OTHER);
            test_scenario::return_shared(ns);
        };
        seal_as(&mut scenario, OWNER, account_id, namespace_id, 0);
        scenario.end();
    }

    #[test]
    fun test_suffix_comparison_defensively_rejects_longer_suffix() {
        assert!(!namespace::test_has_suffix(&b"short", &b"longer"));
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidPermissions)]
    fun test_revoke_rejects_corrupted_role_without_read() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        scenario.next_tx(OWNER);
        {
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::test_set_permissions(&mut ns, D1, 4);
            test_scenario::return_shared(ns);
        };
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(&ns_registry, &account_registry, &managed, &mut ns, D1, wrapped(20), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENoReadAccess)]
    fun test_corrupted_share_only_manager_cannot_supply_key() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        owner_grant(&mut scenario, account_id, namespace_id, D2, true, false, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::test_set_permissions(&mut ns, D1, 4);
            test_scenario::return_shared(ns);
        };
        scenario.next_tx(D1);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(&ns_registry, &account_registry, &managed, &mut ns, D2, wrapped(21), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyVersionNotFound)]
    fun test_shred_missing_historical_version_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::rotate_key(&ns_registry, &account_registry, &managed, &mut ns, wrapped(14), &clock, scenario.ctx());
            namespace::crypto_shred_key_version(
                &ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                99,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyVersionShredded)]
    fun test_shred_same_version_twice_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::rotate_key(&ns_registry, &account_registry, &managed, &mut ns, wrapped(15), &clock, scenario.ctx());
            namespace::crypto_shred_key_version(&ns_registry, &account_registry, &managed, &mut ns, 0, &clock, scenario.ctx());
            namespace::crypto_shred_key_version(&ns_registry, &account_registry, &managed, &mut ns, 0, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_destroy_namespace_twice_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    fun test_all_namespace_views_are_readable() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<NamespaceRegistry>();
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            assert!(namespace::label(&ns).as_bytes() == b"project-a");
            assert!(namespace::created_at_ms(&ns) == 0);
            assert!(namespace::key_created_at_ms(&ns, 0) == 0);
            assert!(namespace::key_version_exists(&ns, 0));
            assert!(!namespace::is_key_shredded(&ns, 0));
            assert!(namespace::key_commitment(&ns, 0).length() == 32);
            assert!(namespace::wrapped_dek(&ns, 0).length() == 32);
            assert!(namespace::permissions(&ns, OWNER) == 7);
            assert!(namespace::permissions(&ns, D3) == 0);
            assert!(namespace::current_key_version(&ns) == 0);
            assert!(namespace::current_version() == 1);
            assert!(namespace::commitment_length() == 32);
            assert!(namespace::has_namespace(&registry, account_id, namespace::label(&ns)));
            test_scenario::return_shared(ns);
            test_scenario::return_shared(registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountInactive)]
    fun test_inactive_account_blocks_namespace_creation() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::deactivate_account(&mut managed, &registry, scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        create_namespace(&mut scenario, account_id, string::utf8(b"blocked"));
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountInactive)]
    fun test_inactive_account_blocks_key_initialization() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"blocked-init"));
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::deactivate_account(&mut managed, &registry, scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        initialize_namespace(&mut scenario, account_id, namespace_id, wrapped(16));
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyNotInitialized)]
    fun test_uninitialized_namespace_cannot_reactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"not-ready"));
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::reactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceAlreadyActive)]
    fun test_active_namespace_cannot_reactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::reactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceInactive)]
    fun test_inactive_namespace_cannot_deactivate_twice() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::deactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            namespace::deactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_destroyed_namespace_cannot_deactivate() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            namespace::deactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountInactive)]
    fun test_inactive_account_blocks_namespace_destroy() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::deactivate_account(&mut managed, &registry, scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EAccountInactive)]
    fun test_inactive_account_blocks_namespace_reactivation() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::deactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.next_tx(OWNER);
        {
            let registry = scenario.take_shared<AccountRegistry>();
            let mut managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            account::deactivate_account(&mut managed, &registry, scenario.ctx());
            test_scenario::return_shared(managed);
            test_scenario::return_shared(registry);
        };
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::reactivate_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyVersionNotFound)]
    fun test_missing_key_view_fails_closed() {
        let mut scenario = test_scenario::begin(OWNER);
        let (_account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            namespace::is_key_shredded(&ns, 99);
            test_scenario::return_shared(ns);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidWrappedDek)]
    fun test_revoke_requires_replacement_wrapped_dek() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, false, vector::empty());
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::revoke_access(&ns_registry, &account_registry, &managed, &mut ns, D1, vector::empty(), &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EShareRequiresRead)]
    fun test_share_role_cannot_survive_read_removal() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        owner_grant(&mut scenario, account_id, namespace_id, D1, true, false, true, vector::empty());
        owner_grant(&mut scenario, account_id, namespace_id, D1, false, false, true, vector::empty());
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_destroyed_uninitialized_namespace_cannot_initialize() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"destroy-before-init"));
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        initialize_namespace(&mut scenario, account_id, namespace_id, wrapped(18));
        scenario.end();
    }

    #[test]
    fun test_cancel_uninitialized_namespace_releases_label() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let first_id = create_namespace(&mut scenario, account_id, string::utf8(b"reusable"));
        scenario.next_tx(OWNER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(first_id);
            let clock = clock::create_for_testing(scenario.ctx());
            let cancelled = namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            assert!(namespace::is_destroyed(&ns));
            assert!(!namespace::is_key_initialized(&ns));
            assert!(!namespace::has_namespace(&ns_registry, account_id, &string::utf8(b"reusable")));
            assert!(namespace::namespace_cancelled_namespace_id(&cancelled) == first_id);
            assert!(namespace::namespace_cancelled_account_id(&cancelled) == account_id);
            assert!(namespace::namespace_cancelled_owner(&cancelled) == OWNER);
            assert!(namespace::namespace_cancelled_label(&cancelled).as_bytes() == b"reusable");
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        let reused_id = create_namespace(&mut scenario, account_id, string::utf8(b"reusable"));
        assert!(reused_id != first_id);
        initialize_namespace(&mut scenario, account_id, reused_id, wrapped(21));
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EKeyAlreadyInitialized)]
    fun test_cancel_initialized_namespace_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::EInvalidCommitment)]
    fun test_write_fence_rejects_wrong_commitment_length() {
        let mut scenario = test_scenario::begin(OWNER);
        let (account_id, namespace_id) = setup_namespace(&mut scenario);
        scenario.next_tx(OWNER);
        {
            let ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::write_fence(
                namespace::seal_key_id(namespace_id, 0),
                &ns_registry,
                &account_registry,
                &managed,
                &ns,
                b"too-short",
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    fun test_seal_id_golden_vectors_are_little_endian_bcs() {
        // Hard-coded 40-byte tails for other-language SDKs to match.
        // namespace_id = 0x0000...00cafe; versions 1 and 10000 as BCS little-endian u64.
        let namespace_id = object::id_from_address(@0xcafe);
        let expected_v1 = x"000000000000000000000000000000000000000000000000000000000000cafe0100000000000000";
        let expected_v10000 = x"000000000000000000000000000000000000000000000000000000000000cafe1027000000000000";
        assert!(namespace::seal_key_id(namespace_id, 1) == expected_v1);
        assert!(namespace::seal_key_id(namespace_id, 10000) == expected_v10000);
        assert!(namespace::test_decode_trailing_u64(&expected_v1) == 1);
        assert!(namespace::test_decode_trailing_u64(&expected_v10000) == 10000);

        // Seal may prepend a domain-separation prefix; only the 40-byte suffix is canonical.
        let mut prefixed = x"aabb";
        prefixed.append(expected_v1);
        assert!(namespace::test_has_suffix(&prefixed, &expected_v1));
        assert!(namespace::test_decode_trailing_u64(&prefixed) == 1);
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENotAccountOwner)]
    fun test_non_owner_cannot_cancel_uninitialized_namespace() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"cancel-auth"));
        scenario.next_tx(OTHER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_cancel_uninitialized_namespace_twice_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"cancel-twice"));
        scenario.next_tx(OWNER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_cancel_then_initialize_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"cancel-then-init"));
        scenario.next_tx(OWNER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        initialize_namespace(&mut scenario, account_id, namespace_id, wrapped(22));
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_shred_then_cancel_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"shred-then-cancel"));
        scenario.next_tx(OWNER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = namespace::ENamespaceDestroyed)]
    fun test_cancel_then_shred_fails() {
        let mut scenario = test_scenario::begin(OWNER);
        let account_id = setup_account(&mut scenario);
        let namespace_id = create_namespace(&mut scenario, account_id, string::utf8(b"cancel-then-shred"));
        scenario.next_tx(OWNER);
        {
            let mut ns_registry = scenario.take_shared<NamespaceRegistry>();
            let account_registry = scenario.take_shared<AccountRegistry>();
            let managed = scenario.take_shared_by_id<MemWalAccount>(account_id);
            let mut ns = scenario.take_shared_by_id<MemoryNamespace>(namespace_id);
            let clock = clock::create_for_testing(scenario.ctx());
            namespace::cancel_uninitialized_namespace(
                &mut ns_registry,
                &account_registry,
                &managed,
                &mut ns,
                &clock,
                scenario.ctx(),
            );
            namespace::crypto_shred_namespace(&ns_registry, &account_registry, &managed, &mut ns, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(ns);
            test_scenario::return_shared(managed);
            test_scenario::return_shared(account_registry);
            test_scenario::return_shared(ns_registry);
        };
        scenario.end();
    }
}
