import { isSuiGrpcClient, type SuiGrpcClient } from "@mysten/sui/grpc";
import { fromHex, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

interface JsonRpcClientLike {
  getObject(input: { id: string; options: { showContent: boolean } }): Promise<{
    data?: { content?: { fields?: unknown } };
  }>;
  getDynamicFieldObject(input: {
    parentId: string;
    name: { type: string; value: string };
  }): Promise<{ data?: { content?: { fields?: unknown } } }>;
  getTransactionBlock(input: {
    digest: string;
    options: { showObjectChanges: boolean };
  }): Promise<{
    objectChanges?: Array<{
      type: string;
      objectId?: string;
      objectType?: string;
    }>;
  }>;
}

function unwrapJsonRpcFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapJsonRpcFields);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const inner =
      "fields" in object && object.fields && typeof object.fields === "object"
        ? object.fields
        : object;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).map(([key, item]) => [
        key,
        unwrapJsonRpcFields(item),
      ]),
    );
  }
  return value;
}

async function fetchObjectJson(
  client: unknown,
  objectId: string,
): Promise<Record<string, unknown> | null> {
  if (isSuiGrpcClient(client)) {
    const response = await client.getObject({
      objectId,
      include: { json: true },
    });
    return response.object.json ?? null;
  }

  const response = await (client as JsonRpcClientLike).getObject({
    id: objectId,
    options: { showContent: true },
  });
  const fields = response.data?.content?.fields;
  return fields
    ? (unwrapJsonRpcFields(fields) as Record<string, unknown>)
    : null;
}

export async function fetchAccountIdForOwner(
  client: unknown,
  registryId: string,
  ownerAddress: string,
): Promise<string | null> {
  const registry = await fetchObjectJson(client, registryId);
  const rawTableId = (
    registry?.accounts as { id?: string | { id?: string } } | undefined
  )?.id;
  const tableId =
    typeof rawTableId === "string" ? rawTableId : rawTableId?.id;
  if (!tableId) return null;

  if (isSuiGrpcClient(client)) {
    const response = await client.getDynamicField({
      parentId: tableId,
      name: {
        type: "address",
        bcs: fromHex(normalizeSuiAddress(ownerAddress)),
      },
    });
    const value = response.dynamicField?.value?.bcs;
    return value?.length === 32 ? `0x${toHex(value)}` : null;
  }

  const response = await (client as JsonRpcClientLike).getDynamicFieldObject({
    parentId: tableId,
    name: { type: "address", value: ownerAddress },
  });
  const fields = response.data?.content?.fields;
  if (!fields || typeof fields !== "object") return null;
  const value = (fields as Record<string, unknown>).value;
  return typeof value === "string" ? value : null;
}

export async function findCreatedObjectByType(
  client: unknown,
  digest: string,
  objectType: string,
): Promise<string | null> {
  if (isSuiGrpcClient(client)) {
    const response = await (client as SuiGrpcClient).getTransaction({
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

  const response = await (client as JsonRpcClientLike).getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const created = response.objectChanges?.find(
    (change) =>
      change.type === "created" && change.objectType?.includes(objectType),
  );
  return created?.objectId ?? null;
}
