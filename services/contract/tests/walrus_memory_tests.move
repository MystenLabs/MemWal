/// V2 tests — focus on the `seal_approve` security properties (the original bug
/// regression + the design §9 attack table), plus core ACL / migration flows.
#[test_only]
module walrus_memory::walrus_memory_tests {
    use sui::test_scenario::{Self as ts};
    use sui::clock;
    use walrus_memory::account::{Self, Account, AccountRegistry};
    use walrus_memory::namespace::{Self, MemoryNamespace, MemBlob};
    use walrus_memory::seal;

    const OWNER: address = @0x0A;
    const DELEGATE: address = @0xDE;
    const GUEST: address = @0x6E;
    const ATTACKER: address = @0xBAD;
    const NEWOWNER: address = @0xACE;

    const READ: u8 = 1;
    const WRITE: u8 = 2;

    const E_NO_ACCESS: u64 = 100;       // walrus_memory::seal + account::authn
    const E_WRONG_VERSION: u64 = 7;     // walrus_memory::account
    const E_NO_PERMISSION: u64 = 201;   // walrus_memory::namespace (write path)
    const E_WRONG_NAMESPACE: u64 = 203; // walrus_memory::namespace

    // --- helpers -------------------------------------------------------------

    fun seal_id(ns: &MemoryNamespace): vector<u8> {
        seal::namespace_seal_id(object::id(ns), 1)
    }

    fun dispose(reg: AccountRegistry, account: Account, ns: MemoryNamespace) {
        account::test_consume_registry(reg);
        transfer::public_transfer(account, @0x0);
        transfer::public_transfer(ns, @0x0);
    }

    // --- happy paths ---------------------------------------------------------

    #[test]
    fun test_owner_can_read() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        seal::test_seal_approve(seal_id(&ns), &account, &ns, &reg, sc.ctx());

