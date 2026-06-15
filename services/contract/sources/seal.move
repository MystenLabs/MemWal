/// Walrus Memory (WM) — SEAL access policy (V2)
///
/// `seal_approve` is the on-chain policy the Seal key servers evaluate (via
/// dry-run) before releasing a USK. It authorizes the **release** of a decryption
/// key — it cannot lock a USK already fetched (design §12). The rewrite closes the
/// original cross-account bug by binding the requested id to the **namespace**
/// uniformly across the owner and delegate paths (there is exactly ONE id-binding
/// check, step 5, on the one and only authorize path).
///
/// Seal id (owner-free, namespace-anchored):
///   `inner_id = bcs(object::id(namespace)) ‖ bcs(key_version)`
///   `full_id  = [package_id] ‖ inner_id`   (package prefix added by the SDK)
///
/// The five steps (design on-chain §8):
///   0. version + liveness
///   1. registry integrity (supplied account is the canonical one for its owner)
///   2. AUTHN  — resolve signer → principal, capture the signing key's authority
///   3. AUTHZ  — what the principal may do on THIS namespace (ACL; owner = FULL)
///   4. EFFECTIVE = authz ∩ delegate authority; decryption requires READ
///   5. IDENTITY BINDING — the requested id must be this namespace's id
module walrus_memory::seal {
    use sui::bcs;
    use walrus_memory::account::{Self, Account, AccountRegistry};
    use walrus_memory::namespace::{Self, MemoryNamespace};

    /// Caller is not authorized to decrypt.
    const ENoAccess: u64 = 100;

    /// SEAL policy entry. Authorizes USK release for `id` iff the signer, acting
    /// for the account's principal, holds READ on `namespace` AND `id` is bound to
    /// that namespace.
    entry fun seal_approve(
        id: vector<u8>,
        account: &Account,
        namespace: &MemoryNamespace,
        registry: &AccountRegistry,
        ctx: &TxContext,
    ) {
        // 0. version + liveness
        namespace::assert_namespace_version(namespace);
        assert!(account::is_active(account), ENoAccess);

        // 1. registry integrity — supplied account is canonical for its owner.
        //    (Forged accounts are already impossible — `Account` is only
        //    constructible in `walrus_memory::account` with `owner = sender` and no
        //    setter — this rejects stale / non-registered objects too.)
        let principal = account::owner(account);
        assert!(
            account::is_canonical_account(registry, principal, object::id(account)),
            ENoAccess,
        );

        // 2. AUTHN — resolve the signer to its delegate authority for this account.
        //    Aborts `ENoAccess` if the caller is neither owner nor a delegate.
        let delegate_perms = account::authn(account, ctx.sender());

        // 3. AUTHZ — what may the PRINCIPAL do on THIS namespace? (owner = FULL)
        let acl_bits = namespace::acl_bits_for(namespace, principal);

        // 4. EFFECTIVE rights = intersection; decryption needs READ.
        let effective = acl_bits & delegate_perms;
        assert!(effective & namespace::read_bit() != 0, ENoAccess);

        // 5. IDENTITY BINDING — the requested id must be this namespace's id
        //    (current or any prior key_version a reader is still entitled to).
        assert!(id_matches(namespace, &id), ENoAccess);
    }

    /// Build the inner Seal id for a namespace generation:
    ///   `bcs(namespace_id) ‖ bcs(key_version)`.
    /// Exposed so off-chain callers can reproduce the exact identity used at
    /// encrypt time.
    public fun namespace_seal_id(namespace_id: ID, key_version: u32): vector<u8> {
        let mut out = bcs::to_bytes(&namespace_id);
        out.append(bcs::to_bytes(&key_version));
        out
    }

    /// True iff `id` ends with this namespace's inner id for the current OR any
    /// prior key_version (so rotation never breaks reads of older data; a removed
    /// party fails step 4 long before reaching here).
    fun id_matches(namespace: &MemoryNamespace, id: &vector<u8>): bool {
        let nid = object::id(namespace);
        let current = namespace::current_key_version(namespace);
        let mut v = 1u32;
        while (v <= current) {
            let expected = namespace_seal_id(nid, v);
            if (has_suffix(id, &expected)) return true;
            v = v + 1;
        };
        false
    }

    /// Check that `data` ends with `suffix` (tolerates the optional package-id
    /// prefix on `id`).
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
    public fun test_seal_approve(
        id: vector<u8>,
        account: &Account,
        namespace: &MemoryNamespace,
        registry: &AccountRegistry,
        ctx: &TxContext,
    ) {
        seal_approve(id, account, namespace, registry, ctx);
    }
}
