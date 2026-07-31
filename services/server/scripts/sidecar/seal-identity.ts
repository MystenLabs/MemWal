/**
 * SEAL key-id construction.
 *
 * Kept apart from routes/seal.ts so it pulls in nothing but @mysten/sui — these
 * two functions carry the revocation property and the id layout has to stay
 * byte-identical to `account::seal_approve`, so they need to be testable on
 * their own.
 */

import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress, toHex } from "@mysten/sui/utils";

/** Just enough of a Sui client to read one object — keeps this module client-agnostic. */
export type ObjectReader = {
  getObject(input: {
    objectId: string;
    include: { json: true };
  }): Promise<{ object?: { type?: string; json?: unknown } | null } | null>;
};

export type SealEncryptPurpose = "normal" | "migration" | "legacy-seed";

/**
 * Read and validate the account's SEAL encryption identity fresh from chain.
 *
 * Owner and counter are security inputs, so neither may come from an
 * unverified request. The object type binds the lookup to the immutable
 * package namespace. Normal writes require an active account. The dedicated
 * migration route may preserve ciphertext for an imported inactive account,
 * but admin quarantine always blocks encryption. The opt-in E2E legacy-seed
 * route alone accepts the v3 account shape, which predates that field.
 */
export async function fetchSealEncryptIdentity(
  accountId: string,
  expectedOwner: string,
  immutablePackageId: string,
  purpose: SealEncryptPurpose,
  client: ObjectReader
): Promise<{
  owner: string;
  immutablePackageId: string;
  accessCounterVersion: bigint;
}> {
  const res = await client.getObject({
    objectId: accountId,
    include: { json: true },
  });
  // gRPC nests the Move fields under `object.json` (same as readBlobObject).
  const json = res?.object?.json as Record<string, unknown> | undefined;
  const objectType = res?.object?.type;
  const typeParts =
    typeof objectType === "string" ? objectType.split("::") : [];
  const packageMatches =
    typeParts.length === 3 &&
    normalizeSuiAddress(typeParts[0]) ===
      normalizeSuiAddress(immutablePackageId) &&
    typeParts[1] === "account" &&
    typeParts[2] === "MemWalAccount";
  if (!packageMatches) {
    throw new Error(
      `object ${accountId} is not a ${immutablePackageId}::account::MemWalAccount`
    );
  }

  const owner = json?.owner;
  if (typeof owner !== "string") {
    throw new Error(`account ${accountId} has no owner field`);
  }
  if (normalizeSuiAddress(owner) !== normalizeSuiAddress(expectedOwner)) {
    throw new Error(`account ${accountId} owner does not match request owner`);
  }

  const active = json?.active;
  if (typeof active !== "boolean") {
    throw new Error(`account ${accountId} has no valid active field`);
  }
  const adminQuarantined = json?.admin_quarantined;
  if (
    typeof adminQuarantined !== "boolean" &&
    !(purpose === "legacy-seed" && adminQuarantined === undefined)
  ) {
    throw new Error(
      `account ${accountId} has no valid admin_quarantined field`
    );
  }
  if (adminQuarantined) {
    throw new Error(`account ${accountId} is admin quarantined`);
  }
  if (!active && purpose !== "migration") {
    throw new Error(`account ${accountId} is not active`);
  }

  const raw = json?.access_counter_version;
  if (raw === undefined || raw === null) {
    throw new Error(
      `account ${accountId} has no access_counter_version field ` +
        "(account predates SEAL identity rotation, or accountId is not a MemWalAccount)"
    );
  }
  return {
    owner: normalizeSuiAddress(owner),
    immutablePackageId: normalizeSuiAddress(immutablePackageId),
    accessCounterVersion: BigInt(raw as string | number),
  };
}

/**
 * Build the SEAL key id for a fresh encryption: owner address ‖ BCS u64 counter,
 * hex, matching what `account::seal_approve` parses back out.
 *
 * `owner` is normalized first: a short-form address ("0x1") would hex-decode to
 * fewer than 32 bytes, the on-chain suffix check would miss, and the ciphertext
 * would be permanently undecryptable — with encryption itself reporting success.
 */
export function buildSealEncryptId(owner: string, counter: bigint): string {
  const ownerHex = normalizeSuiAddress(owner).slice(2);
  return `${ownerHex}${toHex(bcs.u64().serialize(counter).toBytes())}`;
}