        dispose(reg, account, ns);
        sc.end();
    }

    #[test]
    fun test_delegate_with_read_can_read() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let mut account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        account::test_add_delegate(&mut account, DELEGATE, READ, 1);
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        // Signed by the delegate key, not the owner.
        sc.next_tx(DELEGATE);
        seal::test_seal_approve(seal_id(&ns), &account, &ns, &reg, sc.ctx());

        dispose(reg, account, ns);
        sc.end();
    }

    #[test]
    fun test_acl_guest_with_read_can_read() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let owner_account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        // Guest has their OWN canonical account.
        let guest_account = account::test_register_account(&mut reg, GUEST, true, sc.ctx());
        let mut ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());
        namespace::test_set_acl(&mut ns, GUEST, READ, sc.ctx());

        sc.next_tx(GUEST);
        seal::test_seal_approve(seal_id(&ns), &guest_account, &ns, &reg, sc.ctx());

        transfer::public_transfer(owner_account, @0x0);
        dispose(reg, guest_account, ns);
        sc.end();
    }

    #[test]
    fun test_transfer_ownership_lets_new_owner_read_without_reencrypt() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let owner_account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        let new_owner_account = account::test_register_account(&mut reg, NEWOWNER, true, sc.ctx());
        let mut ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        let id_before = seal_id(&ns);
        namespace::test_transfer_ownership(&mut ns, NEWOWNER, sc.ctx()); // sender = OWNER

        // Identity is unchanged (owner-free id): same bytes before/after transfer.
        assert!(id_before == seal_id(&ns), 0);
        assert!(namespace::namespace_owner(&ns) == NEWOWNER, 1);

        sc.next_tx(NEWOWNER);
        seal::test_seal_approve(seal_id(&ns), &new_owner_account, &ns, &reg, sc.ctx());

        transfer::public_transfer(owner_account, @0x0);
        dispose(reg, new_owner_account, ns);
        sc.end();
    }

    // --- the original bug regression + attack table (must be DENIED) ---------

    /// The original cross-account break: attacker uses their OWN (delegate-laden)
    /// account but targets the victim's id. V2 binds the id to the namespace, so
    /// the attacker's namespace doesn't match the victim's id → step 5 denies.
    #[test]
    #[expected_failure(abort_code = E_NO_ACCESS, location = walrus_memory::seal)]
    fun test_old_bug_cross_account_denied_by_id_binding() {
        let mut sc = ts::begin(ATTACKER);
        let mut reg = account::test_new_registry(sc.ctx());
        let mut attacker_account = account::test_register_account(&mut reg, ATTACKER, true, sc.ctx());
        account::test_add_delegate(&mut attacker_account, ATTACKER, READ, 9); // self-delegate
        let attacker_ns = namespace::test_create_namespace(ATTACKER, b"atk", sc.ctx());
        let victim_ns = namespace::test_create_namespace(OWNER, b"victim", sc.ctx());

        // id targets the VICTIM namespace; account+namespace are the attacker's.
        let victim_id = seal::namespace_seal_id(object::id(&victim_ns), 1);
        seal::test_seal_approve(victim_id, &attacker_account, &attacker_ns, &reg, sc.ctx());

        // unreachable
        transfer::public_transfer(victim_ns, @0x0);
        dispose(reg, attacker_account, attacker_ns);
        sc.end();
    }

    /// Attacker passes the victim's namespace with their own account → not in the
    /// victim's ACL → acl_bits = 0 → step 4 denies.
    #[test]
    #[expected_failure(abort_code = E_NO_ACCESS, location = walrus_memory::seal)]
    fun test_foreign_namespace_denied() {
        let mut sc = ts::begin(ATTACKER);
        let mut reg = account::test_new_registry(sc.ctx());
        let attacker_account = account::test_register_account(&mut reg, ATTACKER, true, sc.ctx());
        let victim_ns = namespace::test_create_namespace(OWNER, b"victim", sc.ctx());

        seal::test_seal_approve(seal_id(&victim_ns), &attacker_account, &victim_ns, &reg, sc.ctx());

        dispose(reg, attacker_account, victim_ns);
        sc.end();
    }

    /// A registered delegate that lacks READ (WRITE-only) cannot decrypt.
    #[test]
    #[expected_failure(abort_code = E_NO_ACCESS, location = walrus_memory::seal)]
    fun test_delegate_without_read_denied() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let mut account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        account::test_add_delegate(&mut account, DELEGATE, WRITE, 2); // WRITE only
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        sc.next_tx(DELEGATE);
        seal::test_seal_approve(seal_id(&ns), &account, &ns, &reg, sc.ctx());

        dispose(reg, account, ns);
        sc.end();
    }

    /// A caller that is neither owner nor a registered delegate is rejected at the
    /// authentication step (abort raised inside `account::authn`).
    #[test]
    #[expected_failure(abort_code = E_NO_ACCESS, location = walrus_memory::account)]
    fun test_unregistered_caller_denied() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        sc.next_tx(ATTACKER);
        seal::test_seal_approve(seal_id(&ns), &account, &ns, &reg, sc.ctx());

        dispose(reg, account, ns);
        sc.end();
    }

    /// Revoking a guest (set ACL bits to 0) denies subsequent reads.
    #[test]
    #[expected_failure(abort_code = E_NO_ACCESS, location = walrus_memory::seal)]
    fun test_acl_revoke_denies() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let owner_account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        let guest_account = account::test_register_account(&mut reg, GUEST, true, sc.ctx());
        let mut ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());
        namespace::test_set_acl(&mut ns, GUEST, READ, sc.ctx());
        namespace::test_set_acl(&mut ns, GUEST, 0, sc.ctx()); // revoke

        sc.next_tx(GUEST);
        seal::test_seal_approve(seal_id(&ns), &guest_account, &ns, &reg, sc.ctx());

        transfer::public_transfer(owner_account, @0x0);
        dispose(reg, guest_account, ns);
        sc.end();
    }

    /// A frozen account denies decryption (liveness check).
    #[test]
    #[expected_failure(abort_code = E_NO_ACCESS, location = walrus_memory::seal)]
    fun test_inactive_account_denied() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let account = account::test_register_account(&mut reg, OWNER, false, sc.ctx()); // inactive
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        seal::test_seal_approve(seal_id(&ns), &account, &ns, &reg, sc.ctx());

        dispose(reg, account, ns);
        sc.end();
    }

    /// Downgrade guard: a namespace not on the current VERSION is rejected.
    #[test]
    #[expected_failure(abort_code = E_WRONG_VERSION, location = walrus_memory::account)]
    fun test_downgrade_guard_denied() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let account = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        let mut ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());
        namespace::test_force_version(&mut ns, 1); // simulate legacy (pre-upgrade)

        seal::test_seal_approve(seal_id(&ns), &account, &ns, &reg, sc.ctx());

        dispose(reg, account, ns);
        sc.end();
    }

    // --- migration caps ------------------------------------------------------

    #[test]
    fun test_migration_import_and_cap_burn() {
        let mut sc = ts::begin(OWNER);
        let admin = account::test_mint_admin_cap(sc.ctx());
        let mut reg = account::test_new_registry(sc.ctx());

        let cap = account::mint_migration_cap(&admin, sc.ctx());
        let legacy_id = object::id(&reg); // any ID stand-in for the old account id
        account::test_admin_import_account(&cap, &mut reg, OWNER, legacy_id, 123, true, sc.ctx());

        // The imported account is canonical for OWNER and carries the legacy id.
        sc.next_tx(OWNER);
        let imported = ts::take_shared<Account>(&sc);
        assert!(account::owner(&imported) == OWNER, 0);
        assert!(account::is_active(&imported), 1);
        assert!(*account::legacy_account_id(&imported).borrow() == legacy_id, 2);
        assert!(account::has_account(&reg, OWNER), 3);
        ts::return_shared(imported);

        // Burning the cap permanently removes the forge power.
        account::burn_migration_cap(&admin, cap);

        account::test_consume_registry(reg);
        transfer::public_transfer(admin, OWNER);
        sc.end();
    }

    // --- write path (record / delete, delegate-resolved) ---------------------

    #[test]
    fun test_owner_can_write_and_delete() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let acc = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());
        let clk = clock::create_for_testing(sc.ctx());

        namespace::test_record_memory(&acc, &ns, &reg, b"blob-1", &clk, sc.ctx());

        sc.next_tx(OWNER);
        let mb = ts::take_from_sender<MemBlob>(&sc);
        assert!(namespace::mem_namespace_id(&mb) == object::id(&ns), 0);
        namespace::test_delete_memory(mb, &acc, &ns, &reg, sc.ctx());

        clock::destroy_for_testing(clk);
        dispose(reg, acc, ns);
        sc.end();
    }

    #[test]
    fun test_delegate_with_write_can_write() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let mut acc = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        account::test_add_delegate(&mut acc, DELEGATE, WRITE, 3);
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        sc.next_tx(DELEGATE);
        let clk = clock::create_for_testing(sc.ctx());
        namespace::test_record_memory(&acc, &ns, &reg, b"blob-d", &clk, sc.ctx());

        clock::destroy_for_testing(clk);
        dispose(reg, acc, ns);
        sc.end();
    }

    /// A READ-only delegate cannot write (effective lacks WRITE).
    #[test]
    #[expected_failure(abort_code = E_NO_PERMISSION, location = walrus_memory::namespace)]
    fun test_delegate_without_write_denied() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let mut acc = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        account::test_add_delegate(&mut acc, DELEGATE, READ, 4);
        let ns = namespace::test_create_namespace(OWNER, b"wrapped-dek", sc.ctx());

        sc.next_tx(DELEGATE);
        let clk = clock::create_for_testing(sc.ctx());
        namespace::test_record_memory(&acc, &ns, &reg, b"x", &clk, sc.ctx());

        clock::destroy_for_testing(clk);
        dispose(reg, acc, ns);
        sc.end();
    }

    /// Deleting a MemBlob against the wrong namespace is rejected.
    #[test]
    #[expected_failure(abort_code = E_WRONG_NAMESPACE, location = walrus_memory::namespace)]
    fun test_delete_wrong_namespace_denied() {
        let mut sc = ts::begin(OWNER);
        let mut reg = account::test_new_registry(sc.ctx());
        let acc = account::test_register_account(&mut reg, OWNER, true, sc.ctx());
        let ns_a = namespace::test_create_namespace(OWNER, b"a", sc.ctx());
        let ns_b = namespace::test_create_namespace(OWNER, b"b", sc.ctx());
        let clk = clock::create_for_testing(sc.ctx());
        namespace::test_record_memory(&acc, &ns_a, &reg, b"blob", &clk, sc.ctx());

        sc.next_tx(OWNER);
        let mb = ts::take_from_sender<MemBlob>(&sc);
        namespace::test_delete_memory(mb, &acc, &ns_b, &reg, sc.ctx());

        clock::destroy_for_testing(clk);
        transfer::public_transfer(ns_a, @0x0);
        dispose(reg, acc, ns_b);
        sc.end();
    }
}
