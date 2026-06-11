/// PoC — SEAL access-control bypass via the delegate path.
///
/// Demonstrates that the delegate branch of `seal_approve` grants decryption
/// access to an arbitrary key `id` WITHOUT verifying that `id` belongs to the
/// account's owner. An attacker uses their OWN account + their OWN delegate to
/// pass the policy gate for a VICTIM's key id (= bcs(victim_address)).
///
/// The victim needs no on-chain account: their data is SEAL-encrypted under
/// id = [package_prefix] ++ bcs(victim_address). All the attacker needs is to
/// get the key servers to approve that id — which this test shows they can.
#[test_only]
#[allow(implicit_const_copy)]
module memwal::seal_bypass_poc {
    use std::string;
    use sui::test_scenario;
    use sui::clock;
    use memwal::account::{Self, MemWalAccount, AccountRegistry};

    /// The attacker — owns their own MemWalAccount.
    const ATTACKER: address = @0xA11ACE;
    /// A key the attacker fully controls, registered as a delegate on the
    /// ATTACKER's own account. MUST be blake2b256(0x00 || attacker_pk) where
    /// attacker_pk = 0xbb*32, since add_delegate_key now enforces that binding.
    const ATTACKER_DELEGATE: address = @0xcbb8c34831749c2416ec0339bfc46f42d696576d08d8621e39ef767c42933d77;
    /// The victim. Their private data is encrypted under id = bcs(VICTIM).
    /// The attacker has NO relationship to this address.
    const VICTIM: address = @0xC0FFEE;

    /// Attacker's delegate tries to decrypt the VICTIM's key id through the
    /// delegate path. Before the fix this did NOT abort (access granted = the
    /// vulnerability). After the fix, `seal_approve` enforces the owner-suffix
    /// check on the delegate path too, so this now aborts with `ENoAccess`.
    /// This is the regression test that locks the fix in.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun poc_delegate_path_reads_other_users_id() {
        let mut scenario = test_scenario::begin(ATTACKER);

        // --- Attacker sets up their OWN account (entirely legitimate) ---
        scenario.next_tx(ATTACKER);
        {
            account::test_init(scenario.ctx());
        };
        scenario.next_tx(ATTACKER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        // Attacker adds a delegate THEY control to THEIR OWN account.
        // Allowed: add_delegate_key only checks `account.owner == sender`.
        scenario.next_tx(ATTACKER);
        {
            let mut account = scenario.take_shared<MemWalAccount>();
            let attacker_pk = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            let clock = clock::create_for_testing(scenario.ctx());
            account::add_delegate_key(
                &mut account,
                attacker_pk,
                ATTACKER_DELEGATE,
                string::utf8(b"attacker-controlled key"),
                &clock,
                scenario.ctx(),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(account);
        };

        // --- The exploit ---
        // The attacker's delegate asks to decrypt the VICTIM's key id, while
        // passing the ATTACKER's account. The delegate branch only checks
        // "is sender a delegate of THIS account?" (yes) and never checks that
        // victim_key_id belongs to this account's owner. -> access granted.
        scenario.next_tx(ATTACKER_DELEGATE);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let victim_key_id = sui::bcs::to_bytes(&VICTIM); // == the victim's SEAL id
            // BUG: does not abort. A real SEAL key server would release the
            // decryption key for the victim's id here.
            account::seal_approve(victim_key_id, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }

    /// Control: the SAME goal via the OWNER path is correctly blocked, because
    /// the owner branch DOES enforce the suffix check. This is the contrast
    /// that pinpoints the missing check on the delegate path.
    #[test]
    #[expected_failure(abort_code = account::ENoAccess)]
    fun control_owner_path_blocks_other_users_id() {
        let mut scenario = test_scenario::begin(ATTACKER);

        scenario.next_tx(ATTACKER);
        {
            account::test_init(scenario.ctx());
        };
        scenario.next_tx(ATTACKER);
        {
            let mut registry = scenario.take_shared<AccountRegistry>();
            let clock = clock::create_for_testing(scenario.ctx());
            account::create_account(&mut registry, &clock, scenario.ctx());
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        // Attacker (the owner) tries the victim's id directly -> ENoAccess,
        // because the owner branch requires has_suffix(id, bcs(owner)).
        scenario.next_tx(ATTACKER);
        {
            let account = scenario.take_shared<MemWalAccount>();
            let victim_key_id = sui::bcs::to_bytes(&VICTIM);
            account::seal_approve(victim_key_id, &account, scenario.ctx());
            test_scenario::return_shared(account);
        };

        scenario.end();
    }
}
