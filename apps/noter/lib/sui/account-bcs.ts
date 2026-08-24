/**
 * BCS schemas for reading `memwal::account`'s on-chain structs. gRPC
 * object/dynamic-field/event reads return raw BCS bytes (unlike JSON-RPC's
 * parsed `.fields`), so these are needed to decode on-chain state.
 *
 * These schemas intentionally decode only the leading fields this app reads
 * (id, accounts / id, owner, delegate_keys, active) and rely on the BCS
 * parser stopping there rather than erroring on trailing bytes. That's safe
 * against the package this app is currently configured against, but NOT
 * against services/contract/sources/account.move as it reads today —
 * that source has already grown migration/import fields on AccountRegistry
 * (migration_finalized, pinned_allowlist_root, expected/imported counters,
 * version) and MemWalAccount (admin_quarantined, legacy_account_id, and
 * more) that aren't modeled here at all. Verified correct against the
 * live, currently-deployed bytecode as of this change (decoded delegate key
 * bytes matched a known-good derived public key; a registry dynamic-field
 * lookup round-tripped to the expected account id) — but that means the
 * source has moved ahead of what's published, not that these schemas are
 * future-proof. If/when that contract version is published to the package
 * this app points at, these schemas need the new fields added (in order)
 * or reads will silently decode wrong instead of erroring.
 */
import { bcs } from "@mysten/sui/bcs";

/** memwal::account::DelegateKey */
export const DelegateKeyBcs = bcs.struct("DelegateKey", {
  public_key: bcs.vector(bcs.U8),
  sui_address: bcs.Address,
  label: bcs.String,
  created_at: bcs.U64,
});

/** memwal::account::MemWalAccount */
export const MemWalAccountBcs = bcs.struct("MemWalAccount", {
  id: bcs.Address,
  owner: bcs.Address,
  delegate_keys: bcs.vector(DelegateKeyBcs),
  created_at: bcs.U64,
  active: bcs.Bool,
});

/**
 * sui::table::Table<K, V> — framework struct, not defined in account.move,
 * but referenced by AccountRegistry.accounts: Table<address, ID>. Table's
 * own layout is `{ id: UID, size: u64 }`; entries live as dynamic fields on
 * `id`, not inlined in this struct.
 */
export const TableBcs = bcs.struct("Table", {
  id: bcs.Address,
  size: bcs.U64,
});

/** memwal::account::AccountRegistry */
export const AccountRegistryBcs = bcs.struct("AccountRegistry", {
  id: bcs.Address,
  accounts: TableBcs,
});

/** memwal::account::AccountCreated (event) */
export const AccountCreatedBcs = bcs.struct("AccountCreated", {
  account_id: bcs.Address,
  owner: bcs.Address,
});
