/**
 * On-chain reads for the Enoki registration flow, over gRPC.
 *
 * These deliberately use gRPC's `include: { json: true }` rather than decoding
 * BCS with hand-written struct schemas (the approach in
 * apps/noter/lib/sui/account-bcs.ts). BCS schemas must list every field of a
 * struct in declaration order; when the published package grows a field, a
 * schema that predates it decodes *silently wrong* rather than erroring.
 * account.move has already grown fields on both AccountRegistry and
 * MemWalAccount that noter's schemas don't model — that's a latent bug waiting
 * on the next publish. Reading `json` keeps these lookups correct across
 * contract upgrades, since new fields just arrive as extra keys.
 *
 * The SDK notes the `json` shape may differ between JSON-RPC/gRPC/GraphQL
 * backends. That doesn't apply here — this module only ever talks to the gRPC
 * client from ./grpc-client — but the table-id read below still tolerates both
 * renderings of a `UID`, since that is the one field whose shape has actually
 * varied in practice.
 */
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromHex, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

/**
 * Look up the MemWalAccount object id owned by `ownerAddress`, or null if the
 * owner has no account yet.
 */
export async function fetchAccountIdForOwner(
  client: SuiGrpcClient,
  registryId: string,
  ownerAddress: string,
): Promise<string | null> {
  const registry = await client.getObject({
    objectId: registryId,
    include: { json: true },
  });

  // AccountRegistry.accounts is a sui::table::Table; its entries live as
  // dynamic fields on the table's own UID, not inlined in the struct.
  const accounts = registry.object.json?.accounts as
    | { id?: string | { id?: string } }
    | undefined;
  const rawTableId = accounts?.id;
  const tableId = typeof rawTableId === "string" ? rawTableId : rawTableId?.id;
  if (!tableId) return null;

  const response = await client.getDynamicField({
    parentId: tableId,
    name: {
      type: "address",
      bcs: fromHex(normalizeSuiAddress(ownerAddress)),
    },
  });

  // The value is a Move `ID` — a bare 32-byte address, so it needs no struct
  // schema to decode.
  const value = response.dynamicField?.value?.bcs;
  return value?.length === 32 ? `0x${toHex(value)}` : null;
}

/**
 * Find the object created by `digest` whose type contains `objectType`, or null
 * if the transaction created no such object.
 */
export async function findCreatedObjectByType(
  client: SuiGrpcClient,
  digest: string,
  objectType: string,
): Promise<string | null> {
  const response = await client.getTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  });

  const transaction = response.Transaction ?? response.FailedTransaction;
  const created = transaction.effects?.changedObjects.find(
    (change) =>
      change.idOperation === "Created" &&
      transaction.objectTypes?.[change.objectId]?.includes(objectType),
  );
  return created?.objectId ?? null;
}
